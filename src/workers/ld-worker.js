/**
 * Vincula — worker de processamento de LD.
 *
 * Um worker mantém em memória as pastas de trabalho que abriu (afinidade por
 * arquivo), de modo que leitura, indexação e gravação de uma mesma LD nunca
 * reabrem o ZIP. Toda a carga pesada — descompactação, varredura de XML,
 * auditoria de integridade e recompactação — acontece aqui, fora da thread da
 * interface.
 */
/* global importScripts */
'use strict';

importScripts(
  '../../lib/jszip.min.js',
  '../core/util.js',
  '../core/dates.js',
  '../core/headers.js',
  '../core/xlsx.js',
  '../core/indexer.js',
  '../core/analyzer.js',
  '../core/applier.js',
  '../core/tasks.js'
);

const V = self.Vincula;

/** Resultados que carregam bytes voltam por transferência, sem cópia. */
function transferablesOf(result) {
  const list = [];
  if (result && result.bytes && result.bytes.buffer) list.push(result.bytes.buffer);
  return list;
}

self.onmessage = async (event) => {
  const { id, type, payload } = event.data || {};

  if (type === 'ping') {
    self.postMessage({ id, ok: true, result: { pong: true, version: V.VERSION } });
    return;
  }

  const handler = V.tasks[type];
  if (typeof handler !== 'function') {
    self.postMessage({ id, ok: false, error: `Tarefa desconhecida: ${type}` });
    return;
  }

  const report = (progress) => self.postMessage({ id, progress });

  try {
    const result = await handler(payload || {}, report);
    self.postMessage({ id, ok: true, result }, transferablesOf(result));
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error && error.message ? error.message : String(error),
      stack: error && error.stack ? String(error.stack).slice(0, 1200) : null,
    });
  }
};
