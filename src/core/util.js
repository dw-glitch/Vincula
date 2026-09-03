/**
 * Vincula — utilitários compartilhados.
 * Carregado tanto na página quanto dentro dos Web Workers (via importScripts),
 * por isso o módulo se apoia apenas em `self` e não toca no DOM.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});

  V.VERSION = '2.2.0';
  V.APP_NAME = 'Vincula';

  /* ------------------------------------------------------------------ *
   * Normalização de texto
   * ------------------------------------------------------------------ */

  /** Colapsa espaços (inclusive NBSP), quebras de linha e tabulações. */
  function squash(value) {
    return String(value ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Remove acentuação mantendo o restante do texto. */
  function deaccent(value) {
    return squash(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }

  /**
   * Normalização de cabeçalho: caixa alta, sem acentos, sem pontuação
   * separadora. "Código do Documento" e "CODIGO-DO-DOCUMENTO" convergem.
   */
  function normalizeHeader(value) {
    return deaccent(value)
      .toUpperCase()
      .replace(/[._:;/\\|()\[\]{}"'`´^~°º-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /** Tokens significativos de um cabeçalho, sem palavras de ligação. */
  const STOP_WORDS = new Set(['DE', 'DA', 'DO', 'DAS', 'DOS', 'E', 'O', 'A', 'N', 'NO', 'NA', 'EM', 'POR']);
  function headerTokens(value) {
    return normalizeHeader(value)
      .split(' ')
      .filter((t) => t && !STOP_WORDS.has(t));
  }

  /**
   * Chave canônica de um documento. É a base do índice O(1), portanto
   * precisa ser estável: sem acentos, sem aspas, sem extensão .pdf,
   * traços unicode convertidos para hífen simples.
   */
  function normalizeDocument(value) {
    return squash(value)
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/^['"\s]+|['"\s]+$/g, '')
      .replace(/\.(pdf|xlsx|xlsm|docx|doc|tif|tiff|jpg|png)$/i, '')
      .toUpperCase();
  }

  /**
   * Chave "frouxa" de documento: parte da chave exata e ainda remove
   * pontuacao/espaco interno, alem do zero a esquerda de cada BLOCO
   * numerico original (separado por hifen, espaco, barra etc. antes de
   * juntar tudo). "REL-0001", "REL 001" e "REL1" convergem para "REL1".
   *
   * O zero e removido por segmento -- nao no texto ja colado -- para nao
   * colidir blocos que so parecem iguais depois de juntos: "007-042" e
   * "70-42" ficam "742" e "7042", diferentes, embora ambos virem "007042"
   * e "7042" se colados primeiro. Ainda assim, zero a esquerda as vezes E
   * parte do codigo; por isso esta chave nunca e o padrao, so entra em
   * jogo quando o usuario liga a correspondencia flexivel.
   */
  function looseDocumentKey(value) {
    const exact = normalizeDocument(value);
    if (!exact) return '';
    return exact
      .split(/[^A-Z0-9]+/)
      .filter(Boolean)
      .map((segment) => segment.replace(/^0+(?=\d)/, ''))
      .join('');
  }

  /* ------------------------------------------------------------------ *
   * Colunas do Excel
   * ------------------------------------------------------------------ */

  function columnToIndex(letters) {
    let n = 0;
    const s = String(letters).toUpperCase();
    for (let i = 0; i < s.length; i++) n = n * 26 + (s.charCodeAt(i) - 64);
    return n;
  }

  function indexToColumn(index) {
    let n = index;
    let out = '';
    while (n > 0) {
      n--;
      out = String.fromCharCode(65 + (n % 26)) + out;
      n = Math.floor(n / 26);
    }
    return out;
  }

  const REF_RE = /^([A-Z]+)(\d+)$/;
  function parseRef(ref) {
    const m = REF_RE.exec(String(ref || '').toUpperCase());
    return m ? { col: columnToIndex(m[1]), row: +m[2] } : null;
  }

  /** Só a parte numérica de uma referência — usado em varreduras quentes. */
  function refRow(ref) {
    let i = 0;
    while (i < ref.length && (ref.charCodeAt(i) < 48 || ref.charCodeAt(i) > 57)) i++;
    return +ref.slice(i);
  }

  /** Só a parte de coluna de uma referência, já convertida em índice. */
  function refCol(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const code = ref.charCodeAt(i);
      if (code >= 48 && code <= 57) break;
      n = n * 26 + (code - 64);
    }
    return n;
  }

  /* ------------------------------------------------------------------ *
   * Intervalos (sqref: "A1:C10 E4" etc.)
   * ------------------------------------------------------------------ */

  function parseRanges(sqref) {
    const out = [];
    for (const part of String(sqref || '').trim().split(/\s+/)) {
      if (!part) continue;
      const [a, b] = part.split(':');
      const from = parseRef(a);
      if (!from) continue;
      const to = b ? parseRef(b) : from;
      if (!to) continue;
      out.push({
        r1: Math.min(from.row, to.row),
        r2: Math.max(from.row, to.row),
        c1: Math.min(from.col, to.col),
        c2: Math.max(from.col, to.col),
      });
    }
    return out;
  }

  function rangesContain(ranges, row, col) {
    for (const r of ranges) {
      if (row >= r.r1 && row <= r.r2 && col >= r.c1 && col <= r.c2) return true;
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * XML / HTML
   * ------------------------------------------------------------------ */

  function escapeXml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;')
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
  }

  const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  function unescapeXml(value) {
    return String(value ?? '').replace(/&(?:(#x?[0-9a-fA-F]+)|(\w+));/g, (all, num, name) => {
      if (num) {
        const code = num[1] === 'x' || num[1] === 'X' ? parseInt(num.slice(2), 16) : parseInt(num.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : all;
      }
      return XML_ENTITIES[name] !== undefined ? XML_ENTITIES[name] : all;
    });
  }

  const ATTR_RE = /([\w:.-]+)\s*=\s*"([^"]*)"/g;
  function parseAttrs(source) {
    const out = {};
    ATTR_RE.lastIndex = 0;
    let m;
    while ((m = ATTR_RE.exec(source))) out[m[1]] = m[2];
    return out;
  }

  function readAttr(source, name) {
    const m = new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*=\\s*"([^"]*)"').exec(source);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------ *
   * Hash e formatação
   * ------------------------------------------------------------------ */

  async function sha256Hex(input) {
    let bytes;
    if (input instanceof Uint8Array) bytes = input;
    else if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
    else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
    else if (typeof Blob !== 'undefined' && input instanceof Blob) bytes = new Uint8Array(await input.arrayBuffer());
    else bytes = new TextEncoder().encode(String(input ?? ''));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function formatBytes(n) {
    if (!Number.isFinite(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function formatDuration(ms) {
    if (!Number.isFinite(ms) || ms < 0) return '0s';
    const total = Math.round(ms / 1000);
    const min = Math.floor(total / 60);
    const sec = total % 60;
    return min ? `${min}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
  }

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('pt-BR');
  }

  /** Devolve o controle ao event loop — mantém a UI responsiva no fallback. */
  function yieldToLoop() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  V.util = {
    squash,
    deaccent,
    normalizeHeader,
    headerTokens,
    normalizeDocument,
    looseDocumentKey,
    columnToIndex,
    indexToColumn,
    parseRef,
    refRow,
    refCol,
    parseRanges,
    rangesContain,
    escapeXml,
    unescapeXml,
    parseAttrs,
    readAttr,
    sha256Hex,
    formatBytes,
    formatDuration,
    formatNumber,
    yieldToLoop,
  };
})(typeof self !== 'undefined' ? self : this);
