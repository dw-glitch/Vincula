/**
 * Teste de volume do Vincula.
 *
 * Meta declarada: 20.000+ documentos e 100 LDs processados em menos de 60
 * segundos em máquina corporativa moderna. Este script mede o caminho crítico
 * (leitura → indexação → análise → gravação → auditoria de integridade) em uma
 * única thread do Node; no navegador o trabalho é dividido entre os workers do
 * pool, então o tempo aqui é o limite superior pessimista.
 *
 *   node tests/bench.js [numeroDeLDs] [documentosPorLD]
 */
'use strict';

const { loadVincula } = require('./harness');
const { buildWorkbook, serial, STYLE } = require('./fixtures');

const { V, JSZip } = loadVincula();

const LD_COUNT = Number(process.argv[2] || 100);
const DOCS_PER_LD = Number(process.argv[3] || 200);
// Cada LD também traz uma aba de CV (currículos), atualizada na mesma passada.
const CVS_PER_LD = Math.max(5, Math.round(DOCS_PER_LD / 20));
const TOTAL_DOCS = LD_COUNT * (DOCS_PER_LD + CVS_PER_LD);

const BASE_SERIAL = serial(2026, 1, 1);

function documentCode(ldIndex, row) {
  return `LD${String(ldIndex).padStart(3, '0')}-DOC-${String(row).padStart(5, '0')}`;
}

function cvCode(ldIndex, row) {
  return `LD${String(ldIndex).padStart(3, '0')}-CV-${String(row).padStart(5, '0')}`;
}

function relationRows() {
  const rows = [
    [
      { text: 'DOCUMENTO', style: STYLE.HEADER },
      { text: 'GRDT', style: STYLE.HEADER },
      { text: 'DATA DA GERAÇÃO / POSTAGEM', style: STYLE.HEADER },
    ],
  ];
  for (let ld = 0; ld < LD_COUNT; ld++) {
    for (let doc = 1; doc <= DOCS_PER_LD; doc++) {
      const invalid = doc % 17 === 0; // ~6% das linhas sem data utilizável
      rows.push([
        { text: documentCode(ld, doc) },
        { text: `GR${900000 + ld * 1000 + doc}` },
        invalid ? { text: '-' } : { text: `0${(doc % 9) + 1}/08/2026 08:31:45` },
      ]);
    }
    for (let cv = 1; cv <= CVS_PER_LD; cv++) {
      rows.push([
        { text: cvCode(ld, cv) },
        { text: `GRCV${800000 + ld * 1000 + cv}` },
        { text: `1${(cv % 9) + 0}/08/2026 14:05:00` },
      ]);
    }
  }
  return rows;
}

function ldRows(ldIndex) {
  const rows = [
    [
      { text: 'Item', style: STYLE.HEADER },
      { text: 'Código do Documento', style: STYLE.HEADER },
      { text: 'eGRDT', style: STYLE.HEADER },
      { text: 'Data Efetiva de Emissão', style: STYLE.HEADER },
      { text: 'Observação', style: STYLE.HEADER },
    ],
  ];
  for (let doc = 1; doc <= DOCS_PER_LD; doc++) {
    rows.push([
      { number: doc },
      { text: documentCode(ldIndex, doc) },
      { text: `ANTIGO-${doc}` },
      { dateSerial: BASE_SERIAL, style: STYLE.DATE },
      { text: 'observação de controle' },
    ]);
  }
  return rows;
}

/** Aba de CV (currículos) da LD: mesma regra, coluna de documento própria. */
function cvRows(ldIndex) {
  const rows = [
    [
      { text: 'CV', style: STYLE.HEADER },
      { text: 'GRDT', style: STYLE.HEADER },
      { text: 'Data Efetiva de Emissão', style: STYLE.HEADER },
    ],
  ];
  for (let cv = 1; cv <= CVS_PER_LD; cv++) {
    rows.push([{ text: cvCode(ldIndex, cv) }, { text: `ANTIGO-CV-${cv}` }, { dateSerial: BASE_SERIAL, style: STYLE.DATE }]);
  }
  return rows;
}

