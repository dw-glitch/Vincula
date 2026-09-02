/**
 * Vincula — leitor/gravador XLSX orientado a offsets.
 *
 * Arquitetura: o XML de cada aba nunca vira DOM. Ele é varrido uma única vez
 * por um scanner linear que registra apenas os deslocamentos (start/end) de
 * cada linha e das células das colunas de interesse. A gravação não reescreve
 * o documento: ela recorta e emenda exclusivamente os intervalos autorizados.
 *
 * Consequências práticas:
 *  - memória proporcional às colunas usadas, não à planilha inteira;
 *  - tudo que não foi emendado permanece byte a byte idêntico ao original —
 *    fórmulas, proteção, filtros, validações, comentários, mesclagens,
 *    formatação condicional e estilos sobrevivem por construção;
 *  - o rollback é trivial: enquanto o commit não ocorre, o ZIP original está
 *    intacto e basta descartar a lista de emendas.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { squash, escapeXml, unescapeXml, parseAttrs, readAttr, indexToColumn, refCol, refRow, parseRanges, rangesContain } = V.util;
  const D = V.dates;

  const MAX_COLS = 16384;
  const cellKey = (row, col) => row * MAX_COLS + col;

  function requireJSZip() {
    const Z = scope.JSZip;
    if (!Z) throw new Error('JSZip não está disponível neste contexto.');
    return Z;
  }

  async function readText(zip, path) {
    const file = zip.file(path);
    if (!file) return null;
    return file.async('string');
  }

  /* ================================================================== *
   * sharedStrings
   * ================================================================== */

  const SI_RE = /<si\b[^>]*(?:\/>|>([\s\S]*?)<\/si>)/g;
  const T_SOURCE = '<t\\b[^>]*(?:\\/>|>([\\s\\S]*?)<\\/t>)';

  function extractText(fragment) {
    if (!fragment) return '';
    // Guias fonéticas (<rPh>) não fazem parte do texto visível da célula.
    const clean = fragment.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
    // Regex local: extractText é chamado de dentro de outras varreduras.
    const re = new RegExp(T_SOURCE, 'g');
    let out = '';
    let m;
    while ((m = re.exec(clean))) out += m[1] ? unescapeXml(m[1]) : '';
    return out;
  }

  function parseSharedStrings(xml) {
    const table = [];
    if (!xml) return table;
    SI_RE.lastIndex = 0;
    let m;
    while ((m = SI_RE.exec(xml))) table.push(extractText(m[1]));
    return table;
  }

  /* ================================================================== *
   * styles.xml
   * ================================================================== */

  const NUMFMT_RE = /<numFmt\b([^>]*)\/?>/g;
  const XF_RE = /<xf\b([^>]*?)(\/>|>[\s\S]*?<\/xf>)/g;

  function parseStyles(xml) {
    const styles = {
      xml: xml || null,
      available: !!xml,
      numFmts: new Map(),
      cellXfs: [],
      addedXfs: [],
      addedNumFmts: [],
      dateStyleIds: new Set(),
      dateOnlyStyleIds: new Set(),
      dateStyleCache: new Map(),
      dateNumFmtId: null,
      baseXfCount: 0,
      baseDateNumFmtId: null,
      dirty: false,
    };
    if (!xml) return styles;

    NUMFMT_RE.lastIndex = 0;
    let m;
    while ((m = NUMFMT_RE.exec(xml))) {
      const attrs = parseAttrs(m[1]);
      styles.numFmts.set(Number(attrs.numFmtId), unescapeXml(attrs.formatCode || ''));
      if (D.isDateFormatCode(unescapeXml(attrs.formatCode || '')) && styles.dateNumFmtId === null) {
        // Reaproveita um formato de data já declarado na pasta de trabalho.
        const code = unescapeXml(attrs.formatCode || '').toLowerCase();
        if (code === 'dd/mm/yyyy' || code === 'dd/mm/yy') styles.dateNumFmtId = Number(attrs.numFmtId);
      }
    }

    // cellXfs é o bloco relevante: é ele que o atributo `s` da célula indexa.
    const block = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml);
    if (block) {
      XF_RE.lastIndex = 0;
      let x;
      while ((x = XF_RE.exec(block[1]))) {
        const attrs = parseAttrs(x[1]);
        const numFmtId = Number(attrs.numFmtId || 0);
        const formatCode = styles.numFmts.get(numFmtId);
        const index = styles.cellXfs.length;
        styles.cellXfs.push({ raw: x[0], numFmtId });
        if (D.isDateStyle(numFmtId, formatCode)) styles.dateStyleIds.add(index);
        if (D.isDateOnlyStyle(numFmtId, formatCode)) styles.dateOnlyStyleIds.add(index);
      }
    }

    // Fronteira entre o que veio do arquivo e o que o Vincula acrescenta:
    // é por ela que o rollback sabe o que desfazer.
    styles.baseXfCount = styles.cellXfs.length;
    styles.baseDateNumFmtId = styles.dateNumFmtId;
    return styles;
  }

  /** A célula é lida como data — inclusive quando o formato traz hora junto. */
  function isDateStyleId(styles, styleId) {
    return styles.dateStyleIds.has(Number(styleId || 0));
  }

  /** A célula exibe data *pura*, sem resíduo de hora. */
  function isDateOnlyStyleId(styles, styleId) {
    return styles.dateOnlyStyleIds.has(Number(styleId || 0));
  }

  function allocateDateNumFmt(styles) {
    if (styles.dateNumFmtId !== null) return styles.dateNumFmtId;
    let next = 164;
    for (const id of styles.numFmts.keys()) if (id >= next) next = id + 1;
    styles.dateNumFmtId = next;
    styles.numFmts.set(next, 'dd/mm/yyyy');
    styles.addedNumFmts.push(`<numFmt numFmtId="${next}" formatCode="dd/mm/yyyy"/>`);
    styles.dirty = true;
    return next;
  }

  /**
   * Devolve um styleId que exibe a célula como data preservando o restante da
   * formatação de origem (fonte, preenchimento, bordas, alinhamento).
   *
   * Só um formato de data *pura* é mantido intacto. Um formato com hora —
   * "dd/mm/yyyy hh:mm:ss", o embutido 22 — é substituído por dd/mm/yyyy: o
   * serial já é meia-noite, e mantê-lo faria o Excel exibir a data com o
   * "00:00:00" pendurado, que é exatamente o resíduo que o sistema proíbe.
   */
  function ensureDateStyle(styles, sourceStyleId) {
    const source = Number(sourceStyleId || 0);
    if (!styles.available) return { styleId: source, changed: false, supported: false };
    if (isDateOnlyStyleId(styles, source)) return { styleId: source, changed: false, supported: true };
    if (styles.dateStyleCache.has(source)) {
      return { styleId: styles.dateStyleCache.get(source), changed: false, supported: true };
    }

    const numFmtId = allocateDateNumFmt(styles);
    const base = styles.cellXfs[source];
    let raw;
    if (base) {
      raw = base.raw
        .replace(/\snumFmtId\s*=\s*"[^"]*"/, '')
        .replace(/\sapplyNumberFormat\s*=\s*"[^"]*"/, '')
        .replace(/^<xf\b/, `<xf numFmtId="${numFmtId}" applyNumberFormat="1"`);
    } else {
      raw = `<xf numFmtId="${numFmtId}" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>`;
    }

    const styleId = styles.cellXfs.length;
    styles.cellXfs.push({ raw, numFmtId });
    styles.addedXfs.push(raw);
    styles.dateStyleIds.add(styleId);
    styles.dateOnlyStyleIds.add(styleId);
    styles.dateStyleCache.set(source, styleId);
    styles.dirty = true;
    return { styleId, changed: true, supported: true };
  }

  /** Reescreve styles.xml acrescentando (nunca removendo) formatos e estilos. */
  function serializeStyles(styles) {
    if (!styles.dirty || !styles.xml) return null;
    let xml = styles.xml;

    if (styles.addedNumFmts.length) {
      const block = styles.addedNumFmts.join('');
      const open = /<numFmts\b([^>]*)>/.exec(xml);
      const selfClosing = /<numFmts\b([^>]*)\/>/.exec(xml);
      if (open && !/\/>$/.test(open[0])) {
        const count = Number(readAttr(open[1], 'count') || 0) + styles.addedNumFmts.length;
        xml = xml.replace(open[0], `<numFmts count="${count}">`).replace('</numFmts>', block + '</numFmts>');
      } else if (selfClosing) {
        const count = Number(readAttr(selfClosing[1], 'count') || 0) + styles.addedNumFmts.length;
        xml = xml.replace(selfClosing[0], `<numFmts count="${count}">${block}</numFmts>`);
      } else {
        // numFmts é o primeiro filho de styleSheet no schema.
        xml = xml.replace(
          /(<styleSheet\b[^>]*>)/,
          `$1<numFmts count="${styles.addedNumFmts.length}">${block}</numFmts>`
        );
      }
    }

    if (styles.addedXfs.length) {
      const open = /<cellXfs\b([^>]*)>/.exec(xml);
      if (!open) return null;
      const count = styles.cellXfs.length;
      xml = xml
        .replace(open[0], open[0].replace(/count\s*=\s*"[^"]*"/, `count="${count}"`))
        .replace('</cellXfs>', styles.addedXfs.join('') + '</cellXfs>');
    }

    return xml;
  }

  /* ================================================================== *
   * Abertura da pasta de trabalho
   * ================================================================== */

  function resolvePath(basePath, target) {
    if (!target) return null;
    if (target[0] === '/') return target.slice(1);
    const parts = basePath.split('/');
    parts.pop();
    for (const piece of target.split('/')) {
      if (piece === '..') parts.pop();
      else if (piece && piece !== '.') parts.push(piece);
    }
    return parts.join('/');
  }

  const RELATIONSHIP_RE = /<Relationship\b([^>]*)\/?>/g;
  const SHEET_RE = /<sheet\b([^>]*)\/?>/g;

  async function open(bytes, name) {
    const JSZipRef = requireJSZip();
    const zip = await JSZipRef.loadAsync(bytes);

    const rootRels = await readText(zip, '_rels/.rels');
    let workbookPath = 'xl/workbook.xml';
    if (rootRels) {
      RELATIONSHIP_RE.lastIndex = 0;
      let m;
      while ((m = RELATIONSHIP_RE.exec(rootRels))) {
        const attrs = parseAttrs(m[1]);
        if (/officeDocument$/.test(attrs.Type || '')) {
          // Em _rels/.rels o dono da relação é a raiz do pacote, não a pasta.
          workbookPath = resolvePath('', attrs.Target) || workbookPath;
          break;
        }
      }
    }

    const workbookXml = await readText(zip, workbookPath);
    if (!workbookXml) throw new Error('Arquivo inválido: xl/workbook.xml não encontrado.');

    const relsPath = resolvePath(workbookPath, '_rels/' + workbookPath.split('/').pop() + '.rels');
    const relsXml = await readText(zip, relsPath);
    const rels = new Map();
    if (relsXml) {
      RELATIONSHIP_RE.lastIndex = 0;
      let m;
      while ((m = RELATIONSHIP_RE.exec(relsXml))) {
        const attrs = parseAttrs(m[1]);
        rels.set(attrs.Id, attrs.Target);
      }
    }

    const workbookPr = /<workbookPr\b([^>]*)\/?>/.exec(workbookXml);
    const date1904 = workbookPr ? /^(1|true)$/i.test(readAttr(workbookPr[1], 'date1904') || '') : false;

    const sheets = [];
    SHEET_RE.lastIndex = 0;
    let s;
    while ((s = SHEET_RE.exec(workbookXml))) {
      const attrs = parseAttrs(s[1]);
      const relId = attrs['r:id'] || attrs['relationships:id'] || attrs.id;
      const target = rels.get(relId);
      if (!target) continue;
      sheets.push({
        name: unescapeXml(attrs.name || `Planilha${sheets.length + 1}`),
        path: resolvePath(workbookPath, target),
        hidden: attrs.state === 'hidden' || attrs.state === 'veryHidden',
        scanned: false,
        maxRow: 0,
        maxCol: 0,
      });
    }
    if (!sheets.length) throw new Error('A pasta de trabalho não possui abas legíveis.');

    let sharedStrings = parseSharedStrings(await readText(zip, 'xl/sharedStrings.xml'));
    const styles = parseStyles(await readText(zip, 'xl/styles.xml'));

    return {
      name,
      zip,
      workbookPath,
      date1904,
      sharedStrings,
      styles,
      sheets,
      pendingParts: new Map(),
      snapshots: new Map(),
    };
  }

  function findSheet(wb, pathOrName) {
    return (
      wb.sheets.find((s) => s.path === pathOrName) ||
      wb.sheets.find((s) => s.name === pathOrName) ||
      null
    );
  }

  /* ================================================================== *
   * Scanner de aba
   * ================================================================== */

  // row aberto | row fechado | célula completa (com ou sem filhos)
  const SCAN_RE = /<row\b([^>]*?)(\/>|>)|<\/row>|<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const V_RE = /<v\b[^>]*(?:\/>|>([\s\S]*?)<\/v>)/;
  const F_RE = /<f\b[^>]*(?:\/>|>([\s\S]*?)<\/f>)/;

  function decodeCell(wb, attrs, inner) {
    const type = attrs.t || '';
    const styleId = Number(attrs.s || 0);
    let value = '';
    let numeric = null;

    if (inner) {
      if (type === 'inlineStr') {
        value = extractText(inner);
      } else if (type === 'e' || type === 'str' || type === 'b' || type === 's' || type === '' || type === 'n') {
        const vm = V_RE.exec(inner);
        const raw = vm ? unescapeXml(vm[1] || '') : '';
        if (type === 's') {
          value = wb.sharedStrings[Number(raw)] ?? '';
        } else if (type === 'b') {
          value = raw === '1' ? 'VERDADEIRO' : 'FALSO';
        } else if (type === 'e' || type === 'str') {
          value = raw;
        } else {
          value = raw;
          if (raw !== '') {
            const n = Number(raw);
            if (Number.isFinite(n)) numeric = n;
          }
        }
      }
    }

    const hasFormula = !!inner && F_RE.test(inner);
    const isDate = numeric !== null && isDateStyleId(wb.styles, styleId);
    return { type, styleId, value, numeric, hasFormula, isDate };
  }

  /** Texto exibido pela célula — datas normalizadas para dd/mm/aaaa. */
  function cellDisplay(cell) {
    if (!cell) return '';
    if (cell.isDate) return D.formatDate(D.serialToDate(D.truncateSerial(cell.numeric), cell.date1904));
    if (cell.numeric !== null) return String(cell.numeric);
    return squash(cell.value);
  }

  /**
   * Varre o XML da aba construindo o modelo mínimo necessário.
   *
   * @param {object} wb
   * @param {string} xml
   * @param {{maxRows?:number, columns?:number[]}} options
   *   columns ausente ⇒ todas as colunas (usado só na amostra de cabeçalho).
   */
  function scanSheet(wb, xml, options = {}) {
    const wanted = options.columns && options.columns.length ? new Set(options.columns.filter(Boolean)) : null;
    const rowLimit = options.maxRows || Infinity;

    const rows = new Map();
    const cells = new Map();
    let maxRow = 0;
    let maxCol = 0;

    let current = null;
    let autoRow = 0;
    let autoCol = 0;

    SCAN_RE.lastIndex = 0;
    let m;
    while ((m = SCAN_RE.exec(xml))) {
      if (m[1] !== undefined) {
        // <row ...>
        const attrs = parseAttrs(m[1]);
        const num = attrs.r ? Number(attrs.r) : ++autoRow;
        autoRow = num;
        autoCol = 0;
        if (num > rowLimit) break;
        current = {
          num,
          elemStart: m.index,
          bodyStart: m.index + m[0].length,
          closeStart: m[2] === '/>' ? m.index + m[0].length : -1,
          elemEnd: m[2] === '/>' ? m.index + m[0].length : -1,
          selfClosed: m[2] === '/>',
        };
        rows.set(num, current);
        if (num > maxRow) maxRow = num;
        continue;
      }

      if (m[0] === '</row>') {
        if (current) {
          current.closeStart = m.index;
          current.elemEnd = m.index + 6;
          current = null;
        }
        continue;
      }

      // <c ...>
      if (!current) continue;
      const attrsRaw = m[3];
      const ref = readAttr(attrsRaw, 'r');
      const col = ref ? refCol(ref) : ++autoCol;
      autoCol = col;
      if (col > maxCol) maxCol = col;
      if (wanted && !wanted.has(col)) continue;

      const attrs = parseAttrs(attrsRaw);
      const row = ref ? refRow(ref) : current.num;
      const decoded = decodeCell(wb, attrs, m[4]);
      cells.set(cellKey(row, col), {
        ref: ref || indexToColumn(col) + row,
        row,
        col,
        start: m.index,
        end: m.index + m[0].length,
        attrs,
        date1904: wb.date1904,
        ...decoded,
      });
    }

    return { xml, rows, cells, maxRow, maxCol, columns: options.columns || null };
  }

  function getCell(model, row, col) {
    return model.cells.get(cellKey(row, col)) || null;
  }

  function textAt(model, row, col) {
    return cellDisplay(getCell(model, row, col));
  }

  /* ================================================================== *
   * Guardas da aba: proteção, validações, mesclagens
   * ================================================================== */

  function readGuards(xml) {
    const dataStart = xml.indexOf('<sheetData');
    const dataEnd = xml.indexOf('</sheetData>');
    const head = dataStart >= 0 ? xml.slice(0, dataStart) : '';
    const tail = dataEnd >= 0 ? xml.slice(dataEnd + 12) : xml;
    const outside = head + tail;

    const protection = /<sheetProtection\b([^>]*)\/?>/.exec(outside);
    const merges = [];
    const mergeRe = /<mergeCell\b[^>]*ref="([^"]+)"/g;
    let m;
    while ((m = mergeRe.exec(outside))) merges.push(...parseRanges(m[1]));

    const validations = [];
    const dvRe = /<(?:\w+:)?dataValidation\b([^>]*)>?/g;
    while ((m = dvRe.exec(outside))) {
      const sqref = readAttr(m[1], 'sqref');
      if (sqref) validations.push({ type: readAttr(m[1], 'type') || 'any', ranges: parseRanges(sqref) });
    }
    // x14:dataValidation guarda o intervalo em <xm:sqref>.
    const xmRe = /<xm:sqref>([\s\S]*?)<\/xm:sqref>/g;
    while ((m = xmRe.exec(outside))) validations.push({ type: 'x14', ranges: parseRanges(m[1]) });

    const conditional = [];
    const cfRe = /<conditionalFormatting\b[^>]*sqref="([^"]+)"/g;
    while ((m = cfRe.exec(outside))) conditional.push(...parseRanges(m[1]));

    return {
      protected: !!protection,
      protectionAttrs: protection ? parseAttrs(protection[1]) : null,
      merges,
      validations,
      conditional,
      hasAutoFilter: /<autoFilter\b/.test(outside),
    };
  }

  /** Diagnóstico da célula-alvo antes de qualquer escrita. */
  function inspectTarget(model, guards, row, col) {
    const cell = getCell(model, row, col);
    const notes = [];
    let blocked = null;

    if (cell && cell.hasFormula) {
      blocked = 'FORMULA';
      notes.push('Célula de destino contém fórmula; alteração não aplicada para preservar o cálculo.');
    }
    if (guards.merges.length && rangesContain(guards.merges, row, col)) {
      blocked = blocked || 'MESCLADA';
      notes.push('Célula de destino pertence a um intervalo mesclado; alteração não aplicada.');
    }
    if (guards.protected) notes.push('Aba protegida no Excel; a alteração é gravada no arquivo gerado.');
    for (const dv of guards.validations) {
      if (rangesContain(dv.ranges, row, col)) {
        notes.push(`Célula sob validação de dados (${dv.type}); conteúdo original da validação preservado.`);
        break;
      }
    }
    if (!model.rows.has(row)) {
      blocked = blocked || 'LINHA_AUSENTE';
      notes.push('Linha inexistente no XML da aba; alteração não aplicada.');
    }

    return { cell, blocked, notes };
  }

  /* ================================================================== *
   * Edição por emenda de intervalos
   * ================================================================== */

  function createEditor(wb, model, guards) {
    const edits = [];
    const authorized = new Set();

    function buildCellXml(ref, attrs, body, typeAttr) {
      let out = `<c r="${ref}"`;
      for (const [key, value] of Object.entries(attrs)) {
        if (key === 'r' || key === 't') continue;
        out += ` ${key}="${escapeXml(value)}"`;
      }
      if (typeAttr) out += ` t="${typeAttr}"`;
      return body ? `${out}>${body}</c>` : `${out}/>`;
    }

    /** Descobre onde inserir uma célula ausente, respeitando a ordem colunar. */
    function insertionPoint(row, col) {
      const rowModel = model.rows.get(row);
      if (!rowModel || rowModel.closeStart < 0) return null;
      const body = model.xml.slice(rowModel.bodyStart, rowModel.closeStart);
      const re = /<c\b[^>]*?r="([A-Z]+\d+)"/g;
      let m;
      while ((m = re.exec(body))) {
        if (refCol(m[1]) > col) return rowModel.bodyStart + m.index;
      }
      return rowModel.closeStart;
    }

    /** Estilo provável da coluna, para células que ainda não existem. */
    function columnStyleHint(row, col) {
      for (let probe = row - 1; probe >= 1 && probe > row - 50; probe--) {
        const cell = getCell(model, probe, col);
        if (cell) return Number(cell.attrs.s || 0);
      }
      for (let probe = row + 1; probe <= model.maxRow && probe < row + 50; probe++) {
        const cell = getCell(model, probe, col);
        if (cell) return Number(cell.attrs.s || 0);
      }
      return 0;
    }

    function pushEdit(row, col, ref, cell, attrs, body, typeAttr) {
      const xml = buildCellXml(ref, attrs, body, typeAttr);
      if (cell) {
        edits.push({ start: cell.start, end: cell.end, text: xml });
      } else {
        const at = insertionPoint(row, col);
        if (at === null) return false;
        edits.push({ start: at, end: at, text: xml });
      }
      authorized.add(ref);
      return true;
    }

    /**
     * Grava texto preservando o estilo da célula. Quando o valor é claramente
     * numérico e a célula original também era, o tipo numérico é mantido para
     * não transformar a coluna em texto.
     */
    function writeText(row, col, value) {
      const ref = indexToColumn(col) + row;
      const cell = getCell(model, row, col);
      const attrs = cell ? { ...cell.attrs } : {};
      if (!cell) {
        const hint = columnStyleHint(row, col);
        if (hint) attrs.s = String(hint);
      }
      const text = String(value ?? '');
      const numericLike = /^-?\d{1,15}$/.test(text);
      const keepNumeric = numericLike && cell && cell.numeric !== null && !cell.isDate;

      if (keepNumeric) return pushEdit(row, col, ref, cell, attrs, `<v>${text}</v>`, '');
      return pushEdit(row, col, ref, cell, attrs, `<is><t xml:space="preserve">${escapeXml(text)}</t></is>`, 'inlineStr');
    }

    /**
     * Grava data como data real do Excel: serial numérico à meia-noite mais um
     * estilo com formato de data. Nunca grava texto, nunca grava fração de dia.
     */
    function writeDate(row, col, date) {
      const serial = D.dateToSerial(date, wb.date1904);
      if (serial === null) return false;
      const ref = indexToColumn(col) + row;
      const cell = getCell(model, row, col);
      const attrs = cell ? { ...cell.attrs } : {};
      const sourceStyle = cell ? Number(cell.attrs.s || 0) : columnStyleHint(row, col);
      const style = ensureDateStyle(wb.styles, sourceStyle);
      if (style.supported) attrs.s = String(style.styleId);
      else if (sourceStyle) attrs.s = String(sourceStyle);
      return pushEdit(row, col, ref, cell, attrs, `<v>${serial}</v>`, '');
    }

    /** Aplica todas as emendas de uma vez, da esquerda para a direita. */
    function render() {
      if (!edits.length) return model.xml;
      const ordered = edits.slice().sort((a, b) => a.start - b.start || a.end - b.end);
      let out = '';
      let cursor = 0;
      for (const edit of ordered) {
        if (edit.start < cursor) throw new Error('Emendas sobrepostas detectadas — gravação abortada.');
        out += model.xml.slice(cursor, edit.start) + edit.text;
        cursor = edit.end;
      }
      return out + model.xml.slice(cursor);
    }

    return { edits, authorized, writeText, writeDate, render, guards };
  }

  /* ================================================================== *
   * Auditoria de integridade
   * ================================================================== */

  const CELL_ONLY_SOURCE = '<c\\b[^>]*?(?:\\/>|>[\\s\\S]*?<\\/c>)';
  const CELL_ONLY_RE = new RegExp(CELL_ONLY_SOURCE, 'g');

  /**
   * Cada iterador recebe seu próprio RegExp: as duas varreduras (antes e
   * depois) avançam em paralelo e não podem compartilhar `lastIndex`.
   */
  function* iterateCells(xml) {
    const re = new RegExp(CELL_ONLY_SOURCE, 'g');
    let m;
    while ((m = re.exec(xml))) {
      const ref = readAttr(m[0], 'r');
      yield {
        ref,
        key: ref ? refRow(ref) * MAX_COLS + refCol(ref) : -1,
        text: m[0],
      };
    }
  }

  /**
   * Compara o XML antes e depois em dois níveis:
   *  1. esqueleto (tudo que não é célula) — precisa ser idêntico, o que
   *     garante proteção, filtros, mesclagens, validações e formatação
   *     condicional intactos;
   *  2. célula a célula, em varredura casada — qualquer divergência fora do
   *     conjunto autorizado é violação.
   *
   * Consome memória constante: os iteradores avançam em paralelo.
   */
  function verifyIntegrity(beforeXml, afterXml, authorizedRefs) {
    const violations = [];
    if (beforeXml === afterXml) return { ok: true, violations, comparedCells: 0 };

    const skeletonBefore = beforeXml.replace(CELL_ONLY_RE, '');
    const skeletonAfter = afterXml.replace(CELL_ONLY_RE, '');
    if (skeletonBefore !== skeletonAfter) {
      violations.push({ ref: null, reason: 'Estrutura da aba (fora das células) foi alterada.' });
    }

    const a = iterateCells(beforeXml);
    const b = iterateCells(afterXml);
    let left = a.next();
    let right = b.next();
    let compared = 0;

    while (!left.done && !right.done) {
      const x = left.value;
      const y = right.value;
      if (x.key === y.key) {
        compared++;
        if (x.text !== y.text && !authorizedRefs.has(x.ref)) {
          violations.push({ ref: x.ref, reason: 'Célula alterada fora das colunas autorizadas.' });
        }
        left = a.next();
        right = b.next();
      } else if (x.key < y.key) {
        violations.push({ ref: x.ref, reason: 'Célula removida do arquivo original.' });
        left = a.next();
      } else {
        if (!authorizedRefs.has(y.ref)) {
          violations.push({ ref: y.ref, reason: 'Célula criada fora das colunas autorizadas.' });
        }
        right = b.next();
      }
      if (violations.length > 50) break;
    }
    while (!left.done) {
      violations.push({ ref: left.value.ref, reason: 'Célula removida do arquivo original.' });
      left = a.next();
      if (violations.length > 50) break;
    }
    while (!right.done) {
      if (!authorizedRefs.has(right.value.ref)) {
        violations.push({ ref: right.value.ref, reason: 'Célula criada fora das colunas autorizadas.' });
      }
      right = b.next();
      if (violations.length > 50) break;
    }

    return { ok: violations.length === 0, violations, comparedCells: compared };
  }

  /* ================================================================== *
   * Commit e empacotamento
   * ================================================================== */

  /** Registra a nova versão de uma parte, guardando o original para rollback. */
  function stagePart(wb, path, xml) {
    if (!wb.snapshots.has(path)) wb.snapshots.set(path, null); // marcador de parte tocada
    wb.pendingParts.set(path, xml);
  }

  async function commit(wb, options = {}) {
    const styleXml = serializeStyles(wb.styles);
    if (styleXml) wb.pendingParts.set('xl/styles.xml', styleXml);
    for (const [path, xml] of wb.pendingParts) wb.zip.file(path, xml);
    wb.pendingParts.clear();

    const bytes = await wb.zip.generateAsync({
      type: 'uint8array',
      compression: 'DEFLATE',
      compressionOptions: { level: options.level ?? 9 },
      mimeType: options.mimeType,
    });
    return bytes;
  }

  /**
   * Devolve styles.xml ao estado de leitura: os xf e o numFmt criados durante
   * a gravação somem. Sem isso, uma segunda tentativa no mesmo arquivo
   * apontaria para estilos que o rollback já tinha deixado de fora do pacote.
   */
  function resetAddedStyles(styles) {
    if (!styles) return;
    for (let id = styles.cellXfs.length - 1; id >= styles.baseXfCount; id--) {
      styles.dateStyleIds.delete(id);
      styles.dateOnlyStyleIds.delete(id);
    }
    styles.cellXfs.length = styles.baseXfCount;
    if (styles.dateNumFmtId !== styles.baseDateNumFmtId) {
      styles.numFmts.delete(styles.dateNumFmtId);
      styles.dateNumFmtId = styles.baseDateNumFmtId;
    }
    styles.addedXfs.length = 0;
    styles.addedNumFmts.length = 0;
    styles.dateStyleCache.clear();
    styles.dirty = false;
  }

  /** Descarta emendas pendentes: o ZIP original permanece como estava. */
  function rollback(wb) {
    wb.pendingParts.clear();
    resetAddedStyles(wb.styles);
  }

  function close(wb) {
    wb.zip = null;
    wb.sharedStrings = null;
    wb.styles = null;
    wb.pendingParts = null;
    wb.snapshots = null;
    wb.sheets = [];
  }

  async function readSheetXml(wb, sheet) {
    const xml = await readText(wb.zip, sheet.path);
    if (xml === null) throw new Error(`Aba ausente no pacote: ${sheet.path}`);
    return xml;
  }

  V.xlsx = {
    open,
    close,
    findSheet,
    readSheetXml,
    scanSheet,
    getCell,
    textAt,
    cellDisplay,
    readGuards,
    inspectTarget,
    createEditor,
    verifyIntegrity,
    stagePart,
    commit,
    rollback,
    parseSharedStrings,
    parseStyles,
    ensureDateStyle,
    isDateStyleId,
    isDateOnlyStyleId,
  };
})(typeof self !== 'undefined' ? self : this);
