import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseVerificationBundle, type ReviewEgressFetch, type RunMechanicalReviewRequest } from '@open-design/contracts';
import { registerWorkbenchReviewRoutes } from '../../src/routes/workbench-review.js';
import { runReviewCli } from '../../src/workbench/review-cli.js';
import { egressDigest, type EgressSummary } from '../../src/workbench/review/egress.js';
import { createReviewEvidenceStore, legacyProjection } from '../../src/workbench/review/evidence-store.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { createWorkbenchReviewService } from '../../src/workbench/review/service.js';
import type { ReviewBrowserPort, ViewportCapture } from '../../src/workbench/review/types.js';
import { knownGoodCapture, page, portFrom, resourceType, text, url, vouch } from './review-capture-fixture.js';
import { addressParam, ev, hostParam } from '../../src/workbench/review/evidence.js';
import { bootReviewRuns } from './review-run-fixture.js';

// B4-2 / AC-R06.2 external-resource pages, runner and surface half.

const base = { projectId: 'p', entry: 'index.html', rubric: null, context: null, clock: () => new Date('2026-10-07T08:00:00.000Z'), newId: () => 'rv_egress' } as const;
const consoleCheck = (bundle: Awaited<ReturnType<typeof runMechanicalReview>>) => bundle.results.find(result => result.criterionId === 'core.console-resources')!;
const fetched = (overrides: Partial<ReviewEgressFetch> = {}): ReviewEgressFetch => ({
  origin: 'https://fonts.example-cdn.com', pathDepth: 1, pathDepthCapped: false, pathQuerySha256: 'e'.repeat(64), queryLength: 0, host: 'fonts.example-cdn.com', resourceType: 'Stylesheet', outcome: 'fetched', reason: null,
  resolvedAddress: '93.184.215.14', status: 200, bytes: 16, sha256: 'c'.repeat(64), durationMs: 3, redirects: [], ...overrides,
});
const summary = (overrides: Partial<EgressSummary> = {}): EgressSummary => ({
  allowHosts: ['fonts.example-cdn.com'], limits: { maxRequests: 200, maxBytes: 20 * 1024 * 1024, maxResponseBytes: 5 * 1024 * 1024, requestTimeoutMs: 10_000, maxRedirects: 5 },
  fetches: [fetched()], requests: 1, bytes: 16, exhausted: null, ...overrides,
});

/** A fake port whose session reports what its egress session did. */
function egressPort(capture: (width: number) => ViewportCapture, egress: EgressSummary): ReviewBrowserPort {
  const port = portFrom(capture);
  return { ...port, async open() { const session = await port.open(); return { ...session, egress: () => egress }; } };
}

