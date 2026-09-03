/**
 * Vincula — refinamento de UX da origem da Relação GRCON.
 *
 * Mantém a tela principal simples e acrescenta apenas o necessário quando a
 * relação identificada é a Conferência Histórico × Consulta Geral: fonte
 * detectada, rótulos semânticos corretos e os campos de conferência/status.
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

  /**
   * Ao trocar manualmente a aba, app.js reaplica os quatro campos legados.
   * Reconstituímos os metadados exclusivos da Conferência usando exatamente o
   * mesmo detector de cabeçalhos do motor, sem depender da posição da coluna.
   */
  function refreshConferenceMapping() {
    const rel = relation();
    const map = mapping();
    if (!rel || !map) return;
    const sheet = rel.meta?.sheets?.find((item) => item.path === map.sheetPath) || rel.meta?.sheets?.[0];
    if (!sheet?.grid) return;
    const detected = V.headers.detectRelation(
      gridLookup(sheet.grid),
      Math.min(sheet.grid.maxRow || 0, 80),
      sheet.grid.maxCol || 0
    );
    if (detected.relationType !== 'conference') return;

    map.relationType = 'conference';
    map.sourceLabel = detected.sourceLabel;
    map.sourceShortLabel = detected.sourceShortLabel;
    map.sourceDateLabel = detected.sourceDateLabel;
    map.roleLabel = detected.sourceLabel;
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
    if (select) return select;
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

    setFieldLabel(fieldFor(dateSelect), 'Data efetiva / confirmação', false);
    setFieldLabel(fieldFor(revisionSelect), 'Revisão enviada na GRDT', false);

    ensureExtraField(grid, documentSelect, 'conferenceCol', 'Conferência / postagem confirmada', map.conferenceCol, 'Selecione…');
    ensureExtraField(grid, documentSelect, 'sigemStatusCol', 'Status SIGEM', map.sigemStatusCol, 'Opcional');

    if (!root.querySelector('.conference-source-note')) {
      const note = document.createElement('div');
      note.className = 'file-meta conference-source-note';
      note.textContent = 'Somente registros confirmados como Postado/Confirmado pela Conferência podem atualizar a LD. Status SIGEM é informativo e não confirma postagem.';
      grid.insertAdjacentElement('afterend', note);
    }

    refreshCompleteness();
  }

  function decorate() {
    if (decorating) return;
    decorating = true;
    try {
      decorateSourceSummary();
      decorateMapping();
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
    if (small) small.textContent = 'Histórico do GRCON ou Conferência Histórico × Consulta Geral';
  }

  // A função usada pela tela é a mesma referência de engine; o wrapper apenas
  // agenda o refinamento visual depois que app.js terminar sua própria renderização.
  const originalLoadRelation = engine.loadRelation.bind(engine);
  engine.loadRelation = async function (...args) {
    const result = await originalLoadRelation(...args);
    setTimeout(decorate, 0);
    return result;
  };

  $('relationMapping')?.addEventListener('change', () => setTimeout(decorate, 0));

  const observer = new MutationObserver(() => {
    if (!decorating && relation()) setTimeout(decorate, 0);
  });
  ['relationFileName', 'loadStatus', 'fileList', 'relationMapping'].forEach((id) => {
    const node = $(id);
    if (node) observer.observe(node, { childList: true, subtree: true });
  });

  decorate();
})();
