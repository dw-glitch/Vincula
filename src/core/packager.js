/**
 * Vincula — empacotamento final.
 *
 * Prioridades, nesta ordem: integridade dos arquivos, entrega rápida e tamanho
 * aceitável. XLSX/XLSM já são ZIPs: ficam em STORE no pacote externo para não
 * consumir CPU recomprimindo dados que já estão comprimidos.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});

  const MANIFEST_NAME = 'MANIFESTO.txt';

  function buildManifest(summary, outputs) {
    const lines = [
      `${V.APP_NAME} ${V.VERSION} — pacote de atualização de LD`,
      '',
      ...Object.entries(summary).map(([key, value]) => `${key}: ${value}`),
      '',
      'Arquivos incluídos (SHA-256):',
      ...outputs.map((o) => `  ${o.name}  ${o.hash || '—'}`),
      '',
      'Verificação: o hash de cada arquivo pode ser conferido com',
      '  certutil -hashfile "<arquivo>" SHA256      (Windows)',
      '  shasum -a 256 "<arquivo>"                  (macOS/Linux)',
    ];
    return lines.join('\r\n');
  }

  /**
   * @param {Array<{name:string, bytes:Uint8Array, hash?:string}>} outputs
   * @param {Uint8Array} auditWorkbook
   * @param {string} jsonLog
   * @param {object} summary
   * @param {(percent:number)=>void} [onProgress]
   */
  async function buildPackage(outputs, auditWorkbook, jsonLog, summary, onProgress) {
    const JSZipRef = scope.JSZip;
    if (!JSZipRef) throw new Error('JSZip não está disponível.');
    const zip = new JSZipRef();

    const folder = zip.folder('LDs_ATUALIZADAS');
    for (const output of outputs) {
      folder.file(output.name, output.bytes, { compression: 'STORE' });
    }

    zip.file('RELATORIO_AUDITORIA_VINCULA.xlsx', auditWorkbook, {
      compression: 'STORE',
    });
    zip.file('LOG_VINCULA.json', jsonLog, { compression: 'DEFLATE', compressionOptions: { level: 1 } });
    zip.file(MANIFEST_NAME, buildManifest(summary, outputs), { compression: 'DEFLATE', compressionOptions: { level: 1 } });

    return zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 1 } },
      (meta) => onProgress && onProgress(meta.percent)
    );
  }

  V.packager = { buildPackage, buildManifest };
})(typeof self !== 'undefined' ? self : this);
