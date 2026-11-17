/**
 * Fixture de LD "como o Excel salva": vínculo externo com a planilha
 * corporativa, PROCX/PROCV/SOMASES/CONT.SES, fórmulas compartilhadas e de
 * matriz, nomes definidos, tabela estruturada, comentários, hiperlinks,
 * calcChain, painel congelado, configuração de impressão e fórmulas que já
 * chegam com #REF! (como a C1O-004).
 *
 * Tudo aqui precisa sair do Vincula exatamente como entrou, exceto as
 * células de GRDT, data, revisão e STATUS autorizadas pelo plano.
 */
'use strict';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PR = 'http://schemas.openxmlformats.org/package/2006/relationships';
const CT = 'application/vnd.openxmlformats-officedocument.spreadsheetml';

const CORPORATE_TARGET =
  'file:///Z:\\GRUPOS-HDD\\Qualidade\\Controle%20Documental\\Controle%20de%20Solicita%C3%A7%C3%B5es%20de%20Documentos_02.xlsx';
const RELATIVE_TARGET = '../Apoio/Tabela%20de%20Prazos.xlsx';

const SHARED = [
  'DOCUMENTO', 'TÍTULO', 'REV', 'PROPÓSITO DE EMISSÃO', 'GRDT', 'DATA EFETIVA DE EMISSÃO', 'STATUS',
  'SOLICITAÇÃO', 'PRAZO', 'QTD', 'LEGADO',
  'DOC-001', 'DOC-002', 'DOC-003', 'DOC-004', 'Memorial', 'Planta', 'Lista', 'Desenho',
  'EMISSÃO INICIAL', 'CANCELADO', 'EM EMISSÃO', 'GR-OLD-1', 'SOL-10', 'SOL-20', 'SOL-30', 'SOL-40',
  'LISTA DE DOCUMENTOS — C1O',
];
const S = (text) => SHARED.indexOf(text);

