// R03 second model family (B062, D7/D8): agy subscription by default;
// OpenRouter requires an explicit choice. All provider operations are stubbed.
import { chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReviewRunView, WORKBENCH_REVIEWER_ROLES } from '@open-design/contracts';
import { bootReviewRuns, fakeReviewer } from './review-run-fixture.js';
import { DEFAULT_REVIEWER_PLAN } from '../../src/workbench/review/reviewer-plan.js';
import { createGeminiReviewer } from '../../src/workbench/review/reviewers/gemini.js';
import { ReviewerCallError, type ReviewerInput } from '../../src/workbench/review/reviewers/types.js';

const roots: string[] = [];
const temp = async () => { const root = await mkdtemp(path.join(tmpdir(), 'od-agy-test-')); roots.push(root); return root; };
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const signal = () => new AbortController().signal;
const input: ReviewerInput = {
  projectId: 'p', runId: 'rr_1', entry: 'index.html', styleDirection: null,
  checks: [{ checkId: 'cta-visible', kind: 'mechanical', criterion: 'cta check', mechanicalOutcome: 'pass', mechanicalReason: 'ok', evidenceIds: [] }],
  evidence: [], screenshots: [],
};
const answer = JSON.stringify({ verdicts: [{ checkId: 'cta-visible', verdict: 'supports', rationale: 'fine', evidenceRefs: [] }] });
const output = (response = answer) => JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response } }) + '\n';
const base = { resolveBin: () => '/bin/agy', openRouterKey: async () => '', env: {}, authFile: null };

