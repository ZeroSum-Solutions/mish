import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { runDaemonShutdownSteps, finishDaemonShutdown } from '../src/services/daemon-shutdown.js';

describe('daemon shutdown failures', () => {
  it('attempts later drains and placement close after an earlier drain rejects', async () => {
    const events: string[] = [];
    const failure = new Error('run shutdown failed');
    await expect(runDaemonShutdownSteps([
      () => { events.push('runs'); throw failure; },
      async () => { events.push('terminals'); },
    ], async (failed) => { events.push(failed ? 'placement-unsealed' : 'placement-sealed'); })).rejects.toThrow('daemon shutdown failed');
    expect(events).toEqual(['runs', 'terminals', 'placement-unsealed']);
  });

  it('handles rejected shutdown and cleanup, logs both and marks a failed exit', async () => {
    const failures = [new Error('shutdown failed'), new Error('cleanup failed')];
    const log = vi.fn();
    const exitCodes: number[] = [];
    await expect(finishDaemonShutdown(
      Promise.reject(failures[0]),
      () => { throw failures[1]; },
      log,
      (code) => { exitCodes.push(code); },
    )).resolves.toBeUndefined();
    expect(log.mock.calls.map((call) => call[1])).toEqual(failures);
    expect(exitCodes).toContain(1);
  });

  it('cleans up successful shutdown without changing its exit code', async () => {
    let cleaned = false;
    const exitCodes: number[] = [];
    await finishDaemonShutdown(Promise.resolve(), () => { cleaned = true; }, vi.fn(), (code) => { exitCodes.push(code); });
    expect(cleaned).toBe(true);
    expect(exitCodes).toEqual([]);
  });

  it('a real process exits nonzero after rejected shutdown and still writes its cleanup receipt', () => {
    const moduleUrl = new URL('../src/services/daemon-shutdown.ts', import.meta.url).href;
    try {
      execFileSync(process.execPath, ['--experimental-strip-types', '--input-type=module', '-e',
        `import { finishDaemonShutdown } from ${JSON.stringify(moduleUrl)}; await finishDaemonShutdown(Promise.reject(new Error('failed drain')), () => console.log('cleanup completed'));`],
      { encoding: 'utf8', stdio: 'pipe' });
      throw new Error('shutdown process exited successfully');
    } catch (error) {
      expect(error).toMatchObject({ status: 1 });
      expect((error as { stdout: string }).stdout).toContain('cleanup completed');
      expect((error as { stderr: string }).stderr).toContain('failed drain');
    }
  });
});
