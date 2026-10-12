import { expect, test } from 'vitest';
import { packet } from '../../lib/quality/packet-fixture.ts';
import { scoreBenchmark } from '../../benchmarks/quality/score.ts';
import type { Captures } from '../../benchmarks/quality/types.ts';
test('reports exact advisory deltas; model grade and allegations never gate or qualify stubs', () => {
  const old=packet(); const current=structuredClone(old);
  current.judgments.cases[0]!.samples.forEach(s=>{s.criteria.imagery=3;s.grade='F';s.failures=['Model suspects invented fact'];});
  const score=scoreBenchmark(current.run,current.captures,current.judgments,old,0.5);
  expect(score.regressions).toContainEqual({caseId:'dental',criterion:'imagery',baseline:4,current:3,delta:-1});
  expect(score.passed).toBe(true);expect(score.gateEligible).toBe(false);
  expect(scoreBenchmark(current.run,current.captures,current.judgments,old,1).regressions).toEqual([]);
});
test('reports capped roll-up with content judgment gaps separate from complete mechanical checks',()=>{
  const p=packet();p.judgments.cases[0]!.samples.forEach(s=>{Object.keys(s.criteria).forEach(id=>s.criteria[id]=5);s.grade='F';});
  const score=scoreBenchmark(p.run,p.captures,p.judgments);
  expect(score.cases[0]!.recommendation).toMatchObject({M:5,band:'A',cappedBand:'B',recommendedGrade:'ineligible',eligibilityOutcome:'inconclusive'});
  expect(score).toMatchObject({passed:true,outcome:'passed'});
  expect(score.humanPolicy).toContain('never accept');
});
test('reports missing judge evidence without manufacturing an F or numeric scores',()=>{
  const p=packet();p.judgments.cases[0]={caseId:'dental',origin:'missing-evidence',samples:[],reason:'unread screenshots'};
  const score=scoreBenchmark(p.run,p.captures,p.judgments);
  expect(score.passed).toBe(false);expect(score.cases[0]!.grade).toBeNull();expect(score.cases[0]!.criteria.imagery).toBeNull();
});
test.each(['settings','rubric','model','mode','protocol','case set'] as const)('refuses changed %s in a saved baseline',kind=>{
  const p=packet();const old=structuredClone(p);
  if(kind==='settings')old.run.settings.model='other';
  if(kind==='rubric')old.judgments.rubricDigest='other';
  if(kind==='model')old.judgments.actualModels=['other'];
  if(kind==='mode')old.run.mode='live';
  if(kind==='protocol')old.judgments.judgeProtocolDigest='other';
  if(kind==='case set')old.run.fixtureDigest='other';
  expect(()=>scoreBenchmark(p.run,p.captures,p.judgments,old)).toThrow(/differs|differ/);
});
test('refuses missing/duplicate ratings, changed identities and historical capture schemas',()=>{
  const p=packet();expect(()=>scoreBenchmark(p.run,p.captures,{...p.judgments,cases:[]})).toThrow(/incomplete/i);
  expect(()=>scoreBenchmark(p.run,p.captures,{...p.judgments,cases:[...p.judgments.cases,...p.judgments.cases]})).toThrow(/duplicate/i);
  expect(()=>scoreBenchmark(p.run,{...p.captures,runId:'other'},p.judgments)).toThrow(/identity/i);
  expect(()=>scoreBenchmark(p.run,{...p.captures,schema:'quality-captures/1'} as unknown as Captures,p.judgments)).toThrow(/packet|schema/i);
});
test('mechanical initial failures are gated and retain page and viewport evidence',()=>{
  const p=packet();p.captures.facts[0]!.horizontalOverflowPx=18;p.captures.facts[1]!.consoleErrors=['broken'];
  const score=scoreBenchmark(p.run,p.captures,p.judgments);expect(score.passed).toBe(false);
  expect(score.mechanicalRegressions).toHaveLength(2);expect(score.cases[0]!.failures.join(' ')).toMatch(/overflow.*console/i);
});
test('reports scores, spread, disagreement and measured time without exposing them on the blind sheet',async()=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises'); const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {writeReport}=await import('../../benchmarks/quality/report.ts');const out=await mkdtemp(join(tmpdir(),'quality-report-'));
  try {
    const p=packet();await writeReport(out,scoreBenchmark(p.run,p.captures,p.judgments),p.captures);
    const report=await readFile(join(out,'report.md'),'utf8');expect(report).toContain('ineligible');expect(report).toContain('Spread');expect(report).toContain('Reviewer disagreement');expect(report).toContain('never accepts');expect(report).toContain('Builder variance: unavailable');
    const sheet=await readFile(join(out,'human-check.html'),'utf8');expect(sheet).not.toContain('recommendedGrade');expect(sheet).toContain('Model grades are hidden');expect(sheet).toContain('not assessable');
  } finally {await rm(out,{recursive:true,force:true});}
});
