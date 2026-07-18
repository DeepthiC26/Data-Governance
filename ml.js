/* ============================================================================
   Data Governance — client-side ML engine (pure JS, node-testable).
   Real algorithms, no libraries: standardization, k-means (++init),
   silhouette, PCA-to-2D (power iteration), least-squares forecast, z-score /
   IQR anomaly detection. Everything runs in the browser.
   ========================================================================== */

/* ---------- matrix helpers ------------------------------------------------ */
function buildMatrix(data, cols, nRows) {
  // rows with all features present; returns { X, idx } (idx maps back to row)
  const X = [], idx = [];
  for (let i = 0; i < nRows; i++) {
    const row = [];
    let ok = true;
    for (const c of cols) { const v = data[c][i]; if (v === null || !isFinite(v)) { ok = false; break; } row.push(v); }
    if (ok) { X.push(row); idx.push(i); }
  }
  return { X, idx };
}
function standardize(X) {
  const n = X.length, d = X[0].length;
  const mean = Array(d).fill(0), std = Array(d).fill(0);
  for (const r of X) for (let j = 0; j < d; j++) mean[j] += r[j] / n;
  for (const r of X) for (let j = 0; j < d; j++) std[j] += (r[j] - mean[j]) ** 2 / n;
  for (let j = 0; j < d; j++) std[j] = Math.sqrt(std[j]) || 1;
  const Z = X.map((r) => r.map((v, j) => (v - mean[j]) / std[j]));
  return { Z, mean, std };
}
const dist2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };

/* ---------- k-means (with k-means++ seeding) ------------------------------ */
function kmeans(Z, k, maxIter = 60) {
  const n = Z.length, d = Z[0].length;
  if (n < k) k = Math.max(1, n);
  // k-means++ init
  const centroids = [Z[Math.floor(Math.random() * n)].slice()];
  while (centroids.length < k) {
    const dmin = Z.map((p) => Math.min(...centroids.map((c) => dist2(p, c))));
    const sum = dmin.reduce((a, b) => a + b, 0) || 1;
    let r = Math.random() * sum, pick = 0;
    for (let i = 0; i < n; i++) { r -= dmin[i]; if (r <= 0) { pick = i; break; } }
    centroids.push(Z[pick].slice());
  }
  let labels = new Array(n).fill(0);
  for (let it = 0; it < maxIter; it++) {
    let moved = false;
    // assign
    for (let i = 0; i < n; i++) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < k; c++) { const dd = dist2(Z[i], centroids[c]); if (dd < bd) { bd = dd; best = c; } }
      if (labels[i] !== best) { labels[i] = best; moved = true; }
    }
    // update
    const sums = Array.from({ length: k }, () => Array(d).fill(0)), cnt = Array(k).fill(0);
    for (let i = 0; i < n; i++) { cnt[labels[i]]++; const r = Z[i]; const s = sums[labels[i]]; for (let j = 0; j < d; j++) s[j] += r[j]; }
    for (let c = 0; c < k; c++) if (cnt[c]) for (let j = 0; j < d; j++) centroids[c][j] = sums[c][j] / cnt[c];
    if (!moved && it > 0) break;
  }
  // inertia
  let inertia = 0; for (let i = 0; i < n; i++) inertia += dist2(Z[i], centroids[labels[i]]);
  return { labels, centroids, k, inertia };
}

/* silhouette (sampled for speed on large n) */
function silhouette(Z, labels, k) {
  const n = Z.length; if (k < 2) return 0;
  const sampleIdx = n > 600 ? Array.from({ length: 600 }, () => Math.floor(Math.random() * n)) : Z.map((_, i) => i);
  const byCluster = Array.from({ length: k }, () => []);
  Z.forEach((p, i) => byCluster[labels[i]].push(i));
  let total = 0, cnt = 0;
  for (const i of sampleIdx) {
    const ci = labels[i];
    if (byCluster[ci].length <= 1) continue;
    const meanTo = (members) => { let s = 0, m = 0; for (const j of members) { if (j === i) continue; s += Math.sqrt(dist2(Z[i], Z[j])); m++; } return m ? s / m : 0; };
    const a = meanTo(byCluster[ci]);
    let b = Infinity;
    for (let c = 0; c < k; c++) { if (c === ci || !byCluster[c].length) continue; b = Math.min(b, meanTo(byCluster[c])); }
    if (!isFinite(b)) continue;
    total += (b - a) / Math.max(a, b); cnt++;
  }
  return cnt ? +(total / cnt).toFixed(3) : 0;
}

/* choose best k by silhouette across 2..maxK */
function autoCluster(data, numericCols, nRows, maxK = 5) {
  const cols = numericCols.slice(0, 6).map((c) => c.name);
  if (cols.length < 2) return null;
  const { X, idx } = buildMatrix(data, cols, nRows);
  if (X.length < 10) return null;
  const { Z } = standardize(X);
  let best = null;
  for (let k = 2; k <= Math.min(maxK, Math.floor(X.length / 3)); k++) {
    const km = kmeans(Z, k);
    const sil = silhouette(Z, km.labels, k);
    if (!best || sil > best.sil) best = { ...km, sil };
  }
  if (!best) return null;
  const proj = pca2(Z);
  // cluster sizes
  const sizes = Array(best.k).fill(0); best.labels.forEach((l) => sizes[l]++);
  return { cols, idx, labels: best.labels, k: best.k, silhouette: best.sil, sizes,
    points: proj.map((p, i) => ({ x: p[0], y: p[1], c: best.labels[i] })),
    axes: proj.axes };
}

