import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { renderReviewEvidenceText, parseProjectRubric, type ProjectRubric, type VerificationBundle } from '@open-design/contracts';
import { findBrowserExecutable } from '../../src/browser-sessions.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { egressDigest, httpTransport, type EgressResolver, type EgressTransport } from '../../src/workbench/review/egress.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { expectationFor, motionEdgeExpectationFor, REVIEW_FIXTURE_ROOT, REVIEW_MOTION_EDGE_FIXTURES, REVIEW_MOTION_FIXTURES } from './review-fixture-expectations.js';

// B4-2b motion checks in a real headless browser (AC-R06 preamble). Each run
// samples motion for several seconds per width, so these are opt-in like the
// other browser suites:
//   OD_REVIEW_BROWSER_TESTS=1 pnpm exec vitest run tests/workbench/review-motion-browser.test.ts
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';
const profileRoot = path.join(tmpdir(), 'od-review-test-profiles');

function motionRubric(parameters: Record<string, boolean> = {}): ProjectRubric {
  return parseProjectRubric({
    schema: 'workbench-rubric/1', projectId: 'fixture', revision: 1, updatedAt: '2026-10-08T07:00:00.000Z', contextRevision: 1,
    checks: [{
      checkId: 'motion', kind: 'mechanical', required: true, severity: 'high',
      requiredBasis: { type: 'project-acceptance', requirementId: 'motion-policy', rationale: 'Moving content must be controllable and honour reduced motion' },
      provenance: { origin: 'user-confirmed', derivation: 'project-input', source: null, rationale: 'Owner declaration' },
      parameters: { type: 'motion', ...parameters }, evidenceTypes: ['probe'], sourceCriteria: [],
    }],
  });
}

const run = (root: string, rubric: ProjectRubric | null) => runMechanicalReview({ projectId: 'fixture', entry: 'index.html', rubric, context: null, port: createCdpReviewPort(root, { profileRoot }) });
const motionOf = (bundle: VerificationBundle) => bundle.results.find(result => result.checkId === 'motion')!;
const textOf = (value: Parameters<typeof renderReviewEvidenceText>[0]) => renderReviewEvidenceText(value, 'en');
const motionFindings = (bundle: VerificationBundle) => bundle.evidence.filter(item => motionOf(bundle).evidenceIds.includes(item.id)).flatMap(item => item.observations.map(textOf)).join('\n');

