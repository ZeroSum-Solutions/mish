import { EVALUATOR_PROTOCOL_DIGEST } from './protocol.ts';
import { safePath } from './api.ts';
import { parseScoredJudgment, parseInventory, missingRequiredCriteria } from './judge.ts';
import { assertJudgeRoute } from './subscription.ts';
import { AGENCY_BAR, validateAgencyBar, rollUp } from './bar.ts';
import { summarizeSamples } from './samples.ts';
import { measureMechanical, matchingCaseIds } from './mechanical.ts';
import type { BenchmarkRun, Captures, Judgments, Reviewer } from './types.ts';
export interface Packet { run:BenchmarkRun; captures:Captures; judgments:Judgments; }
export type BaselinePolicy='passing'|'measurement';
export function validate({run,captures,judgments}:Packet) {
  if(run.schema!=='quality-benchmark/1'||captures.schema!=='quality-captures/2'||judgments.schema!=='quality-judgments/2'||!run.cases.length) throw new Error('Invalid benchmark packet');
  validateAgencyBar(judgments.rubric);
  if(judgments.evaluatorProtocolDigest!==EVALUATOR_PROTOCOL_DIGEST) throw new Error('Evaluator protocol differs; preserve the old packet and take a fresh measurement');
  if(!run.runId||captures.runId!==run.runId||judgments.runId!==run.runId) throw new Error('Packet run identity differs');
  for(const fact of captures.facts) safePath(fact.screenshot);
  const ids=new Set(run.cases.map(c=>c.caseId));if(ids.size!==run.cases.length) throw new Error('Duplicate build case');
  if(judgments.sampleCount!==3 || judgments.reviewers.length!==2 || new Set(judgments.reviewers.map(r=>r.id)).size!==2 || !judgments.reviewers.some(r=>r.id==='claude') || !judgments.reviewers.some(r=>r.id==='codex')) throw new Error('Invalid reviewer/sample protocol');
  for(const r of judgments.reviewers) assertJudgeRoute(r.id,r.model);
  const seen=new Set<string>();
  for(const rating of judgments.cases) {
    if(!ids.has(rating.caseId)||seen.has(rating.caseId)) throw new Error('Unknown or duplicate rating case');seen.add(rating.caseId);
    if(!['model','stub','missing-evidence'].includes(rating.origin)) throw new Error('Missing judgment provenance');
    if(rating.origin==='missing-evidence') {if(!rating.reason?.trim()) throw new Error('Missing evidence reason');continue;}
    if((judgments.mode==='live' && rating.origin!=='model') || (judgments.mode==='stub' && rating.origin!=='stub')) throw new Error('Judgment evidence mode differs');
    const pages = run.cases.find(c=>c.caseId===rating.caseId)!.files.filter(f=>/\.html?$/iu.test(f.name)&&!f.name.startsWith('_brand-build/')).map(f=>f.name);
    const perPage = rating.samples.some(s=>s.page !== undefined);
    if(rating.samples.length!==6*(perPage?pages.length:1)) throw new Error('Incomplete judge samples');
    const samples=new Set<string>();
    for(const sample of rating.samples) {
      const r=judgments.reviewers.find(r=>r.id===sample.reviewer);
      const key=`${sample.page??'whole-case'}/${sample.reviewer}/${sample.index}`;
      if(perPage && (!sample.page || !pages.includes(sample.page))) throw new Error('Unknown judgment page');
      if(!r || sample.model!==r.model || !Number.isInteger(sample.index)||sample.index<0||sample.index>=3||samples.has(key)) throw new Error('Invalid or duplicate judge sample');samples.add(key);
      parseScoredJudgment(sample,judgments.rubric);parseInventory(sample.inventory);
      if(missingRequiredCriteria(sample,judgments.rubric).length) throw new Error('Required criterion has no evidence');

      if(!Array.isArray(sample.observedModels)||sample.observedModels.some(model=>typeof model!=='string')) throw new Error('Invalid observed model provenance');
      if(!Number.isFinite(sample.workerTimeMs)||sample.workerTimeMs<0) throw new Error('Invalid sample timing');
      for(const file of sample.receiptFiles) safePath(file);
    }
  }
  if(seen.size!==ids.size) throw new Error('Incomplete ratings');if(judgments.mode==='live' && judgments.actualModels.some(model=>model==='stub')) throw new Error('Stub model provenance cannot qualify live judging');
  if(!judgments.actualModels.length) throw new Error('Missing judge model provenance');
}
function baselineEvidence(baseline:Packet,policy:BaselinePolicy) {
  const measures=baseline.run.cases.map(c=>measureMechanical(c,baseline.captures));
  if(measures.some(m=>m.missing.length || policy==='passing'&&m.findings.length)||baseline.judgments.cases.some(c=>c.origin==='missing-evidence')) throw new Error('Baseline evidence is incomplete or failed; failed checks require explicit measurement mode');
}
function comparePackets(current:Packet,baseline:Packet,policy:BaselinePolicy) {
  validate(baseline);baselineEvidence(baseline,policy);
  if(current.captures.browser!==baseline.captures.browser||current.captures.captureProtocolDigest!==baseline.captures.captureProtocolDigest) throw new Error('Baseline browser/capture protocol differs');
  if(current.run.fixtureDigest!==baseline.run.fixtureDigest || matchingCaseIds(current.run)!==matchingCaseIds(baseline.run)) throw new Error('Baseline fixture/kit/case set differs');
  if(JSON.stringify(current.run.settings)!==JSON.stringify(baseline.run.settings)) throw new Error('Baseline build settings differ');
  if(current.run.mode!==baseline.run.mode||current.judgments.mode!==baseline.judgments.mode) throw new Error('Baseline evidence mode differs');
  for(const field of ['judgeProtocolDigest','rubricDigest','requestedModel'] as const) if(current.judgments[field]!==baseline.judgments[field]) throw new Error(`Baseline ${field} differs`);
  if(JSON.stringify(current.judgments.reviewers)!==JSON.stringify(baseline.judgments.reviewers)||[...current.judgments.actualModels].sort().join()!==[...baseline.judgments.actualModels].sort().join()) throw new Error('Baseline judge model differs');
  for(const currentCase of current.run.fingerprint.cases) {
    const old=baseline.run.fingerprint.cases.find(c=>c.caseId===currentCase.caseId);
    if(!old) throw new Error('Baseline fingerprint case set differs');
    const comparable=(identity:{status:string;value?:unknown})=>identity.status==='available'?{status:identity.status,value:identity.value}:{status:identity.status};
    for(const [label,value,prior] of [['kit',currentCase.kit.contentHash,old.kit.contentHash],['prompt',currentCase.promptVariant,old.promptVariant],['builder',currentCase.builder,old.builder]] as const) {
      if(JSON.stringify(comparable(value))!==JSON.stringify(comparable(prior))) throw new Error(`Baseline ${label} fingerprint differs`);
    }
  }
  if(current.run.fingerprint.cases.length!==baseline.run.fingerprint.cases.length) throw new Error('Baseline fingerprint case set differs');

}
export function scoreBenchmark(run:BenchmarkRun,captures:Captures,judgments:Judgments,baseline?:Packet,threshold=0,baselinePolicy:BaselinePolicy='passing') {
  if(!Number.isFinite(threshold)||threshold<0||threshold>4) throw new Error('Regression threshold must be between 0 and 4');
  if(!['passing','measurement'].includes(baselinePolicy)) throw new Error('Invalid baseline policy');
  validate({run,captures,judgments});if(baseline) comparePackets({run,captures,judgments},baseline,baselinePolicy);
  const deltas:Array<{caseId:string;criterion:string;baseline:number;current:number;delta:number}>=[];
  const mechanicalRegressions:Array<{caseId:string;id:string;baseline:number;current:number;detail:string;evidence:string[]}>=[];
  const cases=run.cases.map(item=>{
    const rating=judgments.cases.find(c=>c.caseId===item.caseId)!;
    const measures=measureMechanical(item,captures);
    if(rating.origin==='missing-evidence') measures.missing.push(rating.reason!);
    const summary=summarizeSamples(rating,judgments.rubric,judgments.reviewers);
    const old=baseline?.run.cases.find(c=>c.caseId===item.caseId);
    const oldMeasure=old&&baseline?measureMechanical(old,baseline.captures):null;
    const oldRating=baseline?.judgments.cases.find(c=>c.caseId===item.caseId);
    const oldSummary=oldRating&&baseline?summarizeSamples(oldRating,baseline.judgments.rubric,baseline.judgments.reviewers):null;
    for(const f of measures.findings) {
      const previous=oldMeasure?.findings.find(o=>o.id===f.id)?.amount??0;
      if(f.amount>previous) mechanicalRegressions.push({caseId:item.caseId,id:f.id,baseline:previous,current:f.amount,detail:f.detail,evidence:f.evidence});
    }
    for(const c of judgments.rubric.criteria) {
      const current=summary.criteria[c.id]??null,previous=oldSummary?.criteria[c.id]??null;
      if(current!==null&&previous!==null) deltas.push({caseId:item.caseId,criterion:c.id,baseline:previous,current,delta:current-previous});
    }
    const scored=Object.values(summary.criteria).every(v=>v!==null);
    const recommendation=scored&&judgments.rubric.version===AGENCY_BAR.version?rollUp(summary.criteria as Record<string,number>,measures.eligibility,judgments.rubric,true):null;
    const outcome=measures.findings.length?'failed':measures.missing.length?'inconclusive':'passed';
    return {caseId:item.caseId,outcome,grade:recommendation?.cappedBand??null,recommendation,...summary,
      advisoryFailures:[...new Set(rating.samples.flatMap(s=>[...s.failures,...s.inventory.placeholders,...s.inventory.brackets,...s.inventory.inventedFacts]))],
      failures:[...measures.findings.map(f=>f.detail),...measures.missing],mechanicalFindings:measures.findings,missingEvidence:measures.missing,
      note:rating.reason??[...new Set(rating.samples.map(s=>s.note))].join('; '),wallTimeMs:item.wallTimeMs,wallTimeDeltaMs:old?item.wallTimeMs-old.wallTimeMs:null};
  });
  const outcome=cases.some(c=>c.outcome==='failed')?'failed':cases.some(c=>c.outcome==='inconclusive')?'inconclusive':'passed';
  const passed=!mechanicalRegressions.length&&!cases.some(c=>c.missingEvidence.length);
  return {schema:'quality-score/2',runId:run.runId,fixtureDigest:run.fixtureDigest,mode:run.mode,gateEligible:run.mode==='live'&&judgments.mode==='live'&&judgments.rubric.status==='approved',threshold,baselinePolicy,comparison:baseline?'baseline':'initial',actualJudgeModels:judgments.actualModels,fingerprint:run.fingerprint,protocols:{evaluator:judgments.evaluatorProtocolDigest,judge:judgments.judgeProtocolDigest,capture:captures.captureProtocolDigest,rubric:judgments.rubricDigest},builderSettings:run.settings,rubric:judgments.rubric,judgeIdentities:judgments.reviewers.map(r=>({reviewer:r.id,requestedModel:r.model,observedModels:[...new Set(judgments.cases.flatMap(c=>c.samples.filter(s=>s.reviewer===r.id).flatMap(s=>s.observedModels)))]})),cases,deltas,regressions:deltas.filter(d=>d.delta < -threshold),mechanicalRegressions,outcome,passed,
    timing:{judgeWallTimeMs:judgments.wallTimeMs,judgeWorkerTimeMs:judgments.cases.flatMap(c=>c.samples).reduce((n,s)=>n+s.workerTimeMs,0),buildWorkerTimeMs:run.cases.reduce((n,c)=>n+c.wallTimeMs,0),builderVariance:'unavailable: requires repeated builds'},spend:{incrementalCashUsd:0,subscriptionUsage:'not reported',lane:judgments.mode==='stub'?'stub':'subscription'},
    speedPolicy:'Wall time and worker time are reported, not targets.',humanPolicy:'Blind human ratings come before calibration. One rater does not satisfy AC-R15.4. No calibration or holdout is claimed. Model scores never accept or deploy a draft or clear required judgments.'};
}
export type Score=ReturnType<typeof scoreBenchmark>;
export function preflightBaseline(baseline:Packet,expected:{fixtureDigest:string;settings:BenchmarkRun['settings'];mode:BenchmarkRun['mode'];rubricDigest:string;requestedModel:string;judgeProtocolDigest:string;captureProtocolDigest:string;reviewers?:Reviewer[];sampleCount?:3;baselinePolicy?:BaselinePolicy}) {
  validate(baseline);baselineEvidence(baseline,expected.baselinePolicy??'passing');
  if(expected.captureProtocolDigest!==baseline.captures.captureProtocolDigest) throw new Error('Baseline capture protocol differs');
  if(expected.fixtureDigest!==baseline.run.fixtureDigest) throw new Error('Baseline fixture/kit/case set differs');
  if(JSON.stringify(expected.settings)!==JSON.stringify(baseline.run.settings)) throw new Error('Baseline build settings differ');
  if(expected.mode!==baseline.run.mode||expected.mode!==baseline.judgments.mode) throw new Error('Baseline evidence mode differs');
  for(const field of ['rubricDigest','requestedModel','judgeProtocolDigest'] as const) if(expected[field]!==baseline.judgments[field]) throw new Error(`Baseline ${field} differs`);
  if(expected.reviewers&&JSON.stringify(expected.reviewers)!==JSON.stringify(baseline.judgments.reviewers)||expected.sampleCount&&expected.sampleCount!==baseline.judgments.sampleCount) throw new Error('Baseline reviewer/sample protocol differs');
}