/* ---------- PCA to 2D via power iteration --------------------------------- */
function pca2(Z) {
  const n = Z.length, d = Z[0].length;
  // covariance d×d
  const C = Array.from({ length: d }, () => Array(d).fill(0));
  for (const r of Z) for (let a = 0; a < d; a++) for (let b = 0; b < d; b++) C[a][b] += r[a] * r[b] / n;
  const matVec = (M, v) => M.map((row) => row.reduce((s, x, j) => s + x * v[j], 0));
  const norm = (v) => { const m = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1; return v.map((x) => x / m); };
  const powIter = (M) => { let v = norm(Array.from({ length: d }, () => Math.random())); for (let i = 0; i < 50; i++) v = norm(matVec(M, v)); return v; };
  const v1 = powIter(C);
  // deflate
  const lam = matVec(C, v1).reduce((s, x, i) => s + x * v1[i], 0);
  const C2 = C.map((row, a) => row.map((x, b) => x - lam * v1[a] * v1[b]));
  const v2 = d > 1 ? powIter(C2) : v1.map(() => 0);
  const proj = Z.map((r) => [r.reduce((s, x, j) => s + x * v1[j], 0), r.reduce((s, x, j) => s + x * v2[j], 0)]);
  proj.axes = { v1, v2 };
  return proj;
}

/* ---------- forecast: least-squares trend + horizon ----------------------- */
function forecast(trend, horizon = 3) {
  if (!trend || !trend.series || trend.series.length < 4) return null;
  const y = trend.series, n = y.length;
  const x = y.map((_, i) => i);
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0; for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; }
  const b = sxx ? sxy / sxx : 0, a = my - b * mx;
  const fit = x.map((xi) => a + b * xi);
  // in-sample fit quality
  let ssRes = 0, ssTot = 0, mape = 0, mc = 0;
  for (let i = 0; i < n; i++) { ssRes += (y[i] - fit[i]) ** 2; ssTot += (y[i] - my) ** 2; if (y[i]) { mape += Math.abs((y[i] - fit[i]) / y[i]); mc++; } }
  const r2 = ssTot ? Math.max(0, 1 - ssRes / ssTot) : 0;
  mape = mc ? mape / mc : 1;
  // future labels: extend month keys
  const future = [];
  const last = trend.keys[trend.keys.length - 1];
  let [yy, mm] = last.split('-').map(Number);
  for (let h = 1; h <= horizon; h++) { mm++; if (mm > 12) { mm = 1; yy++; } future.push(`${yy}-${String(mm).padStart(2, '0')}`); }
  const proj = future.map((_, h) => a + b * (n - 1 + h + 1));
  return { keys: trend.keys, actual: y, fit, futureKeys: future, forecast: proj,
    slope: b, r2: +r2.toFixed(3), mape: +mape.toFixed(3), measure: trend.measure };
}

/* ---------- anomaly detection (robust z-score / IQR) ---------------------- */
function detectAnomalies(data, col, nRows) {
  const vals = [], idx = [];
  for (let i = 0; i < nRows; i++) { const v = data[col][i]; if (v !== null && isFinite(v)) { vals.push(v); idx.push(i); } }
  if (vals.length < 12) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const absDev = vals.map((v) => Math.abs(v - median)).sort((a, b) => a - b);
  const mad = absDev[Math.floor(absDev.length / 2)] || 1e-9;
  // Iglewicz–Hoaglin modified z-score; |M|>3.5 = anomaly
  const mz = (v) => 0.6745 * (v - median) / mad;
  const points = vals.map((v, i) => ({ i: idx[i], v, z: +mz(v).toFixed(2), anomaly: Math.abs(mz(v)) > 3.5 }));
  const count = points.filter((p) => p.anomaly).length;
  return { col, points, count, share: +(100 * count / vals.length).toFixed(2), median: +median.toFixed(2), mad: +mad.toFixed(2) };
}

/* ---------- ML pipeline orchestration ------------------------------------- */
function runML(t, a) {
  const cluster = autoCluster(t.data, a.numeric, t.nRows);
  const fc = forecast(a.trend, 3);
  const anomCol = (a.measure || a.numeric[0]);
  const anomalies = anomCol ? detectAnomalies(t.data, anomCol.name, t.nRows) : null;
  // ML confidence contributions (0..1)
  const signals = [];
  if (cluster) signals.push(Math.max(0, Math.min(1, (cluster.silhouette + 0.2) / 0.9))); // silhouette ~ -1..1, good>0.5
  if (fc) signals.push(Math.max(fc.r2, 1 - Math.min(1, fc.mape)));
  if (anomalies) signals.push(1 - Math.min(0.5, anomalies.share / 100) / 0.5 * 0.5); // fewer anomalies → cleaner
  const mlConfidence = signals.length ? +(100 * signals.reduce((s, x) => s + x, 0) / signals.length).toFixed(1) : null;
  return { cluster, forecast: fc, anomalies, mlConfidence };
}

if (typeof module !== 'undefined') module.exports = { kmeans, silhouette, autoCluster, pca2, forecast, detectAnomalies, runML, standardize, buildMatrix };
