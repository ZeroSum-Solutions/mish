import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { client, digest } from './api.ts';
import { AGENCY_BAR } from './bar.ts';
import { BUILDER_IDS, builderFor, type BuilderId } from './builders/index.ts';
import { captureRun } from './capture.ts';
import { selectCases } from './cases.ts';
import { CODEX_JUDGE_MODEL } from './subscription.ts';
import { containsTerm, designOf, judgePair, literalTerms, PAIRWISE_JUDGE_MODEL, PAIRWISE_PROTOCOL_DIGEST, type Aspect, type Design, type PairJudge, type PairVerdict } from './pairwise.ts';
import { runBenchmark } from './run.ts';
import { assertWriterName, loadSavedBriefs, ORIGINAL, parseWriters, prepareBriefs, type BriefRecord, type WriterSpec } from './writers.ts';
import { verifyFiles } from './packet.ts';
import { writeJsonAtomic } from './storage.ts';
import type { BenchmarkRun, BriefCase, Captures, ReviewerId } from './types.ts';

export interface CompareOptions {
  daemon: string; out: string; agent: string; model: string; timeoutMs: number;
  /** `compare --writers`: inputs to build each case from, as `label` or `label=lane`. `original` is the request alone. */
  writers?: string[];
  /** `compare --build`: a previous compare output; its arms are rebuilt from the same frozen briefs and judged against it. */
  baseline?: string;
  /** Arms taken from existing packets instead of built (`writer -> arm packet dir`), verified before use. */
  reuse?: Record<string, string>;
  /** Continue an interrupted run in `out`: complete arms and saved verdicts are reused. */
  resume?: boolean;
  caseIds?: string; builder?: BuilderId;
  /** Builds per case and input. Pairs are judged within each rep; the report sums across reps. */
  reps?: number;
  /** Concurrent pair judgments (default 2). */
  judgeParallel?: number;
  /** Read briefs from `<dir>/<case>/<writer>.preview.json` instead of calling the writers. */
  briefsDir?: string;
  reviewers?: Array<{ id: ReviewerId; model: string }>;
  headers?: Record<string, string>; mode?: 'live' | 'stub'; pollMs?: number;
  /** Injected in tests; the default calls the subscription judges. */
  judge?: PairJudge;
}

interface ArmRecord { arm: string; writer: string; dir: string; source: 'built' | 'reused' | 'baseline'; runId: string; fixtureDigest: string; fingerprintDigest: string; builder: unknown; cases: Array<{ caseId: string; status: string; wallTimeMs: number; failures: string[]; previewSha256: string | null }> }
export interface CompareResult {
  schema: 'quality-compare/1'; mode: 'writers' | 'build'; createdAt: string;
  bar: { version: string }; pairwiseProtocolDigest: string; reps: number;
  /** Digest of everything that defines this comparison; a resumed run must match it. */
  configDigest: string;
  cases: Array<{ id: string; fixtureDigest: string }>;
  builder: string; buildModel: { agent: string; model: string };
  reviewers: Array<{ id: ReviewerId; model: string }>;
  writers: WriterSpec[];
  briefs: BriefRecord[]; arms: ArmRecord[];
  terms: Array<{ caseId: string; arm: string; entry: string | null; missing: string[] }>;
  verdicts: PairVerdict[];
  /** Pairs that could not be judged (a failed build or capture). Any entry makes the CLI exit 1. */
  missing: Array<{ caseId: string; arms: [string, string]; reason: string }>;
  /** Arm cases with no judgeable design, recorded even when the arm has no pair (a single-arm baseline). */
  unjudgeable: Array<{ caseId: string; arm: string; reason: string }>;
  baseline?: string;
  /** Set only after every arm was built or loaded, every pair judged and the report written. */
  completedAt?: string;
}