describe('runner: egress evidence and verdicts', () => {
  it('characterization: by default an external resource stays inconclusive and the bundle records an empty allow-list', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, port: portFrom(width => knownGoodCapture(width, capture => {
      capture.blockedRequests = [{ url: url('https://fonts.example-cdn.com/a.css'), resourceType: resourceType('Stylesheet') }];
    })) }));
    expect(consoleCheck(bundle).outcome).toBe('inconclusive');
    expect(text(consoleCheck(bundle).reason)).toMatch(/egress/u);
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.egress).toMatchObject({ allowHosts: [], fetches: [], requests: 0, exhausted: null });
    expect(bundle.egress!.digest).toBe(egressDigest(bundle.egress!));
  });

  it('records every allowed fetch in the bundle, covered by its digest, and cites it from the resource check', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width), summary()) }));
    expect(bundle.outcome).toBe('passed');
    expect(bundle.egress).toMatchObject({ allowHosts: ['fonts.example-cdn.com'], fetches: [fetched()], requests: 1, bytes: 16 });
    expect(bundle.egress!.digest).toBe(egressDigest(bundle.egress!));
    const evidence = bundle.evidence.find(item => item.id === 'egress')!;
    expect(evidence).toMatchObject({ type: 'network', viewport: null });
    expect(text(evidence.observations[0])).toMatch(/fetched https:\/\/fonts\.example-cdn\.com\/~redacted:d1:eeeeeeeeeeee .*93\.184\.215\.14 .*200/u);
    expect(consoleCheck(bundle).evidenceIds).toContain('egress');
  });

  it('a spent egress budget makes every check inconclusive, never passed', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width), summary({ exhausted: ev('egress.requestLimit', 200) })) }));
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.results.every(result => result.outcome === 'inconclusive' && /egress/u.test(text(result.recovery)))).toBe(true);
    expect(bundle.evidence.some(item => item.id === 'egress-limit')).toBe(true);
  });

  it('an external resource whose bytes changed during the review makes the run inconclusive', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width), summary({ fetches: [fetched(), fetched({ sha256: 'd'.repeat(64) })], requests: 2 })) }));
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.results.every(result => result.outcome === 'inconclusive')).toBe(true);
    expect(text(bundle.evidence.find(item => item.id === 'egress-integrity')?.observations[0])).toMatch(/fonts\.example-cdn\.com\/~redacted:d1:eeeeeeeeeeee/u);
  });

  it('W2: the same path with different query strings is two resources, not a changed one', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width), summary({ fetches: [
      fetched({ queryLength: 8, pathQuerySha256: 'a'.repeat(64) }),
      fetched({ queryLength: 8, pathQuerySha256: 'b'.repeat(64), sha256: 'd'.repeat(64) }),
      fetched({ queryLength: 8, pathQuerySha256: 'a'.repeat(64) }),
    ], requests: 3 })) }));
    expect(bundle.evidence.some(item => item.id === 'egress-integrity')).toBe(false);
    expect(bundle.outcome).toBe('passed');
  });

  it('a refused allowed-host request keeps its reason and stays inconclusive; a fallback never satisfies the check', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width, capture => {
      capture.blockedRequests = [{ url: url('https://fonts.example-cdn.com/a.woff2', vouch([], ['https://fonts.example-cdn.com'])), resourceType: resourceType('Font'), reason: ev('egress.privateAddress', hostParam('fonts.example-cdn.com'), addressParam('10.0.0.5')) }];
      // The page still rendered with a fallback font.
      capture.fonts = [{ family: page('system-ui'), status: 'loaded' }];
    }), summary({ fetches: [fetched({ outcome: 'refused', reason: ev('egress.privateAddress', hostParam('fonts.example-cdn.com'), addressParam('10.0.0.5')), resolvedAddress: null, status: null, bytes: 0, sha256: null })] })) }));
    expect(consoleCheck(bundle).outcome).toBe('inconclusive');
    expect(text(consoleCheck(bundle).reason)).toMatch(/non-public address/u);
  });

  it('NIT-a: a button that navigates to an external host says click navigations are never followed', async () => {
    const bundle = parseVerificationBundle(await runMechanicalReview({ ...base, egress: { allowHosts: ['shop.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width, capture => {
      capture.actions[1] = { ...capture.actions[1]!, kind: 'button', clickEffect: { target: 'same', domMutations: 0, navigated: false, submissionCaptured: false, externalBlocked: true, error: null } };
    }), summary({ allowHosts: ['shop.example-cdn.com'], fetches: [] })) }));
    const actions = bundle.results.find(result => result.criterionId === 'core.declared-actions')!;
    expect(actions.outcome).toBe('inconclusive');
    expect(text(actions.reason)).toMatch(/click navigations are never followed/u);
  });

  it('judges an external link destination on an allowed host by its fetched status', async () => {
    const withLink = (destination: ViewportCapture['actions'][number]['destination']) => runMechanicalReview({ ...base, egress: { allowHosts: ['shop.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width, capture => {
      capture.actions[0] = { ...capture.actions[0]!, href: url('https://shop.example-cdn.com/gift', vouch([], ['https://shop.example-cdn.com'])), destination };
    }), summary({ allowHosts: ['shop.example-cdn.com'], fetches: [] })) });
    const actions = async (destination: ViewportCapture['actions'][number]['destination']) => (await withLink(destination)).results.find(result => result.criterionId === 'core.declared-actions')!;
    expect((await actions({ kind: 'external', status: 200 })).outcome).toBe('pass');
    expect((await actions({ kind: 'external', status: 404 })).outcome).toBe('fail');
    expect((await actions({ kind: 'external', reason: ev('egress.requestTimeout', hostParam('shop.example-cdn.com'), 10000) })).outcome).toBe('inconclusive');
    expect((await actions({ kind: 'external' })).outcome).toBe('inconclusive');
  });
});

