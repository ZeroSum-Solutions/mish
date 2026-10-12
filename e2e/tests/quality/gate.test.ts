import { expect, test } from 'vitest';
import { packet } from '../../lib/quality/packet-fixture.ts';
import { scoreBenchmark, preflightBaseline } from '../../benchmarks/quality/score.ts';
test('measurement baseline retains failures and gates only new or worsened mechanical defects', () => {
  const old = packet(); old.captures.facts[0]!.horizontalOverflowPx = 18;
  const current = structuredClone(old);
  const score = scoreBenchmark(current.run, current.captures, current.judgments, old, 0, 'measurement');
  expect(score).toMatchObject({ passed: true, outcome: 'failed', baselinePolicy: 'measurement', mechanicalRegressions: [] });
  expect(score.cases[0]!.failures.join(' ')).toMatch(/overflow/i);
  current.captures.facts[0]!.horizontalOverflowPx = 19;
  expect(scoreBenchmark(current.run, current.captures, current.judgments, old, 0, 'measurement').passed).toBe(false);
  current.captures.facts[0]!.horizontalOverflowPx = 17;
  current.captures.facts[1]!.consoleErrors.push('new error');
  expect(scoreBenchmark(current.run, current.captures, current.judgments, old, 0, 'measurement').mechanicalRegressions).toHaveLength(1);
});
test('preflight allows mechanical failures only in explicit measurement mode; missing evidence never qualifies', () => {
  const old = packet(); old.captures.facts[0]!.horizontalOverflowPx = 18;
  const expected = { fixtureDigest: old.run.fixtureDigest, settings: old.run.settings, mode: old.run.mode, rubricDigest: old.judgments.rubricDigest, requestedModel: old.judgments.requestedModel, judgeProtocolDigest: old.judgments.judgeProtocolDigest, captureProtocolDigest: old.captures.captureProtocolDigest, reviewers: old.judgments.reviewers, sampleCount: 3 as const };
  expect(()=>preflightBaseline(old, {...expected, baselinePolicy: 'measurement'})).not.toThrow();
  expect(()=>preflightBaseline(old, expected)).toThrow(/baseline evidence/i);
  old.captures.facts[0]!.keyboard = {status:'missing', reason:'unread'};
  expect(()=>preflightBaseline(old, {...expected, baselinePolicy: 'measurement'})).toThrow(/baseline evidence/i);
});
test('reports per-reviewer medians, ranges and disagreement without choosing the minimum or gating scores', () => {
  const p = packet(); const score = scoreBenchmark(p.run, p.captures, p.judgments);
  const result = score.cases[0]!;
  expect(result.criteria.imagery).toBe(4);
  expect(result.uncertainty).toMatchObject({ sampleCount: 6, reviewerDisagreement: {imagery: 2} });
  expect(result.reviewers.claude!.criteria.imagery).toMatchObject({ median:3, min:2, max:4, spread:2, count:3 });
  expect(result.reviewers.codex!.criteria.imagery).toMatchObject({ median:5, min:4, max:5, spread:1, count:3 });
  expect(score.passed).toBe(true);
  expect(result.recommendation?.recommendedGrade).toBe('ineligible');
  expect(score).not.toHaveProperty('accepted');
});
test('null criteria remain not assessable; model suspicions never become confirmed failures', () => {
  const p = packet(); p.judgments.cases[0]!.samples.forEach(s=>{ s.criteria.craft = null; s.failures=['suspected invented fact']; });
  const result = scoreBenchmark(p.run,p.captures,p.judgments);
  expect(result.passed).toBe(true); expect(result.cases[0]!.criteria.craft).toBeNull();
  expect(result.cases[0]!.recommendation).toBeNull(); expect(result.cases[0]!.advisoryFailures).toContain('suspected invented fact');
});
test('incomplete judge samples and missing captures fail closed, irrespective of model score', () => {
  const p = packet(); p.judgments.cases[0]!.samples.pop();
  expect(()=>scoreBenchmark(p.run,p.captures,p.judgments)).toThrow(/sample/i);
  const q = packet(); q.captures.facts.pop();
  expect(scoreBenchmark(q.run,q.captures,q.judgments).passed).toBe(false);
});
test('a finished keyboard walk is complete; budget exhaustion and heuristic traps stay inconclusive',()=>{
  const p=packet();p.captures.facts.forEach(f=>{if(f.keyboard.status==='complete')f.keyboard.value.exhausted=false;});
  expect(scoreBenchmark(p.run,p.captures,p.judgments).passed).toBe(true);
  const f=p.captures.facts[0]!;if(f.keyboard.status!=='complete')throw new Error('fixture');
  f.keyboard.value.exhausted=true;
  expect(scoreBenchmark(p.run,p.captures,p.judgments)).toMatchObject({passed:false,outcome:'inconclusive'});
  f.keyboard.value.exhausted=false;f.keyboard.value.trapDetected=true;f.keyboard.value.primaryReachable=false;
  const result=scoreBenchmark(p.run,p.captures,p.judgments);expect(result.outcome).toBe('inconclusive');expect(result.mechanicalRegressions).toEqual([]);
});
test('missing-evidence cases cannot use partial sample scores to recommend any band',()=>{
  const p=packet();p.judgments.cases[0]!.samples.pop();p.judgments.cases[0]!.origin='missing-evidence';p.judgments.cases[0]!.reason='unread image';
  const score=scoreBenchmark(p.run,p.captures,p.judgments);expect(score.cases[0]!.criteria.imagery).toBeNull();expect(score.cases[0]!.grade).toBeNull();expect(score.passed).toBe(false);
});
test('same kit ID with changed kit bytes or actual prompt/builder identities is incomparable',()=>{
  const p=packet();const identity={status:'available' as const,value:'kit-a',source:'fixture'};
  p.run.fingerprint.cases=[{caseId:'dental',kit:{id:'kit',contentHash:identity,files:{status:'unavailable',reason:'fixture'}},fontFiles:{status:'unavailable',reason:'fixture'},stagedAssets:{status:'unavailable',reason:'fixture'},promptVariant:{status:'available',value:'variant-a',source:'fixture'},builder:{status:'available',value:{agent:'stub',model:'stub'},source:'fixture'}}];
  for(const field of ['kit','promptVariant','builder'] as const) {
    const old=structuredClone(p);const f=old.run.fingerprint.cases[0]!;
    if(field==='kit')f.kit.contentHash={...identity,value:'kit-b'};
    if(field==='promptVariant')f.promptVariant={...identity,value:'variant-b'};
    if(field==='builder')f.builder={status:'available',source:'fixture',value:{agent:'stub',model:'other'}};
    expect(()=>scoreBenchmark(p.run,p.captures,p.judgments,old)).toThrow(/fingerprint|kit|prompt|builder/i);
  }
});
test('resource body-byte read failure is missing measurement, not a confirmed broken resource',()=>{
  const p=packet();const f=p.captures.facts[0]!;if(f.resources.status!=='complete')throw new Error('fixture');
  f.resources.value.requests.push({url:'http://127.0.0.1:1/photo.png',type:'image',status:200,bytes:null,failure:'Response bytes unavailable'});
  const score=scoreBenchmark(p.run,p.captures,p.judgments);expect(score.mechanicalRegressions).toEqual([]);expect(score).toMatchObject({passed:false,outcome:'inconclusive'});
});
test('polling failure without authoritative terminal failure remains missing evidence',()=>{
  const p=packet();p.run.cases[0]!.status='failed';p.run.cases[0]!.run={status:'running'};p.run.cases[0]!.failures=['Run polling deadline exceeded'];
  const score=scoreBenchmark(p.run,p.captures,p.judgments);expect(score.mechanicalRegressions).toEqual([]);expect(score).toMatchObject({passed:false,outcome:'inconclusive'});
});
test('malformed complete observations cannot be mistaken for complete evidence',()=>{
  for(const name of ['motion','conversion','keyboard','resources','forms'] as const) {
    const p=packet();p.captures.facts[0]![name]={status:'complete',value:{}} as never;
    expect(scoreBenchmark(p.run,p.captures,p.judgments).passed).toBe(false);
  }
});
test('exercised forms with blocked request attempts cannot silently prove truthful local-only behavior',()=>{
  const p=packet();p.captures.facts[0]!.forms={status:'complete',value:[{selector:'form',action:'/submit',method:'post',exercised:true,settling:{complete:true,windowMs:2000,durationMs:2000},requests:[{url:'http://127.0.0.1:1/submit',method:'POST',blocked:true}]}]};
  const score=scoreBenchmark(p.run,p.captures,p.judgments);expect(score).toMatchObject({passed:false,outcome:'inconclusive'});expect(score.mechanicalRegressions).toEqual([]);
});
test('a confirmed absent primary action stays a visible measurable defect rather than inventing a missing tab-walk',()=>{
  const p=packet();for(const f of p.captures.facts){f.conversion={status:'complete',value:{matches:[],exists:false,resolves:false}};if(f.keyboard.status==='complete')f.keyboard.value.primaryReachable=false;}
  const old=structuredClone(p);const score=scoreBenchmark(p.run,p.captures,p.judgments,old,0,'measurement');
  expect(score).toMatchObject({outcome:'failed',passed:true});expect(score.cases[0]!.missingEvidence).toEqual([]);expect(score.cases[0]!.failures.join(' ')).toMatch(/conversion/i);
});
