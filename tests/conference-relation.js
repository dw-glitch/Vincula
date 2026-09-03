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

  // 1) Relatório realista do GRCON: título acima do cabeçalho, ordem igual ao
  // export atual e os três estados observados na Conferência de Postagem.
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
  eq(conferenceMeta.mapping.revisionCol, 6, 'Revisão enviada deve ser a revisão-fonte');
  eq(conferenceMeta.mapping.conferenceCol, 8, 'Conferência deve controlar a confirmação');
  eq(conferenceMeta.mapping.sigemStatusCol, 9, 'Status SIGEM deve ser reconhecido separadamente');
  eq(conferenceMeta.mapping.dateCol, 10, 'Data da confirmação deve alimentar a data confirmada');
  eq(conferenceMeta.mapping.headerRow, 10, 'deve localizar cabeçalho após título e linhas vazias');

  const conferenceIndex = await V.tasks.indexRelation({ fileId: 'conf-real', mapping: conferenceMeta.mapping });
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
  eq(conferenceIndex.selected.get('DOC-001').dateText, '02/09/2026', 'deve converter confirmação com hora para data efetiva pura');
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
  eq(shuffledMeta.mapping.documentCol, 5, 'deve localizar documento fora da primeira coluna');
  eq(shuffledMeta.mapping.grdtCol, 6, 'deve localizar eGRDT fora da posição padrão');
  eq(shuffledMeta.mapping.sigemStatusCol, 7, 'deve localizar Status SIGEM separadamente');
  const shuffledIndex = await V.tasks.indexRelation({ fileId: 'conf-shuffled', mapping: shuffledMeta.mapping });
  eq(shuffledIndex.selected.get('DOC-X').revision, 'R2', 'revisão enviada deve sobreviver à normalização do cabeçalho');

  // 3) Formato legado: comportamento anterior intacto.
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

  // 4) Falta de coluna obrigatória: mensagem específica, sem "arquivo inválido" genérico.
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
    /Data Efetiva de Emissão.*Data da confirmação/,
    'erro deve dizer qual coluna de data não foi encontrada'
  );
  checks++;

  // 5) Volume: milhares de linhas, com somente metade confirmada.
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
