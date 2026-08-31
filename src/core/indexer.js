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
  const { squash, normalizeDocument, looseDocumentKey } = V.util;
  const X = V.xlsx;
  const D = V.dates;

  /**
   * Índice da Relação GRCON.
   *
   * Regra de duplicidade: vence a *última* ocorrência física do documento,
   * inclusive quando ela tiver data vazia — é a ordem em que o sistema de
   * origem emitiu as guias.
   */
  function buildRelationIndex(wb, model, mapping) {
    const documentCol = Number(mapping.documentCol);
    const grdtCol = Number(mapping.grdtCol);
    const dateCol = Number(mapping.dateCol);
    const revisionCol = Number(mapping.revisionCol) || null;
    const firstRow = Number(mapping.headerRow) + 1;

    const rows = [];
    const occurrences = new Map();

    for (let row = firstRow; row <= model.maxRow; row++) {
      const rawDocument = X.textAt(model, row, documentCol);
      const document = normalizeDocument(rawDocument);
      if (!document) continue;

      const grdtCell = X.getCell(model, row, grdtCol);
      const dateCell = X.getCell(model, row, dateCol);
      const revisionCell = revisionCol ? X.getCell(model, row, revisionCol) : null;

      const sourceDateRaw = dateCell
        ? dateCell.isDate
          ? X.cellDisplay(dateCell)
          : squash(dateCell.value !== '' ? dateCell.value : dateCell.numeric)
        : '';

      // Datas vindas de célula numérica já são seriais; texto passa pelo parser.
      const parsed = dateCell && dateCell.numeric !== null && dateCell.isDate
        ? D.serialToDate(D.truncateSerial(dateCell.numeric), wb.date1904)
        : D.parseDate(sourceDateRaw, wb.date1904);

      const dateValid = !!parsed && !D.isBlankDateToken(sourceDateRaw);

      const entry = {
        document,
        rawDocument,
        row,
        grdt: X.cellDisplay(grdtCell),
        revision: revisionCol ? X.cellDisplay(revisionCell) : '',
        sourceDateRaw,
        dateIso: dateValid ? D.formatIsoDate(parsed) : null,
        dateText: dateValid ? D.formatDate(parsed) : '',
        dateValid,
      };

      rows.push(entry);
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
        const signatures = new Set(list.map((x) => `${squash(x.grdt)} ${x.dateText}`));
        duplicates.push({
          document,
          count: list.length,
          selectedRow: winner.row,
          conflict: signatures.size > 1,
          candidates: list.map((x) => ({ row: x.row, grdt: x.grdt, dateText: x.dateText, dateValid: x.dateValid })),
        });
      }
    }

    return {
      rows,
      selected,
      duplicates,
      totalRows: rows.length,
      uniqueDocuments: selected.size,
      invalidDates: rows.filter((x) => !x.dateValid),
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
        // Campos que esta aba realmente possui: a de CV pode não repetir
        // todas as colunas da aba de documentos, e o que não existe aqui não
        // pode ser prometido na prévia nem gravado depois.
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

  /**
   * Índice global documento → ocorrências, unindo todas as LDs.
   * É a estrutura que transforma a busca em O(1).
   */
  function buildGlobalIndex(files) {
    const byDocument = new Map();
    // Índice secundário por chave frouxa (zero à esquerda, pontuação e
    // espaço interno ignorados). Custa pouco calcular sempre; só é
    // consultado quando o usuário liga a correspondência flexível.
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

  V.indexer = { buildRelationIndex, buildLdEntries, buildGlobalIndex };
})(typeof self !== 'undefined' ? self : this);
