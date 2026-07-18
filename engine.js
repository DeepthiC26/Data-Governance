/* ============================================================================
   Data Governance — analytics + governance engine (pure, framework-free).
   All functions are pure and operate on plain arrays/objects so they can be
   unit-tested in Node and reused unchanged in the browser.
   ========================================================================== */

/* ---------- small helpers ------------------------------------------------- */
const isBlank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const cleanNumStr = (s) => String(s).replace(/[,$€£₹%\s]/g, '');

function parseNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  if (isBlank(v)) return null;
  const s = cleanNumStr(v);
  if (s === '' || s === '-' || s === '.') return null;
  if (!/^-?\d*\.?\d+(?:e-?\d+)?$/i.test(s)) return null;
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
}

const MONTHS = /jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec/i;
function looksDateLike(v) {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length < 4) return false;
  // require a date separator or a month name to avoid treating plain ints as dates
  return (/[-/:]/.test(s) && /\d/.test(s)) || MONTHS.test(s);
}
function parseDate(v) {
  if (isBlank(v)) return null;
  if (!looksDateLike(v)) return null;
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
}

const BOOLS = { true: true, false: false, yes: true, no: false, y: true, n: false, t: true, f: false };
function parseBool(v) {
  if (typeof v === 'boolean') return v;
  if (isBlank(v)) return null;
  const s = String(v).trim().toLowerCase();
  return s in BOOLS ? BOOLS[s] : null;
}

/* ---------- statistics ---------------------------------------------------- */
function stats(nums) {
  const a = nums.filter((x) => x !== null && isFinite(x)).sort((x, y) => x - y);
  const n = a.length;
  if (!n) return null;
  const sum = a.reduce((s, x) => s + x, 0);
  const mean = sum / n;
  const q = (p) => {
    const idx = (n - 1) * p, lo = Math.floor(idx), hi = Math.ceil(idx);
    return a[lo] + (a[hi] - a[lo]) * (idx - lo);
  };
  const variance = a.reduce((s, x) => s + (x - mean) ** 2, 0) / n;
  return {
    n, min: a[0], max: a[n - 1], mean, median: q(0.5),
    q1: q(0.25), q3: q(0.75), std: Math.sqrt(variance), sum,
  };
}

