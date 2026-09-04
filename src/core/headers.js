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
   *  - forbidden: tokens que eliminam o candidato (evita confundir campos
   *               semanticamente próximos, como "Revisão enviada" e
   *               "Revisão encontrada").
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
        'NUMERO EGRDT',
        'NUMERO DA EGRDT',
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
        'DATA DE EMISSAO',
        'DATA DA EMISSAO',
        'DATA EMISSAO',
      ],
      required: [['DATA', 'DT'], ['EFETIVA', 'EFETIVO', 'EMISSAO']],
      optional: ['EMISSAO', 'EFETIVA'],
      forbidden: ['GERACAO', 'POSTAGEM', 'ENVIO', 'RECEBIMENTO', 'VENCIMENTO', 'PREVISTA', 'GRDT', 'EGRDT'],
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
      forbidden: ['EFETIVA', 'CONFIRMACAO', 'VENCIMENTO'],
    },
    dateGrdt: {
      label: 'Data da GRDT / eGRDT',
      exact: [
        'DATA EGRDT',
        'DATA E GRDT',
        'DATA DA EGRDT',
        'DATA DA GRDT',
        'DATA GRDT',
        'DATA DE GRDT',
        'DATA DE EMISSAO GRDT',
        'DATA EMISSAO GRDT',
        'DT EGRDT',
        'DT GRDT',
      ],
      required: [['DATA', 'DT'], ['GRDT', 'EGRDT']],
      optional: ['GRDT', 'EGRDT', 'EMISSAO'],
      forbidden: ['EFETIVA', 'CONFIRMACAO', 'GERACAO', 'POSTAGEM', 'VENCIMENTO', 'PREVISTA'],
    },
    revision: {
      label: 'Revisão',
      exact: [
        'REVISAO',
        'REVISOES',
        'REVISAO DOCUMENTO',
        'REVISAO DO DOCUMENTO',
        'NUMERO DA REVISAO',
        'NUMERO REVISAO',
        'N REVISAO',
        'REVISAO ATUAL',
        'ULTIMA REVISAO',
        'REV',
        'REV ATUAL',
        'COD REVISAO',
        'CODIGO REVISAO',
      ],
      required: [['REVISAO', 'REV']],
      optional: ['ATUAL', 'ULTIMA', 'NUMERO', 'CODIGO', 'COD', 'DOCUMENTO'],
      forbidden: ['DATA', 'GRDT', 'SITUACAO', 'STATUS', 'DESCRICAO', 'MOTIVO', 'ENVIADA', 'ENVIADO', 'ENCONTRADA', 'ENCONTRADO'],
    },
  };

  /**
   * A Relação GRCON histórica aceita a data de geração/postagem, a data
   * efetiva usada por exports antigos e também DATA EGRDT. No Histórico,
   * todas são alternativas legadas válidas para a única coluna de data.
   */
  FIELDS.relationDate = {
    label: 'Data (Histórico GRCON)',
    exact: [...FIELDS.datePosting.exact, ...FIELDS.dateEffective.exact, ...FIELDS.dateGrdt.exact],
    required: [['DATA', 'DT'], ['GERACAO', 'POSTAGEM', 'EFETIVA', 'EFETIVO', 'EMISSAO', 'GRDT', 'EGRDT']],
    optional: ['GERACAO', 'POSTAGEM', 'EFETIVA', 'EMISSAO', 'GRDT', 'EGRDT'],
    forbidden: ['CONFIRMACAO', 'VENCIMENTO', 'PREVISTA', 'RECEBIMENTO', 'ENVIO'],
  };

  /** Revisão efetivamente enviada na eGRDT, não a revisão encontrada no SIGEM. */
  FIELDS.revisionSent = {
    label: 'Revisão enviada na GRDT',
    exact: [
      'REVISAO ENVIADA',
      'REVISAO ENVIADA NA GRDT',
      'REVISAO ENVIADA NA EGRDT',
      'REVISAO DA GRDT',
      'REVISAO DA EGRDT',
      'REVISAO SUBMETIDA',
      'REVISAO EMITIDA NA GRDT',
    ],
    required: [['REVISAO', 'REV'], ['ENVIADA', 'ENVIADO', 'SUBMETIDA', 'EMITIDA', 'GRDT', 'EGRDT']],
    optional: ['ENVIADA', 'ENVIADO', 'SUBMETIDA', 'EMITIDA', 'GRDT', 'EGRDT'],
    forbidden: ['DATA', 'STATUS', 'SITUACAO', 'ENCONTRADA', 'ENCONTRADO', 'ATUAL'],
  };

  /**
   * Data confirmada usada pela Conferência Histórico × Consulta Geral.
   * Nunca inclui DATA EGRDT: quando as duas existem, a efetiva/confirmação
   * deve vencer e a data da GRDT permanece em um campo separado.
   */
  FIELDS.conferenceDate = {
    label: 'Data Efetiva de Emissão / Data da confirmação',
    exact: [
      ...FIELDS.dateEffective.exact,
      'DATA DA CONFIRMACAO',
      'DATA DE CONFIRMACAO',
      'DATA CONFIRMACAO',
      'DT DA CONFIRMACAO',
      'DT CONFIRMACAO',
      'PRIMEIRA CONFIRMACAO',
      'DATA DA PRIMEIRA CONFIRMACAO',
    ],
    required: [['DATA', 'DT', 'PRIMEIRA'], ['EFETIVA', 'EFETIVO', 'EMISSAO', 'CONFIRMACAO']],
    optional: ['EFETIVA', 'EMISSAO', 'CONFIRMACAO', 'PRIMEIRA'],
    forbidden: ['GERACAO', 'POSTAGEM', 'ULTIMA', 'VENCIMENTO', 'PREVISTA', 'ENVIO', 'GRDT', 'EGRDT'],
  };

  /** Resultado da comparação que diz se a postagem foi realmente confirmada. */
  FIELDS.conferenceStatus = {
    label: 'Conferência',
    exact: [
      'CONFERENCIA',
      'STATUS DA CONFERENCIA',
      'STATUS CONFERENCIA',
      'SITUACAO DA CONFERENCIA',
      'SITUACAO CONFERENCIA',
      'RESULTADO DA CONFERENCIA',
      'RESULTADO CONFERENCIA',
    ],
    required: [['CONFERENCIA']],
    optional: ['STATUS', 'SITUACAO', 'RESULTADO'],
    forbidden: ['SIGEM', 'ULTIMA', 'DATA'],
  };

  /** Status operacional do SIGEM é evidência informativa, não prova de postagem. */
  FIELDS.sigemStatus = {
    label: 'Status SIGEM',
    exact: ['STATUS SIGEM', 'SITUACAO SIGEM', 'STATUS NO SIGEM', 'SITUACAO NO SIGEM'],
    required: [['STATUS', 'SITUACAO'], ['SIGEM']],
    optional: ['NO'],
    forbidden: ['CONFERENCIA', 'DATA'],
  };

  /**
   * A aba de CV (currículos) da LD lista os mesmos documentos controlados por
   * GRDT, mas rotula a coluna do documento com o vocabulário de currículo.
   */
  FIELDS.documentCv = {
    label: 'Documento / CV',
    exact: [
      ...FIELDS.document.exact,
      'CV',
      'CVS',
      'CURRICULO',
      'CURRICULOS',
      'CURRICULUM',
      'CURRICULUM VITAE',
      'CODIGO CV',
      'CODIGO DO CV',
      'COD CV',
      'NUMERO CV',
      'NUMERO DO CV',
      'N CV',
      'DOCUMENTO CV',
      'CV DOCUMENTO',
      'CODIGO CURRICULO',
      'CODIGO DO CURRICULO',
      'DOCUMENTO CURRICULO',
    ],
    required: [
      [
        'DOCUMENTO', 'DOCUMENTOS', 'DOC', 'CODIGO', 'COD', 'CV', 'CVS',
        'CURRICULO', 'CURRICULOS', 'CURRICULUM', 'CURRICULA', 'VITAE',
      ],
    ],
    optional: ['CODIGO', 'COD', 'NUMERO', 'N', 'NOME', 'CV', 'CURRICULO', 'CURRICULOS', 'DOCUMENTO'],
    forbidden: FIELDS.document.forbidden,
  };

  // Índices pré-normalizados: comparação de cabeçalho é caminho quente.
  for (const field of Object.values(FIELDS)) {
    field.exactSet = new Set(field.exact.map(normalizeHeader));
    field.tokenSets = field.exact.map((text) => headerTokens(text).sort().join(' '));
    field.tokenSetIndex = new Set(field.tokenSets);
    field.forbiddenSet = new Set(field.forbidden);
    field.optionalSet = new Set(field.optional);
  }

  /** Pontua o quanto `text` representa `kind`, de 0 a 100. */
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

    if (field.tokenSetIndex.has(tokens.slice().sort().join(' '))) return 95;

    for (const group of field.required) {
      if (!group.some((token) => tokens.includes(token))) return 0;
    }

    const useful = tokens.filter(
      (token) => field.optionalSet.has(token) || field.required.some((group) => group.includes(token))
    ).length;
    const noise = tokens.length - useful;
    return Math.max(55, 88 - noise * 8);
  }

  function isPostingDateHeader(text) {
    return scoreHeader('datePosting', text) >= 55;
  }

  function isEffectiveDateHeader(text) {
    return scoreHeader('dateEffective', text) >= 55;
  }

  function isGrdtDateHeader(text) {
    return scoreHeader('dateGrdt', text) >= 55;
  }

  function isRelationDateHeader(text) {
    return scoreHeader('relationDate', text) >= 55;
  }

  function isConferenceDateHeader(text) {
    return scoreHeader('conferenceDate', text) >= 55;
  }

  const PROFILES = {
    relation: {
      document: 'document',
      grdt: 'grdt',
      date: 'relationDate',
      dateGrdt: 'dateGrdt',
      revision: 'revision',
    },
    relationConference: {
      document: 'document',
      grdt: 'grdt',
      date: 'conferenceDate',
      dateGrdt: 'dateGrdt',
      revision: 'revisionSent',
      conference: 'conferenceStatus',
      sigemStatus: 'sigemStatus',
    },
    ld: { document: 'document', grdt: 'grdt', date: 'dateEffective', revision: 'revision' },
    ldCv: { document: 'documentCv', grdt: 'grdt', date: 'dateEffective', revision: 'revision' },
  };

  const SHEET_ROLES = {
    cv: {
      label: 'CV (currículos)',
      short: 'CV',
      tokens: ['CV', 'CVS', 'CURRICULO', 'CURRICULOS', 'CURRICULUM', 'CURRICULUMS', 'CURRICULA', 'VITAE'],
    },
    documentos: {
      label: 'Documentos',
      short: 'Documentos',
      tokens: ['DOCUMENTO', 'DOCUMENTOS', 'LD', 'LISTA', 'DADOS'],
    },
  };

  for (const role of Object.values(SHEET_ROLES)) role.tokenSet = new Set(role.tokens);

  function classifySheet(name) {
    const tokens = headerTokens(name);
    if (!tokens.length) return null;
    if (tokens.some((token) => SHEET_ROLES.cv.tokenSet.has(token))) return 'cv';
    if (tokens.some((token) => SHEET_ROLES.documentos.tokenSet.has(token))) return 'documentos';
    return null;
  }

  function sheetRoleLabel(role) {
    return SHEET_ROLES[role] ? SHEET_ROLES[role].label : '';
  }

  function profileForSheet(profile, role) {
    return profile === 'ld' && role === 'cv' ? 'ldCv' : profile || 'ld';
  }

  const CORE_SLOTS = ['document', 'grdt', 'date'];
  const WEIGHTS = {
    document: 1.4,
    grdt: 1.0,
    date: 1.2,
    dateGrdt: 0.35,
    revision: 0.7,
    conference: 1.4,
    sigemStatus: 0.35,
  };
  const MAX_HEADER_SCAN_ROWS = 80;
  const MAX_HEADER_SCAN_COLS = 200;

  /**
   * Varre as primeiras linhas procurando a combinação (linha, colunas) com
   * maior pontuação agregada. Funciona com título, logotipo e linhas vazias
   * antes do cabeçalho real e não depende da posição física das colunas.
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

      for (const [slot, score] of Object.entries(scores)) total += score * (WEIGHTS[slot] || 0.5);
      total -= row * 0.01;
      if (total > best.score) best = { headerRow: row, score: total, columns, scores };
    }

    const found = CORE_SLOTS.filter((slot) => best.columns[slot]).length;
    return {
      headerRow: best.headerRow,
      documentCol: best.columns.document || null,
      grdtCol: best.columns.grdt || null,
      dateCol: best.columns.date || null,
      dateEffectiveCol: best.columns.date || null,
      dateGrdtCol: best.columns.dateGrdt || null,
      revisionCol: best.columns.revision || null,
      conferenceCol: best.columns.conference || null,
      sigemStatusCol: best.columns.sigemStatus || null,
      columns: { ...best.columns },
      fieldScores: best.scores,
      score: best.score,
      matchedFields: found,
      confidence: found === 3 ? 'alta' : found === 2 ? 'media' : 'baixa',
    };
  }

  /**
   * Decide automaticamente qual das duas relações do GRCON foi carregada.
   * A assinatura da Conferência exige os campos exclusivos desse relatório;
   * isso evita classificar um Histórico comum como Conferência por acidente.
   */
  function detectRelation(getValue, maxRow, maxCol) {
    const history = detect(getValue, maxRow, maxCol, 'relation');
    const conference = detect(getValue, maxRow, maxCol, 'relationConference');

    const conferenceSignature = !!(
      conference.documentCol &&
      conference.grdtCol &&
      conference.conferenceCol &&
      (conference.revisionCol || conference.dateCol || conference.dateGrdtCol)
    );

    if (conferenceSignature) {
      const dateEffectiveCol = conference.dateCol || null;
      const dateGrdtCol = conference.dateGrdtCol || null;
      const resolvedDateCol = dateEffectiveCol || dateGrdtCol || null;
      const required = [
        conference.documentCol,
        conference.grdtCol,
        resolvedDateCol,
        conference.revisionCol,
        conference.conferenceCol,
      ].filter(Boolean).length;
      return {
        ...conference,
        dateCol: resolvedDateCol,
        dateEffectiveCol,
        dateGrdtCol,
        dateFallback: !dateEffectiveCol && !!dateGrdtCol,
        relationType: 'conference',
        sourceLabel: 'Conferência Histórico × Consulta Geral',
        sourceShortLabel: 'Conferência',
        sourceDateLabel: dateEffectiveCol
          ? 'Data efetiva / confirmação'
          : dateGrdtCol
            ? 'Data da GRDT (fallback legado)'
            : 'Data efetiva / confirmação',
        confidence: required === 5 ? 'alta' : required >= 4 ? 'media' : 'baixa',
      };
    }

    return {
      ...history,
      dateEffectiveCol: null,
      dateGrdtCol: history.dateGrdtCol || (history.dateCol && isGrdtDateHeader(getValue(history.headerRow, history.dateCol)) ? history.dateCol : null),
      dateFallback: false,
      relationType: 'history',
      sourceLabel: 'Histórico GRCON',
      sourceShortLabel: 'Histórico',
      sourceDateLabel: 'Data da geração / postagem',
    };
  }

  V.headers = {
    FIELDS,
    SHEET_ROLES,
    PROFILES,
    scoreHeader,
    detect,
    detectRelation,
    classifySheet,
    sheetRoleLabel,
    profileForSheet,
    isPostingDateHeader,
    isEffectiveDateHeader,
    isGrdtDateHeader,
    isRelationDateHeader,
    isConferenceDateHeader,
  };
})(typeof self !== 'undefined' ? self : this);
