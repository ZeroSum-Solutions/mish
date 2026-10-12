import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { client, digest } from './api.ts';
import { buildOnBrand } from './builders/build-on-brand.ts';
import type { Builder, BuildInput } from './builders/types.ts';
import { initialFingerprint, kitFingerprint, caseFingerprint, fingerprintDigest } from './fingerprint.ts';
import { selectCases } from './cases.ts';
import type { BenchmarkRun, BriefCase, CaseRun } from './types.ts';
export interface RunOptions {
  daemon: string; out: string; agent: string; model: string; timeoutMs: number;
  pollMs?: number; caseId?: string; kitId?: string; headers?: Record<string, string>; mode?: 'live' | 'stub';
  /** Default build-on-brand, QT's path. compare mode passes chat-run or agency-build. */
  builder?: Builder;
  /** compare mode: the improve-prompt suite instead of the agency suite. */
  suite?: 'agency' | 'improve-prompt';
  /** compare mode: the input each case is built from. */
  inputFor?: (item: BriefCase) => BuildInput;
}
export async function runBenchmark(options: RunOptions): Promise<BenchmarkRun> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0 || !options.agent.trim() || !options.model.trim()) throw new Error('Require agent, model and positive timeout');
  const selected = selectCases(options.caseId, options.kitId, 'dev', options.suite);
  const builder = options.builder ?? buildOnBrand();
  const api = client(options.daemon, options.headers ?? {}, options.timeoutMs);
  // Reserve the output before any request can create a project/run.
  await mkdir(options.out);
  let sourceSha: string | null = null;
  try { sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(); } catch { /* outside a checkout */ }
  const run: BenchmarkRun = {
    schema: 'quality-benchmark/1', runId: randomUUID(), mode: options.mode ?? 'live', startedAt: new Date().toISOString(),
    fixtureDigest: digest(JSON.stringify(selected)), settings: { agent: options.agent, model: options.model, pageCount: 4, useLibrary: true },
    environment: { daemon: options.daemon, health: await api.json('/api/health'), version: await api.json('/api/version'), sourceSha }, cases: [], fingerprint: initialFingerprint(digest(JSON.stringify(selected)), builder.identity),
  };
  const save = () => writeFile(join(options.out, 'run.json'), JSON.stringify(run, null, 2));
  await writeFile(join(options.out, 'cases.json'), JSON.stringify(selected, null, 2));
  await save();
  for (const item of selected) {
    const dir = join(options.out, 'cases', item.id);
    await mkdir(join(dir, 'files'), { recursive: true });
    const result: CaseRun = { caseId: item.id, industry: item.industry, kitId: item.kitId, status: 'admitting', wallTimeMs: 0, files: [], failures: [] };
    run.cases.push(result);
    const kit = await kitFingerprint(api, item.kitId);
    const input = options.inputFor?.(item);
    if (input) result.input = { writer: input.writer, previewSha256: input.preview ? digest(JSON.stringify(input.preview)) : null };
    const startedAt = performance.now();
    let stop = false;
    try {
      ({ stop } = await builder.build({ api, item, dir, result, agent: options.agent, model: options.model, timeoutMs: options.timeoutMs, pollMs: options.pollMs ?? 1000, startedAt, save, ...(input ? { input } : {}) }));
    } finally {
      if (!result.wallTimeMs) result.wallTimeMs = performance.now() - startedAt;
      run.fingerprint.cases.push(caseFingerprint(result, kit));
      run.fingerprint.digest = fingerprintDigest(run.fingerprint);
      await save();
    }
    if (stop) throw new Error('Benchmark stopped: admission or cancellation unverified; see run.json');
  }
  return run;
}
