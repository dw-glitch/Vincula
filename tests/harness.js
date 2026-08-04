/**
 * Carregador dos módulos do Vincula fora do navegador.
 *
 * Os módulos do núcleo são scripts clássicos que se anexam a `self`, sem
 * dependência de DOM — exatamente o mesmo formato consumido pelo Web Worker.
 * Isso permite executá-los no Node para teste automatizado sem duplicar código
 * nem manter um bundle separado.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

const CORE_FILES = [
  'lib/jszip.min.js',
  'src/core/util.js',
  'src/core/dates.js',
  'src/core/headers.js',
  'src/core/xlsx.js',
  'src/core/indexer.js',
  'src/core/analyzer.js',
  'src/core/applier.js',
  'src/core/audit.js',
  'src/core/packager.js',
  'src/core/tasks.js',
];

function loadVincula() {
  const sandbox = {
    console,
    crypto: globalThis.crypto,
    TextEncoder,
    TextDecoder,
    Intl,
    Blob,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Promise,
    Math,
    Date,
    JSON,
    ArrayBuffer,
    Uint8Array,
    Map,
    Set,
    Error,
    navigator: { hardwareConcurrency: 4 },
    process,
  };
  sandbox.self = sandbox;
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  for (const file of CORE_FILES) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    vm.runInContext(code, sandbox, { filename: file });
  }

  if (!sandbox.JSZip) throw new Error('JSZip não foi exposto no contexto de teste.');
  return sandbox.Vincula ? { V: sandbox.Vincula, JSZip: sandbox.JSZip, sandbox } : (() => {
    throw new Error('Vincula não foi carregado.');
  })();
}

module.exports = { loadVincula, ROOT, CORE_FILES };