function pearson(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (xs[i] !== null && ys[i] !== null && isFinite(xs[i]) && isFinite(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  const n = pairs.length;
  if (n < 3) return null;
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
  for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; }
  const cov = sxy - (sx * sy) / n;
  const vx = sxx - (sx * sx) / n, vy = syy - (sy * sy) / n;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

/* ---------- type inference ------------------------------------------------ */
/* Returns per-column: type, and a validity ratio (share of non-blank cells
   that conform to the inferred type). */
function inferColumn(name, values) {
  const nonBlank = values.filter((v) => !isBlank(v));
  const total = values.length;
  const missing = total - nonBlank.length;
  const uniq = new Set(nonBlank.map((v) => String(v).trim())).size;

  if (nonBlank.length === 0) {
    return { name, type: 'empty', missing, missingPct: 100, unique: 0, validity: 0, constant: true };
  }

  const numOk = nonBlank.filter((v) => parseNumber(v) !== null).length;
  const dateOk = nonBlank.filter((v) => parseDate(v) !== null).length;
  const boolOk = nonBlank.filter((v) => parseBool(v) !== null).length;

  const rNum = numOk / nonBlank.length;
  const rDate = dateOk / nonBlank.length;
  const rBool = boolOk / nonBlank.length;

  let type, validity;
  if (rBool >= 0.99 && uniq <= 3) { type = 'boolean'; validity = rBool; }
  else if (rNum >= 0.8) { type = 'numeric'; validity = rNum; }
  else if (rDate >= 0.7) { type = 'datetime'; validity = rDate; }
  else {
    // categorical vs free text by cardinality ratio
    const ratio = uniq / nonBlank.length;
    type = (ratio > 0.6 && uniq > 40) ? 'text' : 'categorical';
    validity = 1; // strings always "valid" as strings
  }

  return {
    name, type,
    missing, missingPct: +(100 * missing / total).toFixed(2),
    unique: uniq, cardinality: +(uniq / total).toFixed(3),
    validity: +validity.toFixed(3),
    constant: uniq <= 1,
  };
}

/* ---------- transformation pipeline --------------------------------------- */
/* Produces a cleaned column-oriented dataset + a log of operations. */
function transform(rawRows, headers) {
  const log = [];
  const nRawRows = rawRows.length;

  // 1. trim string cells
  let trimmed = 0;
  const rows = rawRows.map((r) => {
    const o = {};
    for (const h of headers) {
      let v = r[h];
      if (typeof v === 'string') { const t = v.trim(); if (t !== v) trimmed++; v = t; }
      o[h] = v;
    }
    return o;
  });
  if (trimmed) log.push({ op: 'Trimmed whitespace', detail: `${trimmed} text cells cleaned` });

  // 2. drop fully-duplicate rows
  const seen = new Set();
  const deduped = [];
  for (const r of rows) {
    const key = headers.map((h) => r[h]).join('\u0001');
    if (seen.has(key)) continue;
    seen.add(key); deduped.push(r);
  }
  const dupCount = rows.length - deduped.length;
  if (dupCount) log.push({ op: 'Removed duplicate rows', detail: `${dupCount} exact duplicates dropped` });

  // 3. infer types
  const columns = headers.map((h) => inferColumn(h, deduped.map((r) => r[h])));

  // 4. build typed/cleaned columns + impute for analysis
  const data = {}; // name -> typed array (nulls for missing)
  const imputed = {};
  for (const col of columns) {
    const raw = deduped.map((r) => r[col.name]);
    let arr;
    if (col.type === 'numeric') {
      arr = raw.map(parseNumber);
      if (col.type === 'numeric' && (cleanNumStr(raw.find((v) => !isBlank(v)) ?? '') !== String(raw.find((v) => !isBlank(v)) ?? '')))
        log.push({ op: 'Coerced to number', detail: `“${col.name}” — stripped symbols/separators` });
    } else if (col.type === 'datetime') {
      arr = raw.map(parseDate);
      log.push({ op: 'Parsed dates', detail: `“${col.name}” → timestamps` });
    } else if (col.type === 'boolean') {
      arr = raw.map(parseBool);
    } else {
      arr = raw.map((v) => (isBlank(v) ? null : String(v)));
    }
    data[col.name] = arr;

    // imputation for analysis copies (original nulls preserved in `data`)
    if (col.missing > 0 && col.type !== 'text' && col.type !== 'empty') {
      if (col.type === 'numeric') {
        const s = stats(arr); const fill = s ? s.median : 0;
        imputed[col.name] = arr.map((v) => (v === null ? fill : v));
        log.push({ op: 'Imputed missing (median)', detail: `“${col.name}” — ${col.missing} cells → ${(+fill.toFixed(2))}` });
      } else if (col.type === 'categorical' || col.type === 'boolean') {
        const counts = {}; arr.forEach((v) => { if (v !== null) counts[v] = (counts[v] || 0) + 1; });
        const mode = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        const fill = mode ? mode[0] : 'Unknown';
        imputed[col.name] = arr.map((v) => (v === null ? fill : v));
        log.push({ op: 'Imputed missing (mode)', detail: `“${col.name}” — ${col.missing} cells → “${fill}”` });
      } else imputed[col.name] = arr;
    } else imputed[col.name] = arr;
  }

  // 5. flag constant / low-information columns
  for (const col of columns) {
    if (col.constant) log.push({ op: 'Flagged constant column', detail: `“${col.name}” carries no variation` });
  }

  // 6. outlier detection (IQR) on numeric columns — flagged, not removed
  const outliers = {};
  for (const col of columns) {
    if (col.type !== 'numeric') continue;
    const s = stats(data[col.name]);
    if (!s) continue;
    const iqr = s.q3 - s.q1, lo = s.q1 - 1.5 * iqr, hi = s.q3 + 1.5 * iqr;
    const cnt = data[col.name].filter((v) => v !== null && (v < lo || v > hi)).length;
    outliers[col.name] = cnt;
    if (cnt) log.push({ op: 'Flagged outliers', detail: `“${col.name}” — ${cnt} values outside 1.5×IQR` });
  }

  return { columns, data, imputed, outliers, log, nRawRows, nRows: deduped.length, dupCount, headers };
}

/* ---------- target detection + feature association (for analytical Q&A) ---- */
const TARGET_HINT = /(status|class|target|label|outcome|diagnos|disease|\bstage\b|severity|\bgroup\b|result|condition|ckd|parkinson|churn|surviv|default|fraud|positive|category|type)/i;
function detectTarget(columns) {
  const cand = columns.filter((c) => c.type !== 'datetime' && c.type !== 'text' && c.type !== 'empty' && c.unique >= 2 && c.unique <= 12 && !c.constant);
  if (!cand.length) return null;
  const score = (c) => (TARGET_HINT.test(c.name) ? 100 : 0) + (c.type === 'boolean' ? 30 : 0) + (c.type === 'categorical' ? 18 : 0) + (c.unique === 2 ? 15 : c.unique <= 6 ? 8 : 0);
  const ranked = [...cand].sort((a, b) => score(b) - score(a));
  const best = ranked[0];
  return (TARGET_HINT.test(best.name) || best.type === 'boolean' || best.type === 'categorical' || best.unique <= 6) ? best : null;
}
function numFromLabel(s){ const m=String(s).match(/-?\d+(\.\d+)?/); return m?parseFloat(m[0]):null; }
function encodeTarget(t, target) {
  const vals = t.imputed[target.name];
  if (target.type === 'numeric') return { codes: vals.map((v)=>v), ordinal: true, classes: null };
  const uniq = [...new Set(vals.filter((v) => v != null))];
  const allNum = uniq.every((u) => numFromLabel(u) !== null);
  uniq.sort(allNum ? (a, b) => numFromLabel(a) - numFromLabel(b) : undefined);
  const map = new Map(uniq.map((u, i) => [u, i]));
  return { codes: vals.map((v) => (v == null ? null : map.get(v))), ordinal: uniq.length > 2, classes: uniq, map };
}
function featureAssociations(t, target) {
  const enc = encodeTarget(t, target);
  const items = [];
  for (const c of t.columns) {
    if (c.name === target.name) continue;
    if (c.type !== 'numeric') continue;
    const r = pearson(t.data[c.name], enc.codes);
    if (r !== null) items.push({ feature: c.name, r: +r.toFixed(3), abs: Math.abs(r), dir: r >= 0 ? 'increases' : 'decreases' });
  }
  items.sort((a, b) => b.abs - a.abs);
  return { target: target.name, classes: enc.classes, ordinal: enc.ordinal, items };
}
function groupStats(t, measureName, groupName) {
  const acc = {};
  for (let i = 0; i < t.nRows; i++) {
    const g = t.imputed[groupName][i], v = t.imputed[measureName][i];
    if (g == null || v == null || !isFinite(v)) continue;
    (acc[g] = acc[g] || []).push(v);
  }
  const rows = Object.entries(acc).map(([k, arr]) => ({ group: k, mean: arr.reduce((s, x) => s + x, 0) / arr.length, n: arr.length }));
  const allNum = rows.every((r) => numFromLabel(r.group) !== null);
  if (allNum) rows.sort((a, b) => numFromLabel(a.group) - numFromLabel(b.group));
  else rows.sort((a, b) => b.mean - a.mean);
  return rows;
}
function compareGroups(t, target) {
  let classes, codes;
  const enc = encodeTarget(t, target);
  if (enc.classes && enc.classes.length === 2) { classes = enc.classes; codes = enc.codes; }
  else {
    const vals = t.imputed[target.name];
    const uniq = [...new Set(vals.filter((v) => v != null))];
    if (uniq.length !== 2) return null;
    uniq.sort((a, b) => (numFromLabel(a) ?? 0) - (numFromLabel(b) ?? 0));
    const map = new Map(uniq.map((u, i) => [u, i])); classes = uniq; codes = vals.map((v) => (v == null ? null : map.get(v)));
  }
  const [c0, c1] = classes;
  const out = [];
  for (const c of t.columns) {
    if (c.name === target.name || c.type !== 'numeric') continue;
    const a = [], b = [];
    for (let i = 0; i < t.nRows; i++) { const g = codes[i], v = t.data[c.name][i]; if (v == null || g == null) continue; (g === 0 ? a : b).push(v); }
    if (a.length < 3 || b.length < 3) continue;
    const m = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
    const sd = (arr, mu) => Math.sqrt(arr.reduce((s, x) => s + (x - mu) ** 2, 0) / arr.length) || 1e-9;
    const ma = m(a), mb = m(b), pooled = Math.sqrt((sd(a, ma) ** 2 + sd(b, mb) ** 2) / 2);
    const d = (mb - ma) / pooled;
    out.push({ feature: c.name, g0: +ma.toFixed(2), g1: +mb.toFixed(2), d: +d.toFixed(2), abs: Math.abs(d) });
  }
  out.sort((x, y) => y.abs - x.abs);
  return { c0, c1, items: out };
}

/* ---------- analysis: insights + trends ----------------------------------- */
const MEASURE_HINT = /revenue|sales|amount|total|value|price|profit|cost|spend|income|gmv|turnover/i;
function pickMeasure(numeric, data) {
  if (!numeric.length) return null;
  const hinted = numeric.filter((c) => MEASURE_HINT.test(c.name));
  const pool = hinted.length ? hinted : numeric;
  // among the pool, prefer the one with the largest spread (most to explain)
  let best = pool[0], bestSpread = -1;
  for (const c of pool) {
    const s = stats(data[c.name]); if (!s) continue;
    const spread = s.mean ? s.std / Math.abs(s.mean) : s.std;
    if (spread > bestSpread) { bestSpread = spread; best = c; }
  }
  return best;
}
function pickDimension(categorical) {
  // lowest-cardinality categorical that still varies (best for grouping)
  const usable = categorical.filter((c) => c.unique > 1 && c.unique <= 50);
  if (!usable.length) return categorical[0] || null;
  return usable.sort((a, b) => a.unique - b.unique)[0];
}

function analyze(t) {
  const { columns, data, imputed, outliers, nRows } = t;
  const numeric = columns.filter((c) => c.type === 'numeric');
  const categorical = columns.filter((c) => c.type === 'categorical');
  const datetime = columns.filter((c) => c.type === 'datetime');
  const measure = pickMeasure(numeric, data);
  const dimension = pickDimension(categorical);

  // correlations
  const corr = [];
  for (let i = 0; i < numeric.length; i++)
    for (let j = i + 1; j < numeric.length; j++) {
      const r = pearson(data[numeric[i].name], data[numeric[j].name]);
      if (r !== null) corr.push({ a: numeric[i].name, b: numeric[j].name, r: +r.toFixed(3) });
    }
  corr.sort((x, y) => Math.abs(y.r) - Math.abs(x.r));

  // trend (first datetime × first numeric)
  let trend = null;
  if (datetime.length && numeric.length) {
    const dcol = datetime[0].name, mcol = (measure || numeric[0]).name;
    const pts = [];
    for (let i = 0; i < nRows; i++) {
      const d = data[dcol][i], m = imputed[mcol][i];
      if (d !== null && m !== null) pts.push([d, m]);
    }
    pts.sort((a, b) => a[0] - b[0]);
    if (pts.length > 2) {
      // aggregate by month
      const buckets = {};
      for (const [d, m] of pts) {
        const dt = new Date(d); const key = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}`;
        buckets[key] = (buckets[key] || 0) + m;
      }
      const keys = Object.keys(buckets).sort();
      const series = keys.map((k) => buckets[k]);
      // linear slope over index
      const first = series[0], last = series[series.length - 1];
      const pct = first ? ((last - first) / Math.abs(first)) * 100 : 0;
      trend = { measure: mcol, date: dcol, keys, series,
        direction: pct > 5 ? 'up' : pct < -5 ? 'down' : 'flat',
        pctChange: +pct.toFixed(1) };
    }
  }

  // category breakdown (first categorical × first numeric, by sum)
  let breakdown = null;
  if (categorical.length && numeric.length) {
    const ccol = (dimension || categorical[0]).name, mcol = (measure || numeric[0]).name;
    const agg = {};
    for (let i = 0; i < nRows; i++) {
      const c = imputed[ccol][i], m = imputed[mcol][i];
      if (c !== null && m !== null) agg[c] = (agg[c] || 0) + m;
    }
    const rows = Object.entries(agg).map(([k, v]) => ({ key: k, value: v })).sort((a, b) => b.value - a.value);
    const total = rows.reduce((s, r) => s + r.value, 0);
    breakdown = { category: ccol, measure: mcol, rows: rows.slice(0, 12), total };
  }

  /* insights (ranked natural-language highlights) */
  const insights = [];
  if (t.dupCount) insights.push({ w: 3, kind: 'quality', text: `Removed ${t.dupCount} duplicate row${t.dupCount > 1 ? 's' : ''} during cleaning.` });
  const worstMissing = [...columns].filter((c) => c.missingPct > 0).sort((a, b) => b.missingPct - a.missingPct)[0];
  if (worstMissing) insights.push({ w: worstMissing.missingPct > 20 ? 5 : 2, kind: 'quality', text: `“${worstMissing.name}” has the most missing data at ${worstMissing.missingPct}%${worstMissing.missingPct > 20 ? ' — treat its analysis with caution.' : '.'}` });
  if (breakdown && breakdown.rows.length) {
    const top = breakdown.rows[0]; const share = (100 * top.value / breakdown.total).toFixed(1);
    insights.push({ w: 4, kind: 'trend', text: `“${top.key}” leads ${breakdown.category} by ${breakdown.measure}, at ${share}% of the total.` });
  }
  if (trend) insights.push({ w: 4, kind: 'trend', text: trend.direction === 'flat'
    ? `${trend.measure} stays broadly flat over the period.`
    : `${trend.measure} trends ${trend.direction} ${Math.abs(trend.pctChange)}% from first to last month.` });
  if (corr.length) {
    const c = corr[0]; const strength = Math.abs(c.r) > 0.6 ? 'strong' : Math.abs(c.r) > 0.3 ? 'moderate' : 'weak';
    insights.push({ w: Math.abs(c.r) > 0.6 ? 4 : 2, kind: 'stat', text: `${c.a} and ${c.b} show a ${strength} ${c.r < 0 ? 'negative' : 'positive'} correlation (r=${c.r}).` });
  }
  const constCols = columns.filter((c) => c.constant);
  if (constCols.length) insights.push({ w: 2, kind: 'quality', text: `${constCols.length} column${constCols.length > 1 ? 's carry' : ' carries'} no variation and add little signal.` });
  const bigOutlier = Object.entries(outliers).sort((a, b) => b[1] - a[1])[0];
  if (bigOutlier && bigOutlier[1] > 0) insights.push({ w: 2, kind: 'stat', text: `“${bigOutlier[0]}” contains ${bigOutlier[1]} statistical outlier${bigOutlier[1] > 1 ? 's' : ''}.` });
  insights.push({ w: 1, kind: 'stat', text: `Dataset spans ${nRows} rows across ${columns.length} fields (${numeric.length} numeric, ${categorical.length} categorical, ${datetime.length} date).` });
  insights.sort((a, b) => b.w - a.w);

  const target = detectTarget(columns);
  const assoc = target ? featureAssociations(t, target) : null;
  return { numeric, categorical, datetime, measure, dimension, corr, trend, breakdown, insights, target, assoc };
}

/* ---------- Data Governance confidence score ----------------------------- */
/* Composite of transparent sub-scores, each 0..100. */
function govern(t, a) {
  const { columns, data, outliers, nRows, nRawRows } = t;
  const cells = columns.length * nRows || 1;

  const totalMissing = columns.reduce((s, c) => s + c.missing, 0);
  const completeness = 100 * (1 - totalMissing / cells);

  const uniqueness = 100 * (1 - (t.dupCount / (nRawRows || 1)));

  const validity = 100 * (columns.reduce((s, c) => s + (c.validity ?? 1), 0) / (columns.length || 1));

  const typed = columns.filter((c) => c.type !== 'text' && c.type !== 'empty').length;
  const typeConfidence = 100 * (typed / (columns.length || 1));

  let numOutlier = 0, numCells = 0;
  for (const c of columns) if (c.type === 'numeric') { numOutlier += outliers[c.name] || 0; numCells += nRows; }
  const stability = numCells ? 100 * (1 - numOutlier / numCells) : 90;

  // analytical robustness grows with sample size (log-scaled, saturates ~5k rows)
  const robustness = Math.max(20, Math.min(100, 100 * (Math.log10(Math.max(nRows, 1)) / Math.log10(5000))));

  const richness = 100 * ((a.numeric.length > 0 ? 0.4 : 0) + (a.categorical.length > 0 ? 0.3 : 0) + (a.datetime.length > 0 ? 0.3 : 0));

  const parts = [
    { key: 'Completeness', value: completeness, weight: 0.22, hint: 'Share of cells present after cleaning' },
    { key: 'Validity', value: validity, weight: 0.20, hint: 'Values conforming to their inferred type' },
    { key: 'Uniqueness', value: uniqueness, weight: 0.12, hint: 'Freedom from duplicate records' },
    { key: 'Type clarity', value: typeConfidence, weight: 0.12, hint: 'Columns resolved to a concrete type' },
    { key: 'Stability', value: stability, weight: 0.12, hint: 'Numeric values within expected range' },
    { key: 'Robustness', value: robustness, weight: 0.12, hint: 'Sample size supporting the analysis' },
    { key: 'Richness', value: richness, weight: 0.10, hint: 'Variety of analyzable field types' },
  ].map((p) => ({ ...p, value: Math.max(0, Math.min(100, +p.value.toFixed(1))) }));

  let score = +parts.reduce((s, p) => s + p.value * p.weight, 0).toFixed(1);
  // Governance guard: small samples cannot certify as fully reliable.
  const cap = nRows >= 500 ? 100 : nRows >= 100 ? 88 : nRows >= 30 ? 78 : nRows >= 10 ? 62 : 50;
  let capped = false;
  if (score > cap) { score = cap; capped = true; }
  const band = score >= 85 ? { label: 'Reliable', tone: 'good' }
    : score >= 70 ? { label: 'Moderate', tone: 'ok' }
    : score >= 50 ? { label: 'Guarded', tone: 'warn' }
    : { label: 'Low', tone: 'bad' };

  const verdict = band.tone === 'good'
    ? 'The transformed data and insights are well-supported and safe to act on.'
    : band.tone === 'ok'
    ? 'Insights are usable, but review the flagged quality gaps before high-stakes decisions.'
    : band.tone === 'warn'
    ? 'Treat insights as directional — data quality or sample size limits reliability.'
    : 'Insights are weakly supported; clean or expand the dataset before relying on them.';

  const verdictFull = capped ? verdict + ` Score is capped by the small sample (${nRows} rows).` : verdict;
  return { score, band, verdict: verdictFull, parts, capped, cap };
}

/* full pipeline */
function runPipeline(rawRows, headers) {
  const t = transform(rawRows, headers);
  const a = analyze(t);
  const g = govern(t, a);
  return { t, a, g };
}

if (typeof module !== 'undefined') module.exports = { parseNumber, parseDate, inferColumn, transform, analyze, govern, runPipeline, stats, pearson, detectTarget, featureAssociations, groupStats, compareGroups, encodeTarget };
