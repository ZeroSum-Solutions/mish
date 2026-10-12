// Review-feedback red specs for R03 collect-review runs: the frozen record must
// match the evidence, cancel must stop work and keep what was captured, a
// partial reviewer is not a full one, and paid calls are bounded.
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReviewRunView } from '@mish/contracts';
import { knownGoodCapture, page } from './review-capture-fixture.js';
import { bootReviewRuns, fakeReviewer, PNG_BASE64 } from './review-run-fixture.js';
import { consoleRecord } from '../../src/workbench/review/page-text.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
async function boot(options: Parameters<typeof bootReviewRuns>[0] = {}) {
  const daemon = await bootReviewRuns(options);
  cleanups.push(async () => { await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); });
  return daemon;
}
const deferred = () => { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; };
const until = async (check: () => Promise<boolean> | boolean) => { for (let i = 0; i < 200; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 10)); } throw new Error('condition not reached'); };

/** A capture that blocks while `hold` is set, so a review queues behind U1's single browser job. */
function holdingCapture() {
  const state = { hold: null as Promise<void> | null, entered: 0 };
  const capture = async (width: number) => {
    state.entered++;
    if (state.hold) await state.hold;
    return knownGoodCapture(width, item => { item.served = [{ path: 'index.html', sha256: 'pending' }]; item.screenshotPng = PNG_BASE64; });
  };
  return { state, capture };
}

describe('R03 freeze integrity (AC-R03.1)', () => {
  it('a review that waited behind another browser job while the entry changed is superseded, and no reviewer is called', async () => {
    const { state, capture } = holdingCapture();
    const jev = fakeReviewer('jev-text'); const deepseek = fakeReviewer('deepseek-adversarial');
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': deepseek }, capture });
    const gate = deferred(); state.hold = gate.promise;
    const blocker = daemon.mechanicalRun();
    await until(() => state.entered > 0);
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await writeFile(path.join(daemon.root, 'index.html'), '<!doctype html><title>Edited while queued</title>');
    state.hold = null; gate.release();
    expect((await blocker).status).toBe(200);
    await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    expect(run.operation).toMatchObject({ status: 'interrupted', interruptReason: 'superseded' });
    expect(run.outcome).toBe('inconclusive');
    expect(run.reasons.map(reason => reason.code)).toContain('inputs-changed');
    expect(jev.calls).toHaveLength(0);
    expect(deepseek.calls).toHaveLength(0);
    expect(run.reviewers.every(reviewer => reviewer.status === 'skipped' && /changed/u.test(reviewer.reason ?? ''))).toBe(true);
  });

  it('a rubric saved while the review waited for the browser supersedes the run', async () => {
    const { state, capture } = holdingCapture();
    const jev = fakeReviewer('jev-text');
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') }, capture });
    const gate = deferred(); state.hold = gate.promise;
    const blocker = daemon.mechanicalRun();
    await until(() => state.entered > 0);
    const started = parseReviewRunView(await (await daemon.start({})).json());
    daemon.state.rubric = { ...daemon.state.rubric!, revision: 3 };
    state.hold = null; gate.release();
    await blocker; await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    expect(run.operation.interruptReason).toBe('superseded');
    expect(run.reasons.find(reason => reason.code === 'inputs-changed')?.message).toMatch(/revision 3/u);
    expect(jev.calls).toHaveLength(0);
  });
});

