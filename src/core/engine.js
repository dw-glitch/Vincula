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
    const listeners = { progress: [], metrics: [], log: [], output: [] };

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

    function hydrateMappings(meta) {
      const source = meta.mappings && meta.mappings.length ? meta.mappings : [meta.mapping];
      return source.map((mapping, index) => ({ enabled: true, primary: index === 0, ...mapping }));
    }

    function enabledMappings(file) {
      const list = file.mappings && file.mappings.length ? file.mappings : file.mapping ? [file.mapping] : [];
      return list.filter((mapping) => mapping && mapping.enabled !== false);
    }

    function sheetLabel(file) {
      return enabledMappings(file)
        .map((mapping) => mapping.sheetName)
        .join(' + ');
    }

    async function readFile(file) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const hash = await sha256Hex(bytes);
      return { bytes, hash };
    }

    async function openInPool(file, profile, fileId, onProgress) {
      const { bytes, hash } = await readFile(file);
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
      const relationMappings = hydrateMappings(meta);
      const primary = relationMappings[0];
      const relationType = meta.relationType || primary.relationType || 'history';
      const sourceLabel = meta.sourceLabel || primary.sourceLabel || (relationType === 'conference' ? 'Conferência Histórico × Consulta Geral' : 'Histórico GRCON');
      state.relation = {
        fileId,
        name: file.name,
        size: file.size,
        hash: meta.hash,
        meta,
        relationType,
        sourceLabel,
        sourceShortLabel: meta.sourceShortLabel || primary.sourceShortLabel || (relationType === 'conference' ? 'Conferência' : 'Histórico'),
        mappings: relationMappings,
        mapping: primary,
      };
      state.analysis = null;
      state.timings.leituraRelacao = Date.now() - started;
      progress('leitura', 100, `${sourceLabel} identificado · ${meta.sheets.length} aba(s)`);
      log('info', `${sourceLabel} carregado: ${file.name}`, { tipo: relationType, abas: meta.sheets.length, cache: meta.fromCache });
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

      const loaded = [];
      let done = 0;
      await Promise.all(
        descriptors.map(async ({ file, fileId }) => {
          try {
            checkCancelled();
            const meta = await openInPool(file, 'ld', fileId);
            const mappings = hydrateMappings(meta);
            loaded.push({
              fileId,
              name: file.name,
              size: file.size,
              hash: meta.hash,
              meta,
              mappings,
              mapping: mappings[0],
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

      const extraSheets = loaded
        .filter((ld) => !ld.error && ld.mappings.length > 1)
        .map((ld) => `${ld.name}: ${ld.mappings.slice(1).map((m) => m.sheetName).join(', ')}`);
      if (extraSheets.length) log('info', `${extraSheets.length} LD(s) com mais de uma aba a atualizar`, extraSheets);

      log('info', `${loaded.filter((l) => !l.error).length} LD(s) carregada(s)`, { tempoMs: state.timings.leituraLds });
      return state.lds;
    }

    async function inspectSheet(fileId, sheetPath, profile) {
      return pool.run('scanSheet', { fileId, sheetPath, profile }, { fileId });
    }

    async function columnOptions(fileId, sheetPath, headerRow) {
      return pool.run('columnOptions', { fileId, sheetPath, headerRow }, { fileId });
    }

    function validateMappings() {
      const relationMapping = state.relation.mapping;
      if (relationMapping.relationType === 'conference') {
        if (!relationMapping.documentCol) {
          throw new Error('Não foi possível identificar a coluna “Código/Documento” na Conferência Histórico × Consulta Geral.');
        }
        if (!relationMapping.grdtCol) {
          throw new Error('Não foi possível identificar a coluna “Número da GRDT/eGRDT” na Conferência Histórico × Consulta Geral.');
        }
        if (!relationMapping.revisionCol) {
          throw new Error('Não foi possível identificar a coluna “Revisão enviada na GRDT” na Conferência Histórico × Consulta Geral.');
        }
        if (!relationMapping.dateCol || !relationMapping.dateGrdtCol) {
          throw new Error('Não foi possível identificar a data de envio da GRDT/eGRDT. A data de confirmação não é usada para preencher a LD.');
        }
        if (!relationMapping.conferenceCol) {
          throw new Error('Não foi possível identificar a coluna “Conferência”, necessária para confirmar a postagem no SIGEM.');
        }
      }

      const targets = [
        { label: `Relação ${state.relation.name}`, mapping: relationMapping, primary: true, relation: true },
        ...state.lds
          .filter((ld) => !ld.error)
          .flatMap((ld) =>
            enabledMappings(ld).map((mapping) => ({
              label: mapping.primary ? ld.name : `${ld.name} · aba ${mapping.sheetName}`,
              mapping,
              primary: !!mapping.primary,
              relation: false,
            }))
          ),
      ];

      const seen = new Set();
      for (const target of targets) {
        const { documentCol, grdtCol, dateCol, revisionCol, conferenceCol, sigemStatusCol } = target.mapping;
        if (!documentCol || (target.primary ? !grdtCol || !dateCol : !grdtCol && !dateCol)) {
          throw new Error(
            target.primary
              ? `Associe Documento, GRDT e Data em "${target.label}".`
              : `Associe Documento e ao menos GRDT ou Data em "${target.label}", ou desmarque a aba.`
          );
        }
        const cols = target.relation
          ? [documentCol, grdtCol, dateCol, revisionCol, conferenceCol, sigemStatusCol].filter(Boolean)
          : [documentCol, grdtCol, dateCol, revisionCol].filter(Boolean);
        if (new Set(cols).size < cols.length) {
          throw new Error(`Uma mesma coluna foi associada a dois campos em "${target.label}".`);
        }
        const key = `${target.label}|${target.mapping.sheetPath}`;
        if (seen.has(key)) throw new Error(`A aba "${target.mapping.sheetName}" foi mapeada duas vezes em "${target.label}".`);
        seen.add(key);
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

      progress('indexacao', 5, `Indexando ${state.relation.sourceLabel || 'Relação GRCON'}`);
      const relationIndex = await pool.run(
        'indexRelation',
        { fileId: state.relation.fileId, mapping: state.relation.mapping },
        { fileId: state.relation.fileId }
      );
      checkCancelled();
      if (relationIndex.headerWarning) log('warn', relationIndex.headerWarning);
      if (relationIndex.conferenceStats) {
        log('info', 'Conferência filtrada pela confirmação real no SIGEM', relationIndex.conferenceStats);
      }

      metrics.documentsIndexed = relationIndex.uniqueDocuments;
      publishMetrics();
      progress('indexacao', 25, `${relationIndex.uniqueDocuments} documento(s) confirmado(s)/único(s) na relação`);

      const sheetTargets = usable.flatMap((ld) => enabledMappings(ld).map((mapping) => ({ ld, mapping })));
      if (!sheetTargets.length) throw new Error('Nenhuma aba habilitada para atualização nas LDs carregadas.');

      let indexed = 0;
      const files = new Map();
      const ldIndexes = await pool.map(
        sheetTargets,
        ({ ld, mapping }) => ({ type: 'indexLd', payload: { fileId: ld.fileId, mapping }, fileId: ld.fileId }),
        (result) => {
          indexed++;
          progress(
            'indexacao',
            25 + Math.round((indexed / sheetTargets.length) * 65),
            `${indexed}/${sheetTargets.length} aba(s) de LD indexada(s)${result.value && result.value.fromCache ? ' (cache)' : ''}`
          );
          publishMetrics();
        }
      );
      checkCancelled();

      const indexedFiles = [];
      const indexedSheets = new Set();
      for (let i = 0; i < ldIndexes.length; i++) {
        const result = ldIndexes[i];
        const { ld, mapping } = sheetTargets[i];
        if (!result.ok) {
          log('error', `Falha ao indexar ${ld.name} · aba ${mapping.sheetName}`, result.error.message);
          continue;
        }
        if (!files.has(ld.fileId)) files.set(ld.fileId, { id: ld.fileId, name: result.value.name, sheetName: ld.mapping.sheetName });
        indexedSheets.add(`${ld.fileId}|${mapping.sheetPath}`);
        indexedFiles.push(result.value);
      }
      if (!indexedFiles.length) throw new Error('Nenhuma LD pôde ser indexada.');

      progress('analise', 92, 'Cruzando relação e LDs');
      const globalIndex = V.indexer.buildGlobalIndex(indexedFiles);
      const analysis = V.analyzer.analyze(relationIndex, globalIndex, files, analysisOptions);

      // O valor bruto precisa vir exatamente da ocorrência que venceu o índice.
      // Em uma Conferência, uma linha posterior não confirmada nunca pode
      // sobrescrever a evidência da linha confirmada escolhida.
      const rawByDocument = relationIndex.selected;
      for (const record of analysis.records) {
        const source = rawByDocument.get(record.document);
        record.sourceDateRaw = source ? source.sourceDateRaw : '';
        record.relationSource = relationIndex.sourceLabel || state.relation.sourceLabel || '';
        record.conferenceStatus = source ? source.conferenceStatus || '' : '';
        record.sigemStatus = source ? source.sigemStatus || '' : '';
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

      progress('analise', 100, `${analysis.stats.willChange} alteração(ões) prevista(s) em ${analysis.stats.sheetsWithChanges} aba(s)`);
      log('info', 'Análise concluída', { ...analysis.stats, abasIndexadas: indexedSheets.size });
      return analysis;
    }

    async function generate(generateOptions = {}) {
      checkCancelled();
      if (!state.analysis) throw new Error('Execute a análise antes de gerar.');

      // Nunca permita que botões/consumidores reutilizem artefatos de uma
      // geração anterior enquanto o novo lote está em andamento.
      state.outputs = [];
      state.report = null;
      state.packageBlob = null;
      state.auditBlob = null;
      state.logBlob = null;

      const started = Date.now();
      metrics.startedAt = started;
      metrics.documentsProcessed = 0;
      metrics.cellsWritten = 0;
      publishMetrics();

      const analysis = state.analysis;
      // A entrega cobre toda LD legível, inclusive quando ela já está correta
      // ou não recebeu nenhuma alteração da relação. Antes, somente arquivos
      // presentes em analysis.plans eram gerados e os demais desapareciam.
      const targets = state.lds
        .filter((ld) => !ld.error && enabledMappings(ld).length)
        .map((ld) => ({ ld, plan: analysis.plans.get(ld.fileId) || [] }));

      if (!analysis.plans.size) log('info', 'Nenhuma alteração necessária; as LDs originais serão devolvidas conferidas.');

      progress('atualizacao', 2, `Atualizando ${targets.length} LD(s)`);
      let finished = 0;
      const outputs = [];
      const occurrences = [];
      const failures = [];
      const outcomeByRecord = new Map();
      state.outputs = outputs;

      function outputFrom(value, target) {
        return {
          name: value.outputName,
          source: value.name,
          sourceFileId: target.ld.fileId,
          sheets: (value.sheetNames || [value.sheetName]).filter(Boolean).join(' + ') || sheetLabel(target.ld),
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
          unchanged: !!value.unchanged,
        };
      }

      await pool.map(
        targets,
        ({ ld, plan }) => ({
          type: 'apply',
          payload: {
            fileId: ld.fileId,
            mapping: ld.mapping,
            mappings: enabledMappings(ld),
            plan,
            options: { verify: generateOptions.verify !== false, level: generateOptions.compressionLevel ?? 1 },
          },
          fileId: ld.fileId,
        }),
        (result) => {
          finished++;
          if (result.ok && result.value.ok) {
            const value = result.value;
            const output = outputFrom(value, result.item);
            outputs.push(output);
            occurrences.push(...(value.occurrences || []));
            for (const item of value.results || []) outcomeByRecord.set(item.recordId, item);
            metrics.cellsWritten += value.counters.authorizedCells;
            metrics.documentsProcessed += value.results.filter((r) => r.outcome === 'APLICADO').length;
            // A interface pode liberar cada LD assim que ela fica pronta, sem
            // aguardar auditoria, log e ZIP do lote inteiro.
            emit('output', { output, finished, total: targets.length });
          } else {
            const error = result.ok ? result.value.error : result.error.message;
            failures.push({ file: result.item.ld.name, error });
            log('error', `Falha ao atualizar ${result.item.ld.name}`, error);
          }
          metrics.ldsProcessed = finished;
          progress('atualizacao', Math.round((finished / Math.max(1, targets.length)) * 100), `${finished}/${targets.length} LD(s) atualizada(s)`);
          publishMetrics();
        }
      );
      checkCancelled();
      // Mantém a ordem de carregamento no pacote e na lista final, ainda que
      // os workers terminem os arquivos em ordens diferentes.
      const order = new Map(state.lds.map((ld, index) => [ld.fileId, index]));
      outputs.sort((a, b) => (order.get(a.sourceFileId) ?? 0) - (order.get(b.sourceFileId) ?? 0));

      state.timings.atualizacao = Date.now() - started;

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

      progress('relatorio', 20, 'Montando auditoria');
      const finishedAt = new Date();
      const totalMs = (state.timings.leituraRelacao || 0) + (state.timings.leituraLds || 0) + (state.timings.indexacao || 0) + state.timings.atualizacao;
      const conferenceStats = analysis.relationIndex.conferenceStats;

      const summary = {
        'Versão do Vincula': V.VERSION,
        'Modo de processamento': pool.mode === 'worker' ? `Web Workers (${pool.size} paralelos)` : 'Contingência na página',
        'Gerado em': finishedAt.toLocaleString('pt-BR'),
        'Tempo total de processamento': V.util.formatDuration(totalMs),
        'Tempo de leitura': V.util.formatDuration((state.timings.leituraRelacao || 0) + (state.timings.leituraLds || 0)),
        'Tempo de indexação': V.util.formatDuration(state.timings.indexacao || 0),
        'Tempo de atualização': V.util.formatDuration(state.timings.atualizacao || 0),
        'Relação GRCON': state.relation.name,
        'Fonte identificada': state.relation.sourceLabel || 'Histórico GRCON',
        'Quantidade de LD carregadas': state.lds.length,
        'Quantidade de LD entregues': outputs.length,
        'Quantidade de LD atualizadas': outputs.filter((o) => !o.unchanged).length,
        'Quantidade de LD sem alteração devolvidas': outputs.filter((o) => o.unchanged).length,
        'Quantidade de abas atualizadas': analysis.stats.sheetsWithChanges,
        'Quantidade de documentos (relação)': analysis.stats.relationDocuments,
        ...(conferenceStats
          ? {
              'Linhas da Conferência': conferenceStats.total,
              'Postagens confirmadas pela Conferência': conferenceStats.confirmed,
              'Linhas não confirmadas ignoradas': conferenceStats.excluded,
            }
          : {}),
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
          fonte: state.relation.sourceLabel || 'Histórico GRCON',
          tipo: state.relation.relationType || 'history',
          hash: state.relation.hash,
          aba: state.relation.mapping.sheetName,
          linhaCabecalho: state.relation.mapping.headerRow,
          conferencia: conferenceStats || null,
        },
        duplicates: analysis.relationIndex.duplicates,
        missing: analysis.missing,
        invalidDates: analysis.invalidDates,
        outputs,
        occurrences,
        files: state.lds.map((ld) => ({
          arquivo: ld.name,
          hash: ld.hash,
          aba: sheetLabel(ld),
          abas: enabledMappings(ld).map((mapping) => ({
            aba: mapping.sheetName,
            papel: mapping.roleLabel || (mapping.primary ? 'Documentos' : ''),
            linhaCabecalho: mapping.headerRow,
          })),
          erro: ld.error || null,
        })),
        timings: state.timings,
      });
      report.summary.finishedAt = finishedAt.toISOString();

      const auditBytes = await V.audit.buildAuditWorkbook(report);
      const jsonLog = V.audit.buildJsonLog(report);

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

    function cancel() {
      cancelled = true;
      pool.cancel();
      log('warn', 'Cancelamento solicitado. As tarefas em andamento são encerradas com segurança.');
    }

    async function releaseAll() {
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
