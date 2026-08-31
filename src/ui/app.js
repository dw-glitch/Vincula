/**
 * Vincula — camada de interface.
 *
 * Única parte do sistema que toca no DOM. Toda a carga pesada é delegada ao
 * motor (que a distribui entre workers), de modo que a página só reage a
 * eventos de progresso, métricas e log.
 */
(function () {
  'use strict';

  const V = window.Vincula;
  const { normalizeDocument, formatBytes, formatDuration, formatNumber } = V.util;
  const A = V.analyzer;

  const $ = (id) => document.getElementById(id);
  const esc = (value) =>
    String(value ?? '').replace(/[&<>'"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));

  const PAGE_SIZE = 100;
  const COLLAPSE_THRESHOLD = 6;

  const engine = V.createEngine();

  const ui = {
    page: 1,
    filtered: [],
    logEntries: [],
    expandedCards: new Set(),
    // Recolhido pelo usuário: sem isto, um cartão que abre por padrão (uma aba
    // adicional, por exemplo) voltaria a abrir a cada redesenho.
    collapsedCards: new Set(),
    allExpanded: false,
    busy: false,
    searchTimer: null,
  };

  /* ================================================================== *
   * Primitivas de interface
   * ================================================================== */

  function toast(message) {
    const el = $('toast');
    el.textContent = message;
    el.classList.add('show');
    clearTimeout(el.timer);
    el.timer = setTimeout(() => el.classList.remove('show'), 3600);
  }

  function status(message, kind) {
    const el = $('loadStatus');
    el.textContent = message;
    el.dataset.kind = kind || 'info';
  }

  // Uma etapa só é alcançável quando seu pré-requisito já foi cumprido —
  // sem isto, os quatro botões do topo pareciam igualmente clicáveis mesmo
  // antes de haver relação carregada, análise ou relatório.
  function stepReachable(n) {
    if (n === 1) return true;
    if (n === 2) return !!engine.state.relation;
    if (n === 3) return !!engine.state.analysis;
    if (n === 4) return !!engine.state.report;
    return false;
  }

  function refreshStepsNav() {
    for (let i = 1; i <= 4; i++) {
      const button = document.querySelector(`.step[data-step="${i}"]`);
      button.disabled = !stepReachable(i);
    }
  }

  function goToStep(n) {
    for (let i = 1; i <= 4; i++) {
      $('step' + i).classList.toggle('hidden', i !== n);
      const button = document.querySelector(`.step[data-step="${i}"]`);
      button.classList.toggle('active', i === n);
      button.classList.toggle('done', i < n);
    }
    refreshStepsNav();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function download(blob, name) {
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(link.href);
      link.remove();
    }, 1500);
  }

  function setBusy(busy) {
    ui.busy = busy;
    document.body.classList.toggle('busy', busy);
    $('progressPanel').classList.toggle('hidden', !busy);
    $('cancelBtn').disabled = !busy;
  }

  /* ================================================================== *
   * Progresso e métricas
   * ================================================================== */

  // O motor emite seis fases; a interface mostra quatro barras, conforme o
  // vocabulário do usuário. Análise entra em Preparação, relatório em Finalização.
  const STAGE_MAP = {
    leitura: 'leitura',
    indexacao: 'indexacao',
    analise: 'indexacao',
    atualizacao: 'atualizacao',
    relatorio: 'compactacao',
    compactacao: 'compactacao',
  };
  const STAGE_ORDER = ['leitura', 'indexacao', 'atualizacao', 'compactacao'];

  function resetStages(upTo) {
    const limit = upTo === undefined ? STAGE_ORDER.length : STAGE_ORDER.indexOf(upTo);
    STAGE_ORDER.forEach((stage, index) => {
      if (index >= limit) setStage(stage, 0);
    });
  }

  function setStage(stage, percent) {
    const el = document.querySelector(`.stage[data-stage="${stage}"]`);
    if (!el) return;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    el.querySelector('.progress-fill').style.width = pct + '%';
    el.querySelector('.progress-bar').setAttribute('aria-valuenow', String(pct));
    el.querySelector('.stage-pct').textContent = pct + '%';
    el.classList.toggle('done', pct >= 100);
    el.classList.toggle('running', pct > 0 && pct < 100);
  }

  engine.on('progress', (event) => {
    const stage = STAGE_MAP[event.stage] || event.stage;
    setStage(stage, event.percent);
    // Etapas anteriores ficam cheias: a barra reflete o avanço do fluxo.
    const index = STAGE_ORDER.indexOf(stage);
    for (let i = 0; i < index; i++) setStage(STAGE_ORDER[i], 100);
    $('progressTitle').textContent = event.label;
    $('progressDetail').textContent = event.detail;
  });

  engine.on('metrics', (m) => {
    const set = (key, value) => {
      const el = document.querySelector(`#metrics [data-metric="${key}"]`);
      if (el) el.textContent = value;
    };
    set('lds', `${formatNumber(m.ldsProcessed)}${m.ldsTotal ? ` / ${formatNumber(m.ldsTotal)}` : ''}`);
    set('docs', formatNumber(m.documentsProcessed));
    set('found', formatNumber(m.documentsFound));
    set('changed', formatNumber(m.documentsChanged));
    set('cells', formatNumber(m.cellsWritten));
    set('rate', m.rate ? `${formatNumber(Math.round(m.rate))}/s` : '—');
    $('progressEta').textContent = m.eta > 900 ? `Tempo restante ≈ ${formatDuration(m.eta)}` : '';
  });

  engine.on('log', (entry) => {
    ui.logEntries.push(entry);
    if (entry.level === 'error') console.error('[Vincula]', entry.message, entry.detail || '');
    else if (entry.level === 'warn') console.warn('[Vincula]', entry.message, entry.detail || '');
  });

  /* ================================================================== *
   * Etapa 1 — carga de arquivos
   * ================================================================== */

  function wireDropzone(zone, input, handler) {
    ['dragenter', 'dragover'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.add('dragging');
      })
    );
    ['dragleave', 'drop'].forEach((type) =>
      zone.addEventListener(type, (event) => {
        event.preventDefault();
        zone.classList.remove('dragging');
      })
    );
    zone.addEventListener('drop', (event) => handler([...event.dataTransfer.files]));
    input.addEventListener('change', () => {
      handler([...input.files]);
      input.value = '';
    });
  }

  const SUPPORTED = /\.(xlsx|xlsm)$/i;

  async function loadRelation(files) {
    const file = files.find((f) => SUPPORTED.test(f.name));
    if (!file) return toast('Selecione um arquivo .xlsx ou .xlsm.');
    setBusy(true);
    resetStages();
    status(`Lendo ${file.name}…`);
    try {
      const relation = await engine.loadRelation(file);
      $('relationFileName').textContent = `${file.name} · ${formatBytes(file.size)}`;
      status(
        relation.mapping.confidence === 'alta'
          ? 'Relação carregada. As colunas foram identificadas automaticamente.'
          : 'Relação carregada. Confira as colunas na próxima etapa.',
        'ok'
      );
      refreshFileList();
      refreshReadyState();
    } catch (error) {
      status(error.message, 'bad');
      toast('Falha ao ler a relação: ' + error.message);
    } finally {
      setBusy(false);
    }
  }

  async function loadLds(files) {
    const usable = files.filter((f) => SUPPORTED.test(f.name));
    const rejected = files.length - usable.length;
    if (!usable.length) return toast('Nenhum arquivo .xlsx ou .xlsm selecionado.');

    setBusy(true);
    resetStages();
    status(`Lendo ${usable.length} LD(s)…`);
    try {
      const lds = await engine.loadLds(usable);
      const failed = lds.filter((l) => l.error);
      $('ldFileName').textContent = `${lds.length} LD(s) selecionada(s)`;
      status(
        `${lds.length - failed.length} LD(s) carregada(s).` +
          (failed.length ? ` ${failed.length} com falha.` : '') +
          (rejected ? ` ${rejected} arquivo(s) ignorado(s) por extensão.` : ''),
        failed.length ? 'warn' : 'ok'
      );
      refreshFileList();
      refreshReadyState();
    } catch (error) {
      status(error.message, 'bad');
      toast('Falha ao ler as LDs: ' + error.message);
    } finally {
      setBusy(false);
    }
  }

  function refreshFileList() {
    const items = [];
    if (engine.state.relation) {
      const r = engine.state.relation;
      items.push(
        `<div class="file-row"><span class="tag rel">Relação</span><strong>${esc(r.name)}</strong>
         <small>${formatBytes(r.size)} · ${r.meta.sheets.length} aba(s)</small></div>`
      );
    }
    for (const ld of engine.state.lds) {
      // Quando a LD traz mais de uma aba atualizável (documentos + CV, por
      // exemplo), isso aparece já na lista de arquivos.
      const sheets = ld.error ? [] : targetsOf(ld).filter((m) => m.enabled !== false);
      const sheetInfo = sheets.length > 1 ? ` · abas: ${sheets.map((m) => m.sheetName).join(', ')}` : '';
      items.push(
        `<div class="file-row${ld.error ? ' bad' : ''}"><span class="tag ld">LD</span><strong>${esc(ld.name)}</strong>
         <small>${
           ld.error ? esc(ld.error) : esc(`${formatBytes(ld.size)}${ld.fromCache ? ' · já lida antes' : ''}${sheetInfo}`)
         }</small></div>`
      );
    }
    $('fileList').innerHTML = items.join('');
  }

  function refreshReadyState() {
    const ready = !!engine.state.relation && engine.state.lds.some((l) => !l.error);
    $('toMappingBtn').disabled = !ready;
    refreshStepsNav();
  }

  /* ================================================================== *
   * Etapa 2 — mapeamento
   * ================================================================== */

  function gridLookup(grid) {
    const map = new Map();
    if (grid) for (const cell of grid.cells) map.set(cell.r * 16384 + cell.c, cell.v);
    return (row, col) => map.get(row * 16384 + col) || '';
  }

  function sheetOf(meta, mapping) {
    return meta.sheets.find((s) => s.path === mapping.sheetPath) || meta.sheets[0];
  }

  function columnChoices(sheet, headerRow) {
    const lookup = gridLookup(sheet.grid);
    const limit = Math.min(Math.max(sheet.grid ? sheet.grid.maxCol : 12, 12), 80);
    const out = [];
    for (let col = 1; col <= limit; col++) {
      out.push({ index: col, letter: V.util.indexToColumn(col), header: lookup(headerRow, col) });
    }
    return out;
  }

  function selectHtml(cls, dataset, options, selected, placeholder) {
    const attrs = Object.entries(dataset).map(([k, v]) => `data-${k}="${esc(v)}"`).join(' ');
    const body = options
      .map((o) => `<option value="${esc(o.value)}"${String(o.value) === String(selected) ? ' selected' : ''}>${esc(o.label)}</option>`)
      .join('');
    const empty = placeholder ? `<option value=""${selected ? '' : ' selected'}>${esc(placeholder)}</option>` : '';
    return `<select class="select ${cls}" ${attrs}>${empty}${body}</select>`;
  }

  /** Abas do arquivo que já são alvo de atualização. */
  function targetsOf(file) {
    return file.mappings && file.mappings.length ? file.mappings : [file.mapping];
  }

  function mappingCard(kind, index, target, name, meta, mapping, collapsed) {
    const sheet = sheetOf(meta, mapping);
    const choices = columnChoices(sheet, Number(mapping.headerRow));
    const colOptions = choices.map((c) => ({
      value: c.index,
      label: `${c.letter} · ${c.header || '(sem cabeçalho)'}`,
    }));

    const headerRowLimit = Math.min(sheet.grid ? Math.max(sheet.grid.maxRow, 1) : 1, 40);
    const rowOptions = [];
    const lookup = gridLookup(sheet.grid);
    for (let row = 1; row <= headerRowLimit; row++) {
      const preview = [];
      for (let col = 1; col <= 6; col++) {
        const value = lookup(row, col);
        if (value) preview.push(value);
      }
      rowOptions.push({ value: row, label: `Linha ${row}${preview.length ? ' · ' + preview.join(' | ').slice(0, 60) : ''}` });
    }

    const confidence = mapping.confidence || 'baixa';
    const confidenceLabel = { alta: 'Colunas identificadas', media: 'Confira as colunas', baixa: 'Revise as colunas' }[confidence];
    const extra = kind === 'l' && target > 0;
    // Aba adicional (CV, por exemplo) não precisa repetir todas as colunas da
    // aba principal: basta o documento e ao menos um campo gravável.
    const complete = extra
      ? !!(mapping.documentCol && (mapping.grdtCol || mapping.dateCol))
      : !!(mapping.documentCol && mapping.grdtCol && mapping.dateCol);
    const dateLabel = kind === 'r' ? 'Data da geração / postagem' : 'Data efetiva de emissão';
    const cardId = `${kind}-${index}-${target}`;

    const body = `
      <div class="mapping-grid">
        <div class="field"><label>Aba</label>
          ${selectHtml('ms', { k: kind, i: index, t: target }, meta.sheets.map((s) => ({ value: s.path, label: s.name + (s.hidden ? ' (oculta)' : '') })), mapping.sheetPath)}
        </div>
        <div class="field"><label>Linha do cabeçalho</label>
          ${selectHtml('mr', { k: kind, i: index, t: target }, rowOptions, mapping.headerRow)}
        </div>
        <div class="field"><label>Documento</label>
          ${selectHtml('mc', { k: kind, i: index, t: target, f: 'documentCol' }, colOptions, mapping.documentCol, 'Selecione…')}
        </div>
        <div class="field"><label>GRDT / eGRDT</label>
          ${selectHtml('mc', { k: kind, i: index, t: target, f: 'grdtCol' }, colOptions, mapping.grdtCol, 'Selecione…')}
        </div>
        <div class="field"><label>${esc(dateLabel)}</label>
          ${selectHtml('mc', { k: kind, i: index, t: target, f: 'dateCol' }, colOptions, mapping.dateCol, 'Selecione…')}
        </div>
        <div class="field"><label>Revisão <small>(opcional)</small></label>
          ${selectHtml('mc', { k: kind, i: index, t: target, f: 'revisionCol' }, colOptions, mapping.revisionCol, 'Nenhuma')}
        </div>
      </div>
      <div class="file-meta">${esc(sheet.name)} · ${formatNumber(sheet.maxRow)} linhas · ${formatNumber(sheet.maxCol)} colunas</div>
      ${
        extra
          ? `<div class="sheet-actions">
               <label class="sheet-toggle"><input class="mt" type="checkbox" data-k="${kind}" data-i="${index}" data-t="${target}"${
                 mapping.enabled === false ? '' : ' checked'
               }> <span>Atualizar esta aba</span></label>
               <button class="btn ghost small md" type="button" data-k="${kind}" data-i="${index}" data-t="${target}">Remover aba</button>
             </div>`
          : ''
      }`;

    const roleBadge = mapping.roleLabel ? `<span class="chip small">${esc(mapping.roleLabel)}</span>` : '';
    const offBadge = extra && mapping.enabled === false ? '<span class="chip small">não será atualizada</span>' : '';

    return `<div class="mapping-card${collapsed ? ' collapsed' : ''}${complete ? '' : ' incomplete'}${
      extra ? ' extra' : ''
    }${extra && mapping.enabled === false ? ' off' : ''}" data-card="${cardId}">
      <button class="mapping-head" type="button" data-toggle="${cardId}">
        <span class="mapping-title">${esc(name)}</span>
        ${roleBadge}
        ${offBadge}
        <span class="conf conf-${esc(confidence)}">${esc(confidenceLabel)}</span>
        ${complete ? '' : '<span class="conf conf-baixa">faltam colunas</span>'}
        <span class="chevron" aria-hidden="true"></span>
      </button>
      <div class="mapping-body">${body}</div>
    </div>`;
  }

  function renderMappings() {
    const relation = engine.state.relation;
    $('relationMapping').innerHTML = mappingCard('r', 0, 0, `Relação GRCON · ${relation.name}`, relation.meta, relation.mapping, false);

    const lds = engine.state.lds.filter((l) => !l.error);
    const sheetCount = lds.reduce((sum, ld) => sum + targetsOf(ld).filter((m) => m.enabled !== false).length, 0);
    $('ldCount').textContent = `${lds.length} arquivo(s) · ${sheetCount} aba(s) a atualizar`;
    const autoCollapse = lds.length > COLLAPSE_THRESHOLD;

    $('ldMappings').innerHTML = lds
      .map((ld, i) => {
        const targets = targetsOf(ld);
        const cards = targets
          .map((mapping, t) => {
            const key = `l-${i}-${t}`;
            const complete = t > 0
              ? mapping.documentCol && (mapping.grdtCol || mapping.dateCol)
              : mapping.documentCol && mapping.grdtCol && mapping.dateCol;
            // Cartões incompletos ou de baixa confiança abrem sozinhos: são os
            // que realmente exigem conferência humana. Aba adicional também
            // abre na primeira vez — é novidade que merece ser conferida.
            const shouldOpen =
              ui.allExpanded ||
              ui.expandedCards.has(key) ||
              (!ui.collapsedCards.has(key) && (!autoCollapse || !complete || t > 0 || mapping.confidence !== 'alta'));
            const title =
              t === 0
                ? `LD ${i + 1} · ${ld.name}`
                : `LD ${i + 1} · ${ld.name} · aba "${mapping.sheetName}"`;
            return mappingCard('l', i, t, title, ld.meta, mapping, !shouldOpen);
          })
          .join('');

        return `<div class="ld-block" data-ld="${i}">${cards}
          <div class="ld-block-actions">
            <button class="btn ghost small ma" type="button" data-i="${i}">+ Adicionar aba desta LD</button>
          </div>
        </div>`;
      })
      .join('');

    wireMappingEvents();
    invalidateConfirmation();
  }

  function fileOf(kind, index) {
    return kind === 'r' ? engine.state.relation : engine.state.lds.filter((l) => !l.error)[index];
  }
  function mappingOf(kind, index, target) {
    return targetsOf(fileOf(kind, index))[target || 0];
  }
  function metaOf(kind, index) {
    return fileOf(kind, index).meta;
  }

  function invalidateConfirmation() {
    $('mappingConfirm').checked = false;
    $('analyzeBtn').disabled = true;
  }

  /**
   * Amostra a aba no worker e reescreve o alvo com a detecção resultante.
   * É o mesmo caminho tanto para trocar a aba de um alvo quanto para criar um
   * alvo novo (a aba de CV, por exemplo).
   */
  async function applySheetToTarget(file, mapping, sheetPath, profile) {
    const scan = await engine.inspectSheet(file.fileId, sheetPath, profile);
    const sheet = file.meta.sheets.find((s) => s.path === sheetPath);
    sheet.grid = scan.grid;
    sheet.maxRow = scan.maxRow;
    sheet.maxCol = scan.maxCol;
    sheet.scanned = true;
    if (scan.role !== undefined) {
      sheet.role = scan.role;
      sheet.roleLabel = scan.roleLabel;
    }
    Object.assign(mapping, {
      sheetPath,
      sheetName: sheet.name,
      role: sheet.role || null,
      roleLabel: sheet.roleLabel || '',
      hidden: !!sheet.hidden,
      headerRow: scan.detected.headerRow,
      documentCol: scan.detected.documentCol,
      grdtCol: scan.detected.grdtCol,
      dateCol: scan.detected.dateCol,
      revisionCol: scan.detected.revisionCol,
      confidence: scan.detected.confidence,
      fieldScores: scan.detected.fieldScores,
    });
    return mapping;
  }

  function wireMappingEvents() {
    document.querySelectorAll('[data-toggle]').forEach((button) => {
      button.onclick = () => {
        const card = button.closest('.mapping-card');
        card.classList.toggle('collapsed');
        const key = button.dataset.toggle;
        if (card.classList.contains('collapsed')) {
          ui.expandedCards.delete(key);
          ui.collapsedCards.add(key);
        } else {
          ui.collapsedCards.delete(key);
          ui.expandedCards.add(key);
        }
      };
    });

    document.querySelectorAll('.ms').forEach((select) => {
      select.onchange = async () => {
        const { k, i, t } = select.dataset;
        const file = fileOf(k, +i);
        const mapping = mappingOf(k, +i, +t);

        // Duas abas iguais no mesmo arquivo gravariam duas vezes na mesma
        // planilha: a troca é recusada e o cartão volta ao estado anterior.
        const clash = targetsOf(file).some((other) => other !== mapping && other.sheetPath === select.value);
        if (clash) {
          toast('Esta aba já está mapeada neste arquivo.');
          renderMappings();
          return;
        }

        setBusy(true);
        try {
          // A aba pode ainda não ter sido amostrada: pede ao worker.
          await applySheetToTarget(file, mapping, select.value, k === 'r' ? 'relation' : 'ld');
          renderMappings();
        } catch (error) {
          toast('Falha ao ler a aba: ' + error.message);
        } finally {
          setBusy(false);
        }
      };
    });

    document.querySelectorAll('.mr').forEach((select) => {
      select.onchange = () => {
        mappingOf(select.dataset.k, +select.dataset.i, +select.dataset.t).headerRow = +select.value;
        renderMappings();
      };
    });

    document.querySelectorAll('.mc').forEach((select) => {
      select.onchange = () => {
        const { k, i, t, f } = select.dataset;
        const mapping = mappingOf(k, +i, +t);
        mapping[f] = select.value ? +select.value : null;
        invalidateConfirmation();
        const card = select.closest('.mapping-card');
        const complete = +t > 0
          ? mapping.documentCol && (mapping.grdtCol || mapping.dateCol)
          : mapping.documentCol && mapping.grdtCol && mapping.dateCol;
        card.classList.toggle('incomplete', !complete);
      };
    });

    // Liga/desliga uma aba adicional sem perder o mapeamento já conferido.
    document.querySelectorAll('.mt').forEach((box) => {
      box.onchange = () => {
        mappingOf(box.dataset.k, +box.dataset.i, +box.dataset.t).enabled = box.checked;
        renderMappings();
      };
    });

    document.querySelectorAll('.md').forEach((button) => {
      button.onclick = () => {
        const { i, t } = button.dataset;
        const file = fileOf('l', +i);
        const [removed] = file.mappings.splice(+t, 1);
        renderMappings();
        toast(`Aba "${removed.sheetName}" removida da atualização.`);
      };
    });

    document.querySelectorAll('.ma').forEach((button) => {
      button.onclick = async () => {
        const file = fileOf('l', +button.dataset.i);
        const used = new Set(targetsOf(file).map((mapping) => mapping.sheetPath));
        const free = file.meta.sheets.find((sheet) => !used.has(sheet.path));
        if (!free) return toast('Todas as abas deste arquivo já estão mapeadas.');

        setBusy(true);
        try {
          const mapping = { enabled: true, primary: false };
          await applySheetToTarget(file, mapping, free.path, 'ld');
          file.mappings.push(mapping);
          ui.expandedCards.add(`l-${button.dataset.i}-${file.mappings.length - 1}`);
          renderMappings();
          toast(`Aba "${mapping.sheetName}" adicionada. Confira as colunas.`);
        } catch (error) {
          toast('Falha ao ler a aba: ' + error.message);
        } finally {
          setBusy(false);
        }
      };
    });
  }

  /* ================================================================== *
   * Etapa 3 — pré-visualização
   * ================================================================== */

  function renderAnalysis() {
    const analysis = engine.state.analysis;
    const s = analysis.stats;

    const cards = [
      ['Linhas da relação', s.relationRows, ''],
      ['Documentos únicos', s.relationDocuments, ''],
      ['Encontrados', s.found, 'ok'],
      ['Não encontrados', s.missing, s.missing ? 'warn' : 'ok'],
      ['Duplicados', s.relationDuplicates + s.ldDuplicates, s.relationDuplicates + s.ldDuplicates ? 'warn' : 'ok'],
      ['Serão alterados', s.willChange, s.willChange ? 'ok' : 'warn'],
      ['Sem alteração', s.unchanged, ''],
      ['Datas inválidas', s.invalidDates, s.invalidDates ? 'warn' : 'ok'],
    ];
    // Só aparece quando a correspondência flexível estava ligada e resolveu
    // algo — na maioria das execuções (opção desligada) o valor é sempre 0
    // e não merece ocupar espaço no resumo.
    if (s.approximateMatches) cards.push(['Correspondência aproximada', s.approximateMatches, 'warn']);
    $('summaryCards').innerHTML = cards
      .map((c) => `<div class="summary-card ${c[2]}"><b>${formatNumber(c[1])}</b><span>${c[0]}</span></div>`)
      .join('');

    const pending = s.missing + s.invalidDates;
    const banner = $('statsBanner');
    banner.className = 'banner ' + (pending ? 'warning' : 'success');
    banner.innerHTML = pending
      ? `<strong>${formatNumber(s.relationDocuments)} documentos na relação · ${formatNumber(s.found)} encontrados · ${formatNumber(
          s.missing
        )} pertencem a outra LD · ${formatNumber(s.relationDuplicates)} duplicados · ${formatNumber(
          s.willChange
        )} atualizações previstas.</strong>
         Isso não impede de continuar: documentos não encontrados simplesmente não são alterados, e quando a data
         está inválida, a data que já estava na LD é mantida.`
      : `<strong>${formatNumber(s.relationDocuments)} documentos na relação · ${formatNumber(s.found)} encontrados · ${formatNumber(
          s.willChange
        )} atualizações previstas.</strong> Tudo certo, pode continuar.`;

    renderMatchDiagnostics(analysis, s.relationDocuments > 0 && s.found / s.relationDocuments < 0.05);

    const hasRevision = analysis.records.some((r) => r.beforeRevisao || r.afterRevisao);
    $('previewTableWrap').classList.toggle('has-revision', hasRevision);

    $('generateConfirm').checked = false;
    $('generateBtn').disabled = true;
    ui.page = 1;
    applyFilter();
  }

  /**
   * Amostra lado a lado de chaves de documento — texto como está no arquivo
   * e a chave normalizada usada para casar Relação × LD. Quando quase nada
   * é encontrado, a causa quase sempre aparece aqui: as duas colunas de
   * "chave normalizada" parecem o mesmo documento, mas não são idênticas
   * (prefixo, sufixo, zero à esquerda, extensão, espaço extra).
   */
  function sampleMatchData(analysis, limit) {
    const relationSamples = analysis.relationIndex.rows
      .slice(0, limit)
      .map((r) => ({ raw: r.rawDocument, normalized: r.document }));

    const ldSamples = [];
    for (const [normalized, entries] of analysis.globalIndex.byDocument) {
      for (const entry of entries) {
        const file = analysis.files.get(entry.fileId);
        ldSamples.push({ raw: entry.rawDocument, normalized, file: file ? file.name : entry.fileId });
        if (ldSamples.length >= limit) break;
      }
      if (ldSamples.length >= limit) break;
    }
    return { relationSamples, ldSamples };
  }

  function renderMatchDiagnostics(analysis, autoOpen) {
    const container = $('matchDiagnostics');
    const { relationSamples, ldSamples } = sampleMatchData(analysis, 8);

    if (!relationSamples.length || !ldSamples.length) {
      container.classList.add('hidden');
      container.innerHTML = '';
      return;
    }

    const rows = (list, withFile) =>
      list
        .map(
          (x) =>
            `<tr><td>${esc(x.raw) || '<span class="reason-empty">(vazio)</span>'}</td><td><code>${esc(x.normalized) || '—'}</code></td>${
              withFile ? `<td>${esc(x.file)}</td>` : ''
            }</tr>`
        )
        .join('');

    container.classList.remove('hidden');
    container.classList.toggle('alert', !!autoOpen);
    container.innerHTML = `
      <button type="button" class="diagnostics-head" id="toggleDiagnostics" aria-expanded="${autoOpen ? 'true' : 'false'}">
        <span>
          <strong>${autoOpen ? 'Poucos documentos encontrados — veja por quê' : 'Por que um documento não foi encontrado?'}</strong>
          <small>Compare como o mesmo documento aparece na Relação e nas LDs.</small>
        </span>
        <span class="chevron" aria-hidden="true"></span>
      </button>
      <div class="diagnostics-body${autoOpen ? '' : ' hidden'}">
        <div class="diagnostics-grid">
          <div>
            <h5>Exemplos da Relação GRCON</h5>
            <table class="mini-table"><thead><tr><th>Documento</th><th>Forma comparada</th></tr></thead><tbody>${rows(relationSamples, false)}</tbody></table>
          </div>
          <div>
            <h5>Exemplos das LDs carregadas</h5>
            <table class="mini-table"><thead><tr><th>Documento</th><th>Forma comparada</th><th>Arquivo</th></tr></thead><tbody>${rows(ldSamples, true)}</tbody></table>
          </div>
        </div>
        <p class="diagnostics-hint">
          O Vincula já tenta casar documentos mesmo com zero a mais, espaço ou traço diferente. Quando ainda
          assim não encontra — ou quando mais de um documento da LD poderia ser o mesmo e não dá para saber
          qual — o documento fica como não encontrado. Confira a coluna de Documento escolhida na Etapa 2.
        </p>
      </div>`;

    $('toggleDiagnostics').onclick = () => {
      const body = container.querySelector('.diagnostics-body');
      const collapsed = body.classList.toggle('hidden');
      $('toggleDiagnostics').setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
  }

  function applyFilter() {
    const analysis = engine.state.analysis;
    if (!analysis) return;
    const query = normalizeDocument($('searchPreview').value);
    const filter = $('filterStatus').value;

    ui.filtered = analysis.records.filter((record) => {
      if (!A.matchesFilter(record, filter)) return false;
      if (!query) return true;
      const haystack = normalizeDocument(
        [record.document, record.afterGrdt, record.beforeGrdt, record.fileName, record.sheetName, record.row].join(' ')
      );
      return haystack.includes(query);
    });

    const pages = Math.max(1, Math.ceil(ui.filtered.length / PAGE_SIZE));
    ui.page = Math.min(ui.page, pages);
    renderPreview();
  }

  function statusPill(record) {
    const label = A.STATUS_LABEL[record.status] || record.status;
    return `<span class="pill ${record.status.toLowerCase()}">${esc(label)}</span>`;
  }

  function flagChips(record) {
    if (!record.flags || !record.flags.length) return '';
    return (
      '<div class="chips">' +
      record.flags.map((flag) => `<span class="chip small">${esc(A.FLAG_LABEL[flag] || flag)}</span>`).join('') +
      '</div>'
    );
  }

  // Para uma correspondência direta e sem pendências, o motivo só repete o
  // que a coluna LD/Aba/Linha já mostra ("ocorrência única, linha X..."). Em
  // milhares de linhas isso é ruído puro; o texto completo continua no
  // relatório e disponível ao passar o mouse — na tela só o que exige atenção.
  function displayReason(record) {
    const trivial = (!record.flags || !record.flags.length) && (record.status === 'ATUALIZAR' || record.status === 'SEM_ALTERACAO');
    return trivial ? '' : record.reason;
  }

  function renderPreview() {
    const start = (ui.page - 1) * PAGE_SIZE;
    const rows = ui.filtered.slice(start, start + PAGE_SIZE);

    $('previewBody').innerHTML =
      rows
        .map((r) => {
          const shown = displayReason(r);
          return `<tr>
        <td>${statusPill(r)}${flagChips(r)}</td>
        <td><strong>${esc(r.document)}</strong></td>
        <td>${r.fileName ? `${esc(r.fileName)}<br><small>${esc(r.sheetName)} · linha ${r.row}</small>` : '—'}</td>
        <td>${esc(r.beforeGrdt)}</td>
        <td class="${r.grdtWillChange ? 'changed' : ''}">${esc(r.afterGrdt)}</td>
        <td>${esc(r.beforeDate)}</td>
        <td class="${r.dateWillChange ? 'changed' : ''}">${esc(r.afterDate)}</td>
        <td class="col-revision">${esc(r.beforeRevisao)}</td>
        <td class="col-revision ${r.revisionWillChange ? 'changed' : ''}">${esc(r.afterRevisao)}</td>
        <td class="reason" title="${esc(r.reason)}">${shown ? esc(shown) : '<span class="reason-empty">—</span>'}</td>
      </tr>`;
        })
        .join('') || '<tr><td colspan="10" class="empty">Nenhum resultado para o filtro atual.</td></tr>';

    const pages = Math.max(1, Math.ceil(ui.filtered.length / PAGE_SIZE));
    $('pageInfo').textContent = `Página ${ui.page} de ${pages} · ${formatNumber(ui.filtered.length)} linha(s)`;
    $('prevPage').disabled = ui.page <= 1;
    $('nextPage').disabled = ui.page >= pages;
  }

  /* ================================================================== *
   * Etapa 4 — downloads
   * ================================================================== */

  function renderDownloads(result) {
    const s = engine.state.analysis.stats;
    const outputs = result.outputs;
    const reproved = outputs.filter((o) => o.integrity !== 'APROVADA');

    const ok = !result.failures.length;
    $('finalSummary').innerHTML = `
      <h4 class="${ok ? '' : 'has-pending'}">
        <svg class="completion-icon" viewBox="0 0 24 24" aria-hidden="true">
          ${
            ok
              ? '<circle cx="12" cy="12" r="10" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>'
              : '<path d="M12 3l9 16H3z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M12 9.5v4.2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="16.6" r="1" fill="currentColor"/>'
          }
        </svg>
        ${ok ? 'Atualização concluída com integridade aprovada' : 'Atualização concluída com pendências'}
      </h4>
      <p>
        ${formatNumber(outputs.length)} planilha(s) atualizada(s) · ${formatNumber(s.willChange)} documento(s) alterado(s) ·
        ${formatNumber(s.missing)} não encontrado(s) · ${formatNumber(s.invalidDates)} com data inválida na relação (data da LD mantida) ·
        ${formatNumber(s.unchanged)} já estavam certos.
      </p>
      ${reproved.length ? `<p class="bad">Atenção: ${reproved.length} arquivo(s) não passaram na conferência e não foram incluídos.</p>` : ''}
      ${result.failures.length ? `<p class="bad">${result.failures.map((f) => `${esc(f.file)}: ${esc(f.error)}`).join('<br>')}</p>` : ''}
    `;

    const items = [
      ...outputs.map((o) => ({
        name: o.name,
        meta: `${formatBytes(o.size)} · ${o.grdtWrites} GRDT, ${o.dateWrites} data(s)${
          o.revisionWrites ? ` e ${o.revisionWrites} revisão(ões)` : ''
        } atualizadas`,
        blob: new Blob([o.bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
      })),
      { name: 'RELATORIO_AUDITORIA_VINCULA.xlsx', meta: 'Planilha com o antes e depois de cada documento', blob: result.auditBlob },
      { name: 'LOG_VINCULA.json', meta: 'Detalhes técnicos, para conferência ou TI', blob: result.logBlob },
    ];

    $('downloadList').innerHTML = items
      .map(
        (item, i) => `<div class="download-item">
          <div><strong>${esc(item.name)}</strong><small>${esc(item.meta)}</small></div>
          <button class="btn ghost small" data-download="${i}" type="button">Baixar</button>
        </div>`
      )
      .join('');

    document.querySelectorAll('[data-download]').forEach((button) => {
      button.onclick = () => {
        const item = items[+button.dataset.download];
        download(item.blob, item.name);
      };
    });
  }

  function exportLog() {
    const state = engine.state;
    const payload = {
      aplicacao: V.APP_NAME,
      versao: V.VERSION,
      exportadoEm: new Date().toISOString(),
      modo: engine.mode,
      relacao: state.relation ? { arquivo: state.relation.name, hash: state.relation.hash, mapeamento: state.relation.mapping } : null,
      lds: state.lds.map((ld) => ({
        arquivo: ld.name,
        hash: ld.hash,
        mapeamento: ld.mapping,
        abas: ld.error ? [] : targetsOf(ld).filter((m) => m.enabled !== false),
        erro: ld.error || null,
      })),
      estatisticas: state.analysis ? state.analysis.stats : null,
      tempos: state.timings,
      eventos: ui.logEntries,
    };
    download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }), 'VINCULA_LOG_SESSAO.json');
  }

  /* ================================================================== *
   * Ações
   * ================================================================== */

  async function runAnalysis() {
    const button = $('analyzeBtn');
    button.disabled = true;
    button.textContent = 'Analisando…';
    setBusy(true);
    resetStages();
    try {
      // A busca ampliada (zero à esquerda, espaço, traço) é sempre tentada
      // quando a igualdade exata falha — o usuário não precisa pedir isso.
      // A segurança continua garantida no analisador: só resolve quando há
      // exatamente um candidato; caso ambíguo, fica como não encontrado.
      await engine.analyze({ flexibleMatching: true });
      renderAnalysis();
      goToStep(3);
      const s = engine.state.analysis.stats;
      toast(
        `${formatNumber(s.found)}/${formatNumber(s.relationDocuments)} documentos localizados.` +
          (s.approximateMatches ? ` ${formatNumber(s.approximateMatches)} por correspondência aproximada.` : '')
      );
    } catch (error) {
      toast(error.message);
      $('progressDetail').textContent = error.message;
    } finally {
      setBusy(false);
      button.disabled = false;
      button.textContent = 'Analisar correspondências';
    }
  }

  async function runGeneration() {
    const button = $('generateBtn');
    button.disabled = true;
    button.textContent = 'Gerando e conferindo…';
    setBusy(true);
    resetStages('atualizacao');
    try {
      const result = await engine.generate();
      renderDownloads(result);
      goToStep(4);
      toast('Pacote gerado e conferido com sucesso.');
    } catch (error) {
      toast('Falha: ' + error.message);
      $('progressDetail').textContent = error.message;
    } finally {
      setBusy(false);
      button.disabled = false;
      button.textContent = 'Gerar LDs atualizadas';
    }
  }

  /* ================================================================== *
   * Ligações
   * ================================================================== */

  wireDropzone($('relationDrop'), $('relationInput'), loadRelation);
  wireDropzone($('ldDrop'), $('ldInput'), loadLds);

  $('resetBtn').onclick = async () => {
    await engine.reset();
    window.location.reload();
  };
  $('cancelBtn').onclick = () => {
    engine.cancel();
    toast('Cancelamento solicitado — encerrando com segurança.');
  };
  document.querySelectorAll('.back-btn').forEach((b) => (b.onclick = () => goToStep(+b.dataset.back)));
  document.querySelectorAll('.step').forEach(
    (b) =>
      (b.onclick = () => {
        const target = +b.dataset.step;
        if (target === 1) goToStep(1);
        else if (target === 2 && engine.state.relation) goToStep(2);
        else if (target === 3 && engine.state.analysis) goToStep(3);
        else if (target === 4 && engine.state.report) goToStep(4);
      })
  );

  $('toMappingBtn').onclick = () => {
    ui.expandedCards.clear();
    ui.collapsedCards.clear();
    renderMappings();
    goToStep(2);
  };

  $('replicateBtn').onclick = () => {
    const lds = engine.state.lds.filter((l) => !l.error);
    if (lds.length < 2) return toast('É preciso ter mais de uma LD carregada.');
    const sources = targetsOf(lds[0]);
    let applied = 0;
    let missing = 0;

    for (const ld of lds.slice(1)) {
      const replicated = [];
      for (const source of sources) {
        // Só replica onde a aba de destino existe com o mesmo nome. A primeira
        // cai na aba já escolhida quando o nome não bate — as demais (CV, por
        // exemplo) são simplesmente puladas nas LDs que não as têm.
        const sheet =
          ld.meta.sheets.find((s) => s.name === source.sheetName) ||
          (replicated.length === 0 ? sheetOf(ld.meta, ld.mapping) : null);
        if (!sheet || replicated.some((m) => m.sheetPath === sheet.path)) {
          missing++;
          continue;
        }
        replicated.push({
          ...source,
          sheetPath: sheet.path,
          sheetName: sheet.name,
          role: sheet.role || null,
          roleLabel: sheet.roleLabel || '',
          hidden: !!sheet.hidden,
          primary: replicated.length === 0,
        });
      }
      if (!replicated.length) continue;
      ld.mappings = replicated;
      ld.mapping = replicated[0];
      applied++;
    }

    renderMappings();
    toast(
      `Mapeamento replicado em ${applied} LD(s)${missing ? `; ${missing} aba(s) sem correspondência foram puladas` : ''}. ` +
        'Confira antes de confirmar.'
    );
  };

  $('toggleCardsBtn').onclick = () => {
    ui.allExpanded = !ui.allExpanded;
    $('toggleCardsBtn').textContent = ui.allExpanded ? 'Recolher todas' : 'Expandir todas';
    if (ui.allExpanded) {
      ui.collapsedCards.clear();
    } else {
      // "Recolher todas" recolhe mesmo — inclusive os cartões que abririam
      // sozinhos por serem abas adicionais ou de detecção incerta.
      ui.expandedCards.clear();
      engine.state.lds
        .filter((l) => !l.error)
        .forEach((ld, i) => targetsOf(ld).forEach((_, t) => ui.collapsedCards.add(`l-${i}-${t}`)));
    }
    renderMappings();
  };

  $('mappingConfirm').onchange = () => {
    $('analyzeBtn').disabled = !$('mappingConfirm').checked;
  };
  $('analyzeBtn').onclick = runAnalysis;

  $('searchPreview').oninput = () => {
    clearTimeout(ui.searchTimer);
    ui.searchTimer = setTimeout(() => {
      ui.page = 1;
      applyFilter();
    }, 180);
  };
  $('filterStatus').onchange = () => {
    ui.page = 1;
    applyFilter();
  };
  $('prevPage').onclick = () => {
    if (ui.page > 1) {
      ui.page--;
      renderPreview();
    }
  };
  $('nextPage').onclick = () => {
    if (ui.page < Math.ceil(ui.filtered.length / PAGE_SIZE)) {
      ui.page++;
      renderPreview();
    }
  };

  $('generateConfirm').onchange = () => {
    $('generateBtn').disabled = !($('generateConfirm').checked && engine.state.analysis);
  };
  $('generateBtn').onclick = runGeneration;

  $('downloadZipBtn').onclick = () =>
    engine.state.packageBlob ? download(engine.state.packageBlob, 'VINCULA_PACOTE_COMPLETO.zip') : toast('Gere o pacote primeiro.');
  $('downloadReportBtn').onclick = () =>
    engine.state.auditBlob ? download(engine.state.auditBlob, 'RELATORIO_AUDITORIA_VINCULA.xlsx') : toast('Gere o relatório primeiro.');
  $('exportLogBtn').onclick = exportLog;

  window.addEventListener('beforeunload', (event) => {
    if (!ui.busy) return;
    event.preventDefault();
    event.returnValue = '';
  });

  /* ================================================================== *
   * Início
   * ================================================================== */

  $('appVersion').textContent = 'v' + V.VERSION;
  refreshStepsNav();

  // O modo "rápido" (Web Workers) é o padrão e não precisa de selo — só o
  // modo alternativo é informação que o usuário se beneficia de saber
  // (processamento mais lento, mas o resultado é idêntico).
  engine.pool.ready().then((mode) => {
    if (mode === 'worker') return;
    const badge = $('modeBadge');
    badge.textContent = 'Modo alternativo (pode ser mais lento)';
    badge.classList.remove('hidden');
    badge.classList.add('warn');
    badge.title = 'O processamento acontece na mesma tela, um pouco mais devagar. O resultado é o mesmo.';
  });

  // Exposto para diagnóstico no console do navegador.
  window.VinculaApp = { engine, ui };
})();
