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

  // 1) Relatório realista do GRCON: DATA eGRDT e Data da confirmação coexistem.
  // A confirmação deve ser a data aplicada; DATA eGRDT deve ser preservada separada.
  const conferenceRows = [
    [cell('RELATÓRIO DE CONFERÊNCIA DE POSTAGEM')],
    [], [], [], [], [], [], [], [],
    [
      cell('Código'), cell('Tipo'), cell('Disciplina'), cell('eGRDT'), cell('Data eGRDT'),
      cell('Revisão enviada'), cell('Revisão encontrada'), cell('Conferência'), cell('Status SIGEM'),
      cell('Data da confirmação'), cell('Última conferência'), cell('Observação'),
    ],
    [cell('DOC-001'), cell('ET'), cell('TUB'), cell('GRDT-0001 - eGRDT'), cell('01/09/2026'), cell('A'), cell('A'), cell('Postado'), cell('Em Análise'), cell('02/09/2026, 16:55'), cell('03/09/2026, 08:00'), cell('')],
    [cell('DOC-002'), cell('ET'), cell('TUB'), cell('GRDT-0002 - eGRDT'), cell('01/09/2026'), cell('B'), cell(''), cell('Não postado ainda'), cell('Em Análise'), cell('32'), cell('03/09/2026, 08:00'), cell('')],
    [cell('DOC-003'), cell('ET'), cell('TUB'), cell('GRDT-0003 - eGRDT'), cell('01/09/2026'), cell('C'), cell('B'), cell('Revisão divergente'), cell('Sem Comentários'), cell('32'), cell('03/09/2026, 08:00'), cell('')],
    [cell('DOC-004'), cell('CV'), cell('ADM'), cell('GRDT-0004/COMPLETA - eGRDT'), cell('01/09/2026'), cell('0'), cell('0'), cell('Confirmado'), cell('Sem Comentários'), cell('03/09/2026, 08:31'), cell('03/09/2026, 08:31'), cell('')],
  ];

  const conferenceBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: conferenceRows, options: {} }]);
  const conferenceMeta = await openRelation(V, conferenceBytes, 'conf-real', 'Relatorio_Conferencia_Postagem_20260903.xlsx');

  eq(conferenceMeta.relationType, 'conference', 'deve identificar a origem como Conferência');
  eq(conferenceMeta.sourceLabel, 'Conferência Histórico × Consulta Geral', 'deve expor o rótulo da fonte');
  eq(conferenceMeta.mapping.documentCol, 1, 'Código deve ser Documento');
  eq(conferenceMeta.mapping.grdtCol, 4, 'eGRDT deve ser GRDT');
  eq(conferenceMeta.mapping.dateGrdtCol, 5, 'Data eGRDT deve ser preservada como data da GRDT');
  eq(conferenceMeta.mapping.revisionCol, 6, 'Revisão enviada deve ser a revisão-fonte');
  eq(conferenceMeta.mapping.conferenceCol, 8, 'Conferência deve controlar a confirmação');
  eq(conferenceMeta.mapping.sigemStatusCol, 9, 'Status SIGEM deve ser reconhecido separadamente');
  eq(conferenceMeta.mapping.dateCol, 10, 'Data da confirmação deve alimentar a data aplicada');
  eq(conferenceMeta.mapping.dateEffectiveCol, 10, 'Data da confirmação deve ser registrada como data efetiva');
  eq(conferenceMeta.mapping.dateFallback, false, 'com data efetiva não deve ativar fallback para DATA eGRDT');
  eq(conferenceMeta.mapping.headerRow, 10, 'deve localizar cabeçalho após título e linhas vazias');

  const conferenceIndex = await V.tasks.indexRelation({ fileId: 'conf-real', mapping: conferenceMeta.mapping });
  eq(conferenceIndex.headerWarning, null, 'conferência válida não deve gerar aviso de cabeçalho de data');
  eq(conferenceIndex.dateMode, 'effective', 'a conferência deve operar no modo de data efetiva');
  eq(conferenceIndex.totalRows, 4, 'todas as linhas devem permanecer auditáveis');
  eq(conferenceIndex.conferenceStats.confirmed, 2, 'só Postado/Confirmado deve ser elegível');
  eq(conferenceIndex.conferenceStats.excluded, 2, 'não postado e divergente devem ser excluídos da atualização');
  eq(conferenceIndex.selected.size, 2, 'somente confirmados devem chegar ao índice selecionado');
  ok(conferenceIndex.selected.has('DOC-001'), 'DOC-001 deve ser selecionado');
  ok(conferenceIndex.selected.has('DOC-004'), 'DOC-004 deve ser selecionado');
  ok(!conferenceIndex.selected.has('DOC-002'), 'Status SIGEM Em Análise não pode transformar Não postado ainda em postado');
  ok(!conferenceIndex.selected.has('DOC-003'), 'Revisão divergente não pode atualizar a LD');
  eq(conferenceIndex.selected.get('DOC-001').revision, 'A', 'deve preservar a revisão enviada');
  eq(conferenceIndex.selected.get('DOC-001').grdt, 'GRDT-0001 - eGRDT', 'deve preservar a eGRDT completa');
  eq(conferenceIndex.selected.get('DOC-004').grdt, 'GRDT-0004/COMPLETA - eGRDT', 'deve preservar caracteres do número da eGRDT');
  eq(conferenceIndex.selected.get('DOC-001').dateText, '02/09/2026', 'a data aplicada deve vir da confirmação');
  eq(conferenceIndex.selected.get('DOC-001').dateEffectiveText, '02/09/2026', 'deve preservar a data efetiva separadamente');
  eq(conferenceIndex.selected.get('DOC-001').dateGrdtText, '01/09/2026', 'deve preservar DATA eGRDT separadamente');
  eq(conferenceIndex.selected.get('DOC-001').dateSource, 'effective', 'deve registrar a origem semântica da data aplicada');
  eq(conferenceIndex.invalidDates.length, 0, 'datas inválidas de linhas não confirmadas não devem contaminar pendências de atualização');

  // 2) Cabeçalhos reordenados e com pequenas variações: não depende de posição.
  const shuffledRows = [
    [cell('observação'), cell('  revisao enviada na grdt  '), cell('STATUS da conferência'), cell('Data Efetiva de Emissão'), cell('CÓDIGO DO DOCUMENTO'), cell('número da eGRDT'), cell('situação SIGEM')],
    [cell('x'), cell('R2'), cell('POSTADO'), cell('03/09/2026'), cell('DOC-X'), cell('GRDT-X'), cell('Sem Comentários')],
  ];
  const shuffledBytes = await buildWorkbook(JSZip, [{ name: 'Dados', rows: shuffledRows, options: {} }]);
  const shuffledMeta = await openRelation(V, shuffledBytes, 'conf-shuffled', 'Conferencia_colunas_reordenadas.xlsx');
  eq(shuffledMeta.relationType, 'conference', 'deve tolerar caixa, acento, espaços e ordem diferente');
  eq(shuffledMeta.mapping.revisionCol, 2, 'deve localizar Revisão enviada na GRDT');
  eq(shuffledMeta.mapping.conferenceCol, 3, 'deve localizar Status da conferência sem confundir com SIGEM');
  eq(shuffledMeta.mapping.dateCol, 4, 'deve preferir Data Efetiva de Emissão quando disponível');
  eq(shuffledMeta.mapping.dateEffectiveCol, 4, 'deve manter coluna efetiva explícita');
  eq(shuffledMeta.mapping.dateGrdtCol, null, 'não deve inventar DATA GRDT quando não existe');
  eq(shuffledMeta.mapping.documentCol, 5, 'deve localizar documento fora da primeira coluna');
  eq(shuffledMeta.mapping.grdtCol, 6, 'deve localizar eGRDT fora da posição padrão');
  eq(shuffledMeta.mapping.sigemStatusCol, 7, 'deve localizar Status SIGEM separadamente');
  const shuffledIndex = await V.tasks.indexRelation({ fileId: 'conf-shuffled', mapping: shuffledMeta.mapping });
  eq(shuffledIndex.selected.get('DOC-X').revision, 'R2', 'revisão enviada deve sobreviver à normalização do cabeçalho');

  // 3) Formato legado original: comportamento anterior intacto.
  const historyRows = [
    [cell('Documento'), cell('GRDT'), cell('Data da geração / postagem'), cell('Revisão')],
    [cell('DOC-H1'), cell('GRDT-H1'), cell('01/09/2026'), cell('A')],
    [cell('DOC-H2'), cell('GRDT-H2'), cell('02/09/2026'), cell('B')],
  ];
  const historyBytes = await buildWorkbook(JSZip, [{ name: 'Histórico', rows: historyRows, options: {} }]);
  const historyMeta = await openRelation(V, historyBytes, 'history', 'Historico_GRCON.xlsx');
  eq(historyMeta.relationType, 'history', 'Histórico normal deve continuar sendo reconhecido');
  eq(historyMeta.mapping.conferenceCol, null, 'Histórico não deve inventar coluna de conferência');
  const historyIndex = await V.tasks.indexRelation({ fileId: 'history', mapping: historyMeta.mapping });
  eq(historyIndex.selected.size, 2, 'Histórico deve manter o comportamento legado e usar as duas linhas');
  eq(historyIndex.conferenceStats, null, 'Histórico não deve receber filtro de confirmação');
  eq(historyIndex.headerWarning, null, 'formato histórico já aceito deve continuar sem aviso');

  // 4) Histórico antigo cuja única data é DATA EGRDT deve ser aceito sem alerta.
  const historyGrdtRows = [
    [cell('Documento'), cell('GRDT'), cell('DATA EGRDT'), cell('Revisão')],
    [cell('DOC-HG1'), cell('GRDT-HG1'), cell('01/09/2026'), cell('A')],
  ];
  const historyGrdtBytes = await buildWorkbook(JSZip, [{ name: 'Histórico', rows: historyGrdtRows, options: {} }]);
  const historyGrdtMeta = await openRelation(V, historyGrdtBytes, 'history-grdt-date', 'Historico_DATA_EGRDT.xlsx');
  eq(historyGrdtMeta.relationType, 'history', 'DATA EGRDT sozinha não deve converter histórico em Conferência');
  eq(historyGrdtMeta.mapping.dateCol, 3, 'DATA EGRDT deve ser a data legada do Histórico');
  eq(historyGrdtMeta.mapping.dateGrdtCol, 3, 'DATA EGRDT deve ser identificada semanticamente');
  const historyGrdtIndex = await V.tasks.indexRelation({ fileId: 'history-grdt-date', mapping: historyGrdtMeta.mapping });
  eq(historyGrdtIndex.headerWarning, null, 'DATA EGRDT válida não deve gerar o aviso antigo');
  eq(historyGrdtIndex.selected.get('DOC-HG1').dateText, '01/09/2026', 'Histórico deve continuar usando DATA EGRDT');
  eq(historyGrdtIndex.selected.get('DOC-HG1').dateGrdtText, '01/09/2026', 'valor DATA EGRDT deve permanecer disponível separadamente');

  // 5) Conferência legada com DATA EGRDT, mas sem data efetiva: aceita por fallback,
  // sem fingir que DATA EGRDT é semanticamente uma data efetiva.
  const conferenceFallbackRows = [
    [cell('Código'), cell('eGRDT'), cell('DATA E-GRDT'), cell('Revisão enviada'), cell('Conferência'), cell('Status SIGEM')],
    [cell('DOC-F1'), cell('GRDT-F1'), cell('04/09/2026'), cell('A'), cell('Postado'), cell('Em Workflow')],
  ];
  const conferenceFallbackBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: conferenceFallbackRows, options: {} }]);
  const conferenceFallbackMeta = await openRelation(V, conferenceFallbackBytes, 'conf-fallback', 'Conferencia_DATA_EGRDT.xlsx');
  eq(conferenceFallbackMeta.relationType, 'conference', 'campos exclusivos devem manter a origem como Conferência');
  eq(conferenceFallbackMeta.mapping.dateEffectiveCol, null, 'fallback não pode marcar DATA EGRDT como efetiva');
  eq(conferenceFallbackMeta.mapping.dateGrdtCol, 3, 'DATA E-GRDT deve ser reconhecida como data da GRDT');
  eq(conferenceFallbackMeta.mapping.dateCol, 3, 'dateCol legado deve apontar para o fallback apenas por compatibilidade');
  eq(conferenceFallbackMeta.mapping.dateFallback, true, 'deve registrar explicitamente o modo fallback');
  const conferenceFallbackIndex = await V.tasks.indexRelation({ fileId: 'conf-fallback', mapping: conferenceFallbackMeta.mapping });
  eq(conferenceFallbackIndex.headerWarning, null, 'fallback conhecido não deve gerar a mensagem de erro antiga');
  eq(conferenceFallbackIndex.dateMode, 'grdt-fallback', 'deve informar que a data veio do fallback GRDT');
  eq(conferenceFallbackIndex.selected.get('DOC-F1').dateText, '04/09/2026', 'fallback deve continuar funcional');
  eq(conferenceFallbackIndex.selected.get('DOC-F1').dateEffectiveText, '', 'fallback não pode fabricar data efetiva');
  eq(conferenceFallbackIndex.selected.get('DOC-F1').dateGrdtText, '04/09/2026', 'DATA EGRDT deve permanecer preservada');

  // 6) Catálogo central de aliases e normalização de pontuação/acentuação.
  for (const alias of [
    'DATA EGRDT',
    'DATA E-GRDT',
    'DATA E GRDT',
    'DATA DA EGRDT',
    'DATA DA GRDT',
    'DATA GRDT',
    'DATA DE GRDT',
    'DATA DE EMISSÃO GRDT',
    'DATA EMISSÃO GRDT',
    '  data_e-grdt  ',
  ]) {
    ok(V.headers.isGrdtDateHeader(alias), `deve reconhecer alias de data GRDT: ${alias}`);
  }
  for (const alias of [
    'DATA EFETIVA DE EMISSÃO',
    'DATA EFETIVA EMISSÃO',
    'DATA DE EMISSÃO',
    'DATA DA EMISSÃO',
    'DATA DA CONFIRMAÇÃO',
    'DATA CONFIRMAÇÃO',
    'DATA DE CONFIRMAÇÃO',
    'Data_Efetiva_de_Emissão',
    '  data efetiva   de emissão  ',
  ]) {
    ok(V.headers.isConferenceDateHeader(alias), `deve reconhecer alias de data efetiva/confirmação: ${alias}`);
  }
  ok(!V.headers.isConferenceDateHeader('DATA EGRDT'), 'DATA EGRDT não pode ser classificada como data efetiva');
  ok(!V.headers.isGrdtDateHeader('Data Efetiva de Emissão'), 'data efetiva não pode ser classificada como DATA GRDT');

  // 7) Falta total de coluna de data: mensagem específica e bloqueio real.
  const missingDateRows = [
    [cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência')],
    [cell('DOC-M'), cell('GRDT-M'), cell('A'), cell('Postado')],
  ];
  const missingDateBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: missingDateRows, options: {} }]);
  const missingDateMeta = await openRelation(V, missingDateBytes, 'conf-missing-date', 'Conferencia_sem_data.xlsx');
  eq(missingDateMeta.relationType, 'conference', 'assinatura exclusiva deve reconhecer Conferência mesmo com uma coluna essencial ausente');
  eq(missingDateMeta.mapping.dateCol, null, 'data ausente deve permanecer ausente');
  await assert.rejects(
    () => V.tasks.indexRelation({ fileId: 'conf-missing-date', mapping: missingDateMeta.mapping }),
    /Data Efetiva de Emissão.*Data da confirmação.*DATA EGRDT/,
    'erro deve explicar todas as opções de data aceitas'
  );
  checks++;

  // 8) Volume: milhares de linhas, com somente metade confirmada.
  const volume = [[cell('Código'), cell('eGRDT'), cell('Revisão enviada'), cell('Conferência'), cell('Data da confirmação')]];
  const volumeCount = 6000;
  for (let i = 1; i <= volumeCount; i++) {
    volume.push([
      cell(`DOC-V-${String(i).padStart(5, '0')}`),
      cell(`GRDT-${i}`),
      cell(String(i % 10)),
      cell(i % 2 === 0 ? 'Postado' : 'Não postado ainda'),
      cell(i % 2 === 0 ? '03/09/2026, 08:31' : '32'),
    ]);
  }
  const volumeBytes = await buildWorkbook(JSZip, [{ name: 'RESUMO', rows: volume, options: {} }]);
  const volumeMeta = await openRelation(V, volumeBytes, 'conf-volume', 'Conferencia_volume.xlsx');
  const volumeIndex = await V.tasks.indexRelation({ fileId: 'conf-volume', mapping: volumeMeta.mapping });
  eq(volumeIndex.totalRows, volumeCount, 'volume deve manter todas as linhas na auditoria');
  eq(volumeIndex.selected.size, volumeCount / 2, 'volume deve indexar apenas a metade confirmada');
  eq(volumeIndex.conferenceStats.excluded, volumeCount / 2, 'volume deve contabilizar excluídos sem tentar atualizá-los');

  console.log(`conference-relation: ${checks}/${checks} verificações aprovadas.`);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exitCode = 1;
});
