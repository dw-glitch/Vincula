/**
 * Regressão: o Vincula atualiza a LD sem destruir fórmulas, vínculos externos
 * nem a estrutura do pacote XLSX.
 *
 * Usa a fixture "como o Excel salva" (fixtures-external.js) com vínculo à
 * planilha corporativa Controle de Solicitações de Documentos_02.xlsx.
 */
'use strict';

const assert = require('node:assert/strict');
const { loadVincula } = require('./harness');
const { buildWorkbook, STYLE, serial } = require('./fixtures');
const { buildExternalLd, CORPORATE_TARGET, RELATIVE_TARGET } = require('./fixtures-external');

const { V, JSZip } = loadVincula();
const PA = V.packageAudit;

let passed = 0;
async function check(label, fn) {
  await fn();
  passed++;
  console.log(`  \u2713 ${label}`);
}

async function relationWorkbook() {
  return buildWorkbook(JSZip, [{
    name: 'Relacao', options: {}, rows: [
      [{ text: 'Documento' }, { text: 'GRDT' }, { text: 'DATA DA GERAÇÃO / POSTAGEM' }, { text: 'Revisão' }, { text: 'Propósito' }],
      [{ text: 'DOC-001' }, { text: 'GR-NEW-1' }, { dateSerial: serial(2026, 8, 4), style: STYLE.DATE }, { text: '0' }, { text: 'EMISSÃO INICIAL' }],
      [{ text: 'DOC-003' }, { text: 'GR-NEW-3' }, { dateSerial: serial(2026, 8, 5), style: STYLE.DATE }, { text: 'B' }, { text: 'EMISSÃO INICIAL' }],
    ],
  }]);
}

async function processLd(ldBytes, id) {
  const relMeta = await V.tasks.open({ fileId: `rel-${id}`, name: 'REL.xlsx', bytes: await relationWorkbook(), hash: `rel-${id}`, profile: 'relation' });
  const ldMeta = await V.tasks.open({ fileId: `ld-${id}`, name: 'LD-C1O.xlsx', bytes: ldBytes, hash: `ld-${id}`, profile: 'ld' });
  const relIndex = await V.tasks.indexRelation({ fileId: `rel-${id}`, mapping: relMeta.mapping });
  const ldIndex = await V.tasks.indexLd({ fileId: `ld-${id}`, mapping: ldMeta.mapping });
  const analysis = V.analyzer.analyze(relIndex, V.indexer.buildGlobalIndex([ldIndex]),
    new Map([[`ld-${id}`, { id: `ld-${id}`, name: 'LD-C1O.xlsx', sheetName: 'LD' }]]));
  const result = await V.tasks.apply({
    fileId: `ld-${id}`, mapping: ldMeta.mapping, mappings: ldMeta.mappings,
    plan: analysis.plans.get(`ld-${id}`), options: { verify: true },
  });
  return { result, ldMeta };
}

async function cellXml(bytes, path, ref) {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file(path).async('string');
  const m = new RegExp(`<c r="${ref}"[^>]*?(?:/>|>[\\s\\S]*?</c>)`).exec(xml);
  return m ? m[0] : null;
}

async function displayAt(bytes, ref) {
  const wb = await V.xlsx.open(bytes, 'v.xlsx');
  const xml = await V.xlsx.readSheetXml(wb, wb.sheets[0]);
  const col = V.util.refCol(ref);
  const model = V.xlsx.scanSheet(wb, xml, { columns: [col] });
  return V.xlsx.cellDisplay(V.xlsx.getCell(model, V.util.refRow(ref), col));
}

