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

  // Uma LD pode trazer mais de uma aba atualizável — tipicamente a lista de
  // documentos e a aba de CV (currículos). Todas as abas da LD são amostradas
  // para que nenhuma fique de fora; o teto existe só para conter o custo em
  // pastas de trabalho com dezenas de abas auxiliares.
  const MAX_LD_SHEETS_SCANNED = 24;
  const MAX_LD_TARGETS = 8;

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
   * Alvos de atualização
   *
   * Um alvo é uma aba mapeada: aba + linha de cabeçalho + colunas. A Relação
   * GRCON tem sempre um único alvo; a LD pode ter mais de um — a lista de
   * documentos e a aba de CV (currículos) são o caso corrente, e as duas
   * precisam ser atualizadas na mesma passada.
   * ------------------------------------------------------------------ */

  function toMapping(info, detected, extra) {
    return {
      sheetName: info.name,
      sheetPath: info.path,
      headerRow: detected ? detected.headerRow : 1,
      documentCol: detected ? detected.documentCol : null,
      grdtCol: detected ? detected.grdtCol : null,
      dateCol: detected ? detected.dateCol : null,
      revisionCol: detected ? detected.revisionCol : null,
      confidence: detected ? detected.confidence : 'baixa',
      fieldScores: detected ? detected.fieldScores : {},
      role: info.role || null,
      roleLabel: V.headers.sheetRoleLabel(info.role),
      hidden: !!info.hidden,
      ...extra,
    };
  }

  /**
   * Uma aba secundária só entra sozinha como alvo quando o cabeçalho resolve
   * os três campos obrigatórios (documento, GRDT e data). A aba de CV é a
   * única exceção controlada: identificada pelo nome, basta ter a coluna de
   * documento e ao menos um campo gravável para ser proposta — é comum que a
   * lista de currículos não repita todas as colunas da aba de documentos.
   */
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
      // Aba oculta entra na lista, porém desmarcada: gravar em algo que o
      // usuário não vê precisa ser uma decisão dele, nunca um efeito colateral.
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

      // Na LD, toda aba é amostrada: a lista de documentos e a de CV
      // (currículos) são atualizadas juntas, e só a varredura revela quais
      // abas têm cabeçalho utilizável. Na Relação, uma única aba é usada —
      // então a decodificação para assim que uma resolve os três campos.
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

    const meta = {
      fileId,
      name,
      hash,
      profile,
      date1904: wb.date1904,
      sheets,
      mapping: mappings[0],
      mappings,
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
    // A aba de CV é reconhecida pelo nome e detectada com o perfil próprio.
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
      grid: toPayloadGrid(grid),
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

  /**
   * Distribui os itens do plano entre as abas. Um item que aponta para uma aba
   * que não está entre os alvos habilitados é descartado, nunca redirecionado:
   * a mesma linha em outra aba é outro documento.
   */
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

  /**
   * Atualiza todas as abas mapeadas do arquivo e fecha o pacote uma única vez.
   * Se qualquer aba reprovar na auditoria de integridade, nada é gravado: o
   * arquivo gerado nunca mistura uma aba nova com outra revertida.
   */
  async function apply({ fileId, mapping, mappings, plan, options }, report) {
    const entry = entryOf(fileId);
    const targets = resolveTargets({ mapping, mappings });
    const { groups, discarded } = groupPlanBySheet(plan, targets);
    report && report({ phase: 'atualizacao', name: entry.name });

    const sheetResults = [];
    let failure = null;

    for (const target of targets) {
      const items = groups.get(target.sheetPath) || [];
      // Aba sem nada a gravar não é reaberta: poupa a leitura do XML inteiro.
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
      // Rollback total: as emendas de todas as abas são descartadas juntas.
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
