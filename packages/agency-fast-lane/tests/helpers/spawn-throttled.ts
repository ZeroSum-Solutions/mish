/**
 * Shared spawn-and-collect harness for `tests/cli-stdout-flush.test.ts` and
 * `tests/cli-exit-race.test.ts`: both spawn a real child process and need to prove its full
 * stdout/stderr survive an OS-level pipe-buffer race, which only shows up when the reader is
 * throttled (pauses after every chunk) instead of draining the OS pipe as fast as it fills.
 */

import { spawn } from 'node:child_process';

export type ThrottledSpawnResult = { exitCode: number; stdout: Buffer; stderr: Buffer };

/** Reads a stream into `chunks`, pausing after every chunk so the writer sees backpressure
 * instead of a reader that drains the OS pipe buffer as fast as it fills. Resolves on 'end'. */
function drainThrottled(stream: NodeJS.ReadableStream, chunks: Buffer[]): Promise<void> {
  return new Promise((resolve) => {
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      stream.pause();
      setTimeout(() => stream.resume(), 10);
    });
    stream.on('end', resolve);
  });
}

/**
 * Spawns `command args` with piped stdout/stderr, drains both through `drainThrottled` so the
 * child sees genuine backpressure, and resolves with the exit code and the full (concatenated)
 * output once the process closes. A rejected spawn (e.g. a bad interpreter path) rejects this
 * promise with that reason instead of hanging forever waiting for a 'close' that never comes.
 */
export async function spawnThrottled(command: string, args: string[]): Promise<ThrottledSpawnResult> {
  const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });

  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const spawnError = new Promise<never>((_resolve, reject) => child.on('error', reject));
  const [exitCode] = await Promise.race([
    Promise.all([
      new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1))),
      drainThrottled(child.stdout!, stdoutChunks),
      drainThrottled(child.stderr!, stderrChunks),
    ]),
    spawnError,
  ]);

  return { exitCode, stdout: Buffer.concat(stdoutChunks), stderr: Buffer.concat(stderrChunks) };
}
