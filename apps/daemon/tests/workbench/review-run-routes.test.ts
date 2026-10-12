import { readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReviewRunView } from '@mish/contracts';
import { ReviewRunError } from '../../src/workbench/review/run-service.js';
import { parseReviewRunList } from '@mish/contracts';
import { ReviewerCallError } from '../../src/workbench/review/reviewers/types.js';
import { knownGoodCapture, page, unavailablePort } from './review-capture-fixture.js';
import { bootReviewRuns, concurrency, fakeReviewer, PNG_BASE64, sha256 } from './review-run-fixture.js';
import { consoleRecord } from '../../src/workbench/review/page-text.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function boot(options: Parameters<typeof bootReviewRuns>[0] = {}) {
  const daemon = await bootReviewRuns(options);
  cleanups.push(async () => { await daemon.close(); if (!options.dataDir) await rm(daemon.data, { recursive: true, force: true }); });
  return daemon;
}
const allThree = () => ({ 'jev-text': fakeReviewer('jev-text', { probability: 0.93 }), 'claude-visual': fakeReviewer('claude-visual', { refs: 'screenshots' }), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial', { refs: ['environment-missing', 'core.text-contrast-320'] }) });

async function snapshotTree(root: string): Promise<Record<string, string>> {
  const files = await readdir(root, { recursive: true });
  const out: Record<string, string> = {};
  for (const file of files.map(String).sort()) { try { out[file] = sha256(await readFile(path.join(root, file))); } catch { out[file] = 'dir'; } }
  return out;
}

describe('R03 collect-review runs at the HTTP boundary', () => {
  it.each(['review-store-degraded', 'review-store-unavailable'])('transmits %s as the public error code', async code => {
    const daemon = await boot();
    vi.spyOn(daemon.runs, 'start').mockRejectedValueOnce(new ReviewRunError(409, code, 'Storage needs recovery'));
    const response = await daemon.start({});
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code, details: { reason: code } } });
  });

  it('exposes reconciliation status in the typed list and individual read endpoints', async () => {
    const daemon = await boot();
    const started = parseReviewRunView(await (await daemon.start({})).json());
    await daemon.runs.idle();
    const status = { state: 'degraded' as const, failedRunIds: ['rr_bad'] };
    const probe = vi.spyOn(daemon.runs, 'reconciliationStatus').mockReturnValue(status);
    const response = await fetch(`${daemon.url}/api/workbench/projects/p/reviews`);
    expect(parseReviewRunList(await response.json()).reconciliation).toEqual(status);
    expect(probe).toHaveBeenCalledWith('p');
    probe.mockRestore();
    expect(parseReviewRunView(await daemon.show(started.run.id)).reconciliation).toEqual({ state: 'ready', failedRunIds: [] });
  });

  it('AC-R03.1: freezes revision, scope, rubric, source versions, plan, reviewer ids and evidence; newer changes mark it outdated', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const before = await snapshotTree(daemon.root);
    const response = await daemon.start({ snapshot: { entry: 'index.html', versionId: 'v2' } });
    expect(response.status).toBe(202);
    const started = parseReviewRunView(await response.json());
    await daemon.runs.idle();
    const { run, freshness } = await daemon.show(started.run.id);

    const entryDigest = sha256(await readFile(path.join(daemon.root, 'index.html')));
    expect(run.frozen.snapshot).toEqual({ entry: 'index.html', versionId: 'v2', contentDigest: entryDigest });
    expect(run.frozen.scope).toEqual({ kind: 'all' });
    expect(run.frozen.rubricRevision).toBe(2);
    expect(run.frozen.sourceHashes).toEqual([{ path: 'index.html', sha256: entryDigest }]);
    // The rubric's own judgment first, then the seeded judgments and behavior-triggered checklist judgments (B5-1, AC-R06.3/R06.5).
    expect(run.frozen.plan.judgmentCheckIds[0]).toBe('win95-style');
    expect(run.frozen.plan.judgmentCheckIds).toEqual(expect.arrayContaining(['judgment.hierarchy', 'judgment.goal-fit', 'dsc.field-errors']));
    expect(run.frozen.plan.mechanicalCheckIds).toContain('core.text-contrast');
    expect(run.frozen.plan.reviewers).toEqual([{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }, { role: 'deepseek-adversarial', required: true }, { role: 'gemini-second-family', required: false }]);
    expect(run.frozen.reviewerModelIds).toEqual([{ role: 'jev-text', modelId: 'jev-text-model' }, { role: 'claude-visual', modelId: 'claude-visual-model' }, { role: 'deepseek-adversarial', modelId: 'deepseek-adversarial-model' }, { role: 'gemini-second-family', modelId: 'gemini-3.8-flash' }]);
    expect(run.bundleId).toMatch(/^rv_/u);
    expect(run.screenshotEvidenceIds).toEqual(['screenshot-320', 'screenshot-375', 'screenshot-768', 'screenshot-1440']);
    expect(run.operation).toMatchObject({ kind: 'collect-review', status: 'done', stage: 'finished', attempt: 1 });
    expect(run.outcome).toBe('passed');
    expect(run.completedIndependentReviewers).toBe(3);
    expect(freshness).toEqual({ state: 'current', reasons: [] });

    // AC-R03.2: claims link evidence or are judgments; unknown refs are dropped.
    const claude = run.findings.find(finding => finding.reviewerRole === 'claude-visual' && finding.checkId === 'win95-style')!;
    expect(claude).toMatchObject({ kind: 'evidence-linked', evidenceRefs: ['screenshot-320', 'screenshot-375', 'screenshot-768', 'screenshot-1440'] });
    const jev = run.findings.find(finding => finding.reviewerRole === 'jev-text')!;
    expect(jev).toMatchObject({ kind: 'judgment', probability: 0.93, evidenceRefs: [] });
    expect(run.findings.filter(finding => finding.reviewerRole === 'deepseek-adversarial').every(finding => finding.evidenceRefs.every(ref => ref !== 'environment-missing'))).toBe(true);
    const shots = await readdir(path.join(daemon.data, 'workbench-review', 'runs'), { recursive: true });
    expect(shots.map(String).filter(file => file.endsWith('.png'))).toHaveLength(4);

    // AC-R03.3: review does not edit or publish the project.
    expect(await snapshotTree(daemon.root)).toEqual(before);

    await writeFile(path.join(daemon.root, 'index.html'), '<!doctype html><title>Changed</title>');
    const changed = await daemon.show(run.id);
    expect(changed.freshness.state).toBe('outdated');
    expect(changed.freshness.reasons).toContain('index.html changed since the review');
    daemon.state.rubric = { ...daemon.state.rubric!, revision: 3 };
    expect((await daemon.show(run.id)).freshness.reasons).toContain('The rubric is now at revision 3 (reviewed 2)');
  });

  it('AC-R03.1: selects a saved revision and a scope; refuses unknown revisions, stale revisions, out-of-rubric scope and Grok', async () => {
    const daemon = await boot({ reviewers: allThree() });
    expect((await daemon.start({ snapshot: { entry: 'index.html', versionId: 'missing' } })).status).toBe(404);
    const stale = await daemon.start({ snapshot: { entry: 'index.html', versionId: 'v1' } });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ error: { details: { reason: 'revision-not-current' } } });
    expect((await daemon.start({ rubricRevision: 1 })).status).toBe(409);

    const outside = await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style', 'nope'] } });
    expect(outside.status).toBe(422);
    expect(await outside.json()).toMatchObject({ error: { details: { fields: [{ path: 'scope.checkIds.1' }] } } });

    const grok = await daemon.start({ reviewerPlan: { reviewers: [{ role: 'grok-architecture', required: true }] } });
    expect(grok.status).toBe(422);
    expect((await grok.json() as { error: { message: string } }).error.message).toMatch(/implementation review only/u);

    const scoped = await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] } });
    expect(scoped.status).toBe(202);
    await daemon.runs.idle();
    const view = await daemon.show(parseReviewRunView(await scoped.json()).run.id);
    expect(view.run.reviewers.every(reviewer => reviewer.assignedCheckIds.join() === 'win95-style')).toBe(true);
    // Scope narrows what reviewers judge; mandatory mechanical checks still run.
    expect(view.run.frozen.plan.mechanicalCheckIds.length).toBeGreaterThanOrEqual(6);
  });

  it('requires an Idempotency-Key, replays an equal request and refuses a reused key', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const noKey = await fetch(`${daemon.url}/api/workbench/reviews`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p', snapshot: {}, rubricRevision: 2 }) });
    expect(noKey.status).toBe(400);
    const first = parseReviewRunView(await (await daemon.start({}, 'same')).json());
    const replay = parseReviewRunView(await (await daemon.start({}, 'same')).json());
    expect(replay.run.id).toBe(first.run.id);
    expect((await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] } }, 'same')).status).toBe(409);
    await daemon.runs.idle();
  });

  it('AC-R03.2: two of three reviewers close multi-model scope; one alone is inconclusive with the count', async () => {
    const two = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial'), 'claude-visual': fakeReviewer('claude-visual', { error: new ReviewerCallError('CLI missing', 'Install Claude Code') }) } });
    const optionalClaude = { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }, { role: 'claude-visual', required: false }] } };
    const passed = parseReviewRunView(await (await two.start(optionalClaude)).json());
    await two.runs.idle();
    const done = (await two.show(passed.run.id)).run;
    expect(done.completedIndependentReviewers).toBe(2);
    expect(done.outcome).toBe('passed');
    expect(done.reviewers.find(reviewer => reviewer.role === 'claude-visual')).toMatchObject({ status: 'failed', reason: 'CLI missing', recovery: 'Install Claude Code' });

    const one = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial', { unavailable: true }) } });
    const plan = { reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: false }] } };
    const started = parseReviewRunView(await (await one.start(plan)).json());
    await one.runs.idle();
    const run = (await one.show(started.run.id)).run;
    expect(run.completedIndependentReviewers).toBe(1);
    expect(run.outcome).toBe('inconclusive');
    expect(run.reasons).toContainEqual({ code: 'fewer-than-two-independent-reviewers', message: 'Fewer than two independent reviewers completed (1)' });
    expect(run.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial')).toMatchObject({ status: 'skipped', reason: 'deepseek-adversarial has no key', recovery: 'Add the deepseek-adversarial key in Settings' });
  });

  it('AC-R03.2: a missing required reviewer leaves its assigned checks incomplete even when two others completed', async () => {
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    const started = parseReviewRunView(await (await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] } })).json());
    await daemon.runs.idle();
    const run = (await daemon.show(started.run.id)).run;
    expect(run.completedIndependentReviewers).toBe(2);
    expect(run.outcome).toBe('inconclusive');
    expect(run.incompleteCheckIds).toEqual(['win95-style']);
    expect(run.reasons.map(reason => reason.code)).toEqual(['required-reviewer-incomplete']);
    expect(run.reviewers.find(reviewer => reviewer.role === 'claude-visual')).toMatchObject({ status: 'skipped', modelId: 'claude-opus-5-5', recovery: expect.stringMatching(/deselect/u) });
  });

  it('AC-R03.3: a confirmed mandatory failure is failed whatever the votes; missing mandatory evidence is inconclusive', async () => {
    const reviewers = { 'jev-text': fakeReviewer('jev-text', { probability: 0.99 }), 'claude-visual': fakeReviewer('claude-visual'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') };
    const failing = await boot({ reviewers, capture: width => knownGoodCapture(width, capture => { capture.console.push(consoleRecord({ kind: 'console', text: page('boom'), source: null })); capture.screenshotPng = PNG_BASE64; }) });
    const started = parseReviewRunView(await (await failing.start({})).json());
    await failing.runs.idle();
    const run = (await failing.show(started.run.id)).run;
    expect(run.findings.some(finding => finding.checkId === 'core.console-resources' && finding.verdict === 'supports' && finding.probability === 0.99)).toBe(true);
    expect(run.outcome).toBe('failed');
    expect(run.reasons[0]?.code).toBe('mandatory-check-failed');

    const blind = await boot({ reviewers: allThree(), port: () => unavailablePort() });
    const second = parseReviewRunView(await (await blind.start({})).json());
    await blind.runs.idle();
    const missing = (await blind.show(second.run.id)).run;
    expect(missing.outcome).toBe('inconclusive');
    expect(missing.reasons.map(reason => reason.code)).toContain('mandatory-evidence-missing');
  });

  it('AC-R03.4: cancel keeps completed evidence, exposes partial status, and never runs more than two model calls at once', async () => {
    concurrency.max = 0;
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'claude-visual': fakeReviewer('claude-visual', { gate: new Promise(() => undefined) }), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    const started = parseReviewRunView(await (await daemon.start({})).json());
    for (let i = 0; i < 100; i++) {
      const { run } = await daemon.show(started.run.id);
      if (run.reviewers.filter(reviewer => reviewer.status === 'completed').length === 2) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    expect(await daemon.cli(['cancel', '--project', 'p', '--run', started.run.id, '--json'])).toBe(0);
    const cancelled = parseReviewRunView(daemon.output.pop());
    expect(cancelled.run.operation).toMatchObject({ status: 'interrupted', interruptReason: 'user-cancelled', cancelRequested: true });
    expect(cancelled.run.reviewers.filter(reviewer => reviewer.status === 'completed').map(reviewer => reviewer.role).sort()).toEqual(['deepseek-adversarial', 'jev-text']);
    expect(cancelled.run.reviewers.find(reviewer => reviewer.role === 'claude-visual')).toMatchObject({ status: 'cancelled', recovery: expect.stringMatching(/completed evidence is kept/u) });
    expect(cancelled.run.findings.length).toBeGreaterThan(0);
    expect(cancelled.run.bundleId).toMatch(/^rv_/u);
    expect(cancelled.run.outcome).toBe('inconclusive');
    expect(cancelled.run.reasons.map(reason => reason.code)).toContain('run-interrupted');
    expect(concurrency.max).toBeLessThanOrEqual(2);
    expect((await fetch(`${daemon.url}/api/workbench/reviews/${started.run.id}/cancel?projectId=p`, { method: 'POST' })).status).toBe(409);
  });

  it('AC-R03.4: a daemon restart reconciles an abandoned run as interrupted and keeps its completed evidence', async () => {
    const first = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'claude-visual': fakeReviewer('claude-visual', { gate: new Promise(() => undefined) }), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial', { gate: new Promise(() => undefined) }) } });
    const started = parseReviewRunView(await (await first.start({})).json());
    for (let i = 0; i < 100; i++) {
      if ((await first.show(started.run.id)).run.reviewers.some(reviewer => reviewer.status === 'completed')) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const second = await boot({ dataDir: first.data, reviewers: allThree() });
    const { run } = await second.show(started.run.id);
    expect(run.operation).toMatchObject({ status: 'interrupted', interruptReason: 'daemon-restart' });
    expect(run.reviewers.find(reviewer => reviewer.role === 'jev-text')?.status).toBe('completed');
    expect(run.reviewers.filter(reviewer => reviewer.status === 'cancelled').map(reviewer => reviewer.role).sort()).toEqual(['claude-visual', 'deepseek-adversarial', 'gemini-second-family']);
    expect(run.outcome).toBe('inconclusive');
  });

  it('od CLI parity: start --wait, show and runs use the same endpoints and DTOs', async () => {
    const daemon = await boot({ reviewers: allThree() });
    const input = JSON.stringify({ snapshot: { entry: 'index.html' }, scope: { kind: 'all' }, rubricRevision: 2 });
    expect(await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--wait', '--json'], input)).toBe(0);
    const view = parseReviewRunView(daemon.output.pop());
    expect(view.run.outcome).toBe('passed');
    expect(await daemon.cli(['show', '--project', 'p', '--run', view.run.id, '--json'])).toBe(0);
    expect(parseReviewRunView(daemon.output.pop())).toEqual(await daemon.show(view.run.id));
    expect(await daemon.cli(['runs', '--project', 'p', '--json'])).toBe(0);
    expect(daemon.output.pop()).toMatchObject({ projectId: 'p', runs: [{ id: view.run.id, status: 'done', outcome: 'passed' }] });
    expect(await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--json'], JSON.stringify({ rubricRevision: 2, snapshot: {}, reviewerPlan: { reviewers: [{ role: 'grok', required: true }] } }))).toBe(2);
    expect(await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--json'], JSON.stringify({ projectId: 'q', rubricRevision: 2, snapshot: {} }))).toBe(2);
  });

  it('J4-01: `start` resolves an omitted snapshot.entry from the project’s last review run, not the contract’s hardcoded index.html default', async () => {
    const daemon = await boot({ reviewers: allThree() });
    await writeFile(path.join(daemon.root, 'other.html'), '<!doctype html><title>Other</title>');
    const first = parseReviewRunView(await (await daemon.start({ snapshot: { entry: 'other.html' } })).json());
    expect(first.run.frozen.snapshot.entry).toBe('other.html');
    await daemon.runs.idle();

    // No `snapshot` at all in the input file — the historical behavior would
    // silently freeze `index.html` here (the contract schema's own default),
    // even though this project's page is `other.html`.
    const input = JSON.stringify({ scope: { kind: 'all' }, rubricRevision: 2 });
    expect(await daemon.cli(['start', '--project', 'p', '--input-file', '-', '--json'], input)).toBe(0);
    const second = parseReviewRunView(daemon.output.pop());
    expect(second.run.frozen.snapshot.entry).toBe('other.html');
    await daemon.runs.idle();
  });
});
