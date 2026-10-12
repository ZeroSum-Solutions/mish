import { text } from './review-capture-fixture.js';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { WORKBENCH_MANDATORY_CRITERION_IDS } from '@mish/contracts';
import { createCdpReviewPort } from '../../src/workbench/review/cdp-worker.js';
import { runMechanicalReview } from '../../src/workbench/review/runner.js';
import { classifyStartupFailure } from '../../src/workbench/review/startup.js';
import { expectationFor, REVIEW_EGRESS_FIXTURES, REVIEW_FIXTURE_ROOT, REVIEW_FIXTURES, REVIEW_LOCATOR_FIXTURES, REVIEW_MOTION_EDGE_FIXTURES, REVIEW_MOTION_FIXTURES, motionEdgeExpectationFor } from './review-fixture-expectations.js';

describe('AC-R03.4 mechanical fixtures', () => {
  it('declares exactly the five named fixtures, each with a page and an outcome for every mandatory criterion', () => {
    expect(readdirSync(REVIEW_FIXTURE_ROOT).sort()).toEqual([...REVIEW_FIXTURES, ...REVIEW_EGRESS_FIXTURES, ...REVIEW_LOCATOR_FIXTURES, ...REVIEW_MOTION_FIXTURES, ...REVIEW_MOTION_EDGE_FIXTURES].sort());
    for (const name of REVIEW_FIXTURES) {
      const expected = expectationFor(name);
      expect(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'index.html'), 'utf8')).toMatch(/<!doctype html>/i);
      expect(Object.keys(expected.criteria).sort()).toEqual([...WORKBENCH_MANDATORY_CRITERION_IDS].sort());
      const failing = Object.values(expected.criteria).filter(value => value === 'fail').length;
      expect(expected.outcome).toBe(failing ? 'failed' : 'passed');
      expect(failing).toBe(name === 'known-good' ? 0 : 1);
    }
  });
});

describe('B4-2b motion fixtures', () => {
  it('declares a failing auto carousel and a passing reduced-motion fallback, each passing every mandatory check', () => {
    for (const name of REVIEW_MOTION_FIXTURES) {
      const expected = expectationFor(name);
      expect(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'index.html'), 'utf8')).toMatch(/<!doctype html>/i);
      expect(expected.criteria).toEqual(Object.fromEntries(WORKBENCH_MANDATORY_CRITERION_IDS.map(id => [id, 'pass'])));
      expect(expected.motion).toBe(name === 'auto-carousel' ? 'fail' : 'pass');
      expect(expected.outcome).toBe(expected.motion === 'fail' ? 'failed' : 'passed');
    }
  });

  it('declares each motion edge case with its parameters and one expected motion outcome', () => {
    for (const name of REVIEW_MOTION_EDGE_FIXTURES) {
      const expected = motionEdgeExpectationFor(name);
      expect(readFileSync(path.join(REVIEW_FIXTURE_ROOT, name, 'index.html'), 'utf8'), name).toMatch(/<!doctype html>/i);
      expect(['pass', 'fail', 'inconclusive', 'not-applicable']).toContain(expected.motion);
      expect(Object.keys(expected.parameters).every(key => ['requirePauseControl', 'requireReducedMotionFallback', 'requireLivePreferenceChange'].includes(key))).toBe(true);
    }
  });
});

describe('real CDP port without a capable browser', () => {
  const run = (findExecutable: () => string | null) => runMechanicalReview({ projectId: 'p', entry: 'index.html', rubric: null, context: null, port: createCdpReviewPort(path.join(REVIEW_FIXTURE_ROOT, 'known-good'), { profileRoot: path.join(tmpdir(), 'od-review-test-profiles'), findExecutable }) });

  it('reports inconclusive with setup recovery when no browser is installed', async () => {
    const bundle = await run(() => null);
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.environment).toMatchObject({ worker: 'unavailable', browserVersion: null });
    expect(bundle.results.every(result => result.outcome === 'inconclusive' && /OD_BROWSER_EXECUTABLE_PATH/.test(text(result.recovery)))).toBe(true);
  });

  it('reports inconclusive, not a pass, when the configured browser cannot start', async () => {
    const bundle = await run(() => path.join(REVIEW_FIXTURE_ROOT, 'no-such-browser'));
    expect(bundle.outcome).toBe('inconclusive');
    expect(bundle.results.every(result => result.outcome === 'inconclusive')).toBe(true);
    expect(text(bundle.evidence[0]?.observations[0])).toMatch(/could not start headless \(missing-browser\)/);
    expect(text(bundle.results[0]!.recovery)).toMatch(/executable was not found/);
  });

  it.skipIf(process.platform === 'win32')('classifies a browser that exits at start-up from its own exit status and stderr, logging the stderr only locally (Sol round 9 WARN)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'od-review-fake-browser-'));
    const browser = path.join(dir, 'chrome');
    writeFileSync(browser, '#!/bin/sh\necho "chrome: error while loading shared libraries: libnss3.so: cannot open shared object file STDERR_MARKER_41" >&2\nexit 127\n', { mode: 0o755 });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const bundle = await run(() => browser);
      expect(bundle.results.every(result => result.outcome === 'inconclusive')).toBe(true);
      expect(text(bundle.evidence[0]?.observations[0])).toBe('The installed browser could not start headless (missing-library)');
      expect(text(bundle.results[0]!.recovery)).toMatch(/missing a system library/);
      expect(JSON.stringify(bundle)).not.toMatch(/STDERR_MARKER|libnss3/u);
      expect(warn.mock.calls.map(call => call.join(' ')).join('\n')).toMatch(/missing-library.*STDERR_MARKER_41/su);
    } finally { warn.mockRestore(); rmSync(dir, { recursive: true, force: true }); }
  });

  it.each([
    [{ errno: 'ENOENT' }, 'missing-browser'],
    [{ errno: 'EACCES' }, 'permission-denied'],
    [{ exitCode: 127, stderr: 'x: error while loading shared libraries: libgbm.so.1' }, 'missing-library'],
    [{ exitCode: 1, stderr: 'dyld[123]: Library not loaded: @rpath/Foo.framework' }, 'missing-library'],
    [{ exitCode: 21, stderr: 'The profile appears to be in use by another Chromium process' }, 'profile-locked'],
    [{ exitCode: 1, stderr: 'ERROR: unknown command line flag --headless=new' }, 'unsupported-flag'],
    [{ exitCode: 1, stderr: 'No usable sandbox! Update your kernel' }, 'permission-denied'],
    [{ exitCode: null, signal: 'SIGSEGV', stderr: '' }, 'crashed'],
    [{ exitCode: 134, stderr: '' }, 'crashed'],
    [{ timedOut: true, stderr: '' }, 'timeout'],
    [{ exitCode: 1, stderr: 'something else' }, 'unknown'],
  ] as const)('classifies %j as %s', (signals, expected) => {
    expect(classifyStartupFailure(signals)).toBe(expected);
  });
});
