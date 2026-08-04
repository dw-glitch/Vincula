/**
 * Vincula — detecção inteligente de cabeçalhos.
 *
 * O reconhecimento não depende de escrita exata: caixa, acentuação, hífens,
 * espaços extras e palavras de ligação são normalizados antes da comparação,
 * e há um segundo estágio por conjunto de tokens para variações não previstas
 * ("DATA EFETIVA EMISSAO" ≡ "Data Efetiva de Emissão").
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { normalizeHeader, headerTokens } = V.util;

  /**
   * Cada campo declara:
   *  - exact:     grafias canônicas conhecidas (pontuação máxima);
   *  - required:  grupos de tokens; ao menos um token de cada grupo precisa
   *               estar presente para o cabeçalho ser candidato;
   *  - optional:  tokens que reforçam a confiança;
   *  - forbidden: tokens que eliminam o candidato (evita confundir a data de
   *               postagem com a data efetiva, ou "tipo de documento" com o
   *               código do documento).
   */
  const FIELDS = {
    document: {
      label: 'Documento',
      exact: [
        'DOCUMENTO',
        'DOCUMENTOS',
        'CODIGO DOCUMENTO',
        'CODIGO DO DOCUMENTO',
        'COD DOCUMENTO',
        'COD DO DOCUMENTO',
        'NUMERO DO DOCUMENTO',
        'NUMERO DOCUMENTO',
        'N DOCUMENTO',
        'NOME DO DOCUMENTO',
        'NOME DOCUMENTO',
        'DOC',
        'CODIGO',
      ],
      required: [['DOCUMENTO', 'DOCUMENTOS', 'DOC', 'CODIGO', 'COD']],
      optional: ['CODIGO', 'COD', 'NUMERO', 'N', 'NOME'],
      forbidden: ['TIPO', 'DESCRICAO', 'SITUACAO', 'STATUS', 'QUANTIDADE', 'VALOR', 'DATA', 'GRDT'],
    },
    grdt: {
      label: 'GRDT',
      exact: [
        'GRDT',
        'EGRDT',
        'E GRDT',
        'GRDT EGRDT',
        'N GRDT',
        'NUMERO GRDT',
        'NUMERO DA GRDT',
        'CODIGO GRDT',
        'GUIA GRDT',
      ],
      required: [['GRDT', 'EGRDT']],
      optional: ['E', 'N', 'NUMERO', 'CODIGO', 'GUIA'],
      forbidden: ['DATA', 'DOCUMENTO'],
    },
    dateEffective: {
      label: 'Data Efetiva de Emissão',
      exact: [
        'DATA EFETIVA DE EMISSAO',
        'DATA EFETIVA EMISSAO',
        'DATA EFETIVA',
        'DATA DE EMISSAO EFETIVA',
        'DT EFETIVA DE EMISSAO',
        'DT EFETIVA EMISSAO',
        'DATA EMISSAO EFETIVA',
      ],
      required: [['DATA', 'DT'], ['EFETIVA', 'EFETIVO', 'EMISSAO']],
      optional: ['EMISSAO', 'EFETIVA'],
      forbidden: ['GERACAO', 'POSTAGEM', 'ENVIO', 'RECEBIMENTO', 'VENCIMENTO', 'PREVISTA'],
    },
    datePosting: {
      label: 'Data da Geração / Postagem',
      exact: [
        'DATA DA GERACAO POSTAGEM',
        'DATA DE GERACAO POSTAGEM',
        'DATA GERACAO POSTAGEM',
        'DATA DA GERACAO',
        'DATA DE GERACAO',
        'DATA GERACAO',
        'DATA DA POSTAGEM',
        'DATA DE POSTAGEM',
        'DATA POSTAGEM',
        'DT GERACAO',
        'DT POSTAGEM',
      ],
      required: [['DATA', 'DT'], ['GERACAO', 'POSTAGEM']],
      optional: ['GERACAO', 'POSTAGEM'],
      forbidden: ['EFETIVA', 'VENCIMENTO'],
    },
  };

  // Índices pré-normalizados: comparação de cabeçalho é caminho quente.
  for (const field of Object.values(FIELDS)) {
    field.exactSet = new Set(field.exact.map(normalizeHeader));
    field.tokenSets = field.exact.map((text) => headerTokens(text).sort().join(' '));
    field.tokenSetIndex = new Set(field.tokenSets);
    field.forbiddenSet = new Set(field.forbidden);
    field.optionalSet = new Set(field.optional);
  }

  /**
   * Pontua o quanto `text` representa `kind`, de 0 (não é) a 100 (grafia
   * canônica). Valores >= 55 são considerados correspondência utilizável.
   */
  function scoreHeader(kind, text) {
    const field = FIELDS[kind];
    if (!field) return 0;

    const normalized = normalizeHeader(text);
    if (!normalized) return 0;
    if (field.exactSet.has(normalized)) return 100;

    const tokens = headerTokens(normalized);
    if (!tokens.length) return 0;
    for (const token of tokens) {
      if (field.forbiddenSet.has(token)) return 0;
    }

    // Mesmo conjunto de palavras significativas, ordem/ligação diferentes.
    if (field.tokenSetIndex.has(tokens.slice().sort().join(' '))) return 95;

    for (const group of field.required) {
      if (!group.some((token) => tokens.includes(token))) return 0;
    }

    // Todos os requisitos batem: pontua pela densidade de palavras úteis.
    const useful = tokens.filter(
      (token) => field.optionalSet.has(token) || field.required.some((group) => group.includes(token))
    ).length;
    const noise = tokens.length - useful;
    return Math.max(55, 88 - noise * 8);
  }

  /** Compatibilidade e uso na UI: o cabeçalho é o da data de postagem? */
  function isPostingDateHeader(text) {
    return scoreHeader('datePosting', text) >= 55;
  }

  function isEffectiveDateHeader(text) {
    return scoreHeader('dateEffective', text) >= 55;
  }

  const PROFILES = {
    relation: { document: 'document', grdt: 'grdt', date: 'datePosting' },
    ld: { document: 'document', grdt: 'grdt', date: 'dateEffective' },
  };

  const WEIGHTS = { document: 1.4, grdt: 1.0, date: 1.2 };
  const MAX_HEADER_SCAN_ROWS = 80;
  const MAX_HEADER_SCAN_COLS = 200;

  /**
   * Varre as primeiras linhas procurando a combinação (linha, colunas) com
   * maior pontuação agregada. Funciona com planilhas que trazem título,
   * logotipo ou linhas em branco antes do cabeçalho real.
   *
   * @param {(row:number, col:number) => string} getValue
   */
  function detect(getValue, maxRow, maxCol, profile) {
    const fields = PROFILES[profile] || PROFILES.ld;
    const rowLimit = Math.min(maxRow || 0, MAX_HEADER_SCAN_ROWS);
    const colLimit = Math.min(maxCol || 0, MAX_HEADER_SCAN_COLS);

    let best = { headerRow: 1, score: 0, columns: {}, scores: {} };

    for (let row = 1; row <= rowLimit; row++) {
      const columns = {};
      const scores = {};
      let total = 0;

      for (let col = 1; col <= colLimit; col++) {
        const text = getValue(row, col);
        if (!text) continue;
        for (const [slot, kind] of Object.entries(fields)) {
          const score = scoreHeader(kind, text);
          if (score >= 55 && score > (scores[slot] || 0)) {
            scores[slot] = score;
            columns[slot] = col;
          }
        }
      }

      for (const [slot, score] of Object.entries(scores)) total += score * WEIGHTS[slot];
      // Desempate: cabeçalhos mais altos na planilha são mais prováveis.
      total -= row * 0.01;

      if (total > best.score) best = { headerRow: row, score: total, columns, scores };
    }

    const found = Object.keys(best.columns).length;
    return {
      headerRow: best.headerRow,
      documentCol: best.columns.document || null,
      grdtCol: best.columns.grdt || null,
      dateCol: best.columns.date || null,
      fieldScores: best.scores,
      score: best.score,
      matchedFields: found,
      confidence: found === 3 ? 'alta' : found === 2 ? 'media' : 'baixa',
    };
  }

  V.headers = {
    FIELDS,
    scoreHeader,
    detect,
    isPostingDateHeader,
    isEffectiveDateHeader,
  };
})(typeof self !== 'undefined' ? self : this);
