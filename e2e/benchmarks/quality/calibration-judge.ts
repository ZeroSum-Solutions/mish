import { readFileSync } from 'node:fs';
import { readFile, mkdir, realpath, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import { assertPrivateOutput } from './calibration-privacy.ts';
import { PNG } from 'pngjs';
import { digest, safePath } from './api.ts';
import { AGENCY_BAR } from './bar.ts';
import { REFERENCE_PROTOCOL_DIGEST } from './reference-capture.ts';
import { imageTiles, inventorySchema, scoringSchema, parseInventory, parseScoredJudgment, reviewerSettings, SAMPLE_COUNT, JUDGE_PROTOCOL_DIGEST } from './judge.ts';
import { callClaude, callCodex } from './subscription.ts';
import { writeJsonAtomic } from './storage.ts';
import { validateCalibrationSet, validateSubmission, validateCalibrationSample, calibrationAgreement, type CalibrationModel } from './calibration-session.ts';
import type { CalibrationSet } from './calibration-sheet.ts';
export const CALIBRATION_JUDGE_DIGEST = digest(JUDGE_PROTOCOL_DIGEST + ['calibration-judge.ts', 'calibration-session.ts', 'calibration-sheet.ts', 'calibration-privacy.ts'].map(file => readFileSync(new URL(file, import.meta.url), 'utf8')).join('\n'));

export async function verifyCalibrationEvidence(root: string, set: CalibrationSet) {
  const canonical = await realpath(root);
  for (const image of set.items.flatMap(item => item.screenshots)) {
    const file = await realpath(join(canonical, ...safePath(image.file)));
    if (relative(canonical, file).startsWith('..')) throw new Error('Screenshot escapes evidence root');
    const bytes = await readFile(file);
    if (digest(bytes) !== image.sha256) throw new Error('Screenshot digest differs');
    const png = PNG.sync.read(bytes);
    if (png.width !== image.width || png.height !== image.height) throw new Error('Screenshot dimensions differ');
  }
}
function calibrationPrompt(item: CalibrationSet['items'][number], labels: string[], phase: 'inventory' | 'score', inventory?: ReturnType<typeof parseInventory>) {
  const instruction = phase === 'inventory' ? 'Inventory the visible concept, placeholders, brackets and unread evidence. Do not score or assume an expected grade. No factual brief is available; do not infer invented facts.' : 'Score only substantiated criteria with viewport and region citations. Whole numbers 1 to 5. Use null with a reason when unsupported. Grade independently; no target grade is provided. These are screenshots only, not proof of facts, interaction, technical hygiene, zoom or unshown widths. If evidence is unread, use null, never a passing score.';
  return JSON.stringify({ instruction, page: item.id, limitation: item.limitation, unavailable: item.unavailable, mandatoryNullCriteria: item.unavailable, inventory, rubric: phase === 'score' ? AGENCY_BAR : undefined, imageManifest: labels });
}
function validateScoredEvidence(judgment: ReturnType<typeof parseScoredJudgment>, item: CalibrationSet['items'][number], inventory: ReturnType<typeof parseInventory>) {
  validateCalibrationSample(judgment, item);
  if (inventory.unreadEvidence.length && (judgment.grade !== null || Object.values(judgment.criteria).some(v => v !== null))) throw new Error('Unread evidence must remain inconclusive');
}
/** Explicit submitted packets are checked before output creation or any provider call. */
export async function judgeCalibration(options: { set: unknown; human: unknown[]; evidenceRoot: string; out: string; stub?: boolean; timeoutMs: number }) {
  const set = validateCalibrationSet(options.set);
  if (set.rubricDigest !== digest(JSON.stringify(AGENCY_BAR)) || set.protocolDigest !== REFERENCE_PROTOCOL_DIGEST) throw new Error('Bar or capture protocol changed; recapture and re-calibrate');
  const startedAt = new Date().toISOString();
  const humans = options.human.map(h => validateSubmission(h, set, startedAt));
  if (!humans.length || new Set(humans.map(h => h.rater.trim().toLowerCase())).size !== humans.length) throw new Error('Explicit human submissions required before judging');
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) throw new Error('Invalid judge timeout');
  await verifyCalibrationEvidence(options.evidenceRoot, set);
  await assertPrivateOutput(options.out);
  await mkdir(options.out); // New caller-owned directory. Preserve any earlier session.
  await writeJsonAtomic(join(options.out, 'calibration-input.json'), { set, humans, startedAt, mode: options.stub ? 'stub' : 'live' }, true);
  const model: CalibrationModel & { phaseDigests: Record<string, string>; workerTimeMs: number; wallTimeMs: number; observedModels: Record<string, string[]>; incrementalCashUsd: 0 } = {
    schema: 'quality-calibration-model/1', setDigest: digest(JSON.stringify(set)), humanDigests: humans.map(h => digest(JSON.stringify(h))), rubricDigest: set.rubricDigest, protocolDigest: set.protocolDigest, judgeProtocolDigest: CALIBRATION_JUDGE_DIGEST,
    reviewers: reviewerSettings(), startedAt, completedAt: startedAt, mode: options.stub ? 'stub' : 'live', cases: [], phaseDigests: {}, workerTimeMs: 0, wallTimeMs: 0, observedModels: {}, incrementalCashUsd: 0,
  };
  await mkdir(join(options.out, 'receipts'));
  await mkdir(join(options.out, 'images'));
  const save = () => writeJsonAtomic(join(options.out, 'calibration-model.partial.json'), model);
  await save();
  const prepared: Array<{ item: CalibrationSet['items'][number]; images: Array<{ file: string; label: string }>; imageContent: unknown[] }> = [];
  for (const item of set.items) {
    const images: Array<{ file: string; label: string }> = [];
    // Copy frozen bytes before judging; every page tile is supplied, never judge-picked crops.
    for (const capture of item.screenshots) {
      const bytes = await readFile(join(options.evidenceRoot, ...safePath(capture.file)));
      if (digest(bytes) !== capture.sha256) throw new Error('Evidence changed during calibration');
      await writeFile(join(options.out, 'images', `${item.id}-${capture.width}-original.png`), bytes, { flag: 'wx', mode: 0o600 });
      for (const [index, tile] of imageTiles(bytes).entries()) {
        const file = join(options.out, 'images', `${item.id}-${capture.width}-tile-${index}.png`);
        await writeFile(file, tile, { flag: 'wx', mode: 0o600 });
        images.push({ file, label: `${item.id} ${capture.width}px; vertical tile ${index + 1}` });
      }
    }
    const imageContent = (await Promise.all(images.map(async image => [{ type: 'text', text: image.label }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: (await readFile(image.file)).toString('base64') } }]))).flat();
    if (images.length > 100 || JSON.stringify(imageContent).length > 24_000_000) throw new Error('Calibration page exceeds bounded judge payload');
    prepared.push({ item, images, imageContent });
  }
  for (const { item, images, imageContent } of prepared) {
    const page: CalibrationModel['cases'][number] = { caseId: item.id, samples: [] };
    model.cases.push(page);
    for (const reviewer of model.reviewers) for (let index = 0; index < SAMPLE_COUNT; index++) {
      let inventory: ReturnType<typeof parseInventory> | undefined;
      for (const phase of ['inventory', 'score'] as const) {
        const prompt = calibrationPrompt(item, images.map(i => i.label), phase, inventory);
        const schema = phase === 'inventory' ? inventorySchema : scoringSchema(AGENCY_BAR);
        const t = performance.now();
        let response: Awaited<ReturnType<typeof callClaude>>;
        if (options.stub) response = { judgment: phase === 'inventory' ? { concept: 'Synthetic test fixture', placeholders: [], brackets: [], inventedFacts: [], unreadEvidence: [] } : { grade: 'C', criteria: Object.fromEntries(AGENCY_BAR.criteria.map(c => [c.id, item.unavailable.includes(c.id) ? null : 3])), evidence: Object.fromEntries(AGENCY_BAR.criteria.map(c => [c.id, 'Synthetic fixture; screenshot-only criteria unsupported'])), failures: [], note: 'Stub, no provider evaluation' }, models: ['stub'], receipt: { billingLane: 'stub', incrementalCashUsd: 0 } };
        else {
          const scratch = await mkdtemp(join(tmpdir(), 'qt4-subscription-'));
          try {
            response = reviewer.id === 'claude'
              ? await callClaude({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: prompt }, ...imageContent] } }, schema, reviewer.model, scratch, options.timeoutMs)
              : await callCodex(prompt, images.map(i => i.file), schema, reviewer.model, scratch, options.timeoutMs);
          } finally { await rm(scratch, { recursive: true, force: true }); }
        }
        const workerTimeMs = performance.now() - t;
        if (phase === 'inventory') inventory = parseInventory(response.judgment);
        else {
          const judgment = parseScoredJudgment(response.judgment, AGENCY_BAR);
          validateScoredEvidence(judgment, item, inventory!);
          page.samples.push({ ...judgment, reviewer: reviewer.id, index });
        }
        const file = `receipts/${item.id}-${reviewer.id}-${index}-${phase}.json`;
        await writeJsonAtomic(join(options.out, file), { phase, page: item.id, reviewer, index, promptDigest: digest(prompt), images: await Promise.all(images.map(async i => ({ label: i.label, sha256: digest(await readFile(i.file)) }))), response, workerTimeMs }, true);
        model.phaseDigests[file] = digest(await readFile(join(options.out, file)));
        model.workerTimeMs += workerTimeMs;
        model.observedModels[reviewer.id] = [...new Set([...(model.observedModels[reviewer.id] ?? []), ...response.models])];
        await save();
      }
    }
  }
  model.completedAt = new Date().toISOString(); model.wallTimeMs = Date.parse(model.completedAt) - Date.parse(startedAt);
  const agreement = calibrationAgreement(set, humans, model);
  await writeJsonAtomic(join(options.out, 'calibration-model.json'), model, true);
  await writeJsonAtomic(join(options.out, 'calibration-agreement.json'), agreement, true);
  await writeJsonAtomic(join(options.out, 'calibration-review-template.json'), { reviewedBy: '', reviewedAt: '', agreementDigest: digest(JSON.stringify(agreement)), modelDigest: agreement.modelDigest, dispositions: Object.fromEntries([...agreement.disagreements, ...agreement.letterDisagreements, ...agreement.assessabilityDisagreements, ...agreement.reviewerDisagreements].map(gap => [gap.id, ''])) }, true);
  await writeFile(join(options.out, 'calibration-report.md'), renderCalibrationReport(agreement, model), { flag: 'wx', mode: 0o600 });
  return { model, agreement };
}
export function renderCalibrationReport(report: ReturnType<typeof calibrationAgreement>, model: CalibrationModel & { workerTimeMs: number; wallTimeMs: number; observedModels: Record<string, string[]>; incrementalCashUsd: 0 }) {
  return ['# Blind calibration report', '', `Mode: ${model.mode}. Raters: ${report.raterCount}. Two-letter investigation required: ${report.investigationRequired}. PRD acceptance claimed: false.`, '', report.uncertainty, '', `Judge wall time: ${(model.wallTimeMs / 1000).toFixed(1)} s. Judge worker time: ${(model.workerTimeMs / 1000).toFixed(1)} s. Incremental cash: $${model.incrementalCashUsd}; ${model.mode === 'stub' ? 'synthetic fixture' : 'subscription OAuth'}. Subscription load is not reported by both CLIs.`, '', ...model.reviewers.map(r => `Reviewer ${r.id}: requested ${r.model}; observed ${model.observedModels[r.id]?.join(', ') || 'unknown: identity not emitted by CLI'}.`), '',
    '| Criterion | Assessed | Exact | Within one | Mean absolute error |', '|---|---|---|---|---|', ...Object.entries(report.criterionAgreement).map(([id, s]) => `| ${id} | ${s.assessable} | ${s.exact} | ${s.withinOne} | ${s.meanAbsoluteError ?? 'not assessable'} |`), '',
    '## Criterion disagreements', '', ...report.disagreements.map(d => `- ${d.id}: human ${d.human}; pooled model median ${d.model}; delta ${d.delta}. Evidence is preserved in calibration-agreement.json.`), '',
    '## Assessability disagreements', '', ...report.assessabilityDisagreements.map(d => `- ${d.id}: human ${d.human ?? 'not assessable'}; model ${d.model ?? 'not assessable'}. Investigate.`), '',
    '## Reviewer agreement by criterion', '', ...Object.entries(report.reviewerCriterionAgreement).flatMap(([reviewer, criteria]) => Object.entries(criteria).map(([id, s]) => `- ${reviewer}/${id}: exact ${s.exact}/${s.assessable}; within one ${s.withinOne}; mean absolute error ${s.meanAbsoluteError ?? 'not assessable'}.`)), '',
    '## Reviewer disagreements', '', ...report.reviewerDisagreements.map(d => `- ${d.id}: reviewer median gap ${d.gap}; investigate.`), '',
    '## Letter disagreements', '', ...report.letterDisagreements.map(d => `- ${d.id}: human ${d.humanGrade}; ${d.reviewer} sample median ${d.modelGrade}; gap ${d.gap}${d.investigation ? '; investigate before freezing' : '; within the one-letter tolerance'}.`), '',
    'Per-reviewer medians, ranges, spreads, all sample letters, missing assessments and reviewer disagreement are preserved in calibration-agreement.json. Dispositions explain differences; they never overwrite human or model grades.', '',
    'A freeze requires explicit human review and a disposition for every disagreement. No calibration result accepts or deploys a draft.', ''].join('\n');
}