function mark(label, start) {
  const ms = Number(process.hrtime.bigint() - start) / 1e6;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(0).padStart(7)} ms`);
  return ms;
}

async function main() {
  console.log(`\nVincula ${V.VERSION} — teste de volume`);
  console.log(
    `${LD_COUNT} LDs × (${DOCS_PER_LD} documentos + ${CVS_PER_LD} CVs em aba própria) = ${TOTAL_DOCS.toLocaleString('pt-BR')} documentos\n`
  );

  let start = process.hrtime.bigint();
  const relationBytes = await buildWorkbook(JSZip, [{ name: 'Relação', rows: relationRows(), options: {} }]);
  const ldFiles = [];
  for (let ld = 0; ld < LD_COUNT; ld++) {
    ldFiles.push({
      name: `LD-${String(ld).padStart(3, '0')}.xlsx`,
      bytes: await buildWorkbook(JSZip, [
        { name: 'Dados', rows: ldRows(ld), options: {} },
        { name: 'CV', rows: cvRows(ld), options: {} },
      ]),
    });
  }
  mark('Geração das fixtures', start);
  const corpusBytes = ldFiles.reduce((sum, f) => sum + f.bytes.length, relationBytes.length);
  console.log(`  ${'Tamanho do corpus'.padEnd(34)} ${(corpusBytes / 1048576).toFixed(1).padStart(7)} MB\n`);

  const totals = {};

  /* ---------------- Leitura ---------------- */
  start = process.hrtime.bigint();
  const relationMeta = await V.tasks.open({ fileId: 'rel', name: 'RELACAO.xlsx', bytes: relationBytes, hash: 'rel', profile: 'relation' });
  const ldMetas = [];
  for (let i = 0; i < ldFiles.length; i++) {
    ldMetas.push(await V.tasks.open({ fileId: `ld${i}`, name: ldFiles[i].name, bytes: ldFiles[i].bytes, hash: `h${i}`, profile: 'ld' }));
  }
  totals.leitura = mark('Leitura + amostra de cabeçalhos', start);

  /* ---------------- Indexação ---------------- */
  start = process.hrtime.bigint();
  const relationIndex = await V.tasks.indexRelation({ fileId: 'rel', mapping: relationMeta.mapping });
  const ldIndexes = [];
  for (let i = 0; i < ldFiles.length; i++) {
    // Uma indexação por aba mapeada: documentos e CV.
    for (const mapping of ldMetas[i].mappings) {
      ldIndexes.push(await V.tasks.indexLd({ fileId: `ld${i}`, mapping }));
    }
  }
  totals.indexacao = mark('Indexação (relação + abas das LDs)', start);

  /* ---------------- Cache ---------------- */
  start = process.hrtime.bigint();
  await V.tasks.indexRelation({ fileId: 'rel', mapping: relationMeta.mapping });
  for (let i = 0; i < ldFiles.length; i++) {
    for (const mapping of ldMetas[i].mappings) {
      await V.tasks.indexLd({ fileId: `ld${i}`, mapping });
    }
  }
  totals.cache = mark('Reindexação com cache quente', start);

  /* ---------------- Análise ---------------- */
  start = process.hrtime.bigint();
  const files = new Map(ldFiles.map((file, i) => [`ld${i}`, { id: `ld${i}`, name: file.name, sheetName: 'Dados' }]));
  const globalIndex = V.indexer.buildGlobalIndex(ldIndexes);
  const analysis = V.analyzer.analyze(relationIndex, globalIndex, files);
  totals.analise = mark('Análise (cruzamento O(1))', start);

  /* ---------------- Busca pontual ---------------- */
  start = process.hrtime.bigint();
  let hits = 0;
  for (let i = 0; i < 100000; i++) {
    const code = documentCode(i % LD_COUNT, (i % DOCS_PER_LD) + 1);
    if (globalIndex.byDocument.has(code)) hits++;
  }
  const lookupMs = mark('100.000 buscas no índice global', start);
  console.log(`  ${'  → média por busca'.padEnd(34)} ${((lookupMs / 100000) * 1000).toFixed(2).padStart(7)} µs  (${hits} acertos)\n`);

  /* ---------------- Gravação ---------------- */
  start = process.hrtime.bigint();
  let written = 0;
  let integrityOk = 0;
  for (let i = 0; i < ldFiles.length; i++) {
    const plan = analysis.plans.get(`ld${i}`) || [];
    const result = await V.tasks.apply({
      fileId: `ld${i}`,
      mapping: ldMetas[i].mapping,
      mappings: ldMetas[i].mappings,
      plan,
      options: { verify: true },
    });
    if (result.ok) {
      written += result.counters.authorizedCells;
      if (result.integrity.ok) integrityOk++;
    } else {
      console.error(`  ! falha em ${ldFiles[i].name}: ${result.error}`);
    }
  }
  totals.gravacao = mark('Gravação + auditoria + recompactação', start);

  /* ---------------- Relatório ---------------- */
  start = process.hrtime.bigint();
  const report = V.audit.buildReport({
    summary: { 'Versão do Vincula': V.VERSION },
    records: analysis.records,
    relation: {},
    duplicates: relationIndex.duplicates,
    missing: analysis.missing,
    invalidDates: analysis.invalidDates,
    outputs: [],
    occurrences: [],
    files: [],
    timings: {},
  });
  await V.audit.buildAuditWorkbook(report);
  V.audit.buildJsonLog(report);
  totals.relatorio = mark('Auditoria (XLSX + JSON)', start);

  const pipeline = totals.leitura + totals.indexacao + totals.analise + totals.gravacao + totals.relatorio;

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`  Documentos na relação      ${relationIndex.uniqueDocuments.toLocaleString('pt-BR')}`);
  console.log(`  Correspondências           ${analysis.stats.records.toLocaleString('pt-BR')}`);
  console.log(`  Alterações previstas       ${analysis.stats.willChange.toLocaleString('pt-BR')}`);
  console.log(`  Abas com alteração         ${analysis.stats.sheetsWithChanges.toLocaleString('pt-BR')}`);
  console.log(`  Células gravadas           ${written.toLocaleString('pt-BR')}`);
  console.log(`  Integridade aprovada       ${integrityOk}/${LD_COUNT} arquivos`);
  console.log(`  Ganho do cache             ${(totals.indexacao / Math.max(1, totals.cache)).toFixed(0)}×`);
  console.log(`  \x1b[1mPipeline completo          ${(pipeline / 1000).toFixed(1)} s\x1b[0m`);
  console.log(`  Vazão                      ${Math.round(TOTAL_DOCS / (pipeline / 1000)).toLocaleString('pt-BR')} documentos/s`);

  const heap = process.memoryUsage();
  console.log(`  Heap após execução         ${(heap.heapUsed / 1048576).toFixed(0)} MB`);

  const target = 60000;
  console.log(
    pipeline < target
      ? `\n\x1b[32m✓ Meta atendida: ${(pipeline / 1000).toFixed(1)}s < 60s (thread única, sem paralelismo)\x1b[0m\n`
      : `\n\x1b[31m✗ Acima da meta: ${(pipeline / 1000).toFixed(1)}s\x1b[0m\n`
  );
  if (pipeline >= target) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
