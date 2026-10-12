import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatRunService } from '../../src/runtimes/runs.js';

const dirs: string[] = [];
afterEach(() => { vi.useRealTimers(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function registry() {
  const runsLogDir = mkdtempSync(path.join(tmpdir(), 'wave-b-run-ttl-')); dirs.push(runsLogDir);
  return createChatRunService({ createSseResponse: () => ({ send: () => true, end() {}, cleanup() {} }), createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }), ttlMs: 100,
    // Match the existing runs tests: ts-nocheck narrows the null default in the inferred API.
    runsLogDir: runsLogDir as unknown as null });
}
const meta = { clientRequestId: 'request', analyticsHints: { externalPluginId: 'mish', pluginWorkflowId: 'workflow', entrySurface: 'external_mcp' } };

describe('D11 terminal run retention', () => {
  it('expires request and workflow indexes while preserving durable history', () => {
    vi.useFakeTimers();
    const runs = registry(); const run = runs.create(meta);
    runs.finish(run, 'succeeded', 0, null);
    expect(runs.getByClientRequestId('request')?.id).toBe(run.id);
    expect(runs.findByPluginWorkflowId('workflow')?.id).toBe(run.id);
    vi.advanceTimersByTime(100);
    expect(runs.getByClientRequestId('request')).toBeNull();
    expect(runs.findByPluginWorkflowId('workflow')).toBeNull();
    expect(runs.get(run.id)?.id).toBe(run.id);
    // TTL ends these in-memory idempotency bindings; a later request gets a new run.
    expect(runs.createOrReuse(meta).kind).toBe('created');
  });
  it('does not remove a newer run that replaced an expired run in either index', () => {
    vi.useFakeTimers();
    const runs = registry(); const old = runs.create(meta);
    runs.finish(old, 'succeeded', 0, null);
    const replacement = runs.create(meta);
    vi.advanceTimersByTime(100);
    expect(runs.getByClientRequestId('request')?.id).toBe(replacement.id);
    expect(runs.findByPluginWorkflowId('workflow')?.id).toBe(replacement.id);
  });
  it('does not expire a restarted run when its earlier cleanup timer fires', () => {
    vi.useFakeTimers();
    const runs = registry(); const run = runs.create(meta);
    runs.finish(run, 'failed', 1, null);
    runs.prepareRestart(run);
    vi.advanceTimersByTime(100);
    expect(runs.getByClientRequestId('request')?.id).toBe(run.id);
    expect(runs.findByPluginWorkflowId('workflow')?.id).toBe(run.id);
  });
});
