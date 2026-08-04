/**
 * Vincula — pool de Web Workers com afinidade por arquivo e contingência.
 *
 * Escalonamento: cada LD é aberta em um worker e permanece ligada a ele
 * (afinidade), para que indexação e gravação reaproveitem o ZIP já
 * descompactado. Tarefas sem afinidade vão para o worker menos carregado.
 *
 * Contingência: se o ambiente não permitir workers — abertura do index.html
 * direto do disco, política de CSP restritiva, navegador antigo — o pool cai
 * para execução na própria página, entregando o controle ao event loop entre
 * tarefas para que a interface continue respondendo. A API é a mesma nos dois
 * modos, portanto o restante do sistema não sabe em qual está rodando.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { yieldToLoop } = V.util;

  const HANDSHAKE_TIMEOUT = 4000;

  function defaultSize() {
    const cores = (scope.navigator && scope.navigator.hardwareConcurrency) || 4;
    return Math.max(2, Math.min(cores, 8));
  }

  function createPool(options = {}) {
    const size = Math.max(1, options.size || defaultSize());
    const workerUrl = options.workerUrl || 'src/workers/ld-worker.js';

    const lanes = [];
    const queue = [];
    const affinity = new Map(); // fileId → índice da lane
    let sequence = 0;
    let mode = 'pending';
    let cancelled = false;
    let disposed = false;

    /* ---------------------------------------------------------------- *
     * Lanes com Web Worker
     * ---------------------------------------------------------------- */

    function attachWorker(worker, lane) {
      worker.onmessage = (event) => {
        const { id, ok, result, error, stack, progress } = event.data || {};
        const task = lane.inFlight;
        if (!task || task.id !== id) return;
        if (progress) {
          task.onProgress && task.onProgress(progress);
          return;
        }
        lane.inFlight = null;
        lane.busy = false;
        if (ok) task.resolve(result);
        else {
          const err = new Error(error || 'Falha no worker.');
          if (stack) err.workerStack = stack;
          task.reject(err);
        }
        pump();
      };
      worker.onerror = (event) => {
        const task = lane.inFlight;
        lane.inFlight = null;
        lane.busy = false;
        if (task) task.reject(new Error(event.message || 'Erro no worker de processamento.'));
        pump();
      };
    }

    async function bootWorkers() {
      const created = [];
      for (let i = 0; i < size; i++) {
        const worker = new scope.Worker(workerUrl);
        const lane = { index: i, worker, busy: false, inFlight: null };
        attachWorker(worker, lane);
        created.push(lane);
      }

      // Handshake: garante que importScripts funcionou antes de assumir o modo.
      await new Promise((resolve, reject) => {
        const lane = created[0];
        const id = 'handshake';
        const timer = setTimeout(() => reject(new Error('Worker não respondeu ao handshake.')), HANDSHAKE_TIMEOUT);
        lane.inFlight = {
          id,
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        };
        lane.busy = true;
        lane.worker.postMessage({ id, type: 'ping' });
      });

      lanes.push(...created);
      mode = 'worker';
    }

    /* ---------------------------------------------------------------- *
     * Lane única em contingência (mesma thread)
     * ---------------------------------------------------------------- */

    function bootInline() {
      lanes.push({ index: 0, worker: null, busy: false, inFlight: null, inline: true });
      mode = 'inline';
    }

    async function runInline(lane, task) {
      lane.busy = true;
      lane.inFlight = task;
      try {
        await yieldToLoop();
        const handler = V.tasks[task.type];
        if (typeof handler !== 'function') throw new Error(`Tarefa desconhecida: ${task.type}`);
        const result = await handler(task.payload || {}, task.onProgress);
        task.resolve(result);
      } catch (error) {
        task.reject(error instanceof Error ? error : new Error(String(error)));
      } finally {
        lane.busy = false;
        lane.inFlight = null;
        await yieldToLoop();
        pump();
      }
    }

    /* ---------------------------------------------------------------- *
     * Escalonador
     * ---------------------------------------------------------------- */

    function laneFor(task) {
      if (task.forceLane !== undefined) {
        const lane = lanes[task.forceLane];
        return lane && !lane.busy ? lane : null;
      }
      if (task.fileId !== undefined && task.fileId !== null && affinity.has(task.fileId)) {
        const lane = lanes[affinity.get(task.fileId)];
        return lane && !lane.busy ? lane : null;
      }
      let best = null;
      for (const lane of lanes) {
        if (lane.busy) continue;
        best = lane;
        break;
      }
      return best;
    }

    function pump() {
      if (disposed || !lanes.length) return;
      for (let i = 0; i < queue.length; i++) {
        const task = queue[i];
        const lane = laneFor(task);
        if (!lane) continue;
        queue.splice(i, 1);
        i--;
        if (task.fileId !== undefined && task.fileId !== null && !affinity.has(task.fileId)) {
          affinity.set(task.fileId, lane.index);
        }
        if (lane.inline) {
          runInline(lane, task);
        } else {
          lane.busy = true;
          lane.inFlight = task;
          lane.worker.postMessage({ id: task.id, type: task.type, payload: task.payload }, task.transfer || []);
        }
      }
    }

    async function ready() {
      if (mode !== 'pending') return mode;
      try {
        if (!scope.Worker) throw new Error('Web Workers indisponíveis.');
        await bootWorkers();
      } catch (error) {
        for (const lane of lanes.splice(0, lanes.length)) {
          try {
            lane.worker && lane.worker.terminate();
          } catch (_) {
            /* ignora */
          }
        }
        bootInline();
        pool.fallbackReason = error && error.message ? error.message : String(error);
      }
      pump();
      return mode;
    }

    function run(type, payload, config = {}) {
      if (cancelled) return Promise.reject(new Error('Processamento cancelado.'));
      return new Promise((resolve, reject) => {
        queue.push({
          id: ++sequence,
          type,
          payload,
          transfer: config.transfer,
          fileId: config.fileId,
          forceLane: config.forceLane,
          onProgress: config.onProgress,
          resolve,
          reject,
        });
        pump();
      });
    }

    /**
     * Envia a mesma tarefa para todas as lanes. Necessário para operações de
     * ciclo de vida (liberação de memória), já que cada worker tem seu próprio
     * registro de arquivos abertos.
     */
    function broadcast(type, payload) {
      const previous = cancelled;
      cancelled = false;
      const calls = lanes.map((lane, index) => run(type, payload, { forceLane: index }).catch(() => null));
      cancelled = previous;
      return Promise.all(calls);
    }

    /**
     * Executa a mesma tarefa sobre vários itens respeitando a concorrência do
     * pool; `onSettled` recebe cada resultado assim que ele fica pronto, o que
     * alimenta a barra de progresso sem esperar o lote inteiro.
     */
    async function map(items, factory, onSettled) {
      const results = new Array(items.length);
      let done = 0;
      await Promise.all(
        items.map(async (item, index) => {
          try {
            const spec = factory(item, index);
            const value = await run(spec.type, spec.payload, spec);
            results[index] = { ok: true, value, item };
          } catch (error) {
            results[index] = { ok: false, error, item };
          }
          done++;
          onSettled && onSettled(results[index], done, items.length);
        })
      );
      return results;
    }

    function cancel() {
      cancelled = true;
      const pending = queue.splice(0, queue.length);
      for (const task of pending) task.reject(new Error('Processamento cancelado.'));
    }

    function resume() {
      cancelled = false;
    }

    function dispose() {
      disposed = true;
      cancel();
      for (const lane of lanes) {
        try {
          lane.worker && lane.worker.terminate();
        } catch (_) {
          /* ignora */
        }
      }
      lanes.length = 0;
      affinity.clear();
    }

    const pool = {
      ready,
      run,
      map,
      broadcast,
      cancel,
      resume,
      dispose,
      fallbackReason: null,
      get mode() {
        return mode;
      },
      get size() {
        return lanes.length;
      },
      get pending() {
        return queue.length;
      },
      get cancelled() {
        return cancelled;
      },
      forgetAffinity(fileId) {
        affinity.delete(fileId);
      },
    };
    return pool;
  }

  V.createPool = createPool;
})(typeof self !== 'undefined' ? self : this);