describe.skipIf(!optedIn)('motion checks in a real browser', () => {
  const temp: string[] = [];
  afterAll(() => { for (const dir of temp) rmSync(dir, { recursive: true, force: true }); });

  it('has a capable browser on this host', () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
  });

  for (const name of REVIEW_MOTION_FIXTURES) {
    it(`${name} produces its expected motion and mandatory outcomes`, async () => {
      const expected = expectationFor(name);
      const bundle = await run(path.join(REVIEW_FIXTURE_ROOT, name), motionRubric());
      const mandatory = Object.fromEntries(bundle.results.filter(result => result.criterionId).map(result => [result.criterionId, result.outcome]));
      const detail = bundle.results.map(result => `${result.checkId}: ${result.outcome} — ${result.reason}`).join('\n');
      expect(mandatory, detail).toEqual(expected.criteria);
      expect(motionOf(bundle).outcome, `${detail}\n${motionFindings(bundle)}`).toBe(expected.motion);
      expect(bundle.outcome).toBe(expected.outcome);
      expect(bundle.environment.worker).toBe('cdp-chromium');
      const findings = motionFindings(bundle);
      expect(findings).toMatch(/With no motion preference at \d+px, .* kept moving after 5\.0 s/);
      if (name === 'auto-carousel') {
        // W3: opting in to motion never changes what the mandatory checks judge.
        const without = await run(path.join(REVIEW_FIXTURE_ROOT, name), null);
        const mandatoryOf = (value: VerificationBundle) => value.results.filter(result => result.criterionId).map(({ checkId, outcome, reason }) => ({ checkId, outcome, reason }));
        expect(mandatoryOf(bundle)).toEqual(mandatoryOf(without));
        expect(without.results.some(result => result.parameterType === 'motion')).toBe(false);
        expect(findings).toMatch(/No keyboard-reachable control can pause, stop or hide/);
        expect(findings).toMatch(/With prefers-reduced-motion: reduce at \d+px, .* kept moving/);
        expect(findings).toMatch(/switched to reduce mid-session at \d+px, .* kept moving/);
      } else {
        expect(findings).toMatch(/Activating .* by keyboard stopped the motion at 375px/);
        expect(findings).toMatch(/With prefers-reduced-motion: reduce the page stayed still/);
        expect(findings).toMatch(/A live switch to prefers-reduced-motion: reduce stopped the motion/);
      }
    }, 300_000);
  }

  for (const name of REVIEW_MOTION_EDGE_FIXTURES) {
    it(`${name} produces its expected motion outcome`, async () => {
      const expected = motionEdgeExpectationFor(name);
      const bundle = await run(path.join(REVIEW_FIXTURE_ROOT, name), motionRubric(expected.parameters));
      const findings = motionFindings(bundle);
      expect(motionOf(bundle).outcome, `${motionOf(bundle).reason}
${findings}`).toBe(expected.motion);
      expect(findings).toMatch(/at 375px/);
      expect(findings).toMatch(/at 1440px/);
      if (name === 'slow-carousel') {
        expect(findings).toMatch(/switched to reduce mid-session at \d+px, .* kept moving/);
        expect(findings).toMatch(/With prefers-reduced-motion: reduce at \d+px, .* kept moving/);
        expect(findings).toMatch(/was activated by keyboard at \d+px, .* kept moving/);
      }
      if (name === 'shadow-pause' || name === 'implicit-submit') expect(findings).toMatch(/Activating .* by keyboard stopped the motion at 375px/);
      if (name === 'implicit-submit') expect(JSON.stringify(bundle)).not.toMatch(/Stop emails|Pause animation/);
      if (['bg-interval', 'bg-hidden-anim', 'tamper-tiles', 'tile-mask'].includes(name)) {
        // NB2: a pixel-only slideshow next to a busy bar fails both requirements, at each width.
        expect(findings).toMatch(/was activated by keyboard at 375px, .* kept moving/);
        expect(findings).toMatch(/switched to reduce mid-session at 375px, .* kept moving/);
        expect(findings).toMatch(/was activated by keyboard at 1440px, .* kept moving/);
        expect(findings).toMatch(/switched to reduce mid-session at 1440px, .* kept moving/);
      }
      if (name === 'tiny-dot-decoy') {
        // NW3: the pause stops the bar, but the tiny dot's recurring small changes keep counting as motion.
        expect(findings).toMatch(/was activated by keyboard at 375px, .* kept moving/);
        expect(findings).toMatch(/was activated by keyboard at 1440px, .* kept moving/);
      }
      if (name === 'below-fold-canvas') expect(textOf(motionOf(bundle).reason)).toMatch(/canvas|animation-frame/);
      if (name === 'late-start') expect(textOf(motionOf(bundle).reason)).toMatch(/timer/);
      if (name === 'autofocus-static') expect(findings).toMatch(/viewport only/);
    }, 300_000);
  }

  it('gives identical mandatory outcomes with the motion check off and on (worker-carousel)', async () => {
    const root = path.join(REVIEW_FIXTURE_ROOT, 'worker-carousel');
    const off = await run(root, null);
    const on = await run(root, motionRubric(motionEdgeExpectationFor('worker-carousel').parameters));
    const mandatory = (bundle: VerificationBundle) => bundle.results.filter(result => result.criterionId).map(({ checkId, criterionId, outcome, reason, required }) => ({ checkId, criterionId, outcome, reason, required }));
    expect(mandatory(on)).toEqual(mandatory(off));
    expect(on.viewports).toEqual(off.viewports);
    expect(off.results.some(result => result.parameterType === 'motion')).toBe(false);
    expect(motionOf(on).outcome).toBe('fail');
  }, 300_000);

  it('judges the live preference change separately from the reduced-motion load', async () => {
    // The fallback fixture without its matchMedia change listener: its CSS keeps a reduce load static, but after a live
    // switch the auto-advance timer it started keeps jumping the slides.
    const root = mkdtempSync(path.join(tmpdir(), 'od-review-motion-live-')); temp.push(root);
    cpSync(path.join(REVIEW_FIXTURE_ROOT, 'reduced-motion-static'), root, { recursive: true });
    const page = readFileSync(path.join(root, 'index.html'), 'utf8');
    const withoutListener = page.replace(/\n\s*reduce\.addEventListener\('change'[^\n]*/u, '');
    expect(withoutListener).not.toBe(page);
    expect(withoutListener).not.toMatch(/addEventListener\('change'/);
    writeFileSync(path.join(root, 'index.html'), withoutListener);
    const bundle = await run(root, motionRubric({ requirePauseControl: false }));
    const findings = motionFindings(bundle);
    expect(motionOf(bundle).outcome, findings).toBe('fail');
    expect(findings).toMatch(/With prefers-reduced-motion: reduce the page stayed still/);
    expect(findings).toMatch(/switched to reduce mid-session at \d+px, .* kept moving/);
  }, 300_000);

  it('reports a static page as not applicable, never as a pass', async () => {
    const bundle = await run(path.join(REVIEW_FIXTURE_ROOT, 'known-good'), motionRubric());
    expect(motionOf(bundle).outcome, motionFindings(bundle)).toBe('not-applicable');
    expect(motionFindings(bundle)).toMatch(/Nothing kept moving at \d+px after 5\.0 s/);
  }, 300_000);

  it('records allowed-host requests made by motion reloads in their own redacted section, leaving the main egress unchanged', async () => {
    // No real internet: the resolver answers a public address and the transport dials a local stand-in server.
    const server = createServer((req, res) => {
      const pathname = String(req.url).split('?')[0];
      if (pathname === '/site.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('footer p { font-weight: 600; }'); return; }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
    const local = (server.address() as AddressInfo).port;
    try {
      const root = mkdtempSync(path.join(tmpdir(), 'od-review-motion-egress-')); temp.push(root);
      cpSync(path.join(REVIEW_FIXTURE_ROOT, 'external-allowed'), root, { recursive: true });
      const page = readFileSync(path.join(root, 'index.html'), 'utf8');
      const withQuery = page.replace('https://styles.review-egress.com/site.css', 'https://styles.review-egress.com/site.css?v=secret-token#frag');
      expect(withQuery).not.toBe(page);
      writeFileSync(path.join(root, 'index.html'), withQuery);
      const resolver: EgressResolver = async () => [{ address: '93.184.215.14', family: 4 }];
      const transport: EgressTransport = request => httpTransport({ ...request, address: '127.0.0.1', family: 4, url: new URL(`http://${request.url.hostname}:${local}${request.url.pathname}${request.url.search}`) });
      const egress = { allowHosts: ['styles.review-egress.com', 'shop.review-egress.com'] };
      const review = (rubric: ProjectRubric | null) => runMechanicalReview({ projectId: 'fixture', entry: 'index.html', rubric, context: null, egress, port: createCdpReviewPort(root, { profileRoot, egress, egressOptions: { resolver, transport } }) });
      const withMotion = await review(motionRubric());
      const without = await review(null);
      const motionEgress = withMotion.motionEgress as Extract<NonNullable<VerificationBundle['motionEgress']>, { schema: 'workbench-review-egress/4' }>;
      expect(motionEgress.schema).toBe('workbench-review-egress/4');
      const css = motionEgress.fetches.filter(fetch => fetch.origin === 'https://styles.review-egress.com' && fetch.pathDepth === 1);
      expect(css.length, JSON.stringify(motionEgress.fetches)).toBeGreaterThanOrEqual(1);
      expect(css.every(fetch => fetch.outcome === 'fetched' && fetch.status === 200 && fetch.queryLength === 'v=secret-token'.length && fetch.pathQuerySha256 === createHash('sha256').update('/site.css?v=secret-token').digest('hex'))).toBe(true);
      expect(JSON.stringify(motionEgress)).not.toMatch(/secret-token|#frag|site\.css/);
      expect(motionEgress.digest).toBe(egressDigest(motionEgress));
      expect(motionOf(withMotion).evidenceIds).toContain('motion-egress');
      // The motion reloads never spend or appear in the run's own egress.
      const mainOf = (bundle: VerificationBundle) => (bundle.egress as typeof motionEgress).fetches.map(({ origin, pathQuerySha256, outcome, status, queryLength }) => ({ origin, pathQuerySha256, outcome, status, queryLength }));
      expect(mainOf(withMotion)).toEqual(mainOf(without));
      expect(withMotion.egress!.requests).toBe(without.egress!.requests);
      expect(without).not.toHaveProperty('motionEgress');
    } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 300_000);
});
