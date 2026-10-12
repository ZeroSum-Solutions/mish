/**
 * Single-flight process-exit coordination for the fast-lane CLI's bin entry: normal completion
 * (`main()`'s own return value) and the two fatal process-level handlers (`unhandledRejection`,
 * `uncaughtException`) can each request an exit independently and at any time, including
 * concurrently while a normal exit's own flush is still draining under backpressure. Without
 * coordination, whichever request's flush happened to finish its drain first would call
 * `process.exit()` first — so a normal 0 could win over a fatal 1 that arrived a moment later, or a
 * fatal diagnostic written after a normal flush had already started draining could still be
 * mid-write when that flush's `process.exit()` fired, truncating it. `apps/daemon/src/cli.ts` hit
 * the truncation half of this bug (see `apps/daemon/tests/media-wait-stdout-flush.test.ts`); its
 * own flush helper is private to that script, so this reproduces the same drain technique locally
 * rather than importing across the app/package boundary.
 *
 * A fatal exit always wins the exit code over a normal one, whichever arrived first — the first
 * fatal request keeps its code even if further fatal requests then arrive. Only
 * `requestNormalExit`/`requestFatalExit` are exported: a fatal exit is always exit code 1 in this
 * CLI, so this public surface has no way to construct an invalid combination such as a fatal exit
 * 0 — unlike an earlier `requestExit(code, fatal)` shape this module replaced, which allowed one.
 */

async function drainStdio(): Promise<void> {
  await Promise.all([
    new Promise<void>((resolve) => process.stdout.write('', () => resolve())),
    new Promise<void>((resolve) => process.stderr.write('', () => resolve())),
  ]);
}

let exitWinnerCode: number | undefined;
let exitWinnerIsFatal = false;
let exitRequestGeneration = 0;
let exitCoordinatorStarted = false;

/**
 * `fatal: true` always wins the exit code over `fatal: false`, whichever arrived first.
 * `exitRequestGeneration` bumps on every call; the flush loop below only actually calls
 * `process.exit()` once a full drain completes with the generation unchanged, so a request (or a
 * write it made) that lands while a drain is already in flight is still captured by a repeated
 * drain rather than lost. `exitCoordinatorStarted` guarantees the loop, and so `process.exit()`,
 * only ever runs once. Private: `requestNormalExit`/`requestFatalExit` below are the only public
 * way in, so `fatal` and `code` can never disagree (a fatal exit is always 1).
 */
function submitExitRequest(code: number, fatal: boolean): void {
  if (exitWinnerCode === undefined || (fatal && !exitWinnerIsFatal)) {
    exitWinnerCode = code;
    exitWinnerIsFatal = fatal;
  }
  exitRequestGeneration += 1;
  if (!exitCoordinatorStarted) {
    exitCoordinatorStarted = true;
    void runExitSequence();
  }
}

async function runExitSequence(): Promise<void> {
  for (;;) {
    const generationAtDrainStart = exitRequestGeneration;
    await drainStdio();
    if (exitRequestGeneration === generationAtDrainStart) {
      process.exit(exitWinnerCode);
      return;
    }
    // A request landed while this drain was in flight (a write it made may still be queued
    // behind it) — draining again waits for that write too before anything exits.
  }
}

/** Requests a normal exit with `code` — the bin entry's own completion path, via `main()`'s return
 * value. Loses the exit-code race to any fatal request, whichever arrived first. */
export function requestNormalExit(code: number): void {
  submitExitRequest(code, false);
}

/** Requests a fatal exit — always code 1, the only code a genuine crash in this CLI ever reports.
 * Wins the exit-code race over any normal request, whichever arrived first. */
export function requestFatalExit(): void {
  submitExitRequest(1, true);
}

/** Registers the process-level handlers for a failure `main()` never gets the chance to report
 * itself — a stray unhandled rejection or a genuinely uncaught throw. Both route through
 * `requestFatalExit` so they can never lose a race with, or have their own diagnostic truncated
 * by, a concurrent normal completion. */
export function installFatalHandlers(): void {
  process.on('unhandledRejection', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    requestFatalExit();
  });
  process.on('uncaughtException', (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    requestFatalExit();
  });
}
