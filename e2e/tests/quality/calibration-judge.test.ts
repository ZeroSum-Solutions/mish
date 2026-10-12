import { expect, test, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { digest } from '../../benchmarks/quality/api.ts';
import { AGENCY_BAR } from '../../benchmarks/quality/bar.ts';
import { REFERENCE_PROTOCOL_DIGEST } from '../../benchmarks/quality/reference-capture.ts';
import { judgeCalibration, verifyCalibrationEvidence, verifyCompletedCalibration } from '../../benchmarks/quality/calibration-judge.ts';
import * as subscriptions from '../../benchmarks/quality/subscription.ts';
import { CALIBRATION_LIMITATION, type CalibrationSet } from '../../benchmarks/quality/calibration-sheet.ts';
async function fixture(root: string) {
  const items:CalibrationSet['items']=[];
  for(let i=0;i<8;i++) {
    const id=`P${String(i+1).padStart(2,'0')}`;const shots:CalibrationSet['items'][number]['screenshots']=[];
    for(const width of [1440,390]) {const height=width===1440?900:844;const file=`${id}-${width}.png`;const png=new PNG({width,height});png.data.fill(255);png.data[0]=i;const bytes=PNG.sync.write(png);await writeFile(join(root,file),bytes);shots.push({width,height,file,sha256:digest(bytes)});}
    items.push({id,screenshots:shots,unavailable:['briefFidelity','craft','accessibility'],limitation:CALIBRATION_LIMITATION});
  }
  const set:CalibrationSet={schema:'quality-calibration-set/1',setId:'synthetic',rubricDigest:digest(JSON.stringify(AGENCY_BAR)),protocolDigest:REFERENCE_PROTOCOL_DIGEST,items};
  const human={schema:'quality-calibration-human/1',setId:set.setId,setDigest:digest(JSON.stringify(set)),rubricDigest:set.rubricDigest,protocolDigest:set.protocolDigest,rater:'Synthetic QA',submittedAt:'2020-01-01T00:00:00Z',cases:set.items.map(i=>({caseId:i.id,grade:'B',criteria:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,i.unavailable.includes(c.id)?null:4])),evidence:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,'Synthetic fixture'])),note:'Not a real human rating'}))};
  return {set,human};
}
test('does not create output or call a provider without submitted blind human ratings',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qt4-no-human-'));const claude=vi.spyOn(subscriptions,'callClaude');const codex=vi.spyOn(subscriptions,'callCodex');
 try {const {set}=await fixture(root);const out=join(root,'session');await expect(judgeCalibration({set,human:[],evidenceRoot:root,out,timeoutMs:1000})).rejects.toThrow(/submissions/);expect(claude).not.toHaveBeenCalled();expect(codex).not.toHaveBeenCalled();await expect(readFile(join(out,'calibration-input.json'))).rejects.toThrow();}
 finally {vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
},60000);
test('rejects changed screenshots and symlinks outside the frozen evidence root',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qt4-evidence-'));const outside=await mkdtemp(join(tmpdir(),'qt4-outside-'));
 try {const {set}=await fixture(root);await verifyCalibrationEvidence(root,set);const image=set.items[0]!.screenshots[0]!;const original=await readFile(join(root,image.file));await writeFile(join(root,image.file),'changed');await expect(verifyCalibrationEvidence(root,set)).rejects.toThrow(/digest/);await rm(join(root,image.file));await writeFile(join(outside,image.file),original);await symlink(join(outside,image.file),join(root,image.file));await expect(verifyCalibrationEvidence(root,set)).rejects.toThrow(/escapes/);}
 finally {await rm(root,{recursive:true,force:true});await rm(outside,{recursive:true,force:true});}
},60000);
test('stub runs both inventory→score lanes on the submitted set and preserves all disagreement receipts',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qt4-stub-'));
 try {const {set,human}=await fixture(root);const result=await judgeCalibration({set,human:[human],evidenceRoot:root,out:join(root,'session'),stub:true,timeoutMs:1000});expect(result.model.mode).toBe('stub');expect((await verifyCompletedCalibration(join(root,'session'))).report.raterCount).toBe(1);const promptFile='receipts/P01-claude-0-inventory.json';const receiptPath=join(root,'session',promptFile);const originalReceipt=await readFile(receiptPath);const alteredReceipt=JSON.parse(originalReceipt.toString());alteredReceipt.promptDigest='0'.repeat(64);await writeFile(receiptPath,JSON.stringify(alteredReceipt));const tamperedModel=structuredClone(result.model);tamperedModel.phaseDigests[promptFile]=digest(await readFile(receiptPath));await writeFile(join(root,'session','calibration-model.json'),JSON.stringify(tamperedModel));await expect(verifyCompletedCalibration(join(root,'session'))).rejects.toThrow(/prompt changed/);await writeFile(receiptPath,originalReceipt);await writeFile(join(root,'session','calibration-model.json'),JSON.stringify(result.model));expect(result.model.cases).toHaveLength(8);expect(result.model.cases[0]!.samples).toHaveLength(6);expect(Object.keys(result.model.phaseDigests)).toHaveLength(96);expect(result.agreement.criterionAgreement.typography).toMatchObject({withinOne:8,exact:0});expect(result.agreement.criterionAgreement.craft!.assessable).toBe(0);expect(result.agreement.investigationRequired).toBe(false);expect(result.model.cases[0]!.samples.map(s=>s.grade)).toEqual(Array(6).fill('C'));expect(await readFile(join(root,'session','calibration-report.md'),'utf8')).toContain('Mode: stub');const changed=structuredClone(result.model);changed.cases[0]!.samples[0]!.grade='A';await writeFile(join(root,'session','calibration-model.json'),JSON.stringify(changed));await expect(verifyCompletedCalibration(join(root,'session'))).rejects.toThrow(/scores differ/);}
 finally {await rm(root,{recursive:true,force:true});}
},60000);
test('live adapters receive screenshots and anchors but never submitted human scores or notes',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qt4-private-prompt-'));
 const prompts:string[]=[];
 const response=(prompt:string,reviewer:'claude'|'codex')=>{prompts.push(prompt);const phase=JSON.parse(prompt) as {instruction:string};const score=!phase.instruction.startsWith('Inventory');return {judgment:score?{grade:'C',criteria:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,['briefFidelity','craft','accessibility'].includes(c.id)?null:3])),evidence:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,'Fixture pixel evidence'])),failures:[],note:'Mocked subscription test'}:{concept:'Fixture',placeholders:[],brackets:[],inventedFacts:[],unreadEvidence:[]},models:[reviewer==='claude'?'claude-sonnet-5-5':'gpt-6.1-sol'],receipt:reviewer==='claude'?{apiKeySource:'oauth',auth:{authMethod:'claude.ai',subscriptionType:'max'}}:{billingLane:'subscription',auth:{authMethod:'chatgpt'},requestedModel:'gpt-6.1-sol',serviceTier:'priority'}};};
 vi.spyOn(subscriptions,'callClaude').mockImplementation(async input=>{const request=input as {message:{content:Array<{text?:string}>}};return response(request.message.content[0]!.text!,'claude');});
 vi.spyOn(subscriptions,'callCodex').mockImplementation(async prompt=>response(prompt,'codex'));
 try {const {set,human}=await fixture(root);human.rater='HiddenHuman';human.cases.forEach(c=>{c.note='PRIVATE HUMAN NOTE';c.grade='F';});const out=join(root,'session');await judgeCalibration({set,human:[human],evidenceRoot:root,out,timeoutMs:1000});expect(prompts).toHaveLength(96);expect(prompts.every(p=>!p.includes('HiddenHuman')&&!p.includes('PRIVATE HUMAN NOTE')&&!p.includes('humanGrade'))).toBe(true);expect((await verifyCompletedCalibration(out)).model.mode).toBe('live');}
 finally {vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
},60000);

test('rejects an invalid scored sample before scheduling another provider call',async()=>{
 const root=await mkdtemp(join(tmpdir(),'qt4-invalid-score-'));
 const claude=vi.spyOn(subscriptions,'callClaude').mockResolvedValueOnce({judgment:{concept:'Fixture',placeholders:[],brackets:[],inventedFacts:[],unreadEvidence:[]},models:['claude-sonnet-5-5'],receipt:{}}).mockResolvedValueOnce({judgment:{grade:'C',criteria:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,['briefFidelity','craft','accessibility'].includes(c.id)?null:3])),evidence:Object.fromEntries(AGENCY_BAR.criteria.map(c=>[c.id,'Fixture pixel evidence'])),failures:[],note:' '},models:['claude-sonnet-5-5'],receipt:{}});
 const codex=vi.spyOn(subscriptions,'callCodex');
 try {const {set,human}=await fixture(root);await expect(judgeCalibration({set,human:[human],evidenceRoot:root,out:join(root,'session'),timeoutMs:1000})).rejects.toThrow(/Invalid judgment/);expect(claude).toHaveBeenCalledTimes(2);expect(codex).not.toHaveBeenCalled();}
 finally {vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
},60000);
