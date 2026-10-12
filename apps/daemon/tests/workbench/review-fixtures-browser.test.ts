import { readable, text } from './review-capture-fixture.js';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findBrowserExecutable } from '../../src/browser-sessions.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { expectationFor, REVIEW_FIXTURE_ROOT, REVIEW_FIXTURES, REVIEW_LOCATOR_FIXTURES } from './review-fixture-expectations.js';

// Real-browser fixture runs (AC-R03.4 fixture outcomes, AC-R06.2). They launch
// a headless Chrome/Edge/Chromium, so they run on the gate box only:
//   OD_REVIEW_BROWSER_TESTS=1 pnpm exec vitest run tests/workbench/review-fixtures-browser.test.ts
// Opting in without a browser fails loudly instead of skipping.
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';

describe.skipIf(!optedIn)('mechanical fixtures in a real browser', () => {
  it('has a capable browser on this host', () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
  });

  for (const name of [...REVIEW_FIXTURES, ...REVIEW_LOCATOR_FIXTURES]) {
    it(`${name} produces its expected mechanical outcome`, async () => {
      const expected = expectationFor(name);
      const bundle = await runMechanicalReview({ projectId: 'fixture', entry: 'index.html', rubric: null, context: null, port: createCdpReviewPort(path.join(REVIEW_FIXTURE_ROOT, name), { profileRoot: path.join(tmpdir(), 'od-review-test-profiles') }) });
      const actual = Object.fromEntries(bundle.results.map(result => [result.criterionId, result.outcome]));
      const detail = bundle.results.filter(result => result.outcome !== expected.criteria[result.criterionId!]).map(result => `${result.criterionId}: ${result.outcome} — ${text(result.reason)}`).join('\n');
      expect(actual, detail).toEqual(expected.criteria);
      expect(bundle.outcome).toBe(expected.outcome);
      expect(bundle.environment.worker).toBe('cdp-chromium');
      expect(bundle.viewports).toEqual([320, 375, 768, 1440]);
      expect(bundle.sourceHashes.map(item => item.path)).toContain('index.html');
      const rendered = JSON.stringify(readable(bundle));
      for (const needle of expected.evidenceIncludes ?? []) expect(rendered, needle).toContain(needle);
      for (const needle of expected.evidenceExcludes ?? []) expect(`${rendered} ${JSON.stringify(bundle)}`, needle).not.toContain(needle);
      if (name === 'overflow-320') {
        const overflow = bundle.results.find(result => result.criterionId === 'core.responsive-overflow')!;
        const failing = bundle.evidence.filter(item => overflow.evidenceIds.includes(item.id) && text(item.summary).startsWith('fail')).map(item => item.viewport);
        expect(failing).toEqual([320]);
      }
    }, 120_000);
  }
});