describe('R03 cancel (AC-R03.4)', () => {
  it('cancel while a reviewer availability check is pending never starts that reviewer or calls its provider', async () => {
    const gate = deferred();
    const deepseek = fakeReviewer('deepseek-adversarial', { availabilityGate: gate.promise });
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': deepseek } });
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await until(async () => (await daemon.show(started.run.id)).run.reviewers.find(reviewer => reviewer.role === 'jev-text')?.status === 'completed');
    const cancelled = daemon.runs.cancel('p', started.run.id);
    gate.release();
    const view = await cancelled;
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(deepseek.calls).toHaveLength(0);
    const stored = (await daemon.show(started.run.id)).run;
    expect(stored.operation.status).toBe('interrupted');
    expect(stored.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial')?.status).toBe('cancelled');
    expect(view.run).toEqual(stored);
  });

  it('cancel during capture stops the browser job, releases the browser and keeps the evidence it already captured', async () => {
    const { state, capture } = holdingCapture();
    const closed = { count: 0 };
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') }, capture, onSessionClose: () => { closed.count++; } });
    const gate = deferred(); state.hold = gate.promise;
    const started = parseReviewRunView(await (await daemon.start({})).json());
    await until(() => state.entered > 0);
    const cancelling = daemon.runs.cancel('p', started.run.id);
    // Release the held capture only once cancel() has aborted the run: the abort closes the browser session at once.
    // Releasing earlier races the abort, and the next width could start before the run sees the cancel.
    await until(() => closed.count > 0);
    state.hold = null; gate.release();
    const { run } = await cancelling;
    expect(run.operation).toMatchObject({ status: 'interrupted', interruptReason: 'user-cancelled' });
    expect(run.bundleId).toMatch(/^rv_/u);
    // Widths after the cancel were never captured.
    expect(state.entered).toBe(1);
    expect(run.outcome).toBe('inconclusive');
    // U1's single browser slot is free again.
    expect((await daemon.mechanicalRun()).status).toBe(200);
  });
});

describe('R03 reviewer coverage (AC-R03.2)', () => {
  it('a reviewer that answers only some assigned checks is not an independent completion; its unanswered checks are incomplete', async () => {
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial', { answerFirst: 1 }) } });
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    const deepseek = run.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial')!;
    expect(deepseek.status).toBe('completed');
    expect(deepseek.unansweredCheckIds).toEqual(deepseek.assignedCheckIds.slice(1));
    expect(run.completedIndependentReviewers).toBe(1);
    expect(run.outcome).toBe('inconclusive');
    expect(run.incompleteCheckIds).toEqual(deepseek.assignedCheckIds.slice(1));
  });

  it('splits a reviewer\'s checks into calls no larger than one call of it can answer', async () => {
    const jev = { ...fakeReviewer('jev-text'), maxChecks: 2 };
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    const started = parseReviewRunView(await (await daemon.start({})).json());
    await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    // Captain decision 1: every check is assigned, and no single call carries more than the reviewer's limit.
    const record = run.reviewers.find(reviewer => reviewer.role === 'jev-text')!;
    expect(record.assignedCheckIds).toEqual(run.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial')!.assignedCheckIds);
    expect(jev.calls.length).toBeGreaterThan(1);
    expect(jev.calls.every(call => call.checks.length <= 2)).toBe(true);
    expect(record).toMatchObject({ status: 'completed', unansweredCheckIds: [] });
  });
});

describe('R03 visual critic without vision (AC-R03.2)', () => {
  it('a visual critic that fell back to text because the screenshot store failed is skipped, not an independent completion', async () => {
    // The capture returns bytes that are not a PNG, so the run stores no screenshot.
    const capture = (width: number) => knownGoodCapture(width, item => { item.served = [{ path: 'index.html', sha256: 'pending' }]; item.screenshotPng = Buffer.from('not a png').toString('base64'); });
    const visual = fakeReviewer('claude-visual');
    const claude = { ...visual, async review(input: Parameters<typeof visual.review>[0], signal: AbortSignal) { const result = await visual.review(input, signal); return { ...result, inputMode: input.screenshots.length ? 'vision' as const : 'text-only-fallback' as const }; } };
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'claude-visual': claude }, capture });
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }] } })).json());
    await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    expect(visual.calls[0]?.screenshots).toEqual([]);
    const critic = run.reviewers.find(reviewer => reviewer.role === 'claude-visual')!;
    expect(critic).toMatchObject({ status: 'skipped', inputMode: 'text-only-fallback' });
    expect(critic.reason).toMatch(/could not see/u);
    expect(critic.recovery).toMatch(/screenshot/u);
    expect(run.completedIndependentReviewers).toBe(1);
    expect(run.outcome).toBe('inconclusive');
    expect(run.reasons.map(reason => reason.code)).toEqual(expect.arrayContaining(['fewer-than-two-independent-reviewers', 'required-reviewer-incomplete']));
  });
});

describe('R03 paid-call budget', () => {
  it('two concurrent starts with one Idempotency-Key start one run and call each provider once', async () => {
    const jev = fakeReviewer('jev-text'); const deepseek = fakeReviewer('deepseek-adversarial');
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': deepseek } });
    const [a, b] = await Promise.all([daemon.start({}, 'dup'), daemon.start({}, 'dup')]);
    const ids = [parseReviewRunView(await a.json()).run.id, parseReviewRunView(await b.json()).run.id];
    await daemon.runs.idle();
    expect(ids[0]).toBe(ids[1]);
    expect(jev.calls).toHaveLength(1);
    expect(deepseek.calls).toHaveLength(1);
    expect((await daemon.runs.list('p'))).toHaveLength(1);
  });

  it('allows one active review per project', async () => {
    const gate = deferred();
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text', { gate: gate.promise }), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    expect((await daemon.start({})).status).toBe(202);
    const second = await daemon.start({});
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: { details: { reason: 'review-already-running' } } });
    gate.release(); await daemon.runs.idle();
  });

  it('skips billed reviewers with reason and recovery once the daily cap is reached; the subscription critic still runs', async () => {
    const jev = fakeReviewer('jev-text'); const deepseek = fakeReviewer('deepseek-adversarial'); const claude = fakeReviewer('claude-visual');
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': deepseek, 'claude-visual': claude }, limits: { dailyBilledCalls: 1, modelConcurrency: 1 } });
    const started = parseReviewRunView(await (await daemon.start({})).json());
    await daemon.runs.idle();
    const { run } = await daemon.show(started.run.id);
    expect(jev.calls.length + deepseek.calls.length).toBe(1);
    expect(claude.calls).toHaveLength(1);
    const capped = run.reviewers.find(reviewer => reviewer.status === 'skipped')!;
    // The reason names how many calls the reviewer needs and how many remain (B5-1 lens NIT).
    expect(capped.reason).toMatch(/needs 1 billed call; 0 remain of this daemon's daily limit of 1/u);
    expect(capped.recovery).toMatch(/after midnight UTC/u);
  });
});

describe('od CLI exit codes', () => {
  it('keeps review outcomes, refusals and transport failures on distinct codes', async () => {
    const failing = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') }, capture: width => knownGoodCapture(width, capture => { capture.console.push(consoleRecord({ kind: 'console', text: page('boom'), source: null })); }) });
    const input = JSON.stringify({ snapshot: { entry: 'index.html' }, rubricRevision: 2, reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } });
    expect(await failing.cli(['start', '--project', 'p', '--input-file', '-', '--wait', '--json'], input)).toBe(4);
    expect(await failing.cli(['start', '--project', 'p', '--input-file', '-', '--json'], JSON.stringify({ snapshot: {}, rubricRevision: 9 }))).toBe(3);
    expect(await failing.cli(['show', '--project', 'p', '--run', 'rr_missing', '--json'])).toBe(3);
  });
});
