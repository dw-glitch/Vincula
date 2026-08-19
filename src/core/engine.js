/**
 * Vincula — orquestrador da execução.
 *
 * Conhece o fluxo completo (leitura → indexação → análise → atualização →
 * auditoria → compactação), distribui o trabalho pelo pool e publica métricas
 * em tempo real. Não toca no DOM: a interface se inscreve nos eventos.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { sha256Hex } = V.util;

  const STAGES = {
    leitura: 'Leitura',
    indexacao: 'Preparação',
    analise: 'Análise',
    atualizacao: 'Atualização',
    relatorio: 'Relatório',
    compactacao: 'Finalização',
  };

  class CancelledError extends Error {
    constructor() {
      super('Processamento cancelado pelo usuário.');
      this.name = 'CancelledError';
      this.cancelled = true;
    }
  }

  function createEngine(options = {}) {
    const pool = V.createPool({ size: options.poolSize, workerUrl: options.workerUrl });
    const listeners = { progress: [], metrics: [], log: [] };

    let sequence = 0;
    let cancelled = false;

    const state = {
      relation: null,
      lds: [],
      analysis: null,
      outputs: [],
      report: null,
      packageBlob: null,
      auditBlob: null,
      logBlob: null,
      timings: {},
    };

    const metrics = {
      ldsTotal: 0,
      ldsProcessed: 0,
      documentsIndexed: 0,
      documentsProcessed: 0,
      documentsFound: 0,
      documentsChanged: 0,
      cellsWritten: 0,
      startedAt: 0,
      rate: 0,
      eta: 0,
    };

    /* ---------------------------------------------------------------- *
     * Eventos
     * ---------------------------------------------------------------- */

    function on(event, handler) {
      (listeners[event] || (listeners[event] = [])).push(handler);
      return () => off(event, handler);
    }
    function off(event, handler) {
      const list = listeners[event];
      if (list) listeners[event] = list.filter((h) => h !== handler);
    }
    function emit(event, payload) {
      for (const handler of listeners[event] || []) {
        try {
          handler(payload);
        } catch (error) {
          console.error('[Vincula] listener falhou', error);
        }
      }
    }

    function log(level, message, detail) {
      emit('log', { at: new Date().toISOString(), level, message, detail });
    }

    function progress(stage, percent, detail) {
      emit('progress', {
        stage,
        label: STAGES[stage] || stage,
        percent: Math.max(0, Math.min(100, percent)),
        detail: detail || '',
      });
    }

    function publishMetrics() {
      const elapsed = metrics.startedAt ? Date.now() - metrics.startedAt : 0;
      metrics.rate = elapsed > 250 ? metrics.documentsProcessed / (elapsed / 1000) : 0;
      const remaining = Math.max(0, metrics.documentsIndexed - metrics.documentsProcessed);
      metrics.eta = metrics.rate > 0 ? Math.round((remaining / metrics.rate) * 1000) : 0;
      metrics.elapsed = elapsed;
      emit('metrics', { ...metrics });
    }

    function checkCancelled() {
      if (cancelled) throw new CancelledError();
    }

    /* ---------------------------------------------------------------- *
     * Carga de arquivos
     * ---------------------------------------------------------------- */

    async function readFile(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes);
      return { bytes, hash };
    }

    async function openInPool(file, profile, fileId, onProgress) {
      const { bytes, hash } = await readFile(file);
      // O buffer é transferido: o worker passa a ser o dono, sem cópia.
      return pool.run(
        'open',
        { fileId, name: file.name, bytes, hash, profile },
        { transfer: [bytes.buffer], fileId, onProgress }
      );
    }

    async function loadRelation(file) {
      await pool.ready();
      cancelled = false;
      pool.resume();
      const started = Date.now();
      progress('leitura', 10, `Lendo ${file.name}`);

      const fileId = `rel-${++sequence}`;
      const meta = await openInPool(file, 'relation', fileId);
      state.relation = {
        fileId,
        name: file.name,
        size: file.size,
        hash: meta.hash,
        meta,
        mapping: { ...meta.mapping },
      };
      state.analysis = null;
      state.timings.leituraRelacao = Date.now() - started;
      progress('leitura', 100, `Relação carregada · ${meta.sheets.length} aba(s)`);
      log('info', `Relação GRCON carregada: ${file.name}`, { abas: meta.sheets.length, cache: meta.fromCache });
      return state.relation;
    }

    async function loadLds(files) {
      await pool.ready();
      cancelled = false;
      pool.resume();
      const started = Date.now();
      metrics.ldsTotal = files.length;
      metrics.ldsProcessed = 0;
      publishMetrics();

      const descriptors = files.map((file) => ({ file, fileId: `ld-${++sequence}` }));
      progress('leitura', 2, `Lendo ${files.length} LD(s)`);

      // A leitura do File acontece na página (FileReader não cruza o worker);
      // a abertura do ZIP e a varredura, no worker. O pool limita quantos
      // arquivos ficam em voo, o que mantém o pico de memória sob controle.
      const loaded = [];
      let done = 0;
      await Promise.all(
        descriptors.map(async ({ file, fileId }) => {
          try {
            checkCancelled();
            const meta = await openInPool(file, 'ld', fileId);
            loaded.push({
              fileId,
              name: file.name,
              size: file.size,
              hash: meta.hash,
              meta,
              mapping: { ...meta.mapping },
              fromCache: meta.fromCache,
            });
          } catch (error) {
            loaded.push({ fileId, name: file.name, size: file.size, error: error.message });
            log('error', `Falha ao ler ${file.name}`, error.message);
          } finally {
            done++;
            metrics.ldsProcessed = done;
            publishMetrics();
            progress('leitura', Math.round((done / descriptors.length) * 100), `${done}/${descriptors.length} LD(s) lida(s)`);
          }
        })
      );

      loaded.sort((a, b) => descriptors.findIndex((d) => d.fileId === a.fileId) - descriptors.findIndex((d) => d.fileId === b.fileId));
      state.lds = loaded;
      state.analysis = null;
      state.timings.leituraLds = Date.now() - started;
      log('info', `${loaded.filter((l) => !l.error).length} LD(s) carregada(s)`, { tempoMs: state.timings.leituraLds });
      return state.lds;
    }

    /** Reamostra uma aba diferente da sugerida, sob demanda da interface. */
    async function inspectSheet(fileId, sheetPath, profile) {
      return pool.run('scanSheet', { fileId, sheetPath, profile }, { fileId });
    }

    async function columnOptions(fileId, sheetPath, headerRow) {
      return pool.run('columnOptions', { fileId, sheetPath, headerRow }, { fileId });
    }

    /* ---------------------------------------------------------------- *
     * Análise
     * ---------------------------------------------------------------- */

    function validateMappings() {
      const targets = [
        { label: `Relação ${state.relation.name}`, mapping: state.relation.mapping },
        ...state.lds.filter((ld) => !ld.error).map((ld) => ({ label: ld.name, mapping: ld.mapping })),
      ];
      for (const target of targets) {
        const { documentCol, grdtCol, dateCol, revisionCol } = target.mapping;
        if (!documentCol || !grdtCol || !dateCol) {
          throw new Error(`Associe Documento, GRDT e Data em "${target.label}".`);
        }
        const cols = [documentCol, grdtCol, dateCol];
        if (revisionCol) cols.push(revisionCol);
        if (new Set(cols).size < cols.length) {
          throw new Error(`Uma mesma coluna foi associada a dois campos em "${target.label}".`);
        }
      }
    }

    async function analyze(analysisOptions = {}) {
      checkCancelled();
      if (!state.relation) throw new Error('Carregue a Relação GRCON.');
      const usable = state.lds.filter((ld) => !ld.error);
      if (!usable.length) throw new Error('Carregue ao menos uma LD legível.');
      validateMappings();

      const started = Date.now();
      metrics.startedAt = started;
      metrics.documentsProcessed = 0;
      metrics.documentsIndexed = 0;
      publishMetrics();

      progress('indexacao', 5, 'Indexando a Relação GRCON');
      const relationIndex = await pool.run(
        'indexRelation',
        { fileId: state.relation.fileId, mapping: state.relation.mapping },
        { fileId: state.relation.fileId }
      );
      checkCancelled();
      if (relationIndex.headerWarning) log('warn', relationIndex.headerWarning);

      metrics.documentsIndexed = relationIndex.uniqueDocuments;
      publishMetrics();
      progress('indexacao', 25, `${relationIndex.uniqueDocuments} documento(s) únicos na relação`);

      let indexed = 0;
      const files = new Map();
      const ldIndexes = await pool.map(
        usable,
        (ld) => ({ type: 'indexLd', payload: { fileId: ld.fileId, mapping: ld.mapping }, fileId: ld.fileId }),
        (result) => {
          indexed++;
          progress(
            'indexacao',
            25 + Math.round((indexed / usable.length) * 65),
            `${indexed}/${usable.length} LD(s) indexada(s)${result.value && result.value.fromCache ? ' (cache)' : ''}`
          );
          publishMetrics();
        }
      );
      checkCancelled();

      const indexedFiles = [];
      for (let i = 0; i < ldIndexes.length; i++) {
        const result = ldIndexes[i];
        const ld = usable[i];
        if (!result.ok) {
          log('error', `Falha ao indexar ${ld.name}`, result.error.message);
          continue;
        }
        files.set(ld.fileId, { id: ld.fileId, name: result.value.name, sheetName: result.value.sheetName });
        indexedFiles.push(result.value);
      }
      if (!indexedFiles.length) throw new Error('Nenhuma LD pôde ser indexada.');

      progress('analise', 92, 'Cruzando relação e LDs');
      const globalIndex = V.indexer.buildGlobalIndex(indexedFiles);
      const analysis = V.analyzer.analyze(relationIndex, globalIndex, files, analysisOptions);

      // Enriquecimento para o relatório: valor bruto da data de origem.
      const rawByDocument = new Map(relationIndex.rows.map((r) => [r.document, r]));
      for (const record of analysis.records) {
        const source = rawByDocument.get(record.document);
        record.sourceDateRaw = source ? source.sourceDateRaw : '';
      }

      analysis.relationIndex = relationIndex;
      analysis.globalIndex = globalIndex;
      analysis.files = files;
      state.analysis = analysis;
      state.timings.indexacao = Date.now() - started;

      metrics.documentsIndexed = analysis.records.length;
      metrics.documentsProcessed = analysis.records.length;
      metrics.documentsFound = analysis.stats.found;
      metrics.documentsChanged = analysis.stats.willChange;
      publishMetrics();

      progress('analise', 100, `${analysis.stats.willChange} alteração(ões) prevista(s)`);
      log('info', 'Análise concluída', analysis.stats);
      return analysis;
    }

    /* ---------------------------------------------------------------- *
     * Atualização e empacotamento
     * ---------------------------------------------------------------- */

    async function generate(generateOptions = {}) {
      checkCancelled();
      if (!state.analysis) throw new Error('Execute a análise antes de gerar.');

      const started = Date.now();
      metrics.startedAt = started;
      metrics.documentsProcessed = 0;
      metrics.cellsWritten = 0;
      publishMetrics();

      const analysis = state.analysis;
      const byId = new Map(state.lds.map((ld) => [ld.fileId, ld]));
      const targets = [...analysis.plans.entries()].map(([fileId, plan]) => ({ ld: byId.get(fileId), plan }));

      if (!targets.length) {
        log('warn', 'Nenhuma alteração a aplicar: todos os valores já conferem.');
      }

      progress('atualizacao', 2, `Atualizando ${targets.length} LD(s)`);
      let finished = 0;
      const applied = await pool.map(
        targets,
        ({ ld, plan }) => ({
          type: 'apply',
          payload: {
            fileId: ld.fileId,
            mapping: ld.mapping,
            plan,
            options: { verify: generateOptions.verify !== false, level: 9 },
          },
          fileId: ld.fileId,
        }),
        (result) => {
          finished++;
          if (result.ok && result.value.ok) {
            metrics.cellsWritten += result.value.counters.authorizedCells;
            metrics.documentsProcessed += result.value.results.filter((r) => r.outcome === 'APLICADO').length;
          }
          progress('atualizacao', Math.round((finished / targets.length) * 100), `${finished}/${targets.length} LD(s) atualizada(s)`);
          publishMetrics();
        }
      );
      checkCancelled();

      const outputs = [];
      const occurrences = [];
      const failures = [];
      const outcomeByRecord = new Map();

      for (let i = 0; i < applied.length; i++) {
        const result = applied[i];
        const target = targets[i];
        if (!result.ok) {
          failures.push({ file: target.ld.name, error: result.error.message });
          log('error', `Falha ao atualizar ${target.ld.name}`, result.error.message);
          continue;
        }
        const value = result.value;
        occurrences.push(...(value.occurrences || []));
        for (const item of value.results || []) outcomeByRecord.set(item.recordId, item);

        if (!value.ok) {
          failures.push({ file: target.ld.name, error: value.error });
          log('error', `Atualização revertida em ${target.ld.name}`, value.error);
          continue;
        }
        outputs.push({
          name: value.outputName,
          source: value.name,
          bytes: value.bytes,
          size: value.bytes.length,
          hash: value.outputHash,
          snapshotHash: value.snapshotHash,
          authorizedCells: value.counters.authorizedCells,
          grdtWrites: value.counters.grdtWrites,
          dateWrites: value.counters.dateWrites,
          revisionWrites: value.counters.revisionWrites,
          integrity: value.integrity.verified ? (value.integrity.ok ? 'APROVADA' : 'REPROVADA') : 'NÃO VERIFICADA',
          comparedCells: value.integrity.comparedCells,
          guards: value.guards,
        });
      }

      state.timings.atualizacao = Date.now() - started;

      // Consolida o desfecho real de cada registro (inclusive bloqueios).
      const timestamp = new Date().toISOString();
      for (const record of analysis.records) {
        const outcome = outcomeByRecord.get(record.id);
        record.timestamp = timestamp;
        if (!outcome) continue;
        if (outcome.outcome === 'BLOQUEADO') {
          record.status = V.analyzer.STATUS.BLOQUEADO;
          record.grdtWillChange = outcome.appliedFields?.includes('GRDT') || false;
          record.dateWillChange = outcome.appliedFields?.includes('DATA') || false;
          record.revisionWillChange = outcome.appliedFields?.includes('REVISAO') || false;
          record.reason = `${record.reason} ${outcome.reason || ''}`.trim();
        } else if (outcome.blockedFields && outcome.blockedFields.length) {
          record.reason = `${record.reason} Campo(s) não gravado(s): ${outcome.blockedFields.join(', ')}. ${outcome.reason || ''}`.trim();
          if (outcome.blockedFields.includes('GRDT')) record.grdtWillChange = false;
          if (outcome.blockedFields.includes('DATA')) record.dateWillChange = false;
          if (outcome.blockedFields.includes('REVISAO')) record.revisionWillChange = false;
        }
      }

      /* ---------------- Relatório ---------------- */
      progress('relatorio', 20, 'Montando auditoria');
      const finishedAt = new Date();
      const totalMs = (state.timings.leituraRelacao || 0) + (state.timings.leituraLds || 0) + (state.timings.indexacao || 0) + state.timings.atualizacao;

      const summary = {
        'Versão do Vincula': V.VERSION,
        'Modo de processamento': pool.mode === 'worker' ? `Web Workers (${pool.size} paralelos)` : 'Contingência na página',
        'Gerado em': finishedAt.toLocaleString('pt-BR'),
        'Tempo total de processamento': V.util.formatDuration(totalMs),
        'Tempo de leitura': V.util.formatDuration((state.timings.leituraRelacao || 0) + (state.timings.leituraLds || 0)),
        'Tempo de indexação': V.util.formatDuration(state.timings.indexacao || 0),
        'Tempo de atualização': V.util.formatDuration(state.timings.atualizacao || 0),
        'Relação GRCON': state.relation.name,
        'Quantidade de LD carregadas': state.lds.length,
        'Quantidade de LD atualizadas': outputs.length,
        'Quantidade de documentos (relação)': analysis.stats.relationDocuments,
        'Quantidade de correspondências analisadas': analysis.stats.records,
        'Documentos encontrados': analysis.stats.found,
        'Documentos não encontrados': analysis.stats.missing,
        'Documentos duplicados na relação': analysis.stats.relationDuplicates,
        'Documentos duplicados nas LDs': analysis.stats.ldDuplicates,
        'Documentos sem alteração (ignorados)': analysis.stats.unchanged,
        'Documentos alterados': analysis.records.filter((r) => r.grdtWillChange || r.dateWillChange || r.revisionWillChange).length,
        'Células GRDT gravadas': outputs.reduce((sum, o) => sum + o.grdtWrites, 0),
        'Células de data gravadas': outputs.reduce((sum, o) => sum + o.dateWrites, 0),
        'Células de revisão gravadas': outputs.reduce((sum, o) => sum + (o.revisionWrites || 0), 0),
        'Datas de postagem inválidas': analysis.stats.invalidDates,
        'Ocorrências registradas': occurrences.length,
        'Erros': failures.length,
        'Integridade': failures.length ? 'COM PENDÊNCIAS' : 'APROVADA',
      };

      const report = V.audit.buildReport({
        summary,
        records: analysis.records,
        relation: {
          arquivo: state.relation.name,
          hash: state.relation.hash,
          aba: state.relation.mapping.sheetName,
          linhaCabecalho: state.relation.mapping.headerRow,
        },
        duplicates: analysis.relationIndex.duplicates,
        missing: analysis.missing,
        invalidDates: analysis.invalidDates,
        outputs,
        occurrences,
        files: state.lds.map((ld) => ({
          arquivo: ld.name,
          hash: ld.hash,
          aba: ld.mapping ? ld.mapping.sheetName : '',
          erro: ld.error || null,
        })),
        timings: state.timings,
      });
      report.summary.finishedAt = finishedAt.toISOString();

      const auditBytes = await V.audit.buildAuditWorkbook(report);
      const jsonLog = V.audit.buildJsonLog(report);

      /* ---------------- Pacote ---------------- */
      progress('compactacao', 5, 'Compactando pacote final');
      const packageBlob = await V.packager.buildPackage(outputs, auditBytes, jsonLog, summary, (percent) =>
        progress('compactacao', Math.max(5, Math.round(percent)), 'Compactando pacote final')
      );

      const packageHash = await sha256Hex(packageBlob);
      summary['Hash SHA-256 do pacote'] = packageHash;

      state.outputs = outputs;
      state.report = report;
      state.auditBlob = new Blob([auditBytes], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      state.logBlob = new Blob([jsonLog], { type: 'application/json' });
      state.packageBlob = packageBlob;
      state.timings.total = totalMs;

      progress('compactacao', 100, 'Pacote pronto');
      log('info', 'Pacote gerado', { arquivos: outputs.length, hash: packageHash });
      publishMetrics();

      return {
        outputs,
        report,
        failures,
        occurrences,
        packageBlob,
        packageHash,
        auditBlob: state.auditBlob,
        logBlob: state.logBlob,
        summary,
      };
    }

    /* ---------------------------------------------------------------- *
     * Ciclo de vida
     * ---------------------------------------------------------------- */

    function cancel() {
      cancelled = true;
      pool.cancel();
      log('warn', 'Cancelamento solicitado. As tarefas em andamento são encerradas com segurança.');
    }

    async function releaseAll() {
      // Cada worker tem seu próprio registro: a liberação precisa alcançar todos.
      try {
        await pool.broadcast('releaseAll', {});
      } catch (_) {
        /* pool pode já estar encerrado */
      }
    }

    async function reset() {
      cancel();
      await releaseAll();
      pool.resume();
      cancelled = false;
      state.relation = null;
      state.lds = [];
      state.analysis = null;
      state.outputs = [];
      state.report = null;
      state.packageBlob = null;
      state.auditBlob = null;
      state.logBlob = null;
      state.timings = {};
      Object.assign(metrics, {
        ldsTotal: 0,
        ldsProcessed: 0,
        documentsIndexed: 0,
        documentsProcessed: 0,
        documentsFound: 0,
        documentsChanged: 0,
        cellsWritten: 0,
        startedAt: 0,
        rate: 0,
        eta: 0,
      });
      publishMetrics();
    }

    return {
      state,
      metrics,
      pool,
      on,
      off,
      loadRelation,
      loadLds,
      inspectSheet,
      columnOptions,
      analyze,
      generate,
      cancel,
      reset,
      releaseAll,
      get mode() {
        return pool.mode;
      },
      isCancelled: () => cancelled,
    };
  }

  V.createEngine = createEngine;
  V.STAGES = STAGES;
  V.CancelledError = CancelledError;
})(typeof self !== 'undefined' ? self : this);
