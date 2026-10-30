'use strict';
const assert = require('node:assert/strict');
const { loadVincula } = require('./harness');
const { buildWorkbook, STYLE, serial } = require('./fixtures');
const { V, JSZip } = loadVincula();

async function readStatus(bytes, row, col) {
  const wb = await V.xlsx.open(bytes, 'verificacao.xlsx');
  const sheet = wb.sheets[0];
  const xml = await V.xlsx.readSheetXml(wb, sheet);
  const model = V.xlsx.scanSheet(wb, xml, { columns: [col] });
  return V.xlsx.cellDisplay(V.xlsx.getCell(model, row, col));
}

async function run() {
  const date = serial(2026, 8, 4);
  const relation = await buildWorkbook(JSZip, [{
    name: 'Relacao', options: {}, rows: [
      [{text:'Documento'}, {text:'GRDT'}, {text:'Data Efetiva de Emissão'}, {text:'Propósito'}],
      [{text:'DOC-A'}, {text:'GR-NEW'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}],
    ],
  }]);
  const ld = await buildWorkbook(JSZip, [{
    name: 'Documentos', options: {autoFilter:'A1:G8',validation:'G2:G8'}, rows: [
      [{text:'Código do Documento'}, {text:'GRDT'}, {text:'Data Efetiva de Emissão'},
       {text:'PROPÓSITO DE EMISSÃO'}, {text:'STATUS'}, {text:'STATUS SIGEM'}, {text:'Observação'}],
      [{text:'DOC-A'}, {text:'GR-OLD'}, {dateSerial:date,style:STYLE.DATE}, {text:'CANCELADO'}, {text:'EM EMISSÃO'}, {text:'Em análise'}, {text:'Preservar'}],
      [{text:'DOC-B'}, {text:'GR-B'}, {dateSerial:date,style:STYLE.DATE}, {text:'Emissão Inicial'}, {text:' em emissão '}, {text:'Pendente'}, {text:'Sem relação'}],
      [{text:'DOC-C'}, {text:'GR-C'}, {dateSerial:date,style:STYLE.DATE}, {text:'  cancelado  '}, {text:'EMITIDO'}, {text:'Em análise'}, {text:'Cancelamento local'}],
      [{text:'DOC-D'}, {text:'GR-D'}, {dateSerial:date,style:STYLE.DATE}, {inline:''}, {text:'EM EMISSÃO'}, {text:'Rascunho'}, {text:'Propósito vazio'}],
      [{text:'DOC-E'}, {text:'GR-E'}, {dateSerial:date,style:STYLE.DATE}, {text:'CANCELADO'}, {formula:'"EM EMISSÃO"',cached:'EM EMISSÃO'}, {text:'Pendente'}, {text:'Fórmula preservada'}],
      [{text:'DOC-AB'}, {text:'GR-AB'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'EMITIDO'}, {text:'Pendente'}, {text:'Não confundir códigos'}],
      [{inline:''}, {inline:''}, null, null, {text:'SEM ALTERAÇÃO'}, null, {text:'Linha sem código'}],
    ],
  }]);
  const relMeta = await V.tasks.open({fileId:'rel-local',name:'REL.xlsx',bytes:relation,hash:'rel-local',profile:'relation'});
  const ldMeta = await V.tasks.open({fileId:'ld-local',name:'LD.xlsx',bytes:ld,hash:'ld-local',profile:'ld'});
  assert.equal(ldMeta.mapping.purposeCol, 4);
  assert.equal(ldMeta.mapping.statusCol, 5);
  assert.equal(ldMeta.mapping.sigemStatusCol, 6);
  const relIndex = await V.tasks.indexRelation({fileId:'rel-local',mapping:relMeta.mapping});
  const ldIndex = await V.tasks.indexLd({fileId:'ld-local',mapping:ldMeta.mapping});
  const files = new Map([['ld-local',{id:'ld-local',name:'LD.xlsx',sheetName:'Documentos'}]]);
  const analysis = V.analyzer.analyze(relIndex,V.indexer.buildGlobalIndex([ldIndex]),files);
  const byDoc = (id) => analysis.records.find(r=>r.document===id);
  assert.equal(byDoc('DOC-A').afterStatus,'CANCELADO','propósito local prevalece sobre relação');
  assert.equal(byDoc('DOC-B').afterStatus,'EMITIDO','LD fora da relação é atualizada');
  assert.equal(byDoc('DOC-C').afterStatus,'CANCELADO','espaços e caixa são normalizados');
  assert.equal(byDoc('DOC-D').afterStatus,'EMITIDO','propósito local vazio não bloqueia documento preenchido');
  assert.equal(byDoc('DOC-AB'),undefined,'status já correto não produz alteração desnecessária');
  assert.equal(byDoc('DOC-E').afterStatus,'CANCELADO','fórmula protegida é tentada, não apagada');
  assert.equal(analysis.stats.statusWrites,5);
  const plan = analysis.plans.get('ld-local');
  const result = await V.tasks.apply({fileId:'ld-local',mapping:ldMeta.mapping,plan,options:{verify:true}});
  assert.equal(result.ok,true,result.error);
  assert.equal(result.integrity.ok,true);
  assert.equal(await readStatus(result.bytes,2,5),'CANCELADO');
  assert.equal(await readStatus(result.bytes,3,5),'EMITIDO');
  assert.equal(await readStatus(result.bytes,4,5),'CANCELADO');
  assert.equal(await readStatus(result.bytes,5,5),'EMITIDO');
  assert.equal(await readStatus(result.bytes,6,5),'EM EMISSÃO','fórmula deve preservar valor em cache');
  assert.equal(await readStatus(result.bytes,8,5),'SEM ALTERAÇÃO','linha sem código fica intacta');
  assert.equal(await readStatus(result.bytes,2,6),'Em análise','STATUS SIGEM não deve ser alterado');
  assert.equal(await readStatus(result.bytes,2,2),'GR-NEW','GRDT não sofre regressão');
  assert.equal(await readStatus(result.bytes,2,7),'Preservar','outras colunas intactas');
  assert.equal(result.counters.statusWrites,4,'fórmula de STATUS bloqueada com segurança');

  // Reimportação: todas as células graváveis já conferem. A fórmula permanece
  // bloqueada e por isso continua gerando uma pendência auditável.
  const secondMeta = await V.tasks.open({fileId:'ld-second',name:'LD_2.xlsx',bytes:result.bytes,hash:'ld-second',profile:'ld'});
  const secondIndex = await V.tasks.indexLd({fileId:'ld-second',mapping:secondMeta.mapping});
  const second = V.analyzer.analyze(relIndex,V.indexer.buildGlobalIndex([secondIndex]),
    new Map([['ld-second',{id:'ld-second',name:'LD_2.xlsx',sheetName:'Documentos'}]]));
  assert.equal(second.stats.statusWrites,1,'segunda execução só encontra a fórmula bloqueada');
  assert.equal(second.records.find(r=>r.document==='DOC-E').afterStatus,'CANCELADO');

  // Sem relação correspondente: lote grande ainda deve corrigir STATUS
  // individualmente, sem mudar GRDT ou outros campos.
  const bulkRows = [[{text:'Documento'},{text:'GRDT'},{text:'Data Efetiva de Emissão'},
    {text:'PROPOSITO DE EMISSAO'},{text:'STATUS'}]];
  for(let i=0;i<1200;i++) bulkRows.push([
    {text:'DOC-BULK-'+String(i).padStart(4,'0')}, {text:'GR-'+i},
    {dateSerial:date,style:STYLE.DATE}, {text:i%7===0?'CANCELADO':'CONSTRUÇÃO'}, {text:'EM EMISSÃO'},
  ]);
  const bulkBytes=await buildWorkbook(JSZip,[{name:'Documentos',rows:bulkRows,options:{}}]);
  const bulkMeta=await V.tasks.open({fileId:'bulk',name:'BULK.xlsx',bytes:bulkBytes,hash:'bulk',profile:'ld'});
  const bulkIndex=await V.tasks.indexLd({fileId:'bulk',mapping:bulkMeta.mapping});
  const bulkAnalysis=V.analyzer.analyze(relIndex,V.indexer.buildGlobalIndex([bulkIndex]),
    new Map([['bulk',{id:'bulk',name:'BULK.xlsx',sheetName:'Documentos'}]]));
  assert.equal(bulkAnalysis.stats.statusWrites,1200);
  const bulkResult=await V.tasks.apply({fileId:'bulk',mapping:bulkMeta.mapping,
    plan:bulkAnalysis.plans.get('bulk'),options:{verify:true}});
  assert.equal(bulkResult.ok,true,bulkResult.error);
  assert.equal(await readStatus(bulkResult.bytes,2,5),'CANCELADO');
  assert.equal(await readStatus(bulkResult.bytes,3,5),'EMITIDO');
  assert.equal(await readStatus(bulkResult.bytes,1201,5),'EMITIDO');

  // STATUS SIGEM e STATUS da LD são dois alvos independentes.
  const conferencePlan=[{recordId:999,document:'DOC-A',sheetPath:ldMeta.mapping.sheetPath,
    sheetName:'Documentos',row:2,grdt:null,dateIso:null,revision:null,status:'CANCELADO',sigemStatus:'EMITIDO'}];
  const conferenceResult=await V.tasks.apply({
    fileId:'ld-local',mapping:ldMeta.mapping,plan:conferencePlan,options:{verify:true}
  });
  assert.equal(conferenceResult.ok,true,conferenceResult.error);
  assert.equal(await readStatus(conferenceResult.bytes,2,5),'CANCELADO');
  assert.equal(await readStatus(conferenceResult.bytes,2,6),'EMITIDO');

  // Regressão: não emitir indiscriminadamente as linhas sem GRDT.
  const conditionalRelation = await buildWorkbook(JSZip, [{
    name: 'Relacao', rows: [
      [{text:'Documento'}, {text:'GRDT'}, {text:'Data Efetiva de Emissão'}, {text:'Propósito'}],
      [{text:'DOC-NOVO'}, {text:'GRDT-NOVA'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}],
      [{text:'DOC-SEM-GRDT'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}],
    ],
  }]);
  const conditionalLd = await buildWorkbook(JSZip, [{
    name: 'Documentos', rows: [
      [{text:'Documento'}, {text:'GRDT'}, {text:'Data Efetiva de Emissão'},
       {text:'PROPÓSITO DE EMISSÃO'}, {text:'STATUS'}, {text:'STATUS SIGEM'}],
      [{text:'DOC-VAZIO'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'EM EMISSÃO'}, {text:'Pendente'}],
      [{text:'DOC-SEM-GRDT'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'PENDENTE'}, {text:'Pendente'}],
      [{text:'DOC-NOVO'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'PENDENTE'}, {text:'Pendente'}],
      [{text:'DOC-EXISTENTE'}, {text:'GRDT-ANTIGA'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'PENDENTE'}, {text:'Pendente'}],
      [{text:'DOC-CANCELADO'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'  cancelado  '}, {text:'PENDENTE'}, {text:'Pendente'}],
      [{text:'DOC-PLACEHOLDER'}, {text:'-'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'EM EMISSÃO'}, {text:'Pendente'}],
      [{text:'DOC-NAO-EXISTENTE'}, {text:'N/A'}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'EM EMISSÃO'}, {text:'Pendente'}],
      [{text:'DOC-EMITIDO'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'CONSTRUÇÃO'}, {text:'EMITIDO'}, {text:'Pendente'}],
      [{text:'DOC-SEM-PROPOSITO'}, {text:'GRDT-LOCAL'}, {dateSerial:date,style:STYLE.DATE}, {inline:''}, {text:'PENDENTE'}, {text:'Pendente'}],
    ],
  }]);
  const conditionalRelMeta = await V.tasks.open({
    fileId:'conditional-rel',name:'COND_REL.xlsx',bytes:conditionalRelation,hash:'conditional-rel',profile:'relation',
  });
  const conditionalMeta = await V.tasks.open({
    fileId:'conditional-ld',name:'COND_LD.xlsx',bytes:conditionalLd,hash:'conditional-ld',profile:'ld',
  });
  const conditionalIndex = await V.tasks.indexRelation({fileId:'conditional-rel',mapping:conditionalRelMeta.mapping});
  const conditionalLdIndex = await V.tasks.indexLd({fileId:'conditional-ld',mapping:conditionalMeta.mapping});
  const conditionalFiles = new Map([['conditional-ld',{
    id:'conditional-ld',name:'COND_LD.xlsx',sheetName:'Documentos',
  }]]);
  const conditionalAnalysis = V.analyzer.analyze(
    conditionalIndex,V.indexer.buildGlobalIndex([conditionalLdIndex]),conditionalFiles
  );
  const conditionalByDoc = (id) => conditionalAnalysis.records.find(r=>r.document===id);
  assert.equal(V.analyzer.statusFromLdPurpose('CONSTRUÇÃO',false),'','propósito sozinho não emite');
  assert.equal(V.analyzer.statusFromLdPurpose('CONSTRUÇÃO',true),'EMITIDO','GRDT habilita emissão');
  assert.equal(V.analyzer.statusFromLdPurpose(' cancelado ',false),'CANCELADO','cancelamento prevalece');
  assert.equal(conditionalByDoc('DOC-VAZIO'),undefined,'sem relação e sem GRDT preserva STATUS');
  assert.equal(conditionalByDoc('DOC-SEM-GRDT').statusWillChange,false,'relação com GRDT vazia não altera STATUS');
  assert.equal(conditionalByDoc('DOC-SEM-GRDT').afterStatus,'PENDENTE','relação sem GRDT mantém o STATUS existente');
  assert.equal(conditionalByDoc('DOC-NOVO').afterStatus,'EMITIDO','GRDT a preencher emite');
  assert.equal(conditionalByDoc('DOC-NOVO').grdtWillChange,true,'GRDT nova será gravada');
  assert.equal(conditionalByDoc('DOC-EXISTENTE').afterStatus,'EMITIDO','GRDT pré-existente emite sem relação');
  assert.equal(conditionalByDoc('DOC-CANCELADO').afterStatus,'CANCELADO','CANCELADO local mesmo sem GRDT');
  assert.equal(conditionalByDoc('DOC-PLACEHOLDER'),undefined,'hífen não é GRDT');
  assert.equal(conditionalByDoc('DOC-NAO-EXISTENTE'),undefined,'N/A não é GRDT');
  assert.equal(conditionalByDoc('DOC-EMITIDO'),undefined,'não modifica STATUS preexistente sem GRDT');
  assert.equal(conditionalByDoc('DOC-SEM-PROPOSITO').afterStatus,'EMITIDO','GRDT local emite mesmo sem propósito');
  assert.equal(conditionalAnalysis.stats.statusWrites,4,'exatamente quatro STATUS merecem atualização');
  assert.equal(conditionalAnalysis.stats.grdtWrites,1,'somente a GRDT nova é preenchida');
  const conditionalResult = await V.tasks.apply({
    fileId:'conditional-ld',mapping:conditionalMeta.mapping,
    plan:conditionalAnalysis.plans.get('conditional-ld'),options:{verify:true},
  });
  assert.equal(conditionalResult.ok,true,conditionalResult.error);
  assert.equal(conditionalResult.integrity.ok,true);
  for (const [row, expected] of [
    [2,'EM EMISSÃO'],[3,'PENDENTE'],[4,'EMITIDO'],[5,'EMITIDO'],
    [6,'CANCELADO'],[7,'EM EMISSÃO'],[8,'EM EMISSÃO'],[9,'EMITIDO'],[10,'EMITIDO'],
  ]) assert.equal(await readStatus(conditionalResult.bytes,row,5),expected,'STATUS da linha '+row);
  assert.equal(await readStatus(conditionalResult.bytes,4,2),'GRDT-NOVA','GRDT nova e status emitido no mesmo arquivo');
  assert.equal(await readStatus(conditionalResult.bytes,2,6),'Pendente','STATUS SIGEM independente da LD');

  // Sem coluna de propósito: GRDT preenchida ainda é condição suficiente.
  const withoutPurpose = await buildWorkbook(JSZip,[{
    name:'Documentos',rows:[
      [{text:'Documento'}, {text:'GRDT'}, {text:'Data Efetiva de Emissão'}, {text:'STATUS'}],
      [{text:'DOC-SEM-COL-P'}, {text:'GRDT-123'}, {dateSerial:date,style:STYLE.DATE}, {text:'PENDENTE'}],
      [{text:'DOC-SEM-COL-P2'}, {inline:''}, {dateSerial:date,style:STYLE.DATE}, {text:'PENDENTE'}],
    ],
  }]);
  const noPurposeMeta = await V.tasks.open({
    fileId:'no-purpose',name:'SEM_PROPOSITO.xlsx',bytes:withoutPurpose,hash:'no-purpose',profile:'ld',
  });
  assert.equal(noPurposeMeta.mapping.purposeCol,null,'nenhuma coluna de propósito inventada');
  const noPurposeIndex = await V.tasks.indexLd({fileId:'no-purpose',mapping:noPurposeMeta.mapping});
  const noPurposeAnalysis = V.analyzer.analyze(
    conditionalIndex,V.indexer.buildGlobalIndex([noPurposeIndex]),
    new Map([['no-purpose',{id:'no-purpose',name:'SEM_PROPOSITO.xlsx',sheetName:'Documentos'}]])
  );
  assert.equal(noPurposeAnalysis.stats.statusWrites,1,'GRDT local basta, sem coluna de propósito');
  assert.equal(noPurposeAnalysis.records.find(r=>r.document==='DOC-SEM-COL-P')?.afterStatus,'EMITIDO');
  const noPurposeResult = await V.tasks.apply({
    fileId:'no-purpose',mapping:noPurposeMeta.mapping,
    plan:noPurposeAnalysis.plans.get('no-purpose'),options:{verify:true},
  });
  assert.equal(noPurposeResult.ok,true,noPurposeResult.error);
  assert.equal(await readStatus(noPurposeResult.bytes,2,4),'EMITIDO');
  assert.equal(await readStatus(noPurposeResult.bytes,3,4),'PENDENTE');


  // Se uma fórmula impedir a nova GRDT, EMITIDO não pode ser gravado
  // antecipadamente. Com GRDT já existente, o STATUS continua independente.
  const blockedRelation = await buildWorkbook(JSZip,[{
    name:'Relacao',rows:[
      [{text:'Documento'},{text:'GRDT'},{text:'Data Efetiva de Emissão'},{text:'Propósito'}],
      [{text:'DOC-GRDT-BLOQUEADA'},{text:'GR-NEW'},{dateSerial:date,style:STYLE.DATE},{text:'CONSTRUÇÃO'}],
      [{text:'DOC-GRDT-EXISTENTE'},{text:'GR-NEW2'},{dateSerial:date,style:STYLE.DATE},{text:'CONSTRUÇÃO'}],
    ],
  }]);
  const blockedLd = await buildWorkbook(JSZip,[{
    name:'Documentos',rows:[
      [{text:'Documento'},{text:'GRDT'},{text:'Data Efetiva de Emissão'},
       {text:'PROPÓSITO DE EMISSÃO'},{text:'STATUS'}],
      [{text:'DOC-GRDT-BLOQUEADA'},{formula:'""',cached:''},{dateSerial:date,style:STYLE.DATE},
       {text:'CONSTRUÇÃO'},{text:'PENDENTE'}],
      [{text:'DOC-GRDT-EXISTENTE'},{formula:'CONCATENATE("GR-","OLD")',cached:'GR-OLD'},
       {dateSerial:date,style:STYLE.DATE},{text:'CONSTRUÇÃO'},{text:'PENDENTE'}],
      [{text:'DOC-CANCELADO-SEM-GRDT'},{inline:''},{dateSerial:date,style:STYLE.DATE},
       {text:'CANCELADO'},{text:'PENDENTE'}],
    ],
  }]);
  const blockedRelMeta = await V.tasks.open({
    fileId:'blocked-rel',name:'BLOCKED_REL.xlsx',bytes:blockedRelation,hash:'blocked-rel',profile:'relation',
  });
  const blockedLdMeta = await V.tasks.open({
    fileId:'blocked-ld',name:'BLOCKED_LD.xlsx',bytes:blockedLd,hash:'blocked-ld',profile:'ld',
  });
  const blockedRelIndex = await V.tasks.indexRelation({fileId:'blocked-rel',mapping:blockedRelMeta.mapping});
  const blockedLdIndex = await V.tasks.indexLd({fileId:'blocked-ld',mapping:blockedLdMeta.mapping});
  const blockedAnalysis = V.analyzer.analyze(
    blockedRelIndex,V.indexer.buildGlobalIndex([blockedLdIndex]),
    new Map([['blocked-ld',{id:'blocked-ld',name:'BLOCKED_LD.xlsx',sheetName:'Documentos'}]])
  );
  const blockedPlan = blockedAnalysis.plans.get('blocked-ld');
  const blockedFirst = blockedPlan.find(p=>p.document==='DOC-GRDT-BLOQUEADA');
  const blockedSecond = blockedPlan.find(p=>p.document==='DOC-GRDT-EXISTENTE');
  assert.equal(blockedFirst.statusRequiresGrdtWrite,true,'novo EMITIDO depende da GRDT gravada');
  assert.equal(blockedSecond.statusRequiresGrdtWrite,false,'GRDT previamente preenchida dispensa a nova escrita');
  const blockedResult = await V.tasks.apply({
    fileId:'blocked-ld',mapping:blockedLdMeta.mapping,plan:blockedPlan,options:{verify:true},
  });
  assert.equal(blockedResult.ok,true,blockedResult.error);
  assert.equal(blockedResult.integrity.ok,true);
  assert.equal(await readStatus(blockedResult.bytes,2,5),'PENDENTE','não marcar EMITIDO com GRDT nova bloqueada');
  assert.equal(await readStatus(blockedResult.bytes,3,5),'EMITIDO','GRDT existente permite STATUS emitido');
  assert.equal(await readStatus(blockedResult.bytes,4,5),'CANCELADO','cancelamento sem GRDT permanece permitido');
  assert.equal(blockedResult.counters.grdtWrites,0,'fórmulas de GRDT foram preservadas');
  assert.equal(blockedResult.counters.statusWrites,2,'somente STATUS de linhas elegíveis foram gravados');
  assert.ok(blockedResult.occurrences.some(o=>
    o.type==='DEPENDENCIA_GRDT' && o.document==='DOC-GRDT-BLOQUEADA'
  ),'bloqueio da atualização do STATUS registrado em auditoria');

  console.log('STATUS LD: regras, independência SIGEM, Excel, integridade e lote de 1200 aprovados.');
  V.tasks.releaseAll();
}
run().catch(err=>{console.error(err);process.exitCode=1;});
