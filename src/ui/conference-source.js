/**
 * Vincula — refinamento de UX da origem da Relação GRCON.
 *
 * Mantém a tela principal simples e acrescenta apenas o necessário quando a
 * relação identificada é a Conferência SIGEM × Histórico: fonte detectada,
 * rótulos semânticos corretos, prioridade de `ultimo envio` e os campos de
 * conferência/status sem retirar do usuário o controle manual do mapeamento.
 */
(function () {
  'use strict';

  const V = window.Vincula;
  const app = window.VinculaApp;
  if (!V || !app || !app.engine) return;

  const engine = app.engine;
  const $ = (id) => document.getElementById(id);
  let decorating = false;

  function relation() {
    return engine.state && engine.state.relation;
  }

  function mapping() {
    const rel = relation();
    return rel && rel.mapping;
  }

  function isConference() {
    const rel = relation();
    const map = mapping();
    return !!(rel && ((rel.relationType || map?.relationType) === 'conference'));
  }

  function sourceLabel() {
    const rel = relation();
    const map = mapping();
    return rel?.sourceLabel || map?.sourceLabel || 'Histórico GRCON';
  }

  function gridLookup(grid) {
    const values = new Map();
    if (grid && Array.isArray(grid.cells)) {
      for (const cell of grid.cells) values.set(cell.r * 16384 + cell.c, cell.v);
    }
    return (row, col) => values.get(row * 16384 + col) || '';
  }

  function selectedHeader(select) {
    const text = select?.selectedOptions?.[0]?.textContent || '';
    return text.replace(/^[A-Z]+\s*·\s*/i, '').trim();
  }

  /**
   * Ao trocar manualmente a aba, app.js reaplica os quatro campos legados.
   * Reconstituímos os metadados exclusivos da Conferência usando exatamente o
   * mesmo detector de cabeçalhos do motor, sem depender da posição da coluna.
   *
   * Regra obrigatória da Conferência:
   *   1) escolha manual do usuário;
   *   2) `ultimo envio` detectado automaticamente;
   *   3) DATA EGRDT apenas como fallback legado.
   *
   * Data de confirmação pode existir no arquivo e no dropdown, mas nunca é
   * escolhida automaticamente como data de preenchimento da LD.
   */
  function refreshConferenceMapping() {
    const rel = relation();
    const map = mapping();
    if (!rel || !map) return;
    const sheet = rel.meta?.sheets?.find((item) => item.path === map.sheetPath) || rel.meta?.sheets?.[0];
    if (!sheet?.grid) return;

    const lookup = gridLookup(sheet.grid);
    const detected = V.headers.detectRelation(
      lookup,
      Math.min(sheet.grid.maxRow || 0, 80),
      sheet.grid.maxCol || 0
    );
    if (detected.relationType !== 'conference') return;

    map.relationType = 'conference';
    map.sourceLabel = detected.sourceLabel;
    map.sourceShortLabel = detected.sourceShortLabel;
    map.roleLabel = detected.sourceLabel;
    map.dateSentCol = detected.dateSentCol || null;
    map.dateEffectiveCol = null;
    map.dateGrdtCol = detected.dateGrdtCol || null;

    // A escolha manual é estado persistente do mapeamento e nunca pode ser
    // sobrescrita por MutationObserver, rerender, useEffect equivalente ou
    // nova validação visual.
    if (map.manualDateSelection && map.dateCol) {
      map.dateFallback = false;
      if (!map.sourceDateLabel || !/^Seleção manual:/i.test(map.sourceDateLabel)) {
        const header = lookup(Number(map.headerRow || detected.headerRow), Number(map.dateCol));
        map.sourceDateLabel = `Seleção manual: ${header || 'coluna escolhida'}`;
      }
    } else if (detected.dateSentCol) {
      map.dateCol = detected.dateSentCol;
      map.dateFallback = false;
      map.sourceDateLabel = 'ultimo envio';
    } else if (detected.dateGrdtCol) {
      map.dateCol = detected.dateGrdtCol;
      map.dateFallback = true;
      map.sourceDateLabel = 'DATA EGRDT (fallback legado)';
    } else if (!map.dateCol && detected.dateCol) {
      map.dateCol = detected.dateCol;
      map.dateFallback = false;
      map.sourceDateLabel = detected.sourceDateLabel || 'Data enviada na GRDT';
    }

    if (!map.revisionCol && detected.revisionCol) map.revisionCol = detected.revisionCol;
    if (!map.conferenceCol) map.conferenceCol = detected.conferenceCol;
    if (!map.sigemStatusCol) map.sigemStatusCol = detected.sigemStatusCol;

    rel.relationType = 'conference';
    rel.sourceLabel = detected.sourceLabel;
    rel.sourceShortLabel = detected.sourceShortLabel;
  }

  function invalidateConfirmation() {
    const confirm = $('mappingConfirm');
    const analyze = $('analyzeBtn');
    if (confirm) confirm.checked = false;
    if (analyze) analyze.disabled = true;
  }

  function fieldFor(select) {
    return select && select.closest('.field');
  }

  function setFieldLabel(field, text, optional) {
    if (!field) return;
    const label = field.querySelector('label');
    if (!label) return;
    label.textContent = text;
    if (optional) {
      const small = document.createElement('small');
      small.textContent = ' (opcional)';
      label.appendChild(small);
    }
  }

  function cloneColumnSelect(template, fieldName, selected, placeholder) {
    const select = template.cloneNode(true);
    select.dataset.f = fieldName;
    if (placeholder) {
      const empty = select.querySelector('option[value=""]');
      if (empty) empty.textContent = placeholder;
    }
    select.value = selected ? String(selected) : '';
    select.onchange = () => {
      const map = mapping();
      if (!map) return;
      map[fieldName] = select.value ? Number(select.value) : null;
      invalidateConfirmation();
      refreshCompleteness();
    };
    return select;
  }

  function ensureExtraField(grid, template, fieldName, label, selected, placeholder) {
    let select = grid.querySelector(`select[data-k="r"][data-f="${fieldName}"]`);
    if (select) {
      select.value = selected ? String(selected) : '';
      return select;
    }
    const field = document.createElement('div');
    field.className = 'field conference-source-field';
    const fieldLabel = document.createElement('label');
    fieldLabel.textContent = label;
    select = cloneColumnSelect(template, fieldName, selected, placeholder);
    field.append(fieldLabel, select);
    grid.appendChild(field);
    return select;
  }

  function refreshCompleteness() {
    const map = mapping();
    const card = $('relationMapping')?.querySelector('.mapping-card');
    if (!map || !card) return;
    const complete = map.relationType === 'conference'
      ? !!(map.documentCol && map.grdtCol && map.dateCol && map.revisionCol && map.conferenceCol)
      : !!(map.documentCol && map.grdtCol && map.dateCol);
    card.classList.toggle('incomplete', !complete);

    let missing = card.querySelector('.conference-missing-fields');
    if (!complete && map.relationType === 'conference') {
      if (!missing) {
        missing = document.createElement('span');
        missing.className = 'conf conf-baixa conference-missing-fields';
        missing.textContent = 'faltam campos da conferência';
        card.querySelector('.mapping-head .chevron')?.insertAdjacentElement('beforebegin', missing);
      }
    } else if (missing) {
      missing.remove();
    }
  }

  function decorateSourceSummary() {
    const rel = relation();
    if (!rel) return;
    const label = sourceLabel();
    const fileName = $('relationFileName');
    if (fileName && !fileName.textContent.includes(`Fonte: ${label}`)) {
      fileName.textContent = fileName.textContent.replace(/\s+·\s+Fonte:.*$/, '') + ` · Fonte: ${label}`;
    }

    const status = $('loadStatus');
    if (status && status.dataset.kind !== 'bad' && /Relação carregada|colunas foram identificadas|Confira as colunas/i.test(status.textContent)) {
      status.textContent = `Arquivo identificado como: ${label}. ${
        rel.mapping?.confidence === 'alta'
          ? 'As colunas foram identificadas automaticamente.'
          : 'Confira as colunas na próxima etapa.'
      }`;
      status.dataset.kind = 'ok';
    }

    const row = $('fileList')?.querySelector('.file-row .tag.rel')?.closest('.file-row');
    if (row) {
      const tag = row.querySelector('.tag.rel');
      const small = row.querySelector('small');
      if (tag) tag.textContent = rel.sourceShortLabel || rel.mapping?.sourceShortLabel || 'Relação';
      if (small && !small.textContent.includes(label)) small.textContent += ` · ${label}`;
    }
  }

  function decoratePreviewHeader() {
    const headers = document.querySelectorAll('#previewTableWrap thead th');
    if (headers[6]) headers[6].textContent = isConference() ? 'Data enviada na GRDT' : 'Nova data';
  }

  function decorateMapping() {
    const rel = relation();
    const root = $('relationMapping');
    if (!rel || !root) return;

    refreshConferenceMapping();
    const map = mapping();
    if (!map) return;

    const title = root.querySelector('.mapping-title');
    if (title && !title.textContent.startsWith(sourceLabel())) {
      title.textContent = `${sourceLabel()} · ${rel.name}`;
    }

    if (map.relationType !== 'conference') {
      refreshCompleteness();
      return;
    }

    const grid = root.querySelector('.mapping-grid');
    if (!grid) return;
    const documentSelect = grid.querySelector('select[data-k="r"][data-f="documentCol"]');
    const dateSelect = grid.querySelector('select[data-k="r"][data-f="dateCol"]');
    const revisionSelect = grid.querySelector('select[data-k="r"][data-f="revisionCol"]');
    if (!documentSelect || !dateSelect || !revisionSelect) return;

    // O dropdown já contém TODAS as colunas da planilha (é um clone do seletor
    // base de app.js). Apenas sincronizamos o valor; não filtramos cabeçalhos.
    if (map.dateCol && dateSelect.value !== String(map.dateCol)) dateSelect.value = String(map.dateCol);

    setFieldLabel(fieldFor(dateSelect), 'Data enviada na GRDT', false);
    setFieldLabel(fieldFor(revisionSelect), 'Revisão enviada na GRDT', false);

    ensureExtraField(
      grid,
      documentSelect,
      'dateGrdtCol',
      'DATA EGRDT (fallback legado)',
      map.dateGrdtCol,
      'Opcional'
    );
    ensureExtraField(grid, documentSelect, 'conferenceCol', 'Conferência / postagem confirmada', map.conferenceCol, 'Selecione…');
    ensureExtraField(grid, documentSelect, 'sigemStatusCol', 'Status SIGEM', map.sigemStatusCol, 'Opcional');

    let note = root.querySelector('.conference-source-note');
    if (!note) {
      note = document.createElement('div');
      note.className = 'file-meta conference-source-note';
      grid.insertAdjacentElement('afterend', note);
    }
    note.textContent = map.manualDateSelection
      ? `${map.sourceDateLabel || 'Seleção manual'} será usada como Data enviada na GRDT. Sua escolha manual tem prioridade e não será substituída automaticamente.`
      : map.dateFallback
        ? '`ultimo envio` não foi encontrado; DATA EGRDT está sendo usada somente como fallback legado. Data de confirmação não preenche a LD.'
        : '`ultimo envio` foi reconhecido como Data enviada na GRDT e será usado para atualizar a LD. Data de confirmação não é usada para preencher a LD. Você pode alterar a coluna manualmente no dropdown.';

    refreshCompleteness();
  }

  function decorate() {
    if (decorating) return;
    decorating = true;
    try {
      decorateSourceSummary();
      decorateMapping();
      decoratePreviewHeader();
    } finally {
      decorating = false;
    }
  }

  // A área de importação já comunica os dois formatos antes de qualquer carga.
  const relationDrop = $('relationDrop');
  if (relationDrop) {
    const strong = relationDrop.querySelector('strong');
    const small = relationDrop.querySelector('small');
    if (strong) strong.textContent = 'Relação do GRCON';
    if (small) small.textContent = 'Histórico do GRCON ou Conferência SIGEM × Histórico';
  }

  // A função usada pela tela é a mesma referência de engine; o wrapper apenas
  // agenda o refinamento visual depois que app.js terminar sua própria renderização.
  const originalLoadRelation = engine.loadRelation.bind(engine);
  engine.loadRelation = async function (...args) {
    const result = await originalLoadRelation(...args);
    setTimeout(decorate, 0);
    return result;
  };

  // Mensagem específica antes da análise: confirmação não é fallback válido.
  const originalAnalyze = engine.analyze.bind(engine);
  engine.analyze = async function (...args) {
    const map = mapping();
    if (map?.relationType === 'conference' && !map.dateCol) {
      throw new Error('Selecione a coluna “Data enviada na GRDT”. O Vincula procura “ultimo envio” automaticamente e não usa “Data de confirmação” como substituta.');
    }
    return originalAnalyze(...args);
  };

  $('relationMapping')?.addEventListener('change', (event) => {
    const target = event.target;
    const map = mapping();
    if (!map || !(target instanceof HTMLSelectElement)) {
      setTimeout(decorate, 0);
      return;
    }

    // Trocar de aba invalida uma escolha manual feita na aba anterior; a nova
    // aba volta a ser detectada normalmente.
    if (target.matches('select[data-k="r"].ms')) {
      map.manualDateSelection = false;
      map.sourceDateLabel = '';
    }

    // A alteração do seletor principal de data é uma decisão explícita do
    // usuário. Ela passa a ter precedência sobre toda autodetecção posterior.
    if (target.matches('select[data-k="r"][data-f="dateCol"]')) {
      if (target.value) {
        map.manualDateSelection = true;
        map.dateCol = Number(target.value);
        map.dateFallback = false;
        map.sourceDateLabel = `Seleção manual: ${selectedHeader(target) || 'coluna escolhida'}`;
      } else {
        map.manualDateSelection = false;
        map.dateCol = null;
        map.sourceDateLabel = '';
      }
      invalidateConfirmation();
    }

    setTimeout(decorate, 0);
  });

  const observer = new MutationObserver(() => {
    if (!decorating && relation()) setTimeout(decorate, 0);
  });
  ['relationFileName', 'loadStatus', 'fileList', 'relationMapping'].forEach((id) => {
    const node = $(id);
    if (node) observer.observe(node, { childList: true, subtree: true });
  });

  decorate();
})();
