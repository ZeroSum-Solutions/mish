/**
 * Spawns tests/exit-race-fixture.ts (a standalone entry point, not this file itself) to prove the
 * CLI's exit coordinator (`requestNormalExit`/`requestFatalExit`/`installFatalHandlers` in
 * src/process-exit.ts, re-exported from src/cli.ts) is single-flight under a genuine race: a
 * normal completion requests exit 0 while a large stdout payload is still draining under
 * backpressure, then a real uncaughtException fires a moment later requesting exit 1. Without
 * coordination, whichever request's own flush happened to finish draining first would call
 * process.exit() first — the normal 0 could win over the later fatal 1, or the fatal diagnostic
 * could still be mid-write when the normal flush's process.exit() fired, truncating it.
 * `spawnThrottled` (tests/helpers/spawn-throttled.ts) throttles the reader (pauses after every
 * chunk) so the OS pipe stays near-full while the child writes, reproducing the same real-timing
 * race tests/cli-stdout-flush.test.ts and apps/daemon/tests/media-wait-stdout-flush.test.ts use.
 */

import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { spawnThrottled } from './helpers/spawn-throttled.ts';

const fixtureEntry = fileURLToPath(new URL('./exit-race-fixture.ts', import.meta.url));

test('a fatal diagnostic arriving mid-flush wins the exit code over a concurrent normal completion, and is never truncated', async () => {
  const { exitCode, stdout, stderr } = await spawnThrottled(process.execPath, ['--experimental-strip-types', fixtureEntry]);

  assert.equal(exitCode, 1, 'the fatal request must win the exit code, even though the normal completion asked first');

  const stderrText = stderr.toString('utf8');
  assert.ok(stderrText.includes('FATAL-DIAGNOSTIC-8842: a real crash arriving mid-flush'), `expected the full diagnostic on stderr, got: ${stderrText}`);

  assert.equal(stdout.length, 96 * 1024, 'the normal path\'s own large write must still fully drain even though it lost the exit-code race');
});