describe('frozen evidence integrity', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it('refuses a stored bundle whose egress records were edited after the digest was taken', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'od-egress-store-')); dirs.push(data);
    const store = createReviewEvidenceStore(data);
    const bundle = await runMechanicalReview({ ...base, egress: { allowHosts: ['fonts.example-cdn.com'] }, port: egressPort(width => knownGoodCapture(width), summary()) });
    await store.save(bundle);
    expect(await store.read('p', bundle.id)).toEqual(bundle);
    const [file] = (await readdir(path.join(data, 'workbench-review', 'projects'), { recursive: true })).map(String).filter(name => name.endsWith(`${bundle.id}.json`));
    const target = path.join(data, 'workbench-review', 'projects', file!);
    const stored = JSON.parse(await readFile(target, 'utf8'));
    stored.egress.fetches[0].status = 404;
    await writeFile(target, JSON.stringify(stored));
    await expect(store.read('p', bundle.id)).rejects.toThrow(/digest/u);
    expect(await store.list('p')).toEqual([]);
  });
});

describe('surfaces: HTTP and od CLI carry the same per-run allow-list', () => {
  let server: Server | undefined; const dirs: string[] = [];
  afterEach(async () => {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
    await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
  });

  async function boot() {
    const data = await mkdtemp(path.join(tmpdir(), 'od-egress-routes-')); dirs.push(data);
    const ports: (RunMechanicalReviewRequest['egress'] | undefined)[] = [];
    const review = createWorkbenchReviewService({
      dataDir: data, projectInputs: () => ({ root: path.join(data, 'root'), context: null, rubric: null }),
      createPort: (_root, egress) => { ports.push(egress); return portFrom(width => knownGoodCapture(width)); },
    });
    const app = express(); app.use(express.json());
    registerWorkbenchReviewRoutes(app, {
      http: { sendApiError: (res, status, code, message, init = {}) => res.status(status).json({ error: { code, message, ...init } }) },
      authorizeProjectRequest: async () => true, assertProject: () => undefined, review,
    });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const output: unknown[] = [];
    const cli = (args: string[]) => runReviewCli(args, { env: { OD_DAEMON_URL: url }, write: value => output.push(value) });
    const post = (body: unknown) => fetch(`${url}/api/workbench/projects/p/review/mechanical`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { ports, output, cli, post };
  }

  it('passes the same allow-list to the evidence worker from HTTP and from `od workbench review run --allow-host`', async () => {
    const { ports, cli, output, post } = await boot();
    const response = await post({ entry: 'index.html', egress: { allowHosts: ['fonts.example-cdn.com', 'cdn.example-cdn.com:8443'] } });
    expect(response.status).toBe(200);
    const http = parseVerificationBundle(await response.json());
    expect(await cli(['run', '--project', 'p', '--allow-host', 'fonts.example-cdn.com', '--allow-host', 'cdn.example-cdn.com:8443', '--json'])).toBe(0);
    const viaCli = parseVerificationBundle(output.pop());
    expect(ports).toEqual([{ allowHosts: ['fonts.example-cdn.com', 'cdn.example-cdn.com:8443'] }, { allowHosts: ['fonts.example-cdn.com', 'cdn.example-cdn.com:8443'] }]);
    expect(viaCli.egress?.allowHosts).toEqual(http.egress?.allowHosts);
    // Default: no list, no egress.
    expect(await cli(['run', '--project', 'p', '--json'])).toBe(0);
    expect(ports[2]).toBeUndefined();
  });

  it('refuses a bad host before any run, with the reason, on both surfaces', async () => {
    const { ports, cli, output, post } = await boot();
    for (const host of ['*.example-cdn.com', '127.0.0.1', 'localhost', 'https://fonts.example-cdn.com']) {
      const response = await post({ egress: { allowHosts: [host] } });
      expect(response.status, host).toBe(400);
      const body = await response.json() as { error: { details?: { fields?: { path: string; message: string }[] } } };
      expect(body.error.details?.fields?.[0]?.path, host).toBe('egress.allowHosts.0');
      expect(await cli(['run', '--project', 'p', '--allow-host', host, '--json']), host).toBe(2);
      expect(JSON.stringify(output.pop())).toMatch(/invalid-cli-input/u);
    }
    expect(ports).toEqual([]);
  });
});

describe('N3: the mechanical service re-validates the allow-list it is handed', () => {
  it('refuses an allow-list that bypassed the request contract, before any browser starts', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'od-egress-n3-'));
    try {
      let ports = 0;
      const review = createWorkbenchReviewService({ dataDir: data, projectInputs: () => ({ root: data, context: null, rubric: null }), createPort: () => { ports++; return portFrom(width => knownGoodCapture(width)); } });
      await expect(review.run('p', { entry: 'index.html', egress: { allowHosts: ['169.254.169.254'] } } as RunMechanicalReviewRequest)).rejects.toThrow(/allow-list/u);
      expect(ports).toBe(0);
    } finally { await rm(data, { recursive: true, force: true }); }
  });
});

