/**
 * Vincula — auditoria da execução.
 *
 * Produz dois artefatos complementares: uma planilha de conferência para o
 * usuário e um log JSON íntegro para arquivamento/automação. Ambos cobrem
 * 100% dos documentos processados, inclusive os que não geraram escrita —
 * rastreabilidade completa é requisito, não relatório de exceções.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { escapeXml, indexToColumn, sha256Hex } = V.util;
  const A = V.analyzer;

  const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const RNS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

  const STYLE_DEFAULT = 0;
  const STYLE_HEADER = 1;
  const STYLE_WRAP = 2;

  function sheetXml(rows, widths) {
    const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 1);
    const dimension = `A1:${indexToColumn(columnCount)}${Math.max(1, rows.length)}`;

    let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>`;
    xml += `<worksheet xmlns="${NS}"><dimension ref="${dimension}"/>`;
    xml += `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>`;
    xml += `<sheetFormatPr defaultRowHeight="15"/>`;

    if (widths && widths.length) {
      xml += '<cols>';
      widths.forEach((width, i) => {
        xml += `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`;
      });
      xml += '</cols>';
    }

    xml += '<sheetData>';
    rows.forEach((row, r) => {
      xml += `<row r="${r + 1}">`;
      row.forEach((value, c) => {
        const ref = `${indexToColumn(c + 1)}${r + 1}`;
        const style = r === 0 ? STYLE_HEADER : c === row.length - 1 ? STYLE_WRAP : STYLE_DEFAULT;
        if (typeof value === 'number' && Number.isFinite(value)) {
          xml += `<c r="${ref}" s="${style}"><v>${value}</v></c>`;
        } else {
          const text = value === null || value === undefined ? '' : String(value);
          if (!text) {
            xml += `<c r="${ref}" s="${style}"/>`;
          } else {
            xml += `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(text)}</t></is></c>`;
          }
        }
      });
      xml += '</row>';
    });
    xml += '</sheetData>';
    xml += `<autoFilter ref="${dimension}"/>`;
    xml += `<pageMargins left="0.5" right="0.5" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;
    return xml;
  }

  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="${NS}">
<fonts count="2"><font><sz val="11"/><color theme="1"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF0B2E59"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf></cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  /** Monta um XLSX mínimo, porém válido, a partir de abas [{name, rows}]. */
  async function buildWorkbook(sheets) {
    const JSZipRef = scope.JSZip;
    if (!JSZipRef) throw new Error('JSZip não está disponível.');
    const zip = new JSZipRef();

    const overrides = sheets
      .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
      .join('');

    zip.file(
      '[Content_Types].xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${overrides}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`
    );
    zip.file(
      '_rels/.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RNS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`
    );
    zip.file(
      'xl/workbook.xml',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="${NS}" xmlns:r="${RNS}"><sheets>${sheets
        .map((sheet, i) => `<sheet name="${escapeXml(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`
    );
    zip.file(
      'xl/_rels/workbook.xml.rels',
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="${RNS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join('')}<Relationship Id="rId${sheets.length + 1}" Type="${RNS}/styles" Target="styles.xml"/></Relationships>`
    );
    zip.file('xl/styles.xml', STYLES_XML);
    sheets.forEach((sheet, i) => zip.file(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(sheet.rows, sheet.widths)));

    return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 9 } });
  }

  function flagLabels(flags) {
    return (flags || []).map((flag) => A.FLAG_LABEL[flag] || flag).join('; ');
  }

  /**
   * Estrutura canônica da execução. Serve de fonte única tanto para a planilha
   * quanto para o JSON, evitando divergência entre os dois artefatos.
   */
  function buildReport(context) {
    const { summary, records, relation, duplicates, missing, invalidDates, outputs, occurrences, files, timings } = context;

    const detail = records.map((record) => ({
      documento: record.document,
      arquivo: record.fileName || '',
      aba: record.sheetName || '',
      linha: record.row || '',
      linhaRelacao: record.relationRow || '',
      grdtAnterior: record.beforeGrdt || '',
      grdtNova: record.afterGrdt || '',
      dataAnterior: record.beforeDate || '',
      dataNova: record.afterDate || '',
      revisaoAnterior: record.beforeRevisao || '',
      revisaoNova: record.afterRevisao || '',
      grdtAlterada: record.grdtWillChange ? 'SIM' : 'NÃO',
      dataAlterada: record.dateWillChange ? 'SIM' : 'NÃO',
      revisaoAlterada: record.revisionWillChange ? 'SIM' : 'NÃO',
      status: A.STATUS_LABEL[record.status] || record.status,
      statusCodigo: record.status,
      marcadores: flagLabels(record.flags),
      motivo: record.reason,
      timestamp: record.timestamp || summary.finishedAt,
    }));

    return { summary, detail, relation, duplicates, missing, invalidDates, outputs, occurrences, files, timings };
  }

  async function buildAuditWorkbook(report) {
    const summaryRows = [['Indicador', 'Valor'], ...Object.entries(report.summary).map(([k, v]) => [k, String(v)])];

    const detailRows = [
      [
        'Documento', 'Arquivo', 'Aba', 'Linha', 'Linha na Relação',
        'GRDT anterior', 'GRDT nova', 'Data anterior', 'Data nova', 'Revisão anterior', 'Revisão nova',
        'GRDT alterada', 'Data alterada', 'Revisão alterada', 'Status', 'Marcadores', 'Timestamp', 'Motivo',
      ],
      ...report.detail.map((d) => [
        d.documento, d.arquivo, d.aba, d.linha, d.linhaRelacao,
        d.grdtAnterior, d.grdtNova, d.dataAnterior, d.dataNova, d.revisaoAnterior, d.revisaoNova,
        d.grdtAlterada, d.dataAlterada, d.revisaoAlterada, d.status, d.marcadores, d.timestamp, d.motivo,
      ]),
    ];

    const changedRows = [
      ['Documento', 'Arquivo', 'Aba', 'Linha', 'GRDT anterior', 'GRDT nova', 'Data anterior', 'Data nova', 'Revisão anterior', 'Revisão nova', 'Timestamp'],
      ...report.detail
        .filter((d) => d.grdtAlterada === 'SIM' || d.dataAlterada === 'SIM' || d.revisaoAlterada === 'SIM')
        .map((d) => [d.documento, d.arquivo, d.aba, d.linha, d.grdtAnterior, d.grdtNova, d.dataAnterior, d.dataNova, d.revisaoAnterior, d.revisaoNova, d.timestamp]),
    ];

    const duplicateRows = [
      ['Documento', 'Ocorrências', 'Linha considerada', 'Há conflito de valores', 'Candidatos'],
      ...report.duplicates.map((d) => [
        d.document,
        d.count,
        d.selectedRow,
        d.conflict ? 'SIM' : 'NÃO',
        d.candidates.map((c) => `L${c.row}: ${c.grdt || '(vazio)'} | ${c.dateText || '(sem data)'}`).join(' || '),
      ]),
    ];

    const missingRows = [
      ['Documento', 'Linha na Relação', 'GRDT da relação', 'Data da relação', 'Status', 'Motivo'],
      ...report.missing.map((m) => [m.document, m.relationRow, m.afterGrdt, m.afterDate, 'NÃO ENCONTRADO', m.reason]),
    ];

    const invalidRows = [
      ['Documento', 'Arquivo', 'Linha na Relação', 'Valor de origem', 'Data preservada na LD', 'Motivo'],
      ...report.invalidDates.map((r) => [
        r.document,
        r.fileName,
        r.relationRow,
        r.sourceDateRaw || '(vazio)',
        r.beforeDate || '',
        'Data da postagem inválida — Data Efetiva de Emissão preservada.',
      ]),
    ];

    const occurrenceRows = [
      ['Arquivo', 'Aba', 'Célula', 'Documento', 'Tipo', 'Detalhe'],
      ...report.occurrences.map((o) => [o.file, o.sheet, o.ref || '', o.document || '', o.type, o.detail]),
    ];

    const outputRows = [
      ['Arquivo gerado', 'Origem', 'Abas atualizadas', 'Tamanho (bytes)', 'Células autorizadas', 'GRDT gravadas', 'Datas gravadas', 'Revisões gravadas', 'Integridade', 'SHA-256'],
      ...report.outputs.map((o) => [
        o.name,
        o.source,
        o.sheets || '',
        o.size,
        o.authorizedCells,
        o.grdtWrites,
        o.dateWrites,
        o.revisionWrites || 0,
        o.integrity,
        o.hash,
      ]),
    ];

    return buildWorkbook([
      { name: 'Resumo', rows: summaryRows, widths: [38, 60] },
      { name: 'Detalhamento', rows: detailRows, widths: [26, 26, 16, 8, 12, 18, 18, 14, 14, 14, 14, 12, 12, 14, 16, 26, 22, 70] },
      { name: 'Alterações', rows: changedRows, widths: [26, 26, 16, 8, 18, 18, 14, 14, 14, 14, 22] },
      { name: 'Duplicados', rows: duplicateRows, widths: [26, 12, 16, 18, 80] },
      { name: 'Não Encontrados', rows: missingRows, widths: [26, 14, 18, 14, 18, 60] },
      { name: 'Datas Inválidas', rows: invalidRows, widths: [26, 26, 14, 24, 20, 60] },
      { name: 'Ocorrências', rows: occurrenceRows, widths: [26, 16, 10, 26, 16, 80] },
      { name: 'Arquivos Gerados', rows: outputRows, widths: [40, 28, 26, 16, 18, 14, 14, 14, 14, 68] },
    ]);
  }

  function buildJsonLog(report) {
    return JSON.stringify(
      {
        aplicacao: V.APP_NAME,
        versao: V.VERSION,
        geradoEm: new Date().toISOString(),
        resumo: report.summary,
        tempos: report.timings,
        relacao: report.relation,
        arquivos: report.files,
        arquivosGerados: report.outputs,
        duplicados: report.duplicates,
        naoEncontrados: report.missing.map((m) => ({ documento: m.document, linhaRelacao: m.relationRow, motivo: m.reason })),
        datasInvalidas: report.invalidDates.map((r) => ({
          documento: r.document,
          arquivo: r.fileName,
          linhaRelacao: r.relationRow,
          valorOrigem: r.sourceDateRaw || '',
          motivo: 'Data da postagem inválida — Data Efetiva de Emissão preservada.',
        })),
        ocorrencias: report.occurrences,
        detalhamento: report.detail,
      },
      null,
      2
    );
  }

  V.audit = { buildWorkbook, buildReport, buildAuditWorkbook, buildJsonLog, sha256Hex };
})(typeof self !== 'undefined' ? self : this);
