import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { expect, test } from 'vitest';
import { agencyBuild } from '../../benchmarks/quality/builders/agency-build.ts';
import { selectCases } from '../../benchmarks/quality/cases.ts';
import { compare, record } from '../../benchmarks/quality/compare.ts';
import { containsTerm, literalTerms, settle, type OrderedVerdict, type PairJudge } from '../../benchmarks/quality/pairwise.ts';
import { runBenchmark } from '../../benchmarks/quality/run.ts';
import { client } from '../../benchmarks/quality/api.ts';
import { prepareBriefs, parseWriters } from '../../benchmarks/quality/writers.ts';
import { startStub } from '../../benchmarks/quality/stub.ts';

/** Prefers whichever design the named arm built; blind judges never see arm names, this fake does. */
const prefer = (arm: string): PairJudge => async ({ first, second }) => ({
  judgment: { overall: first.arm.startsWith(arm) ? '1' : second.arm.startsWith(arm) ? '2' : 'tie', fidelity: 'tie', visual: first.arm.startsWith(arm) ? '1' : second.arm.startsWith(arm) ? '2' : 'tie', reasons: 'Synthetic judge.' },
  models: ['stub'], receipt: { billingLane: 'stub' },
});
const options = (daemon: string, out: string) => ({ daemon, out, agent: 'stub', model: 'stub', timeoutMs: 60_000, pollMs: 5, mode: 'stub' as const });

test('improve-prompt cases are their own suite; agency selection and digests are unchanged', () => {
  expect(selectCases().map(c => c.id)).toEqual(['dental', 'restaurant', 'law', 'saas', 'fitness', 'brightwater']);
  const improve = selectCases(undefined, undefined, 'dev', 'improve-prompt');
  expect(improve.map(c => c.id)).toEqual(['bakery-preorder', 'saas-invoicing', 'win95-portfolio', 'clinic-access', 'warehouse-dashboard']);
  for (const item of improve) { expect(item.questions?.length).toBeGreaterThan(0); expect(item.omittedFacts.length).toBeGreaterThan(0); }
  expect(selectCases('bakery-preorder,clinic-access').map(c => c.id)).toEqual(['bakery-preorder', 'clinic-access']);
  expect(() => selectCases('bakery-preorder,nope')).toThrow(/unknown case/i);
});

test('a verdict counts only when both orders name the same design', () => {
  const v = (first: string, second: string, overall: OrderedVerdict['overall']): OrderedVerdict => ({ reviewer: 'claude', model: 'm', first, second, overall, fidelity: 'tie', visual: 'tie', reasons: 'r', receipt: 'x' });
  expect(settle(v('a', 'b', '1'), v('b', 'a', '2'), 'overall')).toBe('a');
  expect(settle(v('a', 'b', '1'), v('b', 'a', '1'), 'overall')).toBe('unsettled');
  expect(settle(v('a', 'b', 'tie'), v('b', 'a', 'tie'), 'overall')).toBe('tie');
});

test('exact terms match whole tokens only', () => {
  expect(literalTerms('Use Fraunces and Inter. Built with Vue 3 for 1080p.')).toEqual(expect.arrayContaining(['Fraunces', 'Inter', 'Vue', '3', '1080p']));
  expect(containsTerm('smooth interactions', 'Inter')).toBe(false);
  expect(containsTerm('Body set in Inter.', 'Inter')).toBe(true);
});

