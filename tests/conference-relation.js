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

  console.log(`conference-relation: ${checks}/${checks} verificações aprovadas.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
