import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { captureEvidenceErrors } from './evidence.ts';
import { fingerprintDigest } from './fingerprint.ts';
import { VIEWPORTS } from './settings.ts';
import { digest, safePath } from './api.ts';
import type { BenchmarkRun, Captures, BriefCase, Judgments } from './types.ts';
/** Detect accidentally mixed/edited artifacts before capture, provider egress or scoring. */
export async function verifyFiles(out: string, run: BenchmarkRun, captures?: Captures) {
  if (captures && captures.schema !== 'quality-captures/2') throw new Error('Unsupported capture schema');
  if (!run.fingerprint || run.fingerprint.digest !== fingerprintDigest(run.fingerprint) || run.fingerprint.fixtureDigest !== run.fixtureDigest) throw new Error('Run fingerprint differs');
  const briefs = JSON.parse(await readFile(join(out, 'cases.json'), 'utf8')) as BriefCase[];
  if (digest(JSON.stringify(briefs)) !== run.fixtureDigest || briefs.length !== run.cases.length || run.cases.some(item => !briefs.some(brief => brief.id === item.caseId && brief.kitId === item.kitId && brief.industry === item.industry))) throw new Error('Frozen brief/run packet differs');
  for (const item of run.cases) {
    if (!/^[a-z0-9-]+$/u.test(item.caseId)) throw new Error('Unsafe case identity');
    for (const file of item.files) {
      const bytes = await readFile(join(out, 'cases', item.caseId, 'files', ...safePath(file.name)));
      if (bytes.length !== file.bytes || digest(bytes) !== file.sha256) throw new Error(`Saved artifact changed: ${item.caseId}/${file.name}`);
    }
  }
  if (captures) {
    if (captures.runId !== run.runId) throw new Error('Capture run identity differs');
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const item of run.cases) for (const file of item.files.filter(file => /\.html?$/iu.test(file.name) && !file.name.startsWith('_brand-build/'))) for (const viewport of VIEWPORTS) {
      const facts = captures.facts.filter(fact => fact.caseId === item.caseId && fact.page === file.name && fact.viewport.width === viewport.width && fact.viewport.height === viewport.height);
      if (facts.length !== 1) throw new Error(`Missing or duplicate capture: ${item.caseId}/${file.name}/${viewport.width}`);
    }
    for (const fact of captures.facts) {
      if (!run.cases.some(item => item.caseId === fact.caseId && item.files.some(file => file.name === fact.page)) || !VIEWPORTS.some(viewport => viewport.width === fact.viewport.width && viewport.height === fact.viewport.height)) throw new Error('Unknown capture page or viewport');
      if (!fact.id || ids.has(fact.id)) throw new Error('Missing or duplicate capture identity');
      ids.add(fact.id);
      if (!fact.evidenceFile || !fact.evidenceSha256) throw new Error('Missing capture evidence receipt');
      const evidenceBytes = await readFile(join(out, ...safePath(fact.evidenceFile)));
      if (digest(evidenceBytes) !== fact.evidenceSha256) throw new Error(`Saved evidence changed: ${fact.evidenceFile}`);
      const { evidenceFile: _path, evidenceSha256: _hash, ...evidence } = fact;
      if (JSON.stringify(JSON.parse(evidenceBytes.toString())) !== JSON.stringify(evidence)) throw new Error('Capture evidence differs from receipt');
      if(!fact.error&&captureEvidenceErrors(fact).length) throw new Error('Malformed capture evidence');
      if (!Array.isArray(fact.sections)) throw new Error('Missing section evidence');
      for (const record of [fact, ...fact.sections]) {
        if (record !== fact) {
          if (!record.id.startsWith(`${fact.id}-s`) || ids.has(record.id)) throw new Error('Invalid or duplicate section identity');
          ids.add(record.id);
        }
        if (paths.has(record.screenshot)) throw new Error('Duplicate screenshot path');
        paths.add(record.screenshot); safePath(record.screenshot);
        if (!record.error || record.screenshotSha256) {
          const bytes = await readFile(join(out, ...safePath(record.screenshot)));
          if (!record.screenshotSha256 || digest(bytes) !== record.screenshotSha256) throw new Error(`Saved screenshot changed: ${record.screenshot}`);
        }
      }
    }
  }
}