describe('Gemini second-family route selection', () => {
  it('keeps the advisory default and existing required roles', () => {
    expect(WORKBENCH_REVIEWER_ROLES).toContain('gemini-second-family');
    expect(DEFAULT_REVIEWER_PLAN.find(entry => entry.role === 'gemini-second-family')).toEqual({ role: 'gemini-second-family', required: false });
    expect(DEFAULT_REVIEWER_PLAN.filter(entry => entry.required)).toHaveLength(3);
  });

  it('uses agy with the default model and one NDJSON prompt on stdin, without keys or user config', async () => {
    const root = await temp();
    let spawned = false;
    const reviewer = createGeminiReviewer({ ...base, isolatedConfigRoot: root,
      env: { PATH: '/bin', HOME: '/user', OPENROUTER_API_KEY: 'test-key', GEMINI_API_KEY: 'test-key', GOOGLE_CLOUD_PROJECT: 'blocked', GEMINI_CLI_HOME: '/user', ANTIGRAVITY_APP_DATA_DIR: '/user/config', XDG_CONFIG_HOME: '/user/config' },
      run: async request => {
        spawned = true;
        expect(request.command).toBe('/bin/agy');
        expect(request.args).toEqual(['--model', 'gemini-3.8-flash-medium', '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print-timeout', '300000ms']);
        const event = JSON.parse(request.stdin);
        expect(event.event).toBe('user'); expect(event.message.content).toContain('cta-visible');
        expect(request.stdin.trim().split('\n')).toHaveLength(1);
        expect(request.env.HOME!.startsWith(root)).toBe(true);
        expect(request.env.XDG_CONFIG_HOME!.startsWith(request.env.HOME!)).toBe(true);
        expect(request.env.ANTIGRAVITY_APP_DATA_DIR!.startsWith(request.env.HOME!)).toBe(true);
        for (const key of ['OPENROUTER_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_CLOUD_PROJECT', 'GEMINI_CLI_HOME']) expect(request.env[key]).toBeUndefined();
        expect(request.cwd.startsWith(request.env.HOME!)).toBe(true);
        expect((await stat(request.env.HOME!)).mode & 0o777).toBe(0o700);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect(await readdir(request.cwd)).toEqual([]);
        return { exitCode: 0, stdout: JSON.stringify({ event: 'init', init: {} }) + '\n' + output(), stderr: '' };
      },
    });
    await reviewer.prepare?.();
    expect(reviewer).toMatchObject({ provider: 'gemini', modelId: 'gemini-3.8-flash-medium', billingLane: 'gemini-subscription' });
    expect(await reviewer.availability()).toEqual({ available: true });
    expect((await reviewer.review(input, signal())).verdicts[0]?.verdict).toBe('supports');
    expect(spawned).toBe(true); expect(await readdir(root)).toEqual([]);
  });

  it('never selects OpenRouter merely because its key is configured', async () => {
    let billed = 0; let resolved = 0;
    const reviewer = createGeminiReviewer({ ...base, resolveBin: () => null,
      openRouterKey: async () => { resolved++; return 'test-key'; }, call: async () => { billed++; return answer; } });
    await reviewer.prepare?.();
    expect(await reviewer.availability()).toMatchObject({ available: false, code: 'cli-missing', recovery: expect.stringMatching(/agy/u) });
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-missing' });
    expect(reviewer.billingLane).toBe('gemini-subscription'); expect(resolved).toBe(0); expect(billed).toBe(0);
  });

  it('chooses OpenRouter only by explicit opt-in and freezes that choice', async () => {
    const env = { OD_GEMINI_REVIEW_ROUTE: 'openrouter' }; let called = false;
    const reviewer = createGeminiReviewer({ ...base, env, openRouterKey: async () => 'test-key',
      run: async () => { throw new Error('must not spawn agy'); }, call: async request => {
        called = true; expect(request.model).toBe('google/gemini-3.8-flash'); expect(request.key).toBe('test-key'); return answer;
      } });
    await reviewer.prepare?.(); env.OD_GEMINI_REVIEW_ROUTE = 'agy'; await reviewer.prepare?.();
    expect(reviewer).toMatchObject({ provider: 'openrouter', billingLane: 'openrouter-metered' });
    expect((await reviewer.review(input, signal())).verdicts).toHaveLength(1); expect(called).toBe(true);
  });

  it('does not switch an explicitly selected OpenRouter route to agy when its key is missing', async () => {
    const reviewer = createGeminiReviewer({ ...base, route: 'openrouter' });
    await reviewer.prepare?.();
    expect(await reviewer.availability()).toMatchObject({ available: false, code: 'key-missing' });
    expect(reviewer.billingLane).toBe('openrouter-metered');
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'key-missing' });
  });

  it('fails closed on an unknown route', async () => {
    const reviewer = createGeminiReviewer({ ...base, env: { OD_GEMINI_REVIEW_ROUTE: 'typo' } });
    expect(await reviewer.availability()).toMatchObject({ available: false, code: 'cli-failed' });
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-failed' });
  });

  it.each(['authentication required', 'provider failed', 'upstream auth rejected', 'invalid credentials', 'OAuth token expired', 'unauthorized', 'please run again'])('keeps agy on %s without billing or leaking output', async error => {
    let billed = 0;
    const reviewer = createGeminiReviewer({ ...base, openRouterKey: async () => 'test-key', call: async () => { billed++; return answer; },
      run: async () => ({ exitCode: 41, stdout: '', stderr: error + ' secret-example' }) });
    const failure = await reviewer.review(input, signal()).catch(error => error);
    expect(failure).toBeInstanceOf(ReviewerCallError);
    expect(failure).toMatchObject({ code: 'provider-error', message: 'The agy provider did not return a successful answer' });
    expect(failure.message + failure.recovery).not.toContain('secret-example'); expect(billed).toBe(0);
  });

  it.each(['ERROR', 'CANCELLED', 'IN_PROGRESS'])('rejects an agy %s result even with exit zero and valid response text', async status => {
    const reviewer = createGeminiReviewer({ ...base, run: async () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'result', result: { status, response: answer } }), stderr: '' }) });
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: status === 'ERROR' ? 'provider-error' : 'cli-failed' });
  });

  it.each([0, 41])('keeps stdout provider auth errors as provider errors on exit %s without exposing diagnostics', async exitCode => {
    const reviewer = createGeminiReviewer({ ...base, run: async () => ({ exitCode, stdout: JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'authentication required secret-example' } }), stderr: '' }) });
    const failure = await reviewer.review(input, signal()).catch(error => error);
    expect(failure).toMatchObject({ code: 'provider-error' });
    expect(failure.message + failure.recovery).not.toContain('secret-example');
  });

  it.each(['Print mode: not logged in and no controlling terminal; cannot complete interactive login', 'Please set an Auth method'])('recognizes the agy sign-in prompt: %s', async message => {
    for (const stream of ['stderr', 'stdout'] as const) {
      const reviewer = createGeminiReviewer({ ...base, run: async () => ({ exitCode: 41,
        stderr: stream === 'stderr' ? message + '\n' : '',
        stdout: stream === 'stdout' ? JSON.stringify({ event: 'result', result: { status: 'ERROR', error: message } }) : '',
      }) });
      await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-auth-missing', message: 'agy is not signed in' });
    }
  });

  it('ignores sign-in text in successful stderr', async () => {
    const reviewer = createGeminiReviewer({ ...base, run: async () => ({ exitCode: 0, stdout: output(), stderr: 'Please set an Auth method' }) });
    expect((await reviewer.review(input, signal())).verdicts[0]?.verdict).toBe('supports');
  });

  it('rejects missing terminal results instead of scoring a step update', async () => {
    const reviewer = createGeminiReviewer({ ...base, run: async () => ({ exitCode: 0, stdout: JSON.stringify({ event: 'step_update', response: answer }), stderr: '' }) });
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-failed' });
  });

  it('maps a rejected explicit OpenRouter key to a closed code', async () => {
    const reviewer = createGeminiReviewer({ ...base, route: 'openrouter', openRouterKey: async () => 'test-key', call: async () => { throw Object.assign(new Error('401'), { status: 401 }); } });
    await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'provider-auth-rejected' });
  });

  it('uses the configured agy model and abstains on copy without a call', () => {
    expect(createGeminiReviewer({ ...base, env: { OD_GEMINI_REVIEW_MODEL: 'gemini-3.8-flash-low' } }).modelId).toBe('gemini-3.8-flash-low');
    expect(createGeminiReviewer({ ...base, agyModel: 'gemini-3.8-flash-high' }).modelId).toBe('gemini-3.8-flash-high');
    expect(createGeminiReviewer(base).plannedCalls?.({ ...input, checks: [{ ...input.checks[0]!, kind: 'judgment', copy: true }] })).toBe(0);
  });
});