describe('N2: a run checks its frozen egress digest against the stored evidence on read', () => {
  it('marks the run outdated when the stored bundle no longer carries the frozen digest, or cannot be verified', async () => {
    const slice = await bootReviewRuns();
    try {
      const response = await slice.start({ egress: { allowHosts: ['fonts.example-cdn.com'] }, reviewerPlan: { reviewers: [] } });
      const { run } = await response.json() as { run: { id: string } };
      await slice.runs.idle();
      expect((await slice.show(run.id)).freshness.reasons.join(' ')).not.toMatch(/egress/u);
      const files = (await readdir(path.join(slice.data, 'workbench-review', 'projects'), { recursive: true })).map(String).filter(name => /rv_[^/]*\.json$/u.test(name));
      const target = path.join(slice.data, 'workbench-review', 'projects', files[0]!);
      const stored = JSON.parse(await readFile(target, 'utf8'));
      // A self-consistent replacement: valid digest, different from the one the run froze.
      stored.egress.requests = 7;
      const { digest: _old, ...rest } = stored.egress;
      stored.egress.digest = egressDigest(rest);
      await writeFile(target, JSON.stringify(stored));
      const swapped = await slice.show(run.id);
      expect(swapped.freshness.state).toBe('outdated');
      expect(swapped.freshness.reasons.join(' ')).toMatch(/egress digest/u);
      // Corrupted records (digest no longer matches) cannot be verified at all.
      stored.egress.requests = 8;
      await writeFile(target, JSON.stringify(stored));
      const corrupted = await slice.show(run.id);
      expect(corrupted.freshness.state).toBe('outdated');
      expect(corrupted.freshness.reasons.join(' ')).toMatch(/could not be verified/u);
    } finally { await slice.close(); }
  });
});

describe('collect-review runs freeze the allow-list', () => {
  it('freezes the hosts at start, hands them to the evidence worker, and records the evidence digest; CLI start takes --allow-host', async () => {
    const egressSeen: unknown[] = [];
    const slice = await bootReviewRuns({ onPortEgress: egress => egressSeen.push(egress) });
    try {
      const response = await slice.start({ egress: { allowHosts: ['fonts.example-cdn.com'] }, reviewerPlan: { reviewers: [] } });
      expect(response.status).toBe(202);
      const started = await response.json() as { run: { id: string; frozen: { egress?: unknown } } };
      expect(started.run.frozen.egress).toEqual({ allowHosts: ['fonts.example-cdn.com'], fetchDigest: null });
      await slice.runs.idle();
      const done = await slice.show(started.run.id);
      expect(egressSeen).toEqual([{ allowHosts: ['fonts.example-cdn.com'] }]);
      expect(done.run.frozen.egress?.fetchDigest).toMatch(/^[0-9a-f]{64}$/u);

      expect(await slice.cli(['start', '--project', 'p', '--input-file', '-', '--allow-host', 'fonts.example-cdn.com', '--json'], JSON.stringify({ snapshot: { entry: 'index.html' }, rubricRevision: 2, reviewerPlan: { reviewers: [] } }))).toBe(0);
      await slice.runs.idle();
      expect(egressSeen[1]).toEqual({ allowHosts: ['fonts.example-cdn.com'] });
      expect(await slice.cli(['start', '--project', 'p', '--input-file', '-', '--allow-host', 'a.example-cdn.com', '--json'], JSON.stringify({ snapshot: { entry: 'index.html' }, rubricRevision: 2, egress: { allowHosts: ['b.example-cdn.com'] } }))).toBe(2);
    } finally { await slice.close(); }
  });
});

