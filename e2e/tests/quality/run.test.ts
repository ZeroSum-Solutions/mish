import { afterEach, expect, test } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBenchmark } from '../../benchmarks/quality/run.ts';
import { startStub } from '../../benchmarks/quality/stub.ts';

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
test('saves the frozen builds and regression anchor through public APIs and refuses output reuse', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-test-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stub = await startStub(); cleanup.push(stub.close);
  const options = { daemon: stub.url, out: join(root, 'run'), agent: 'stub', model: 'stub', timeoutMs: 1000, pollMs: 1, mode: 'stub' as const };
  const run = await runBenchmark(options);
  expect(run.cases.map(item => item.caseId)).toEqual(['dental', 'restaurant', 'law', 'saas', 'fitness', 'brightwater']);
  expect(run.cases.every(item => item.status === 'succeeded' && item.siteCheck?.ok && item.wallTimeMs >= 0)).toBe(true);
  expect(await readFile(join(options.out, 'cases/dental/files/assets/photo.svg'), 'utf8')).toContain('<svg');
  expect(stub.requests.filter(item => item.method === 'POST').map(item => item.path)).toEqual(Array(6).fill('/api/build-on-brand'));
  await expect(runBenchmark(options)).rejects.toThrow(/EEXIST/);
  expect(stub.requests.filter(item => item.method === 'POST')).toHaveLength(6);
});

test('rejects non-loopback origins before creating output', async () => {
  await expect(runBenchmark({ daemon: 'https://example.com', out: '/unused', agent: 'stub', model: 'stub', timeoutMs: 100 })).rejects.toThrow(/loopback/);
});
test('retains failed generation and refuses traversal paths from the file API', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-test-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stub = await startStub({ status: 'failed', unsafePath: '../escape.html' }); cleanup.push(stub.close);
  const run = await runBenchmark({ daemon: stub.url, out: join(root, 'run'), agent: 'stub', model: 'stub', timeoutMs: 1000, caseId: 'dental', mode: 'stub' });
  expect(run.cases[0]!.failures).toEqual(['Generation failed', 'Unsafe or private artifact path']);
  expect(run.cases[0]!.status).toBe('failed');
});
test('cancels a timed-out owned run and stops if cancellation cannot be verified', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-test-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stub = await startStub({ neverTerminal: true, cancelFails: true }); cleanup.push(stub.close);
  const out = join(root, 'run');
  await expect(runBenchmark({ daemon: stub.url, out, agent: 'stub', model: 'stub', timeoutMs: 50, pollMs: 5, caseId: 'dental', mode: 'stub' })).rejects.toThrow(/cancellation unverified/);
  expect(stub.requests.some(item => item.path.endsWith('/cancel'))).toBe(true);
  expect(await readFile(join(out, 'run.json'), 'utf8')).toContain('Cancellation unverified');
});

test('fingerprints observed inventory and marks unexposed identities unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-fingerprint-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stub = await startStub(); cleanup.push(stub.close);
  const run = await runBenchmark({ daemon: stub.url, out: join(root, 'run'), agent: 'stub', model: 'stub', timeoutMs: 1000, caseId: 'dental', mode: 'stub' });
  const fingerprint = run.fingerprint;
  expect(fingerprint.captureSettings.viewports).toHaveLength(5);
  expect(fingerprint.cases[0]!.kit.id).toBe(run.cases[0]!.kitId);
  expect(fingerprint.cases[0]!.kit.contentHash.status).toBe('unavailable');
  expect(fingerprint.cases[0]!.promptVariant.status).toBe('unavailable');
  const item = fingerprint.cases[0]!;
  expect(item.builder.status).toBe('available');
  if (item.builder.status === 'available') expect(item.builder.value).toEqual({ agent: 'stub', model: 'stub' });
  expect(item.stagedAssets.status).toBe('available');
  if (item.stagedAssets.status === 'available') expect(item.stagedAssets.value).toContainEqual(run.cases[0]!.files.find(file => file.name === 'assets/photo.svg'));
  expect(fingerprint.cases[0]!.fontFiles.status).toBe('unavailable');
  expect(fingerprint.digest).toMatch(/^[a-f0-9]{64}$/);
  const saved = JSON.parse(await readFile(join(root, 'run/run.json'), 'utf8'));
  expect(saved.fingerprint).toEqual(fingerprint);
});

test('hashes kit and font bytes read through public APIs and records exposed prompt identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-fingerprint-')); cleanup.push(() => rm(root, { recursive: true, force: true }));
  const stub = await startStub({ kitFiles: { 'DESIGN.md': 'Kit', 'assets/local.woff2': Buffer.from('font bytes') }, files: { 'assets/local.woff2': Buffer.from('font bytes') }, runMetadata: { strategyRolloutDecision: { path: 'legacy', reason: 'stub fixture' } } }); cleanup.push(stub.close);
  const run = await runBenchmark({ daemon: stub.url, out: join(root, 'run'), agent: 'stub', model: 'stub', timeoutMs: 1000, caseId: 'dental', mode: 'stub' });
  const item = run.fingerprint.cases[0]!;
  expect(item.kit.contentHash.status).toBe('available');
  if (item.kit.files.status === 'available') expect(item.kit.files.value.map(file => file.name)).toEqual(['assets/local.woff2', 'DESIGN.md']);
  expect(item.fontFiles.status).toBe('available');
  if (item.fontFiles.status === 'available') expect(item.fontFiles.value[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(item.promptVariant.status).toBe('available');
  expect(stub.requests.some(request => request.path.endsWith('/static'))).toBe(true);
});
