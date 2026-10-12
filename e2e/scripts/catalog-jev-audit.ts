/** Text-only Jev review of observed browser evidence. Never treats a score as visual acceptance. */
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

interface Observation { id: string; width: number; status?: number; text?: string; overflow?: number; errors?: string[]; failedResources?: string[]; brokenImages?: string[]; clippedText?: string[]; wrappedButtons?: string[]; headings?: unknown[]; buttons?: string[]; visibleElements?: number; messages?: unknown[]; error?: string; }
const label = process.argv[2] ?? 'before';
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid audit label');
const root = resolve(process.cwd(), '../.tmp/catalog-audit');
const data = JSON.parse(await readFile(resolve(root, 'live', label, 'audit.json'), 'utf8')) as { itemCount: number; completedItems: number; results: Observation[] };
const pilot = process.argv.includes('--pilot');
if (!pilot && data.completedItems !== data.itemCount) throw new Error('Browser audit is incomplete');
const groups = new Map<string, Observation[]>();
for (const result of data.results) groups.set(result.id, [...groups.get(result.id) ?? [], result]);
const entries = [...groups.entries()].filter(([, observations]) => observations.length === 2);
const selected = pilot ? entries.slice(0, 4) : entries;
const catalog = JSON.parse(await readFile(resolve(process.cwd(), '../packages/cult-ui-catalog/catalog.json'), 'utf8')) as { rows: Array<{ id: string; name: string; derivedFrom?: string }> };
const slugs = (JSON.parse(await readFile(resolve(process.cwd(), '../packages/cult-ui-catalog/generated/slugs.json'), 'utf8')) as { items: Record<string, string> }).items;
const sourceRows = new Map(catalog.rows.map(row => [`cult:${slugs[row.id]}`, row]));
const sourceHints = new Map<string, unknown>();
// Optional caller-supplied private kit: read only short class declarations, never env files.
const kit = process.env.CULT_KIT_DIR;
if (kit) for (const [id] of selected) {
  const row = sourceRows.get(id);
  if (!row) continue;
  const name = row.derivedFrom?.slice(5) ?? row.name;
  try {
    const registry = JSON.parse(await readFile(resolve(kit, 'registry', `${name}.json`), 'utf8')) as { files: Array<{ path: string; content: string }> };
    const files = registry.files.filter(file => /\.(tsx|css)$/.test(file.path) && (!row.derivedFrom || file.path.endsWith(`/sections/${row.name.split('--')[1]}.tsx`)));
    const snippets = files.flatMap(file => file.content.split('\n').filter(line => /className=|transition-all|prefers-reduced-motion|background-clip/.test(line)).map(line => line.trim().slice(0, 280))).slice(0, 4);
    sourceHints.set(id, { registryName: name, sourceFiles: files.map(file => file.path), authoredStyleSnippets: snippets, limitation: 'Short authored style snippets only. They are not computed pixel appearance and do not establish a visual defect.' });
  } catch { sourceHints.set(id, { unavailable: true }); }
}
const key = process.env.TYPESAFE_API_KEY ?? execFileSync('zsvault', ['get', 'typesafe_api_key'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
if (!key) throw new Error('TypeSafe credential unavailable');
const file = resolve(root, `inventory-audit-jev-${label}${pilot ? '-pilot' : ''}.json`);
const prior = process.argv.includes('--resume') ? JSON.parse(await readFile(file, 'utf8')) as { batches: Array<Record<string, unknown>>; decisions: Array<Record<string, unknown>> } : { batches: [], decisions: [] };
const batches = prior.batches;
const decisions = prior.decisions;
const completedIds = new Set(decisions.map(decision => decision.id));
const pending = selected.filter(([id]) => !completedIds.has(id));
for (let start = 0; start < pending.length; start += 8) {
  const chunk = pending.slice(start, start + 8);
  const state: Record<string, unknown> = { scope: 'Observed rendered DOM and runtime data, no screenshot/image input. These are source-library demos, so demonstrative sample records, deliberate shaders and artistic motion are legitimate. Judge only evidence provided; do not infer visual polish, contrast, actual pixel appearance, or provider functionality.' };
  const questions: Record<string, unknown> = {};
  chunk.forEach(([id, observations], index) => {
    const name = `item_${index}`;
    state[name] = { id, observations: observations.map(observation => ({ width: observation.width, status: observation.status, text: observation.text, overflow: observation.overflow, errors: observation.errors, error: observation.error, visibleElements: observation.visibleElements, clippedText: observation.clippedText?.slice(0, 10), wrappedButtons: observation.wrappedButtons?.slice(0, 10), headings: observation.headings?.slice(0, 8), buttons: observation.buttons?.slice(0, 12), failedResourceCount: observation.failedResources?.length ?? 0, failedResources: observation.failedResources?.slice(0, 3), messages: observation.messages, brokenImageCount: observation.brokenImages?.length ?? 0, brokenImages: observation.brokenImages?.slice(0, 3) })), sourceHints: sourceHints.get(id) };
    questions[`${name}_runtime_defect`] = { type: 'noul', instructions: `Does \`${name}\` contain evidence of a user-visible runtime or layout defect at either observed viewport?`, criteria: { true: 'Runtime errors, HTTP errors, broken media, empty painted content, horizontal overflow above 2px, or meaningful unreachable text clipped beyond viewport. Readiness alone is insufficient for visual quality.', false: 'Both observations are populated, no errors or broken media, no significant horizontal overflow. Tiny graphical controls need not contain prose. clippedText may include intentional horizontal example strips, scrolling spreadsheet headers or exiting ticker/carousel content; alone it is only triage, not proof. Wrapping may reflect SVG/control geometry, so wrappedButtons alone is also triage.' } };
    questions[`${name}_copy_slop`] = { type: 'noul', instructions: `Does the rendered text in \`${name}\` contain unmistakable generic AI copy clutter that harms this particular demo?`, criteria: { true: 'Multiple gratuitous marketing claims, vague hype, repeated filler headings, or empty instructional word salad unrelated to demonstrated component. Evaluate actual copy only.', false: 'Specific useful component labels, sample task data, compact demonstration copy, component-dependent marketing examples, or insufficient text to establish an anti-pattern. Source fidelity should not be rejected for intentionally demonstrating a legitimate component pattern.' } };
    questions[`${name}_quality_evidence`] = { type: 'choice', instructions: `What can the text-only browser observations of \`${name}\` establish about quality?`, criteria: { defect_observed: 'A concrete runtime, missing-content, media, overflow or clipping defect appears.', rendered_no_structural_defect: 'Both views rendered and no concrete structural defect was measured. This is not proof of visual polish, source fidelity, contrast or interaction quality.', insufficient_observation: 'The frame did not supply enough observable content/runtime evidence to establish rendering.' } };
  });
  const begun = Date.now();
  const response = await fetch('https://api.typesafe.ai/v1/systemone', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'jev-1.13.0', state, questions }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const body = await response.json() as { model: string; answers: Record<string, { type: string; noul?: number; choice?: string; confidence?: number }>; usage: { input_tokens: number; output_tokens: number } };
  chunk.forEach(([id], index) => {
    const prefix = `item_${index}`;
    const runtime = body.answers[`${prefix}_runtime_defect`], copy = body.answers[`${prefix}_copy_slop`], quality = body.answers[`${prefix}_quality_evidence`];
    if (runtime?.type !== 'noul' || typeof runtime.noul !== 'number' || copy?.type !== 'noul' || typeof copy.noul !== 'number' || quality?.type !== 'choice' || typeof quality.choice !== 'string') throw new Error('Invalid Jev answer');
    decisions.push({ id, runtimeDefectProbability: runtime.noul, copySlopProbability: copy.noul, qualityEvidence: quality.choice, qualityConfidence: quality.confidence });
  });
  batches.push({ model: body.model, ms: Date.now() - begun, items: chunk.map(([id]) => id), usage: body.usage });
  const inputTokens = batches.reduce((sum, batch) => sum + Number((batch.usage as { input_tokens: number }).input_tokens), 0);
  await writeFile(file, JSON.stringify({ at: new Date().toISOString(), label, scope: 'Text-only observed DOM/runtime and copy review. No image input, no visual ship grade, no external provider integration proof.', source: resolve(root, 'live', label, 'audit.json'), model: body.model, pricingReference: 'https://docs.typesafe.ai/models', inputTokens, estimatedUsd: inputTokens * 0.042 / 1_000_000, batches, decisions }, null, 2));
  console.log(JSON.stringify({ reviewed: decisions.length, total: selected.length, inputTokens, estimatedUsd: inputTokens * 0.042 / 1_000_000, file }));
}