describe('agy config lifecycle', () => {
  it.each(['file', 'symlink'])('references the default agy sign-in %s leaf and denies all agent tools in isolated settings', async kind => {
    const root = await temp(); const user = await temp();
    const userConfig = path.join(user, '.gemini', 'antigravity-cli');
    await mkdir(userConfig, { recursive: true });
    const authFile = path.join(userConfig, 'antigravity-oauth-token');
    if (kind === 'symlink') {
      const target = path.join(user, 'stored-token'); await writeFile(target, 'fake-subscription-token'); await symlink(target, authFile);
    } else await writeFile(authFile, 'fake-subscription-token');
    await writeFile(path.join(userConfig, 'settings.json'), '{"hooks":"must-not-load"}');
    let referenced = false;
    const reviewer = createGeminiReviewer({ resolveBin: base.resolveBin, openRouterKey: base.openRouterKey, env: { HOME: user }, isolatedConfigRoot: root, run: async request => {
      const config = path.join(request.env.HOME!, '.gemini', 'antigravity-cli');
      expect(await readlink(path.join(config, 'antigravity-oauth-token'))).toBe(authFile);
      const settings = JSON.parse(await readFile(path.join(config, 'settings.json'), 'utf8'));
      expect(settings).toEqual({ permissions: { deny: ['read_file(*)', 'write_file(*)', 'command(*)', 'mcp(*)', 'read_url(*)', 'execute_url(*)'] } });
      expect((await stat(path.join(config, 'settings.json'))).mode & 0o777).toBe(0o600);
      referenced = true; return { exitCode: 0, stdout: output(), stderr: '' };
    } });
    expect((await reviewer.review(input, signal())).verdicts[0]?.verdict).toBe('supports');
    expect(referenced).toBe(true); expect(await readdir(root)).toEqual([]);
    expect(await readFile(authFile, 'utf8')).toBe('fake-subscription-token');
  });

  it('sweeps only old owned config dirs at startup, preserving recent dirs, symlinks and unrelated files', async () => {
    const root = await temp(); const outside = await temp();
    for (const name of ['agy-config-old', 'agy-config-recent', 'keep-me']) { await mkdir(path.join(root, name)); await writeFile(path.join(root, name, 'state.json'), '{}'); }
    const old = new Date(Date.now() - 301_000);
    await utimes(path.join(root, 'agy-config-old'), old, old); await utimes(path.join(root, 'keep-me'), old, old);
    await writeFile(path.join(outside, 'state.json'), 'keep'); await symlink(outside, path.join(root, 'agy-config-link'));
    createGeminiReviewer({ ...base, isolatedConfigRoot: root });
    await expect.poll(async () => (await readdir(root)).sort()).toEqual(['agy-config-link', 'agy-config-recent', 'keep-me']);
    expect(await readFile(path.join(outside, 'state.json'), 'utf8')).toBe('keep');
  });

  it.skipIf(process.platform === 'win32')('continues the sweep after failure and refuses reviews if cleanup failed', async () => {
    const root = await temp(); const blocked = path.join(root, 'agy-config-a'); const removable = path.join(root, 'agy-config-b');
    const old = new Date(Date.now() - 301_000);
    for (const dir of [blocked, removable]) { await mkdir(dir); await writeFile(path.join(dir, 'state.json'), '{}'); await utimes(dir, old, old); }
    await chmod(blocked, 0o500);
    try {
      const reviewer = createGeminiReviewer({ ...base, isolatedConfigRoot: root }); await reviewer.prepare?.();
      expect(await readdir(root)).toEqual(['agy-config-a']);
      expect(await reviewer.availability()).toMatchObject({ available: false, code: 'cli-failed' });
      await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-failed' });
    } finally { await chmod(blocked, 0o700); }
  });

  it.skipIf(process.platform === 'win32')('reports cleanup failure instead of a completed review', async () => {
    const root = await temp(); let home = '';
    const reviewer = createGeminiReviewer({ ...base, isolatedConfigRoot: root, run: async request => {
      home = request.env.HOME!; await writeFile(path.join(request.cwd, 'state.json'), '{}'); await chmod(request.cwd, 0o500);
      return { exitCode: 0, stdout: output(), stderr: '' };
    } });
    try { await expect(reviewer.review(input, signal())).rejects.toMatchObject({ code: 'cli-failed', message: 'The agy config directory could not be removed' }); }
    finally { if (home) await chmod(path.join(home, 'work'), 0o700); }
  });

  it.each(['timeout', 'abort'])('cleans up on %s', async kind => {
    const root = await temp(); const controller = new AbortController(); let entered!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const reviewer = createGeminiReviewer({ ...base, isolatedConfigRoot: root, timeoutMs: kind === 'timeout' ? 50 : 1000,
      run: async request => { entered(); return new Promise<never>((_, reject) => request.signal.addEventListener('abort', () => reject(request.signal.reason))); } });
    const pending = reviewer.review(input, controller.signal).catch(error => error); await called;
    if (kind === 'abort') controller.abort(new Error('stopped'));
    expect(await pending).toMatchObject(kind === 'timeout' ? { code: 'timeout' } : { message: 'stopped' }); expect(await readdir(root)).toEqual([]);
  });
});

