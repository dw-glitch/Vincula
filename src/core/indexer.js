/**
 * Vincula — construção dos índices.
 *
 * Todo o desempenho do sistema nasce aqui: cada planilha é percorrida uma
 * única vez e transformada em estruturas de acesso direto. A busca de um
 * documento deixa de ser uma varredura O(n) por LD e passa a ser um acesso
 * O(1) em Map, independentemente da quantidade de LDs carregadas.
 *
 * Os índices trafegam entre worker e página, portanto usam apenas tipos
 * estruturados clonáveis: datas viajam como serial + ISO, nunca como Date.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { squash, normalizeDocument, looseDocumentKey, normalizeHeader } = V.util;
  const X = V.xlsx;
  const D = V.dates;

  /**
   * Rótulos de confirmação conhecidos do próprio GRCON. A versão atual do
   * relatório usa "Postado"; versões anteriores do módulo usavam
   * "Confirmado". A lista é fechada de propósito: nunca inferimos postagem
   * por um texto genérico nem pelo Status SIGEM.
   */
  const CONFIRMED_CONFERENCE = new Set([
    'POSTADO',
    'CONFIRMADO',
    'CONFIRMADA',
    'POSTAGEM CONFIRMADA',
    'POSTAGEM CONFIRMADO',
  ]);

  function isConfirmedConferenceStatus(value) {
    return CONFIRMED_CONFERENCE.has(normalizeHeader(value));
  }

  function readDateInfo(wb, cell) {
    const raw = cell
      ? cell.isDate
        ? X.cellDisplay(cell)
        : squash(cell.value !== '' ? cell.value : cell.numeric)
      : '';
    const parsed = cell && cell.numeric !== null && cell.isDate
      ? D.serialToDate(D.truncateSerial(cell.numeric), wb.date1904)
      : D.parseDate(raw, wb.date1904);
    const valid = !!parsed && !D.isBlankDateToken(raw);
    return {
      raw,
      valid,
      iso: valid ? D.formatIsoDate(parsed) : null,
      text: valid ? D.formatDate(parsed) : '',
    };
  }

  /**
   * Índice da Relação GRCON.
   *
   * Histórico normal: comportamento legado, em que todas as linhas válidas de
   * documento entram no índice e a última ocorrência física vence.
   *
   * Conferência Histórico × Consulta Geral: todas as linhas ficam registradas
   * em `rows` para auditoria, mas SOMENTE linhas cuja coluna Conferência diga
   * explicitamente que a postagem foi confirmada entram em `selected` e podem
   * chegar à lógica de atualização das LDs.
   *
   * A data da GRDT e a data efetiva/confirmação são mantidas separadas. Quando
   * as duas existem, somente a efetiva alimenta `dateText/dateIso`; DATA EGRDT
   * permanece disponível em `dateGrdt*`. O fallback para DATA EGRDT só ocorre
   * quando o relatório não possui coluna efetiva, preservando o fluxo legado.
   */
  function buildRelationIndex(wb, model, mapping) {
    const documentCol = Number(mapping.documentCol);
    const grdtCol = Number(mapping.grdtCol);
    const mappedDateCol = Number(mapping.dateCol) || null;
    const dateEffectiveCol = Number(mapping.dateEffectiveCol) || null;
    const dateGrdtCol = Number(mapping.dateGrdtCol) || null;
    const revisionCol = Number(mapping.revisionCol) || null;
    const conferenceCol = Number(mapping.conferenceCol) || null;
    const sigemStatusCol = Number(mapping.sigemStatusCol) || null;
    const relationType = mapping.relationType === 'conference' ? 'conference' : 'history';
    const firstRow = Number(mapping.headerRow) + 1;

    const rows = [];
    const eligibleRows = [];
    const excludedRows = [];
    const occurrences = new Map();
    const statusCounts = new Map();

    for (let row = firstRow; row <= model.maxRow; row++) {
      const rawDocument = X.textAt(model, row, documentCol);
      const document = normalizeDocument(rawDocument);
      if (!document) continue;

      const grdtCell = X.getCell(model, row, grdtCol);
      const mappedDateCell = mappedDateCol ? X.getCell(model, row, mappedDateCol) : null;
      const effectiveDateCell = dateEffectiveCol ? X.getCell(model, row, dateEffectiveCol) : null;
      const grdtDateCell = dateGrdtCol ? X.getCell(model, row, dateGrdtCol) : null;
      const revisionCell = revisionCol ? X.getCell(model, row, revisionCol) : null;
      const conferenceCell = conferenceCol ? X.getCell(model, row, conferenceCol) : null;
      const sigemStatusCell = sigemStatusCol ? X.getCell(model, row, sigemStatusCol) : null;

      const effectiveDate = readDateInfo(wb, effectiveDateCell);
      const grdtDate = readDateInfo(wb, grdtDateCell);
      const mappedDate = readDateInfo(wb, mappedDateCell);

      let selectedDate;
      let dateSource;
      if (relationType === 'conference') {
        if (dateEffectiveCol) {
          selectedDate = effectiveDate;
          dateSource = 'effective';
        } else if (dateGrdtCol || mapping.dateFallback) {
          selectedDate = dateGrdtCol ? grdtDate : mappedDate;
          dateSource = 'grdt-fallback';
        } else {
          selectedDate = mappedDate;
          dateSource = 'conference-legacy';
        }
      } else {
        selectedDate = mappedDateCol ? mappedDate : grdtDate;
        dateSource = dateGrdtCol && mappedDateCol === dateGrdtCol ? 'grdt-legacy' : 'history';
      }

      const conferenceStatus = conferenceCol ? X.cellDisplay(conferenceCell) : '';
      const sigemStatus = sigemStatusCol ? X.cellDisplay(sigemStatusCell) : '';
      const confirmedPost = relationType !== 'conference' || isConfirmedConferenceStatus(conferenceStatus);

      const entry = {
        document,
        rawDocument,
        row,
        relationType,
        grdt: X.cellDisplay(grdtCell),
        revision: revisionCol ? X.cellDisplay(revisionCell) : '',
        conferenceStatus,
        sigemStatus,
        confirmedPost,
        dateSource,
        sourceDateRaw: selectedDate.raw,
        dateIso: selectedDate.iso,
        dateText: selectedDate.text,
        dateValid: selectedDate.valid,
        dateEffectiveRaw: effectiveDate.raw,
        dateEffectiveIso: effectiveDate.iso,
        dateEffectiveText: effectiveDate.text,
        dateEffectiveValid: effectiveDate.valid,
        dateGrdtRaw: grdtDate.raw,
        dateGrdtIso: grdtDate.iso,
        dateGrdtText: grdtDate.text,
        dateGrdtValid: grdtDate.valid,
      };

      rows.push(entry);

      if (relationType === 'conference') {
        const statusKey = normalizeHeader(conferenceStatus) || '(VAZIO)';
        statusCounts.set(statusKey, (statusCounts.get(statusKey) || 0) + 1);
      }

      if (!confirmedPost) {
        entry.excludedReason = `Conferência "${conferenceStatus || 'vazia'}" não confirma postagem no SIGEM.`;
        excludedRows.push(entry);
        continue;
      }

      eligibleRows.push(entry);
      let list = occurrences.get(document);
      if (!list) occurrences.set(document, (list = []));
      list.push(entry);
    }

    const selected = new Map();
    const duplicates = [];
    for (const [document, list] of occurrences) {
      const winner = list[list.length - 1];
      selected.set(document, winner);
      if (list.length > 1) {
        const signatures = new Set(list.map((x) => `${squash(x.grdt)} ${squash(x.revision)} ${x.dateText}`));
        duplicates.push({
          document,
          count: list.length,
          selectedRow: winner.row,
          conflict: signatures.size > 1,
          candidates: list.map((x) => ({
            row: x.row,
            grdt: x.grdt,
            revision: x.revision,
            dateText: x.dateText,
            dateValid: x.dateValid,
            dateSource: x.dateSource,
            dateEffectiveText: x.dateEffectiveText,
            dateGrdtText: x.dateGrdtText,
            conferenceStatus: x.conferenceStatus,
          })),
        });
      }
    }

    const conferenceStats = relationType === 'conference'
      ? {
          total: rows.length,
          confirmed: eligibleRows.length,
          excluded: excludedRows.length,
          byStatus: Object.fromEntries(statusCounts),
        }
      : null;

    return {
      relationType,
      rows,
      eligibleRows,
      excludedRows,
      selected,
      duplicates,
      totalRows: rows.length,
      uniqueDocuments: selected.size,
      invalidDates: eligibleRows.filter((x) => !x.dateValid),
      conferenceStats,
    };
  }

  /**
   * Índice de uma aba de LD. Devolve uma lista plana e serializável; o índice
   * global (documento → ocorrências) é montado na página, unindo todas as LDs
   * e todas as abas mapeadas de cada uma — a de documentos e a de CV
   * (currículos), quando existe.
   */
  function buildLdEntries(wb, model, mapping, fileId) {
    const documentCol = Number(mapping.documentCol);
    const grdtCol = Number(mapping.grdtCol) || null;
    const dateCol = Number(mapping.dateCol) || null;
    const revisionCol = Number(mapping.revisionCol) || null;
    const firstRow = Number(mapping.headerRow) + 1;
    const sheetPath = mapping.sheetPath || '';
    const sheetName = mapping.sheetName || '';

    const entries = [];
    for (let row = firstRow; row <= model.maxRow; row++) {
      const rawDocument = X.textAt(model, row, documentCol);
      const document = normalizeDocument(rawDocument);
      if (!document) continue;

      const grdtCell = grdtCol ? X.getCell(model, row, grdtCol) : null;
      const dateCell = dateCol ? X.getCell(model, row, dateCol) : null;
      const revisionCell = revisionCol ? X.getCell(model, row, revisionCol) : null;

      entries.push({
        fileId,
        sheetPath,
        sheetName,
        document,
        rawDocument,
        row,
        beforeGrdt: X.cellDisplay(grdtCell),
        beforeDate: X.cellDisplay(dateCell),
        beforeDateSerial: dateCell && dateCell.isDate ? D.truncateSerial(dateCell.numeric) : null,
        beforeRevisao: revisionCol ? X.cellDisplay(revisionCell) : '',
        hasGrdtCol: !!grdtCol,
        hasDateCol: !!dateCol,
        hasRevisionCol: !!revisionCol,
        dateCellIsDate: !!(dateCell && dateCell.isDate),
        grdtHasFormula: !!(grdtCell && grdtCell.hasFormula),
        dateHasFormula: !!(dateCell && dateCell.hasFormula),
        revisionHasFormula: !!(revisionCell && revisionCell.hasFormula),
      });
    }
    return entries;
  }

  /** Índice global documento → ocorrências, unindo todas as LDs. */
  function buildGlobalIndex(files) {
    const byDocument = new Map();
    const byLooseKey = new Map();
    let total = 0;
    let duplicated = 0;

    for (const file of files) {
      for (const entry of file.entries) {
        let list = byDocument.get(entry.document);
        if (!list) byDocument.set(entry.document, (list = []));
        list.push(entry);
        total++;

        const loose = looseDocumentKey(entry.document);
        if (loose) {
          let looseList = byLooseKey.get(loose);
          if (!looseList) byLooseKey.set(loose, (looseList = []));
          looseList.push(entry.document);
        }
      }
    }
    for (const list of byDocument.values()) if (list.length > 1) duplicated++;

    return { byDocument, byLooseKey, totalEntries: total, uniqueDocuments: byDocument.size, duplicatedDocuments: duplicated };
  }

  V.indexer = {
    CONFIRMED_CONFERENCE,
    isConfirmedConferenceStatus,
    buildRelationIndex,
    buildLdEntries,
    buildGlobalIndex,
  };
})(typeof self !== 'undefined' ? self : this);
