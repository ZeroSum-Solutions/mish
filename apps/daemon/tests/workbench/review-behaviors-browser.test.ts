import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { verificationBundleSchema } from '@open-design/contracts';
import { findBrowserExecutable } from '../../src/browser-sessions.js';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';

// B5-1 W6: the in-page behavior probe (AC-R06.5) in a real headless browser.
// Opt in like the other browser suites:
//   OD_REVIEW_BROWSER_TESTS=1 pnpm exec vitest run tests/workbench/review-behaviors-browser.test.ts
const optedIn = process.env.OD_REVIEW_BROWSER_TESTS === '1';
const FIXTURE = path.resolve(import.meta.dirname, '../fixtures/workbench/review-behaviors');

describe.skipIf(!optedIn)('observed behaviors in a real browser', () => {
  it('has a capable browser on this host', () => {
    expect(findBrowserExecutable(), 'Install Chrome/Edge/Chromium or set OD_BROWSER_EXECUTABLE_PATH').not.toBeNull();
  });

  it('reports a dialog, a closed <dialog>, tabs, an image and a root-level animation without failing the bundle', async () => {
    const bundle = await runMechanicalReview({ projectId: 'fixture', entry: 'index.html', rubric: null, context: null, port: createCdpReviewPort(FIXTURE, { profileRoot: path.join(tmpdir(), 'od-review-test-profiles') }) });
    expect(verificationBundleSchema.safeParse(bundle).success).toBe(true);
    expect(bundle.environment.worker).toBe('cdp-chromium');
    const by = Object.fromEntries((bundle.observedBehaviors ?? []).map(record => [record.behavior, record]));
    // The open role="dialog" and the closed <dialog> both count: the page supports dialogs.
    expect(by.dialog).toMatchObject({ state: 'observed', count: 2 });
    expect(by.tabs).toMatchObject({ state: 'observed', count: 2 });
    expect(by.image).toMatchObject({ state: 'observed', count: 1 });
    expect(by.animation?.state).toBe('observed');
    // Evidence v2: the root-level animation's target has no structural selector from <body>, so it adds no sample.
    expect(by['text-input']?.state).toBe('not-observed');
    for (const record of bundle.observedBehaviors ?? []) for (const sample of record.samples) expect(['selector', 'token']).toContain(sample.kind);
  }, 120_000);
});
