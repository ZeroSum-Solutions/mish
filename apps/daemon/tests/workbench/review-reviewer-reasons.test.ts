// R03 reviewer reason codes (AC-R03.3): a requested reviewer that is skipped,
// failed or cancelled names its real cause with a closed code beside its
// reason and recovery. The live receipt's visual critic was denied screenshot
// reads (its data root sat under a .claude folder) but only said it "could not
// see" them; Jev scored a Windows 95 style from text alone.
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProviderHttpError } from '@mish/agency-fast-lane/deepseek';
import { parseReviewRunView } from '@mish/contracts';
import { createClaudeVisualReviewer } from '../../src/workbench/review/reviewers/claude-visual.js';
import { createDeepSeekReviewer } from '../../src/workbench/review/reviewers/deepseek.js';
import { createJevReviewer } from '../../src/workbench/review/reviewers/jev.js';
import { ReviewerCallError, type ReviewerInput } from '../../src/workbench/review/reviewers/types.js';
import { knownGoodCapture } from './review-capture-fixture.js';
import { bootReviewRuns, fakeReviewer } from './review-run-fixture.js';

const signal = () => new AbortController().signal;
const shot = (dir: string) => path.join(dir, '320.png');
const input = (dir: string): ReviewerInput => ({
  projectId: 'p', runId: 'rr_1', entry: 'index.html', styleDirection: 'Windows 95',
  checks: [{ checkId: 'win95-style', kind: 'judgment', criterion: 'Reads as Windows 95', mechanicalOutcome: null, mechanicalReason: null, evidenceIds: [], visual: true }],
  evidence: [], screenshots: [{ evidenceId: 'screenshot-320', width: 320, path: shot(dir) }],
});
const readCall = (id: string, file: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: file } }] }, parent_tool_use_id: null });
const readError = (id: string, message: string) => JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, is_error: true, content: message }] }, parent_tool_use_id: null });
const resultFrame = JSON.stringify({ type: 'result', is_error: false, result: '', structured_output: { verdicts: [{ checkId: 'win95-style', verdict: 'supports', rationale: 'Grey chrome', evidenceRefs: ['screenshot-320'] }] } });
const critic = (dir: string, stdout: string, exitCode = 0, stderr = '') => createClaudeVisualReviewer({ resolveBin: () => 'claude', workDir: () => dir, run: async () => ({ exitCode, stderr, stdout }) });

describe('visual critic fallbacks name their cause', () => {
  it('a screenshot read refused by permissions under a .claude folder is screenshot-read-denied, with the folder as the recovery', async () => {
    const dir = path.join(tmpdir(), 'od-r03-reasons', '.claude', 'worktrees', 'x', 'data', 'shots');
    const result = await critic(dir, [readCall('t1', shot(dir)), readError('t1', 'Permission to read this file has been denied.'), resultFrame].join('\n')).review(input(dir), signal());
    expect(result.inputMode).toBe('text-only-fallback');
    expect(result.fallback).toMatchObject({ code: 'screenshot-read-denied', reason: expect.stringMatching(/denied it read access/u), recovery: expect.stringMatching(/inside a \.claude folder.*OD_DATA_DIR/u) });
  });

  it('a denied read elsewhere, a failed read and no read attempt are told apart', async () => {
    const dir = path.join(tmpdir(), 'od-r03-reasons', 'shots');
    const denied = await critic(dir, [readCall('t1', shot(dir)), readError('t1', 'Read operation blocked by permission rules'), resultFrame].join('\n')).review(input(dir), signal());
    expect(denied.fallback).toMatchObject({ code: 'screenshot-read-denied', recovery: expect.stringMatching(/permission settings/u) });
    const failed = await critic(dir, [readCall('t1', shot(dir)), readError('t1', 'File does not exist.'), resultFrame].join('\n')).review(input(dir), signal());
    expect(failed.fallback?.code).toBe('screenshot-read-failed');
    const unread = await critic(dir, resultFrame).review(input(dir), signal());
    expect(unread.fallback?.code).toBe('screenshot-not-read');
  });

  it('a signed-out CLI is cli-auth-missing, an old CLI is cli-outdated and a missing CLI is cli-missing', async () => {
    const dir = path.join(tmpdir(), 'od-r03-reasons', 'shots');
    const signedOut = await critic(dir, JSON.stringify({ type: 'result', is_error: true, result: 'Not logged in · Please run /login' }), 1).review(input(dir), signal()).catch(error => error);
    expect(signedOut).toBeInstanceOf(ReviewerCallError);
    expect(signedOut).toMatchObject({ code: 'cli-auth-missing', recovery: expect.stringMatching(/claude auth status/u) });
    const noResult = await critic(dir, '', 1, 'Invalid API key · Please run /login').review(input(dir), signal()).catch(error => error);
    expect(noResult.code).toBe('cli-auth-missing');
    const outdated = await critic(dir, '', 1, "error: unknown option '--restricted'").review(input(dir), signal()).catch(error => error);
    expect(outdated.code).toBe('cli-outdated');
    const crashed = await critic(dir, JSON.stringify({ type: 'result', is_error: true, result: 'Overloaded' }), 1).review(input(dir), signal()).catch(error => error);
    expect(crashed.code).toBe('cli-failed');
    expect(await createClaudeVisualReviewer({ resolveBin: () => null, workDir: () => dir }).availability()).toMatchObject({ available: false, code: 'cli-missing' });
  });
});