export const DEFAULT_REVIEWERS: Array<{ id: ReviewerId; model: string }> = [{ id: 'claude', model: PAIRWISE_JUDGE_MODEL }, { id: 'codex', model: CODEX_JUDGE_MODEL }];
const load = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T;
/** `root/...parts`, refusing anything that resolves outside `root`. */
function inside(root: string, ...parts: string[]): string {
  const base = resolve(root); const target = resolve(base, ...parts); const rel = relative(base, target);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path escapes ${root}: ${parts.join('/')}`);
  return target;
}
const exists = (file: string) => stat(file).then(() => true, () => false);

/**
 * A finished arm packet: run and captures verified byte for byte, built from exactly these cases, and,
 * when briefs are known, from exactly these briefs.
 */
async function loadArm(dir: string, cases: BriefCase[], writer: string, briefDigest: (caseId: string) => string | null | undefined, expected?: { runId: string; fingerprintDigest: string }): Promise<{ run: BenchmarkRun; captures: Captures }> {
  const run = await load<BenchmarkRun>(join(dir, 'run.json'));
  const captures = await load<Captures>(join(dir, 'captures.json'));
  await verifyFiles(dir, run, captures);
  if (expected && (run.runId !== expected.runId || run.fingerprint.digest !== expected.fingerprintDigest)) throw new Error(`Arm ${dir} is not the run its compare recorded`);
  if (run.fixtureDigest !== digest(JSON.stringify(cases))) throw new Error(`Arm ${dir} was built from different cases`);
  if (run.cases.length !== cases.length) throw new Error(`Arm ${dir} does not cover every case`);
  for (const item of run.cases) {
    // The input is part of the verified fingerprint, so editing it in run.json alone is caught.
    const pinned = run.fingerprint.cases.find(c => c.caseId === item.caseId)?.input;
    if (!item.input || !pinned || JSON.stringify(pinned) !== JSON.stringify(item.input)) throw new Error(`Arm ${dir} has no fingerprinted compare input for ${item.caseId}`);
    if (item.input.writer !== writer) throw new Error(`Arm ${dir} was built by writer ${item.input.writer}, not ${writer}`);
    if ((writer === ORIGINAL) !== (item.input.previewSha256 === null)) throw new Error(`Arm ${dir} input does not match writer ${writer} for ${item.caseId}`);
    const want = briefDigest(item.caseId);
    if (want !== undefined && item.input.previewSha256 !== want) throw new Error(`Arm ${dir} was built from a different ${writer} brief for ${item.caseId}`);
  }
  return { run, captures };
}

/** Runs `work` on up to `limit` items at a time; after the first failure no new item starts, and that failure is thrown once the running ones settle. */
async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  let failure: { error: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length && !failure) { try { await work(queue.shift()!); } catch (error) { failure ??= { error }; } }
  }));
  if (failure) throw failure.error;
}

/**
 * Mode B. `writers`: build every case once per writer and rep (`original` = the request alone)
 * through chat-run, or reuse verified arm packets, then judge every pair of designs blind in both
 * orders. `baseline`: rebuild each of a previous compare's arms on the current code from its frozen
 * briefs, with its builder, and judge each new design against the verified stored one.
 */
export async function compare(options: CompareOptions): Promise<CompareResult> {
  if (!options.writers?.length === !options.baseline) throw new Error('Pass --writers or --build, not both');
  const reviewers = options.reviewers ?? DEFAULT_REVIEWERS;
  const baseline = options.baseline ? await load<CompareResult>(join(options.baseline, 'compare.json')) : undefined;
  if (baseline && baseline.schema !== 'quality-compare/1') throw new Error('Unsupported baseline');
  if (baseline && !baseline.completedAt) throw new Error('The baseline compare did not finish; finish it with --resume first');
  const caseIds = options.caseIds ?? baseline?.cases.map(c => c.id).join(',');
  const cases = selectCases(caseIds, undefined, 'dev', 'improve-prompt');
  if (baseline) for (const c of baseline.cases) if (cases.find(x => x.id === c.id) && digest(JSON.stringify(cases.find(x => x.id === c.id))) !== c.fixtureDigest) throw new Error(`Case ${c.id} changed since the baseline`);
  const writers = baseline ? parseWriters(baseline.writers.map(w => `${w.label}=${w.lane}`)) : parseWriters(options.writers!);
  if (baseline && options.builder && options.builder !== baseline.builder) throw new Error('--build reuses the baseline builder');
  const builder = (baseline?.builder ?? options.builder ?? 'chat-run') as BuilderId;
  if (!(BUILDER_IDS as readonly string[]).includes(builder)) throw new Error(`Unknown builder ${builder}`);
  if (builder !== 'chat-run' && writers.some(w => w.label !== ORIGINAL)) throw new Error(`${builder} takes no Improve prompt brief; compare writers through chat-run`);
  // A chat-run comparison needs two inputs; another builder's single `original` arm is a baseline for --build.
  if (!baseline && writers.length < (builder === 'chat-run' ? 2 : 1)) throw new Error('Name at least two distinct writers');
  const reps = baseline ? 1 : options.reps ?? 1;
  if (!Number.isSafeInteger(reps) || reps < 1 || reps > 5) throw new Error('--reps must be 1 to 5');
  const reuse = options.reuse ?? {};
  for (const name of Object.keys(reuse)) if (!writers.some(w => w.label === name)) throw new Error(`--reuse names unknown writer ${name}`);
  if (Object.keys(reuse).length && reps !== 1) throw new Error('--reuse supports one rep');
  if (baseline) for (const stored of baseline.arms.filter(a => a.source !== 'baseline')) { assertWriterName(stored.arm); if (stored.dir !== `arms/${stored.arm}`) throw new Error(`Baseline arm ${stored.arm} has an unexpected folder`); }

  const judgeParallel = options.judgeParallel ?? 2;
  if (!Number.isSafeInteger(judgeParallel) || judgeParallel < 1 || judgeParallel > 8) throw new Error('--judge-parallel must be 1 to 8');
  const configDigest = digest(JSON.stringify({ fixture: digest(JSON.stringify(cases)), writers, reps, builder, reviewers, reuse, baseline: options.baseline ?? null, buildModel: [options.agent, options.model], mode: options.mode ?? 'live', daemon: options.daemon, bar: AGENCY_BAR.version, protocol: PAIRWISE_PROTOCOL_DIGEST }));
  const resumed = options.resume && await exists(join(options.out, 'compare.json')) ? await load<CompareResult>(join(options.out, 'compare.json')) : undefined;
  if (resumed && resumed.configDigest !== configDigest) throw new Error('This output was started with different settings; use a new --out');
  if (!resumed) { await mkdir(options.out); await mkdir(join(options.out, 'arms')); }
  const api = client(options.daemon, options.headers ?? {}, options.timeoutMs);

  // Briefs: only for arms this run builds. Reused arms bring their own; build mode replays the baseline's.
  const toBuild = writers.filter(w => !reuse[w.label]);
  let previews: Map<string, unknown>; let records: BriefRecord[];
  if (resumed) { records = resumed.briefs; previews = await loadSavedBriefs(options.out, records); }
  else ({ previews, records } = await prepareBriefs(api, cases, toBuild, options.out, options.briefsDir ?? (baseline ? join(options.baseline!, 'briefs') : undefined)));
  if (baseline) for (const r of records) { const stored = baseline.briefs.find(b => b.caseId === r.caseId && b.writer === r.writer); if (!stored || stored.sha256 !== r.sha256) throw new Error(`Brief ${r.caseId}/${r.writer} differs from the baseline's`); }
  const briefDigest = (writer: string) => (caseId: string) => writer === ORIGINAL ? null : records.find(r => r.caseId === caseId && r.writer === writer)?.sha256;

  const { completedAt: _previous, ...resumedResult } = resumed ?? {} as CompareResult;
  const result: CompareResult = resumed ? { ...resumedResult, arms: [], terms: [], verdicts: [], missing: [], unjudgeable: [] } : {
    schema: 'quality-compare/1', mode: baseline ? 'build' : 'writers', createdAt: new Date().toISOString(),
    bar: { version: AGENCY_BAR.version }, pairwiseProtocolDigest: PAIRWISE_PROTOCOL_DIGEST, reps, configDigest,
    cases: cases.map(c => ({ id: c.id, fixtureDigest: digest(JSON.stringify(c)) })), builder, buildModel: { agent: options.agent, model: options.model },
    reviewers, writers, briefs: records, arms: [], terms: [], verdicts: [], missing: [], unjudgeable: [], ...(options.baseline ? { baseline: options.baseline } : {}),
  };
  // Saves are serialized and atomic, so concurrent judges never leave a torn checkpoint.
  let saving = Promise.resolve();
  const save = () => (saving = saving.then(() => writeJsonAtomic(join(options.out, 'compare.json'), result)));
  await save();

  const designs = new Map<string, Design>();
  const recordArm = async (arm: string, writer: string, source: ArmRecord['source'], dir: string, run: BenchmarkRun, captures: Captures) => {
    result.arms.push({ arm, writer, source, dir: relative(options.out, dir), runId: run.runId, fixtureDigest: run.fixtureDigest, fingerprintDigest: run.fingerprint.digest, builder: run.fingerprint.builder ?? { id: 'build-on-brand' },
      cases: run.cases.map(c => ({ caseId: c.caseId, status: c.status, wallTimeMs: Math.round(c.wallTimeMs), failures: c.failures, previewSha256: c.input?.previewSha256 ?? null })) });
    for (const item of cases) {
      const design = await designOf(arm, dir, run, captures, item.id);
      if (design) designs.set(`${item.id}/${arm}`, design);
      else result.unjudgeable.push({ caseId: item.id, arm, reason: 'No succeeded build with full 1440 and 390 captures of an entry page' });
      result.terms.push({ caseId: item.id, arm, entry: design?.entry ?? null, missing: design ? literalTerms(item.brief).filter(term => !containsTerm(design.text, term)) : [] });
    }
    await save();
  };
  /** Builds an arm, or on resume reuses it when it finished; a half-built arm must be removed first. */
  const buildOrResume = async (arm: string, writer: string) => {
    const dir = inside(join(options.out, 'arms'), arm);
    if (resumed && await exists(join(dir, 'captures.json'))) { const done = await loadArm(dir, cases, writer, briefDigest(writer)); return { dir, ...done }; }
    if (await exists(dir)) throw new Error(`Arm ${arm} did not finish; remove ${dir} to rebuild it`);
    const run = await runBenchmark({
      daemon: options.daemon, out: dir, agent: options.agent, model: options.model, timeoutMs: options.timeoutMs, mode: options.mode ?? 'live',
      ...(options.pollMs ? { pollMs: options.pollMs } : {}), headers: options.headers ?? {},
      builder: builderFor(builder), suite: 'improve-prompt', caseId: cases.map(c => c.id).join(','),
      inputFor: item => {
        if (writer === ORIGINAL) return { writer, preview: null };
        const preview = previews.get(`${item.id}/${writer}`);
        if (!preview) throw new Error(`No ${writer} brief for ${item.id}`);
        return { writer, preview };
      },
    });
    return { dir, run, captures: await captureRun(dir, run) };
  };
  const armName = (writer: string, rep: number) => reps === 1 ? writer : `${writer}-r${rep}`;
  if (baseline) {
    for (const stored of baseline.arms.filter(a => a.source !== 'baseline')) {
      const built = await buildOrResume(`current-${stored.arm}`, stored.writer);
      await recordArm(`current-${stored.arm}`, stored.writer, 'built', built.dir, built.run, built.captures);
      const dir = inside(options.baseline!, stored.dir);
      const kept = await loadArm(dir, cases, stored.writer, briefDigest(stored.writer), { runId: stored.runId, fingerprintDigest: stored.fingerprintDigest });
      await recordArm(`baseline-${stored.arm}`, stored.writer, 'baseline', dir, kept.run, kept.captures);
    }
  } else for (let rep = 1; rep <= reps; rep++) for (const writer of writers) {
    const arm = armName(writer.label, rep);
    if (reuse[writer.label]) {
      const dir = resolve(reuse[writer.label]!);
      const kept = await loadArm(dir, cases, writer.label, () => undefined);
      await recordArm(arm, writer.label, 'reused', dir, kept.run, kept.captures);
    } else {
      const built = await buildOrResume(arm, writer.label);
      await recordArm(arm, writer.label, 'built', built.dir, built.run, built.captures);
    }
  }

  // Judge: every pair of writers per case within each rep, or each current arm against its stored arm.
  const pairs: Array<[string, string]> = baseline
    ? baseline.arms.filter(a => a.source !== 'baseline').map(a => [`baseline-${a.arm}`, `current-${a.arm}`] as [string, string])
    : Array.from({ length: reps }, (_, r) => writers.flatMap((a, i) => writers.slice(i + 1).map(b => [armName(a.label, r + 1), armName(b.label, r + 1)] as [string, string]))).flat();
  const jobs: Array<{ item: BriefCase; a: Design; b: Design; reviewer: { id: ReviewerId; model: string } }> = [];
  for (const item of cases) for (const [a, b] of pairs) {
    const da = designs.get(`${item.id}/${a}`); const db = designs.get(`${item.id}/${b}`);
    if (!da || !db) { result.missing.push({ caseId: item.id, arms: [a, b], reason: `No judged page for ${[!da ? a : null, !db ? b : null].filter(Boolean).join(' and ')}: build or capture failed` }); continue; }
    for (const reviewer of reviewers) jobs.push({ item, a: da, b: db, reviewer });
  }
  await save();
  await mapLimit(jobs, judgeParallel, async ({ item, a, b, reviewer }) => {
    result.verdicts.push(await judgePair({ out: options.out, item, a, b, reviewer: reviewer.id, model: reviewer.model, timeoutMs: options.timeoutMs, ...(options.judge ? { judge: options.judge } : {}) }));
    await save();
  });
  const order = (v: PairVerdict) => `${cases.findIndex(c => c.id === v.caseId)}|${pairs.findIndex(p => p[0] === v.arms[0] && p[1] === v.arms[1])}|${reviewers.findIndex(r => r.id === v.reviewer)}`;
  result.verdicts.sort((x, y) => order(x).localeCompare(order(y), undefined, { numeric: true }));
  await save();
  await writeReport(options.out, result, cases, designs);
  result.completedAt = new Date().toISOString();
  await save();
  return result;
}