test('compare --writers builds each input through chat-run, judges every pair in both orders and restores the writer setting', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-compare-'));
  try {
    const out = join(root, 'writers');
    const result = await compare({ ...options(stub.url, out), writers: ['original', 'claude', 'terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }, { id: 'codex', model: 'gpt-6.1-sol' }], judge: prefer('terra') });
    expect(result.arms.map(a => a.arm)).toEqual(['original', 'claude', 'terra']);
    expect(result.arms.flatMap(a => a.cases.map(c => c.status))).toEqual(['succeeded', 'succeeded', 'succeeded']);
    // The brief each arm attached is the one the writer produced, by digest.
    for (const writer of ['claude', 'terra']) expect(result.arms.find(a => a.writer === writer)!.cases[0]!.previewSha256).toBe(result.briefs.find(b => b.writer === writer)!.sha256);
    expect(result.arms.find(a => a.writer === 'original')!.cases[0]!.previewSha256).toBeNull();
    const runs = stub.requests.filter(r => r.path === '/api/runs' && r.method === 'POST').map(r => r.body as { brief?: unknown });
    expect(runs.filter(r => r.brief).length).toBe(2);
    // Three pairs, two reviewers; terra wins every settled verdict.
    expect(result.verdicts).toHaveLength(6);
    expect(record(result.verdicts, 'terra', 'overall', arm => arm)).toEqual({ wins: 4, losses: 0, ties: 0, unsettled: 0 });
    expect(record(result.verdicts, 'original', 'overall', arm => arm)).toEqual({ wins: 0, losses: 2, ties: 2, unsettled: 0 });
    // The isolated runtime's writer setting is put back.
    const puts = stub.requests.filter(r => r.path === '/api/app-config' && r.method === 'PUT').map(r => (r.body as { improvePromptTransformer: unknown }).improvePromptTransformer);
    expect(puts).toEqual(['claude', 'terra', null]);
    const report = await readFile(join(out, 'compare-report.md'), 'utf8');
    expect(report).toContain('Single rep');
    expect(report).toMatch(/agency-bar\//u);
    const gallery = await readFile(join(out, 'gallery.html'), 'utf8');
    expect(gallery).toContain('Reveal / hide inputs');
    expect(await readFile(join(out, 'briefs', 'bakery-preorder', 'terra.preview.json'), 'utf8')).toContain('stub writer terra');

    // A rerun from frozen briefs calls no writer; --build judges each stored arm against its rebuild.
    const before = stub.requests.length;
    const frozen = await compare({ ...options(stub.url, join(root, 'frozen')), writers: ['claude', 'terra'], caseIds: 'bakery-preorder', briefsDir: join(out, 'briefs'), reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    expect(stub.requests.slice(before).some(r => r.path === '/api/workbench/briefs/preview' || r.path === '/api/app-config')).toBe(false);
    expect(frozen.briefs.every(b => b.source === 'frozen')).toBe(true);
    const rebuilt = await compare({ ...options(stub.url, join(root, 'build')), baseline: out, reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('current') });
    expect(rebuilt.mode).toBe('build');
    expect(rebuilt.verdicts.map(v => v.arms)).toEqual([['baseline-original', 'current-original'], ['baseline-claude', 'current-claude'], ['baseline-terra', 'current-terra']]);
    expect(record(rebuilt.verdicts, 'current', 'overall', arm => arm.split('-')[0]!)).toMatchObject({ wins: 3, losses: 0 });
  } finally { await stub.close(); }
}, 240_000);

test('reps build each input more than once and judge pairs within a rep', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-reps-'));
  try {
    const result = await compare({ ...options(stub.url, join(root, 'reps')), writers: ['original', 'terra'], caseIds: 'clinic-access', reps: 2, reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    expect(result.arms.map(a => a.arm)).toEqual(['original-r1', 'terra-r1', 'original-r2', 'terra-r2']);
    expect(result.verdicts.map(v => v.arms)).toEqual([['original-r1', 'terra-r1'], ['original-r2', 'terra-r2']]);
    const writerOf = (arm: string) => arm.replace(/-r\d+$/u, '');
    expect(record(result.verdicts, 'terra', 'overall', writerOf)).toMatchObject({ wins: 2 });
    expect(await readFile(join(root, 'reps', 'compare-report.md'), 'utf8')).toContain('2 reps');
  } finally { await stub.close(); }
}, 240_000);

test('agency-build saves the published project and records the observed fill model as the builder', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-agency-'));
  try {
    const run = await runBenchmark({ ...options(stub.url, join(root, 'agency')), caseId: 'dental', builder: agencyBuild() });
    expect(run.cases[0]).toMatchObject({ status: 'succeeded', target: { entry: 'index.html' } });
    expect(run.fingerprint.builder).toEqual({ id: 'agency-build', options: { family: 'auto', verify: 'strict' } });
    expect(run.fingerprint.cases[0]!.builder).toMatchObject({ status: 'available', value: { agent: 'agency:deepseek', model: 'stub-fill' } });
    await expect(compare({ ...options(stub.url, join(root, 'bad')), writers: ['original', 'terra'], builder: 'agency-build', caseIds: 'bakery-preorder' })).rejects.toThrow(/takes no Improve prompt brief/);
  } finally { await stub.close(); }
});

test('writer names may not collide with outcomes or build-mode prefixes, and a label can name its lane', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-names-'));
  try {
    for (const bad of ['tie', 'unsettled', 'baseline-x', '../x', 'A'])
      await expect(compare({ ...options(stub.url, join(root, bad.replace(/\W/gu, '_'))), writers: ['original', bad], caseIds: 'bakery-preorder' })).rejects.toThrow(/Invalid writer/);
    const result = await compare({ ...options(stub.url, join(root, 'lanes')), writers: ['terra', 'terra-plus=terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra-plus') });
    expect(result.briefs.map(b => [b.writer, b.lane])).toEqual([['terra', 'terra'], ['terra-plus', 'terra']]);
    expect(result.verdicts[0]!.overall).toBe('terra-plus');
  } finally { await stub.close(); }
}, 120_000);

test('an invalid frozen brief stops before any build', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-invalid-'));
  try {
    const briefs = join(root, 'briefs', 'bakery-preorder');
    await import('node:fs/promises').then(fs => fs.mkdir(briefs, { recursive: true }));
    await writeFile(join(briefs, 'claude.preview.json'), 'null');
    await expect(compare({ ...options(stub.url, join(root, 'out')), writers: ['original', 'claude'], caseIds: 'bakery-preorder', briefsDir: join(root, 'briefs') })).rejects.toThrow(/Invalid brief preview/);
    expect(stub.requests.some(r => r.path === '/api/runs')).toBe(false);
  } finally { await stub.close(); }
});

test('failed builds are reported as pairs not judged, not as a clean comparison', async () => {
  const stub = await startStub({ chatStatus: 'failed' });
  const root = await mkdtemp(join(tmpdir(), 'quality-missing-'));
  try {
    const result = await compare({ ...options(stub.url, join(root, 'out')), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    expect(result.verdicts).toHaveLength(0);
    expect(result.missing).toEqual([{ caseId: 'bakery-preorder', arms: ['original', 'terra'], reason: expect.stringMatching(/build or capture failed/) }]);
    expect(await readFile(join(root, 'out', 'compare-report.md'), 'utf8')).toContain('## Not judged');
  } finally { await stub.close(); }
}, 120_000);

test('an interrupted run resumes without rebuilding, and verified arms can be reused', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-resume-'));
  try {
    const out = join(root, 'out');
    let calls = 0;
    const flaky: PairJudge = async input => { calls += 1; if (calls === 2) throw new Error('judge interrupted'); return prefer('terra')(input); };
    const run = { ...options(stub.url, out), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude' as const, model: 'claude-opus-5-5' }], judgeParallel: 1 };
    await expect(compare({ ...run, judge: flaky })).rejects.toThrow(/judge interrupted/);
    const builds = stub.requests.filter(r => r.path === '/api/runs' && r.method === 'POST').length;
    await expect(compare({ ...run, judge: prefer('terra') })).rejects.toThrow(/EEXIST/);
    const resumed = await compare({ ...run, resume: true, judge: prefer('terra') });
    expect(stub.requests.filter(r => r.path === '/api/runs' && r.method === 'POST').length).toBe(builds);
    expect(resumed.verdicts).toHaveLength(1);
    expect(resumed.verdicts[0]!.overall).toBe('terra');
    // A different setting cannot resume this output.
    await expect(compare({ ...run, writers: ['original', 'claude'], resume: true, judge: prefer('terra') })).rejects.toThrow(/different settings/);

    const reused = await compare({ ...options(stub.url, join(root, 'reuse')), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reuse: { original: join(out, 'arms', 'original') }, reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    expect(reused.arms.map(a => [a.arm, a.source])).toEqual([['original', 'reused'], ['terra', 'built']]);
    // A tampered reused arm is refused.
    const page = join(out, 'arms', 'original', 'cases', 'bakery-preorder', 'files', 'landing.html');
    await writeFile(page, `${await readFile(page, 'utf8')} `);
    await expect(compare({ ...options(stub.url, join(root, 'tampered')), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reuse: { original: join(out, 'arms', 'original') }, judge: prefer('terra') })).rejects.toThrow(/Saved artifact changed/);
  } finally { await stub.close(); }
}, 240_000);

test('--build refuses an escaping, tampered or drifted baseline and rebuilds with the baseline builder', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-baseline-'));
  try {
    const base = join(root, 'base');
    await compare({ ...options(stub.url, base), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    const meta = JSON.parse(await readFile(join(base, 'compare.json'), 'utf8')) as { arms: Array<{ arm: string; dir: string }> };
    const edit = async (change: (m: typeof meta) => void) => { const copy = structuredClone(meta); change(copy); await writeFile(join(base, 'compare.json'), JSON.stringify(copy)); };
    await edit(m => { m.arms[0]!.dir = '../../escaped'; });
    await expect(compare({ ...options(stub.url, join(root, 'b1')), baseline: base, judge: prefer('current') })).rejects.toThrow(/unexpected folder/);
    await edit(m => { m.arms[0]!.arm = 'x/../../escaped'; m.arms[0]!.dir = 'arms/x/../../escaped'; });
    await expect(compare({ ...options(stub.url, join(root, 'b2')), baseline: base, judge: prefer('current') })).rejects.toThrow(/Invalid writer or arm name/);
    await edit(() => {});
    const brief = join(base, 'briefs', 'bakery-preorder', 'terra.preview.json');
    const original = await readFile(brief, 'utf8');
    await writeFile(brief, original.replace('Synthetic value', 'Changed value'));
    await expect(compare({ ...options(stub.url, join(root, 'b3')), baseline: base, judge: prefer('current') })).rejects.toThrow(/differs from the baseline/);
    await writeFile(brief, original);

    const agencyBase = join(root, 'agency-base');
    const first = await compare({ ...options(stub.url, agencyBase), writers: ['original'], builder: 'agency-build', caseIds: 'bakery-preorder' });
    expect(first.verdicts).toHaveLength(0);
    const before = stub.requests.filter(r => r.path === '/api/agency/build').length;
    const rebuilt = await compare({ ...options(stub.url, join(root, 'agency-rebuilt')), baseline: agencyBase, reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('current') });
    expect(stub.requests.filter(r => r.path === '/api/agency/build').length).toBe(before + 1);
    expect(rebuilt.builder).toBe('agency-build');
    expect(rebuilt.verdicts.map(v => v.arms)).toEqual([['baseline-original', 'current-original']]);
  } finally { await stub.close(); }
}, 300_000);

test('SIGINT during writer generation stops the loop and restores the setting last', async () => {
  const stub = await startStub({ previewDelayMs: 300 });
  const root = await mkdtemp(join(tmpdir(), 'quality-sigint-'));
  try {
    const killed: string[] = [];
    const signals = new EventEmitter();
    const run = prepareBriefs(client(stub.url, {}, 10_000), selectCases('bakery-preorder,clinic-access'), parseWriters(['claude', 'terra']), root, undefined, { kill: signal => killed.push(signal), signals });
    await new Promise(resolve => setTimeout(resolve, 100));
    signals.emit('SIGINT', 'SIGINT');
    await expect(run).rejects.toThrow(/Interrupted by SIGINT/);
    const puts = stub.requests.filter(r => r.path === '/api/app-config' && r.method === 'PUT').map(r => (r.body as { improvePromptTransformer: unknown }).improvePromptTransformer);
    expect(puts).toEqual(['claude', null]);
    expect(killed).toEqual(['SIGINT']);
    expect(JSON.parse(await readFile(join(root, 'writer-setting.json'), 'utf8'))).toEqual({ saved: null, restored: true });
  } finally { await stub.close(); }
});

test('reused and baseline arms must carry their fingerprinted input and recorded identity; bad settings are refused', async () => {
  const stub = await startStub();
  const root = await mkdtemp(join(tmpdir(), 'quality-identity-'));
  try {
    const grade = await runBenchmark({ ...options(stub.url, join(root, 'grade')), caseId: 'bakery-preorder', suite: 'improve-prompt' });
    expect(grade.cases[0]!.input).toBeUndefined();
    const { captureRun } = await import('../../benchmarks/quality/capture.ts');
    await captureRun(join(root, 'grade'), grade);
    await expect(compare({ ...options(stub.url, join(root, 'r1')), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reuse: { terra: join(root, 'grade') } })).rejects.toThrow(/no fingerprinted compare input/);
    await expect(compare({ ...options(stub.url, join(root, 'r2')), writers: ['original', 'terra'], caseIds: 'bakery-preorder', judgeParallel: Number.NaN })).rejects.toThrow(/judge-parallel/);

    const base = join(root, 'base');
    await compare({ ...options(stub.url, base), writers: ['original', 'terra'], caseIds: 'bakery-preorder', reviewers: [{ id: 'claude', model: 'claude-opus-5-5' }], judge: prefer('terra') });
    const meta = JSON.parse(await readFile(join(base, 'compare.json'), 'utf8')) as { writers: Array<{ label: string; lane: string }>; arms: Array<{ runId: string }> };
    const saved = JSON.stringify(meta);
    meta.writers[1]!.label = '../../../escaped';
    await writeFile(join(base, 'compare.json'), JSON.stringify(meta));
    await expect(compare({ ...options(stub.url, join(root, 'b1')), baseline: base, judge: prefer('current') })).rejects.toThrow(/Invalid writer or arm name/);
    const unfinished = JSON.parse(saved) as Record<string, unknown>; delete unfinished.completedAt;
    await writeFile(join(base, 'compare.json'), JSON.stringify(unfinished));
    await expect(compare({ ...options(stub.url, join(root, 'b0')), baseline: base, judge: prefer('current') })).rejects.toThrow(/did not finish/);
    const swapped = JSON.parse(saved) as typeof meta; swapped.arms[0]!.runId = 'another-run';
    await writeFile(join(base, 'compare.json'), JSON.stringify(swapped));
    await expect(compare({ ...options(stub.url, join(root, 'b2')), baseline: base, judge: prefer('current') })).rejects.toThrow(/not the run its compare recorded/);
  } finally { await stub.close(); }
}, 240_000);

test('a single-arm agency baseline with no judgeable page is reported, not passed', async () => {
  const stub = await startStub({ agencyWithoutPages: true });
  const root = await mkdtemp(join(tmpdir(), 'quality-single-'));
  try {
    const result = await compare({ ...options(stub.url, join(root, 'out')), writers: ['original'], builder: 'agency-build', caseIds: 'bakery-preorder', judge: prefer('x') });
    expect(result.verdicts).toEqual([]);
    expect(result.unjudgeable).toEqual([{ caseId: 'bakery-preorder', arm: 'original', reason: expect.any(String) }]);
  } finally { await stub.close(); }
}, 120_000);