describe('text reviewer failures name their cause', () => {
  it('Jev: missing key, rejected key, unreachable lane and a non-JSON answer', async () => {
    const dir = tmpdir();
    const text = { ...input(dir), screenshots: [], checks: [{ ...input(dir).checks[0]!, visual: false }] };
    expect(await createJevReviewer({ apiKey: async () => 'k', keyConfigured: async () => false }).availability()).toMatchObject({ code: 'key-missing' });
    const answer = (response: () => Promise<Response>) => createJevReviewer({ apiKey: async () => 'k', fetchImpl: response as unknown as typeof fetch }).review(text, signal()).catch(error => error);
    expect((await answer(async () => new Response('{}', { status: 401 }))).code).toBe('provider-auth-rejected');
    expect((await answer(async () => new Response('{}', { status: 500 }))).code).toBe('provider-error');
    expect((await answer(async () => { throw new TypeError('fetch failed'); })).code).toBe('provider-unreachable');
    expect((await answer(async () => new Response('not json'))).code).toBe('invalid-response');
  });

  it('DeepSeek: missing key, rejected key, unreachable lane and an unusable answer', async () => {
    // A non-visual check: a visual one without measured facts is now an abstention with no call.
    const text = { ...input(tmpdir()), screenshots: [], checks: [{ ...input(tmpdir()).checks[0]!, visual: false }] };
    expect(await createDeepSeekReviewer({ apiKey: async () => 'k', keyConfigured: async () => false }).availability()).toMatchObject({ code: 'key-missing' });
    const answer = (call: NonNullable<Parameters<typeof createDeepSeekReviewer>[0]['call']>) => createDeepSeekReviewer({ apiKey: async () => 'k', call }).review(text, signal()).catch(error => error);
    expect((await answer(async () => { throw new ProviderHttpError('deepseek', 401); })).code).toBe('provider-auth-rejected');
    expect((await answer(async () => { throw new Error('socket hang up'); })).code).toBe('provider-unreachable');
    expect((await answer(async () => ({ text: 'Looks fine', ms: 1, retries: 0 }))).code).toBe('invalid-response');
    expect((await answer(async () => ({ text: '{"verdicts":[]}', ms: 1, retries: 0 }))).code).toBe('no-verdicts');
  });
});

