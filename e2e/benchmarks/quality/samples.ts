import type { CaseJudgments, Rubric, Reviewer } from './types.ts';
const median = (values: number[]) => { const sorted=[...values].sort((a,b)=>a-b); const m=Math.floor(sorted.length/2); return sorted.length%2 ? sorted[m]! : (sorted[m-1]!+sorted[m]!)/2; };
function summary(values: Array<number|null>) {
  const scored=values.filter((v):v is number=>v!==null);
  return { median:scored.length===values.length && scored.length ? median(scored):null, min:scored.length?Math.min(...scored):null, max:scored.length?Math.max(...scored):null, spread:scored.length>1?Math.max(...scored)-Math.min(...scored):null, count:scored.length, notAssessable:values.length-scored.length };
}
function summarizePage(rating: CaseJudgments, rubric: Rubric, reviewerSettings: Reviewer[]) {
  const reviewers=Object.fromEntries(reviewerSettings.map(reviewer=>[reviewer.id,{ model:reviewer.model, sampleCount:rating.samples.filter(s=>s.reviewer===reviewer.id).length, criteria:Object.fromEntries(rubric.criteria.map(c=>[c.id,summary(rating.samples.filter(s=>s.reviewer===reviewer.id).map(s=>s.criteria[c.id]!))])) }]));
  const complete=rating.origin!=='missing-evidence' && rating.samples.length===6;
  const all=Object.fromEntries(rubric.criteria.map(c=>[c.id,summary(rating.samples.map(s=>s.criteria[c.id]!))]));
  const criteria=Object.fromEntries(Object.entries(all).map(([id,s])=>[id,complete?s.median:null]));
  const reviewerDisagreement=Object.fromEntries(rubric.criteria.map(c=>{
    const values=reviewerSettings.map(r=>reviewers[r.id]!.criteria[c.id]!.median);
    return [c.id,values.length===2 && values.every(v=>v!==null)?Math.abs(values[0]!-values[1]!):null];
  }));
  return {criteria,reviewers,notAssessableReasons:Object.fromEntries(rubric.criteria.map(c=>[c.id,[...new Set(rating.samples.filter(s=>s.criteria[c.id]===null).map(s=>s.evidence?.[c.id]??'Evidence unavailable'))]])),uncertainty:{sampleCount:rating.samples.length,criterionSpread:Object.fromEntries(Object.entries(all).map(([id,s])=>[id,s.spread])),reviewerDisagreement,notAssessable:Object.entries(all).filter(([,s])=>!complete||s.median===null).map(([id])=>id),reason:'Three samples per reviewer describe judge variation, not builder variance or human calibration. Any not-assessable sample keeps that criterion unscored.'}};
}

export function summarizeSamples(rating: CaseJudgments, rubric: Rubric, reviewers: Reviewer[]) {
  const pageNames = [...new Set(rating.samples.map(s => s.page ?? 'whole-case'))];
  const pages = pageNames.map(page => ({ page, ...summarizePage({ ...rating, samples: rating.samples.filter(s => (s.page ?? 'whole-case') === page) }, rubric, reviewers) }));
  const combined = summarizePage(rating, rubric, reviewers);
  const criteria = Object.fromEntries(rubric.criteria.map(c => {
    const values = pages.map(p => p.criteria[c.id] ?? null);
    return [c.id, rating.origin !== 'missing-evidence' && values.length && values.every(v => v !== null) ? Math.min(...values as number[]) : null];
  }));
  const weakest = (values: Array<number|null>) => values.length && values.every(v=>v!==null) ? Math.min(...values as number[]) : null;
  const pageMax = (values: Array<number|null>) => values.length && values.every(v=>v!==null) ? Math.max(...values as number[]) : null;
  for (const r of reviewers) for (const c of rubric.criteria) {
    combined.reviewers[r.id]!.criteria[c.id]!.median = weakest(pages.map(p=>p.reviewers[r.id]!.criteria[c.id]!.median));
  }
  combined.uncertainty.criterionSpread=Object.fromEntries(rubric.criteria.map(c=>[c.id,pageMax(pages.map(p=>p.uncertainty.criterionSpread[c.id]??null))]));
  combined.uncertainty.reviewerDisagreement=Object.fromEntries(rubric.criteria.map(c=>[c.id,pageMax(pages.map(p=>p.uncertainty.reviewerDisagreement[c.id]??null))]));
  return { ...combined, criteria, pages, uncertainty: { ...combined.uncertainty,
    notAssessable: Object.entries(criteria).filter(([,v]) => v === null).map(([id]) => id),
    reason: 'Whole-site criterion scores use the weakest page median; no home page offsets a weak inner page. Optional nulls remain unscored. Judge variation is uncalibrated.' } };
}
