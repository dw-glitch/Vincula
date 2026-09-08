/**
 * Vincula — aplicação do plano de escrita, com snapshot e rollback.
 *
 * Uma LD pode ter mais de uma aba atualizável (a lista de documentos e a de
 * CV/currículos, por exemplo). Cada aba passa pela sequência completa de
 * segurança abaixo e fica *pendente* no pacote; o commit único só acontece
 * quando todas as abas passam. Se qualquer uma reprovar, nada é gravado —
 * o arquivo gerado nunca sai pela metade.
 *
 * Sequência de segurança de cada aba:
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
   * Aplica o plano de UMA aba e deixa a nova versão pendente no pacote.
   * Não faz commit nem rollback: quem orquestra decide, depois de conhecer o
   * resultado de todas as abas do arquivo.
   *
   * @param {object} wb      pasta de trabalho aberta
   * @param {object} sheet   metadados da aba mapeada
   * @param {object} model   modelo varrido da aba (contém o XML original)
   * @param {object} mapping colunas confirmadas pelo usuário
   * @param {Array} plan     itens {recordId, document, row, grdt, dateIso, revision}
   * @param {{verify?:boolean}} options
   */
  async function applySheetPlan(wb, sheet, model, mapping, plan, options = {}) {
    const verify = options.verify !== false;
    const grdtCol = Number(mapping.grdtCol) || null;
    const dateCol = Number(mapping.dateCol) || null;
    const revisionCol = Number(mapping.revisionCol) || null;

    const snapshotXml = model.xml;
    const snapshotHash = await sha256Hex(snapshotXml);

    const guards = X.readGuards(snapshotXml);
    const editor = X.createEditor(wb, model, guards);

    const results = [];
    const occurrences = [];
    let grdtWrites = 0;
    let dateWrites = 0;
    let revisionWrites = 0;

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
        // Uma coluna não mapeada nesta aba simplesmente não é gravada: a aba
        // de CV pode não repetir todos os campos da aba de documentos.
        if (item.grdt !== null && item.grdt !== undefined && grdtCol) targets.push({ field: 'GRDT', col: grdtCol });
        if (item.dateIso && dateCol) targets.push({ field: 'DATA', col: dateCol });
        if (item.revision !== null && item.revision !== undefined && revisionCol) {
          targets.push({ field: 'REVISAO', col: revisionCol });
        }
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
              : target.field === 'REVISAO'
                ? editor.writeText(item.row, target.col, item.revision)
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
          else if (target.field === 'REVISAO') revisionWrites++;
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

      return {
        ok: true,
        sheetName: sheet.name,
        sheetPath: sheet.path,
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
        counters: { grdtWrites, dateWrites, revisionWrites, authorizedCells: editor.authorized.size },
      };
    } catch (error) {
      return {
        ok: false,
        error: error && error.message ? error.message : String(error),
        sheetName: sheet.name,
        sheetPath: sheet.path,
        snapshotHash,
        results,
        occurrences,
      };
    }
  }

  /** Fecha o pacote com todas as abas pendentes já validadas. */
  async function finalize(wb, options = {}) {
    // Nível 1 é intencional: XLSX/XLSM já são contêineres comprimidos e o
    // nível 9 aumentava muito o tempo de resposta com ganho mínimo de tamanho.
    const bytes = await X.commit(wb, { level: options.level ?? 1 });
    return { outputName: outputName(wb.name), bytes, outputHash: await sha256Hex(bytes) };
  }

  /** Descarta tudo o que estava pendente: o pacote original fica intacto. */
  function rollback(wb) {
    X.rollback(wb);
  }

  V.applier = { applySheetPlan, finalize, rollback, outputName, OUTCOME };
})(typeof self !== 'undefined' ? self : this);
