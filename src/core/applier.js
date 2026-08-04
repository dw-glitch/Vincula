/**
 * Vincula — aplicação do plano de escrita, com snapshot e rollback.
 *
 * Sequência de segurança de cada LD:
 *   1. snapshot  — o XML original da aba é retido em memória e seu SHA-256
 *                  registrado na auditoria;
 *   2. validação — cada célula-alvo é inspecionada (fórmula, mesclagem,
 *                  proteção, validação de dados) antes de qualquer escrita;
 *   3. escrita   — apenas as células autorizadas são emendadas;
 *   4. auditoria — o XML resultante é comparado com o snapshot célula a
 *                  célula e no esqueleto;
 *   5. commit    — só então o ZIP recebe a nova versão da aba.
 *
 * Qualquer falha entre 2 e 4 dispara rollback: as emendas são descartadas e o
 * pacote original permanece exatamente como foi carregado.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { sha256Hex, indexToColumn } = V.util;
  const X = V.xlsx;
  const D = V.dates;

  const OUTCOME = {
    APLICADO: 'APLICADO',
    BLOQUEADO: 'BLOQUEADO',
    IGNORADO: 'IGNORADO',
  };

  function outputName(name) {
    const dot = name.lastIndexOf('.');
    if (dot < 0) return name + '_ATUALIZADA_GRDT.xlsx';
    return name.slice(0, dot) + '_ATUALIZADA_GRDT' + name.slice(dot);
  }

  /**
   * @param {object} wb      pasta de trabalho aberta
   * @param {object} sheet   metadados da aba mapeada
   * @param {object} model   modelo varrido da aba (contém o XML original)
   * @param {object} mapping colunas confirmadas pelo usuário
   * @param {Array} plan     itens {recordId, document, row, grdt, dateIso}
   * @param {{verify?:boolean, level?:number}} options
   */
  async function applyPlan(wb, sheet, model, mapping, plan, options = {}) {
    const verify = options.verify !== false;
    const grdtCol = Number(mapping.grdtCol);
    const dateCol = Number(mapping.dateCol);

    const snapshotXml = model.xml;
    const snapshotHash = await sha256Hex(snapshotXml);

    const guards = X.readGuards(snapshotXml);
    const editor = X.createEditor(wb, model, guards);

    const results = [];
    const occurrences = [];
    let grdtWrites = 0;
    let dateWrites = 0;

    if (guards.protected) {
      occurrences.push({
        file: wb.name,
        sheet: sheet.name,
        ref: null,
        type: 'PROTECAO',
        detail: 'Aba protegida no Excel. A proteção foi preservada no arquivo gerado.',
      });
    }

    try {
      for (const item of plan) {
        const targets = [];
        if (item.grdt !== null && item.grdt !== undefined) targets.push({ field: 'GRDT', col: grdtCol });
        if (item.dateIso) targets.push({ field: 'DATA', col: dateCol });
        if (!targets.length) {
          results.push({ recordId: item.recordId, outcome: OUTCOME.IGNORADO, reason: 'Nada a gravar.' });
          continue;
        }

        // Uma célula bloqueada invalida apenas o campo correspondente.
        const applied = [];
        const blockedFields = [];
        const notes = new Set();

        for (const target of targets) {
          const check = X.inspectTarget(model, guards, item.row, target.col);
          check.notes.forEach((note) => notes.add(note));
          if (check.blocked) {
            blockedFields.push(target.field);
            occurrences.push({
              file: wb.name,
              sheet: sheet.name,
              ref: `${indexToColumn(target.col)}${item.row}`,
              type: check.blocked,
              detail: check.notes.join(' '),
              document: item.document,
            });
            continue;
          }

          const ok =
            target.field === 'GRDT'
              ? editor.writeText(item.row, target.col, item.grdt)
              : editor.writeDate(item.row, target.col, D.parseDate(item.dateIso, false));

          if (!ok) {
            blockedFields.push(target.field);
            occurrences.push({
              file: wb.name,
              sheet: sheet.name,
              ref: `${indexToColumn(target.col)}${item.row}`,
              type: 'POSICAO',
              detail: 'Não foi possível posicionar a célula no XML da aba.',
              document: item.document,
            });
            continue;
          }

          applied.push(target.field);
          if (target.field === 'GRDT') grdtWrites++;
          else dateWrites++;
        }

        results.push({
          recordId: item.recordId,
          outcome: applied.length ? OUTCOME.APLICADO : OUTCOME.BLOQUEADO,
          appliedFields: applied,
          blockedFields,
          reason: [...notes].join(' '),
        });
      }

      const updatedXml = editor.render();

      let integrity = { ok: true, violations: [], comparedCells: 0, verified: false };
      if (verify) {
        integrity = { ...X.verifyIntegrity(snapshotXml, updatedXml, editor.authorized), verified: true };
        if (!integrity.ok) {
          const detail = integrity.violations
            .slice(0, 5)
            .map((v) => `${v.ref || 'estrutura'}: ${v.reason}`)
            .join('; ');
          throw new Error(`Integridade reprovada em ${wb.name} — ${detail}`);
        }
      }

      X.stagePart(wb, sheet.path, updatedXml);
      const bytes = await X.commit(wb, { level: options.level ?? 9 });
      const outputHash = await sha256Hex(bytes);

      return {
        ok: true,
        outputName: outputName(wb.name),
        bytes,
        outputHash,
        snapshotHash,
        results,
        occurrences,
        guards: {
          protected: guards.protected,
          merges: guards.merges.length,
          validations: guards.validations.length,
          conditional: guards.conditional.length,
          autoFilter: guards.hasAutoFilter,
        },
        integrity,
        counters: { grdtWrites, dateWrites, authorizedCells: editor.authorized.size },
      };
    } catch (error) {
      // Rollback: nada foi escrito no ZIP, basta descartar as emendas.
      X.rollback(wb);
      return {
        ok: false,
        error: error && error.message ? error.message : String(error),
        snapshotHash,
        results,
        occurrences,
        rolledBack: true,
      };
    }
  }

  V.applier = { applyPlan, outputName, OUTCOME };
})(typeof self !== 'undefined' ? self : this);
