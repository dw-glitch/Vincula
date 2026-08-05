/**
 * Suíte de testes do núcleo do Vincula.
 *
 * Cobre as regras funcionais obrigatórias (atualização de GRDT, conversão de
 * data, tratamento de data inválida, documento não encontrado, duplicidade) e
 * as garantias de integridade (nenhuma célula alterada fora das colunas
 * autorizadas, preservação de fórmulas, proteção, validações, mesclagens,
 * formatação condicional e partes auxiliares do pacote).
 *
 *   node tests/run.js
 */
'use strict';

const { loadVincula } = require('./harness');
const { buildWorkbook, serial, STYLE } = require('./fixtures');

const { V, JSZip } = loadVincula();

/* ------------------------------------------------------------------ *
 * Mini framework
 * ------------------------------------------------------------------ */

const results = [];
let currentSuite = '';

function suite(name) {
  currentSuite = name;
  console.log(`\n\x1b[1m${name}\x1b[0m`);
}

function check(description, condition, detail) {
  const ok = !!condition;
  results.push({ suite: currentSuite, description, ok, detail });
  const mark = ok ? '\x1b[32m  ✓\x1b[0m' : '\x1b[31m  ✗\x1b[0m';
  console.log(`${mark} ${description}${ok || detail === undefined ? '' : `\n      → ${detail}`}`);
  return ok;
}

