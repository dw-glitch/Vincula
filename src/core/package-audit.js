/**
 * Vincula — auditoria de integridade do PACOTE XLSX.
 *
 * A auditoria por aba (xlsx.verifyIntegrity) garante que só as células
 * autorizadas mudaram dentro de cada aba editada. Esta camada olha o arquivo
 * inteiro, como o Excel olha: relê o XLSX gerado do zero, de forma
 * independente, e compara com o original.
 *
 * O que é conferido (entrada × saída):
 *   - todas as partes do pacote: nenhuma some, nenhuma aparece, e toda parte
 *     que o Vincula não edita (externalLinks, rels, workbook.xml, calcChain,
 *     tabelas, comentários, desenhos, sharedStrings…) permanece byte a byte;
 *   - styles.xml só pode ganhar estilos no fim, nunca perder ou alterar;
 *   - abas, nomes definidos e referências externas do workbook.xml;
 *   - vínculos externos (externalLinks) e o caminho gravado em cada um —
 *     inclusive caminhos de rede corporativos (Z:\…, \\servidor\…);
 *   - fórmulas: quantidade total, por aba, por função (PROCX, PROCV, SOMASES,
 *     CONT.SES, SE), com referência externa e com #REF!; nas abas editadas,
 *     cada célula com fórmula precisa sair idêntica (fórmula e valor em cache);
 *   - #REF! já existente na entrada é informado, mas não reprova: reprova
 *     apenas o #REF! que surgir no processamento.
 *
 * Qualquer FALHA impede que o arquivo seja entregue como íntegro.
 */
