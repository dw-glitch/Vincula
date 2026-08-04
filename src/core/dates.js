/**
 * Vincula — conversão e validação de datas.
 *
 * Regra de ouro do sistema: a Data Efetiva de Emissão é sempre gravada como
 * *data real do Excel* (serial numérico + formato de data), nunca como texto
 * e nunca com resíduo de hora/minuto/segundo/milissegundo.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { squash, deaccent } = V.util;

  const MS_PER_DAY = 86400000;

  /** Números de formato embutidos do Excel que representam data/hora. */
  const BUILTIN_DATE_FORMATS = new Set([
    14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
    45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58,
  ]);

  /**
   * Um formato é de data quando, retirados literais e escapes, ainda restam
   * marcadores de data/hora. Evita falso positivo em máscaras como "0,00".
   */
  function isDateFormatCode(code) {
    if (!code) return false;
    const stripped = String(code).replace(/"[^"]*"|\\.|\[[^\]]*\]/g, '');
    return /[ymdhs]/i.test(stripped);
  }

  function isDateStyle(numFmtId, formatCode) {
    return BUILTIN_DATE_FORMATS.has(Number(numFmtId)) || isDateFormatCode(formatCode);
  }

  /** Época do Excel: 1899-12-30 (ou 1904-01-01 em pastas legadas do Mac). */
  function epochUTC(date1904) {
    return date1904 ? Date.UTC(1904, 0, 1) : Date.UTC(1899, 11, 30);
  }

  /** Serial (inclusive fracionário) → Date em UTC. */
  function serialToDate(serial, date1904) {
    const n = Number(serial);
    if (!Number.isFinite(n)) return null;
    return new Date(epochUTC(date1904) + n * MS_PER_DAY);
  }

  /**
   * Serial → serial do início do dia. Truncar aqui, no domínio numérico,
   * é mais seguro do que ida e volta por Date: elimina hora/minuto/segundo/
   * milissegundo sem risco de arredondamento de ponto flutuante.
   */
  function truncateSerial(serial) {
    const n = Number(serial);
    if (!Number.isFinite(n)) return null;
    // 1e-9 absorve seriais como 45000.99999999 gerados por conversões prévias.
    return Math.floor(n + 1e-9);
  }

  /** Date → serial do Excel, sempre à meia-noite. */
  function dateToSerial(date, date1904) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
    return Math.round((midnight - epochUTC(date1904)) / MS_PER_DAY);
  }

  /** Zera a componente de tempo mantendo o dia civil. */
  function toDateOnly(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  }

  /**
   * Valores que o sistema trata como "sem data": nunca substituem a Data
   * Efetiva de Emissão já existente na LD e viram pendência no relatório.
   */
  const INVALID_TOKENS = new Set([
    '', '-', '--', '---', 'NULL', 'UNDEFINED', 'NAN', 'N A', 'NA', 'ND',
    'S D', 'SD', 'SEM DATA', 'DATA INVALIDA', 'INVALIDA', 'INVALIDO',
    '#N D', '#N A', '#VALUE!', '#VALOR!', '#REF!', '#NUM!', '#NULO!',
    '0', '00 00 0000', 'X', '?', '/', '.',
  ]);

  function isBlankDateToken(value) {
    if (value === null || value === undefined) return true;
    if (value instanceof Date) return Number.isNaN(value.getTime());
    const normalized = deaccent(value)
      .toUpperCase()
      .replace(/[\u2010-\u2015\u2212]/g, '-')
      .replace(/[._:;/\\]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return INVALID_TOKENS.has(normalized);
  }

  const DMY_RE = /^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(?:[\sT]+\d{1,2}[:h]\d{1,2}(?:[:.]\d{1,2})?(?:[.,]\d+)?\s*(?:AM|PM)?)?$/i;
  const ISO_RE = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT].*)?$/;

  function buildDate(year, month, day) {
    let y = year;
    if (y < 100) y += y < 70 ? 2000 : 1900;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const date = new Date(Date.UTC(y, month - 1, day));
    // Rejeita rolagens do tipo 31/02 → 03/03.
    if (date.getUTCFullYear() !== y || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
    return date;
  }

  /**
   * Interpreta qualquer origem plausível de data — Date, serial numérico,
   * "04/08/2026 08:31:45", "2026-08-04T08:31:45Z" — e devolve sempre a data
   * civil sem hora, ou null quando não houver data utilizável.
   *
   * O formato brasileiro (dia primeiro) é a interpretação canônica: a Relação
   * GRCON é emitida em pt-BR.
   */
  function parseDate(value, date1904) {
    if (value === null || value === undefined) return null;

    if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : toDateOnly(value);

    if (typeof value === 'number') {
      if (!Number.isFinite(value) || value <= 0) return null;
      return serialToDate(truncateSerial(value), date1904);
    }

    const text = squash(value);
    if (!text || isBlankDateToken(text)) return null;

    const dmy = DMY_RE.exec(text);
    if (dmy) return buildDate(+dmy[3], +dmy[2], +dmy[1]);

    const iso = ISO_RE.exec(text);
    if (iso) return buildDate(+iso[1], +iso[2], +iso[3]);

    // Serial armazenado como texto ("45874").
    if (/^\d{4,6}([.,]\d+)?$/.test(text)) {
      const serial = Number(text.replace(',', '.'));
      if (Number.isFinite(serial) && serial > 0) return serialToDate(truncateSerial(serial), date1904);
    }

    return null;
  }

  const BR_DATE = new Intl.DateTimeFormat('pt-BR', {
    timeZone: 'UTC',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });

  /** Data → "04/08/2026". String vazia quando não houver data. */
  function formatDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return BR_DATE.format(date);
  }

  /** ISO curto para o log de auditoria. */
  function formatIsoDate(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return '';
    return date.toISOString().slice(0, 10);
  }

  V.dates = {
    MS_PER_DAY,
    isDateFormatCode,
    isDateStyle,
    serialToDate,
    dateToSerial,
    truncateSerial,
    toDateOnly,
    isBlankDateToken,
    parseDate,
    formatDate,
    formatIsoDate,
  };
})(typeof self !== 'undefined' ? self : this);
