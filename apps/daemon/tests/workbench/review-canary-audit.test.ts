import express from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { parseVerificationBundle, type VerificationBundle } from '@mish/contracts';
import { registerWorkbenchReviewRoutes } from '../../src/routes/workbench-review.js';
import { runReviewCli } from '../../src/workbench/review-cli.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import type { EgressResolver, EgressTransport } from '../../src/workbench/review/egress.js';
import { buildReviewerInput } from '../../src/workbench/review/reviewer-plan.js';
import { createClaudeVisualReviewer } from '../../src/workbench/review/reviewers/claude-visual.js';
import { createJevReviewer } from '../../src/workbench/review/reviewers/jev.js';
import { buildReviewPrompt } from '../../src/workbench/review/reviewers/prompt.js';
import { createWorkbenchReviewService } from '../../src/workbench/review/service.js';
import { readable } from './review-capture-fixture.js';

// Round 7 canary audit (captain): one page plants a unique canary in every
// page-controllable place (text, title, meta, alt, aria-*, data-*, ids,
// classes, roles, href/src/srcset/action/formaction paths and origins,
// sourceURL, console args, thrown errors, CSS class/property/keyframes/font
// names, iframe names, custom element tags, window.name, cookies, storage,
// URL query and fragment). No canary may reach any output of a review.
// R03 evidence detail extends the audit to the measured detail, the visual-<width>
// facts (the planted font family is a declared family there) and every
// provider request body built from the reviewer input.
// Opt-in like the other browser fixtures (OD_REVIEW_BROWSER_TESTS=1).
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/workbench/review-canary');
const CANARY = /canary/iu;
/** Set OD_REVIEW_CANARY_BUNDLE_OUT to a path to save the produced bundle (used to refresh the web panel fixture). */
const bundleOut = process.env.OD_REVIEW_CANARY_BUNDLE_OUT;

describe.skipIf(!optedIn)('round 7 canary audit in a real browser', () => {
  const dirs: string[] = [];
  afterAll(async () => { await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });

  it('no page-planted canary appears in the bundle, reviewer input, logs, HTTP response or CLI output', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'od-review-canary-')); dirs.push(data);
    const hits: string[] = [];
    const resolver: EgressResolver = async () => [{ address: '93.184.215.14', family: 4 }];
    const transport: EgressTransport = async request => {
      hits.push(request.url.pathname);
      const ok = request.url.pathname.startsWith('/api/');
      return { status: ok ? 200 : 404, headers: { 'content-type': ok ? 'application/json' : 'text/html', 'access-control-allow-origin': '*' }, body: Buffer.from(ok ? '{"canary":"CANARY_99"}' : '<!doctype html><title>CANARY_98</title>') };
    };
    const egress = { allowHosts: ['good.review-egress.com'] };
    const review = createWorkbenchReviewService({
      dataDir: data,
      projectInputs: () => ({ root: FIXTURE, context: null, rubric: null }),
      createPort: (root, policy) => createCdpReviewPort(root, { profileRoot: path.join(tmpdir(), 'od-review-test-profiles'), ...(policy ? { egress: policy } : {}), egressOptions: { resolver, transport } }),
    });
    const app = express(); app.use(express.json());
    registerWorkbenchReviewRoutes(app, { http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) }, authorizeProjectRequest: async () => true, assertProject: () => undefined, review });
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    // Every line the daemon writes while the review runs.
    const logged: string[] = [];
    const methods = ['log', 'info', 'warn', 'error', 'debug'] as const;
    const originals = methods.map(name => console[name]);
    const writes = [process.stdout.write.bind(process.stdout), process.stderr.write.bind(process.stderr)];
    methods.forEach(name => { console[name] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); }; });
    process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return (writes[0] as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: unknown, ...rest: unknown[]) => { logged.push(String(chunk)); return (writes[1] as (...a: unknown[]) => boolean)(chunk, ...rest); }) as typeof process.stderr.write;
    let posted: unknown;
    try {
      const response = await fetch(`${url}/api/workbench/projects/audit/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entry: 'index.html', egress }) });
      expect(response.status).toBe(200);
      posted = await response.json();
    } finally {
      methods.forEach((name, index) => { console[name] = originals[index]!; });
      process.stdout.write = writes[0] as typeof process.stdout.write;
      process.stderr.write = writes[1] as typeof process.stderr.write;
    }
    try {
      const bundle: VerificationBundle = parseVerificationBundle(posted);
      if (bundleOut) await writeFile(bundleOut, `${JSON.stringify(bundle, null, 2)}\n`);
      // The page really ran: it has findings and allowed-host fetches, so the outputs are not trivially empty.
      expect(bundle.results.some(result => result.outcome !== 'pass')).toBe(true);
      expect(hits.length).toBeGreaterThan(0);
      expect((bundle.console?.entries.length ?? 0)).toBeGreaterThan(0);

      const reviewerInput = buildReviewerInput({ projectId: 'audit', runId: 'rr_audit', entry: 'index.html', rubric: null, context: null, reviewedCheckIds: bundle.results.map(result => result.checkId), bundle, screenshots: [] });
      // R03 evidence detail: the new detail and visual-<width> facts are present, so the audit covers them.
      expect(bundle.evidence.some(item => /^visual-\d+$/u.test(item.id) && item.detail?.length)).toBe(true);
      expect(bundle.evidence.filter(item => item.detail?.length).length).toBeGreaterThan(bundle.viewports.length);
      // Every provider request as it would be sent (DeepSeek and Claude prompts, Jev's System One body); no provider is called.
      const prompts: string[] = [];
      const deepseekPrompt = buildReviewPrompt('deepseek-adversarial', reviewerInput); prompts.push(deepseekPrompt.system, deepseekPrompt.user);
      await createClaudeVisualReviewer({ resolveBin: () => 'claude', workDir: () => path.join(data, 'critic'), run: async request => { prompts.push(request.stdin); return { exitCode: 1, stderr: '', stdout: '' }; } }).review(reviewerInput, new AbortController().signal).catch(() => undefined);
      await createJevReviewer({ apiKey: async () => 'k', fetchImpl: (async (_url: string, init: RequestInit) => { prompts.push(String(init.body)); return new Response('{}', { status: 500 }); }) as typeof fetch }).review(reviewerInput, new AbortController().signal).catch(() => undefined);
      expect(prompts).toHaveLength(4);
      const read = await (await fetch(`${url}/api/workbench/projects/audit/review/bundles/${bundle.id}`)).text();
      const output: unknown[] = [];
      expect(await runReviewCli(['get', '--project', 'audit', '--bundle', bundle.id, '--json'], { env: { OD_DAEMON_URL: url }, write: value => output.push(value) })).toBe(0);

      // Everything the review persisted under the daemon data root, read back as stored.
      const persisted: string[] = [];
      for (const entry of await readdir(data, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) persisted.push(`${entry.name}\n${await readFile(path.join(entry.parentPath, entry.name), 'utf8')}`);
      }
      expect(persisted.some(file => file.includes(bundle.id))).toBe(true);

      const surfaces: Record<string, string> = {
        bundle: JSON.stringify(bundle), rendered: JSON.stringify(readable(bundle)), persisted: persisted.join('\n'), reviewerInput: JSON.stringify(reviewerInput), prompts: prompts.join('\n'), logs: logged.join('\n'), http: read, cli: JSON.stringify(output),
      };
      const leaks = Object.entries(surfaces).flatMap(([name, text]) => [...text.matchAll(/.{0,60}canary.{0,30}/giu)].map(match => `${name}: ${match[0]}`));
      expect(leaks, 'canaries reached review outputs').toEqual([]);
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 300_000);
});
