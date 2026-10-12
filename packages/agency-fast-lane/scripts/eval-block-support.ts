/** Live J4 judgment replay. Labels never enter a provider request; no oracle/stub accuracy. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { briefNeedsFaq, buildBlockSupportQuestions } from '../src/block-support.ts';
import { postSystemOne } from '../src/jev.ts';
import { validateChoiceAnswer } from '../src/route.ts';
import type { BlockCatalog } from '../src/block-plan.ts';

type AuditCase = { brief: string; true: string[]; X: string[]; spine: string[]; dir: string[] };
type Fixture = { labelling_rule: string; roles: string[]; cases: Record<string, AuditCase> };
type Question = { type: string; criteria: Record<string, string>; instructions: string };
type RawCall = { request: { model: string; state: Record<string, unknown>; questions: Record<string, unknown> }; response: Record<string, unknown>; ms: number };
type Result = { id: string; picker: Record<string, number>; support: Record<string, number>; calls: RawCall[] };
const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
if (!args.includes('--live') && !option('--replay')) throw new Error('Use --live for measured Jev accuracy, or --replay <saved-live-receipt>. Synthetic scores are not an eval.');
const thresholds = [Number(option('--threshold') ?? 0.8), Number(option('--compare-threshold') ?? 0.9)];
if (thresholds.some((value) => !Number.isFinite(value) || value < 0 || value > 1)) throw new Error('thresholds must be in [0, 1]');
const fixtures = option('--fixtures') ?? new URL('../tests/fixtures/block-support-cases.json', import.meta.url);
const questionPath = option('--questions') ?? new URL('../tests/fixtures/block-support-j4-questions.json', import.meta.url);
const fixtureText = await readFile(fixtures, 'utf8');
const questionText = await readFile(questionPath, 'utf8');
const fixture = JSON.parse(fixtureText) as Fixture;
const battery = JSON.parse(questionText) as Record<string, Question>;
const roles = ['logo_wall', 'faq', 'team', 'testimonials', 'blog_articles', 'timeline_roadmap', 'pricing', 'plan_comparison'];
if (JSON.stringify(fixture.roles) !== JSON.stringify(roles) || !fixture.labelling_rule || !fixture.cases || Object.keys(fixture.cases).length === 0) throw new Error('Expected original J4 cases/roles/label rule');
for (const [id, row] of Object.entries(fixture.cases)) {
  if (!id || typeof row.brief !== 'string' || !Array.isArray(row.true) || !Array.isArray(row.X) || [...row.true, ...row.X].some((role) => !roles.includes(role)) || new Set(row.true).size !== row.true.length || new Set(row.X).size !== row.X.length || row.true.some((role) => row.X.includes(role))) throw new Error('Invalid J4 labels');
}
for (const role of roles) if (battery[`block_${role}`]?.type !== 'choice') throw new Error(`Missing original J4 picker question: ${role}`);
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const provenance = { fixtureSha256: sha256(fixtureText), questionsSha256: sha256(questionText), labellingRule: fixture.labelling_rule };
// Judgment-only support seam: all audited roles have candidates, independent of spine coverage,
// section variant taste, seven-block capacity, and generated content. Same isolation as J4.
const kind = (role: string) => role.replaceAll('_', '-');
const catalog: BlockCatalog = { blocks: ['hero', 'features', ...roles.map(kind), 'cta-band'].map((sectionKind) => ({
  id: sectionKind, sectionKind, title: sectionKind, spineAffinities: 'any', useCases: [], tags: [],
})) };
const model = 'jev-1.13.0';
const timeoutMs = Number(option('--timeout-ms') ?? 60000);
if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeout-ms must be a positive integer');
let key: string | undefined;
async function request(state: Record<string, unknown>, questions: Record<string, unknown>): Promise<RawCall> {
  if (!key) throw new Error('Jev credential unavailable');
  const started = performance.now();
  const response = await postSystemOne({ endpoint: 'https://api.typesafe.ai/v1/systemone', model, timeoutMs, fetchImpl: fetch, key: async () => key!, state, questions });
  if (!response.ok) throw new Error(`Jev HTTP ${response.status}`);
  const body = JSON.parse(response.text) as Record<string, unknown>;
  return { request: { model, state, questions }, response: body, ms: Math.round(performance.now() - started) };
}
async function evaluate(id: string, row: AuditCase): Promise<Result> {
  const picked = await request({ brief: row.brief }, battery);
  const answers = picked.response.answers as Record<string, unknown>;
  const picker: Record<string, number> = {};
  for (const role of roles) {
    const checked = validateChoiceAnswer(answers?.[`block_${role}`], new Set(Object.keys(battery[`block_${role}`].criteria)));
    if ('reason' in checked) throw new Error(`case ${id}: malformed picker ${role}`);
    picker[role] = 1 - (checked.answer.probabilities.none ?? 0);
  }
  const plan = { spine: 'PA', directionId: 'judgment-only', blocks: ['hero', 'features', ...roles.filter((role) => picker[role] >= 0.5).map(kind), 'cta-band'] };
  const questions = buildBlockSupportQuestions(plan, catalog);
  const support: Record<string, number> = {};
  const calls = [picked];
  if (Object.keys(questions).length > 0) {
    const supported = await request({ brief: row.brief }, questions);
    calls.push(supported);
    const supportAnswers = supported.response.answers as Record<string, { type?: string; noul?: number }>;
    for (const question of Object.keys(questions)) {
      const answer = supportAnswers?.[question];
      if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1) throw new Error(`case ${id}: malformed support ${question}`);
      support[question.replace(/^support_/, '')] = answer.noul;
    }
  }
  console.error(`Completed ${id}: ${calls.length} live calls`);
  return { id, picker, support, calls };
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, item]) => [name, canonical(item)]));
  return value;
}
function validateReplay(row: Result) {
  const fixtureRow = fixture.cases[row.id];
  if (!fixtureRow || !row.picker || !row.support || !Array.isArray(row.calls)) throw new Error('Invalid replay case');
  const plan = { spine: 'PA', directionId: 'judgment-only', blocks: ['hero', 'features', ...roles.filter((role) => row.picker[role] >= 0.5).map(kind), 'cta-band'] };
  const supportQuestions = buildBlockSupportQuestions(plan, catalog);
  const expected = [battery, ...(Object.keys(supportQuestions).length ? [supportQuestions] : [])];
  if (row.calls.length !== expected.length) throw new Error('Replay call count differs from current question builder');
  for (const [index, questions] of expected.entries()) {
    const call = row.calls[index] as RawCall & { requestSha256?: string };
    const request = { model, state: { brief: fixtureRow.brief }, questions };
    const digest = sha256(JSON.stringify(canonical(request)));
    const savedDigest = call.requestSha256 ?? sha256(JSON.stringify(canonical(call.request)));
    if (digest !== savedDigest) throw new Error('Replay request differs from current builder; rerun --live');
    const answers = call.response.answers as Record<string, unknown>;
    if (index === 0) {
      for (const role of roles) {
        const checked = validateChoiceAnswer(answers?.[`block_${role}`], new Set(Object.keys(battery[`block_${role}`].criteria)));
        if ('reason' in checked || row.picker[role] !== 1 - (checked.answer.probabilities.none ?? 0)) throw new Error('Replay picker score differs from provider answer');
      }
    } else {
      for (const question of Object.keys(supportQuestions)) {
        const answer = answers?.[question] as { type?: string; noul?: number } | undefined;
        if (answer?.type !== 'noul' || typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1 || row.support[question.replace(/^support_/, '')] !== answer.noul) throw new Error('Replay support score missing or differs from provider answer');
      }
    }
  }
}
let results: Result[];
if (option('--replay')) {
  const saved = JSON.parse(await readFile(option('--replay')!, 'utf8'));
  if (saved.mode !== 'live' || saved.provenance?.fixtureSha256 !== provenance.fixtureSha256 || saved.provenance?.questionsSha256 !== provenance.questionsSha256) throw new Error('Replay must be a live receipt for these exact fixtures/questions');
  results = saved.results;
  if (!Array.isArray(results)) throw new Error('Replay is missing results');
  results.forEach(validateReplay);
} else {
  key = process.env.TYPESAFE_API_KEY;
  if (!key) {
    try { key = (await promisify(execFile)('zsvault', ['get', 'typesafe_api_key'], { timeout: 15000 })).stdout.trim(); }
    catch { throw new Error('TypeSafe credential unavailable from environment or ZS Vault'); }
  }
  const entries = Object.entries(fixture.cases);
  results = new Array(entries.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, entries.length) }, async () => {
    while (next < entries.length) {
      const at = next++;
      results[at] = await evaluate(...entries[at]);
    }
  }));
}
if (!Array.isArray(results) || results.length !== Object.keys(fixture.cases).length || new Set(results.map((row) => row.id)).size !== results.length || results.some((row) => !fixture.cases[row.id])) throw new Error('Incomplete or duplicate case results');
const counts = () => ({ tp: 0, fp: 0, tn: 0, fn: 0 });
const score = (totals: ReturnType<typeof counts>, expected: boolean, actual: boolean) => { totals[expected ? (actual ? 'tp' : 'fn') : (actual ? 'fp' : 'tn')] += 1; };
const metric = (totals: ReturnType<typeof counts>) => ({ ...totals, correct: totals.tp + totals.tn, total: totals.tp + totals.fp + totals.tn + totals.fn, accuracy: (totals.tp + totals.tn) / (totals.tp + totals.fp + totals.tn + totals.fn) });
const tables = thresholds.map((threshold) => {
  const before = counts(); const after = counts();
  const errors: Array<{ id: string; role: string; expected: boolean; before: boolean; after: boolean; support?: number }> = [];
  for (const result of results) {
    const row = fixture.cases[result.id];
    for (const role of roles) {
      if (row.X.includes(role)) continue;
      if (!Number.isFinite(result.picker[role])) throw new Error('Missing picker score');
      const baseline = result.picker[role] >= 0.5;
      const recovered = baseline || (role === 'faq' ? briefNeedsFaq(row.brief) : (result.support[role] ?? -1) >= threshold);
      const expected = row.true.includes(role);
      score(before, expected, baseline); score(after, expected, recovered);
      if (baseline !== expected || recovered !== expected) errors.push({ id: result.id, role, expected, before: baseline, after: recovered, ...(result.support[role] !== undefined ? { support: result.support[role] } : {}) });
    }
  }
  return { supportThreshold: threshold, pickerThreshold: 0.5, before: metric(before), after: metric(after), errors };
});
const output = { mode: option('--replay') ? 'replay' : 'live', evaluatedAt: new Date().toISOString(), model, provenance, cases: results.length,
  limitation: 'Original J4 judgment battery and labels; support uses production missing-role questions. Excludes ambiguous labels, catalog compatibility, seven-block capacity, rendering, and generation. Eval requests use a separate 60s per-call budget, not the production shared deadline.',
  calls: results.reduce((total, row) => total + row.calls.length, 0), tables, results };
if (option('--output')) await writeFile(option('--output')!, JSON.stringify(output, null, 2) + '\n');
console.log(JSON.stringify({ ...output, results: results.map(({ calls, ...row }) => ({ ...row, calls: calls.length })) }, null, 2));
