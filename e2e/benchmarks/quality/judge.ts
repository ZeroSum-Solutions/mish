import { readFileSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { validateAgencyBar, renderAgencyBarMarkdown } from './bar.ts';
import { PNG } from 'pngjs';
import { verifyFiles, judgmentEvidenceDigest } from './packet.ts';
import { EVALUATOR_PROTOCOL_DIGEST } from './protocol.ts';
import { writeJsonAtomic } from './storage.ts';
import { digest, safePath } from './api.ts';
import { VIEWPORTS } from './settings.ts';
import { callClaude, callCodex, sanitiseDiagnostic, assertJudgeRoute, DEFAULT_JUDGE_MODEL, CODEX_JUDGE_MODEL } from './subscription.ts';
import type { BenchmarkRun, Captures, Judgment, Judgments, Rubric, Inventory, Reviewer, JudgeSample, CaseRun, CaptureFact } from './types.ts';
export { callClaude, callCodex, subscriptionEnv, requireSubscription, requireCodexSubscription, DEFAULT_JUDGE_MODEL, CODEX_JUDGE_MODEL } from './subscription.ts';
export const SAMPLE_COUNT = 3;
export const JUDGE_PROTOCOL_DIGEST = digest(Buffer.concat(['judge.ts', 'subscription.ts', 'samples.ts', 'storage.ts'].map(file => readFileSync(new URL(file, import.meta.url)))));
const GRADES = ['A', 'B', 'C', 'D', 'E', 'F'] as const;
export function parseRubric(markdown: string): Rubric {
  const blocks = [...markdown.matchAll(/```json\s*\n([\s\S]*?)```/gu)];
  if (blocks.length !== 1) throw new Error('Rubric must contain one fenced JSON block');
  const value = JSON.parse(blocks[0]![1]!) as Rubric;
  if (!value.version?.trim() || !['placeholder', 'approved'].includes(value.status) || !Array.isArray(value.criteria) || !value.criteria.length || !value.grades) throw new Error('Invalid rubric');
  const ids = new Set<string>();
  for (const criterion of value.criteria) {
    if (!/^[a-zA-Z][a-zA-Z0-9]*$/u.test(criterion.id) || ids.has(criterion.id) || !criterion.name?.trim()) throw new Error('Invalid or duplicate rubric criterion');
    ids.add(criterion.id);
    for (const anchor of ['1', '2', '3', '4', '5'] as const) if (typeof criterion.anchors?.[anchor] !== 'string' || !criterion.anchors[anchor].trim()) throw new Error('Missing criterion anchor');
  }
  for (const grade of GRADES) if (typeof value.grades[grade] !== 'string' || !value.grades[grade].trim()) throw new Error('Missing letter-grade definition');
  validateAgencyBar(value);
  if (markdown !== renderAgencyBarMarkdown()) throw new Error('Altered rubric document; use the generated agency bar');
  return value;
}
export function parseJudgment(value: unknown, rubric: Rubric): Judgment {
  const judgment = value as Judgment;
  if (!judgment || judgment.grade !== null && !GRADES.includes(judgment.grade) || typeof judgment.note !== 'string' || !judgment.note.trim() || !Array.isArray(judgment.failures) || judgment.failures.some(item => typeof item !== 'string' || !item.trim()) || !judgment.criteria) throw new Error('Invalid judgment');
  if (Object.keys(judgment.criteria).length !== rubric.criteria.length) throw new Error('Incomplete criterion scores');
  for (const criterion of rubric.criteria) {
    const score = judgment.criteria[criterion.id];
    if (score !== null && (!Number.isInteger(score) || score! < 1 || score! > 5)) throw new Error(`Rate ${criterion.id} from 1 to 5`);
  }
  return judgment;
}
export function judgeSchema(rubric: Rubric) {
  return { type: 'object', additionalProperties: false, required: ['grade', 'criteria', 'failures', 'note'], properties: {
    grade: { anyOf: [{ type: 'string', enum: GRADES }, { type: 'null' }] }, note: { type: 'string', minLength: 1 }, failures: { type: 'array', items: { type: 'string', minLength: 1 } },
    criteria: { type: 'object', additionalProperties: false, required: rubric.criteria.map(item => item.id), properties: Object.fromEntries(rubric.criteria.map(item => [item.id, { anyOf: [{ type: 'integer', minimum: 1, maximum: 5 }, { type: 'null' }] }])) },
  } };
}

export function parseInventory(value: unknown): Inventory {
  const inventory = value as Inventory;
  if (!inventory || typeof inventory.concept !== 'string' || !inventory.concept.trim()
    || ['placeholders', 'brackets', 'inventedFacts', 'unreadEvidence'].some(key => !Array.isArray(inventory[key as keyof Inventory]) || (inventory[key as keyof Inventory] as unknown[]).some(item => typeof item !== 'string' || !item.trim()))) throw new Error('Invalid inventory');
  return inventory;
}
export const inventorySchema = { type: 'object', additionalProperties: false, required: ['concept', 'placeholders', 'brackets', 'inventedFacts', 'unreadEvidence'], properties: { concept: { type: 'string', minLength: 1 }, ...Object.fromEntries(['placeholders', 'brackets', 'inventedFacts', 'unreadEvidence'].map(key => [key, {type:'array',items:{type:'string',minLength:1}}])) } };
export function parseScoredJudgment(value: unknown, rubric: Rubric) {
  const judgment = parseJudgment(value, rubric);
  if (!judgment.evidence || Object.keys(judgment.evidence).length !== rubric.criteria.length || rubric.criteria.some(c => typeof judgment.evidence?.[c.id] !== 'string' || !judgment.evidence[c.id]!.trim())) throw new Error('Every criterion needs cited evidence or a not-assessable reason');
  return judgment;
}
export function scoringSchema(rubric: Rubric) {
  const schema = judgeSchema(rubric);
  return {...schema, required:[...schema.required, 'evidence'], properties:{...schema.properties, evidence:{type:'object',additionalProperties:false,required:rubric.criteria.map(c=>c.id),properties:Object.fromEntries(rubric.criteria.map(c=>[c.id,{type:'string',minLength:1}]))}}};
}
export function reviewerSettings(model = DEFAULT_JUDGE_MODEL, codexModel = CODEX_JUDGE_MODEL): Reviewer[] {
  assertJudgeRoute('claude', model); assertJudgeRoute('codex', codexModel);
  return [{id:'claude',model}, {id:'codex',model:codexModel}];
}
/** Preserve original full-page PNGs; send bounded, lossless tiles to the judge. */
export function imageTiles(bytes: Buffer): Buffer[] {
  const source = PNG.sync.read(bytes); const tiles: Buffer[] = [];
  if (source.width > 2000) throw new Error('Capture exceeds judge image width');
  for (let y = 0; y < source.height;) {
    let height = Math.min(1600, source.height - y);
    for (;;) {
      const tile = new PNG({ width: source.width, height });
      PNG.bitblt(source, tile, 0, y, tile.width, tile.height, 0, 0);
      const encoded = PNG.sync.write(tile);
      if (encoded.toString('base64').length <= 5_000_000) { tiles.push(encoded); y += height; break; }
      if (height <= 1) throw new Error('Judge image tile exceeds size budget');
      height = Math.ceil(height / 2);
    }
  }
  return tiles;
}

/** Visual criteria are required. Interaction/hygiene gaps remain criterion-level nulls. */
export const REQUIRED_CRITERIA = ['artDirection', 'imagery', 'typography', 'layout', 'briefFidelity', 'responsive'];
export function missingRequiredCriteria(judgment: Judgment, rubric: Rubric) {
  return rubric.criteria.filter(c => REQUIRED_CRITERIA.includes(c.id) && judgment.criteria[c.id] === null).map(c => c.id);
}
/** One page per request. Other widths are measured facts, never extra visual payload. */
export async function buildPagePayload(out: string, item: CaseRun, page: string, allFacts: CaptureFact[], brief: unknown, stub: boolean) {
  const facts = allFacts.filter(f => f.page === page);
  const html = await readFile(join(out, 'cases', item.caseId, 'files', ...safePath(page)), 'utf8');
  const source = await Promise.all(item.files.filter(f => /\.(css|js|mjs)$/iu.test(f.name)).map(async f => ({ file: f.name, text: await readFile(join(out, 'cases', item.caseId, 'files', ...safePath(f.name)), 'utf8') })));
  const text = JSON.stringify({ brief, page, html, source, facts, siteCheck: item.siteCheck, buildFailures: item.failures,
    visualWidths: [1440, 390], otherWidths: 'Mechanical facts only; no visual inference at uncited widths.' });
  if (Buffer.byteLength(text)>2_000_000) throw new Error('Required page source/facts exceed judge payload budget');
  const content: unknown[] = [{ type: 'text', text }];
  const images: Array<{ file: string; sha256: string; label: string }> = [];
  const dir = join(out, 'cases', item.caseId, 'judge'); await mkdir(dir, { recursive: true });
  const add = async (bytes: Buffer, id: string, label: string, required: boolean) => {
    const tiles = imageTiles(bytes);
    const blocks = tiles.flatMap((tile, index) => [{ type: 'text', text: `${label}, vertical tile ${index + 1}/${tiles.length}` }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: tile.toString('base64') } }]);
    if (images.length + tiles.length > 100 || Buffer.byteLength(JSON.stringify([...content, ...blocks])) > 23_000_000) {
      if (required) throw new Error('Required page captures exceed judge payload budget');
      return;
    }
    for (const [index, tile] of tiles.entries()) {
      const file = join(dir, `${id}-tile-${index}.png`); await writeFile(file, tile);
      images.push({ file, sha256: digest(tile), label: `${label}, vertical tile ${index + 1}/${tiles.length}` });
    }
    content.push(...blocks);
  };
  const visual = facts.filter(f => [1440, 390].includes(f.viewport.width));
  if (!stub) {
    for (const f of visual) await add(await readFile(join(out, ...safePath(f.screenshot))), f.id, `${page} at ${f.viewport.width}x${f.viewport.height}, full page`, true);
    for (const f of visual) for (const section of f.sections.filter(s => !s.error && s.box.height <= 800).slice(0, 4)) {
      let bytes: Buffer;
      try { bytes = await readFile(join(out, ...safePath(section.screenshot))); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      await add(bytes, section.id, `${page} at ${f.viewport.width}x${f.viewport.height}, section ${section.id} ${section.selector}`, false);
    }
  }
  return { text, content, images };
}

