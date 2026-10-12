import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createGeminiReviewer } from '../../src/workbench/review/reviewers/gemini.js';
import type { ReviewerInput } from '../../src/workbench/review/reviewers/types.js';

const roots: string[] = [];
const workers: number[] = [];
afterEach(async () => {
  for (const pid of workers.splice(0)) { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const input: ReviewerInput = {
  projectId: 'p', runId: 'rr_1', entry: 'index.html', styleDirection: null,
  checks: [{ checkId: 'cta-visible', kind: 'mechanical', criterion: 'x'.repeat(200_000), mechanicalOutcome: 'pass', mechanicalReason: 'ok', evidenceIds: [] }],
  evidence: [], screenshots: [],
};
const answer = JSON.stringify({ verdicts: [{ checkId: 'cta-visible', verdict: 'supports', rationale: 'fine', evidenceRefs: [] }] });
async function setup(source: string, timeoutMs = 3000) {
  const root = await mkdtemp(path.join(tmpdir(), 'od-gemini-process-'));
  roots.push(root);
  const command = path.join(root, 'agy.cjs');
  await writeFile(command, `#!${process.execPath}\n${source}`, { mode: 0o700 });
  const homeRoot = path.join(root, 'homes');
  const reviewer = createGeminiReviewer({ resolveBin: () => command, env: {}, authFile: null, isolatedConfigRoot: homeRoot, openRouterKey: async () => '', timeoutMs });
  return { root, homeRoot, reviewer };
}

describe.skipIf(process.platform === 'win32')('agy pipes', () => {
  it('contains EPIPE when the CLI closes stdin before consuming a 200 KB prompt', async () => {
    const { reviewer, homeRoot } = await setup('require("node:fs").closeSync(0); setTimeout(() => process.exit(41), 100);');
    await expect(reviewer.review(input, new AbortController().signal)).rejects.toMatchObject({ code: 'provider-error' });
    expect(await readdir(homeRoot)).toEqual([]);
  });

  it('delivers a complete 200 KB prompt through backpressure', async () => {
    const { reviewer } = await setup(`let text = ''; process.stdin.on('data', chunk => { text += chunk; }); process.stdin.on('end', () => { if (!JSON.parse(text).message.content.includes('x'.repeat(200000))) process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: answer } }))}); });`);
    expect((await reviewer.review(input, new AbortController().signal)).verdicts[0]?.verdict).toBe('supports');
  });

  it('retains the terminal result after more than 2 MB of progress events', async () => {
    const result = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: answer } }) + '\n';
    const { reviewer } = await setup(`process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ event: 'step_update', text: 'x'.repeat(2100000) }) + '\\n'); process.stdout.write(${JSON.stringify(result)}); });`);
    expect((await reviewer.review(input, new AbortController().signal)).verdicts[0]?.verdict).toBe('supports');
  });

  it('preserves UTF-8 when the terminal response spans byte chunks', async () => {
    const result = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: answer.replace('fine', 'café') } }) + '\n';
    const { reviewer } = await setup(`process.stdin.resume(); process.stdin.on('end', () => { const text = Buffer.from(${JSON.stringify(result)}); const cut = text.indexOf(Buffer.from('é')) + 1; process.stdout.write(text.subarray(0, cut)); setTimeout(() => process.stdout.write(text.subarray(cut)), 50); });`);
    expect((await reviewer.review(input, new AbortController().signal)).verdicts[0]?.rationale).toBe('café');
  });

  it('surfaces provider credentials errors safely when early exit breaks the prompt pipe', async () => {
    const { reviewer, homeRoot } = await setup('process.stderr.write("Provider rejected credentials secret-example"); require("node:fs").closeSync(0); setTimeout(() => process.exit(41), 100);');
    const failure = await reviewer.review(input, new AbortController().signal).catch(error => error);
    expect(failure).toMatchObject({ code: 'provider-error', message: 'The agy provider did not return a successful answer' });
    expect(failure.message + failure.recovery).not.toContain('secret-example');
    expect(await readdir(homeRoot)).toEqual([]);
  });

  it('preserves the auth failure when early exit also breaks the prompt pipe', async () => {
    const { reviewer, homeRoot } = await setup('process.stderr.write("Print mode: not logged in and no controlling terminal; cannot complete interactive login"); require("node:fs").closeSync(0); setTimeout(() => process.exit(41), 100);');
    await expect(reviewer.review(input, new AbortController().signal)).rejects.toMatchObject({ code: 'cli-auth-missing' });
    expect(await readdir(homeRoot)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32')('agy process lifetime', () => {
  it.each(['abort', 'timeout'] as const)('kills the relaunched worker and settles on %s even after the wrapper exits', async kind => {
    const worker = 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);';
    const { root, homeRoot, reviewer } = await setup(`
      process.stdin.resume();
      process.stdin.on('end', () => {
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(worker)}], { stdio: ['ignore', 1, 2] });
        require('node:fs').writeFileSync(require('node:path').join(__dirname, 'worker.json'), JSON.stringify({ pid: child.pid }));
        process.exit(0);
      });
    `, kind === 'timeout' ? 500 : 3000);
    const controller = new AbortController();
    const pending = reviewer.review(input, controller.signal).catch(error => error);
    let pid: number | undefined;
    for (let i = 0; i < 100 && !pid; i++) {
      try { pid = JSON.parse(await readFile(path.join(root, 'worker.json'), 'utf8')).pid; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    expect(pid).toBeTypeOf('number');
    workers.push(pid!);
    if (kind === 'abort') controller.abort(new Error('stopped'));
    let deadline: ReturnType<typeof setTimeout>;
    const result = await Promise.race([pending, new Promise(resolve => { deadline = setTimeout(() => resolve('did not settle'), 1000); })]);
    clearTimeout(deadline!);
    expect(result).toMatchObject(kind === 'abort' ? { message: 'stopped' } : { code: 'timeout' });
    expect(await readdir(homeRoot)).toEqual([]);
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try { process.kill(pid!, 0); await new Promise(resolve => setTimeout(resolve, 10)); } catch { alive = false; }
    }
    expect(alive).toBe(false);
  });
});
