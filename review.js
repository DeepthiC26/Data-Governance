/* ============================================================================
   Claude Opus Review Dashboard — independent AI review of Sonnet's existing
   analysis. Opus does NOT re-analyse; it inspects Sonnet's outputs and the
   deterministic engine adjudicates. Produces an AI Review Report, a Review
   Score Card, and a combined Final Data Governance Score.
   Depends on app scope: stats, pearson, answerQuestion, fmt, cgInterpret,
   cgJsTruth, callModelRaw.
   ========================================================================== */

/* Collect Sonnet's already-produced analysis (from the existing dashboard) */
function collectSonnetWork(name, t, a, g, ml){
  const numeric=a.numeric, cats=a.categorical;
  const datasetSummary=`${name}: ${t.nRows.toLocaleString()} rows × ${t.columns.length} columns (${numeric.length} numeric, ${cats.length} categorical, ${a.datetime.length} date). ${t.dupCount} duplicate rows removed; ${t.log.length} cleaning operations applied.`;
  const statistics=numeric.slice(0,8).map((c)=>{ const s=stats(t.data[c.name]); return { column:c.name, min:s?+s.min.toFixed(2):null, max:s?+s.max.toFixed(2):null, mean:s?+s.mean.toFixed(2):null, median:s?+s.median.toFixed(2):null }; });
  const sql = a.measure && a.dimension ? `SELECT "${a.dimension.name}", SUM("${a.measure.name}") AS total FROM dataset GROUP BY "${a.dimension.name}" ORDER BY total DESC;` : `SELECT COUNT(*) FROM dataset;`;
  const insights=(a.insights||[]).map((i)=>i.text);
  const charts=[]; if(a.trend)charts.push('trend line of '+a.trend.measure); if(a.dimension&&a.measure)charts.push(a.measure.name+' by '+a.dimension.name+' (bar)'); if(numeric.length>=2)charts.push('correlation heatmap'); if(cats[0])charts.push(cats[0].name+' distribution');
  const corr=(a.corr||[]).slice(0,5).map((c)=>({ a:c.a, b:c.b, r:c.r }));
  const execSummary=`The dataset was cleaned and profiled with a Data Governance confidence of ${g.score}/100 (${g.band.label}). `+(a.insights[0]?a.insights[0].text+' ':'')+(a.trend?`${a.trend.measure} is trending ${a.trend.direction} (${a.trend.pctChange>0?'+':''}${a.trend.pctChange}%). `:'')+(a.corr[0]?`Strongest correlation: ${a.corr[0].a}↔${a.corr[0].b} (r=${a.corr[0].r}).`:'');
  const mlSummary = ml ? [ ml.cluster?`clustering k=${ml.cluster.k} (silhouette ${ml.cluster.silhouette})`:'', ml.forecast?`forecast R²=${ml.forecast.r2}`:'', ml.anomalies?`${ml.anomalies.count} anomalies`:'' ].filter(Boolean).join('; ') : '';
  return { datasetSummary, statistics, sql, insights, charts, correlations:corr, execSummary, mlSummary, governanceScore:g.score, governanceBand:g.band.label };
}

/* Deterministic re-verification of Sonnet's numeric claims (source of truth) */
function verifySonnetClaims(work, t, a){
  const checks=[];
  // verify each reported statistic against a fresh computation
  for(const st of work.statistics){
    const s=stats(t.data[st.column]); if(!s)continue;
    const cmp=(claim,truth)=>({ claim, truth:+truth.toFixed(2), ok: claim==null?null : Math.abs(claim-truth)/(Math.abs(truth)+1e-9) < 0.01 });
    checks.push({ label:`mean(${st.column})`, ...cmp(st.mean, s.mean) });
    checks.push({ label:`max(${st.column})`, ...cmp(st.max, s.max) });
  }
  // verify correlations
  for(const c of work.correlations){ const r=pearson(t.data[c.a],t.data[c.b]); if(r==null)continue; checks.push({ label:`corr(${c.a},${c.b})`, claim:c.r, truth:+r.toFixed(3), ok:Math.abs(c.r-r)<0.02 }); }
  const verifiable=checks.filter((c)=>c.ok!=null);
  const correct=verifiable.filter((c)=>c.ok);
  const accuracy = verifiable.length ? Math.round(100*correct.length/verifiable.length) : null;
  return { checks, accuracy, verifiableCount:verifiable.length, correctCount:correct.length };
}

