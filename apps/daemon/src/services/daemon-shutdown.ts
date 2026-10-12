type ShutdownStep = () => void | Promise<unknown>;

/** Attempt every drain and always release placement, then report all failures. */
export async function runDaemonShutdownSteps(steps: readonly ShutdownStep[], closePlacement: (failed: boolean) => void | Promise<unknown>): Promise<void> {
  const failures: unknown[] = [];
  try {
    for (const step of steps) {
      try { await step(); } catch (error) { failures.push(error); }
    }
  } finally {
    try { await closePlacement(failures.length > 0); } catch (error) { failures.push(error); }
  }
  if (failures.length) throw new AggregateError(failures, 'daemon shutdown failed');
}

/** Event listeners cannot await shutdown: consume rejections and retain a failed exit. */
export async function finishDaemonShutdown(
  shutdown: Promise<unknown>,
  cleanup: ShutdownStep,
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
  setExitCode: (code: number) => void = (code) => { process.exitCode = code; },
): Promise<void> {
  try {
    await shutdown;
  } catch (error) {
    log('[od] daemon shutdown failed', error);
    setExitCode(1);
  } finally {
    try { await cleanup(); } catch (error) {
      log('[od] daemon cleanup failed', error);
      setExitCode(1);
    }
  }
}