/** Binds judgments to the captured case bytes, facts and rubric, rather than only run IDs. */
export function judgmentEvidenceDigest(run:BenchmarkRun,captures:Captures,rubricDigest:string) {
  return digest(JSON.stringify({runId:run.runId,fixtureDigest:run.fixtureDigest,fingerprint:run.fingerprint.digest,cases:run.cases,captures,rubricDigest}));
}
function canonical(value:unknown):unknown {
  if(Array.isArray(value)) return value.map(canonical);
  if(value&&typeof value==='object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,v])=>[key,canonical(v)]));
  return value;
}
/** A sample must reproduce its two immutable phase receipts and subscription provenance. */
export async function verifyJudgments(out:string,judgments:Judgments,run?:BenchmarkRun,captures?:Captures) {
  if(run&&captures&&judgments.evidenceDigest!==judgmentEvidenceDigest(run,captures,judgments.rubricDigest)) throw new Error('Judgment evidence digest differs');
  if(judgments.mode==='live'&&(!run||!captures)) throw new Error('Live judgment evidence binding unavailable');
  for(const sample of judgments.cases.flatMap(c=>c.samples)) {
    if(!sample.receiptDigests || sample.receiptFiles.length!==2) throw new Error('Missing judge phase receipts');
    let inventory:unknown; let scored:unknown; let workerTimeMs=0; const observedModels=new Set<string>(); const phases=new Set<string>();
    for(const file of sample.receiptFiles) {
      const bytes=await readFile(join(out,...safePath(file)));
      if(!sample.receiptDigests[file] || digest(bytes)!==sample.receiptDigests[file]) throw new Error(`Judge receipt changed: ${file}`);
      const receipt=JSON.parse(bytes.toString()) as {phase:string;page?:string;reviewer:string;index:number;model:string;workerTimeMs:number;response:{judgment:unknown;models:string[];receipt?:{billingLane?:string;auth?:{authMethod?:string;apiProvider?:string;subscriptionType?:string};apiKeySource?:string;serviceTier?:string;requestedModel?:string}}};
      if(!['inventory','score'].includes(receipt.phase)||phases.has(receipt.phase)||receipt.reviewer!==sample.reviewer||receipt.index!==sample.index||receipt.model!==sample.model||receipt.page!==sample.page||!Number.isFinite(receipt.workerTimeMs)||receipt.workerTimeMs<0||!Array.isArray(receipt.response?.models)) throw new Error('Judge sample/receipt identity differs');
      phases.add(receipt.phase); for(const model of receipt.response.models) observedModels.add(model);workerTimeMs+=receipt.workerTimeMs;
      if(judgments.mode==='live') {
        const provenance=receipt.response.receipt;
        const actualModels=receipt.response.models;
        if(actualModels.some(model=>model!==sample.model&&!(sample.reviewer==='claude'&&model.startsWith(`${sample.model}-`)&&/^\d{8}$/u.test(model.slice(sample.model.length+1)))) || actualModels.some(model=>!judgments.actualModels.includes(model))) throw new Error('Judge sample/receipt model provenance differs');
        const valid=sample.reviewer==='claude' ? provenance?.auth?.authMethod==='claude.ai'&&provenance.auth.apiProvider==='firstParty'&&provenance.auth.subscriptionType==='max'&&['none','oauth','claude.ai'].includes(provenance.apiKeySource??'') : provenance?.billingLane==='subscription'&&provenance.auth?.authMethod==='chatgpt'&&provenance.serviceTier==='priority'&&provenance.requestedModel===sample.model;
        if(!valid) throw new Error('Live judge sample requires subscription receipt provenance');
      }
      if(receipt.phase==='inventory') inventory=receipt.response.judgment;else scored=receipt.response.judgment;
    }
    const value={grade:sample.grade,criteria:sample.criteria,failures:sample.failures,note:sample.note,evidence:sample.evidence};
    if(JSON.stringify(canonical(inventory))!==JSON.stringify(canonical(sample.inventory))||JSON.stringify(canonical(scored))!==JSON.stringify(canonical(value))||workerTimeMs!==sample.workerTimeMs||[...observedModels].sort().join()!==[...sample.observedModels].sort().join()) throw new Error('Judge sample differs from phase receipts');
  }
}