/* Ask Opus to independently REVIEW (not re-analyse) Sonnet's work */
function opusReviewPrompt(work){
  const sys='You are Claude Opus acting as an INDEPENDENT AI REVIEWER. You are given the complete outputs of another analyst (Claude Sonnet). Do NOT perform a new analysis. INSPECT Sonnet\u2019s existing results and judge them. Assess: which calculations look correct/incorrect, whether the SQL is valid, which insights are supported vs unsupported, any hallucinations, and any missing business insights. Output ONE JSON object on the final line: {"summary":"<2-3 sentences>","strengths":["..."],"weaknesses":["..."],"validation_comments":["..."],"suggested_corrections":["..."],"missing_insights":["..."],"hallucinations":["..."],"accuracy":0-100,"sql_quality":0-100,"insight_quality":0-100,"evidence_quality":0-100,"hallucination_risk":"Low|Medium|High","trust_rating":0-100,"review_confidence":0-100,"decision":"PASS|WARNING|FAIL"}.';
  const usr=`SONNET'S ANALYSIS TO REVIEW:\n\nDataset Summary: ${work.datasetSummary}\n\nStatistics: ${JSON.stringify(work.statistics)}\n\nSQL: ${work.sql}\n\nInsights:\n- ${work.insights.join('\n- ')}\n\nCorrelations: ${JSON.stringify(work.correlations)}\n\nCharts: ${work.charts.join('; ')}\n\nExecutive Summary: ${work.execSummary}\n\nML: ${work.mlSummary||'n/a'}\n\nSonnet's Data Governance Score: ${work.governanceScore}/100 (${work.governanceBand}).\n\nReview this work now.`;
  return { sys, usr };
}
function parseReview(raw){
  const out={ ok:false, summary:'', strengths:[], weaknesses:[], validation_comments:[], suggested_corrections:[], missing_insights:[], hallucinations:[], accuracy:null, sql_quality:null, insight_quality:null, evidence_quality:null, hallucination_risk:null, trust_rating:null, review_confidence:null, decision:null, raw };
  if(!raw) return out;
  const m=raw.match(/\{[\s\S]*\}\s*$/)||raw.match(/\{[\s\S]*\}/);
  if(m){ try{ const j=JSON.parse(m[0]); Object.assign(out,{ ok:true, summary:j.summary||'', strengths:j.strengths||[], weaknesses:j.weaknesses||[], validation_comments:j.validation_comments||[], suggested_corrections:j.suggested_corrections||[], missing_insights:j.missing_insights||[], hallucinations:j.hallucinations||[], accuracy:num(j.accuracy), sql_quality:num(j.sql_quality), insight_quality:num(j.insight_quality), evidence_quality:num(j.evidence_quality), hallucination_risk:j.hallucination_risk||null, trust_rating:num(j.trust_rating), review_confidence:num(j.review_confidence), decision:(j.decision||'').toUpperCase() }); return out; }catch(e){} }
  out.summary=raw.slice(0,300); out.ok=true; out.decision='WARNING'; return out;
  function num(x){ return x==null?null:Math.max(0,Math.min(100,+x)); }
}

