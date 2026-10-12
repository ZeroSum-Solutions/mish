import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseVerificationBundle, type ReviewEgressEvidence } from '@open-design/contracts';
import { findBrowserExecutable } from '../../src/browser-sessions.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { egressDigest, httpTransport, type EgressResolver, type EgressTransport } from '../../src/workbench/review/egress.js';
import { buildReviewerInput } from '../../src/workbench/review/reviewer-plan.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { REVIEW_FIXTURE_ROOT } from './review-fixture-expectations.js';
import { readable, text } from './review-capture-fixture.js';

// B4-2 / AC-R06.2 external-resource pages in a real headless browser. Opt-in
// like the other browser fixtures:
//   OD_REVIEW_BROWSER_TESTS=1 pnpm exec vitest run tests/workbench/review-egress-browser.test.ts
// No real internet: the injected resolver answers public addresses and the
// injected transport dials a local server standing in for the allowed hosts.
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';
const FIXTURE = path.join(REVIEW_FIXTURE_ROOT, 'external-allowed');
interface Case { allowHosts: string[]; privateHosts?: string[]; outcome: string; inconclusive: string[] }
const cases = (JSON.parse(readFileSync(path.join(FIXTURE, 'expected.json'), 'utf8')) as { cases: Record<string, Case> }).cases;

