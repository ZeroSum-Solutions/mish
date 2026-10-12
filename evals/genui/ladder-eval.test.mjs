// node --test evals/genui/ladder-eval.test.mjs
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { BriefSetError, classifyFailure, grade, loadBriefs, outcomeFromSnapshot, summarizeProvider } from './ladder-eval.mjs';

const NINE = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'];
const BRIEFS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'briefs', 'ladder');

function briefsFor(spines) {
  return spines.map((spine, i) => ({ id: `ladder-${i + 1}`, expectedSpine: spine }));
}

function row(seq, provider, expectedSpine, routedSpine, extra = {}) {
  return { seq, provider, briefId: `b${seq}`, expectedSpine, routedSpine, ok: true, wallMs: 1000, ...extra };
}

function rowsFor(spines, provider = 'cerebras') {
  return spines.map((spine, i) => row(i + 1, provider, spine, spine));
}

test('the checked-in brief set loads and expects all nine spines', () => {
  const briefs = loadBriefs(BRIEFS_DIR);
  assert.equal(briefs.length, 20);
  assert.deepEqual([...new Set(briefs.map((b) => b.expectedSpine))].sort(), [...NINE].sort());
});

test('a brief without a sidecar is a brief-set error', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'ladder-eval-'));
  try {
    writeFileSync(path.join(dir, 'ladder-01.txt'), 'A dental practice.');
    writeFileSync(path.join(dir, 'ladder-02.txt'), 'A bistro.');
    writeFileSync(path.join(dir, 'ladder-02.json'), JSON.stringify({ expectedSpine: 'XX' }));
    assert.throws(() => loadBriefs(dir), (e) => e instanceof BriefSetError
      && e.message.includes('no sidecar ladder-01.json')
      && e.message.includes('ladder-02.json: expectedSpine must be one of'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('passes when nothing failed, p50 is under the bar and every spine matched', () => {
  const result = grade({ rows: rowsFor(NINE), briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.equal(result.pass.overall, true);
  assert.equal(result.pass.deepseekP50, null);
  assert.deepEqual(result.mismatches, []);
});

test('fails and lists the build when a routed spine differs from expectedSpine', () => {
  const rows = rowsFor(NINE);
  rows[2] = row(3, 'cerebras', 'CO', 'SM');
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.equal(result.pass.spinesMatched, false);
  assert.equal(result.pass.overall, false);
  assert.deepEqual(result.mismatches, [{ seq: 3, provider: 'cerebras', briefId: 'b3', expectedSpine: 'CO', routedSpine: 'SM', viaSpine: null }]);
});

test('fails when a spine is not expected by any brief that ran', () => {
  const eight = NINE.slice(0, 8);
  const result = grade({ rows: rowsFor(eight), briefs: briefsFor(eight), providers: ['cerebras'] });
  assert.equal(result.pass.allNineSpines, false);
  assert.deepEqual(result.missingSpines, ['MI']);
  assert.equal(result.pass.overall, false);
});

test('fails on a failed build or a p50 over the bar', () => {
  const failed = rowsFor(NINE);
  failed[0] = { ...failed[0], ok: false, status: 'failed', routedSpine: 'TL' };
  assert.equal(grade({ rows: failed, briefs: briefsFor(NINE), providers: ['cerebras'] }).pass.zeroFailed, false);

  const slow = rowsFor(NINE, 'deepseek').map((r) => ({ ...r, wallMs: 7000 }));
  const result = grade({ rows: slow, briefs: briefsFor(NINE), providers: ['deepseek'] });
  assert.equal(result.pass.deepseekP50, false);
  assert.equal(result.pass.overall, false);
});

test('an unrouted build is a failed build with failureClass unrouted', () => {
  const out = outcomeFromSnapshot({ status: 'unrouted', route: { decision: 'unrouted', spine: 'BA' } });
  assert.equal(out.ok, false);
  assert.equal(out.failureClass, 'unrouted');
  const rows = rowsFor(NINE);
  rows[6] = { ...rows[6], ...out };
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.equal(result.pass.zeroFailed, false);
  assert.equal(result.failures.unrouted, 1);
  assert.equal(result.pass.overall, false);
});

test('failures are classified: unrouted, BUILD_FAILED, VERIFY_FAILED, other', () => {
  assert.equal(classifyFailure({ ok: true, routedSpine: 'TL' }), null);
  assert.equal(classifyFailure({ ok: false, status: 'unrouted' }), 'unrouted');
  assert.equal(classifyFailure({ ok: false, status: 'failed', errorClass: 'BUILD_FAILED' }), 'BUILD_FAILED');
  assert.equal(classifyFailure({ ok: false, status: 'failed', errorClass: 'VERIFY_FAILED' }), 'VERIFY_FAILED');
  assert.equal(classifyFailure({ ok: false, status: 'error', errorClass: 'HARNESS_ERROR' }), 'other');
  assert.equal(classifyFailure({ ok: false, status: 'failed', errorClass: 'JEV_UNAVAILABLE' }), 'other');
  const rows = [
    { ...row(1, 'deepseek', 'TL', 'TL'), ok: false, status: 'failed', errorClass: 'BUILD_FAILED' },
    { ...row(2, 'deepseek', 'TL', 'TL'), ok: false, status: 'failed', errorClass: 'VERIFY_FAILED' },
    { ...row(3, 'deepseek', 'BA', null), ok: false, status: 'unrouted' },
    { ...row(4, 'deepseek', 'PA', null), ok: false, status: 'error', errorClass: 'HARNESS_ERROR' },
  ];
  assert.deepEqual(grade({ rows, briefs: briefsFor(NINE), providers: ['deepseek'] }).failures, { unrouted: 1, 'unrouted-record': 0, BUILD_FAILED: 1, VERIFY_FAILED: 1, other: 1 });
});

test('a BUILD_FAILED build with no route is a failure, not a spine mismatch', () => {
  const out = outcomeFromSnapshot({ status: 'failed', error: { code: 'BUILD_FAILED', message: 'x' } });
  assert.equal(out.routedSpine, null);
  assert.equal(out.failureClass, 'BUILD_FAILED');
  const rows = [...rowsFor(NINE), { ...row(10, 'cerebras', 'SM', null), ...out }];
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.pass.zeroFailed, false);
});

test('the spine is graded on viaSpine when the route carries it, and both are reported', () => {
  const out = outcomeFromSnapshot({ status: 'done', family: 'listings', route: { decision: 'routed', family: 'listings', spine: 'TL', viaSpine: 'SM' } });
  assert.equal(out.routedSpine, 'TL');
  assert.equal(out.viaSpine, 'SM');
  const rows = rowsFor(NINE);
  rows[3] = { ...rows[3], ...out };
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.deepEqual(result.mismatches, []);
  assert.equal(result.pass.overall, true);
  // With no viaSpine, the top spine is graded: TL for an SM brief is a mismatch naming both.
  rows[3] = { ...rows[3], viaSpine: null };
  const top = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.deepEqual(top.mismatches, [{ seq: 4, provider: 'cerebras', briefId: 'b4', expectedSpine: 'SM', routedSpine: 'TL', viaSpine: null }]);
  assert.equal(outcomeFromSnapshot({ status: 'done', route: { decision: 'routed', spine: 'CS' } }).viaSpine, null);
});

test('nine-spine coverage is required per provider', () => {
  // Cerebras covers all nine; DeepSeek never gets an ok MI build.
  const deepseek = rowsFor(NINE, 'deepseek').map((r) => (r.expectedSpine === 'MI' ? { ...r, ok: false, status: 'failed', errorClass: 'VERIFY_FAILED' } : r));
  const rows = [...rowsFor(NINE), ...deepseek];
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras', 'deepseek'] });
  assert.deepEqual(result.coverageGaps, [{ provider: 'deepseek', spine: 'MI' }]);
  assert.equal(result.coverage.cerebras.MI, 1);
  assert.equal(result.coverage.deepseek.MI, 0);
  assert.equal(result.pass.perProviderCoverage, false);
  assert.equal(result.pass.overall, false);
  // A provider that ran no build of a spine at all is a gap too.
  const eight = grade({ rows: [...rowsFor(NINE), ...rowsFor(NINE.slice(0, 8), 'deepseek')], briefs: briefsFor(NINE), providers: ['cerebras', 'deepseek'] });
  assert.deepEqual(eight.coverageGaps, [{ provider: 'deepseek', spine: 'MI' }]);
});

test('per-provider stats keep p50 and p95 and count failure classes', () => {
  const rows = Array.from({ length: 20 }, (_, i) => ({ ...row(i + 1, 'cerebras', 'TL', 'TL'), wallMs: (i + 1) * 100 }));
  rows[0] = { ...rows[0], ok: false, status: 'unrouted' };
  const s = summarizeProvider(rows);
  assert.equal(s.p50, 1000);
  assert.equal(s.p95, 1900);
  assert.equal(s.failures.unrouted, 1);
  assert.equal(s.failed, 1);
});

// Review BLOCK 3: a listed provider with no rows fails; it is never a vacuous pass.
test('a provider listed in --providers with zero rows fails the run', () => {
  const result = grade({ rows: rowsFor(NINE), briefs: briefsFor(NINE), providers: ['cerebras', 'deepseek'] });
  assert.deepEqual(result.providersWithoutRows, ['deepseek']);
  assert.equal(result.pass.allProvidersRan, false);
  assert.equal(result.perProvider.deepseek.n, 0);
  assert.equal(result.pass.overall, false);
});

test('coverage also covers a provider that produced rows but was not listed', () => {
  const rows = [...rowsFor(NINE), ...rowsFor(NINE.slice(0, 8), 'deepseek')];
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.deepEqual(result.coverageGaps, [{ provider: 'deepseek', spine: 'MI' }]);
  assert.equal(result.pass.overall, false);
});

// Review BLOCK 4: a done build that lost its route is a failure, not "no mismatch".
test('a done build with no route information fails as unrouted-record', () => {
  const out = outcomeFromSnapshot({ status: 'done', family: 'watson' });
  assert.equal(out.ok, false);
  assert.equal(out.failureClass, 'unrouted-record');
  assert.equal(classifyFailure({ ok: true, status: 'done', routedSpine: null, viaSpine: null }), 'unrouted-record');
  // Even a row that claims ok but has no spine is counted as failed.
  const rows = rowsFor(NINE);
  rows.push({ ...row(10, 'cerebras', 'TL', null), status: 'done' });
  const result = grade({ rows, briefs: briefsFor(NINE), providers: ['cerebras'] });
  assert.equal(result.failures['unrouted-record'], 1);
  assert.equal(result.totalFailed, 1);
  assert.equal(result.pass.zeroFailed, false);
  assert.equal(result.pass.overall, false);
});

test('a dry-run row is never a failure', () => {
  assert.equal(classifyFailure({ ok: true, status: 'skipped', dryRun: true, routedSpine: undefined }), null);
});
