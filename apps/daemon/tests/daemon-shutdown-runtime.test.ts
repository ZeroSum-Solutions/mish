import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ fail: true }));
vi.mock('../src/server.js', () => ({
  startServer: async () => ({
    url: 'http://127.0.0.1:0',
    server: express().listen(0, '127.0.0.1'),
    shutdown: async () => { if (state.fail) throw new Error('disk failed during shutdown'); },
  }),
}));
import { startDaemonRuntime } from '../src/daemon-startup.js';

const savedExitCode = process.exitCode;
afterEach(() => { process.exitCode = savedExitCode; vi.restoreAllMocks(); });

describe('daemon runtime failed shutdown', () => {
  it('closes the HTTP listener and retains a nonzero exit when shutdown rejects', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const runtime = await startDaemonRuntime({ port: 0 });
    await new Promise<void>((resolve) => runtime.server.once('listening', resolve));
    await runtime.stop();
    expect(runtime.server.listening).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
