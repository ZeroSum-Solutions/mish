/**
 * Spawns the real `src/cli.ts` bin entry (not `main()` in-process) and proves it flushes a large
 * piped output fully before the process exits — the same unflushed-write race
 * apps/daemon/tests/media-wait-stdout-flush.test.ts guards `apps/daemon/src/cli.ts` against.
 * `process.exit()` terminates the process without waiting for pending async writes; when stdout
 * or stderr is a pipe, a single write past the OS pipe buffer (commonly 64KiB) can still be
 * queued when the process dies, so the caller sees the right exit code with truncated or empty
 * output.
 *
 * A `--asset` value with no `=` fails validation and is echoed back verbatim in the usage-error
 * message (`src/cli-args.ts`'s `fail`), so a value several times past the pipe buffer forces one write
 * large enough to expose the race deterministically — the same "embed a huge string in an echoed
 * message" technique the daemon spec uses (there via an HTTP response body, not an argv value; see
 * below for why this spec's value is sized differently). `spawnThrottled`
 * (tests/helpers/spawn-throttled.ts) throttles the reader (pauses after every chunk) so the OS
 * pipe stays near-full while the child writes, instead of draining fast enough to hide the race,
 * and fails this test clearly (instead of hanging) if the spawn itself is rejected.
 */

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnThrottled } from './helpers/spawn-throttled.ts';

const cliEntry = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

test('a real spawned CLI process flushes a large stderr message fully before it exits, even piped and throttled', async () => {
  const briefDir = await mkdtemp(path.join(tmpdir(), 'fast-lane-flush-test-'));
  const briefPath = path.join(briefDir, 'brief.md');
  await writeFile(briefPath, 'Riverbend Dental, a family dental practice in Boise.');

  // Several times past the ~64KiB pipe buffer that forces the unflushed-write race, but sized for
  // a single argv value: Linux commonly limits one exec() argument to roughly 128KiB even when the
  // aggregate ARG_MAX is much larger (this machine's own ARG_MAX, via `getconf ARG_MAX`, is ~1MB
  // and tolerates far more — a 300KiB value passed here before), so a value close to that per-arg
  // ceiling can fail to spawn on Linux CI (E2BIG) before the CLI ever runs. The daemon spec's own
  // payload is 6MB, but it rides in an HTTP response body, not an argv value.
  const hugeAssetValue = 'x'.repeat(96 * 1024);
  const expectedMessage = `--asset expects id=path, received ${hugeAssetValue}\n`;

  const { exitCode, stdout, stderr } = await spawnThrottled(process.execPath, [
    '--experimental-strip-types', cliEntry, '--family', 'ownedsite', '--brief', briefPath, '--verify-mode', 'off', '--asset', hugeAssetValue,
  ]);

  assert.equal(exitCode, 1, 'a malformed --asset value is a usage error (exit 1)');
  assert.equal(stdout.length, 0, 'a usage error prints nothing to stdout');
  const stderrText = stderr.toString('utf8');
  assert.equal(stderrText.length, expectedMessage.length, `expected ${expectedMessage.length} bytes on stderr, got ${stderrText.length} (truncated under the pipe race)`);
  assert.equal(stderrText, expectedMessage, 'the full ~96KiB message must survive the pipe race, not just its length');
});