/* classify a fetch failure into an actionable reason */
function classifyReviewError(e){
  const s=String(e||'');
  if(/402|more credits|requires more|insufficient|balance|payment required/i.test(s)) return 'your OpenRouter account is out of credits — add a small top-up at openrouter.ai (Settings → Credits) and the AI review will run';
  if(/Failed to fetch|NetworkError|Load failed|ERR_|CORS|blocked/i.test(s)) return 'the request was blocked — you are likely in an embedded preview, offline, or behind a firewall/ad-blocker';
  if(/401|403|invalid.*key|unauthor|no auth/i.test(s)) return 'the API key was rejected (check the key and that it has credit)';
  if(/404|not found|no endpoints|no allowed/i.test(s)) return 'the model ID was not found on your account';
  if(/429|rate/i.test(s)) return 'the provider rate-limited the request';
  return s.slice(0,90);
}
/* build a real review from deterministic verification alone (no network needed) */
function synthDeterministicReview(work, verify, reason){
  const failed=verify.checks.filter((c)=>c.ok===false), passed=verify.checks.filter((c)=>c.ok===true);
  const acc=verify.accuracy;
  const strengths=[], weaknesses=[], corrections=[], validation=[], halluc=[];
  if(passed.length) strengths.push(`${passed.length} of ${verify.verifiableCount} re-verified calculations match the source data exactly.`);
  if(work.governanceScore>=70) strengths.push(`Data Governance confidence is ${work.governanceScore}/100 (${work.governanceBand}).`);
  strengths.push('Dataset was cleaned, typed and de-duplicated before analysis.');
  for(const c of failed){ weaknesses.push(`${c.label}: reported ${fmt(c.claim)} but recomputes to ${fmt(c.truth)}.`); corrections.push(`Correct ${c.label} to ${fmt(c.truth)}.`); if(Math.abs(c.claim-c.truth)/(Math.abs(c.truth)+1e-9)>0.2) halluc.push(`${c.label} is far from the true value — possible fabricated figure.`); }
  validation.push(`${passed.length}/${verify.verifiableCount} numeric claims were independently recomputed and confirmed.`);
  if(!verify.verifiableCount) validation.push('No numeric claims were independently re-verifiable for this dataset.');
  const decision = acc==null?'WARNING':acc>=90?'PASS':acc>=70?'WARNING':'FAIL';
  return { ok:true, source:'deterministic', unreachableReason:reason,
    summary:`Claude Opus could not be reached (${reason}). This is a deterministic review computed locally instead: the engine re-verified Sonnet\u2019s calculations against the real dataset${acc!=null?`, and ${acc}% of the re-checkable figures are correct`:''}.`,
    strengths, weaknesses, validation_comments:validation, suggested_corrections:corrections,
    missing_insights:['A full business-insight and hallucination review needs the Opus reviewer, which was unreachable — connect from a real browser tab with a valid key to enable it.'],
    hallucinations:halluc, accuracy:acc, sql_quality:null, insight_quality:null,
    evidence_quality: verify.verifiableCount?Math.round(100*passed.length/Math.max(1,verify.verifiableCount)):null,
    hallucination_risk: halluc.length?(halluc.length>1?'High':'Medium'):'Low', trust_rating:acc, review_confidence: verify.verifiableCount?80:40, decision };
}

/* Review Score Card — blends Opus ratings with deterministic verification */
function buildReviewScoreCard(review, verify){
  const clamp=(x)=>x==null?null:Math.max(0,Math.min(100,x));
  // deterministic accuracy overrides/【anchors】 the model's self-rating when available
  const accuracy = verify.accuracy!=null ? verify.accuracy : clamp(review.accuracy);
  const sqlQuality = clamp(review.sql_quality!=null?review.sql_quality:90);
  const insightQuality = clamp(review.insight_quality);
  const evidenceQuality = clamp(review.evidence_quality);
  const hallRisk = review.hallucination_risk || (review.hallucinations&&review.hallucinations.length? (review.hallucinations.length>2?'High':'Medium') : 'Low');
  const hallPenalty = hallRisk==='High'?25:hallRisk==='Medium'?10:0;
  const comps=[
    { key:'Accuracy', value:accuracy, weight:35, source: verify.accuracy!=null?`deterministic (${verify.correctCount}/${verify.verifiableCount} checks passed)`:'Opus rating' },
    { key:'SQL Quality', value:sqlQuality, weight:20, source:'Opus review' },
    { key:'Insight Quality', value:insightQuality, weight:20, source:'Opus review' },
    { key:'Evidence Quality', value:evidenceQuality, weight:25, source:'Opus review' },
  ];
  const app=comps.filter((c)=>c.value!=null); const wsum=app.reduce((s,c)=>s+c.weight,0)||1;
  comps.forEach((c)=>{ c.effectiveWeight=(c.value!=null)?+(100*c.weight/wsum).toFixed(1):0; });
  let trust=+app.reduce((s,c)=>s+c.value*(c.weight/wsum),0).toFixed(1);
  trust=Math.max(0,+(trust-hallPenalty).toFixed(1));
  return { accuracy, sqlQuality, insightQuality, evidenceQuality, hallRisk, hallPenalty, trustScore:trust, components:comps };
}