/** Reconstruct scores from immutable phase receipts before authorising a freeze. */
export async function verifyCompletedCalibration(out: string) {
  const input = JSON.parse(await readFile(join(out, 'calibration-input.json'), 'utf8')) as { set: CalibrationSet; humans: unknown[]; startedAt: string; mode: string };
  const model = JSON.parse(await readFile(join(out, 'calibration-model.json'), 'utf8')) as Awaited<ReturnType<typeof judgeCalibration>>['model'];
  const set = validateCalibrationSet(input.set);
  if (model.mode !== input.mode || model.startedAt !== input.startedAt || set.rubricDigest !== digest(JSON.stringify(AGENCY_BAR)) || set.protocolDigest !== REFERENCE_PROTOCOL_DIGEST || model.judgeProtocolDigest !== CALIBRATION_JUDGE_DIGEST || JSON.stringify(model.reviewers) !== JSON.stringify(reviewerSettings()) || !model.phaseDigests || Object.keys(model.phaseDigests).length !== set.items.length * 12) throw new Error('Freeze inputs or protocol changed');
  for (const item of set.items) {
    const expectedImages: Array<{ label: string; sha256: string }> = [];
    for (const image of item.screenshots) {
      const bytes = await readFile(join(out, 'images', `${item.id}-${image.width}-original.png`));
      if (digest(bytes) !== image.sha256) throw new Error('Frozen screenshot changed');
      for (const [index, tile] of imageTiles(bytes).entries()) expectedImages.push({ label: `${item.id} ${image.width}px; vertical tile ${index + 1}`, sha256: digest(tile) });
    }
    const samples: CalibrationModel['cases'][number]['samples'] = [];
    for (const reviewer of model.reviewers) for (let index = 0; index < SAMPLE_COUNT; index++) {
      let inventory: ReturnType<typeof parseInventory> | undefined;
      for (const phase of ['inventory', 'score'] as const) {
        const file = `receipts/${item.id}-${reviewer.id}-${index}-${phase}.json`;
        const bytes = await readFile(join(out, file));
        if (digest(bytes) !== model.phaseDigests[file]) throw new Error('Judge receipt changed');
        const receipt = JSON.parse(bytes.toString('utf8')) as { promptDigest: string; phase: string; page: string; reviewer: unknown; index: number; response: { judgment: unknown; models: string[]; receipt: { billingLane?: string; apiKeySource?: string; auth?: { authMethod?: string; subscriptionType?: string }; requestedModel?: string; serviceTier?: string } }; images: Array<{ label: string; sha256: string }> };
        if (receipt.phase !== phase || receipt.page !== item.id || receipt.index !== index || JSON.stringify(receipt.reviewer) !== JSON.stringify(reviewer)) throw new Error('Judge receipt identity changed');
        const provenance = receipt.response.receipt;
        if (model.mode === 'live' && (receipt.response.models.includes('stub') || reviewer.id === 'claude' && (!['none', 'oauth', 'claude.ai'].includes(provenance.apiKeySource ?? '') || provenance.auth?.authMethod !== 'claude.ai' || provenance.auth?.subscriptionType !== 'max') || reviewer.id === 'codex' && (provenance.billingLane !== 'subscription' || provenance.auth?.authMethod !== 'chatgpt' || provenance.requestedModel !== reviewer.model || provenance.serviceTier !== 'priority'))) throw new Error('Live subscription provenance missing');
        if (JSON.stringify(receipt.images) !== JSON.stringify(expectedImages)) throw new Error('Judge image coverage changed');
        if (receipt.promptDigest !== digest(calibrationPrompt(item, expectedImages.map(i => i.label), phase, inventory))) throw new Error('Judge prompt changed');
        if (model.mode === 'live' && reviewer.id === 'claude' && (!receipt.response.models.length || receipt.response.models.some(actual => actual !== reviewer.model && !(actual.startsWith(`${reviewer.model}-`) && /^\d{8}$/u.test(actual.slice(reviewer.model.length + 1)))))) throw new Error('Observed Claude model differs');
        if (phase === 'inventory') inventory = parseInventory(receipt.response.judgment);
        else {
          const judgment = parseScoredJudgment(receipt.response.judgment, AGENCY_BAR);
          validateScoredEvidence(judgment, item, inventory!);
          samples.push({ ...judgment, reviewer: reviewer.id, index });
        }
      }
    }
    if (JSON.stringify(model.cases.find(p => p.caseId === item.id)?.samples) !== JSON.stringify(samples)) throw new Error('Model scores differ from phase receipts');
  }
  const report = calibrationAgreement(set, input.humans, model);
  if (digest(JSON.stringify(JSON.parse(await readFile(join(out, 'calibration-agreement.json'), 'utf8')))) !== digest(JSON.stringify(report))) throw new Error('Agreement report changed');
  return { set, model, report };
}
