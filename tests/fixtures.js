/**
 * Geradores de planilhas de teste.
 *
 * As fixtures são construídas com recursos que o Vincula precisa preservar:
 * sharedStrings, fórmulas, células mescladas, proteção de aba, validação de
 * dados, formatação condicional, autofiltro e uma segunda aba. Se qualquer um
 * deles for perdido na gravação, a auditoria de integridade acusa.
 */
'use strict';

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function indexToColumn(index) {
  let n = index;
  let out = '';
  while (n > 0) {
    n--;
    out = String.fromCharCode(65 + (n % 26)) + out;
    n = Math.floor(n / 26);
  }
  return out;
}

/** Data civil → serial do Excel (época 1899-12-30). */
function serial(year, month, day) {
  return Math.round((Date.UTC(year, month - 1, day) - Date.UTC(1899, 11, 30)) / 86400000);
}

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}">
<numFmts count="2"><numFmt numFmtId="164" formatCode="0.00&quot; kg&quot;"/><numFmt numFmtId="165" formatCode="dd/mm/yyyy hh:mm:ss"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="22" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

// DATETIME/DATETIME_CUSTOM reproduzem a LD real que motivou a correção: a
// coluna de data vem formatada com hora, então a data gravada à meia-noite
// aparecia como "01/09/2026 00:00:00".
const STYLE = { DEFAULT: 0, HEADER: 1, DATE: 2, TEXT: 3, CUSTOM: 4, DATETIME: 5, DATETIME_CUSTOM: 6 };

/**
 * Célula declarativa:
 *   {text}      → string via sharedStrings
 *   {inline}    → string inline
 *   {number}    → numérico
 *   {dateSerial}→ data real
 *   {formula}   → fórmula com resultado em cache
 */
function buildSheet(rows, options = {}) {
  const shared = options.shared;
  const maxCol = rows.reduce((max, row) => Math.max(max, row.length), 1);
  const dimension = `A1:${indexToColumn(maxCol)}${Math.max(rows.length, 1)}`;

  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
  xml += `<worksheet xmlns="${NS}" xmlns:r="${RNS}">`;
  xml += `<sheetPr><outlinePr summaryBelow="1" summaryRight="1"/></sheetPr>`;
  xml += `<dimension ref="${dimension}"/>`;
  xml += `<sheetViews><sheetView tabSelected="1" workbookViewId="0"><selection activeCell="A1" sqref="A1"/></sheetView></sheetViews>`;
  xml += `<sheetFormatPr defaultRowHeight="15"/>`;
  xml += `<cols><col min="1" max="${maxCol}" width="22" customWidth="1"/></cols>`;
  xml += '<sheetData>';

  rows.forEach((row, r) => {
    const rowNumber = r + 1;
    xml += `<row r="${rowNumber}" spans="1:${maxCol}">`;
    row.forEach((cell, c) => {
      if (cell === null || cell === undefined) return;
      const ref = `${indexToColumn(c + 1)}${rowNumber}`;
      const style = cell.style === undefined ? STYLE.DEFAULT : cell.style;
      const attrs = ` r="${ref}"${style ? ` s="${style}"` : ''}`;

      if (cell.formula !== undefined) {
        xml += `<c${attrs}><f>${escapeXml(cell.formula)}</f><v>${escapeXml(cell.cached ?? '')}</v></c>`;
      } else if (cell.dateSerial !== undefined) {
        xml += `<c${attrs}><v>${cell.dateSerial}</v></c>`;
      } else if (cell.number !== undefined) {
        xml += `<c${attrs}><v>${cell.number}</v></c>`;
      } else if (cell.inline !== undefined) {
        xml += `<c${attrs} t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell.inline)}</t></is></c>`;
      } else if (cell.text !== undefined) {
        xml += `<c${attrs} t="s"><v>${shared.index(cell.text)}</v></c>`;
      } else {
        xml += `<c${attrs}/>`;
      }
    });
    xml += '</row>';
  });

  xml += '</sheetData>';
  if (options.protection) {
    xml += `<sheetProtection sheet="1" objects="1" scenarios="1" selectLockedCells="1" selectUnlockedCells="1"/>`;
  }
  if (options.autoFilter) xml += `<autoFilter ref="${options.autoFilter}"/>`;
  if (options.merges && options.merges.length) {
    xml += `<mergeCells count="${options.merges.length}">`;
    for (const merge of options.merges) xml += `<mergeCell ref="${merge}"/>`;
    xml += '</mergeCells>';
  }
  if (options.conditional) {
    xml += `<conditionalFormatting sqref="${options.conditional}"><cfRule type="containsText" dxfId="0" priority="1" operator="containsText" text="URGENTE"><formula>NOT(ISERROR(SEARCH("URGENTE",A2)))</formula></cfRule></conditionalFormatting>`;
  }
  if (options.validation) {
    xml += `<dataValidations count="1"><dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="${options.validation}"><formula1>"SIM,NAO"</formula1></dataValidation></dataValidations>`;
  }
  xml += `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`;
  xml += '</worksheet>';
  return xml;
}

function createSharedStrings() {
  const list = [];
  const map = new Map();
  return {
    index(value) {
      const key = String(value);
      if (map.has(key)) return map.get(key);
      const at = list.length;
      map.set(key, at);
      list.push(key);
      return at;
    },
    xml() {
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="${NS}" count="${list.length}" uniqueCount="${list.length}">${list
        .map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`)
        .join('')}</sst>`;
    },
  };
}

/**
 * @param {object} JSZip
 * @param {Array<{name:string, rows:Array, options:object}>} sheets
 */
async function buildWorkbook(JSZip, sheets, extra = {}) {
  const zip = new JSZip();
  const shared = createSharedStrings();
  const rendered = sheets.map((sheet) => buildSheet(sheet.rows, { ...sheet.options, shared }));

  const overrides = sheets
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');

  zip.file(
    '[Content_Types].xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`
  );
  zip.file(
    '_rels/.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
  );
  zip.file(
    'xl/workbook.xml',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${RNS}">${
      extra.date1904 ? '<workbookPr date1904="1"/>' : ''
    }<sheets>${sheets
      .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets><definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'${sheets[0].name}'!$A$1:$F$2</definedName></definedNames></workbook>`
  );
  zip.file(
    'xl/_rels/workbook.xml.rels',
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${RNS}/styles" Target="styles.xml"/><Relationship Id="rId${
      sheets.length + 2
    }" Type="${RNS}/sharedStrings" Target="sharedStrings.xml"/></Relationships>`
  );
  zip.file('xl/styles.xml', STYLES_XML);
  rendered.forEach((xml, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, xml));
  zip.file('xl/sharedStrings.xml', shared.xml());
  // Parte auxiliar que precisa sobreviver intacta ao reempacotamento.
  zip.file('docProps/core.xml', `<?xml version="1.0"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">Fixture</dc:title></cp:coreProperties>`);

  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}

module.exports = { buildWorkbook, buildSheet, createSharedStrings, serial, STYLE, indexToColumn };
