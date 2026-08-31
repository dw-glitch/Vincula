/**
 * Vincula — cruzamento Relação GRCON × LDs e montagem do plano de escrita.
 *
 * Nada é gravado aqui. Esta camada decide, documento a documento, o que
 * mudaria e por quê — é o insumo da pré-visualização e, depois de confirmada,
 * do plano enviado aos workers.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { squash, looseDocumentKey } = V.util;
  const D = V.dates;

  const STATUS = {
    ATUALIZAR: 'ATUALIZAR',
    SEM_ALTERACAO: 'SEM_ALTERACAO',
    NAO_ENCONTRADO: 'NAO_ENCONTRADO',
    BLOQUEADO: 'BLOQUEADO',
    ERRO: 'ERRO',
  };

  const STATUS_LABEL = {
    ATUALIZAR: 'Alterado',
    SEM_ALTERACAO: 'Sem alteração',
    NAO_ENCONTRADO: 'Não encontrado',
    BLOQUEADO: 'Bloqueado',
    ERRO: 'Erro',
  };

  const FLAG = {
    DUPLICADO_RELACAO: 'DUPLICADO_RELACAO',
    DUPLICADO_LD: 'DUPLICADO_LD',
    DATA_INVALIDA: 'DATA_INVALIDA',
    GRDT_AUSENTE: 'GRDT_AUSENTE',
    DATA_TEXTO: 'DATA_TEXTO',
    CORRESPONDENCIA_APROXIMADA: 'CORRESPONDENCIA_APROXIMADA',
  };

  const FLAG_LABEL = {
    DUPLICADO_RELACAO: 'Duplicado na relação',
    DUPLICADO_LD: 'Duplicado na LD',
    DATA_INVALIDA: 'Data da postagem inválida',
    GRDT_AUSENTE: 'GRDT ausente na relação',
    DATA_TEXTO: 'Data convertida de texto para data do Excel',
    CORRESPONDENCIA_APROXIMADA: 'Correspondência aproximada — confira',
  };

  /** Data já presente na LD, normalizada para comparação. */
  function existingDateIso(entry) {
    if (entry.beforeDateSerial === null || entry.beforeDateSerial === undefined) return null;
    return D.formatIsoDate(D.serialToDate(entry.beforeDateSerial, false));
  }

  /**
   * @param {object} relation  índice da Relação GRCON
   * @param {object} global    índice global das LDs (documento → ocorrências).
   *   Uma LD pode contribuir com mais de uma aba (documentos e CV/currículos);
   *   cada ocorrência carrega a aba de onde veio e é atualizada no lugar certo.
   * @param {object} files     mapa fileId → {id, name, sheetName}
   * @param {{convertTextDates?:boolean, flexibleMatching?:boolean}} options
   *   flexibleMatching é ligado por padrão: quando a igualdade exata falha,
   *   tenta de novo por uma chave frouxa (zero à esquerda, espaço, traço) e
   *   só resolve quando existe exatamente um candidato. Passe `false`
   *   explicitamente para exigir igualdade exata em toda a análise.
   */
  function analyze(relation, global, files, options = {}) {
    const convertTextDates = options.convertTextDates !== false;
    const flexibleMatching = options.flexibleMatching !== false;

    const records = [];
    const missing = [];
    const invalidDates = [];
    const plans = new Map();
    let sequence = 0;
    let approximateCount = 0;

    for (const [document, source] of relation.selected) {
      let matches = global.byDocument.get(document);
      const duplicatedInRelation = (relation.duplicates.find((d) => d.document === document)?.count || 0) > 1;

      // Correspondência exata falhou: com a correspondência flexível ligada,
      // tenta a chave frouxa (zero à esquerda / pontuação / espaço ignorados).
      // Só resolve quando existe exatamente UMA chave exata diferente sob a
      // mesma chave frouxa — ambíguo é tratado como não encontrado, nunca
      // como palpite silencioso.
      let approximateSource = null;
      let ambiguousLoose = false;
      if ((!matches || !matches.length) && flexibleMatching) {
        const loose = looseDocumentKey(document);
        const candidates = loose ? global.byLooseKey.get(loose) : null;
        if (candidates && candidates.length) {
          const distinct = [...new Set(candidates)];
          if (distinct.length === 1 && distinct[0] !== document) {
            approximateSource = distinct[0];
            matches = global.byDocument.get(approximateSource);
          } else if (distinct.length > 1) {
            ambiguousLoose = true;
          }
        }
      }

      if (!matches || !matches.length) {
        const record = {
          id: ++sequence,
          document,
          status: STATUS.NAO_ENCONTRADO,
          flags: duplicatedInRelation ? [FLAG.DUPLICADO_RELACAO] : [],
          relationRow: source.row,
          fileId: null,
          fileName: '',
          sheetName: '',
          row: null,
          beforeGrdt: '',
          afterGrdt: source.grdt,
          beforeDate: '',
          afterDate: source.dateText,
          beforeRevisao: '',
          afterRevisao: source.revision,
          grdtWillChange: false,
          dateWillChange: false,
          revisionWillChange: false,
          reason: ambiguousLoose
            ? 'Documento pertence a outra LD. Correspondência flexível encontrou mais de um documento diferente com a mesma chave aproximada; não resolvido automaticamente para evitar juntar documentos errados.'
            : 'Documento pertence a outra LD.',
        };
        records.push(record);
        missing.push(record);
        continue;
      }

      // Documento repetido na LD: todas as ocorrências exatas são atualizadas.
      for (const entry of matches) {
        const file = files.get(entry.fileId) || { name: '', sheetName: '' };
        // A aba vem da própria ocorrência: o mesmo arquivo pode ter sido
        // indexado em mais de uma aba.
        const sheetName = entry.sheetName || file.sheetName || '';
        const flags = [];
        if (duplicatedInRelation) flags.push(FLAG.DUPLICADO_RELACAO);
        if (matches.length > 1) flags.push(FLAG.DUPLICADO_LD);
        if (approximateSource) flags.push(FLAG.CORRESPONDENCIA_APROXIMADA);

        // Campo que não existe nesta aba não é prometido nem gravado.
        const sheetHasGrdt = entry.hasGrdtCol !== false;
        const sheetHasDate = entry.hasDateCol !== false;
        const sheetHasRevision = entry.hasRevisionCol !== false;

        const grdtValue = squash(source.grdt);
        const hasGrdt = grdtValue !== '' && !D.isBlankDateToken(grdtValue);
        if (!hasGrdt) flags.push(FLAG.GRDT_AUSENTE);
        if (!source.dateValid) flags.push(FLAG.DATA_INVALIDA);

        const grdtWillChange = hasGrdt && sheetHasGrdt && squash(entry.beforeGrdt) !== grdtValue;

        const revisionValue = squash(source.revision);
        const hasRevision = revisionValue !== '';
        const revisionWillChange = hasRevision && sheetHasRevision && squash(entry.beforeRevisao) !== revisionValue;

        let dateWillChange = false;
        if (source.dateValid && sheetHasDate) {
          const current = existingDateIso(entry);
          // Mesmo dia, porém guardado como texto: reescreve como data real do
          // Excel — o tipo faz parte do resultado exigido, não só o valor.
          dateWillChange = current !== source.dateIso || (!entry.dateCellIsDate && convertTextDates);
          if (dateWillChange && !entry.dateCellIsDate) flags.push(FLAG.DATA_TEXTO);
        }

        const reasons = [];
        reasons.push(
          duplicatedInRelation
            ? `Relação: ${relation.duplicates.find((d) => d.document === document).count} ocorrências; vence a última, linha ${source.row}.`
            : `Relação: ocorrência única, linha ${source.row}.`
        );
        reasons.push(
          matches.length > 1
            ? `LD: ${matches.length} ocorrências do documento; todas atualizadas. Esta: ${file.name} · ${sheetName} · linha ${entry.row}.`
            : `LD: ${file.name} · ${sheetName} · linha ${entry.row}.`
        );
        if (!sheetHasGrdt) reasons.push(`A aba "${sheetName}" não tem coluna de GRDT mapeada; o campo não é gravado nela.`);
        if (!sheetHasDate) reasons.push(`A aba "${sheetName}" não tem coluna de data mapeada; o campo não é gravado nela.`);
        if (!source.dateValid) {
          reasons.push(
            `Data da postagem inválida ("${source.sourceDateRaw || 'vazio'}"); a Data Efetiva de Emissão da LD é preservada.`
          );
        }
        if (!hasGrdt) reasons.push('GRDT sem valor válido na relação; a GRDT da LD é preservada.');
        if (entry.grdtHasFormula && grdtWillChange) reasons.push('Célula de GRDT contém fórmula; verificação aplicada na gravação.');
        if (approximateSource) {
          reasons.push(
            `Correspondência flexível: relação tem "${source.rawDocument}", LD tem "${entry.rawDocument}" — ` +
              'chaves normalizadas diferem só em zero à esquerda, espaço ou pontuação. Confira antes de confiar.'
          );
          approximateCount++;
        }
        if (!grdtWillChange && !dateWillChange && !revisionWillChange) reasons.push('Valores já conferem; nenhuma escrita será executada.');

        const willChange = grdtWillChange || dateWillChange || revisionWillChange;
        const record = {
          id: ++sequence,
          document,
          status: willChange ? STATUS.ATUALIZAR : STATUS.SEM_ALTERACAO,
          flags,
          relationRow: source.row,
          fileId: entry.fileId,
          fileName: file.name,
          sheetName,
          sheetPath: entry.sheetPath || '',
          row: entry.row,
          beforeGrdt: entry.beforeGrdt,
          afterGrdt: grdtWillChange ? source.grdt : entry.beforeGrdt,
          beforeDate: entry.beforeDate,
          afterDate: source.dateValid ? source.dateText : entry.beforeDate,
          beforeRevisao: entry.beforeRevisao,
          afterRevisao: revisionWillChange ? source.revision : entry.beforeRevisao,
          grdtWillChange,
          dateWillChange,
          revisionWillChange,
          reason: reasons.join(' '),
        };
        records.push(record);
        if (!source.dateValid) invalidDates.push(record);

        if (willChange) {
          let plan = plans.get(entry.fileId);
          if (!plan) plans.set(entry.fileId, (plan = []));
          plan.push({
            recordId: record.id,
            document,
            // A aba vai junto: um mesmo arquivo pode receber escrita em mais
            // de uma aba, e a linha só faz sentido dentro da sua.
            sheetPath: entry.sheetPath || '',
            sheetName,
            row: entry.row,
            grdt: grdtWillChange ? source.grdt : null,
            dateIso: dateWillChange ? source.dateIso : null,
            revision: revisionWillChange ? source.revision : null,
          });
        }
      }
    }

    const changing = records.filter((r) => r.status === STATUS.ATUALIZAR);
    const sheetsTouched = new Set(changing.map((r) => `${r.fileId}|${r.sheetPath}`));
    const stats = {
      relationRows: relation.totalRows,
      relationDocuments: relation.uniqueDocuments,
      relationDuplicates: relation.duplicates.length,
      relationConflicts: relation.duplicates.filter((d) => d.conflict).length,
      ldEntries: global.totalEntries,
      ldDocuments: global.uniqueDocuments,
      ldDuplicates: global.duplicatedDocuments,
      records: records.length,
      found: relation.uniqueDocuments - missing.length,
      missing: missing.length,
      willChange: changing.length,
      unchanged: records.filter((r) => r.status === STATUS.SEM_ALTERACAO).length,
      invalidDates: invalidDates.length,
      grdtWrites: changing.filter((r) => r.grdtWillChange).length,
      dateWrites: changing.filter((r) => r.dateWillChange).length,
      revisionWrites: changing.filter((r) => r.revisionWillChange).length,
      approximateMatches: approximateCount,
      sheetsWithChanges: sheetsTouched.size,
    };

    return { records, missing, invalidDates, plans, stats };
  }

  /** Filtro da pré-visualização: casa tanto status quanto marcadores. */
  function matchesFilter(record, filter) {
    if (!filter || filter === 'ALL') return true;
    if (filter === 'DUPLICADO') {
      return record.flags.includes(FLAG.DUPLICADO_RELACAO) || record.flags.includes(FLAG.DUPLICADO_LD);
    }
    if (filter === 'DATA_INVALIDA') return record.flags.includes(FLAG.DATA_INVALIDA);
    if (filter === 'CORRESPONDENCIA_APROXIMADA') return record.flags.includes(FLAG.CORRESPONDENCIA_APROXIMADA);
    return record.status === filter;
  }

  V.analyzer = { STATUS, STATUS_LABEL, FLAG, FLAG_LABEL, analyze, matchesFilter };
})(typeof self !== 'undefined' ? self : this);
