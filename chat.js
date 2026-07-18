/* ============================================================================
   Data Governance — analytics chat engine v2 (deterministic, offline).
   Adds conversation memory (follow-ups), greetings/help, conversational
   phrasing, grounding `facts` for the optional LLM layer, and suggested
   follow-up questions. Every number is computed from real data.
   Returns { text, chart?, facts, followups? }.
   ========================================================================== */
function answerQuestion(question, t, a, ctx) {
  ctx = ctx || {};
  const raw = question.trim();
  const q = ' ' + raw.toLowerCase() + ' ';
  const cols = t.columns, numeric = a.numeric, categorical = a.categorical, datetime = a.datetime;
  const data = t.data, imp = t.imputed, nRows = t.nRows;
  const num = (s) => s.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const has = (...w) => w.some((x) => q.includes(x));

  const byLen = [...cols].sort((x, y) => y.name.length - x.name.length);
  const qnorm = ' ' + raw.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
  const colNorm = (n) => n.toLowerCase().replace(/[_-]+/g, ' ').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  const mentioned = byLen.filter((c) => { const n = colNorm(c.name); return n && qnorm.includes(' ' + n + ' '); });
  const mNum = mentioned.find((c) => c.type === 'numeric');
  const mCat = mentioned.find((c) => c.type === 'categorical');

  const measure = mNum || (has('revenue','sales','amount','total','price','value') ? a.measure : null) || ctx.lastMeasure || a.measure || numeric[0];
  const dimension = mCat || ctx.lastDimension || a.dimension || categorical[0];
  const remember = (res) => { if (measure) ctx.lastMeasure = measure; if (dimension) ctx.lastDimension = dimension; return res; };

  const nMatch = q.match(/top\s+(\d+)|bottom\s+(\d+)|first\s+(\d+)/);
  const topN = nMatch ? parseInt(nMatch[1] || nMatch[2] || nMatch[3]) : 8;

  const aggregate = (mCol, dCol, fn) => {
    const acc = {};
    for (let i = 0; i < nRows; i++) { const gk = imp[dCol.name][i], v = imp[mCol.name][i]; if (gk === null || v === null) continue; (acc[gk] = acc[gk] || []).push(v); }
    const rows = Object.entries(acc).map(([k, arr]) => { const sum = arr.reduce((s, x) => s + x, 0); return { key: k, sum, mean: sum / arr.length, count: arr.length }; });
    const metric = fn === 'mean' ? 'mean' : fn === 'count' ? 'count' : 'sum';
    rows.sort((x, y) => y[metric] - x[metric]);
    return { rows, metric };
  };
  const contNum = numeric.filter((c) => c.unique > 2); // exclude 0/1-coded columns
  const followupsFor = (kind) => {
    const f = [];
    if (kind !== 'trend' && a.trend) f.push(`trend of ${a.trend.measure} over time`);
    if (kind !== 'breakdown' && measure && dimension) f.push(`${measure.name} by ${dimension.name}`);
    if (kind !== 'avg' && measure) f.push(`average ${measure.name}`);
    if (contNum.length >= 2) f.push(`correlation between ${contNum[0].name} and ${contNum[1].name}`);
    return f.slice(0, 3);
  };

  if (/^(hi|hey|hello|yo|howdy|good (morning|afternoon|evening))\b/.test(raw.toLowerCase()))
    return remember({ text: `Hi! I've analyzed **${ctx.name || 'your dataset'}** — ${nRows.toLocaleString()} rows, ${cols.length} columns. Ask me about totals, averages, trends, correlations, top categories, or data quality.`, facts: { rows: nRows, cols: cols.length }, followups: followupsFor() });
  if (has('thank', 'thanks', 'thx', 'cheers', 'appreciate'))
    return { text: 'Anytime. Want me to dig into a trend, a breakdown, or the data-quality signals next?', facts: {}, followups: followupsFor() };
  if (has('what can you', 'help', 'how do i', 'what should i ask', 'examples'))
    return { text: `I answer questions computed directly from your data. Try:\n• **totals & averages** — "average ${(measure||{name:'a column'}).name}"\n• **breakdowns** — "${(measure||{name:'value'}).name} by ${(dimension||{name:'category'}).name}"\n• **trends** — "sales over time"\n• **relationships** — "correlation between two columns"\n• **quality** — "which columns have missing values"`, facts: {}, followups: followupsFor() };

  /* ===================== analytical intents (priority) ===================== */
  // resolve a free-text concept to a real column (name overlap + light synonyms)
  const SYN = { sex:'gender', bp:'blood pressure', sugar:'glucose', kidney:'creatinin', smoke:'smok', diabetic:'diab' };
  const resolveCol = (term) => {
    if (!term) return null; let s = term.toLowerCase().trim().replace(/[^a-z0-9 _]/g, '');
    for (const k in SYN) if (s.includes(k)) s += ' ' + SYN[k];
    let hit = byLen.find((c) => { const n = c.name.toLowerCase(); return n === s || n.includes(s) || s.includes(n); });
    if (hit) return hit;
    const tks = s.split(/\s+/).flatMap((w) => [w, w.replace(/s$/, '')]).filter((w) => w.length > 2);
    hit = byLen.find((c) => { const n = c.name.toLowerCase().replace(/[_]/g, ' '); return tks.some((w) => n.includes(w) || w.includes(n)); });
    return hit || null;
  };
  const assocBar = (items, title, key) => ({ type: 'bar', orientation: 'h', x: items.map((x) => x[key]).reverse(), y: items.map((x) => x.feature).reverse(), color: '#F2A968', title });

  const relationship = (A, B) => {
    if (!A || !B || A.name === B.name) return null;
    if (A.type === 'numeric' && B.type === 'numeric') {
      const r = pearson(data[A.name], data[B.name]); if (r === null) return null;
      const st = Math.abs(r) > 0.6 ? 'strong' : Math.abs(r) > 0.3 ? 'moderate' : 'weak';
      const xs = [], ys = []; for (let i = 0; i < nRows; i++) { const p = data[A.name][i], u = data[B.name][i]; if (p !== null && u !== null) { xs.push(p); ys.push(u); } }
      return remember({ text: `**${A.name}** and **${B.name}** have a **${st} ${r < 0 ? 'negative' : 'positive'}** relationship (r = ${r.toFixed(3)}) — as one ${r < 0 ? 'rises, the other tends to fall' : 'rises, so does the other'}.`, facts: { a: A.name, b: B.name, r }, chart: { type: 'scatter', x: xs, y: ys, xt: A.name, yt: B.name, title: `${A.name} vs ${B.name}` }, followups: followupsFor() });
    }
    const numCol = [A, B].find((c) => c.type === 'numeric'); const catCol = [A, B].find((c) => c.type !== 'numeric');
    if (numCol && catCol) {
      const rows = groupStats(t, numCol.name, catCol.name); if (!rows.length) return null;
      const hi = [...rows].sort((x, y) => y.mean - x.mean)[0], lo = [...rows].sort((x, y) => x.mean - y.mean)[0];
      const diff = lo.mean ? Math.abs((hi.mean - lo.mean) / lo.mean) * 100 : 0;
      return remember({ text: `Average **${numCol.name}** varies by **${catCol.name}**: highest in **${hi.group}** (${num(hi.mean)}), lowest in **${lo.group}** (${num(lo.mean)}) — a ${diff.toFixed(0)}% gap. So ${catCol.name} is ${diff > 15 ? 'clearly' : 'only mildly'} associated with ${numCol.name}.`, facts: { measure: numCol.name, group: catCol.name, rows: rows.map((r) => ({ group: r.group, mean: +r.mean.toFixed(2) })) }, chart: { type: 'bar', x: rows.map((r) => r.group), y: rows.map((r) => r.mean), color: '#F2A968', title: `${numCol.name} by ${catCol.name}` }, followups: followupsFor() });
    }
    // both categorical → rate of B across A
    const acc = {}; for (let i = 0; i < nRows; i++) { const ka = imp[A.name][i], kb = imp[B.name][i]; if (ka == null || kb == null) continue; acc[ka] = acc[ka] || {}; acc[ka][kb] = (acc[ka][kb] || 0) + 1; }
    const groups = Object.keys(acc).slice(0, 8); const bClasses = [...new Set(Object.values(acc).flatMap((o) => Object.keys(o)))];
    const focus = bClasses[bClasses.length - 1];
    const rates = groups.map((g) => { const tot = Object.values(acc[g]).reduce((s, x) => s + x, 0); return { key: g, rate: 100 * (acc[g][focus] || 0) / tot }; });
    return remember({ text: `Share of **${B.name} = ${focus}** by **${A.name}**: ` + rates.map((r) => `${r.key} ${r.rate.toFixed(0)}%`).join(' · ') + `. ${Math.max(...rates.map((r) => r.rate)) - Math.min(...rates.map((r) => r.rate)) > 10 ? 'The groups differ, suggesting an association.' : 'The rates are similar, suggesting little association.'}`, facts: { a: A.name, b: B.name, focus, rates }, chart: { type: 'bar', x: rates.map((r) => r.key), y: rates.map((r) => r.rate), color: '#F2A968', title: `% ${B.name}=${focus} by ${A.name}`, suffix: '%' }, followups: followupsFor() });
  };

  // (1) feature importance / factors / associated / indicate / biomarkers / characteristics / significant
  if (has('which factor', 'contribute most', 'contribute to', 'most associated', 'associated with', 'which feature', 'most important', 'which biomarker', 'which lab', 'laboratory values', 'characteristics indicate', 'characteristics that', 'indicate', 'risk factor', 'drivers', 'what predicts', 'predictors', 'values change', 'change significantly', 'most predictive', 'features are most')) {
    if (a.assoc && a.assoc.items.length) {
      let items = a.assoc.items;
      if (has('increase', 'rise', 'higher with', 'grow', 'with severity', 'with ckd severity', 'severity')) items = items.filter((x) => x.r > 0);
      const top = items.slice(0, 6).map((x) => ({ ...x, mag: x.abs }));
      const tgt = a.assoc.target;
      const lead = top.slice(0, 4).map((x) => `**${x.feature}** (${x.dir === 'increases' ? '↑' : '↓'} r=${x.r})`).join(', ');
      return remember({ text: `Ranked by association with **${tgt}**, the strongest factors are ${lead}. The arrow shows direction (↑ = higher when ${tgt} is higher); r is the correlation strength.`, facts: { target: tgt, top: top.map((x) => ({ feature: x.feature, r: x.r })) }, chart: assocBar(top, `Association with ${tgt}`, 'mag'), followups: ['compare the groups', `explain the importance of ${top[0].feature}`, 'generate insights'] });
    }
  }

  // (2) compare across groups / which group has highest Y / vary across
  if (has('compare', 'across', 'which stage', 'which group', 'which class', 'highest', 'lowest', 'by stage', 'per stage', 'vary across', 'differ', 'between stages', 'each stage', 'across all')) {
    const mentGroups = mentioned.filter((c) => c.type === 'categorical' || c.type === 'boolean' || (c.type === 'numeric' && c.unique >= 2 && c.unique <= 12));
    const mentMeas = mentioned.filter((c) => c.type === 'numeric' && c.unique > 12);
    let grp = mentGroups[0];
    if (!grp && has('stage', 'severity', 'group', 'class', 'category')) grp = resolveCol('stage') || resolveCol('severity') || resolveCol('group') || resolveCol('class') || a.target;
    if (!grp) grp = a.target || (dimension && dimension.type !== 'numeric' ? dimension : null);
    let meas = mentMeas[0] || (mNum && mNum.unique > 12 ? mNum : null);
    if (!meas) { const rc = resolveCol(raw.replace(/across.*|by .*|per .*|compare/gi, '')); if (rc && rc.type === 'numeric' && rc !== grp) meas = rc; }
    if (grp && meas && meas.type === 'numeric' && meas !== grp) {
      const rows = groupStats(t, meas.name, grp.name);
      const hi = [...rows].sort((x, y) => y.mean - x.mean)[0];
      return remember({ text: `Average **${meas.name}** by **${grp.name}** — highest in **${hi.group}** (${num(hi.mean)}). Full breakdown: ` + rows.slice(0, 7).map((r) => `${r.group}: ${num(r.mean)}`).join(' · ') + '.', facts: { measure: meas.name, group: grp.name, rows: rows.map((r) => ({ group: r.group, mean: +r.mean.toFixed(2), n: r.n })) }, chart: { type: 'bar', x: rows.map((r) => r.group), y: rows.map((r) => r.mean), color: '#F2A968', title: `${meas.name} by ${grp.name}` }, followups: followupsFor() });
    }
    if (a.target) {
      const cg = compareGroups(t, a.target);
      if (cg && cg.items.length) { const top = cg.items.slice(0, 6);
        return remember({ text: `Comparing **${cg.c0}** vs **${cg.c1}** (by ${a.target.name}), the features that differ most are ` + top.slice(0, 4).map((x) => `**${x.feature}** (${num(x.g0)} \u2192 ${num(x.g1)})`).join(', ') + '.', facts: { target: a.target.name, groups: [cg.c0, cg.c1], top: top.map((x) => ({ feature: x.feature, g0: x.g0, g1: x.g1, d: x.d })) }, chart: assocBar(top, `Biggest differences: ${cg.c0} vs ${cg.c1}`, 'abs'), followups: ['which factors contribute most', 'generate insights'] });
      }
    }
  }

  // (3) how does A affect B / relationship between A and B / influence
  if (has('how does', 'how do', 'affect', 'influence', 'impact of', 'relationship between', 'related to', 'effect of', 'vary with', 'depend on', 'associated', 'does gender', 'does age', 'linked to')) {
    let A = null, B = null;
    let m = raw.toLowerCase().match(/relationship between\s+(.+?)\s+and\s+(.+)/);
    if (m) { A = resolveCol(m[1]); B = resolveCol(m[2]); }
    if (!A || !B) { m = raw.toLowerCase().match(/(?:how (?:does|do)|effect of|impact of|does)\s+(.+?)\s+(?:affect|influence|impact|relate to|vary with|on|associated with|linked to)\s+(.+)/); if (m) { A = resolveCol(m[1]); B = resolveCol(m[2]); } }
    if (!A && !B) { const ms = mentioned.slice(0, 2); if (ms.length === 2) { A = ms[0]; B = ms[1]; } }
    let res = null;
    if (A && B) res = relationship(A, B);
    else if (A && a.target) res = relationship(A, a.target);
    else if (B && a.target) res = relationship(B, a.target);
    if (res) return res;
  }

  // (4) explain importance / significance / role of a column
  if (has('importance of', 'importance', 'significance of', 'role of', 'why is', 'explain the', 'what does', 'meaning of')) {
    const col = mentioned[0] || resolveCol(raw.replace(/.*(importance of|significance of|role of|explain the|meaning of|what does)\s*/i, ''));
    if (col && col.type === 'numeric') {
      const s = stats(data[col.name]); const it = a.assoc && a.assoc.items.find((x) => x.feature === col.name);
      return remember({ text: `**${col.name}** ranges ${num(s.min)}–${num(s.max)} (mean ${num(s.mean)}, median ${num(s.median)}).${it ? ` It is **${it.abs > 0.5 ? 'strongly' : it.abs > 0.3 ? 'moderately' : 'weakly'} associated** with ${a.assoc.target} (r = ${it.r}) and ${it.dir === 'increases' ? 'rises' : 'falls'} as ${a.assoc.target} increases.` : ''}`, facts: { column: col.name, r: it ? it.r : null }, chart: { type: 'hist', x: data[col.name].filter((v) => v !== null), color: '#F2A968', title: `Distribution of ${col.name}` }, followups: followupsFor() });
    }
  }

  // (5) generate insights / clinical insights / key findings
  if (has('generate', 'clinical insight', 'key insight', 'insights from', 'key finding', 'give me insights', 'summarize the finding', 'main takeaway', 'what stands out')) {
    const parts = [];
    if (a.assoc && a.assoc.items.length) { const top = a.assoc.items.slice(0, 3); parts.push(`Strongest factors linked to **${a.assoc.target}**: ${top.map((x) => `${x.feature} (r=${x.r})`).join(', ')}.`); }
    if (a.insights[0]) parts.push(a.insights[0].text);
    if (a.insights[1]) parts.push(a.insights[1].text);
    if (a.trend) parts.push(`${a.trend.measure} is trending ${a.trend.direction} (${a.trend.pctChange > 0 ? '+' : ''}${a.trend.pctChange}%).`);
    if (a.corr[0]) parts.push(`Strongest correlation: ${a.corr[0].a} ↔ ${a.corr[0].b} (r=${a.corr[0].r}).`);
    return remember({ text: `**Key insights**\n` + parts.map((p) => '• ' + p).join('\n'), facts: {}, chart: a.assoc && a.assoc.items.length ? assocBar(a.assoc.items.slice(0, 6).map((x) => ({ ...x, mag: x.abs })), `Top factors for ${a.assoc.target}`, 'mag') : null, followups: ['which factors contribute most', 'compare the groups'] });
  }

  // (6) filtered / conditional queries: "how many X over 60", "average Y for Electronics", "what % are male"
  const STOP = new Set(['the','and','for','are','was','with','how','many','what','average','mean','count','number','rows','total','sum','percentage','percent','share','proportion','patients','records','which','have','has','that','over','under','above','below','more','less','than','least','most','equal','equals']);
  const buildMask = (excludeCol) => {
    const mask = new Array(nRows).fill(true); const descs = []; let any = false, ambiguous = false;
    const low = raw.toLowerCase();
    const opRe = /(>=|<=|==|>|<|=|greater than or equal|less than or equal|at least|at most|greater than|less than|more than|over|above|under|below|equals?)\s*(?:age[d]?\s*(?:of\s*)?)?(-?\d[\d,.]*)/gi;
    let m;
    while ((m = opRe.exec(low))) {
      const val = parseFloat(m[2].replace(/,/g, '')); if (!isFinite(val)) continue;
      const ot = m[1];
      const op = /(>=|at least|greater than or equal)/.test(ot) ? '>=' : /(<=|at most|less than or equal)/.test(ot) ? '<=' : /(>|over|above|greater|more)/.test(ot) ? '>' : /(<|under|below|less)/.test(ot) ? '<' : '=';
      const pre = low.slice(0, m.index).replace(/[_-]/g, ' ');
      let col = byLen.find((c) => c.type === 'numeric' && c !== excludeCol && new RegExp('\\b' + colNorm(c.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(pre));
      if (!col) {
        const cands = numeric.filter((c) => c !== excludeCol);
        const within = cands.filter((c) => { const s = stats(data[c.name]); return s && val >= s.min && val <= s.max; });
        const pool = within.length ? within : cands;
        col = pool.find((c) => /age/i.test(c.name)) || (pool.length === 1 ? pool[0] : within.length === 1 ? within[0] : null);
        if (!col && pool.length) { ambiguous = true; continue; }
      }
      if (!col) continue;
      for (let i = 0; i < nRows; i++) { const v = data[col.name][i]; if (v === null) { mask[i] = false; continue; } const ok = op === '>' ? v > val : op === '<' ? v < val : op === '>=' ? v >= val : op === '<=' ? v <= val : v === val; if (!ok) mask[i] = false; }
      descs.push(`${col.name} ${op} ${val}`); any = true;
    }
    for (const c of cols) {
      if (c.type !== 'categorical' && c.type !== 'boolean') continue;
      const vals = [...new Set(imp[c.name].filter((v) => v != null))];
      for (const val of vals) {
        const vn = String(val).toLowerCase().replace(/[^a-z0-9 ]/g, ' ').trim();
        if (vn.length < 3 || STOP.has(vn)) continue;
        if (qnorm.includes(' ' + vn + ' ')) { for (let i = 0; i < nRows; i++) { if (String(imp[c.name][i]).toLowerCase() !== String(val).toLowerCase()) mask[i] = false; } descs.push(`${c.name} = ${val}`); any = true; break; }
      }
    }
    if (!any) return ambiguous ? { ambiguous: true } : null;
    const count = mask.reduce((s, b) => s + (b ? 1 : 0), 0);
    return { mask, desc: descs.join(' and '), count };
  };
  if (has('how many', 'count', 'number of', 'percentage', 'percent', 'share', 'proportion', ' over ', ' under ', ' above ', ' below ', 'greater than', 'less than', 'more than', 'at least', 'at most', ' for ', ' where ', 'what % ')) {
    const aggWord = has('average', 'mean', 'avg', 'sum', 'total', 'max', 'maximum', 'min', 'minimum', 'median');
    const measHint = mentioned.find((c) => c.type === 'numeric') || (aggWord ? (a.measure || numeric[0]) : null);
    const filt = buildMask(aggWord ? measHint : null);
    if (filt && filt.ambiguous) {
      return { text: `I found a numeric condition but couldn't tell which column you mean. Your numeric columns are ${numeric.map((c) => c.name).join(', ')} \u2014 name one, e.g. "how many where ${(numeric[0] || {}).name} > 60".`, facts: {}, followups: followupsFor() };
    }
    if (filt) {
      const pct = (100 * filt.count / nRows).toFixed(1);
      const meas = (aggWord ? measHint : null) || mentioned.find((c) => c.type === 'numeric' && !filt.desc.includes(c.name));
      if (aggWord && meas) {
        const vals = []; for (let i = 0; i < nRows; i++) if (filt.mask[i] && data[meas.name][i] !== null) vals.push(data[meas.name][i]);
        const s = stats(vals);
        if (s) { let val, word;
          if (has('average', 'mean', 'avg')) { val = s.mean; word = 'average'; }
          else if (has('median')) { val = s.median; word = 'median'; }
          else if (has('max', 'maximum')) { val = s.max; word = 'maximum'; }
          else if (has('min', 'minimum')) { val = s.min; word = 'minimum'; }
          else { val = s.sum; word = 'total'; }
          return { text: `Among rows where **${filt.desc}** (${filt.count.toLocaleString()} rows), the **${word} of ${meas.name}** is **${num(val)}**.`, facts: { filter: filt.desc, n: filt.count, [word]: +val.toFixed(2) }, followups: followupsFor() };
        }
      }
      return { text: `**${filt.count.toLocaleString()}** rows match **${filt.desc}** \u2014 that's **${pct}%** of ${nRows.toLocaleString()} total.`, facts: { filter: filt.desc, count: filt.count, pct: +pct }, followups: followupsFor() };
    }
  }

  if (has('how many row', 'number of row', 'how many record', 'row count', 'how big', 'size of', 'how many entries'))
    return remember({ text: `Your dataset has **${nRows.toLocaleString()} rows** and **${cols.length} columns** after cleaning (${numeric.length} numeric, ${categorical.length} categorical, ${datetime.length} date).`, facts: { rows: nRows, cols: cols.length }, followups: followupsFor() });

  if (has('missing', 'null', 'empty value', 'incomplete', 'blank', 'gaps')) {
    const miss = cols.filter((c) => c.missingPct > 0).sort((x, y) => y.missingPct - x.missingPct);
    if (!miss.length) return { text: 'Good news — **no missing values** remain. Every column is complete after cleaning.', facts: { missing: 0 }, followups: followupsFor() };
    const top = miss.slice(0, 6);
    return { text: `**${miss.length} column${miss.length > 1 ? 's have' : ' has'} missing data.** The gaps are largest in ` + top.map((c) => `**${c.name}** (${c.missingPct}%)`).join(', ') + `. These were imputed for analysis (median for numbers, mode for categories).`,
      facts: { columns_with_missing: miss.length, worst: top.map((c) => ({ column: c.name, pct: c.missingPct })) },
      chart: { type: 'bar', orientation: 'h', x: top.map((c) => c.missingPct), y: top.map((c) => c.name), color: '#F2C24B', title: 'Missing % by column', suffix: '%' }, followups: followupsFor() };
  }

  const twoNumsMentioned = mentioned.filter((c) => c.type === 'numeric').slice(0, 2);
  const wantsCorr = has('correlation', 'correlate', 'correlated') ||
    (twoNumsMentioned.length === 2 && has('relationship', 'related', 'vs', 'versus', 'against', 'compare', 'associated'));
  if (wantsCorr) {
    const twoNums = twoNumsMentioned;
    if (twoNums.length === 2) {
      const r = pearson(data[twoNums[0].name], data[twoNums[1].name]);
      const strength = r === null ? 'no measurable' : Math.abs(r) > 0.6 ? 'strong' : Math.abs(r) > 0.3 ? 'moderate' : 'weak';
      const xs = [], ys = [];
      for (let i = 0; i < nRows; i++) { const a1 = data[twoNums[0].name][i], b1 = data[twoNums[1].name][i]; if (a1 !== null && b1 !== null) { xs.push(a1); ys.push(b1); } }
      return { text: `**${twoNums[0].name}** and **${twoNums[1].name}** show a **${strength}${r !== null ? ` ${r < 0 ? 'negative' : 'positive'}` : ''} correlation** (r = ${r === null ? 'n/a' : r.toFixed(3)}).${r !== null && Math.abs(r) < 0.3 ? ' In practice they move fairly independently.' : ''}`,
        facts: { a: twoNums[0].name, b: twoNums[1].name, r }, chart: { type: 'scatter', x: xs, y: ys, xt: twoNums[0].name, yt: twoNums[1].name, title: `${twoNums[0].name} vs ${twoNums[1].name}` }, followups: followupsFor() };
    }
    if (a.corr.length) { const c = a.corr[0]; return { text: `Name two numeric columns and I'll measure their correlation for you. For reference, the strongest pair in this dataset is **${c.a} ↔ ${c.b}** (r = ${c.r}).`, facts: { top_pair: c }, followups: followupsFor() }; }
  }

  if (has('trend', 'over time', 'by month', 'monthly', 'time series', 'growth', 'evolution', 'seasonal', 'trending')) {
    if (a.trend) { const tr = a.trend;
      return remember({ text: `**${tr.measure}** is trending **${tr.direction}** — ${tr.pctChange > 0 ? '+' : ''}${tr.pctChange}% from ${tr.keys[0]} to ${tr.keys[tr.keys.length - 1]} across ${tr.keys.length} months.`,
        facts: { measure: tr.measure, direction: tr.direction, pct_change: tr.pctChange }, chart: { type: 'line', x: tr.keys, y: tr.series, color: '#F2A968', title: `${tr.measure} over time` }, followups: followupsFor('trend') });
    }
    return { text: "There's no date column here, so I can't plot a time trend. I can still break this down by a category or summarize a numeric column.", facts: {}, followups: followupsFor() };
  }

  if (has('top', 'bottom', 'break down', 'breakdown', ' by ', ' per ', 'group', 'rank', 'best', 'worst', 'highest', 'lowest', 'which ', 'what about', 'compare')) {
    if (measure && dimension) {
      const fn = has('average', 'mean', 'avg') ? 'mean' : has('count', 'how many') ? 'count' : 'sum';
      const { rows, metric } = aggregate(measure, dimension, fn);
      const ascending = has('bottom', 'worst', 'lowest');
      const view = (ascending ? [...rows].reverse() : rows).slice(0, topN);
      const label = metric === 'mean' ? `average ${measure.name}` : metric === 'count' ? 'record count' : `total ${measure.name}`;
      const lead = view[0], total = rows.reduce((s, r) => s + r[metric], 0);
      const share = total ? ((lead[metric] / total) * 100).toFixed(1) : '0';
      return remember({ text: `By **${label}**, **${lead.key}** leads ${dimension.name} at **${num(lead[metric])}** (${share}% of the total)${view[1] ? `, followed by **${view[1].key}** (${num(view[1][metric])})` : ''}.`,
        facts: { measure: measure.name, dimension: dimension.name, metric, top: view.slice(0, 5).map((r) => ({ key: r.key, value: +r[metric].toFixed(2) })) },
        chart: { type: 'bar', x: view.map((r) => r.key), y: view.map((r) => r[metric]), color: '#F2A968', title: `${label} by ${dimension.name}` }, followups: followupsFor('breakdown') });
    }
  }

  if (has('average', 'mean', 'sum', 'total', 'max', 'maximum', 'min', 'minimum', 'median', 'avg', 'typical')) {
    if (measure && (mentioned.some((c) => c.type === 'numeric') || has('revenue','sales','amount','total','price','value','it','that','this'))) {
      const s = stats(data[measure.name]);
      if (s) { let val, word;
        if (has('average', 'mean', 'avg', 'typical')) { val = s.mean; word = 'average'; }
        else if (has('median')) { val = s.median; word = 'median'; }
        else if (has('max', 'maximum', 'highest', 'largest')) { val = s.max; word = 'maximum'; }
        else if (has('min', 'minimum', 'lowest', 'smallest')) { val = s.min; word = 'minimum'; }
        else { val = s.sum; word = 'total'; }
        return remember({ text: `The **${word} of ${measure.name}** is **${num(val)}**.\nAcross ${s.n.toLocaleString()} values it ranges ${num(s.min)}\u2013${num(s.max)}, averaging ${num(s.mean)} (median ${num(s.median)}).`,
          facts: { column: measure.name, [word]: +val.toFixed(2), min: s.min, max: s.max, mean: +s.mean.toFixed(2) },
          chart: { type: 'hist', x: data[measure.name].filter((v) => v !== null), color: '#F2A968', title: `Distribution of ${measure.name}` }, followups: followupsFor('avg') });
      }
    }
  }

  if (has('distribution', 'histogram', 'spread', 'how are', 'range of', 'values of', 'vary')) {
    if (measure && (mentioned.some((c) => c.type === 'numeric') || ctx.lastMeasure)) {
      const s = stats(data[measure.name]);
      return remember({ text: `**${measure.name}** ranges from ${num(s.min)} to ${num(s.max)}, centered near ${num(s.median)} (mean ${num(s.mean)}, std ${num(s.std)}).`,
        facts: { column: measure.name, min: s.min, max: s.max, median: s.median }, chart: { type: 'hist', x: data[measure.name].filter((v) => v !== null), color: '#F2A968', title: `Distribution of ${measure.name}` }, followups: followupsFor() });
    }
    if (mCat) { const counts = {}; for (let i = 0; i < nRows; i++) { const v = imp[mCat.name][i]; if (v !== null) counts[v] = (counts[v] || 0) + 1; }
      const rows = Object.entries(counts).sort((x, y) => y[1] - x[1]).slice(0, 12);
      return remember({ text: `**${mCat.name}** has **${Object.keys(counts).length} categories**. Most common is **${rows[0][0]}** (${rows[0][1]} rows).`,
        facts: { column: mCat.name, categories: Object.keys(counts).length }, chart: { type: 'bar', x: rows.map((r) => r[0]), y: rows.map((r) => r[1]), color: '#E67E4D', title: `Count by ${mCat.name}` }, followups: followupsFor() });
    }
  }

  if (has('unique', 'distinct', 'how many different', 'categories', 'kinds of')) {
    const c = mentioned[0]; if (c) return remember({ text: `**${c.name}** has **${c.unique.toLocaleString()} unique value${c.unique > 1 ? 's' : ''}** (type: ${c.type}).`, facts: { column: c.name, unique: c.unique }, followups: followupsFor() });
  }

  if (has('describe', 'summary', 'summarize', 'tell me about', 'overview', 'what is this', 'what data', 'explain the data'))
    return remember({ text: `This dataset has **${nRows.toLocaleString()} rows** and **${cols.length} columns** (${numeric.length} numeric, ${categorical.length} categorical, ${datetime.length} date).\nThe headline finding: ${a.insights[0].text} ${a.insights[1] ? 'Also worth noting: ' + a.insights[1].text : ''}`, facts: { rows: nRows, cols: cols.length }, followups: followupsFor() });
  if (has('confidence', 'reliable', 'quality', 'trust', 'governance', 'score', 'how good'))
    return { text: `The current confidence score reflects seven signals \u2014 completeness, validity, uniqueness, type clarity, stability, sample robustness and field richness. Open the **Governance** view for the full breakdown and verdict.`, facts: {}, followups: followupsFor() };

  /* open-ended / domain question we can't compute from columns */
  const isQuestion = /\?/.test(raw) || /^(how|why|what|does|do|can|is|are|will|would|should|which|explain|tell|describe|cause|impact|effect|predict|diagnose)\b/.test(raw.toLowerCase());
  if (isQuestion && !mentioned.length) {
    const colList = cols.slice(0, 8).map((c) => c.name).join(', ');
    const ex = [];
    if (contNum.length >= 2) ex.push(`correlation between ${contNum[0].name} and ${contNum[1].name}`);
    if (measure) ex.push(`average ${measure.name}`);
    if (measure && dimension) ex.push(`${measure.name} by ${dimension.name}`);
    return { text: `I answer by computing directly from **this dataset**, so I can't reason about outside knowledge or causation the way a general chatbot can.\n\nYour columns are: ${colList}${cols.length > 8 ? '\u2026' : ''}. Ask me to compute something from them \u2014 e.g. ${ex.slice(0, 2).map((e) => `"${e}"`).join(' or ')}.\n\n**Want GPT/Claude-style answers to open questions like this?** Turn on **AI mode** at the top of this panel and add a key \u2014 then I'll answer conversationally, grounded in your data.`,
      facts: {}, followups: followupsFor() };
  }

  return { text: `I compute answers straight from your data. Try ${followupsFor().map((f) => `"${f}"`).join(', ')} \u2014 or ask about totals, averages, missing values, or a specific column. For open-ended questions, turn on **AI mode** above.`, facts: {}, followups: followupsFor() };
}

if (typeof module !== 'undefined') module.exports = { answerQuestion };
