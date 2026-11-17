#!/usr/bin/env node
/**
 * Vincula — diagnóstico de integridade de LDs (uso local, nada sai da máquina).
 *
 * Modos:
 *
 *   1) Inventário de uma LD (fórmulas, PROCX, vínculos externos, #REF!):
 *        node scripts/diagnostico-ld.js LD.xlsx
 *
 *   2) Comparar a LD original com uma versão já gerada (por exemplo, a que
 *      foi baixada do Vincula antes desta correção):
 *        node scripts/diagnostico-ld.js --comparar ORIGINAL.xlsx GERADA.xlsx
 *
 *   3) Processar de ponta a ponta, sem navegador, e auditar cada saída:
 *        node scripts/diagnostico-ld.js --relacao RELACAO.xlsx LD1.xlsx LD2.xlsx ...
 *      As LDs atualizadas e o relatório JSON vão para ./saida-diagnostico/.
 *
 * Código de saída 0 = tudo íntegro; 1 = alguma FALHA de integridade.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { loadVincula } = require('../tests/harness');

const { V, JSZip } = loadVincula();
const PA = V.packageAudit;

function usage() {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(2);
}

function read(file) {
  return new Uint8Array(fs.readFileSync(file));
}

function printInventory(name, inv) {
  const t = inv.totals;
  console.log(`\n=== ${name}`);
  console.log(`Abas: ${inv.sheets.length} · Partes: ${inv.parts.size} · Tabelas: ${inv.tables} · Nomes definidos: ${inv.workbook.definedNames.length}`);
  console.log(`Fórmulas: ${t.formulas} · PROCX: ${t.procx} · PROCV: ${t.procv} · SOMASES: ${t.somases} · CONT.SES: ${t.contses} · SE: ${t.se}`);
  console.log(`Fórmulas com referência externa: ${t.external} · Fórmulas com #REF!: ${t.refErrors}`);
  for (const s of inv.sheets) {
    if (!s.stats) continue;
    console.log(`  - ${s.name}: ${s.stats.formulas} fórmula(s), ${s.stats.external} externa(s), ${s.stats.refErrors} #REF!`);
  }
  console.log(`Vínculos externos (${inv.externalLinks.length}):`);
  inv.externalLinks.forEach((l, i) => console.log(`  [${i + 1}] ${l.targetDecoded || '(sem caminho)'}  ← ${l.targetKind}${l.exists ? '' : ' — PARTE AUSENTE'}`));
  if (inv.directories.length) console.log(`Entradas de diretório no ZIP: ${inv.directories.join(', ')}`);
}

function printReport(report) {
  console.log(`\n--- Integridade: ${report.file || ''} → ${report.ok ? 'APROVADA' : 'REPROVADA'}`);
  for (const c of report.checks) {
    const mark = c.status === 'OK' ? 'OK    ' : c.status === 'ALERTA' ? 'ALERTA' : 'FALHA ';
    console.log(`  ${mark} ${c.label}: ${c.before} → ${c.after}${c.detail ? `\n           ${c.detail}` : ''}`);
  }
  for (const s of report.sheets) {
    if (s.status !== 'OK') console.log(`  FALHA  Aba ${s.sheet}: ${s.detail || 'contagem divergente'}`);
  }
}

async function compareFiles(originalFile, generatedFile) {
  const z0 = await JSZip.loadAsync(read(originalFile));
  const z1 = await JSZip.loadAsync(read(generatedFile));
  const sheetPaths = Object.keys(z0.files).filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n));
  const before = await PA.inventory(z0, { detailSheets: sheetPaths });
  const after = await PA.inventory(z1, { detailSheets: sheetPaths });
  const edited = sheetPaths.filter((p) => after.parts.get(p) && before.parts.get(p).hash !== after.parts.get(p).hash);
  printInventory(`ORIGINAL ${path.basename(originalFile)}`, before);
  printInventory(`GERADA   ${path.basename(generatedFile)}`, after);
  const report = PA.compare(before, after, { editedSheets: edited, fileName: path.basename(generatedFile) });
  printReport(report);
  return report.ok;
}

async function processAll(relationFile, ldFiles) {
  const outDir = path.resolve('saida-diagnostico');
  fs.mkdirSync(outDir, { recursive: true });
  const relMeta = await V.tasks.open({ fileId: 'rel', name: path.basename(relationFile), bytes: read(relationFile), hash: 'rel', profile: 'relation' });
  const relIndex = await V.tasks.indexRelation({ fileId: 'rel', mapping: relMeta.mapping });

  const lds = [];
  for (const [i, file] of ldFiles.entries()) {
    const fileId = `ld-${i}`;
    const meta = await V.tasks.open({ fileId, name: path.basename(file), bytes: read(file), hash: fileId, profile: 'ld' });
    const enabled = (meta.mappings || [meta.mapping]).filter((m) => m.enabled !== false);
    const indexes = [];
    for (const mapping of enabled) indexes.push(await V.tasks.indexLd({ fileId, mapping }));
    lds.push({ fileId, file, meta, enabled, indexes });
    console.log(`LD ${path.basename(file)}: aba(s) ${enabled.map((m) => `${m.sheetName} (cabeçalho L${m.headerRow}, confiança ${m.confidence})`).join(', ')}`);
  }

  const files = new Map(lds.map((ld) => [ld.fileId, { id: ld.fileId, name: path.basename(ld.file), sheetName: ld.meta.mapping.sheetName }]));
  const analysis = V.analyzer.analyze(relIndex, V.indexer.buildGlobalIndex(lds.flatMap((ld) => ld.indexes)), files);

  let allOk = true;
  const reports = [];
  for (const ld of lds) {
    const plan = analysis.plans.get(ld.fileId) || [];
    const result = await V.tasks.apply({ fileId: ld.fileId, mapping: ld.meta.mapping, mappings: ld.enabled, plan, options: { verify: true } });
    if (result.packageIntegrity) {
      printReport(result.packageIntegrity);
      reports.push(result.packageIntegrity);
    }
    if (!result.ok) {
      allOk = false;
      console.log(`\n✗ ${path.basename(ld.file)}: ${result.error}`);
      continue;
    }
    fs.writeFileSync(path.join(outDir, result.outputName), result.bytes);
    console.log(`\n✓ ${result.outputName}: ${plan.length} documento(s) no plano · ${result.counters.authorizedCells} célula(s) gravada(s) ` +
      `(GRDT ${result.counters.grdtWrites}, data ${result.counters.dateWrites}, revisão ${result.counters.revisionWrites}, STATUS ${result.counters.statusWrites})`);
  }
  fs.writeFileSync(path.join(outDir, 'INTEGRIDADE_PACOTE.json'), JSON.stringify(reports, null, 2));
  console.log(`\nSaída: ${outDir}`);
  return allOk;
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('-h') || args.includes('--help')) usage();
  let ok = true;
  if (args[0] === '--comparar') {
    if (args.length !== 3) usage();
    ok = await compareFiles(args[1], args[2]);
  } else if (args[0] === '--relacao') {
    if (args.length < 3) usage();
    ok = await processAll(args[1], args.slice(2));
  } else {
    for (const file of args) {
      const zip = await JSZip.loadAsync(read(file));
      printInventory(path.basename(file), await PA.inventory(zip));
    }
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
