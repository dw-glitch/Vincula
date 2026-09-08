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

  /** fileId → { name, hash, originalBytes, wb, indexes } */
  const registry = new Map();
  /** hash|nome → fileId, base do cache entre execuções da mesma sessão. */
  const fingerprints = new Map();

  const HEADER_SCAN_ROWS = 80;
  const HEADER_SCAN_COLS = 200;
  const MAX_GRID_CELLS = 8000;

  const MAX_LD_SHEETS_SCANNED = 24;
  const MAX_LD_TARGETS = 8;

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
    return [
      mapping.sheetPath,
      mapping.headerRow,
      mapping.documentCol,
      mapping.grdtCol,
      mapping.dateCol,
      mapping.dateEffectiveCol,
      mapping.dateGrdtCol,
      mapping.dateFallback ? 1 : 0,
      mapping.revisionCol,
      mapping.conferenceCol,
      mapping.sigemStatusCol,
      mapping.relationType,
    ].join('|');
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
    const lookup = gridLookup(grid);
    const maxRow = Math.min(grid.maxRow, HEADER_SCAN_ROWS);
    if (profile === 'relation') return V.headers.detectRelation(lookup, maxRow, grid.maxCol);
    return V.headers.detect(lookup, maxRow, grid.maxCol, profile);
  }

  /* ------------------------------------------------------------------ *
   * Alvos de atualização
   * ------------------------------------------------------------------ */

  function toMapping(info, detected, extra) {
    return {
      sheetName: info.name,
      sheetPath: info.path,
      headerRow: detected ? detected.headerRow : 1,
      documentCol: detected ? detected.documentCol : null,
      grdtCol: detected ? detected.grdtCol : null,
      dateCol: detected ? detected.dateCol : null,
      dateEffectiveCol: detected ? detected.dateEffectiveCol || null : null,
      dateGrdtCol: detected ? detected.dateGrdtCol || null : null,
      dateFallback: !!(detected && detected.dateFallback),
      revisionCol: detected ? detected.revisionCol : null,
      conferenceCol: detected ? detected.conferenceCol : null,
      sigemStatusCol: detected ? detected.sigemStatusCol : null,
      relationType: detected && detected.relationType ? detected.relationType : null,
      sourceLabel: detected && detected.sourceLabel ? detected.sourceLabel : '',
      sourceShortLabel: detected && detected.sourceShortLabel ? detected.sourceShortLabel : '',
      sourceDateLabel: detected && detected.sourceDateLabel ? detected.sourceDateLabel : '',
      confidence: detected ? detected.confidence : 'baixa',
      fieldScores: detected ? detected.fieldScores : {},
      role: info.role || null,
      roleLabel: detected && detected.sourceLabel ? detected.sourceLabel : V.headers.sheetRoleLabel(info.role),
      hidden: !!info.hidden,
      ...extra,
    };
  }

  function isUpdatableTarget(detected, role) {
    if (!detected || !detected.documentCol) return false;
    if (detected.matchedFields === 3) return true;
    return role === 'cv' && !!(detected.grdtCol || detected.dateCol);
  }

  function buildTargets(sheets, profile, primaryInfo, primaryDetected) {
    const primary = toMapping(primaryInfo, primaryDetected, { primary: true, enabled: true });
    if (profile !== 'ld') return [primary];

    const targets = [primary];
    for (const info of sheets) {
      if (info.path === primary.sheetPath || !info.detected) continue;
      if (!isUpdatableTarget(info.detected, info.role)) continue;
      if (targets.length >= MAX_LD_TARGETS) break;
      targets.push(toMapping(info, info.detected, { primary: false, enabled: !info.hidden }));
    }
    return targets;
  }

  /* ------------------------------------------------------------------ *
   * open — abre o arquivo, amostra os cabeçalhos e sugere o mapeamento
   * ------------------------------------------------------------------ */

  async function open({ fileId, name, bytes, hash, profile = 'ld' }, report) {
    const fingerprint = `${hash}|${name}|${profile}`;
    const cachedId = fingerprints.get(fingerprint);
    if (cachedId && registry.has(cachedId)) {
      const cached = registry.get(cachedId);
      registry.set(fileId, cached);
      return { ...toPayloadMeta(cached.meta), fileId, fromCache: true };
    }

    report && report({ phase: 'leitura', name });
    const wb = await X.open(bytes, name);

    const sheets = [];
    let suggestion = null;
    let suggestionSheet = null;
    let scannedCount = 0;

    for (const sheet of wb.sheets) {
      const role = V.headers.classifySheet(sheet.name);
      const info = {
        name: sheet.name,
        path: sheet.path,
        hidden: sheet.hidden,
        role,
        roleLabel: V.headers.sheetRoleLabel(role),
        scanned: false,
        maxRow: 0,
        maxCol: 0,
        grid: null,
        detected: null,
      };
      sheets.push(info);

      if (profile !== 'ld' && suggestion && suggestion.confidence === 'alta') continue;
      if (scannedCount >= MAX_LD_SHEETS_SCANNED) continue;

      const xml = await X.readSheetXml(wb, sheet);
      const dimension = readDimension(xml);
      const grid = buildGrid(wb, xml);
      scannedCount++;
      info.scanned = true;
      info.grid = grid;
      info.maxRow = Math.max(dimension?.maxRow || 0, grid.maxRow);
      info.maxCol = Math.max(dimension?.maxCol || 0, grid.maxCol);
      sheet.maxRow = info.maxRow;
      sheet.maxCol = info.maxCol;

      const detected = detectFromGrid(grid, V.headers.profileForSheet(profile, role));
      info.detected = detected;
      if (!suggestion || detected.score > suggestion.score) {
        suggestion = detected;
        suggestionSheet = info;
      }
    }

    const mappings = buildTargets(sheets, profile, suggestionSheet || sheets[0], suggestion);
    const primary = mappings[0];

    const meta = {
      fileId,
      name,
      hash,
      profile,
      relationType: profile === 'relation' ? primary.relationType || 'history' : null,
      sourceLabel: profile === 'relation' ? primary.sourceLabel || 'Histórico GRCON' : '',
      sourceShortLabel: profile === 'relation' ? primary.sourceShortLabel || 'Histórico' : '',
      date1904: wb.date1904,
      sheets,
      mapping: primary,
      mappings,
    };

    // Mantém os bytes recebidos para devolver uma LD byte a byte idêntica
    // quando a análise conclui que ela já está correta. Antes, arquivos sem
    // alterações nem sequer entravam na geração e desapareciam da entrega.
    const entry = { name, hash, profile, originalBytes: bytes, wb, meta, indexes: new Map() };
    registry.set(fileId, entry);
    fingerprints.set(fingerprint, fileId);
    return { ...toPayloadMeta(meta), fromCache: false };
  }

  /** Amostra sob demanda de uma aba ainda não decodificada. */
  async function scanSheet({ fileId, sheetPath, profile }) {
    const entry = entryOf(fileId);
    const info = entry.meta.sheets.find((s) => s.path === sheetPath);
    if (!info) throw new Error('Aba não encontrada: ' + sheetPath);
    const sheetProfile = V.headers.profileForSheet(profile || entry.profile, info.role);

    if (info.scanned) {
      const detected = detectFromGrid(info.grid, sheetProfile);
      info.detected = detected;
      return {
        fileId,
        sheetPath,
        role: info.role,
        roleLabel: info.roleLabel,
        grid: toPayloadGrid(info.grid),
        maxRow: info.maxRow,
        maxCol: info.maxCol,
        detected,
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
    const detected = detectFromGrid(grid, sheetProfile);
    info.detected = detected;
    return {
      fileId,
      sheetPath,
      role: info.role,
      roleLabel: info.roleLabel,
      grid: toPayloadGrid(info.grid),
      maxRow: info.maxRow,
      maxCol: info.maxCol,
      detected,
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
    const columns = [
      mapping.documentCol,
      mapping.grdtCol,
      mapping.dateCol,
      mapping.dateEffectiveCol,
      mapping.dateGrdtCol,
      mapping.revisionCol,
      mapping.conferenceCol,
      mapping.sigemStatusCol,
    ]
      .map(Number)
      .filter((value, index, list) => Number.isFinite(value) && value > 0 && list.indexOf(value) === index);
    const model = X.scanSheet(entry.wb, xml, { columns });
    try {
      return await fn(sheet, model);
    } finally {
      model.cells.clear();
      model.rows.clear();
      model.xml = '';
    }
  }

  /** Confere se a coluna de data corresponde ao tipo de relação identificado. */
  function validatePostingHeader(entry, mapping) {
    const info = entry.meta.sheets.find((s) => s.path === mapping.sheetPath);
    if (!info || !info.grid) return { ok: false, header: '', mode: 'missing' };

    const isConference = mapping.relationType === 'conference';
    const effectiveCol = Number(mapping.dateEffectiveCol) || null;
    const grdtDateCol = Number(mapping.dateGrdtCol) || null;
    const resolvedCol = isConference
      ? effectiveCol || Number(mapping.dateCol) || grdtDateCol
      : Number(mapping.dateCol) || grdtDateCol;
    if (!resolvedCol) return { ok: false, header: '', mode: 'missing' };

    const header = gridLookup(info.grid)(Number(mapping.headerRow), resolvedCol);
    let ok;
    let mode;

    if (isConference) {
      if (effectiveCol || V.headers.isConferenceDateHeader(header)) {
        ok = V.headers.isConferenceDateHeader(header);
        mode = ok ? 'effective' : 'invalid';
      } else {
        ok = V.headers.isGrdtDateHeader(header);
        mode = ok ? 'grdt-fallback' : 'invalid';
      }
    } else {
      ok = V.headers.isRelationDateHeader(header);
      mode = ok && V.headers.isGrdtDateHeader(header) ? 'grdt-legacy' : ok ? 'legacy' : 'invalid';
    }

    return { ok, header: normalizeHeader(header), mode };
  }

  function validateConferenceMapping(mapping) {
    if (mapping.relationType !== 'conference') return;
    if (!mapping.documentCol) {
      throw new Error('Não foi possível identificar a coluna “Código/Documento” na planilha de Conferência Histórico × Consulta Geral.');
    }
    if (!mapping.grdtCol) {
      throw new Error('Não foi possível identificar a coluna “Número da GRDT/eGRDT” na planilha de Conferência Histórico × Consulta Geral.');
    }
    if (!mapping.revisionCol) {
      throw new Error('Não foi possível identificar a coluna “Revisão enviada na GRDT” na planilha de Conferência Histórico × Consulta Geral.');
    }
    if (!mapping.dateEffectiveCol && !mapping.dateCol && !mapping.dateGrdtCol) {
      throw new Error('Não foi possível identificar uma coluna de data na Conferência Histórico × Consulta Geral. São aceitas “Data Efetiva de Emissão”, “Data da confirmação” ou “DATA EGRDT” no modo legado.');
    }
    if (!mapping.conferenceCol) {
      throw new Error('Não foi possível identificar a coluna “Conferência”, necessária para determinar se a postagem foi confirmada no SIGEM.');
    }
  }

  async function indexRelation({ fileId, mapping }, report) {
    const entry = entryOf(fileId);
    validateConferenceMapping(mapping);
    const key = 'rel:' + mappingKey(mapping);
    if (entry.indexes.has(key)) return { ...entry.indexes.get(key), fromCache: true };

    report && report({ phase: 'indexacao', name: entry.name });
    const check = validatePostingHeader(entry, mapping);
    const result = await withModel(entry, mapping, async (sheet, model) => {
      const index = V.indexer.buildRelationIndex(entry.wb, model, mapping);
      const dateKind = mapping.relationType === 'conference'
        ? 'Data Efetiva de Emissão / Data da confirmação / DATA EGRDT (fallback legado)'
        : 'data da Relação GRCON (postagem/geração, efetiva de emissão ou DATA EGRDT)';
      return {
        fileId,
        name: entry.name,
        sheetName: sheet.name,
        relationType: mapping.relationType || 'history',
        sourceLabel: mapping.sourceLabel || (mapping.relationType === 'conference' ? 'Conferência Histórico × Consulta Geral' : 'Histórico GRCON'),
        dateMode: check.mode,
        dateFallback: check.mode === 'grdt-fallback',
        headerWarning: check.ok ? null : `A coluna de data associada ("${check.header}") não é reconhecida como ${dateKind}.`,
        rows: index.rows,
        eligibleRows: index.eligibleRows,
        excludedRows: index.excludedRows,
        selected: index.selected,
        duplicates: index.duplicates,
        totalRows: index.totalRows,
        uniqueDocuments: index.uniqueDocuments,
        invalidDates: index.invalidDates,
        conferenceStats: index.conferenceStats,
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

  /**
   * Abas que esta chamada pode gravar: todas as mapeadas e habilitadas, sem
   * repetição — a mesma aba duas vezes gravaria duas vezes na mesma planilha.
   */
  function resolveTargets({ mapping, mappings }) {
    const list = [];
    const seen = new Set();
    for (const item of mappings && mappings.length ? mappings : mapping ? [mapping] : []) {
      if (!item || item.enabled === false || seen.has(item.sheetPath)) continue;
      seen.add(item.sheetPath);
      list.push(item);
    }
    if (!list.length) throw new Error('Nenhuma aba habilitada para atualização.');
    return list;
  }

  function groupPlanBySheet(plan, targets) {
    const groups = new Map(targets.map((target) => [target.sheetPath, []]));
    const discarded = [];
    for (const item of plan || []) {
      if (!item.sheetPath) {
        groups.get(targets[0].sheetPath).push(item);
        continue;
      }
      const bucket = groups.get(item.sheetPath);
      if (bucket) bucket.push(item);
      else discarded.push(item);
    }
    return { groups, discarded };
  }

  function mergeGuards(sheetResults) {
    const merged = { protected: false, merges: 0, validations: 0, conditional: 0, autoFilter: false };
    for (const result of sheetResults) {
      const guards = result.guards;
      if (!guards) continue;
      merged.protected = merged.protected || guards.protected;
      merged.merges += guards.merges || 0;
      merged.validations += guards.validations || 0;
      merged.conditional += guards.conditional || 0;
      merged.autoFilter = merged.autoFilter || guards.autoFilter;
    }
    return merged;
  }

  /** Atualiza todas as abas mapeadas do arquivo e fecha o pacote uma única vez. */
  async function apply({ fileId, mapping, mappings, plan, options }, report) {
    const entry = entryOf(fileId);
    const targets = resolveTargets({ mapping, mappings });
    const { groups, discarded } = groupPlanBySheet(plan, targets);
    report && report({ phase: 'atualizacao', name: entry.name });

    // Toda LD legível deve voltar ao usuário. Se nada precisa ser escrito,
    // devolvemos uma cópia dos bytes originais: é instantâneo, preserva o
    // arquivo integralmente e evita uma recompressão inútil do XLSX/XLSM.
    if (!(plan && plan.length)) {
      const bytes = entry.originalBytes.slice();
      return {
        ok: true,
        fileId,
        name: entry.name,
        sheetName: targets[0].sheetName,
        sheetNames: [],
        sheets: [],
        snapshotHash: entry.hash,
        results: [],
        occurrences: [],
        guards: { protected: false, merges: 0, validations: 0, conditional: 0, autoFilter: false },
        integrity: { verified: true, ok: true, comparedCells: 0, violations: [], byteIdentical: true },
        counters: { grdtWrites: 0, dateWrites: 0, revisionWrites: 0, authorizedCells: 0 },
        outputName: V.applier.outputName(entry.name),
        bytes,
        outputHash: entry.hash,
        unchanged: true,
      };
    }

    const sheetResults = [];
    let failure = null;

    for (const target of targets) {
      const items = groups.get(target.sheetPath) || [];
      if (!items.length) continue;
      const result = await withModel(entry, target, (sheet, model) =>
        V.applier.applySheetPlan(entry.wb, sheet, model, target, items, options || {})
      );
      sheetResults.push(result);
      if (!result.ok) {
        failure = result;
        break;
      }
    }

    const results = sheetResults.flatMap((result) => result.results || []);
    const occurrences = sheetResults.flatMap((result) => result.occurrences || []);
    for (const item of discarded) {
      results.push({
        recordId: item.recordId,
        outcome: V.applier.OUTCOME.BLOQUEADO,
        appliedFields: [],
        blockedFields: [],
        reason: `Aba "${item.sheetName || item.sheetPath}" não está entre as abas habilitadas para atualização.`,
      });
    }

    const sheets = sheetResults.map((result) => ({
      sheetName: result.sheetName,
      sheetPath: result.sheetPath,
      ok: result.ok,
      snapshotHash: result.snapshotHash,
      counters: result.counters || null,
      integrity: result.integrity || null,
      error: result.error || null,
    }));

    if (failure) {
      V.applier.rollback(entry.wb);
      return {
        ok: false,
        fileId,
        name: entry.name,
        sheetName: failure.sheetName,
        sheets,
        error: failure.error,
        snapshotHash: sheetResults[0] ? sheetResults[0].snapshotHash : null,
        results,
        occurrences,
        rolledBack: true,
      };
    }

    const counters = sheetResults.reduce(
      (total, result) => {
        const c = result.counters || {};
        total.grdtWrites += c.grdtWrites || 0;
        total.dateWrites += c.dateWrites || 0;
        total.revisionWrites += c.revisionWrites || 0;
        total.authorizedCells += c.authorizedCells || 0;
        return total;
      },
      { grdtWrites: 0, dateWrites: 0, revisionWrites: 0, authorizedCells: 0 }
    );

    const verified = sheetResults.length > 0 && sheetResults.every((result) => result.integrity && result.integrity.verified);
    const integrity = {
      verified,
      ok: sheetResults.every((result) => !result.integrity || result.integrity.ok),
      comparedCells: sheetResults.reduce((sum, result) => sum + ((result.integrity && result.integrity.comparedCells) || 0), 0),
      violations: sheetResults.flatMap((result) => (result.integrity && result.integrity.violations) || []),
    };

    const closed = await V.applier.finalize(entry.wb, options || {});
    return {
      ok: true,
      fileId,
      name: entry.name,
      sheetName: sheetResults.length ? sheetResults[0].sheetName : targets[0].sheetName,
      sheetNames: sheetResults.map((result) => result.sheetName),
      sheets,
      snapshotHash: sheetResults.length ? sheetResults[0].snapshotHash : null,
      results,
      occurrences,
      guards: mergeGuards(sheetResults),
      integrity,
      counters,
      ...closed,
    };
  }

  function release({ fileId }) {
    const entry = registry.get(fileId);
    if (!entry) return { released: false };
    registry.delete(fileId);
    for (const other of registry.values()) if (other === entry) return { released: true, shared: true };
    for (const [fingerprint, id] of fingerprints) if (id === fileId) fingerprints.delete(fingerprint);
    if (entry.wb) X.close(entry.wb);
    entry.originalBytes = null;
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