/**
 * Wins, losses, ties and unsettled verdicts for one column (a writer in writers mode, summed over its
 * reps; `baseline`/`current` in build mode), for one reviewer or all, on one aspect.
 */
export function record(verdicts: PairVerdict[], column: string, aspect: Aspect, columnOf: (arm: string) => string, reviewer?: ReviewerId) {
  const mine = verdicts.filter(v => v.arms.some(arm => columnOf(arm) === column) && (!reviewer || v.reviewer === reviewer));
  const outcome = (v: PairVerdict) => ['tie', 'unsettled'].includes(v[aspect]) ? v[aspect] : columnOf(v[aspect]);
  return {
    wins: mine.filter(v => outcome(v) === column).length,
    losses: mine.filter(v => !['tie', 'unsettled', column].includes(outcome(v))).length,
    ties: mine.filter(v => v[aspect] === 'tie').length,
    unsettled: mine.filter(v => v[aspect] === 'unsettled').length,
  };
}
const fmt = (r: ReturnType<typeof record>) => `${r.wins}–${r.losses}–${r.ties}${r.unsettled ? ` (${r.unsettled}?)` : ''}`;
const escape = (value: string) => value.replace(/[&<>"]/gu, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

async function writeReport(out: string, result: CompareResult, cases: BriefCase[], designs: Map<string, Design>) {
  const arms = result.arms.map(a => a.arm);
  const writerOf = new Map(result.arms.map(a => [a.arm, a.writer]));
  const columnOf = (arm: string) => result.mode === 'build' ? arm.split('-')[0]! : writerOf.get(arm) ?? arm;
  const columns = [...new Set(arms.map(columnOf))];
  const settledPairs = new Map<string, Map<ReviewerId, string>>();
  for (const v of result.verdicts) { const key = `${v.caseId}/${v.arms.join('/')}`; if (!settledPairs.has(key)) settledPairs.set(key, new Map()); settledPairs.get(key)!.set(v.reviewer, v.overall); }
  const both = [...settledPairs.values()].filter(m => m.size === 2 && [...m.values()].every(x => x !== 'unsettled'));
  const agree = both.filter(m => new Set(m.values()).size === 1).length;
  const lines = [
    `# Quality compare — ${result.mode === 'writers' ? 'Improve prompt writers' : 'build against baseline'} (${result.createdAt})`, '',
    result.reps === 1 ? '**Single rep:** one build per case and input. Read margins as direction, not proof.' : `**${result.reps} reps** per case and input; pairs are judged within a rep and summed here.`, '',
    `- Bar: ${result.bar.version}. Pairwise protocol ${result.pairwiseProtocolDigest.slice(0, 12)}.`,
    `- Builder: ${result.builder}, building with ${result.buildModel.agent} / ${result.buildModel.model}.`,
    `- Judges: ${result.reviewers.map(r => `${r.id} ${r.model}`).join(', ')}. Each saw "Design 1/2" only, in both orders; a verdict counts only when both orders agree.`,
    `- Cases: ${result.cases.map(c => `${c.id} (${c.fixtureDigest.slice(0, 12)})`).join(', ')}.`,
    ...(result.baseline ? [`- Baseline: ${result.baseline}.`] : []), '',
    '## Pairwise record (wins–losses–ties; unsettled in parentheses)', '',
    `| | ${columns.join(' | ')} |`, `|---|${columns.map(() => '---').join('|')}|`,
    ...result.reviewers.map(r => `| Overall — ${r.id} | ${columns.map(c => fmt(record(result.verdicts, c, 'overall', columnOf, r.id))).join(' | ')} |`),
    `| Fidelity — all judges | ${columns.map(c => fmt(record(result.verdicts, c, 'fidelity', columnOf))).join(' | ')} |`,
    `| Visual — all judges | ${columns.map(c => fmt(record(result.verdicts, c, 'visual', columnOf))).join(' | ')} |`, '',
    `The judges named the same overall result on ${agree}/${both.length} pairs that both settled.`, '',
    '## Exact terms from the request missing from the entry page source (markup and CSS)', '',
    `| Case | ${arms.join(' | ')} |`, `|---|${arms.map(() => '---').join('|')}|`,
    ...cases.map(c => `| ${c.id} | ${arms.map(a => { const t = result.terms.find(x => x.caseId === c.id && x.arm === a); return !t?.entry ? 'no page' : t.missing.length ? t.missing.join(', ') : '—'; }).join(' | ')} |`), '',
    ...(result.missing.length || result.unjudgeable.length ? ['## Not judged', '', ...result.unjudgeable.map(m => `- ${m.caseId} / ${m.arm}: ${m.reason}`), ...result.missing.map(m => `- ${m.caseId}: ${m.arms.join(' vs ')}: ${m.reason}`), ''] : []),
    '## Builds', '',
    ...result.arms.flatMap(a => a.cases.map(c => `- ${c.caseId} / ${a.arm} (${a.source}): ${c.status}, ${(c.wallTimeMs / 60000).toFixed(1)} min${c.failures.length ? `; ${c.failures.join('; ')}` : ''}`)), '',
    '## Briefs', '',
    ...(result.briefs.length ? result.briefs.map(b => `- ${b.caseId} / ${b.writer}${b.lane !== b.writer ? ` (lane ${b.lane})` : ''}: ${b.source}${b.transformMs !== null ? `, transform ${(b.transformMs / 1000).toFixed(1)} s` : ''}, ${b.sha256.slice(0, 12)}`) : ['- None built here: arms used the request alone or were reused with their own briefs.']),
    '', 'The brief preview does not report which model wrote it, so a writer that fell back to Claude is not visible here; check the daemon log for `[brief] … fell back`.', '',
  ];
  await writeFile(join(out, 'compare-report.md'), `${lines.join('\n')}\n`);

  // Blind gallery: designs per case in a fixed shuffled order, inputs hidden until revealed.
  const sections = cases.map(item => {
    const shown = arms.map(arm => designs.get(`${item.id}/${arm}`)).filter((d): d is Design => !!d)
      .sort((x, y) => digest(`${item.id}/${x.arm}`).localeCompare(digest(`${item.id}/${y.arm}`)));
    return `<section><h2>${escape(item.id)}</h2><p class="req">${escape(item.brief)}</p><div class="grid">${shown.map((d, i) => `<figure><figcaption>Design ${String.fromCharCode(65 + i)} <span class="arm">${escape(d.arm)}</span></figcaption><div class="shots"><img loading="lazy" src="${escape(relative(out, d.desktop))}" alt="Design ${String.fromCharCode(65 + i)} at 1440 wide"><img loading="lazy" class="phone" src="${escape(relative(out, d.phone))}" alt="Design ${String.fromCharCode(65 + i)} at 390 wide"></div></figure>`).join('')}</div></section>`;
  }).join('');
  await writeFile(join(out, 'gallery.html'), `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Quality compare gallery</title><style>
:root{--bg:#f6f5f2;--fg:#1d1c1a;--muted:#6b6862;--card:#fff;--line:#e2dfd8}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#a19e97;--card:#1f1e1c;--line:#34322e}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}main{max-width:1400px;margin:auto}
.req{color:var(--muted);max-width:80ch}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}
figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px}.shots{display:flex;gap:8px;align-items:flex-start}
.shots img{width:72%;height:auto;border:1px solid var(--line)}.shots img.phone{width:26%}.arm{display:none;color:var(--muted)}body.reveal .arm{display:inline}
button{font:inherit;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer}
</style></head><body><main><h1>Quality compare gallery</h1><p>Rank the designs for each case before you reveal which input built them. Single rep.</p><button onclick="document.body.classList.toggle('reveal')">Reveal / hide inputs</button>${sections}</main></body></html>`);
}