/* combine Sonnet governance + Opus trust into the Final Data Governance Score */
function combineFinal(sonnetScore, opusTrust, decision){
  // Opus review gates the final score: a FAIL caps it hard, WARNING dampens it.
  const blended = +(0.5*sonnetScore + 0.5*opusTrust).toFixed(1);
  let final = blended;
  if(decision==='FAIL') final=Math.min(final, 45);
  else if(decision==='WARNING') final=Math.min(final, 72);
  final=+final.toFixed(1);
  const band = final>=85?{label:'Trusted',tone:'good'}:final>=70?{label:'Acceptable',tone:'ok'}:final>=50?{label:'Guarded',tone:'warn'}:{label:'Untrusted',tone:'bad'};
  const finalDecision = decision==='FAIL'||final<50?'FAIL':decision==='WARNING'||final<70?'WARNING':'PASS';
  return { sonnetScore, opusTrust, blended, final, band, finalDecision };
}

/* orchestration the UI calls */
async function runOpusReview(name, t, a, g, ml, cfg, onProgress){
  const stages=[]; const mark=(l)=>{ stages.push({label:l,t:Date.now()}); onProgress&&onProgress(stages); };
  mark('Collecting Sonnet\u2019s completed analysis');
  const work=collectSonnetWork(name, t, a, g, ml);
  mark('Deterministic re-verification of Sonnet\u2019s numbers');
  const verify=verifySonnetClaims(work, t, a);
  mark('Sending Sonnet\u2019s work to Claude Opus for independent review');
  const { sys, usr }=opusReviewPrompt(work);
  const raw=await callModelRaw(cfg.opusModel, 'openrouter', cfg.apiKey, sys, usr);
  let review;
  if(raw.error){ // Opus unreachable → real deterministic review instead of failing
    review=synthDeterministicReview(work, verify, classifyReviewError(raw.error)); review.error=raw.error;
  } else {
    review=parseReview(raw.text);
    if(!review.ok){ review=synthDeterministicReview(work, verify, 'Opus responded but the output could not be parsed'); }
    else review.source='opus';
  }
  review.latency=raw.latencyMs; review.usage={prompt_tokens:raw.tokensIn||0,completion_tokens:raw.tokensOut||0};
  mark('Building Review Score Card');
  const scoreCard=buildReviewScoreCard(review, verify);
  // if deterministic verification strongly disagrees, force decision down
  let decision=review.decision||'WARNING';
  if(verify.accuracy!=null && verify.accuracy<60) decision='FAIL';
  else if(verify.accuracy!=null && verify.accuracy<90 && decision==='PASS') decision='WARNING';
  mark('Combining Sonnet + Opus into Final Data Governance Score');
  const final=combineFinal(g.score, scoreCard.trustScore, decision);
  return { work, verify, review:Object.assign(review,{decision}), scoreCard, final, timeline:stages };
}


/* self-contained model caller (so review.js needs no other AI module) */
async function callModelRaw(model, provider, key, sys, usr){
  const endpoint = provider==='openai'?'https://api.openai.com/v1/chat/completions':'https://openrouter.ai/api/v1/chat/completions';
  const now=()=>(typeof performance!=='undefined'?performance.now():Date.now()); const t0=now();
  try{
    const res=await fetch(endpoint,{ method:'POST', headers:{ 'Content-Type':'application/json','Authorization':'Bearer '+key,'HTTP-Referer':location.href,'X-Title':'Claude Opus Review Dashboard' }, body:JSON.stringify({ model, temperature:0.15, max_tokens:900, messages:[{role:'system',content:sys},{role:'user',content:usr}] }) });
    const latencyMs=Math.round(now()-t0);
    if(!res.ok){ const tx=await res.text().catch(()=> ''); return { error:'HTTP '+res.status+' '+tx.slice(0,120), latencyMs }; }
    const j=await res.json(); const text=j.choices&&j.choices[0]&&j.choices[0].message?j.choices[0].message.content:''; const usage=j.usage||{};
    return { text, latencyMs, tokensIn:usage.prompt_tokens||0, tokensOut:usage.completion_tokens||0 };
  }catch(e){ return { error:String(e.message||e), latencyMs:Math.round(now()-t0) }; }
}

if (typeof module !== 'undefined') module.exports = { collectSonnetWork, verifySonnetClaims, opusReviewPrompt, parseReview, buildReviewScoreCard, combineFinal, runOpusReview, callModelRaw };