describe('review runs record the code', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });
  async function boot(options: Parameters<typeof bootReviewRuns>[0] = {}) {
    const daemon = await bootReviewRuns(options);
    cleanups.push(async () => { await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); });
    return daemon;
  }

  it('a denied screenshot read is skipped as screenshot-read-denied with its own reason and recovery', async () => {
    const visual = fakeReviewer('claude-visual');
    const claude = { ...visual, async review(request: ReviewerInput, abort: AbortSignal) {
      const result = await visual.review(request, abort);
      return { ...result, inputMode: 'text-only-fallback' as const, fallback: { code: 'screenshot-read-denied' as const, reason: 'The visual critic could not see the page screenshots: Claude Code denied it read access, so it did not review the visual checks', recovery: 'The screenshots are stored inside a .claude folder' } };
    } };
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'claude-visual': claude, 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    const started = parseReviewRunView(await (await daemon.start({})).json());
    await daemon.runs.idle();
    const { run } = parseReviewRunView(await daemon.show(started.run.id));
    expect(run.reviewers.find(reviewer => reviewer.role === 'claude-visual')).toMatchObject({ status: 'skipped', reasonCode: 'screenshot-read-denied', reason: expect.stringMatching(/denied it read access/u), recovery: expect.stringMatching(/\.claude folder/u) });
    // The od CLI shows the same record (UI/CLI dual track).
    expect(await daemon.cli(['show', '--project', 'p', '--run', started.run.id, '--json'])).toBe(0);
    const shown = parseReviewRunView(daemon.output.at(-1));
    expect(shown.run.reviewers.find(reviewer => reviewer.role === 'claude-visual')?.reasonCode).toBe('screenshot-read-denied');
  });

  it('od workbench review run --lang renders each check\'s measured detail in that locale', async () => {
    const daemon = await boot({ capture: width => knownGoodCapture(width, item => { item.served = [{ path: 'index.html', sha256: 'pending' }, { path: 'book.html', sha256: 'pending' }]; }) });
    expect(await daemon.cli(['run', '--project', 'p', '--lang', "en", '--json'])).toBe(0);
    const printed = daemon.output.at(-1) as { text: { evidence: { id: string; detail?: string[] }[] } };
    expect(printed.text.evidence.find(item => item.id === 'core.keyboard-focus@320')?.detail).toEqual(['Tab walk: 3 focusable element(s), 3 distinct stop(s) reached, 3 with a visible focus indicator; returned to the start: yes']);
  });

  it('a fallback with no screenshot is screenshot-unavailable; setup, budget and call failures carry their codes', async () => {
    const visual = fakeReviewer('claude-visual', { inputMode: 'text-only-fallback' });
    const failing = fakeReviewer('deepseek-adversarial', { error: new ReviewerCallError('DeepSeek Flash did not answer', 'Check the key', 'provider-auth-rejected') });
    const daemon = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text', { unavailable: true }), 'claude-visual': visual, 'deepseek-adversarial': failing } });
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'claude-visual', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await daemon.runs.idle();
    const { run } = parseReviewRunView(await daemon.show(started.run.id));
    const byRole = Object.fromEntries(run.reviewers.map(reviewer => [reviewer.role, reviewer]));
    expect(byRole['jev-text']).toMatchObject({ status: 'skipped', reasonCode: 'unavailable' });
    expect(byRole['deepseek-adversarial']).toMatchObject({ status: 'failed', reasonCode: 'provider-auth-rejected' });
    // The fixture stores screenshots, so a fallback without a cause is "not read", never a generic message.
    expect(byRole['claude-visual']).toMatchObject({ status: 'skipped', reasonCode: 'screenshot-not-read', reason: expect.stringMatching(/answered without opening them/u) });

    const unconfigured = await boot({ reviewers: { 'jev-text': fakeReviewer('jev-text') } });
    const second = parseReviewRunView(await (await unconfigured.start({})).json());
    await unconfigured.runs.idle();
    const missing = parseReviewRunView(await unconfigured.show(second.run.id)).run.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial');
    expect(missing).toMatchObject({ status: 'skipped', reasonCode: 'not-configured' });
  });

  it('a Jev abstention on a visual check is an uncertain finding marked insufficient-visual-evidence and still counts as an answer', async () => {
    const jev = fakeReviewer('jev-text');
    const abstaining = { ...jev, async review(request: ReviewerInput, abort: AbortSignal) {
      const result = await jev.review(request, abort);
      return { ...result, verdicts: result.verdicts.map(verdict => verdict.checkId === 'win95-style' ? { ...verdict, verdict: 'supports' as const, probability: 0.04, abstain: 'insufficient-visual-evidence' as const, rationale: 'Insufficient evidence for visual style' } : verdict) };
    } };
    const daemon = await boot({ reviewers: { 'jev-text': abstaining, 'deepseek-adversarial': fakeReviewer('deepseek-adversarial') } });
    const started = parseReviewRunView(await (await daemon.start({ reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await daemon.runs.idle();
    const { run } = parseReviewRunView(await daemon.show(started.run.id));
    // The run keeps the abstention honest even if an adapter sent a probability with it.
    expect(run.findings.find(finding => finding.id === 'jev-text-win95-style')).toEqual({
      id: 'jev-text-win95-style', reviewerRole: 'jev-text', checkId: 'win95-style', verdict: 'uncertain', kind: 'judgment', evidenceRefs: [], probability: null,
      rationale: 'Insufficient evidence for visual style', abstainReason: 'insufficient-visual-evidence',
    });
    expect(run.reviewers.find(reviewer => reviewer.role === 'jev-text')).toMatchObject({ status: 'completed', unansweredCheckIds: [] });
    expect(run.completedIndependentReviewers).toBe(2);
  });

  it('a Jev full abstention reserves and counts no billed call, so the daily cap still lets DeepSeek run', async () => {
    let fetched = 0;
    const jev = createJevReviewer({ apiKey: async () => 'k', fetchImpl: (async () => { fetched++; return new Response('{}'); }) as unknown as typeof fetch });
    const deepseek = fakeReviewer('deepseek-adversarial');
    const daemon = await boot({ reviewers: { 'jev-text': jev, 'deepseek-adversarial': deepseek }, limits: { dailyBilledCalls: 1, modelConcurrency: 1 } });
    // The style check needs the rendered look; the fixture capture has no visual facts, so Jev can only abstain.
    daemon.state.rubric!.checks[0]!.evidenceTypes = ['judgment-rationale', 'screenshot'];
    const started = parseReviewRunView(await (await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] }, reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }] } })).json());
    await daemon.runs.idle();
    const { run } = parseReviewRunView(await daemon.show(started.run.id));
    expect(fetched).toBe(0);
    expect(run.reviewers.find(reviewer => reviewer.role === 'jev-text')).toMatchObject({ status: 'completed', providerCalls: 0, unansweredCheckIds: [] });
    expect(run.findings.find(finding => finding.reviewerRole === 'jev-text')).toMatchObject({ abstainReason: 'insufficient-visual-evidence' });
    expect(deepseek.calls).toHaveLength(1);
    expect(run.reviewers.find(reviewer => reviewer.role === 'deepseek-adversarial')).toMatchObject({ status: 'completed', providerCalls: 1 });
  });
});