function sst() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<sst xmlns="${NS}" count="${SHARED.length}" uniqueCount="${SHARED.length}">${SHARED.map(
    (t) => `<si><t>${t}</t></si>`
  ).join('')}</sst>`;
}

/** Aba principal da LD: cabeçalho na linha 3, dados nas linhas 4–7. */
function ldSheet() {
  const s = (ref, text, style = 0) => `<c r="${ref}" s="${style}" t="s"><v>${S(text)}</v></c>`;
  const n = (ref, value, style = 0) => `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
  const rows = [];
  rows.push(`<row r="1" spans="1:11" ht="24" customHeight="1" x14ac:dyDescent="0.25">${s('A1', 'LISTA DE DOCUMENTOS — C1O', 1)}</row>`);
  rows.push(`<row r="3" spans="1:11" x14ac:dyDescent="0.25">${['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K']
    .map((col, i) => s(`${col}3`, SHARED[i], 1))
    .join('')}</row>`);
  const data = [
    // doc, título, rev, propósito, grdt, data, status
    ['DOC-001', 'Memorial', '0', 'EMISSÃO INICIAL', null, null, 'EM EMISSÃO', 'SOL-10'],
    ['DOC-002', 'Planta', 'A', 'CANCELADO', 'GR-OLD-1', 46238, 'EM EMISSÃO', 'SOL-20'],
    ['DOC-003', 'Lista', 'B', 'EMISSÃO INICIAL', null, null, 'EM EMISSÃO', 'SOL-30'],
    ['DOC-004', 'Desenho', '0', 'EMISSÃO INICIAL', null, null, 'EM EMISSÃO', 'SOL-40'],
  ];
  data.forEach((d, i) => {
    const r = 4 + i;
    let cells = s(`A${r}`, d[0]) + s(`B${r}`, d[1]);
    cells += /^\d+$/.test(d[2]) ? n(`C${r}`, d[2]) : `<c r="C${r}" t="str"><v>${d[2]}</v></c>`;
    cells += s(`D${r}`, d[3]);
    cells += d[4] ? s(`E${r}`, d[4]) : `<c r="E${r}" s="0"/>`;
    cells += d[5] ? n(`F${r}`, d[5], 2) : `<c r="F${r}" s="2"/>`;
    cells += s(`G${r}`, d[6]);
    // H: PROCX na planilha corporativa (vínculo externo [1]).
    cells += `<c r="H${r}" t="str"><f>_xlfn.XLOOKUP(A${r},[1]Solicitações!$A:$A,[1]Solicitações!$C:$C,"")</f><v>${d[7]}</v></c>`;
    // I: PROCV compartilhada no vínculo relativo [2].
    cells += i === 0
      ? `<c r="I${r}"><f t="shared" ref="I4:I7" si="0">VLOOKUP(A4,[2]Prazos!$A$1:$B$500,2,FALSE)</f><v>${10 + i}</v></c>`
      : `<c r="I${r}"><f t="shared" si="0"/><v>${10 + i}</v></c>`;
    // J: CONT.SES interno.
    cells += `<c r="J${r}"><f>COUNTIFS($G$4:$G$7,G${r},$D$4:$D$7,D${r})</f><v>1</v></c>`;
    // K: fórmula que já chega quebrada (cenário C1O-004).
    cells += `<c r="K${r}" t="e"><f>#REF!+[1]Solicitações!#REF!</f><v>#REF!</v></c>`;
    rows.push(`<row r="${r}" spans="1:11" x14ac:dyDescent="0.25">${cells}</row>`);
  });
  // Linha 9: SOMASES e matriz legada.
  rows.push(`<row r="9" spans="1:11" x14ac:dyDescent="0.25"><c r="I9"><f>SUMIFS(I4:I7,D4:D7,"EMISSÃO INICIAL")</f><v>35</v></c><c r="J9"><f t="array" ref="J9">SUM(IF(G4:G7="EMITIDO",1,0))</f><v>0</v></c></row>`);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${NS}" xmlns:r="${RNS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14ac xr xr2 xr3" xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac" xmlns:xr="http://schemas.microsoft.com/office/spreadsheetml/2014/revision" xr:uid="{00000000-0001-0000-0000-000000000000}"><sheetPr><pageSetUpPr fitToPage="1"/></sheetPr><dimension ref="A1:K9"/><sheetViews><sheetView tabSelected="1" zoomScale="85" workbookViewId="0"><pane ySplit="3" topLeftCell="A4" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A4" sqref="A4"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15" x14ac:dyDescent="0.25"/><cols><col min="1" max="1" width="22.7109375" customWidth="1"/><col min="8" max="8" width="18" customWidth="1"/></cols><sheetData>${rows.join(
    ''
  )}</sheetData><autoFilter ref="A3:K7"/><mergeCells count="1"><mergeCell ref="A1:K1"/></mergeCells><conditionalFormatting sqref="G4:G7"><cfRule type="cellIs" dxfId="0" priority="1" operator="equal"><formula>"CANCELADO"</formula></cfRule></conditionalFormatting><dataValidations count="1"><dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="D4:D7"><formula1>"EMISSÃO INICIAL,CANCELADO"</formula1></dataValidation></dataValidations><hyperlinks><hyperlink ref="A4" r:id="rId1"/></hyperlinks><pageMargins left="0.511811024" right="0.511811024" top="0.787401575" bottom="0.787401575" header="0.31496062" footer="0.31496062"/><pageSetup paperSize="9" scale="62" orientation="landscape" r:id="rId2"/><legacyDrawing r:id="rId3"/></worksheet>`;
}

function supportSheet() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<worksheet xmlns="${NS}" xmlns:r="${RNS}"><dimension ref="A1:B3"/><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Status</t></is></c><c r="B1" t="inlineStr"><is><t>Qtd</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>EMITIDO</t></is></c><c r="B2"><f>COUNTIF(LD!$G:$G,Tabela1[[#This Row],[Status]])</f><v>0</v></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>CANCELADO</t></is></c><c r="B3"><f>COUNTIF(LD!$G:$G,Tabela1[[#This Row],[Status]])</f><v>0</v></c></row></sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/><tableParts count="1"><tablePart r:id="rId1"/></tableParts></worksheet>`;
}

function externalLink(sheetName, cells) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<externalLink xmlns="${NS}" xmlns:r="${RNS}" xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" mc:Ignorable="x14"><externalBook r:id="rId1"><sheetNames><sheetName val="${sheetName}"/></sheetNames><sheetDataSet><sheetData sheetId="0">${cells}</sheetData></sheetDataSet></externalBook></externalLink>`;
}

/**
 * @param {object} JSZip
 * @param {{relativeOnly?:boolean}} [options]
 */