(function (scope) {
  'use strict';

  const V = (scope.Vincula = scope.Vincula || {});
  const { sha256Hex, parseAttrs, unescapeXml } = V.util;

  const STATUS = { OK: 'OK', FALHA: 'FALHA', ALERTA: 'ALERTA' };

  const REL_RE = /<Relationship\b([^>]*?)\/?>/g;
  const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  const F_RE = /<f\b([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/;

  const FUNCTIONS = [
    { key: 'procx', label: 'PROCX (XLOOKUP)', re: /\b(?:_xlfn\.)?XLOOKUP\s*\(/i },
    { key: 'procv', label: 'PROCV (VLOOKUP)', re: /\bVLOOKUP\s*\(/i },
    { key: 'somases', label: 'SOMASES (SUMIFS)', re: /\bSUMIFS\s*\(/i },
    { key: 'contses', label: 'CONT.SES (COUNTIFS)', re: /\bCOUNTIFS\s*\(/i },
    { key: 'se', label: 'SE (IF)', re: /\bIF\s*\(/i },
  ];
  // [1]Plan!A1, '[2]Plan'!A1, [3]!Nome — índice de externalReferences.
  const EXTERNAL_REF_RE = /\[\d+\]/;

  function isDirectory(name, entry) {
    return (entry && entry.dir) || /\/$/.test(name);
  }

  function relsPathOf(partPath) {
    const slash = partPath.lastIndexOf('/');
    return `${partPath.slice(0, slash + 1)}_rels/${partPath.slice(slash + 1)}.rels`;
  }

  function resolveTarget(basePath, target) {
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

  function parseRels(xml) {
    const list = [];
    if (!xml) return list;
    REL_RE.lastIndex = 0;
    let m;
    while ((m = REL_RE.exec(xml))) {
      const a = parseAttrs(m[1]);
      list.push({
        id: a.Id || '',
        type: (a.Type || '').split('/').pop(),
        target: unescapeXml(a.Target || ''),
        external: /^external$/i.test(a.TargetMode || ''),
      });
    }
    return list;
  }

  /** Caminho de vínculo: classifica para o relatório, nunca altera. */
  function classifyTarget(target) {
    const t = String(target || '');
    if (/^file:\/\/\/[A-Za-z]:/i.test(t) || /^[A-Za-z]:\\/.test(t)) return 'absoluto (unidade de rede/disco)';
    if (/^file:\/\/\/?\\\\|^\\\\|^file:\/\/[^/]/i.test(t)) return 'absoluto (UNC)';
    if (/^https?:/i.test(t)) return 'URL (SharePoint/OneDrive)';
    return 'relativo à pasta da LD';
  }

  function decodeTarget(target) {
    try {
      return decodeURIComponent(target);
    } catch (_) {
      return target;
    }
  }

  function parseWorkbook(xml) {
    const out = { sheets: [], definedNames: [], externalReferences: [], calcPr: '' };
    if (!xml) return out;
    const sheetRe = /<sheet\b([^>]*?)\/?>/g;
    let m;
    while ((m = sheetRe.exec(xml))) {
      const a = parseAttrs(m[1]);
      out.sheets.push({ name: unescapeXml(a.name || ''), rid: a['r:id'] || '', state: a.state || 'visible' });
    }
    const dnRe = /<definedName\b([^>]*)>([\s\S]*?)<\/definedName>/g;
    while ((m = dnRe.exec(xml))) {
      const a = parseAttrs(m[1]);
      out.definedNames.push({
        name: unescapeXml(a.name || ''),
        scope: a.localSheetId !== undefined ? a.localSheetId : '',
        text: unescapeXml(m[2]),
        raw: m[0],
      });
    }
    const erRe = /<externalReference\b([^>]*?)\/?>/g;
    while ((m = erRe.exec(xml))) out.externalReferences.push(parseAttrs(m[1])['r:id'] || '');
    const calc = /<calcPr\b[^>]*\/?>/.exec(xml);
    out.calcPr = calc ? calc[0] : '';
    return out;
  }

  /**
   * Conta e (opcionalmente) cataloga as fórmulas de uma aba.
   * Fórmulas compartilhadas: as dependentes (<f t="shared" si="n"/>) herdam o
   * texto da mestra para efeito de contagem por função.
   */
  function scanFormulas(xml, keepCells) {
    const stats = { formulas: 0, external: 0, refErrors: 0, arrays: 0, shared: 0 };
    for (const fn of FUNCTIONS) stats[fn.key] = 0;
    const cells = keepCells ? new Map() : null;
    const sharedText = new Map();
    const pendingShared = [];

    CELL_RE.lastIndex = 0;
    let m;
    while ((m = CELL_RE.exec(xml))) {
      const inner = m[2];
      if (!inner || inner.indexOf('<f') < 0) continue;
      const f = F_RE.exec(inner);
      if (!f) continue;
      const fAttrs = parseAttrs(f[1]);
      const text = unescapeXml(f[2] || '');
      const ref = parseAttrs(m[1]).r || '';
      stats.formulas++;
      if (fAttrs.t === 'array') stats.arrays++;
      if (fAttrs.t === 'shared') {
        stats.shared++;
        if (text) sharedText.set(fAttrs.si, text);
        else {
          pendingShared.push(fAttrs.si);
          if (cells) cells.set(ref, m[0]);
          continue;
        }
      }
      countText(stats, text);
      if (cells) cells.set(ref, m[0]);
    }
    for (const si of pendingShared) countText(stats, sharedText.get(si) || '');
    return { stats, cells };
  }

  function countText(stats, text) {
    if (!text) return;
    if (EXTERNAL_REF_RE.test(text)) stats.external++;
    if (text.indexOf('#REF!') >= 0) stats.refErrors++;
    for (const fn of FUNCTIONS) if (fn.re.test(text)) stats[fn.key]++;
  }

  /**
   * Inventário de um pacote XLSX aberto pelo JSZip.
   * @param {object} zip
   * @param {{detailSheets?: Iterable<string>}} options
   *   detailSheets: abas cujas células com fórmula são catalogadas uma a uma
   *   (as que o Vincula edita). As demais são provadas pelo hash da parte.
   */
  async function inventory(zip, options = {}) {
    const detail = new Set(options.detailSheets || []);
    const parts = new Map();
    const directories = [];

    for (const name of Object.keys(zip.files)) {
      const entry = zip.files[name];
      if (isDirectory(name, entry)) {
        directories.push(name);
        continue;
      }
      const bytes = await entry.async('uint8array');
      parts.set(name, { size: bytes.length, hash: await sha256Hex(bytes) });
    }

    const readText = async (path) => {
      const file = zip.file(path);
      return file ? file.async('string') : null;
    };

    // Raiz → workbook
    const rootRels = parseRels(await readText('_rels/.rels'));
    const officeDoc = rootRels.find((r) => r.type === 'officeDocument');
    const workbookPath = officeDoc ? resolveTarget('', officeDoc.target) : 'xl/workbook.xml';
    const workbookXml = await readText(workbookPath);
    const workbook = parseWorkbook(workbookXml);
    const workbookRels = parseRels(await readText(relsPathOf(workbookPath)));
    const relById = new Map(workbookRels.map((r) => [r.id, r]));

    // Vínculos externos (externalLinks) e o caminho gravado em cada um.
    const externalLinks = [];
    for (const rid of workbook.externalReferences) {
      const rel = relById.get(rid);
      const part = rel ? resolveTarget(workbookPath, rel.target) : null;
      const linkXml = part ? await readText(part) : null;
      const linkRels = part ? parseRels(await readText(relsPathOf(part))) : [];
      const pathRel = linkRels.find((r) => /externalLinkPath|xlExternalLinkPath/i.test(r.type)) || linkRels[0] || null;
      const sheetNames = [];
      if (linkXml) {
        const snRe = /<sheetName\b[^>]*val="([^"]*)"/g;
        let m;
        while ((m = snRe.exec(linkXml))) sheetNames.push(unescapeXml(m[1]));
      }
      externalLinks.push({
        rid,
        part,
        exists: !!linkXml,
        target: pathRel ? pathRel.target : '',
        targetDecoded: pathRel ? decodeTarget(pathRel.target) : '',
        targetKind: pathRel ? classifyTarget(pathRel.target) : 'ausente',
        sheetNames,
      });
    }

    // Toda relação TargetMode="External" do pacote (vínculos, hiperlinks…).
    const externalRels = [];
    for (const name of parts.keys()) {
      if (!/\.rels$/i.test(name)) continue;
      for (const rel of parseRels(await readText(name))) {
        if (rel.external) externalRels.push({ source: name, id: rel.id, type: rel.type, target: rel.target });
      }
    }

    // Abas: contagem de fórmulas; detalhe célula a célula nas abas editadas.
    const sheets = [];
    for (const sheet of workbook.sheets) {
      const rel = relById.get(sheet.rid);
      const path = rel ? resolveTarget(workbookPath, rel.target) : null;
      const xml = path ? await readText(path) : null;
      const scan = xml ? scanFormulas(xml, detail.has(path)) : { stats: null, cells: null };
      sheets.push({ name: sheet.name, path, state: sheet.state, exists: !!xml, stats: scan.stats, cells: scan.cells });
    }

    const totals = { formulas: 0, external: 0, refErrors: 0, arrays: 0, shared: 0 };
    for (const fn of FUNCTIONS) totals[fn.key] = 0;
    for (const sheet of sheets) {
      if (!sheet.stats) continue;
      for (const key of Object.keys(totals)) totals[key] += sheet.stats[key] || 0;
    }

    return {
      workbookPath,
      parts,
      directories,
      workbook,
      externalLinks,
      externalRels,
      sheets,
      totals,
      tables: [...parts.keys()].filter((p) => /^xl\/tables\/[^/]+\.xml$/i.test(p)).length,
      styles: parts.has('xl/styles.xml') ? await readText('xl/styles.xml') : null,
    };
  }

  /** styles.xml: o Vincula só acrescenta numFmt/xf no fim dos blocos. */
  function stylesAppendOnly(before, after) {
    if (before === after) return true;
    if (!before || !after) return false;
    const block = (xml, tag) => {
      const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`).exec(xml);
      return m ? m[1] : null;
    };
    const strip = (xml) =>
      xml.replace(/<numFmts\b[^>]*\/>|<numFmts\b[^>]*>[\s\S]*?<\/numFmts>/, '').replace(/<cellXfs\b[^>]*>[\s\S]*?<\/cellXfs>/, '');
    if (strip(before) !== strip(after)) return false;
    const xfB = block(before, 'cellXfs');
    const xfA = block(after, 'cellXfs');
    if (xfB === null || xfA === null || !xfA.startsWith(xfB)) return false;
    const nfB = block(before, 'numFmts') || '';
    const nfA = block(after, 'numFmts') || '';
    return nfA.startsWith(nfB);
  }

  /**
   * @param {object} before inventário da entrada
   * @param {object} after  inventário da saída (relida do zero)
   * @param {{editedSheets?: Iterable<string>, authorized?: Map<string, Set<string>>, fileName?: string}} context
   */
  function compare(before, after, context = {}) {
    const edited = new Set(context.editedSheets || []);
    const authorized = context.authorized || new Map();
    const checks = [];
    const add = (id, label, status, beforeValue, afterValue, detail) =>
      checks.push({ id, label, status, before: beforeValue, after: afterValue, detail: detail || '' });

    // 1. Abas
    const namesB = before.workbook.sheets.map((s) => s.name).join(' | ');
    const namesA = after.workbook.sheets.map((s) => s.name).join(' | ');
    add('abas', 'Quantidade e nomes das abas', namesB === namesA ? STATUS.OK : STATUS.FALHA,
      before.workbook.sheets.length, after.workbook.sheets.length, namesB === namesA ? '' : `Antes: ${namesB} · Depois: ${namesA}`);

    // 2. Partes do pacote
    const missing = [...before.parts.keys()].filter((p) => !after.parts.has(p));
    const added = [...after.parts.keys()].filter((p) => !before.parts.has(p));
    const changed = [];
    const unexpected = [];
    for (const [path, info] of before.parts) {
      const other = after.parts.get(path);
      if (!other || other.hash === info.hash) continue;
      changed.push(path);
      if (!edited.has(path) && path !== 'xl/styles.xml') unexpected.push(path);
    }
    const newDirs = after.directories.filter((d) => !before.directories.includes(d));
    const partsOk = !missing.length && !added.length && !unexpected.length && !newDirs.length;
    add('partes', 'Partes do pacote preservadas (fora das abas editadas)', partsOk ? STATUS.OK : STATUS.FALHA,
      before.parts.size, after.parts.size,
      [
        missing.length ? `Removidas: ${missing.join(', ')}` : '',
        added.length ? `Criadas: ${added.join(', ')}` : '',
        unexpected.length ? `Alteradas sem autorização: ${unexpected.join(', ')}` : '',
        newDirs.length ? `Entradas de diretório inseridas: ${newDirs.join(', ')}` : '',
        partsOk ? `Alteradas (autorizadas): ${changed.join(', ') || 'nenhuma'}` : '',
      ].filter(Boolean).join(' · '));

    // 3. styles.xml
    const stylesOk = stylesAppendOnly(before.styles, after.styles);
    add('estilos', 'styles.xml apenas acrescido (formatação original intacta)', stylesOk ? STATUS.OK : STATUS.FALHA,
      before.styles ? before.styles.length : 0, after.styles ? after.styles.length : 0);

    // 4. Vínculos externos
    const linkKey = (l) => `${l.rid}|${l.part}|${l.target}|${l.exists}`;
    const linksB = before.externalLinks.map(linkKey).join('\n');
    const linksA = after.externalLinks.map(linkKey).join('\n');
    const linkPartsB = before.externalLinks.map((l) => l.part).filter(Boolean);
    const linkPartsChanged = linkPartsB.filter((p) => {
      const a = before.parts.get(p);
      const b = after.parts.get(p);
      const relsA = before.parts.get(relsPathOf(p));
      const relsB = after.parts.get(relsPathOf(p));
      return !a || !b || a.hash !== b.hash || (relsA && (!relsB || relsA.hash !== relsB.hash));
    });
    const linksOk = linksB === linksA && !linkPartsChanged.length;
    add('vinculos', 'Vínculos externos (xl/externalLinks) e caminhos preservados', linksOk ? STATUS.OK : STATUS.FALHA,
      before.externalLinks.length, after.externalLinks.length,
      linksOk
        ? before.externalLinks.map((l) => `[${before.externalLinks.indexOf(l) + 1}] ${l.targetDecoded}`).join(' · ')
        : `Divergência nos vínculos: ${linkPartsChanged.join(', ') || 'lista de externalReferences/caminhos alterada'}`);

    const extB = before.externalRels.map((r) => `${r.source}|${r.id}|${r.target}`).sort().join('\n');
    const extA = after.externalRels.map((r) => `${r.source}|${r.id}|${r.target}`).sort().join('\n');
    add('relacoes', 'Relacionamentos externos (vínculos e hiperlinks)', extB === extA ? STATUS.OK : STATUS.FALHA,
      before.externalRels.length, after.externalRels.length);

    const relative = before.externalLinks.filter((l) => l.targetKind === 'relativo à pasta da LD');
    if (relative.length) {
      add('vinculosRelativos', 'Vínculos gravados com caminho relativo (preservados sem alteração)', STATUS.ALERTA,
        relative.length, after.externalLinks.filter((l) => l.targetKind === 'relativo à pasta da LD').length,
        'O Excel resolve esses vínculos a partir da pasta em que a LD for aberta. Coloque a LD atualizada na pasta corporativa ' +
          'original antes de abri-la e salvá-la; abrir e salvar a partir de Downloads faz o próprio Excel regravar o caminho. ' +
          relative.map((l) => l.targetDecoded).join(' · '));
    }

    // 5. Nomes definidos
    const dnB = before.workbook.definedNames.map((d) => d.raw).join('\n');
    const dnA = after.workbook.definedNames.map((d) => d.raw).join('\n');
    add('nomes', 'Nomes definidos', dnB === dnA ? STATUS.OK : STATUS.FALHA,
      before.workbook.definedNames.length, after.workbook.definedNames.length);

    // 6. Tabelas
    add('tabelas', 'Tabelas estruturadas', before.tables === after.tables && !missing.some((p) => /tables\//.test(p)) ? STATUS.OK : STATUS.FALHA,
      before.tables, after.tables);

    // 7. Fórmulas (totais e por função)
    const t0 = before.totals;
    const t1 = after.totals;
    add('formulas', 'Quantidade de fórmulas', t0.formulas === t1.formulas ? STATUS.OK : STATUS.FALHA, t0.formulas, t1.formulas);
    add('formulasExternas', 'Fórmulas com referência a outro arquivo', t0.external === t1.external ? STATUS.OK : STATUS.FALHA, t0.external, t1.external);
    for (const fn of FUNCTIONS) {
      add(`fn_${fn.key}`, `Fórmulas ${fn.label}`, t0[fn.key] === t1[fn.key] ? STATUS.OK : STATUS.FALHA, t0[fn.key], t1[fn.key]);
    }

    // 8. #REF!: só reprova o que surgiu no processamento.
    const newRef = t1.refErrors > t0.refErrors;
    add('ref', 'Fórmulas com #REF!', newRef ? STATUS.FALHA : t0.refErrors ? STATUS.ALERTA : STATUS.OK, t0.refErrors, t1.refErrors,
      newRef
        ? `${t1.refErrors - t0.refErrors} #REF! novo(s) introduzido(s) no processamento.`
        : t0.refErrors
          ? `${t0.refErrors} fórmula(s) já chegaram com #REF! no arquivo original; nenhuma nova foi introduzida pelo Vincula.`
          : '');
    const brokenNamesB = before.workbook.definedNames.filter((d) => d.text.indexOf('#REF!') >= 0).length;
    if (brokenNamesB) {
      add('nomesRef', 'Nomes definidos com #REF! (já existentes na entrada)', STATUS.ALERTA, brokenNamesB,
        after.workbook.definedNames.filter((d) => d.text.indexOf('#REF!') >= 0).length);
    }

    // 9. Por aba + célula a célula nas abas editadas
    const sheetDetails = [];
    for (const sheetB of before.sheets) {
      const sheetA = after.sheets.find((s) => s.path === sheetB.path);
      const statsB = sheetB.stats || {};
      const statsA = (sheetA && sheetA.stats) || {};
      const row = {
        sheet: sheetB.name,
        path: sheetB.path,
        edited: edited.has(sheetB.path),
        formulasBefore: statsB.formulas || 0,
        formulasAfter: statsA.formulas || 0,
        externalBefore: statsB.external || 0,
        externalAfter: statsA.external || 0,
        refBefore: statsB.refErrors || 0,
        refAfter: statsA.refErrors || 0,
        procxBefore: statsB.procx || 0,
        procxAfter: statsA.procx || 0,
        changedFormulaCells: 0,
        authorizedCells: (authorized.get(sheetB.path) || new Set()).size,
        status: STATUS.OK,
        detail: '',
      };
      if (!sheetA || !sheetA.exists) {
        row.status = STATUS.FALHA;
        row.detail = 'Aba ausente no arquivo gerado.';
      } else if (sheetB.cells && sheetA.cells) {
        const lost = [];
        for (const [ref, raw] of sheetB.cells) {
          if (sheetA.cells.get(ref) !== raw) lost.push(ref);
        }
        const created = [...sheetA.cells.keys()].filter((ref) => !sheetB.cells.has(ref));
        row.changedFormulaCells = lost.length + created.length;
        if (lost.length || created.length) {
          row.status = STATUS.FALHA;
          row.detail = [
            lost.length ? `Fórmula alterada/perdida em: ${lost.slice(0, 10).join(', ')}${lost.length > 10 ? '…' : ''}` : '',
            created.length ? `Fórmula criada em: ${created.slice(0, 10).join(', ')}` : '',
          ].filter(Boolean).join(' · ');
        }
      }
      if (row.formulasBefore !== row.formulasAfter || row.externalBefore !== row.externalAfter || row.refAfter > row.refBefore) {
        row.status = STATUS.FALHA;
      }
      sheetDetails.push(row);
    }
    const editedRows = sheetDetails.filter((r) => r.edited);
    add('formulasCelula', 'Fórmulas das abas editadas idênticas (texto e valor em cache)',
      editedRows.every((r) => r.status === STATUS.OK) ? STATUS.OK : STATUS.FALHA,
      editedRows.reduce((s, r) => s + r.formulasBefore, 0), editedRows.reduce((s, r) => s + r.formulasAfter, 0),
      editedRows.filter((r) => r.detail).map((r) => `${r.sheet}: ${r.detail}`).join(' · '));

    if (context.authorized) {
      add('alteracoes', 'Células alteradas pelo Vincula (somente colunas autorizadas)', STATUS.OK,
        '', [...authorized.values()].reduce((s, set) => s + set.size, 0),
        editedRows.map((r) => `${r.sheet}: ${r.authorizedCells}`).join(' · '));
    }

    const failures = checks.filter((c) => c.status === STATUS.FALHA);
    return {
      ok: failures.length === 0,
      file: context.fileName || '',
      checks,
      sheets: sheetDetails,
      externalLinks: before.externalLinks.map((l, i) => ({
        indice: i + 1,
        parte: l.part,
        caminho: l.targetDecoded,
        tipo: l.targetKind,
        abas: l.sheetNames.join(', '),
        preservado: !!after.externalLinks.find((x) => x.rid === l.rid && x.target === l.target && x.part === l.part),
      })),
      totals: { before: before.totals, after: after.totals },
      failures: failures.map((c) => `${c.label}: antes ${c.before}, depois ${c.after}${c.detail ? ` — ${c.detail}` : ''}`),
    };
  }

  /** Resumo de uma linha para UI/relatório. */
  function summarize(report) {
    if (!report) return 'NÃO VERIFICADA';
    const t = report.totals.after;
    const links = report.externalLinks.length;
    return `${report.ok ? 'ÍNTEGRO' : 'REPROVADO'} — ${t.formulas} fórmula(s), ${t.procx} PROCX, ${t.external} com referência externa, ` +
      `${links} vínculo(s) externo(s)${t.refErrors ? `, ${t.refErrors} #REF! já existente(s) na entrada` : ''}`;
  }

  V.packageAudit = { inventory, compare, summarize, STATUS, classifyTarget };
})(typeof self !== 'undefined' ? self : this);
