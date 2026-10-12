import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

const pending = {
  schema: 'capture-draft/1', draftId: `draft_${'a'.repeat(20)}`, projectId: 'p', captureId: `cap_${'b'.repeat(20)}`,
  revision: 1, parentRevision: null, createdAt: '2026-10-09T12:00:00.000Z', status: 'pending',
  prompt: 'Recreate the header.', html: null, outputSha256: null, assumptions: [], failure: null,
  generator: { provider: 'claude-max', modelId: 'claude-sonnet-5-5', billingLane: 'max-subscription' },
};
const ready = { ...pending, status: 'ready', html: '<!doctype html><html></html>', outputSha256: 'a'.repeat(64) };
const input = { projectId: 'p', captureId: pending.captureId, prompt: pending.prompt };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const options = (output: unknown[]) => ({ baseUrl: 'http://127.0.0.1:48123', env: {}, readStdin: async () => JSON.stringify(input), write: (value: unknown) => output.push(value) });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('od workbench draft-from-capture (AC-R14.2)', () => {
  it.each(['file', 'stdin'])('reads long-form intent from a prompt %s with JSON metadata in a file', async source => {
    const dir = await mkdtemp(path.join(tmpdir(), 'od-draft-cli-'));
    try {
      const metadataFile = path.join(dir, 'input.json');
      const promptFile = path.join(dir, 'prompt.txt');
      const prompt = 'Recreate the header.\nKeep the original layout.';
      const { prompt: _prompt, ...metadata } = input;
      await writeFile(metadataFile, JSON.stringify(metadata)); await writeFile(promptFile, prompt);
      const calls = vi.fn().mockResolvedValue(response({ ...pending, prompt }, 202)); vi.stubGlobal('fetch', calls);
      const output: unknown[] = [];
      expect(await runWorkbenchCli(['draft-from-capture', 'create', '--input-file', metadataFile, '--prompt-file', source === 'stdin' ? '-' : promptFile, '--json'], { ...options(output), readStdin: async () => prompt })).toBe(0);
      expect(JSON.parse(calls.mock.calls[0]![1].body)).toEqual({ ...metadata, prompt });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('rejects two stdin consumers and oversized prompt files before daemon access', async () => {
    const calls = vi.fn(); vi.stubGlobal('fetch', calls);
    const dir = await mkdtemp(path.join(tmpdir(), 'od-draft-cli-'));
    try {
      const inputFile = path.join(dir, 'input.json'); const promptFile = path.join(dir, 'prompt.txt');
      await writeFile(inputFile, JSON.stringify(input)); await writeFile(promptFile, 'x'.repeat(128 * 1024 + 1));
      for (const args of [
        ['--input-file', '-', '--prompt-file', '-'],
        ['--input-file', inputFile, '--prompt-file', promptFile],
      ]) expect(await runWorkbenchCli(['draft-from-capture', 'create', ...args, '--json'], options([]))).toBe(2);
      expect(calls).not.toHaveBeenCalled();
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('creates from stdin with one idempotency key and project authority', async () => {
    const calls = vi.fn().mockResolvedValue(response(pending, 202)); vi.stubGlobal('fetch', calls);
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--idempotency-key', 'cli-stable', '--json'], options(output))).toBe(0);
    expect(calls).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:48123/api/workbench/capture-drafts', expect.objectContaining({
      method: 'POST', body: JSON.stringify(input), headers: expect.objectContaining({ 'idempotency-key': 'cli-stable', 'x-od-project-id': 'p', 'x-od-client': 'cli' }),
    }));
    expect(output).toEqual([pending]);
  });

  it('lists and reads an exact revision through the same HTTP contract', async () => {
    const calls = vi.fn().mockResolvedValueOnce(response({ drafts: [ready] })).mockResolvedValueOnce(response(ready)); vi.stubGlobal('fetch', calls);
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['draft-from-capture', 'list', '--project', 'p', '--json'], options(output))).toBe(0);
    expect(await runWorkbenchCli(['draft-from-capture', 'show', '--project', 'p', '--id', pending.draftId, '--revision', '1', '--json'], options(output))).toBe(0);
    expect(calls.mock.calls.map(call => call[0])).toEqual(['http://127.0.0.1:48123/api/workbench/capture-drafts?projectId=p', `http://127.0.0.1:48123/api/workbench/capture-drafts/${pending.draftId}/revisions/1?projectId=p`]);
    expect(output).toEqual([{ drafts: [ready] }, ready]);
  });

  it('rejects malformed input and options before contacting the daemon', async () => {
    const calls = vi.fn(); vi.stubGlobal('fetch', calls);
    for (const args of [
      ['create', '--input-file', '-'], ['list', '--project', '', '--json'], ['show', '--project', 'p', '--id', '../bad', '--revision', '1', '--json'],
      ['show', '--project', 'p', '--id', pending.draftId, '--revision', '1.5', '--json'],
      ['list', '--project', 'p', '--workspace', 'w', '--json'], ['list', '--project', 'p', '--project', 'q', '--json'],
      ['list', '--project', 'p', '--wait', '--json'],
    ]) expect(await runWorkbenchCli(['draft-from-capture', ...args], options([]))).toBe(2);
    expect(await runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--json'], { ...options([]), readStdin: async () => JSON.stringify({ ...input, html: 'not accepted' }) })).toBe(2);
    expect(calls).not.toHaveBeenCalled();
  });

  it('preserves typed daemon refusals and refuses malformed success bodies', async () => {
    const calls = vi.fn().mockResolvedValueOnce(response({ error: { code: 'FORBIDDEN', message: 'Project scope is not authorized' } }, 403)).mockResolvedValueOnce(response({ status: 'ready' })); vi.stubGlobal('fetch', calls);
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['draft-from-capture', 'list', '--project', 'p', '--json'], options(output))).toBe(3);
    expect(output[0]).toMatchObject({ status: 403, error: { code: 'FORBIDDEN' } });
    expect(await runWorkbenchCli(['draft-from-capture', 'list', '--project', 'p', '--json'], options(output))).toBe(1);
  });

  it('waits for the same immutable revision and prints only the terminal result', async () => {
    vi.useFakeTimers();
    const calls = vi.fn().mockResolvedValueOnce(response(pending, 202)).mockResolvedValueOnce(response(ready)); vi.stubGlobal('fetch', calls);
    const output: unknown[] = [];
    const result = runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--wait', '--json'], options(output));
    await vi.runAllTimersAsync();
    expect(await result).toBe(0); expect(output).toEqual([ready]);
    expect(calls.mock.calls[1]?.[0]).toBe(`http://127.0.0.1:48123/api/workbench/capture-drafts/${pending.draftId}/revisions/1?projectId=p`);
  });

  it('fails wait on a failed revision while retaining its recovery response', async () => {
    const failed = { ...pending, status: 'failed', failure: { reason: 'provider-unavailable', message: 'Provider unavailable', recovery: 'Retry this revision.' } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(failed)));
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--wait', '--json'], options(output))).toBe(3);
    expect(output).toEqual([failed]);
  });

  it('bounds waiting and returns the persisted identity for later resume', async () => {
    vi.useFakeTimers();
    const calls = vi.fn().mockImplementation(async () => response(pending)); vi.stubGlobal('fetch', calls);
    const output: unknown[] = [];
    const start = Date.now();
    const result = runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--wait', '--json'], options(output));
    await vi.runAllTimersAsync();
    expect(await result).toBe(3);
    expect(Date.now() - start).toBe(120_000);
    expect(calls.mock.calls.length).toBeLessThanOrEqual(121);
    expect(output).toEqual([{ error: { code: 'draft-wait-timeout', message: expect.any(String), draftId: pending.draftId, revision: 1, projectId: 'p' } }]);
  });

  it('rejects success responses that change project or revision identity', async () => {
    const calls = vi.fn().mockResolvedValueOnce(response({ ...ready, projectId: 'another' })).mockResolvedValueOnce(response({ ...ready, revision: 2 })); vi.stubGlobal('fetch', calls);
    expect(await runWorkbenchCli(['draft-from-capture', 'create', '--input-file', '-', '--json'], options([]))).toBe(1);
    expect(await runWorkbenchCli(['draft-from-capture', 'show', '--project', 'p', '--id', pending.draftId, '--revision', '1', '--json'], options([]))).toBe(1);
  });
});
