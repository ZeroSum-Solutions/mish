/**
 * Spawned by tests/cli-exit-race.test.ts to reproduce a real OS-level backpressure race between a
 * normal completion's exit request and a concurrent fatal diagnostic — not a test file itself
 * (its name does not match `tests/*.test.ts`, so the test runner never picks it up on its own).
 *
 * Imports the real `requestNormalExit`/`installFatalHandlers` from src/cli.ts (re-exported from
 * src/process-exit.ts) rather than reimplementing the coordinator, so this exercises production
 * code, not a stand-in for it. It cannot be exercised in-process inside the shared test-runner
 * process: calling `requestNormalExit` for real ends in `process.exit()`, which would kill the
 * whole test run.
 */

import { installFatalHandlers, requestNormalExit } from '../src/cli.ts';

installFatalHandlers();

// Several times past the ~64KiB pipe buffer, so the spawning test's throttled reader leaves this
// write backpressured — still draining — when the fatal path below fires a moment later.
process.stdout.write('x'.repeat(96 * 1024));

// Simulates a normal, successful completion requesting exit 0, exactly as the bin entry does with
// main()'s own return value — while that stdout write is still draining under backpressure.
requestNormalExit(0);

// A stray failure that a caller of main() never awaited, arriving after the normal exit already
// requested 0 but before it has finished flushing. Node treats a throw from a process.nextTick
// callback as a genuine uncaughtException, so this exercises the real fatal handler, not a direct
// call to it. The coordinator must let this fatal request win the exit code, and must not let the
// still-in-flight normal flush drop this diagnostic.
process.nextTick(() => {
  throw new Error('FATAL-DIAGNOSTIC-8842: a real crash arriving mid-flush');
});