describe.skipIf(!optedIn)('egress allow-list in a real browser', () => {
  let server: Server; let port = 0; const hits: string[] = [];
  beforeAll(async () => {
    server = createServer((req, res) => {
      const host = String(req.headers.host).replace(/:\d+$/u, '');
      hits.push(`${host}${req.url}`);
      if (host === 'styles.review-egress.com' && req.url === '/site.css') { res.writeHead(200, { 'content-type': 'text/css', 'set-cookie': 'track=1' }); res.end('footer p { font-weight: 600; }'); return; }
      if (host === 'shop.review-egress.com' && req.url === '/gift-cards') { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Gift cards</title>'); return; }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it('has a capable browser on this host', () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
  });

  for (const [name, expected] of Object.entries(cases)) {
    it(`${name}: ${expected.outcome}`, async () => {
      hits.length = 0;
      const resolver: EgressResolver = async hostname => [{ address: expected.privateHosts?.includes(hostname) ? '10.0.0.7' : '93.184.215.14', family: 4 }];
      const transport: EgressTransport = request => httpTransport({ ...request, address: '127.0.0.1', family: 4, url: new URL(`http://${request.url.hostname}:${port}${request.url.pathname}${request.url.search}`) });
      const egress = { allowHosts: expected.allowHosts };
      const bundle = parseVerificationBundle(await runMechanicalReview({
        projectId: 'fixture', entry: 'index.html', rubric: null, context: null, egress,
        port: createCdpReviewPort(FIXTURE, { profileRoot: path.join(tmpdir(), 'od-review-test-profiles'), egress, egressOptions: { resolver, transport } }),
      }));
      const open = bundle.results.filter(result => result.outcome !== 'pass').map(result => result.criterionId).sort();
      const detail = bundle.results.filter(result => result.outcome !== 'pass').map(result => `${result.criterionId}: ${result.outcome} — ${text(result.reason)}`).join('\n');
      expect(open, detail).toEqual([...expected.inconclusive].sort());
      expect(bundle.results.filter(result => result.outcome === 'fail'), detail).toEqual([]);
      expect(bundle.outcome).toBe(expected.outcome);
      expect(bundle.egress!.allowHosts).toEqual(expected.allowHosts);
      expect(bundle.egress!.digest).toBe(egressDigest(bundle.egress!));
      if (name === 'default-deny') {
        expect(hits).toEqual([]);
        expect(bundle.egress!.fetches).toEqual([]);
      }
      if (name === 'allowed') {
        // Records v2: origin plus a digest of path and query, never the path itself.
        const sha = (text: string) => createHash('sha256').update(text).digest('hex');
        // Writes are always records v3.
        expect((bundle.egress as { schema?: string }).schema).toBe('workbench-review-egress/4');
        const v3 = bundle.egress as ReviewEgressEvidence;
        const locations = new Set(v3.fetches.map(fetch => `${fetch.origin} ${fetch.pathDepth} ${fetch.pathQuerySha256}`));
        expect(locations).toEqual(new Set([`https://styles.review-egress.com 1 ${sha('/site.css')}`, `https://shop.review-egress.com 1 ${sha('/gift-cards')}`]));
        expect(JSON.stringify(bundle)).not.toMatch(/site\.css|gift-cards/u);
        expect(bundle.egress!.fetches.every(fetch => fetch.outcome === 'fetched' && fetch.resolvedAddress === '93.184.215.14' && fetch.status === 200)).toBe(true);
        // The gift-card destination is probed once per run, not once per width.
        expect(hits.filter(hit => hit.includes('gift-cards'))).toHaveLength(1);
      }
      if (name === 'private-address') {
        expect(hits.some(hit => hit.startsWith('styles.'))).toBe(false);
        expect(bundle.egress!.fetches.some(fetch => fetch.outcome === 'refused' && /non-public address/u.test(text(fetch.reason)))).toBe(true);
      }
    }, 180_000);
  }
});

// Security review of B4-2 (BLOCK B1, WARN W1): turned the reviewer's PoCs into fixtures.
describe.skipIf(!optedIn)('egress security fixtures in a real browser', () => {
  const GOOD = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Good page</title></head><body style="font:16px system-ui;color:#111;background:#fff"><main><h1>Welcome</h1><p>Clean external page.</p><a href="/index.html" style="display:inline-block;padding:12px">Continue</a></main></body></html>';
  const hits: string[] = [];
  const resolver: EgressResolver = async () => [{ address: '93.184.215.14', family: 4 }];
  const transport: EgressTransport = async request => { hits.push(`${request.method} ${request.url.href}`); return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.from(GOOD) }; };
  const casesOf = (name: string) => (JSON.parse(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'expected.json'), 'utf8')) as { cases: Record<string, Case> }).cases;
  const review = async (name: string, allowHosts: string[]) => {
    hits.length = 0;
    const egress = { allowHosts };
    return parseVerificationBundle(await runMechanicalReview({
      projectId: 'fixture', entry: 'index.html', rubric: null, context: null, egress,
      port: createCdpReviewPort(path.join(REVIEW_FIXTURE_ROOT, name), { profileRoot: path.join(tmpdir(), 'od-review-test-profiles'), egress, egressOptions: { resolver, transport } }),
    }));
  };

  for (const [name, expected] of Object.entries(casesOf('main-frame-escape'))) {
    it(`B1 main-frame-escape (${name}): the replaced main frame is never reviewed and the run cannot pass`, async () => {
      const bundle = await review('main-frame-escape', expected.allowHosts);
      const detail = bundle.results.map(result => `${result.criterionId}: ${result.outcome} — ${text(result.reason)}`).join('\n');
      expect(bundle.outcome, detail).toBe(expected.outcome);
      expect(bundle.results.every(result => result.outcome === 'inconclusive'), detail).toBe(true);
      expect(text(bundle.results[0]!.reason)).toMatch(/left the reviewed entry/u);
      // The external document is never fetched into the main frame.
      expect(hits).toEqual([]);
    }, 180_000);
  }

  it('W1 external-get-form: click probes never deliver a GET form to an allowed host', async () => {
    const expected = casesOf('external-get-form').allowed!;
    const bundle = await review('external-get-form', expected.allowHosts);
    expect(hits.filter(hit => hit.includes('/unsubscribe'))).toEqual([]);
    expect(bundle.outcome, bundle.results.filter(result => result.outcome !== 'pass').map(result => `${result.criterionId}: ${result.outcome} — ${text(result.reason)}`).join('\n')).toBe(expected.outcome);
    expect(bundle.results.find(result => result.criterionId === 'core.declared-actions')!.outcome).toBe('inconclusive');
  }, 180_000);
});

