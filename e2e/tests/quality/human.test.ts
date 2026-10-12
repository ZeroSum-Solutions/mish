import { test, expect } from 'vitest';
import { packet } from '../../lib/quality/packet-fixture.ts';
import { scoreBenchmark } from '../../benchmarks/quality/score.ts';
import * as calibration from '../../benchmarks/quality/calibration.ts';
test('blind ratings retain criterion disagreement and flag two-letter gaps as advisory investigation only',()=>{
  const p=packet();const score=scoreBenchmark(p.run,p.captures,p.judgments);
  const human={schema:'quality-human-check/2',rater:'Devin',runId:p.run.runId,fixtureDigest:p.run.fixtureDigest,rubricDigest:score.protocols.rubric,ratedAt:'2026-10-09T00:00:00Z',cases:[{caseId:'dental',grade:'F',criteria:Object.fromEntries(p.judgments.rubric.criteria.map(c=>[c.id,c.id==='craft'?null:2])),note:'blind'}]};
  const report=calibration.humanAgreement([human],score,'2026-10-09T01:00:00Z');
  expect(report.raterCount).toBe(1);expect(report.prdAcceptanceClaim).toBe(false);expect(report.cases[0]!.twoLetterGap).toBe(true);
  expect(report.cases[0]!.criteria.imagery).toMatchObject({human:2,model:4,delta:2,agree:false});
  expect(report.cases[0]!.criteria.craft).toMatchObject({human:null,delta:null,agree:null});expect(score.passed).toBe(true);
  expect(()=>calibration.humanAgreement([{...human,ratedAt:'2026-10-09T02:00:00Z'}],score,'2026-10-09T01:00:00Z')).toThrow(/before|blind/i);
  expect(()=>calibration.humanAgreement([{...human,runId:'other'}],score,'2026-10-09T01:00:00Z')).toThrow(/identity/i);
});
test('the blind sheet follows the selected rubric rather than substituting the agency criterion set',async()=>{
  const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join}=await import('node:path');
  const {writeHumanSheet}=await import('../../benchmarks/quality/report.ts');const p=packet();const out=await mkdtemp(join(tmpdir(),'quality-rubric-sheet-'));
  try {
    const rubric={...p.judgments.rubric,criteria:[{id:'restraint',name:'Restraint',anchors:{'1':'bad','2':'poor','3':'draft','4':'strong','5':'great'}}]};
    await writeHumanSheet(out,{runId:p.run.runId,fixtureDigest:p.run.fixtureDigest,mode:'stub',caseIds:['dental'],rubricDigest:'selected-rubric'},p.captures,rubric);
    const sheet=await readFile(join(out,'human-check.html'),'utf8');expect(sheet).toContain('data-criterion="restraint"');expect(sheet).not.toContain('data-criterion="imagery"');expect(sheet).toContain('selected-rubric');
  } finally {await rm(out,{recursive:true,force:true});}
});