describe('gemini reviewer in a run (D7 advisory, D8 incomplete)', () => {
  const boot = async (gemini: ReturnType<typeof fakeReviewer>) => bootReviewRuns({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial'), 'gemini-second-family': gemini } });
  const finish = async (daemon: Awaited<ReturnType<typeof boot>>, required: boolean) => {
    const started = parseReviewRunView(await (await daemon.start({ scope: { kind: 'checks', checkIds: ['win95-style'] }, reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }, { role: 'deepseek-adversarial', required: true }, { role: 'gemini-second-family', required }] } })).json());
    await daemon.runs.idle();
    return (await daemon.show(started.run.id)).run;
  };

  it('a required Gemini reviewer that is unavailable shows its fix hint and leaves its checks incomplete, never silently skipped', async () => {
    const run = await finish(await boot(fakeReviewer('gemini-second-family', { unavailable: true })), true);
    expect(run.reviewers.find(reviewer => reviewer.role === 'gemini-second-family')).toMatchObject({ status: 'skipped', required: true, recovery: expect.stringMatching(/Add the gemini-second-family key/u) });
    expect(run.reasons.map(reason => reason.code)).toContain('required-reviewer-incomplete');
    expect(run.outcome).toBe('inconclusive');
  });

  it('an optional Gemini reviewer that is unavailable is advisory: the run still resolves on the other families', async () => {
    const run = await finish(await boot(fakeReviewer('gemini-second-family', { unavailable: true })), false);
    expect(run.reasons.map(reason => reason.code)).not.toContain('required-reviewer-incomplete');
    expect(run.completedIndependentReviewers).toBe(2);
  });

  it('keeps frozen subscription facts and marks the required reviewer incomplete when CLI auth is lost', async () => {
    let billed = 0;
    const gemini = createGeminiReviewer({
      ...base, run: async () => ({ exitCode: 1, stdout: '', stderr: 'Print mode: not logged in and no controlling terminal; cannot complete interactive login' }), openRouterKey: async () => 'configured-key',
      call: async () => { billed++; return answer; },
    });
    const daemon = await bootReviewRuns({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial'), 'gemini-second-family': gemini } });
    try {
      const run = await finish(daemon, true);
      expect(run.reviewers.find(record => record.role === 'gemini-second-family')).toMatchObject({
        provider: 'gemini', modelId: 'gemini-3.8-flash-medium', billingLane: 'gemini-subscription', status: 'failed', reasonCode: 'cli-auth-missing',
      });
      expect(run.frozen.reviewerModelIds).toContainEqual({ role: 'gemini-second-family', modelId: 'gemini-3.8-flash-medium' });
      expect(run.reasons.map(reason => reason.code)).toContain('required-reviewer-incomplete');
      expect(billed).toBe(0);
    } finally { await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); }
  });

  it('selects a fresh route for the next run while keeping the first run frozen', async () => {
    let installed = false;
    const gemini = createGeminiReviewer({ ...base, resolveBin: () => installed ? '/bin/agy' : null, run: async () => ({ exitCode: 0, stdout: output(answer.replaceAll('cta-visible', 'win95-style')), stderr: '' }) });
    const daemon = await bootReviewRuns({ reviewers: { 'jev-text': fakeReviewer('jev-text'), 'deepseek-adversarial': fakeReviewer('deepseek-adversarial'), 'gemini-second-family': gemini } });
    try {
      const first = await finish(daemon, true);
      expect(first.reviewers.find(record => record.role === 'gemini-second-family')?.status).toBe('skipped');
      installed = true;
      const second = await finish(daemon, true);
      expect(second.reviewers.find(record => record.role === 'gemini-second-family')).toMatchObject({ status: 'completed', billingLane: 'gemini-subscription' });
      expect((await daemon.show(first.id)).run.reviewers.find(record => record.role === 'gemini-second-family')?.status).toBe('skipped');
    } finally { await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); }
  });

  it('isolates overlapping run routes and gates the metered run against its budget', async () => {
    const env = { OD_GEMINI_REVIEW_ROUTE: 'agy' }; let billed = 0;
    let entered!: () => void; let release!: () => void;
    const called = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    const gemini = createGeminiReviewer({ ...base, env,
      openRouterKey: async () => 'configured-key', call: async () => { billed++; return answer; },
      run: async () => { entered(); await gate; return { exitCode: 0, stdout: output(answer.replaceAll('cta-visible', 'win95-style')), stderr: '' }; },
    });
    const daemon = await bootReviewRuns({ reviewers: { 'gemini-second-family': gemini }, limits: { maxActive: 2, dailyBilledCalls: 0 } });
    const body = { scope: { kind: 'checks', checkIds: ['win95-style'] }, reviewerPlan: { reviewers: [{ role: 'gemini-second-family', required: true }] } };
    try {
      const first = parseReviewRunView(await (await daemon.start(body)).json()).run;
      await called;
      env.OD_GEMINI_REVIEW_ROUTE = 'openrouter';
      const second = parseReviewRunView(await (await daemon.start({ ...body, projectId: 'q' })).json()).run;
      const showSecond = async () => parseReviewRunView(await (await fetch(`${daemon.url}/api/workbench/reviews/${second.id}?projectId=q`)).json()).run;
      await expect.poll(async () => (await showSecond()).operation.status).toBe('done');
      expect((await showSecond()).reviewers[0]).toMatchObject({ billingLane: 'openrouter-metered', status: 'skipped', reasonCode: 'daily-limit' });
      release(); await daemon.runs.idle();
      expect((await daemon.show(first.id)).run.reviewers[0]).toMatchObject({ billingLane: 'gemini-subscription', provider: 'gemini', status: 'completed' });
      expect(billed).toBe(0);
    } finally { release(); await daemon.runs.idle(); await daemon.close(); await rm(daemon.data, { recursive: true, force: true }); }
  });
});
