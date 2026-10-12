import { test, expect } from 'vitest';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest } from '../../benchmarks/quality/api.ts';
import { packet } from '../../lib/quality/packet-fixture.ts';
import { verifyJudgments,judgmentEvidenceDigest } from '../../benchmarks/quality/packet.ts';
async function fixture(root:string) {
  const p=packet();const sample=p.judgments.cases[0]!.samples[0]!;
  // Other samples in this pure unit fixture have no receipts; bind only this one.
  p.judgments.cases[0]!.samples=[sample];
  const files={'inventory.json':{phase:'inventory',reviewer:sample.reviewer,index:sample.index,model:sample.model,response:{judgment:sample.inventory,models:['stub']},workerTimeMs:4},'score.json':{phase:'score',reviewer:sample.reviewer,index:sample.index,model:sample.model,response:{judgment:{grade:sample.grade,criteria:sample.criteria,evidence:sample.evidence,failures:sample.failures,note:sample.note},models:['stub']},workerTimeMs:6}};
  sample.receiptFiles=Object.keys(files);sample.receiptDigests={};
  for(const [file,value] of Object.entries(files)){const bytes=Buffer.from(JSON.stringify(value));await writeFile(join(root,file),bytes);sample.receiptDigests[file]=digest(bytes);}
  p.judgments.evidenceDigest=judgmentEvidenceDigest(p.run,p.captures,p.judgments.rubricDigest);
  return p;
}
test('phase hashes, sample values, evidence binding and live provenance are all checked',async()=>{
  const root=await mkdtemp(join(tmpdir(),'quality-phase-binding-'));
  try {
    const p=await fixture(root);const sample=p.judgments.cases[0]!.samples[0]!;
    await expect(verifyJudgments(root,p.judgments,p.run,p.captures)).resolves.toBeUndefined();
    sample.criteria.imagery=5;
    await expect(verifyJudgments(root,p.judgments,p.run,p.captures)).rejects.toThrow(/sample.*receipt|receipt.*sample/i);
    sample.criteria.imagery=2;
    p.captures.facts[0]!.horizontalOverflowPx=18;
    await expect(verifyJudgments(root,p.judgments,p.run,p.captures)).rejects.toThrow(/evidence digest/i);
    p.captures.facts[0]!.horizontalOverflowPx=0;
    p.judgments.mode='live';p.judgments.actualModels=['claude-sonnet-5-5','gpt-6.1-sol'];
    await expect(verifyJudgments(root,p.judgments,p.run,p.captures)).rejects.toThrow(/provenance/i);
    p.judgments.mode='stub';await writeFile(join(root,'score.json'),'edited');
    await expect(verifyJudgments(root,p.judgments,p.run,p.captures)).rejects.toThrow(/receipt changed/i);
  } finally {await rm(root,{recursive:true,force:true});}
});