/** Frozen evidence, three independent inventory→score samples on each subscription lane. */
export async function judgeRun(out: string, run: BenchmarkRun, captures: Captures, options: { rubricPath: string; model: string; codexModel?: string; stub?: boolean; timeoutMs: number }): Promise<Judgments> {
  if (!options.stub) await verifyFiles(out, run, captures);
  const markdown = await readFile(options.rubricPath, 'utf8'); const rubric = parseRubric(markdown);
  if (markdown !== renderAgencyBarMarkdown()) throw new Error('Altered rubric document; use the generated agency bar');
  if (captures.runId !== run.runId) throw new Error('Capture run identity differs');
  if (!options.stub && rubric.status !== 'approved') throw new Error('Lead must approve agency-bar.md before live judging');
  if (!options.stub && run.mode !== 'live') throw new Error('Use --stub for synthetic runs');
  const reviewers = reviewerSettings(options.stub && options.model === 'stub' ? DEFAULT_JUDGE_MODEL : options.model, options.codexModel);
  const judgments: Judgments = { schema:'quality-judgments/2', runId:run.runId, evidenceDigest:judgmentEvidenceDigest(run,captures,digest(markdown)),evaluatorProtocolDigest:EVALUATOR_PROTOCOL_DIGEST, judgeProtocolDigest:JUDGE_PROTOCOL_DIGEST, mode:options.stub?'stub':'live', rubricDigest:digest(markdown), rubric, requestedModel:reviewers[0]!.model, reviewers, sampleCount:3, actualModels:[], judgedAt:new Date().toISOString(), wallTimeMs:0, cases:[], phaseReceipts:{} };
  const progressFile = join(out,'judgments.partial.json');
  try { await readFile(join(out,'judgments.json')); throw new Error('Judgments already completed; preserve this packet'); }
  catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  try {
    const previous = JSON.parse(await readFile(progressFile,'utf8')) as Judgments;
    if (previous.schema !== judgments.schema || previous.evidenceDigest!==judgments.evidenceDigest || previous.evaluatorProtocolDigest!==EVALUATOR_PROTOCOL_DIGEST || previous.runId !== run.runId || previous.rubricDigest !== judgments.rubricDigest || previous.judgeProtocolDigest !== JUDGE_PROTOCOL_DIGEST || JSON.stringify(previous.reviewers) !== JSON.stringify(reviewers) || previous.sampleCount !== SAMPLE_COUNT || previous.mode !== judgments.mode) throw new Error('Interrupted judge settings differ; preserve the prior packet');
    // Individual sample receipts are the resume truth. Rebuild summaries from them.
    if(!Number.isFinite(Date.parse(previous.judgedAt))) throw new Error('Invalid original judge timestamp');
    judgments.judgedAt=previous.judgedAt; judgments.wallTimeMs = previous.wallTimeMs;
    for(const [file,sha] of Object.entries(previous.phaseReceipts??{})) if(digest(await readFile(join(out,...safePath(file))))!==sha) throw new Error(`Judge receipt changed: ${file}`);
    for(const sample of previous.cases.flatMap(c=>c.samples)) for(const file of sample.receiptFiles) if(digest(await readFile(join(out,...safePath(file))))!==sample.receiptDigests[file]) throw new Error(`Judge receipt changed: ${file}`);
    judgments.phaseReceipts=previous.phaseReceipts??{};
  } catch(error) { if((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  let publication = Promise.resolve();
  const save = () => { publication = publication.then(async () => {
    judgments.wallTimeMs = Date.now()-Date.parse(judgments.judgedAt);
    judgments.cases.sort((a,b)=>run.cases.findIndex(c=>c.caseId===a.caseId)-run.cases.findIndex(c=>c.caseId===b.caseId));
    for (const c of judgments.cases) c.samples.sort((a,b)=>(a.page??'').localeCompare(b.page??'') || a.reviewer.localeCompare(b.reviewer) || a.index-b.index);
    await writeJsonAtomic(progressFile,judgments);
  }); return publication; };
  const judgeCase = async (item: CaseRun) => {
    const facts = captures.facts.filter(f=>f.caseId === item.caseId);
    const pages = item.files.filter(file=>/\.html?$/iu.test(file.name) && !file.name.startsWith('_brand-build/'));
    const rating: Judgments['cases'][number] = {caseId:item.caseId,origin:options.stub?'stub':'model',samples:[]};
    judgments.cases.push(rating);
    if (!pages.length || pages.some(page=>VIEWPORTS.some(viewport=>facts.filter(f=>f.page===page.name && f.viewport.width===viewport.width && f.viewport.height===viewport.height && !f.error).length!==1))) {
      rating.origin='missing-evidence'; rating.reason='Missing rendered evidence; case was not model judged'; await save(); return;
    }
    const dir = join(out,'cases',item.caseId,'judge'); await mkdir(dir,{recursive:true});
    const briefs = JSON.parse(await readFile(join(out,'cases.json'),'utf8')) as Array<{id:string;brief:string}>;
    const brief=briefs.find(b=>b.id===item.caseId);
    for (const page of pages) {
    let payload: Awaited<ReturnType<typeof buildPagePayload>>;
    try { payload = await buildPagePayload(out, item, page.name, facts, brief, !!options.stub); }
    catch (error) { if (!(error instanceof Error) || !error.message.includes('payload budget')) throw error; rating.origin='missing-evidence'; rating.reasons=[...new Set([...(rating.reasons??[]),`${page.name}: ${error.message}`])].sort(); rating.reason=rating.reasons.join('; '); await save(); continue; }
    const { content, images, text: pageText } = payload;
    const evidenceDigest=digest(JSON.stringify({page:page.name,pageText,images:images.map(({sha256,label})=>({sha256,label})),rubric:judgments.rubricDigest,protocol:JUDGE_PROTOCOL_DIGEST,mode:judgments.mode}));
    // Independent samples run together; publication is serialized for reliable resume.
    const attempts = await Promise.allSettled(reviewers.flatMap(reviewer => Array.from({length:SAMPLE_COUNT}, (_,index) => (async () => {
      const receiptFiles:string[]=[]; const receiptDigests:Record<string,string>={}; let workerTimeMs=0; let observedModels:string[]=[];
      const phase=async (name:'inventory'|'score', instruction:string, schema:unknown, inventory?:Inventory) => {
        const path=join(dir,`${encodeURIComponent(page.name)}-${reviewer.id}-${index}-${name}.json`); receiptFiles.push(`cases/${item.caseId}/judge/${encodeURIComponent(page.name)}-${reviewer.id}-${index}-${name}.json`);
        const inputDigest=digest(JSON.stringify({evidenceDigest,reviewer,index,name,instruction,inventory}));
        let saved: {inputDigest:string;responseDigest:string;phase:string;page?:string;reviewer:string;index:number;model:string;response:Awaited<ReturnType<typeof callClaude>>;workerTimeMs:number};
        try { saved=JSON.parse(await readFile(path,'utf8')); if(saved.inputDigest!==inputDigest||saved.responseDigest!==digest(JSON.stringify(saved.response))) throw new Error('Saved judge input differs; preserve this packet'); }
        catch(error) {
          if((error as NodeJS.ErrnoException).code!=='ENOENT') throw error;
          const t=performance.now();
          const text=JSON.stringify({instruction,inventory,rubric:name==='score'?markdown:undefined,imageManifest:images.map(i=>i.label)});
          let response: Awaited<ReturnType<typeof callClaude>>;
          try {
          if(options.stub) response={judgment:name==='inventory'?{concept:'Synthetic fixture',placeholders:[],brackets:[],inventedFacts:[],unreadEvidence:[]}:{grade:'C',criteria:Object.fromEntries(rubric.criteria.map(c=>[c.id,3])),evidence:Object.fromEntries(rubric.criteria.map(c=>[c.id,'Synthetic fixture; no provider evaluation'])),failures:[],note:'Synthetic stub judge; no model evaluation.'},models:['stub'],receipt:{billingLane:'stub',incrementalCashUsd:0}};
          else if(reviewer.id==='claude') response=await callClaude({type:'user',message:{role:'user',content:[{type:'text',text},...content]}},schema,reviewer.model,out,options.timeoutMs);
          else response=await callCodex(`${text}\n${pageText}`,images.map(i=>i.file),schema,reviewer.model,out,options.timeoutMs);
            if(name==='inventory') parseInventory(response.judgment); else parseScoredJudgment(response.judgment,rubric);
          } catch (error) {
            const failure = error as Error & { receipt?: unknown };
            const failureFile = `${path}.failure-${Date.now()}.json`;
            await writeJsonAtomic(failureFile, { inputDigest, page: page.name, phase: name, reviewer: reviewer.id, index, model: reviewer.model, error: failure.receipt ?? { message: sanitiseDiagnostic(failure.message), response: typeof response! === 'undefined' ? undefined : sanitiseDiagnostic(response!) } }, true);
            const relative = failureFile.slice(out.length + 1);
            judgments.phaseReceipts[relative] = digest(await readFile(failureFile)); await save(); throw error;
          }
          saved={inputDigest,responseDigest:digest(JSON.stringify(response)),phase:name,page:page.name,reviewer:reviewer.id,index,model:reviewer.model,response,workerTimeMs:performance.now()-t}; await writeJsonAtomic(path,saved,true);
        }
        receiptDigests[receiptFiles[receiptFiles.length-1]!]=digest(await readFile(path));
        judgments.phaseReceipts[receiptFiles[receiptFiles.length-1]!]=receiptDigests[receiptFiles[receiptFiles.length-1]!]!; await save();
        workerTimeMs+=saved.workerTimeMs; observedModels=[...new Set([...observedModels,...saved.response.models])]; judgments.actualModels=[...new Set([...judgments.actualModels,...saved.response.models])];
        return saved.response.judgment;
      };
      const inventory=parseInventory(await phase('inventory','Pass 1. Inventory the concept; cite placeholders, raw brackets, suspected invented facts, and each unread evidence item. Do not score, assume an expected grade, or see other reviewer results.',inventorySchema));
      const judgment=parseScoredJudgment(await phase('score','Pass 2. Score only criteria substantiated by this evidence. Cite page, viewport and region or a measured fact for every criterion. Use null with a not-assessable reason when unsupported (especially reference interaction, hygiene and supplied facts). Required criteria: artDirection, imagery, typography, layout, briefFidelity, responsive. CSS/JS and measured facts substantiate static states; do not demand live tools. Uncaptured optional menu/carousel states are craft/accessibility nulls with a reason, not unread visual evidence. Inventory unread items do not void the page; decide evidence availability separately for each criterion. Scores and suspected facts remain advisory. No expected grade is supplied.',scoringSchema(rubric),inventory),rubric);
      const missing = missingRequiredCriteria(judgment, rubric);
      if (missing.length) { rating.origin='missing-evidence'; rating.reasons=[...new Set([...(rating.reasons??[]),`${page.name}: required criteria unsubstantiated: ${missing.join(', ')}`])].sort(); rating.reason=rating.reasons.join('; '); }
      const sample:JudgeSample={...judgment,page:page.name,reviewer:reviewer.id,model:reviewer.model,observedModels,index,inventory,workerTimeMs,receiptFiles,receiptDigests}; rating.samples.push(sample); await save();
    })())));
    const failed = attempts.find((attempt): attempt is PromiseRejectedResult => attempt.status === 'rejected');
    if (failed) throw failed.reason;
    }
    await save();
  };
  for(let start=0;start<run.cases.length;start+=2) {
    const results=await Promise.allSettled(run.cases.slice(start,start+2).map(judgeCase));
    const failed=results.find((result): result is PromiseRejectedResult=>result.status==='rejected');
    if(failed) throw failed.reason;
  }
  if(!judgments.actualModels.length) judgments.actualModels=['none:missing-evidence'];
  await save(); await writeJsonAtomic(join(out,'judgments.json'),judgments,true); return judgments;
}