// Round 3 of the B4-2 security review (W-A, W-B, NIT-b): one generic runner over the fixtures' expected cases.
interface RoundThreeCase { allowHosts: string[]; outcome?: string; notPassed?: boolean; noHits?: boolean; hitsInclude?: string; allInconclusive?: boolean; reason?: string; notReason?: string; consoleOutcome?: string; blockedReason?: string; secretsAbsent?: string[]; evidenceIncludes?: string }
describe.skipIf(!optedIn)('egress round-3 fixtures in a real browser', () => {
  const PAGE = '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Elsewhere</title></head><body><main><h1>Elsewhere</h1></main></body></html>';
  const hits: string[] = [];
  const resolver: EgressResolver = async () => [{ address: '93.184.215.14', family: 4 }];
  const transport: EgressTransport = async request => { hits.push(`${request.method} ${request.url.pathname}${request.url.search}`); return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'access-control-allow-origin': '*' }, body: Buffer.from(PAGE) }; };
  for (const name of ['js-get-submit', 'pushstate', 'hash-query', 'blob-nav', 'window-open', 'iframe-form-autosubmit', 'subframe-embed', 'redacted-urls', 'iframe-formdata-src', 'meta-refresh-query', 'iframe-script-path', 'page-text-secrets', 'iframe-base-href', 'iframe-base-elsewhere', 'selector-secrets', 'role-secrets', 'console-sourceurl', 'iframe-base-attr-trick']) {
    const cases = (JSON.parse(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'expected.json'), 'utf8')) as { cases: Record<string, RoundThreeCase> }).cases;
    for (const [label, expected] of Object.entries(cases)) {
      it(`${name} (${label})`, async () => {
        hits.length = 0;
        const egress = { allowHosts: expected.allowHosts };
        const bundle = parseVerificationBundle(await runMechanicalReview({
          projectId: 'fixture', entry: 'index.html', rubric: null, context: null, egress,
          port: createCdpReviewPort(path.join(REVIEW_FIXTURE_ROOT, name), { profileRoot: path.join(tmpdir(), 'od-review-test-profiles'), egress, egressOptions: { resolver, transport } }),
        }));
        const detail = bundle.results.map(result => `${result.criterionId}: ${result.outcome} — ${text(result.reason)}`).join('\n');
        const reasons = bundle.results.map(result => text(result.reason)).join('\n');
        if (expected.outcome) expect(bundle.outcome, detail).toBe(expected.outcome);
        if (expected.notPassed) expect(bundle.outcome, detail).not.toBe('passed');
        if (expected.noHits) expect(hits, detail).toEqual([]);
        if (expected.hitsInclude) expect(hits, detail).toContain(expected.hitsInclude);
        // BLOCK 2: what is persisted is the bundle; nothing secret-bearing may appear anywhere in it.
        // ...nor in what reviewers are sent (the UI renders the same bundle fields).
        const reviewerInput = buildReviewerInput({ projectId: 'fixture', runId: 'rr_fixture', entry: 'index.html', rubric: null, context: null, reviewedCheckIds: bundle.results.map(result => result.checkId), bundle, screenshots: [] });
        const persisted = `${JSON.stringify(bundle)} ${JSON.stringify(readable(bundle))} ${JSON.stringify(reviewerInput)}`;
        for (const secret of expected.secretsAbsent ?? []) expect(persisted.includes(secret), `${secret} leaked into the bundle`).toBe(false);
        if (expected.evidenceIncludes) expect(persisted).toContain(expected.evidenceIncludes);
        if (expected.allInconclusive) expect(bundle.results.every(result => result.outcome === 'inconclusive'), detail).toBe(true);
        if (expected.reason) expect(reasons).toContain(expected.reason);
        if (expected.notReason) expect(reasons, detail).not.toContain(expected.notReason);
        const consoleResult = bundle.results.find(result => result.criterionId === 'core.console-resources')!;
        if (expected.consoleOutcome) expect(consoleResult.outcome, detail).toBe(expected.consoleOutcome);
        if (expected.blockedReason) expect(text(consoleResult.reason), detail).toContain(expected.blockedReason);
      }, 180_000);
    }
  }
});