describe('every previously written bundle version stays readable (Sol round 5 BLOCK + captain addendum)', () => {
  const fixtureDir = path.resolve(import.meta.dirname, '../fixtures/workbench/review-bundles');
  /** Frozen bundles, each validated by its own historical contract when it was generated. */
  const FIXTURES = [
    { file: 'no-egress-main.json', id: 'rv_legacy_no_egress', egress: undefined },
    { file: 'egress-v1-unversioned.json', id: 'rv_legacy_egress_v1a', egress: 'unversioned' },
    { file: 'egress-v1-query.json', id: 'rv_legacy_egress_v1b', egress: 'unversioned' },
    { file: 'egress-v2.json', id: 'rv_legacy_egress_v2', egress: 'workbench-review-egress/2' },
  ] as const;
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

  it('the store verifies each frozen bundle in its stored form, then the store, HTTP and the CLI serve a redacted projection (round 7)', async () => {
    const data = await mkdtemp(path.join(tmpdir(), 'od-egress-legacy-')); dirs.push(data);
    const dir = path.join(data, 'workbench-review', 'projects', createHash('sha256').update('legacy-project', 'utf8').digest('hex').slice(0, 32));
    await mkdir(dir, { recursive: true });
    const bundles = new Map<string, unknown>();
    for (const fixture of FIXTURES) {
      const legacy = JSON.parse(await readFile(path.join(fixtureDir, fixture.file), 'utf8'));
      expect(legacy.id, fixture.file).toBe(fixture.id);
      expect(legacy, fixture.file).not.toHaveProperty('console');
      if (fixture.egress === undefined) expect(legacy).not.toHaveProperty('egress');
      else if (fixture.egress === 'unversioned') expect(legacy.egress).not.toHaveProperty('schema');
      else expect(legacy.egress.schema).toBe(fixture.egress);
      expect(parseVerificationBundle(legacy), fixture.file).toEqual(legacy);
      await writeFile(path.join(dir, `${fixture.id}.json`), JSON.stringify(legacy));
      // What a reader is served: the projection, never the raw stored URLs or reasons.
      const projected = legacyProjection(parseVerificationBundle(legacy));
      expect(parseVerificationBundle(projected), fixture.file).toEqual(projected);
      expect(projected.egress?.digest, fixture.file).toBe(legacy.egress?.digest);
      expect(projected.legacy, fixture.file).toBe(true);
      expect(JSON.stringify(projected), fixture.file).not.toMatch(/\/css\/site\.css|\/start\.css/u);
      bundles.set(fixture.id, projected);
    }
    const store = createReviewEvidenceStore(data);
    for (const [id, projected] of bundles) expect(await store.read('legacy-project', id), id).toEqual(projected);
    expect((await store.list('legacy-project')).map(item => item.id).sort()).toEqual([...bundles.keys()].sort());

    const review = createWorkbenchReviewService({ dataDir: data, projectInputs: () => ({ root: data, context: null, rubric: null }), createPort: () => portFrom(width => knownGoodCapture(width)) });
    const app = express(); app.use(express.json());
    registerWorkbenchReviewRoutes(app, { http: { sendApiError: (res, status, code, message) => res.status(status).json({ error: { code, message } }) }, authorizeProjectRequest: async () => true, assertProject: () => undefined, review });
    const server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
    try {
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      for (const [id, legacy] of bundles) {
        const response = await fetch(`${url}/api/workbench/projects/legacy-project/review/bundles/${id}`);
        expect(response.status, id).toBe(200);
        expect(await response.json(), id).toEqual(legacy);
        const output: unknown[] = [];
        expect(await runReviewCli(['get', '--project', 'legacy-project', '--bundle', id, '--json'], { env: { OD_DAEMON_URL: url }, write: value => output.push(value) }), id).toBe(0);
        expect(output.pop(), id).toEqual(legacy);
      }
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  });

  it('a corrupted legacy egress section is still refused by its digest', async () => {
    const legacy = JSON.parse(await readFile(path.join(fixtureDir, 'egress-v1-query.json'), 'utf8'));
    legacy.egress.requests = 99;
    const data = await mkdtemp(path.join(tmpdir(), 'od-egress-legacy-bad-')); dirs.push(data);
    const dir = path.join(data, 'workbench-review', 'projects', createHash('sha256').update('legacy-project', 'utf8').digest('hex').slice(0, 32));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, `${legacy.id}.json`), JSON.stringify(legacy));
    await expect(createReviewEvidenceStore(data).read('legacy-project', legacy.id)).rejects.toThrow(/digest/u);
  });
});
