'use strict';

const assert = require('assert');
const { loadVincula } = require('./harness');
const { buildWorkbook } = require('./fixtures');

async function openRelation(V, bytes, id, name) {
  return V.tasks.open({
    fileId: id,
    name,
    bytes,
    hash: `hash-${id}`,
    profile: 'relation',
  });
}

function cell(text) {
  return { text: String(text ?? '') };
}

async function main() {
  const { V, JSZip } = loadVincula();
  let checks = 0;
  const ok = (value, message) => {
    assert.ok(value, message);
    checks++;
  };
  const eq = (actual, expected, message) => {
    assert.strictEqual(actual, expected, message);
    checks++;
  };

  // ------------------------------------------------------------------
  // 1 + 3) `ultimo envio` é detectado automaticamente e vence confirmação.
  // ------------------------------------------------------------------
  const conferenceRows = [
    [cell('RELATÓRIO DE CONFERÊNCIA DE POSTAGEM')],
    [], [],
    [
      cell('Código'),
      cell('eGRDT'),
      cell('Revisão enviada'),
      cell('Conferência'),
      cell('Status SIGEM'),
      cell('ultimo envio'),
      cell('Data da confirmação'),
    ],
    [
      cell('DOC-001'),
      cell('GRDT-100'),
      cell('A'),
      cell('Postado'),
      cell('Em Análise'),
      cell('10/09/2026'),
      cell('11/09/2026'),
    ],
  ];

  const conferenceBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: conferenceRows, options: {} }]);
  const conferenceMeta = await openRelation(V, conferenceBytes, 'conf-ultimo-envio', 'Relatorio_Conferencia_Postagem.xlsx');

  eq(conferenceMeta.relationType, 'conference', 'deve identificar a origem como Conferência');
  eq(conferenceMeta.sourceLabel, 'Conferência SIGEM × Histórico', 'deve expor o rótulo correto da fonte');
  eq(conferenceMeta.mapping.documentCol, 1, 'Código deve ser Documento');
  eq(conferenceMeta.mapping.grdtCol, 2, 'eGRDT deve ser GRDT');
  eq(conferenceMeta.mapping.revisionCol, 3, 'Revisão enviada deve ser a revisão-fonte');
  eq(conferenceMeta.mapping.conferenceCol, 4, 'Conferência deve controlar a confirmação');
  eq(conferenceMeta.mapping.sigemStatusCol, 5, 'Status SIGEM deve ser reconhecido separadamente');
  eq(conferenceMeta.mapping.dateCol, 6, 'ultimo envio deve alimentar Data enviada na GRDT');
  eq(conferenceMeta.mapping.sourceDateLabel, 'ultimo envio', 'origem semântica deve registrar ultimo envio');
  eq(conferenceMeta.mapping.dateEffectiveCol, null, 'Data da confirmação não pode virar a data aplicada automaticamente');
  eq(conferenceMeta.mapping.dateFallback, false, 'ultimo envio não é fallback');

  const conferenceIndex = await V.tasks.indexRelation({ fileId: 'conf-ultimo-envio', mapping: conferenceMeta.mapping });
  eq(conferenceIndex.selected.size, 1, 'linha confirmada deve ser indexada');
  eq(conferenceIndex.selected.get('DOC-001').dateText, '10/09/2026', 'a data aplicada deve vir de ultimo envio');
  eq(conferenceIndex.selected.get('DOC-001').sourceDateRaw, '10/09/2026', 'valor bruto deve permanecer auditável');
  eq(conferenceIndex.selected.get('DOC-001').dateSource, 'ultimo-envio', 'origem técnica deve identificar ultimo envio');
  eq(conferenceIndex.selected.get('DOC-001').dateSourceLabel, 'ultimo envio', 'origem amigável deve identificar ultimo envio');

  // ------------------------------------------------------------------
  // 2) Normalização: acentos, caixa, espaços e underscore convergem.
  // ------------------------------------------------------------------
  for (const alias of [
    'ultimo envio',
    'Último Envio',
    'ÚLTIMO ENVIO',
    'último envio',
    'ultimo_envio',
    'ULTIMO_ENVIO',
    'Último envio',
    '  último   envio  ',
  ]) {
    ok(V.headers.isSentDateHeader(alias), `deve reconhecer alias de ultimo envio: ${alias}`);
  }
  ok(!V.headers.isSentDateHeader('Data da confirmação'), 'Data da confirmação não pode ser classificada como ultimo envio');

  // ------------------------------------------------------------------
  // 4) Seleção manual tem prioridade sobre autodetecção durante processamento.
  // ------------------------------------------------------------------
  const manualMapping = {
    ...conferenceMeta.mapping,
    dateCol: 7,
    manualDateSelection: true,
    dateFallback: false,
    sourceDateLabel: 'Seleção manual: Data da confirmação',
  };
  const manualIndex = await V.tasks.indexRelation({ fileId: 'conf-ultimo-envio', mapping: manualMapping });
  eq(manualIndex.selected.get('DOC-001').dateText, '11/09/2026', 'escolha manual deve ser respeitada');
  eq(manualIndex.selected.get('DOC-001').dateSource, 'manual', 'índice deve registrar que a origem foi manual');
  eq(
    manualIndex.selected.get('DOC-001').dateSourceLabel,
    'Seleção manual: Data da confirmação',
    'auditoria deve preservar o nome da coluna escolhida manualmente'
  );

  // ------------------------------------------------------------------
  // 5) Data brasileira não pode ser invertida para padrão americano.
  // ------------------------------------------------------------------
  eq(V.dates.formatIsoDate(V.dates.parseDate('10/09/2026')), '2026-09-10', '10/09/2026 deve ser 10 de setembro');
  eq(V.dates.formatDate(V.dates.parseDate('10/09/26')), '10/09/2026', 'ano com dois dígitos deve ser aceito');
  eq(V.dates.formatDate(V.dates.parseDate('2026-09-10')), '10/09/2026', 'ISO deve ser aceito sem inverter dia/mês');
  eq(V.dates.formatDate(V.dates.parseDate('10/09/2026 16:58')), '10/09/2026', 'data + hora deve descartar a hora');

  // ------------------------------------------------------------------
  // 6) Mesmo documento/revisão em duas GRDTs: data mais recente vence,
  // mesmo quando a linha mais recente fisicamente contém a tentativa antiga.
  // ------------------------------------------------------------------
  const repeatedRows = [
    [cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência'), cell('ultimo envio')],
    [cell('DOC-R'), cell('GRDT-115'), cell('A'), cell('Postado'), cell('10/09/2026')],
    [cell('DOC-R'), cell('GRDT-100'), cell('A'), cell('Postado'), cell('01/09/2026')],
  ];
  const repeatedBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: repeatedRows, options: {} }]);
  const repeatedMeta = await openRelation(V, repeatedBytes, 'conf-repeated', 'Conferencia_duas_GRDTs.xlsx');
  const repeatedIndex = await V.tasks.indexRelation({ fileId: 'conf-repeated', mapping: repeatedMeta.mapping });
  const repeatedWinner = repeatedIndex.selected.get('DOC-R');
  eq(repeatedWinner.grdt, 'GRDT-115', 'GRDT com envio mais recente deve vencer');
  eq(repeatedWinner.revision, 'A', 'revisão deve vir da mesma linha da GRDT vencedora');
  eq(repeatedWinner.dateText, '10/09/2026', 'ultimo envio mais recente deve vencer');
  eq(repeatedIndex.duplicates[0].selectedRow, 2, 'não deve simplesmente escolher a última linha física');

  // Tentativa mais nova sem confirmação não pode sobrescrever a confirmada.
  const unconfirmedRows = [
    [cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência'), cell('ultimo envio')],
    [cell('DOC-U'), cell('GRDT-200'), cell('A'), cell('Postado'), cell('10/09/2026')],
    [cell('DOC-U'), cell('GRDT-999'), cell('A'), cell('Não postado ainda'), cell('12/09/2026')],
  ];
  const unconfirmedBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: unconfirmedRows, options: {} }]);
  const unconfirmedMeta = await openRelation(V, unconfirmedBytes, 'conf-unconfirmed', 'Conferencia_tentativa_nao_confirmada.xlsx');
  const unconfirmedIndex = await V.tasks.indexRelation({ fileId: 'conf-unconfirmed', mapping: unconfirmedMeta.mapping });
  eq(unconfirmedIndex.selected.get('DOC-U').grdt, 'GRDT-200', 'tentativa não confirmada não pode vencer');
  eq(unconfirmedIndex.conferenceStats.excluded, 1, 'tentativa não confirmada deve permanecer auditável como excluída');

  // ------------------------------------------------------------------
  // 7) Revisão e data permanecem ligadas à mesma ocorrência/GRDT.
  // ------------------------------------------------------------------
  const revisionsRows = [
    [cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência'), cell('ultimo envio')],
    [cell('DOC-REV'), cell('GRDT-A'), cell('A'), cell('Postado'), cell('01/09/2026')],
    [cell('DOC-REV'), cell('GRDT-B'), cell('B'), cell('Postado'), cell('10/09/2026')],
  ];
  const revisionsBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: revisionsRows, options: {} }]);
  const revisionsMeta = await openRelation(V, revisionsBytes, 'conf-revisions', 'Conferencia_revisoes.xlsx');
  const revisionsIndex = await V.tasks.indexRelation({ fileId: 'conf-revisions', mapping: revisionsMeta.mapping });
  const revisionsWinner = revisionsIndex.selected.get('DOC-REV');
  eq(revisionsWinner.revision, 'B', 'revisão B deve vencer junto da data mais recente');
  eq(revisionsWinner.grdt, 'GRDT-B', 'GRDT deve ser da mesma linha da revisão B');
  eq(revisionsWinner.dateText, '10/09/2026', 'data deve ser da mesma linha da revisão B');

  // ------------------------------------------------------------------
  // Compatibilidade: Histórico GRCON tradicional continua intacto.
  // ------------------------------------------------------------------
  const historyRows = [
    [cell('Documento'), cell('GRDT'), cell('Data da geração / postagem'), cell('Revisão')],
    [cell('DOC-H1'), cell('GRDT-H1'), cell('01/09/2026'), cell('A')],
    [cell('DOC-H2'), cell('GRDT-H2'), cell('02/09/2026'), cell('B')],
  ];
  const historyBytes = await buildWorkbook(JSZip, [{ name: 'Histórico', rows: historyRows, options: {} }]);
  const historyMeta = await openRelation(V, historyBytes, 'history', 'Historico_GRCON.xlsx');
  eq(historyMeta.relationType, 'history', 'Histórico normal deve continuar sendo reconhecido');
  const historyIndex = await V.tasks.indexRelation({ fileId: 'history', mapping: historyMeta.mapping });
  eq(historyIndex.selected.size, 2, 'Histórico deve manter o comportamento legado');
  eq(historyIndex.conferenceStats, null, 'Histórico não deve receber filtro de confirmação');

  // Compatibilidade: DATA EGRDT continua como fallback quando ultimo envio não existe.
  const fallbackRows = [
    [cell('Código'), cell('eGRDT'), cell('DATA EGRDT'), cell('Revisão enviada'), cell('Conferência')],
    [cell('DOC-F'), cell('GRDT-F'), cell('04/09/2026'), cell('A'), cell('Postado')],
  ];
  const fallbackBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: fallbackRows, options: {} }]);
  const fallbackMeta = await openRelation(V, fallbackBytes, 'conf-fallback', 'Conferencia_DATA_EGRDT.xlsx');
  eq(fallbackMeta.relationType, 'conference', 'campos exclusivos devem manter origem Conferência');
  eq(fallbackMeta.mapping.dateCol, 3, 'DATA EGRDT deve ser fallback quando ultimo envio não existir');
  eq(fallbackMeta.mapping.dateFallback, true, 'fallback deve ficar explícito');
  const fallbackIndex = await V.tasks.indexRelation({ fileId: 'conf-fallback', mapping: fallbackMeta.mapping });
  eq(fallbackIndex.selected.get('DOC-F').dateText, '04/09/2026', 'fallback legado deve continuar funcional');

  // Conferência com somente Data da confirmação não pode promovê-la automaticamente.
  const confirmationOnlyRows = [
    [cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência'), cell('Data da confirmação')],
    [cell('DOC-C'), cell('GRDT-C'), cell('A'), cell('Postado'), cell('10/09/2026')],
  ];
  const confirmationOnlyBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: confirmationOnlyRows, options: {} }]);
  const confirmationOnlyMeta = await openRelation(V, confirmationOnlyBytes, 'conf-confirmation-only', 'Conferencia_so_confirmacao.xlsx');
  eq(confirmationOnlyMeta.relationType, 'conference', 'assinatura exclusiva deve identificar a Conferência');
  eq(confirmationOnlyMeta.mapping.dateCol, null, 'Data da confirmação não deve ser escolhida automaticamente');


  // ------------------------------------------------------------------
  // Relatório detalhado REAL do GRCON: cabeçalho linha 10, propósito por
  // guia/revisão, linhas pendentes e destino STATUS SIGEM da LD.
  // ------------------------------------------------------------------
  const detailedHeader = Array(17).fill(null);
  for (const [col, name] of [
    [1, 'Código'], [4, 'eGRDTs emitidas / histórico de envios'],
    [7, 'Último envio'], [8, 'eGRDT mais recente'],
    [9, 'PROPÓSITO DE EMISSÃO'], [10, 'Revisão atual'],
    [13, 'Conferência'], [14, 'Status SIGEM'],
  ]) detailedHeader[col - 1] = cell(name);
  const detail = (doc, grdt, revision, purpose, conference = 'Aguardando retorno do SIGEM') => {
    const row = Array(17).fill(null);
    for (const [col, value] of [
      [1, doc], [4, 'Outras guias anteriores'], [7, '07/10/2026'],
      [8, grdt], [9, purpose], [10, revision],
      [13, conference], [14, 'Recusado'],
    ]) row[col - 1] = cell(value);
    return row;
  };
  const detailedRows = [
    ...Array.from({ length: 9 }, () => []),
    detailedHeader,
    detail('DOC-P', 'GRDT-300', 'C',
      'GRDT-300 — Rev. C — Para Construção\\nGRDT-200 — Rev. B — Cancelado'),
    detail('DOC-C', 'GRDT-400', 'A',
      'GRDT-400 — Rev. A — Cancelado'),
    detail('DOC-N', 'GRDT-500', '0',
      'GRDT-500 — Rev. 0 — Não identificado'),
    detail('DOC-X', 'GRDT-600', 'D',
      'GRDT-600 — Rev. D — Para Construção'),
    detail('DOC-OLD', 'GRDT-800', 'D',
      'GRDT-800 — Rev. D — Para Construção\\nGRDT-700 — Rev. C — Cancelado'),
    detail('DOC-OLD', 'GRDT-700', 'C',
      'GRDT-700 — Rev. C — Cancelado', 'Postado'),
  ];
  const detailedBytes = await buildWorkbook(JSZip, [
    { name: 'Detalhamento', rows: detailedRows, options: {} },
    { name: 'GRDTs Pendentes', rows: [[cell('GRDT'), cell('Quantidade de documentos')]], options: {} },
  ]);
  const detailedMeta = await openRelation(V, detailedBytes, 'detail-20261008', 'Relatorio_Conferencia_Postagem_Pendencias_20261008.xlsx');
  eq(detailedMeta.mapping.headerRow, 10, 'cabeçalho real do relatório é a linha 10');
  eq(detailedMeta.mapping.grdtCol, 8, 'última eGRDT é a coluna H, nunca o histórico D');
  eq(detailedMeta.mapping.purposeCol, 9, 'propósito de emissão é a coluna I');
  eq(detailedMeta.mapping.revisionCol, 10, 'revisão atual é a coluna J');
  eq(detailedMeta.mapping.conferenceCol, 13, 'conferência é a coluna M');
  const detailedIndex = await V.tasks.indexRelation({ fileId: 'detail-20261008', mapping: detailedMeta.mapping });
  eq(detailedIndex.selected.size, 1, 'somente ocorrência postada é confirmada');
  eq(detailedIndex.statusSelected.size, 5, 'todas as emissões recentes são consideradas apenas para STATUS SIGEM');
  eq(detailedIndex.statusSelected.get('DOC-P').purpose, 'Para Construção', 'última revisão prevalece sobre cancelamento histórico');
  eq(detailedIndex.statusSelected.get('DOC-C').purpose, 'Cancelado', 'cancelamento vigente é reconhecido');
  eq(detailedIndex.statusSelected.get('DOC-N').purpose, 'Não identificado', 'propósito desconhecido não é inferido');
  eq(V.analyzer.statusFromPurpose('Não identificado'), '', 'propósito não identificado não deve virar EMITIDO');

  const ldHeader = ['Documento', 'eGRDT', 'Data Efetiva de Emissão', 'Revisão', 'PROPÓSITO DE EMISSÃO', 'STATUS SIGEM', 'Status da LD'].map(cell);
  const ldLine = (doc, rev, purpose, sigem) => [
    cell(doc), cell('GRDT-ANTIGA'), cell('01/08/2026'), cell(rev),
    cell(purpose), cell(sigem), cell('PENDENTE'),
  ];
  const ldRows = [
    ldHeader,
    ldLine('DOC-P', 'C', 'Para Construção', 'PENDENTE'),
    ldLine('DOC-C', 'A', 'Cancelado', 'EMITIDO'),
    ldLine('DOC-N', '0', 'Não identificado', 'PENDENTE'),
    ldLine('DOC-X', 'B', 'Para Construção', 'PENDENTE'),
    ldLine('DOC-OLD', 'D', 'Para Construção', 'PENDENTE'),
  ];
  const ldBytes = await buildWorkbook(JSZip, [{ name: 'LD_001', rows: ldRows, options: {} }]);
  const ldMeta = await V.tasks.open({
    fileId: 'ld-detail', name: 'LD_001.xlsx', bytes: ldBytes, hash: 'ld-detail', profile: 'ld',
  });
  eq(ldMeta.mapping.sigemStatusCol, 6, 'STATUS SIGEM da LD detectado na coluna F');
  eq(ldMeta.mapping.statusCol, 7, 'status genérico da LD continua identificado separadamente');
  const ldMapping = { ...ldMeta.mapping, statusCol: ldMeta.mapping.sigemStatusCol };
  const ldIndex = await V.tasks.indexLd({ fileId: 'ld-detail', mapping: ldMapping });
  const global = V.indexer.buildGlobalIndex([ldIndex]);
  const files = new Map([['ld-detail', { id: 'ld-detail', name: 'LD_001.xlsx', sheetName: 'LD_001' }]]);
  const analysis = V.analyzer.analyze(detailedIndex, global, files);
  const byDoc = (doc) => analysis.records.find((item) => item.document === doc);
  eq(byDoc('DOC-P').afterStatus, 'EMITIDO', 'construção pendente atualiza apenas STATUS SIGEM');
  eq(byDoc('DOC-C').afterStatus, 'CANCELADO', 'cancelamento pendente atualiza apenas STATUS SIGEM');
  eq(byDoc('DOC-N').afterStatus, 'PENDENTE', 'não identificado preserva status');
  eq(byDoc('DOC-X').afterStatus, 'PENDENTE', 'revisão divergente preserva status');
  eq(byDoc('DOC-OLD').afterStatus, 'EMITIDO', 'guia mais nova pendente vence propósito de guia antiga postada');
  eq(analysis.stats.grdtWrites, 0, 'pendência não altera GRDT');
  eq(analysis.stats.dateWrites, 0, 'pendência não altera data');
  eq(analysis.stats.revisionWrites, 0, 'pendência não altera revisão');
  eq(analysis.stats.statusWrites, 3, 'somente os três propósitos válidos/revisões equivalentes alteram status');

  const applied = await V.tasks.apply({
    fileId: 'ld-detail', mapping: ldMapping,
    plan: analysis.plans.get('ld-detail'), options: { verify: true },
  });
  ok(applied.ok && applied.integrity.ok, 'Excel gerado com verificação de integridade');
  eq(applied.counters.statusWrites, 3, 'somente STATUS SIGEM recebeu gravações');
  const outputMeta = await V.tasks.open({
    fileId: 'ld-detail-output', name: 'LD_001_ATUALIZADA.xlsx',
    bytes: applied.bytes, hash: 'ld-detail-output', profile: 'ld',
  });
  const resultIndex = await V.tasks.indexLd({
    fileId: 'ld-detail-output',
    mapping: { ...outputMeta.mapping, statusCol: outputMeta.mapping.sigemStatusCol },
  });
  const outputStatuses = new Map(resultIndex.entries.map((e) => [e.document, e.beforeStatus]));
  eq(outputStatuses.get('DOC-P'), 'EMITIDO', 'STATUS SIGEM construction gravado na LD');
  eq(outputStatuses.get('DOC-C'), 'CANCELADO', 'STATUS SIGEM cancelamento gravado na LD');
  eq(outputStatuses.get('DOC-N'), 'PENDENTE', 'STATUS SIGEM desconhecido permanece');
  eq(outputStatuses.get('DOC-X'), 'PENDENTE', 'STATUS SIGEM revisão divergente permanece');
  eq(outputStatuses.get('DOC-OLD'), 'EMITIDO', 'STATUS SIGEM última emissão gravado');

  const beforeZip = await JSZip.loadAsync(ldBytes);
  const afterZip = await JSZip.loadAsync(applied.bytes);
  const beforeXml = await beforeZip.file('xl/worksheets/sheet1.xml').async('string');
  const afterXml = await afterZip.file('xl/worksheets/sheet1.xml').async('string');
  for (const col of ['B', 'C', 'D', 'E', 'G']) {
    const cells = (xml) => [...xml.matchAll(new RegExp('<c r="' + col + '[0-9]+"[^>]*>.*?<\\/c>', 'g'))].map((match) => match[0]);
    eq(JSON.stringify(cells(afterXml)), JSON.stringify(cells(beforeXml)),
      'coluna ' + col + ' totalmente preservada (inclui PROPÓSITO DE EMISSÃO)');
  }

  console.log(`conference-relation: ${checks}/${checks} verificações aprovadas.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
