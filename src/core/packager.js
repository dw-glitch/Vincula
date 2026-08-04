/**
 * Vincula — empacotamento final.
 *
 * Prioridades, nesta ordem: integridade dos arquivos, menor tamanho final,
 * tempo aceitável. Por isso o ZIP usa DEFLATE nível 9 nos artefatos de texto
 * e mantém os XLSX — que já são ZIPs comprimidos internamente — em nível
 * baixo: recomprimir dados já comprimidos custa tempo e não reduz tamanho.
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
      // XLSX/XLSM já são contêineres comprimidos: nível 1 mantém o tamanho e
      // economiza um passe completo de DEFLATE por arquivo.
      folder.file(output.name, output.bytes, { compression: 'DEFLATE', compressionOptions: { level: 1 } });
    }

    zip.file('RELATORIO_AUDITORIA_VINCULA.xlsx', auditWorkbook, {
      compression: 'DEFLATE',
      compressionOptions: { level: 1 },
    });
    zip.file('LOG_VINCULA.json', jsonLog, { compression: 'DEFLATE', compressionOptions: { level: 9 } });
    zip.file(MANIFEST_NAME, buildManifest(summary, outputs), { compression: 'DEFLATE', compressionOptions: { level: 9 } });

    return zip.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 9 } },
      (meta) => onProgress && onProgress(meta.percent)
    );
  }

  V.packager = { buildPackage, buildManifest };
})(typeof self !== 'undefined' ? self : this);