function equal(description, actual, expected) {
  const ok = Object.is(actual, expected);
  return check(description, ok, ok ? undefined : `esperado ${JSON.stringify(expected)}, obtido ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const SERIAL_2026_01_01 = serial(2026, 1, 1);
const SERIAL_2026_02_02 = serial(2026, 2, 2);
const SERIAL_2026_08_04 = serial(2026, 8, 4);
const SERIAL_2026_08_05 = serial(2026, 8, 5);

// A relação traz duas linhas de preâmbulo antes do cabeçalho real e usa
// grafias variadas — a detecção precisa achar a linha 3 sozinha.
function relationRows() {
  return [
    [{ inline: 'RELAÇÃO GRCON — CONTROLE DE GUIAS', style: STYLE.HEADER }],
    [],
    [
      { text: 'Nº', style: STYLE.HEADER },
      { text: 'GRDT', style: STYLE.HEADER },
      { text: 'Situação', style: STYLE.HEADER },
      { text: 'DOCUMENTO', style: STYLE.HEADER },
      { text: 'DATA DA GERAÇÃO / POSTAGEM', style: STYLE.HEADER },
    ],
    [{ number: 1 }, { text: '900100' }, { text: 'Emitida' }, { text: 'DOC-001' }, { text: '04/08/2026 08:31:45' }],
    [{ number: 2 }, { text: '900200' }, { text: 'Pendente' }, { text: 'DOC-002' }, { text: '-' }],
    [{ number: 3 }, { text: '900300' }, { text: 'Pendente' }, { text: 'DOC-003' }, { inline: '' }],
    [{ number: 4 }, { text: '900400' }, { text: 'Emitida' }, { text: 'DOC-004' }, { text: '15/01/2026 23:59:59' }],
    // Duplicata de DOC-001: vence a última ocorrência física.
    [{ number: 5 }, { text: '900101' }, { text: 'Reemitida' }, { text: 'DOC-001' }, { text: '05/08/2026 10:00:00' }],
    // Documento que não existe em nenhuma LD carregada.
    [{ number: 6 }, { text: '900999' }, { text: 'Emitida' }, { text: 'DOC-999' }, { text: '01/02/2026 00:00:01' }],
    // Documento com sufixo .pdf e caixa baixa + data como célula de data real
    // com fração de dia (08:30) — precisa ser truncada.
    [{ number: 7 }, { text: '900500' }, { text: 'Emitida' }, { text: 'doc-005.pdf' }, { dateSerial: SERIAL_2026_08_04 + 0.354166, style: STYLE.DATE }],
    // GRDT vazia: só a data deve ser atualizada.
    [{ number: 8 }, { inline: '' }, { text: 'Emitida' }, { text: 'DOC-006' }, { text: '10/03/2026 12:00:00' }],
  ];
}

function ldRows() {
  return [
    [
      { text: 'Item', style: STYLE.HEADER },
      { text: 'Código do Documento', style: STYLE.HEADER },
      { text: 'eGRDT', style: STYLE.HEADER },
      { text: 'Data Efetiva de Emissão', style: STYLE.HEADER },
      { text: 'Observação', style: STYLE.HEADER },
      { text: 'Total', style: STYLE.HEADER },
    ],
    // 2: GRDT e data mudam
    [{ number: 1 }, { text: 'DOC-001' }, { text: '900000' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }, { text: 'URGENTE' }, { formula: 'A2*2', cached: '2' }],
    // 3: data da relação inválida → data preservada, GRDT atualizada
    [{ number: 2 }, { text: 'DOC-002' }, { text: '888' }, { dateSerial: SERIAL_2026_02_02, style: STYLE.DATE }, { text: 'ok' }, { formula: 'A3*2', cached: '4' }],
    // 4: sem data na LD e sem data na relação → nada muda na data
    [{ number: 3 }, { text: 'DOC-003' }, { inline: '' }, null, { text: 'ok' }, { formula: 'A4*2', cached: '6' }],
    // 5: data gravada como TEXTO → precisa virar data real do Excel
    [{ number: 4 }, { text: 'DOC-005' }, { inline: '' }, { text: '04/08/2026', style: STYLE.TEXT }, { text: 'ok' }, { formula: 'A5*2', cached: '8' }],
    // 6: GRDT vazia na relação → GRDT preservada, data atualizada
    [{ number: 5 }, { text: 'DOC-006' }, { text: '777' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }, { text: 'ok' }, { formula: 'A6*2', cached: '10' }],
    // 7: documento fora da relação → linha intocada
    [{ number: 6 }, { text: 'DOC-007' }, { text: '555' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }, { text: 'ok' }, { formula: 'A7*2', cached: '12' }],
    // 8: GRDT é fórmula → gravação bloqueada, fórmula preservada
    [{ number: 7 }, { text: 'DOC-004' }, { formula: 'CONCATENATE("GR","555")', cached: 'GR555' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }, { text: 'ok' }, { formula: 'A8*2', cached: '14' }],
  ];
}

const LD_OPTIONS = {
  protection: true,
  autoFilter: 'A1:F8',
  merges: ['E9:F9'],
  validation: 'E2:E20',
  conditional: 'E2:E20',
};

function secondSheetRows() {
  return [
    [{ text: 'Resumo', style: STYLE.HEADER }],
    [{ text: 'Peso' }, { number: 12.5, style: STYLE.CUSTOM }],
    [{ text: 'DOC-001' }, { text: 'não deve ser tocado' }],
  ];
}

/* ------------------------------------------------------------------ *
 * Utilidades de verificação
 * ------------------------------------------------------------------ */

async function partText(bytes, path) {
  const zip = await JSZip.loadAsync(bytes);
  const file = zip.file(path);
  return file ? file.async('string') : null;
}

async function openModel(bytes, name, columns) {
  const wb = await V.xlsx.open(bytes, name);
  const sheet = wb.sheets[0];
  const xml = await V.xlsx.readSheetXml(wb, sheet);
  const model = V.xlsx.scanSheet(wb, xml, { columns });
  return { wb, sheet, xml, model };
}

/* ------------------------------------------------------------------ *
 * Execução
 * ------------------------------------------------------------------ */

async function main() {
  const relationBytes = await buildWorkbook(JSZip, [
    { name: 'Relação', rows: relationRows(), options: { autoFilter: 'A3:E11' } },
  ]);
  const ldBytes = await buildWorkbook(JSZip, [
    { name: 'Dados', rows: ldRows(), options: LD_OPTIONS },
    { name: 'Resumo', rows: secondSheetRows(), options: {} },
  ]);
  // Segunda LD: só contém DOC-004, para testar duplicidade entre arquivos.
  const ld2Rows = [
    ldRows()[0],
    [{ number: 1 }, { text: 'DOC-004' }, { text: '111' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }, { text: 'ok' }, { number: 1 }],
  ];
  const ld2Bytes = await buildWorkbook(JSZip, [{ name: 'Dados', rows: ld2Rows, options: {} }]);

  /* ---------------- Detecção de cabeçalhos ---------------- */
  suite('Detecção inteligente de cabeçalhos');

  for (const [text, kind] of [
    ['DATA EFETIVA DE EMISSÃO', 'dateEffective'],
    ['Data Efetiva de Emissão', 'dateEffective'],
    ['data efetiva de emissão', 'dateEffective'],
    ['DATA EFETIVA EMISSAO', 'dateEffective'],
    ['Data Efetiva Emissao', 'dateEffective'],
    ['  data-efetiva  de   emissao ', 'dateEffective'],
    ['eGRDT', 'grdt'],
    ['E GRDT', 'grdt'],
    ['GRDT', 'grdt'],
    ['DOCUMENTO', 'document'],
    ['Código Documento', 'document'],
    ['Código do Documento', 'document'],
    ['DATA DA GERAÇÃO / POSTAGEM', 'datePosting'],
    ['DATA DA POSTAGEM', 'datePosting'],
    ['Data da Geração', 'datePosting'],
  ]) {
    check(`"${text}" reconhecido como ${kind}`, V.headers.scoreHeader(kind, text) >= 55, `pontuação ${V.headers.scoreHeader(kind, text)}`);
  }

  check('"DATA DA POSTAGEM" não é confundida com Data Efetiva', V.headers.scoreHeader('dateEffective', 'DATA DA POSTAGEM') === 0);
  check('"Tipo de Documento" não é confundido com Documento', V.headers.scoreHeader('document', 'Tipo de Documento') === 0);

  /* ---------------- Datas ---------------- */
  suite('Conversão e validação de datas');

  const parsed = V.dates.parseDate('04/08/2026 08:31:45');
  equal('"04/08/2026 08:31:45" vira 04/08/2026', V.dates.formatDate(parsed), '04/08/2026');
  equal('sem resíduo de hora', parsed.getUTCHours() + parsed.getUTCMinutes() + parsed.getUTCSeconds() + parsed.getUTCMilliseconds(), 0);
  equal('serial fracionário é truncado', V.dates.truncateSerial(SERIAL_2026_08_04 + 0.9999), SERIAL_2026_08_04);
  equal('ida e volta preserva o dia', V.dates.dateToSerial(V.dates.serialToDate(SERIAL_2026_08_04 + 0.354, false), false), SERIAL_2026_08_04);

  for (const invalid of ['-', '', '   ', 'null', 'undefined', 'data inválida', '–', 'N/A', '#N/D']) {
    check(`"${invalid}" é data inválida`, V.dates.isBlankDateToken(invalid));
  }
  check('"04/08/2026" é data válida', !V.dates.isBlankDateToken('04/08/2026') && !!V.dates.parseDate('04/08/2026'));
  check('31/02/2026 é rejeitada', V.dates.parseDate('31/02/2026') === null);

  /* ---------------- Abertura e mapeamento ---------------- */
  suite('Abertura, amostragem e sugestão de mapeamento');

  const relationMeta = await V.tasks.open({ fileId: 'rel', name: 'RELACAO.xlsx', bytes: relationBytes, hash: 'h-rel', profile: 'relation' });
  equal('cabeçalho da relação na linha 3', relationMeta.mapping.headerRow, 3);
  equal('coluna DOCUMENTO detectada', relationMeta.mapping.documentCol, 4);
  equal('coluna GRDT detectada', relationMeta.mapping.grdtCol, 2);
  equal('coluna DATA DA GERAÇÃO / POSTAGEM detectada', relationMeta.mapping.dateCol, 5);
  equal('confiança alta na relação', relationMeta.mapping.confidence, 'alta');

  const ldMeta = await V.tasks.open({ fileId: 'ld1', name: 'LD-A.xlsx', bytes: ldBytes, hash: 'h-ld1', profile: 'ld' });
  equal('cabeçalho da LD na linha 1', ldMeta.mapping.headerRow, 1);
  equal('coluna Código do Documento detectada', ldMeta.mapping.documentCol, 2);
  equal('coluna eGRDT detectada', ldMeta.mapping.grdtCol, 3);
  equal('coluna Data Efetiva de Emissão detectada', ldMeta.mapping.dateCol, 4);
  equal('aba de dados escolhida', ldMeta.mapping.sheetName, 'Dados');

  const ld2Meta = await V.tasks.open({ fileId: 'ld2', name: 'LD-B.xlsx', bytes: ld2Bytes, hash: 'h-ld2', profile: 'ld' });

  /* ---------------- Cache ---------------- */
  suite('Cache por hash de conteúdo');
  const again = await V.tasks.open({ fileId: 'ld1-again', name: 'LD-A.xlsx', bytes: ldBytes, hash: 'h-ld1', profile: 'ld' });
  check('mesmo hash + mesmo nome reaproveita a indexação', again.fromCache === true);
  const changed = await V.tasks.open({ fileId: 'ld1-mod', name: 'LD-A.xlsx', bytes: ldBytes, hash: 'h-diferente', profile: 'ld' });
  check('hash diferente invalida o cache', changed.fromCache === false);

  /* ---------------- Índices ---------------- */
  suite('Índices e regras de duplicidade');

  const relationIndex = await V.tasks.indexRelation({ fileId: 'rel', mapping: relationMeta.mapping });
  equal('linhas úteis da relação', relationIndex.totalRows, 8);
  equal('documentos únicos', relationIndex.uniqueDocuments, 7);
  equal('duplicados na relação', relationIndex.duplicates.length, 1);
  equal('duplicado é DOC-001', relationIndex.duplicates[0].document, 'DOC-001');
  equal('vence a última ocorrência (linha 8)', relationIndex.duplicates[0].selectedRow, 8);
  equal('GRDT vencedora', relationIndex.selected.get('DOC-001').grdt, '900101');
  equal('datas inválidas na relação', relationIndex.invalidDates.length, 2);
  equal('sufixo .pdf normalizado', relationIndex.selected.has('DOC-005'), true);
  equal('data com fração truncada', relationIndex.selected.get('DOC-005').dateText, '04/08/2026');
  check('sem aviso de cabeçalho de postagem', relationIndex.headerWarning === null, relationIndex.headerWarning);

  const ldIndex1 = await V.tasks.indexLd({ fileId: 'ld1', mapping: ldMeta.mapping });
  const ldIndex2 = await V.tasks.indexLd({ fileId: 'ld2', mapping: ld2Meta.mapping });
  equal('documentos indexados na LD-A', ldIndex1.entries.length, 7);

  const globalIndex = V.indexer.buildGlobalIndex([ldIndex1, ldIndex2]);
  equal('índice global é O(1) por documento', globalIndex.byDocument.get('DOC-001').length, 1);
  equal('DOC-004 aparece nas duas LDs', globalIndex.byDocument.get('DOC-004').length, 2);

  /* ---------------- Análise ---------------- */
  suite('Análise de correspondências');

  const files = new Map([
    ['ld1', { id: 'ld1', name: 'LD-A.xlsx', sheetName: 'Dados' }],
    ['ld2', { id: 'ld2', name: 'LD-B.xlsx', sheetName: 'Dados' }],
  ]);
  const analysis = V.analyzer.analyze(relationIndex, globalIndex, files);

  equal('documentos não encontrados', analysis.stats.missing, 1);
  equal('não encontrado é DOC-999', analysis.missing[0].document, 'DOC-999');
  equal('motivo do não encontrado', analysis.missing[0].reason, 'Documento pertence a outra LD.');
  equal('status do não encontrado', analysis.missing[0].status, 'NAO_ENCONTRADO');
  equal('documentos encontrados', analysis.stats.found, 6);

  const byDoc = (doc) => analysis.records.filter((r) => r.document === doc);
  const doc002 = byDoc('DOC-002')[0];
  check('DOC-002 marcado com data inválida', doc002.flags.includes('DATA_INVALIDA'));
  check('DOC-002 não altera a data', doc002.dateWillChange === false);
  check('DOC-002 altera a GRDT', doc002.grdtWillChange === true);
  equal('DOC-002 mantém a data original na prévia', doc002.afterDate, '02/02/2026');

  const doc006 = byDoc('DOC-006')[0];
  check('DOC-006 sem GRDT na relação não altera GRDT', doc006.grdtWillChange === false);
  check('DOC-006 atualiza a data', doc006.dateWillChange === true);
  check('DOC-006 sinaliza GRDT ausente', doc006.flags.includes('GRDT_AUSENTE'));

  const doc005 = byDoc('DOC-005')[0];
  check('DOC-005 converte data-texto em data real', doc005.dateWillChange === true && doc005.flags.includes('DATA_TEXTO'));

  const doc007 = byDoc('DOC-007');
  equal('DOC-007 não está na relação e não gera registro', doc007.length, 0);

  const doc004 = byDoc('DOC-004');
  equal('DOC-004 gera um registro por LD', doc004.length, 2);
  check('DOC-004 marcado como duplicado na LD', doc004[0].flags.includes('DUPLICADO_LD'));

  const doc001 = byDoc('DOC-001')[0];
  equal('DOC-001 recebe a GRDT da última ocorrência', doc001.afterGrdt, '900101');
  equal('DOC-001 recebe a data da última ocorrência', doc001.afterDate, '05/08/2026');
  check('DOC-001 marcado como duplicado na relação', doc001.flags.includes('DUPLICADO_RELACAO'));

  /* ---------------- Aplicação ---------------- */
  suite('Gravação, integridade e preservação');

  const applied = await V.tasks.apply({
    fileId: 'ld1',
    mapping: ldMeta.mapping,
    plan: analysis.plans.get('ld1'),
    options: { verify: true },
  });

  check('gravação concluída', applied.ok === true, applied.error);
  check('auditoria de integridade aprovada', applied.integrity && applied.integrity.ok === true, JSON.stringify(applied.integrity?.violations));
  check('auditoria comparou o arquivo inteiro', (applied.integrity?.comparedCells || 0) > 30, `${applied.integrity?.comparedCells} células`);
  equal('nome do arquivo gerado', applied.outputName, 'LD-A_ATUALIZADA_GRDT.xlsx');
  check('proteção da aba registrada como ocorrência', applied.occurrences.some((o) => o.type === 'PROTECAO'));
  check('célula com fórmula bloqueada', applied.occurrences.some((o) => o.type === 'FORMULA' && o.ref === 'C8'));

  const out = await openModel(applied.bytes, 'saida', [2, 3, 4, 5, 6]);

  const grdt001 = V.xlsx.getCell(out.model, 2, 3);
  equal('GRDT de DOC-001 gravada', V.xlsx.cellDisplay(grdt001), '900101');

  const date001 = V.xlsx.getCell(out.model, 2, 4);
  check('data de DOC-001 é data real do Excel', date001.isDate === true, `numeric=${date001.numeric} style=${date001.styleId}`);
  equal('data de DOC-001 sem hora', date001.numeric, SERIAL_2026_08_05);
  equal('data de DOC-001 exibida como dd/mm/aaaa', V.xlsx.cellDisplay(date001), '05/08/2026');
  check('data não foi gravada como texto', date001.type === '' || date001.type === 'n', `t="${date001.type}"`);

  const date002 = V.xlsx.getCell(out.model, 3, 4);
  equal('data inválida preserva a data original', date002.numeric, SERIAL_2026_02_02);
  equal('GRDT de DOC-002 atualizada mesmo com data inválida', V.xlsx.cellDisplay(V.xlsx.getCell(out.model, 3, 3)), '900200');

  const date005 = V.xlsx.getCell(out.model, 5, 4);
  check('data-texto convertida em data real', date005.isDate === true && date005.numeric === SERIAL_2026_08_04, `numeric=${date005.numeric}`);

  const grdt006 = V.xlsx.getCell(out.model, 6, 3);
  equal('GRDT preservada quando ausente na relação', V.xlsx.cellDisplay(grdt006), '777');
  equal('data de DOC-006 atualizada', V.xlsx.cellDisplay(V.xlsx.getCell(out.model, 6, 4)), '10/03/2026');

  equal('linha de DOC-007 intocada (GRDT)', V.xlsx.cellDisplay(V.xlsx.getCell(out.model, 7, 3)), '555');
  equal('linha de DOC-007 intocada (data)', V.xlsx.getCell(out.model, 7, 4).numeric, SERIAL_2026_01_01);

  const grdtFormula = V.xlsx.getCell(out.model, 8, 3);
  check('fórmula na coluna GRDT preservada', grdtFormula.hasFormula === true);
  equal('fórmula manteve o resultado em cache', V.xlsx.cellDisplay(grdtFormula), 'GR555');
  equal('data de DOC-004 atualizada apesar da GRDT bloqueada', V.xlsx.cellDisplay(V.xlsx.getCell(out.model, 8, 4)), '15/01/2026');

  const outSheetXml = out.xml;
  check('proteção de aba preservada', outSheetXml.includes('<sheetProtection'));
  check('autofiltro preservado', outSheetXml.includes('<autoFilter'));
  check('mesclagem preservada', outSheetXml.includes('<mergeCell ref="E9:F9"/>'));
  check('validação de dados preservada', outSheetXml.includes('<dataValidation'));
  check('formatação condicional preservada', outSheetXml.includes('<conditionalFormatting'));
  check('coluna com largura customizada preservada', outSheetXml.includes('customWidth="1"'));
  check('fórmulas da coluna Total preservadas', (outSheetXml.match(/<f>A\d+\*2<\/f>/g) || []).length === 7);

  const originalSecond = await partText(ldBytes, 'xl/worksheets/sheet2.xml');
  const outputSecond = await partText(applied.bytes, 'xl/worksheets/sheet2.xml');
  check('segunda aba idêntica byte a byte', originalSecond === outputSecond);

  const originalShared = await partText(ldBytes, 'xl/sharedStrings.xml');
  const outputShared = await partText(applied.bytes, 'xl/sharedStrings.xml');
  check('sharedStrings intacto', originalShared === outputShared);

  const originalProps = await partText(ldBytes, 'docProps/core.xml');
  const outputProps = await partText(applied.bytes, 'docProps/core.xml');
  check('partes auxiliares do pacote intactas', originalProps === outputProps);

  const originalStyles = await partText(ldBytes, 'xl/styles.xml');
  const outputStyles = await partText(applied.bytes, 'xl/styles.xml');
  check('styles.xml só recebeu acréscimos', outputStyles.length >= originalStyles.length && outputStyles.includes('numFmtId="164" formatCode="0.00'));
  check('formato de data adicionado ao styles.xml', /formatCode="dd\/mm\/yyyy"/.test(outputStyles));

  /* ---------------- Diferencial completo ---------------- */
  suite('Meta de integridade: zero alterações fora do escopo');

  const before = await openModel(ldBytes, 'antes', null);
  const after = await openModel(applied.bytes, 'depois', null);
  const authorized = new Set(['C2', 'D2', 'C3', 'D4', 'D5', 'D6', 'D8', 'C5', 'C4']);
  const unexpected = [];
  for (const [key, cell] of after.model.cells) {
    const original = before.model.cells.get(key);
    const beforeText = original ? V.xlsx.cellDisplay(original) : '(ausente)';
    const afterText = V.xlsx.cellDisplay(cell);
    if (beforeText !== afterText && !authorized.has(cell.ref)) {
      unexpected.push(`${cell.ref}: "${beforeText}" → "${afterText}"`);
    }
  }
  check('nenhuma célula alterada fora de GRDT/Data', unexpected.length === 0, unexpected.join(' | '));
  equal('total de células preservado', after.model.cells.size, before.model.cells.size);

  /* ---------------- Escrita inteligente ---------------- */
  suite('Escrita inteligente (só grava o que mudou)');

  const reapplied = await V.tasks.apply({
    fileId: 'ld2',
    mapping: ld2Meta.mapping,
    plan: analysis.plans.get('ld2'),
    options: { verify: true },
  });
  check('segunda LD gravada', reapplied.ok === true, reapplied.error);
  equal('apenas as células necessárias foram autorizadas', reapplied.counters.authorizedCells, 2);

  const emptyPlan = await V.tasks.apply({ fileId: 'ld2', mapping: ld2Meta.mapping, plan: [], options: { verify: true } });
  equal('plano vazio não autoriza nenhuma célula', emptyPlan.counters.authorizedCells, 0);

  /* ---------------- Rollback ---------------- */
  suite('Rollback');

  const rollbackTest = await V.tasks.apply({
    fileId: 'ld1',
    mapping: ldMeta.mapping,
    // Linha inexistente: a gravação é recusada sem quebrar o arquivo.
    plan: [{ recordId: 1, document: 'DOC-X', row: 99999, grdt: 'X', dateIso: '2026-01-01' }],
    options: { verify: true },
  });
  check('linha inexistente é bloqueada, não gera erro fatal', rollbackTest.ok === true);
  check('bloqueio registrado como ocorrência', rollbackTest.occurrences.some((o) => o.type === 'LINHA_AUSENTE'));
  const rollbackOut = await openModel(rollbackTest.bytes, 'rb', [3, 4]);
  equal('arquivo permanece consistente após bloqueio', V.xlsx.cellDisplay(V.xlsx.getCell(rollbackOut.model, 7, 3)), '555');

  /* ---------------- Auditoria ---------------- */
  suite('Auditoria');

  const report = V.audit.buildReport({
    summary: { 'Versão do Vincula': V.VERSION, finishedAt: new Date().toISOString() },
    records: analysis.records,
    relation: { arquivo: 'RELACAO.xlsx' },
    duplicates: relationIndex.duplicates,
    missing: analysis.missing,
    invalidDates: analysis.invalidDates,
    outputs: [
      { name: applied.outputName, source: 'LD-A.xlsx', size: applied.bytes.length, authorizedCells: applied.counters.authorizedCells, grdtWrites: applied.counters.grdtWrites, dateWrites: applied.counters.dateWrites, integrity: 'APROVADA', hash: applied.outputHash },
    ],
    occurrences: applied.occurrences,
    files: [{ arquivo: 'LD-A.xlsx' }],
    timings: {},
  });

  equal('relatório cobre todos os registros', report.detail.length, analysis.records.length);
  check('detalhamento traz GRDT anterior e nova', report.detail.every((d) => 'grdtAnterior' in d && 'grdtNova' in d));
  check('detalhamento traz timestamp', report.detail.every((d) => !!d.timestamp));

  const auditBytes = await V.audit.buildAuditWorkbook(report);
  check('planilha de auditoria gerada', auditBytes.length > 1000, `${auditBytes.length} bytes`);
  const auditZip = await JSZip.loadAsync(auditBytes);
  equal('auditoria tem 8 abas', Object.keys(auditZip.files).filter((f) => /worksheets\/sheet\d+\.xml$/.test(f)).length, 8);
  const auditReopened = await V.xlsx.open(auditBytes, 'auditoria');
  equal('auditoria é um XLSX legível', auditReopened.sheets[0].name, 'Resumo');

  const json = JSON.parse(V.audit.buildJsonLog(report));
  equal('log JSON identifica a versão', json.versao, V.VERSION);
  check('log JSON lista não encontrados', json.naoEncontrados.some((x) => x.documento === 'DOC-999'));
  check('log JSON lista datas inválidas', json.datasInvalidas.length >= 2);

  /* ---------------- Pacote ---------------- */
  suite('Pacote final');
  const pkg = await V.packager.buildPackage(
    [{ name: applied.outputName, bytes: applied.bytes, hash: applied.outputHash }],
    auditBytes,
    V.audit.buildJsonLog(report),
    { 'Versão do Vincula': V.VERSION }
  );
  const pkgBytes = new Uint8Array(await pkg.arrayBuffer());
  const pkgZip = await JSZip.loadAsync(pkgBytes);
  check('pacote contém a LD atualizada', !!pkgZip.file(`LDs_ATUALIZADAS/${applied.outputName}`));
  check('pacote contém o relatório', !!pkgZip.file('RELATORIO_AUDITORIA_VINCULA.xlsx'));
  check('pacote contém o log', !!pkgZip.file('LOG_VINCULA.json'));
  check('pacote contém o manifesto com hashes', !!pkgZip.file('MANIFESTO.txt'));
  const packedLd = await pkgZip.file(`LDs_ATUALIZADAS/${applied.outputName}`).async('uint8array');
  equal('LD sobrevive ao empacotamento', await V.util.sha256Hex(packedLd), applied.outputHash);

  /* ---------------- Variação real de export: data efetiva na 1ª coluna da relação ---------------- */
  suite('Relação GRCON com "Data Efetiva de Emissão" na 1ª coluna (variação de export)');

  // Alguns exports de GRCON não usam "DATA DA GERAÇÃO / POSTAGEM": a coluna de
  // data já vem rotulada "Data Efetiva de Emissão", como primeira coluna da
  // aba de documentos. O detector precisa reconhecer essa grafia também na
  // relação (não só na LD) sem exigir remapeamento manual.
  const altRelationRows = [
    [
      { text: 'Data Efetiva de Emissão', style: STYLE.HEADER },
      { text: 'Documento', style: STYLE.HEADER },
      { text: 'GRDT', style: STYLE.HEADER },
    ],
    [{ text: '04/08/2026' }, { text: 'DOC-A01' }, { text: 'GR-A01' }],
    [{ text: '05/08/2026' }, { text: 'DOC-A02' }, { text: 'GR-A02' }],
    [{ text: '-' }, { text: 'DOC-A03' }, { text: 'GR-A03' }],
  ];
  const altLdRows = [
    [
      { text: 'Documento', style: STYLE.HEADER },
      { text: 'GRDT', style: STYLE.HEADER },
      { text: 'Data Efetiva de Emissão', style: STYLE.HEADER },
    ],
    [{ text: 'DOC-A01' }, { text: 'ANTIGA-1' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }],
    [{ text: 'DOC-A02' }, { text: 'ANTIGA-2' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }],
    [{ text: 'DOC-A03' }, { text: 'ANTIGA-3' }, { dateSerial: SERIAL_2026_01_01, style: STYLE.DATE }],
  ];

  const altRelationBytes = await buildWorkbook(JSZip, [{ name: 'Documentos', rows: altRelationRows, options: {} }]);
  const altLdBytes = await buildWorkbook(JSZip, [{ name: 'Dados', rows: altLdRows, options: {} }]);

  const altRelMeta = await V.tasks.open({ fileId: 'alt-rel', name: 'GRCON_ALT.xlsx', bytes: altRelationBytes, hash: 'alt-rel', profile: 'relation' });
  equal('coluna A (1ª) reconhecida como data da relação', altRelMeta.mapping.dateCol, 1);
  equal('coluna Documento reconhecida', altRelMeta.mapping.documentCol, 2);
  equal('coluna GRDT reconhecida', altRelMeta.mapping.grdtCol, 3);
  equal('confiança alta mesmo com "Data Efetiva de Emissão" na relação', altRelMeta.mapping.confidence, 'alta');

  const altLdMeta = await V.tasks.open({ fileId: 'alt-ld', name: 'LD_ALT.xlsx', bytes: altLdBytes, hash: 'alt-ld', profile: 'ld' });
  const altRelIndex = await V.tasks.indexRelation({ fileId: 'alt-rel', mapping: altRelMeta.mapping });
  check('sem aviso de cabeçalho não reconhecido', altRelIndex.headerWarning === null, altRelIndex.headerWarning);

  const altLdIndex = await V.tasks.indexLd({ fileId: 'alt-ld', mapping: altLdMeta.mapping });
  const altGlobalIndex = V.indexer.buildGlobalIndex([altLdIndex]);
  const altFiles = new Map([['alt-ld', { id: 'alt-ld', name: 'LD_ALT.xlsx', sheetName: 'Dados' }]]);
  const altAnalysis = V.analyzer.analyze(altRelIndex, altGlobalIndex, altFiles);

  equal('todos os 3 documentos são encontrados na LD', altAnalysis.stats.found, 3);
  equal('nenhum documento fica sem encontrar', altAnalysis.missing.length, 0);
  const altDoc01 = altAnalysis.records.find((r) => r.document === 'DOC-A01');
  equal('GRDT de DOC-A01 seria atualizada', altDoc01.afterGrdt, 'GR-A01');
  equal('data de DOC-A01 vem da coluna A da relação', altDoc01.afterDate, '04/08/2026');
  const altDoc03 = altAnalysis.records.find((r) => r.document === 'DOC-A03');
  check('DOC-A03 com data inválida não bloqueia a GRDT', altDoc03.grdtWillChange === true);
  check('DOC-A03 preserva a data existente na LD', altDoc03.dateWillChange === false);

  /* ---------------- Liberação ---------------- */
  suite('Gerenciamento de memória');
  const statsBefore = V.tasks.stats();
  V.tasks.releaseAll();
  const statsAfter = V.tasks.stats();
  check('arquivos abertos são liberados', statsBefore.openFiles > 0 && statsAfter.openFiles === 0);

  /* ---------------- Resultado ---------------- */
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(64)}`);
  console.log(`${results.length - failed.length}/${results.length} verificações aprovadas.`);
  if (failed.length) {
    console.log('\x1b[31mFalhas:\x1b[0m');
    for (const f of failed) console.log(`  · [${f.suite}] ${f.description}${f.detail ? ` — ${f.detail}` : ''}`);
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error('\n\x1b[31mErro fatal na suíte:\x1b[0m', error);
  process.exitCode = 1;
});
