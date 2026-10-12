import { fingerprintDigest } from '../../benchmarks/quality/fingerprint.ts';
import { test, expect } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runBenchmark } from '../../benchmarks/quality/run.ts';
import { startStub } from '../../benchmarks/quality/stub.ts';
import { verifyFiles } from '../../benchmarks/quality/packet.ts';
test('checks frozen briefs and copied bytes before provider egress or scoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-packet-')); const stub = await startStub();
  try {
    const out = join(root, 'run'); const run = await runBenchmark({ daemon: stub.url, out, agent: 'stub', model: 'stub', timeoutMs: 1000, mode: 'stub', caseId: 'dental' });
    await expect(verifyFiles(out, run)).resolves.toBeUndefined();
    await writeFile(join(out, 'cases/dental/files/index.html'), '<h1>Edited after capture</h1>');
    await expect(verifyFiles(out, run)).rejects.toThrow(/artifact changed/);
  } finally { await stub.close(); await rm(root, { recursive: true, force: true }); }
});

test('refuses old captures and altered fingerprint settings before reading screenshots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'quality-packet-')); const stub = await startStub();
  try {
    const out = join(root, 'run'); const run = await runBenchmark({ daemon: stub.url, out, agent: 'stub', model: 'stub', timeoutMs: 1000, mode: 'stub', caseId: 'dental' });
    await expect(verifyFiles(out, run, { schema: 'quality-captures/1', runId: run.runId, facts: [], browser: 'stub', captureProtocolDigest: 'stub' } as unknown as import('../../benchmarks/quality/types.ts').Captures)).rejects.toThrow(/schema/);
    run.fingerprint.captureSettings = { ...run.fingerprint.captureSettings, motionSampleFrames: 13 } as unknown as typeof run.fingerprint.captureSettings;
    expect(fingerprintDigest(run.fingerprint)).not.toBe(run.fingerprint.digest);
    await expect(verifyFiles(out, run)).rejects.toThrow(/fingerprint/i);
  } finally { await stub.close(); await rm(root, { recursive: true, force: true }); }
});