async function mutate(bytes, fn) {
  const zip = await JSZip.loadAsync(bytes);
  await fn(zip);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

async function auditPair(beforeBytes, afterBytes, edited = []) {
  const before = await PA.inventory(await JSZip.loadAsync(beforeBytes), { detailSheets: edited });
  const after = await PA.inventory(await JSZip.loadAsync(afterBytes), { detailSheets: edited });
  return PA.compare(before, after, { editedSheets: edited });
}

async function run() {
  const original = await buildExternalLd(JSZip);
  const { result } = await processLd(original, 'a');

  console.log('\nPacote gerado com vínculos externos');
  await check('processamento concluído', () => assert.equal(result.ok, true, result.error));
  await check('auditoria de pacote aprovada', () => assert.equal(result.packageIntegrity.ok, true, result.packageIntegrity.failures.join('\n')));

  const z0 = await JSZip.loadAsync(original);
  const z1 = await JSZip.loadAsync(result.bytes);
  const names0 = Object.keys(z0.files).sort();
  const names1 = Object.keys(z1.files).sort();
  await check('mesmas partes, sem entradas de diretório inseridas', () => assert.deepEqual(names1, names0));

  const untouched = names0.filter((n) => n !== 'xl/worksheets/sheet1.xml' && n !== 'xl/styles.xml');
  for (const name of untouched) {
    const a = await z0.file(name).async('uint8array');
    const b = await z1.file(name).async('uint8array');
    assert.equal(Buffer.compare(Buffer.from(a), Buffer.from(b)), 0, `${name} alterada`);
  }
  await check(`${untouched.length} partes não editadas byte a byte idênticas (externalLinks, rels, workbook, calcChain, tabela, comentários…)`, () => {});

  const linkRels = await z1.file('xl/externalLinks/_rels/externalLink1.xml.rels').async('string');
  await check('caminho corporativo Z:\\…\\Controle de Solicitações de Documentos_02.xlsx preservado literalmente', () =>
    assert.ok(linkRels.includes(`Target="${CORPORATE_TARGET}"`) && linkRels.includes('TargetMode="External"')));
  const link2 = await z1.file('xl/externalLinks/_rels/externalLink2.xml.rels').async('string');
  await check('vínculo relativo preservado sem resolução de caminho', () => assert.ok(link2.includes(`Target="${RELATIVE_TARGET}"`)));
  const wbXml = await z1.file('xl/workbook.xml').async('string');
  await check('externalReferences e nomes definidos intactos', () => {
    assert.ok(wbXml.includes('<externalReferences><externalReference r:id="rId3"/><externalReference r:id="rId4"/></externalReferences>'));
    assert.ok(wbXml.includes('<definedName name="BASE_SOLICITACOES">[1]Solicitações!$A:$C</definedName>'));
  });

  for (const ref of ['H4', 'H5', 'H6', 'H7', 'I4', 'I5', 'J4', 'K4', 'I9', 'J9']) {
    assert.equal(await cellXml(result.bytes, 'xl/worksheets/sheet1.xml', ref), await cellXml(original, 'xl/worksheets/sheet1.xml', ref), ref);
  }
  await check('PROCX [1], PROCV compartilhada [2], CONT.SES, SOMASES, matriz e #REF! legado idênticos (fórmula + cache)', () => {});

  const checks = Object.fromEntries(result.packageIntegrity.checks.map((c) => [c.id, c]));
  await check('contagens antes = depois (fórmulas, PROCX, externas)', () => {
    assert.equal(checks.formulas.before, 20); assert.equal(checks.formulas.after, 20);
    assert.equal(checks.fn_procx.before, 4); assert.equal(checks.fn_procx.after, 4);
    assert.equal(checks.formulasExternas.before, 12); assert.equal(checks.formulasExternas.after, 12);
    assert.equal(checks.vinculos.before, 2); assert.equal(checks.vinculos.after, 2);
  });
  await check('#REF! pré-existente vira ALERTA (não reprova) e nenhum novo #REF!', () => {
    assert.equal(checks.ref.status, 'ALERTA'); assert.equal(checks.ref.before, 4); assert.equal(checks.ref.after, 4);
  });
  await check('vínculo relativo sinalizado no relatório', () => assert.equal(checks.vinculosRelativos.status, 'ALERTA'));

  console.log('\nRegras de negócio preservadas');
  await check('STATUS EMITIDO quando a GRDT foi preenchida', async () => {
    assert.equal(await displayAt(result.bytes, 'E4'), 'GR-NEW-1');
    assert.equal(await displayAt(result.bytes, 'G4'), 'EMITIDO');
    assert.equal(await displayAt(result.bytes, 'G6'), 'EMITIDO');
  });
  await check('STATUS CANCELADO quando PROPÓSITO = CANCELADO', async () => assert.equal(await displayAt(result.bytes, 'G5'), 'CANCELADO'));
  await check('sem GRDT: STATUS preservado', async () => assert.equal(await displayAt(result.bytes, 'G7'), 'EM EMISSÃO'));
  await check('somente células autorizadas alteradas', () => assert.equal(checks.alteracoes.after, result.counters.authorizedCells));

  console.log('\nZIP de origem não é mutado pelo commit');
  await check('após o commit o pacote em memória continua sendo o original', async () => {
    const wb = await V.xlsx.open(original, 'x.xlsx');
    const path = 'xl/worksheets/sheet1.xml';
    const before = await V.xlsx.readSheetXml(wb, wb.sheets[0]);
    V.xlsx.stagePart(wb, path, before.replace('DOC', 'DOC'));
    V.xlsx.stagePart(wb, path, before + '<!-- alterado -->');
    const bytes = await V.xlsx.commit(wb);
    assert.equal(await V.xlsx.readSheetXml(wb, wb.sheets[0]), before);
    assert.ok(!Object.keys(wb.zip.files).some((n) => n.endsWith('/')));
    assert.ok((await (await JSZip.loadAsync(bytes)).file(path).async('string')).endsWith('<!-- alterado -->'));
  });

  console.log('\nA auditoria reprova perdas reais');
  const lostLink = await mutate(result.bytes, (zip) => {
    zip.remove('xl/externalLinks/externalLink1.xml');
    zip.remove('xl/externalLinks/_rels/externalLink1.xml.rels');
  });
  await check('externalLink removido → FALHA', async () => {
    const r = await auditPair(original, lostLink);
    assert.equal(r.ok, false);
    assert.ok(r.checks.find((c) => c.id === 'vinculos').status === 'FALHA');
  });
  const rewrittenPath = await mutate(result.bytes, async (zip) => {
    const p = 'xl/externalLinks/_rels/externalLink1.xml.rels';
    zip.file(p, (await zip.file(p).async('string')).replace(CORPORATE_TARGET, 'file:///C:/Users/x/Downloads/Controle.xlsx'));
  });
  await check('caminho do vínculo trocado por caminho local → FALHA', async () => assert.equal((await auditPair(original, rewrittenPath)).ok, false));
  const formulaToValue = await mutate(result.bytes, async (zip) => {
    const p = 'xl/worksheets/sheet1.xml';
    zip.file(p, (await zip.file(p).async('string')).replace(/<c r="H5" t="str"><f>[^<]*<\/f>/, '<c r="H5" t="str">'));
  });
  await check('fórmula PROCX convertida em valor → FALHA', async () => {
    const r = await auditPair(original, formulaToValue, ['xl/worksheets/sheet1.xml']);
    assert.equal(r.ok, false);
    assert.equal(r.checks.find((c) => c.id === 'fn_procx').status, 'FALHA');
  });
  const newRef = await mutate(result.bytes, async (zip) => {
    const p = 'xl/worksheets/sheet1.xml';
    zip.file(p, (await zip.file(p).async('string')).replace('[1]Solicitações!$C:$C,"")</f><v>SOL-20', '#REF!,"")</f><v>SOL-20'));
  });
  await check('#REF! introduzido → FALHA', async () => assert.equal((await auditPair(original, newRef, ['xl/worksheets/sheet1.xml'])).ok, false));
  const withDirs = await mutate(result.bytes, (zip) => zip.folder('xl/worksheets'));
  await check('entradas de diretório inseridas → FALHA', async () => assert.equal((await auditPair(original, withDirs)).ok, false));

  console.log('\nEditor de células');
  await check('célula em intervalo de fórmula de matriz é bloqueada', async () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1"><f t="array" ref="A1:A3">B1:B3*2</f><v>2</v></c><c r="B1"><v>1</v></c></row><row r="2"><c r="A2"><v>4</v></c></row></sheetData></worksheet>';
    const wb = await V.xlsx.open(original, 'x.xlsx');
    const model = V.xlsx.scanSheet(wb, xml, {});
    const guards = V.xlsx.readGuards(xml);
    assert.equal(V.xlsx.inspectTarget(model, guards, 2, 1).blocked, 'FORMULA');
    assert.equal(V.xlsx.inspectTarget(model, guards, 1, 2).blocked, null);
  });
  await check('atributos regravados sem duplo escape e sem metadados órfãos (vm/cm)', async () => {
    const xml = '<worksheet><sheetData><row r="1"><c r="A1" s="0" vm="1" xr:uid="a&amp;b" t="s"><v>0</v></c></row></sheetData></worksheet>';
    const wb = await V.xlsx.open(original, 'x.xlsx');
    const model = V.xlsx.scanSheet(wb, xml, {});
    const editor = V.xlsx.createEditor(wb, model, V.xlsx.readGuards(xml));
    editor.writeText(1, 1, 'EMITIDO');
    const out = editor.render();
    assert.ok(out.includes('xr:uid="a&amp;b"'), out);
    assert.ok(!out.includes('vm="1"'), out);
  });

  console.log(`\npackage-integrity: ${passed} verificações aprovadas.`);
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
