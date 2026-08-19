/**
 * Vincula — tarefas executáveis sobre uma pasta de trabalho.
 *
 * Este módulo é o contrato entre a página e os Web Workers: as mesmas funções
 * rodam dentro do worker (caminho normal) ou na própria página (contingência,
 * quando workers não estão disponíveis — por exemplo ao abrir o index.html
 * direto do disco). Nada aqui toca no DOM.
 *
 * Política de memória: o XML da aba é carregado sob demanda e liberado assim
 * que a etapa termina. Entre as etapas permanece apenas o ZIP comprimido e o
 * índice (poucos bytes por documento), o que mantém o consumo estável mesmo
 * com centenas de LDs.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { normalizeHeader, indexToColumn, parseRef } = V.util;
  const X = V.xlsx;

  /** fileId → { name, hash, wb, indexes } */
  const registry = new Map();
  /** hash|nome → fileId, base do cache entre execuções da mesma sessão. */
  const fingerprints = new Map();

  const HEADER_SCAN_ROWS = 80;
  const HEADER_SCAN_COLS = 200;
  const MAX_GRID_CELLS = 8000;

  // A amostra completa fica no worker (é o que alimenta a detecção). Para a
  // página vai só o recorte que os seletores de mapeamento precisam — com 100
  // LDs abertas, enviar a amostra inteira de cada arquivo custaria dezenas de
  // megabytes de estruturas vivas na thread da interface.
  const PAYLOAD_ROWS = 40;
  const PAYLOAD_COLS = 80;
  const PAYLOAD_MAX_CELLS = 1500;

  function toPayloadGrid(grid) {
    if (!grid) return null;
    const cells = [];
    for (const cell of grid.cells) {
      if (cell.r > PAYLOAD_ROWS || cell.c > PAYLOAD_COLS) continue;
      cells.push(cell);
      if (cells.length >= PAYLOAD_MAX_CELLS) break;
    }
    return { cells, maxRow: grid.maxRow, maxCol: grid.maxCol, truncated: cells.length < grid.cells.length };
  }

  /** Cópia serializável dos metadados, sem as amostras completas. */
  function toPayloadMeta(meta) {
    return {
      ...meta,
      sheets: meta.sheets.map((sheet) => ({ ...sheet, grid: toPayloadGrid(sheet.grid) })),
    };
  }

  function mappingKey(mapping) {
    return [mapping.sheetPath, mapping.headerRow, mapping.documentCol, mapping.grdtCol, mapping.dateCol, mapping.revisionCol].join('|');
  }

  function entryOf(fileId) {
    const entry = registry.get(fileId);
    if (!entry) throw new Error('Arquivo não está carregado nesta sessão (id ' + fileId + ').');
    return entry;
  }

  /** Dimensão declarada pelo Excel — evita varrer a planilha só para contar. */
  function readDimension(xml) {
    const m = /<dimension\b[^>]*ref="([^"]+)"/.exec(xml);
    if (!m) return null;
    const [, range] = m;
    const parts = range.split(':');
    const to = parseRef(parts[parts.length - 1]);
    return to ? { maxRow: to.row, maxCol: to.col } : null;
  }

  /** Amostra do topo da aba: alimenta a detecção e os seletores da interface. */
  function buildGrid(wb, xml) {
    const model = X.scanSheet(wb, xml, { maxRows: HEADER_SCAN_ROWS });
    const cells = [];
    for (const cell of model.cells.values()) {
      if (cell.col > HEADER_SCAN_COLS) continue;
      const text = X.cellDisplay(cell);
      if (!text) continue;
      cells.push({ r: cell.row, c: cell.col, v: text });
      if (cells.length >= MAX_GRID_CELLS) break;
    }
    return { cells, maxRow: model.maxRow, maxCol: model.maxCol };
  }

  function gridLookup(grid) {
    const map = new Map();
    for (const cell of grid.cells) map.set(cell.r * 16384 + cell.c, cell.v);
    return (row, col) => map.get(row * 16384 + col) || '';
  }

  function detectFromGrid(grid, profile) {
    return V.headers.detect(gridLookup(grid), Math.min(grid.maxRow, HEADER_SCAN_ROWS), grid.maxCol, profile);
  }

  /* ------------------------------------------------------------------ *
   * open — abre o arquivo, amostra os cabeçalhos e sugere o mapeamento
   * ------------------------------------------------------------------ */

  async function open({ fileId, name, bytes, hash, profile = 'ld' }, report) {
    const fingerprint = `${hash}|${name}|${profile}`;
    const cachedId = fingerprints.get(fingerprint);
    if (cachedId && registry.has(cachedId)) {
      // Mesmo conteúdo já indexado nesta sessão: nada é reprocessado.
      const cached = registry.get(cachedId);
      registry.set(fileId, cached);
      return { ...toPayloadMeta(cached.meta), fileId, fromCache: true };
    }

    report && report({ phase: 'leitura', name });
    const wb = await X.open(bytes, name);

    const sheets = [];
    let suggestion = null;
    let suggestionSheet = null;

    for (const sheet of wb.sheets) {
      const info = { name: sheet.name, path: sheet.path, hidden: sheet.hidden, scanned: false, maxRow: 0, maxCol: 0, grid: null };
      sheets.push(info);

      // Interrompe a decodificação assim que uma aba resolve os três campos.
      if (suggestion && suggestion.confidence === 'alta') continue;

      const xml = await X.readSheetXml(wb, sheet);
      const dimension = readDimension(xml);
      const grid = buildGrid(wb, xml);
      info.scanned = true;
      info.grid = grid;
      info.maxRow = Math.max(dimension?.maxRow || 0, grid.maxRow);
      info.maxCol = Math.max(dimension?.maxCol || 0, grid.maxCol);
      sheet.maxRow = info.maxRow;
      sheet.maxCol = info.maxCol;

      const detected = detectFromGrid(grid, profile);
      if (!suggestion || detected.score > suggestion.score) {
        suggestion = detected;
        suggestionSheet = info;
      }
    }

    const meta = {
      fileId,
      name,
      hash,
      profile,
      date1904: wb.date1904,
      sheets,
      mapping: {
        sheetName: suggestionSheet ? suggestionSheet.name : sheets[0].name,
        sheetPath: suggestionSheet ? suggestionSheet.path : sheets[0].path,
        headerRow: suggestion ? suggestion.headerRow : 1,
        documentCol: suggestion ? suggestion.documentCol : null,
        grdtCol: suggestion ? suggestion.grdtCol : null,
        dateCol: suggestion ? suggestion.dateCol : null,
        revisionCol: suggestion ? suggestion.revisionCol : null,
        confidence: suggestion ? suggestion.confidence : 'baixa',
        fieldScores: suggestion ? suggestion.fieldScores : {},
      },
    };

    const entry = { name, hash, profile, wb, meta, indexes: new Map() };
    registry.set(fileId, entry);
    fingerprints.set(fingerprint, fileId);
    return { ...toPayloadMeta(meta), fromCache: false };
  }

  /** Amostra sob demanda de uma aba ainda não decodificada. */
  async function scanSheet({ fileId, sheetPath, profile }) {
    const entry = entryOf(fileId);
    const info = entry.meta.sheets.find((s) => s.path === sheetPath);
    if (!info) throw new Error('Aba não encontrada: ' + sheetPath);
    if (info.scanned) {
      return {
        fileId,
        sheetPath,
        grid: toPayloadGrid(info.grid),
        maxRow: info.maxRow,
        maxCol: info.maxCol,
        detected: detectFromGrid(info.grid, profile || entry.profile),
      };
    }

    const sheet = X.findSheet(entry.wb, sheetPath);
    const xml = await X.readSheetXml(entry.wb, sheet);
    const dimension = readDimension(xml);
    const grid = buildGrid(entry.wb, xml);
    info.scanned = true;
    info.grid = grid;
    info.maxRow = Math.max(dimension?.maxRow || 0, grid.maxRow);
    info.maxCol = Math.max(dimension?.maxCol || 0, grid.maxCol);
    return {
      fileId,
      sheetPath,
      grid: toPayloadGrid(grid),
      maxRow: info.maxRow,
      maxCol: info.maxCol,
      detected: detectFromGrid(grid, profile || entry.profile),
    };
  }

  /** Cabeçalhos de uma linha, para os seletores de coluna da interface. */
  function columnOptions({ fileId, sheetPath, headerRow }) {
    const entry = entryOf(fileId);
    const info = entry.meta.sheets.find((s) => s.path === sheetPath);
    if (!info || !info.grid) return { columns: [] };
    const lookup = gridLookup(info.grid);
    const columns = [];
    const limit = Math.max(info.grid.maxCol, 12);
    for (let col = 1; col <= limit; col++) {
      columns.push({ index: col, letter: indexToColumn(col), header: lookup(headerRow, col) || '(sem cabeçalho)' });
    }
    return { columns };
  }

  /* ------------------------------------------------------------------ *
   * Carga sob demanda do modelo completo da aba
   * ------------------------------------------------------------------ */

  async function withModel(entry, mapping, fn) {
    const sheet = X.findSheet(entry.wb, mapping.sheetPath) || X.findSheet(entry.wb, mapping.sheetName);
    if (!sheet) throw new Error(`Aba "${mapping.sheetName || mapping.sheetPath}" não encontrada em ${entry.name}.`);
    const xml = await X.readSheetXml(entry.wb, sheet);
    const model = X.scanSheet(entry.wb, xml, {
      columns: [Number(mapping.documentCol), Number(mapping.grdtCol), Number(mapping.dateCol), Number(mapping.revisionCol)],
    });
    try {
      return await fn(sheet, model);
    } finally {
      // Libera o maior consumidor de memória assim que a etapa termina.
      model.cells.clear();
      model.rows.clear();
      model.xml = '';
    }
  }

  /**
   * Confere se a coluna de data associada à relação é reconhecível como a
   * data-fonte do documento — aceita tanto "geração/postagem" quanto
   * "efetiva de emissão", já que exports diferentes de GRCON rotulam essa
   * mesma coluna de formas diferentes.
   */
  function validatePostingHeader(entry, mapping) {
    const info = entry.meta.sheets.find((s) => s.path === mapping.sheetPath);
    if (!info || !info.grid) return { ok: true, header: '' };
    const header = gridLookup(info.grid)(Number(mapping.headerRow), Number(mapping.dateCol));
    return { ok: V.headers.isRelationDateHeader(header), header: normalizeHeader(header) };
  }

  async function indexRelation({ fileId, mapping }, report) {
    const entry = entryOf(fileId);
    const key = 'rel:' + mappingKey(mapping);
    if (entry.indexes.has(key)) return { ...entry.indexes.get(key), fromCache: true };

    report && report({ phase: 'indexacao', name: entry.name });
    const check = validatePostingHeader(entry, mapping);
    const result = await withModel(entry, mapping, async (sheet, model) => {
      const index = V.indexer.buildRelationIndex(entry.wb, model, mapping);
      return {
        fileId,
        name: entry.name,
        sheetName: sheet.name,
        headerWarning: check.ok ? null : `A coluna de data associada ("${check.header}") não é reconhecida como data da Relação GRCON (postagem/geração ou efetiva de emissão).`,
        rows: index.rows,
        selected: index.selected,
        duplicates: index.duplicates,
        totalRows: index.totalRows,
        uniqueDocuments: index.uniqueDocuments,
        invalidDates: index.invalidDates,
      };
    });
    entry.indexes.set(key, result);
    return { ...result, fromCache: false };
  }

  async function indexLd({ fileId, mapping }, report) {
    const entry = entryOf(fileId);
    const key = 'ld:' + mappingKey(mapping);
    if (entry.indexes.has(key)) return { ...entry.indexes.get(key), fromCache: true };

    report && report({ phase: 'indexacao', name: entry.name });
    const result = await withModel(entry, mapping, async (sheet, model) => ({
      fileId,
      name: entry.name,
      sheetName: sheet.name,
      rowCount: model.maxRow,
      entries: V.indexer.buildLdEntries(entry.wb, model, mapping, fileId),
    }));
    entry.indexes.set(key, result);
    return { ...result, fromCache: false };
  }

  async function apply({ fileId, mapping, plan, options }, report) {
    const entry = entryOf(fileId);
    report && report({ phase: 'atualizacao', name: entry.name });
    return withModel(entry, mapping, async (sheet, model) => {
      const result = await V.applier.applyPlan(entry.wb, sheet, model, mapping, plan || [], options || {});
      return { fileId, name: entry.name, sheetName: sheet.name, ...result };
    });
  }

  function release({ fileId }) {
    const entry = registry.get(fileId);
    if (!entry) return { released: false };
    registry.delete(fileId);
    // Só descarta o ZIP quando nenhum outro id aponta para a mesma entrada.
    for (const other of registry.values()) if (other === entry) return { released: true, shared: true };
    for (const [fingerprint, id] of fingerprints) if (id === fileId) fingerprints.delete(fingerprint);
    if (entry.wb) X.close(entry.wb);
    entry.indexes.clear();
    return { released: true };
  }

  function releaseAll() {
    for (const fileId of [...registry.keys()]) release({ fileId });
    registry.clear();
    fingerprints.clear();
    return { released: true };
  }

  function stats() {
    return { openFiles: registry.size, cachedFingerprints: fingerprints.size };
  }

  V.tasks = {
    open,
    scanSheet,
    columnOptions,
    indexRelation,
    indexLd,
    apply,
    release,
    releaseAll,
    stats,
  };
})(typeof self !== 'undefined' ? self : this);
