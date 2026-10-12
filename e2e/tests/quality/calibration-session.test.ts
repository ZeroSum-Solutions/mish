import { digest } from '../../benchmarks/quality/api.ts';
import { expect, test } from 'vitest';
import { AGENCY_BAR } from '../../benchmarks/quality/bar.ts';
import { validateCalibrationSet, validateSubmission, calibrationAgreement, freezeCalibration } from '../../benchmarks/quality/calibration-session.ts';
import type { CalibrationModel } from '../../benchmarks/quality/calibration-session.ts';
import { CALIBRATION_LIMITATION, type CalibrationSet } from '../../benchmarks/quality/calibration-sheet.ts';
const ids = AGENCY_BAR.criteria.map(c => c.id);
const set: CalibrationSet = {schema:'quality-calibration-set/1',setId:'set',rubricDigest:'rubric',protocolDigest:'capture',items:Array.from({length:8},(_,i)=>({id:`P${String(i+1).padStart(2,'0')}`,screenshots:[{width:1440,height:900,file:`P${String(i+1).padStart(2,'0')}-1440.png`,sha256:digest('desktop'+i)},{width:390,height:844,file:`P${String(i+1).padStart(2,'0')}-390.png`,sha256:digest('mobile'+i)}],unavailable:['briefFidelity','craft','accessibility'],limitation:CALIBRATION_LIMITATION}))};
const human = () => ({schema:'quality-calibration-human/1',setId:'set',setDigest:digest(JSON.stringify(set)),rubricDigest:'rubric',protocolDigest:'capture',rater:'Devin',submittedAt:'2026-10-09T15:00:00Z',cases:set.items.map(item=>({caseId:item.id,grade:'A',criteria:Object.fromEntries(ids.map(id=>[id,item.unavailable.includes(id)?null:4])),evidence:Object.fromEntries(ids.map(id=>[id,'1440 hero; screenshot only for unsupported criteria'])),note:''}))});
const model = ():CalibrationModel => ({schema:'quality-calibration-model/1' as const,setDigest:digest(JSON.stringify(set)),humanDigests:[digest(JSON.stringify(human()))],rubricDigest:'rubric',protocolDigest:'capture',judgeProtocolDigest:'judge',reviewers:[{id:'claude' as const,model:'claude-sonnet-5-5'},{id:'codex' as const,model:'gpt-6.1-sol'}],startedAt:'2026-10-09T15:01:00Z',completedAt:'2026-10-09T15:02:00Z',mode:'stub' as const,cases:set.items.map(item=>({caseId:item.id,samples:['claude','codex'].flatMap(reviewer=>Array.from({length:3},(_,index)=>({reviewer,index,grade:'C',failures:[],criteria:Object.fromEntries(ids.map(id=>[id,item.unavailable.includes(id)?null:3])),evidence:Object.fromEntries(ids.map(id=>[id,'1440 hero'])),note:'fixture'})))}))});
test('validates complete blind coverage and rejects unsafe screenshot paths',()=>{
 expect(validateCalibrationSet(set)).toEqual(set);
 expect(()=>validateCalibrationSet({...set,items:[...set.items,set.items[0]]})).toThrow();
 expect(()=>validateCalibrationSet({...set,items:set.items.map(i=>({...i,screenshots:[i.screenshots[0]]}))})).toThrow();
 expect(()=>validateCalibrationSet({...set,items:set.items.map(i=>({...i,screenshots:i.screenshots.map(s=>({...s,file:'../url-key.json'}))}))})).toThrow();
});
test('explicit complete human submission must precede model judging',()=>{
 expect(validateSubmission(human(),set,'2026-10-09T15:01:00Z').rater).toBe('Devin');
 expect(()=>validateSubmission({...human(),submittedAt:undefined},set,'2026-10-09T15:01:00Z')).toThrow();
 expect(()=>validateSubmission(human(),set,'2026-10-09T14:00:00Z')).toThrow();
 const h=human();h.cases[0]!.criteria.craft=4;expect(()=>validateSubmission(h,set,'2026-10-09T15:01:00Z')).toThrow();
 const partial=human();delete partial.cases[0]!.criteria.typography;expect(()=>validateSubmission(partial,set,'2026-10-09T15:01:00Z')).toThrow();
});
test('reports criterion gaps, reviewer spread and two-letter failures without changing grades',()=>{
 const report=calibrationAgreement(set,[human()],model());
 expect(report.criterionAgreement.typography).toMatchObject({assessable:8,exact:0,withinOne:8,meanAbsoluteError:1});
 expect(report.criterionAgreement.craft!.assessable).toBe(0);
 expect(report.disagreements).toHaveLength(40);
 expect(report.letterDisagreements[0]).toMatchObject({humanGrade:'A',modelGrade:'C',gap:2});
 expect(report.investigationRequired).toBe(true);expect(report.prdAcceptanceClaim).toBe(false);
 expect(()=>calibrationAgreement(set,[human(),human()],model())).toThrow();
});
test('freeze requires live evidence and reviewed dispositions, never freezes stub evidence',()=>{
 const report=calibrationAgreement(set,[human()],model());
 expect(()=>freezeCalibration(set,model(),report,{reviewedBy:'Devin',reviewedAt:'2026-10-09T15:03:00Z',agreementDigest:digest(JSON.stringify(report)),modelDigest:report.modelDigest,dispositions:{}})).toThrow(/live/i);
 const live={...model(),mode:'live' as const};const liveReport=calibrationAgreement(set,[human()],live);
 expect(()=>freezeCalibration(set,live,liveReport,{reviewedBy:'Devin',reviewedAt:'2026-10-09T15:03:00Z',agreementDigest:digest(JSON.stringify(liveReport)),modelDigest:liveReport.modelDigest,dispositions:{}})).toThrow(/investigat/i);
});
test('blocks all-unread coverage and requires dispositions for assessability and reviewer gaps',()=>{
 const live={...model(),mode:'live' as const};for(const page of live.cases)for(const sample of page.samples){sample.grade=null;for(const id of ids)sample.criteria[id]=null;}
 const report=calibrationAgreement(set,[human()],live);
 expect(report.investigationRequired).toBe(true);expect(report.assessabilityDisagreements).toHaveLength(40);
 expect(()=>freezeCalibration(set,live,report,{reviewedBy:'Devin',reviewedAt:'2026-10-09T15:03:00Z',agreementDigest:digest(JSON.stringify(report)),modelDigest:report.modelDigest,dispositions:{}})).toThrow(/inconclusive/);
 const split=model();for(const page of split.cases)for(const sample of page.samples)sample.criteria.typography=sample.reviewer==='claude'?1:5;
 const disagree=calibrationAgreement(set,[human()],split);expect(disagree.reviewerDisagreements).toHaveLength(8);expect(disagree.reviewerCriterionAgreement.claude!.typography!.meanAbsoluteError).toBe(3);
});
test('freeze succeeds with complete reviewed live evidence and cannot reuse an unrelated review',()=>{
 const live={...model(),mode:'live' as const};const report=calibrationAgreement(set,[human()],live);
 const review={reviewedBy:'Devin',reviewedAt:'2026-10-09T15:03:00Z',agreementDigest:digest(JSON.stringify(report)),modelDigest:report.modelDigest,dispositions:Object.fromEntries([...report.disagreements,...report.letterDisagreements,...report.assessabilityDisagreements,...report.reviewerDisagreements].map(g=>[g.id,'Investigated fixture disagreement; preserve both scores']))};
 expect(freezeCalibration(set,live,report,review).sampleCount).toBe(3);
 expect(()=>freezeCalibration(set,live,report,{...review,agreementDigest:'stale'})).toThrow(/bound/);
 expect(()=>validateCalibrationSet({...set,url:'https://example.com/'})).toThrow(/Private/);
 expect(()=>validateCalibrationSet({...set,items:set.items.map(item=>({...item,unavailable:ids}))})).toThrow(/Screenshot-only/);
});