async function buildExternalLd(JSZip) {
  const zip = new JSZip();
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="bin" ContentType="${CT}.printerSettings"/><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="vml" ContentType="application/vnd.openxmlformats-officedocument.vmlDrawing"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${CT}.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="${CT}.worksheet+xml"/><Override PartName="/xl/externalLinks/externalLink1.xml" ContentType="${CT}.externalLink+xml"/><Override PartName="/xl/externalLinks/externalLink2.xml" ContentType="${CT}.externalLink+xml"/><Override PartName="/xl/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/><Override PartName="/xl/styles.xml" ContentType="${CT}.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="${CT}.sharedStrings+xml"/><Override PartName="/xl/tables/table1.xml" ContentType="${CT}.table+xml"/><Override PartName="/xl/comments1.xml" ContentType="${CT}.comments+xml"/><Override PartName="/xl/calcChain.xml" ContentType="${CT}.calcChain+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId3" Type="${RNS}/extended-properties" Target="docProps/app.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    'docProps/core.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:creator>Qualidade</dc:creator></cp:coreProperties>`,
    'docProps/app.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Microsoft Excel</Application></Properties>`,
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<workbook xmlns="${NS}" xmlns:r="${RNS}"><fileVersion appName="xl" lastEdited="7" lowestEdited="7" rupBuild="27425"/><workbookPr defaultThemeVersion="166925"/><bookViews><workbookView xWindow="-120" yWindow="-120" windowWidth="29040" windowHeight="15840"/></bookViews><sheets><sheet name="LD" sheetId="1" r:id="rId1"/><sheet name="Apoio" sheetId="2" r:id="rId2"/></sheets><externalReferences><externalReference r:id="rId3"/><externalReference r:id="rId4"/></externalReferences><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">LD!$A$3:$K$7</definedName><definedName name="_xlnm.Print_Area" localSheetId="0">LD!$A$1:$K$9</definedName><definedName name="BASE_SOLICITACOES">[1]Solicitações!$A:$C</definedName><definedName name="NOME_QUEBRADO">#REF!</definedName></definedNames><calcPr calcId="191029"/></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId8" Type="${RNS}/calcChain" Target="calcChain.xml"/><Relationship Id="rId3" Type="${RNS}/externalLink" Target="externalLinks/externalLink1.xml"/><Relationship Id="rId7" Type="${RNS}/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId2" Type="${RNS}/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId1" Type="${RNS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId6" Type="${RNS}/styles" Target="styles.xml"/><Relationship Id="rId5" Type="${RNS}/theme" Target="theme/theme1.xml"/><Relationship Id="rId4" Type="${RNS}/externalLink" Target="externalLinks/externalLink2.xml"/></Relationships>`,
    'xl/externalLinks/externalLink1.xml': externalLink(
      'Solicitações',
      '<row r="1"><cell r="A1" t="s"><v>DOC-001</v></cell><cell r="C1" t="s"><v>SOL-10</v></cell></row>'
    ),
    'xl/externalLinks/_rels/externalLink1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${RNS}/externalLinkPath" Target="${CORPORATE_TARGET}" TargetMode="External"/></Relationships>`,
    'xl/externalLinks/externalLink2.xml': externalLink('Prazos', '<row r="1"><cell r="B1"><v>10</v></cell></row>'),
    'xl/externalLinks/_rels/externalLink2.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${RNS}/externalLinkPath" Target="${RELATIVE_TARGET}" TargetMode="External"/></Relationships>`,
    'xl/theme/theme1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme"><a:themeElements/></a:theme>`,
    'xl/styles.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<styleSheet xmlns="${NS}"><numFmts count="1"><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="1"><dxf><font><color rgb="FFFF0000"/></font></dxf></dxfs></styleSheet>`,
    'xl/sharedStrings.xml': sst(),
    'xl/worksheets/sheet1.xml': ldSheet(),
    'xl/worksheets/_rels/sheet1.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId3" Type="${RNS}/vmlDrawing" Target="../drawings/vmlDrawing1.vml"/><Relationship Id="rId2" Type="${RNS}/printerSettings" Target="../printerSettings/printerSettings1.bin"/><Relationship Id="rId1" Type="${RNS}/hyperlink" Target="file:///Z:\\GRUPOS-HDD\\Qualidade\\Docs\\DOC-001.pdf" TargetMode="External"/><Relationship Id="rId4" Type="${RNS}/comments" Target="../comments1.xml"/></Relationships>`,
    'xl/worksheets/sheet2.xml': supportSheet(),
    'xl/worksheets/_rels/sheet2.xml.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="${PR}"><Relationship Id="rId1" Type="${RNS}/table" Target="../tables/table1.xml"/></Relationships>`,
    'xl/tables/table1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<table xmlns="${NS}" id="1" name="Tabela1" displayName="Tabela1" ref="A1:B3" totalsRowShown="0"><autoFilter ref="A1:B3"/><tableColumns count="2"><tableColumn id="1" name="Status"/><tableColumn id="2" name="Qtd" dataDxfId="0"><calculatedColumnFormula>COUNTIF(LD!$G:$G,Tabela1[[#This Row],[Status]])</calculatedColumnFormula></tableColumn></tableColumns><tableStyleInfo name="TableStyleMedium2" showFirstColumn="0" showLastColumn="0" showRowStripes="1" showColumnStripes="0"/></table>`,
    'xl/comments1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<comments xmlns="${NS}"><authors><author>Qualidade</author></authors><commentList><comment ref="H3" authorId="0"><text><t>PROCX na planilha corporativa</t></text></comment></commentList></comments>`,
    'xl/drawings/vmlDrawing1.vml': '<xml xmlns:v="urn:schemas-microsoft-com:vml"><v:shape id="_x0000_s1025"/></xml>',
    'xl/calcChain.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<calcChain xmlns="${NS}"><c r="H4" i="1"/><c r="I4"/><c r="J4"/><c r="K4"/><c r="I9"/><c r="J9" a="1"/><c r="B2" i="2"/></calcChain>`,
  };
  for (const [path, content] of Object.entries(files)) zip.file(path, content, { createFolders: false });
  zip.file('xl/printerSettings/printerSettings1.bin', new Uint8Array([0, 1, 2, 3, 254, 255]), { createFolders: false });
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

module.exports = { buildExternalLd, CORPORATE_TARGET, RELATIVE_TARGET };
