// Browser start-up failures (B4-2 round 10, Sol round 9 WARN). The cause is
// classified from daemon-owned signals only (the spawn errno, the exit code or
// signal, the process's own stderr, a start-up timeout) into a closed enum
// with a class-specific recovery. The raw stderr goes to the local daemon log
// and never into a bundle.
import type { REVIEW_EVIDENCE_VOCABULARIES } from '@mish/contracts';

export type StartupFailure = (typeof REVIEW_EVIDENCE_VOCABULARIES)['startupFailure'][number];

export interface StartupSignals {
  /** `error.code` of a failed spawn (ENOENT, EACCES, …). */
  errno?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  /** The tail of the browser's stderr. */
  stderr?: string;
  /** The browser never answered Browser.getVersion in time. */
  timedOut?: boolean;
}

const MISSING_LIBRARY = /error while loading shared libraries|cannot open shared object file|Library not loaded|dyld(?:\[\d+\])?:|image not found|The code execution cannot proceed because .*\.dll/iu;
const PROFILE_LOCKED = /ProcessSingleton|SingletonLock|profile (?:appears to be )?in use|user data directory is already in use|lock file/iu;
const UNSUPPORTED_FLAG = /unknown (?:command[- ]line )?(?:flag|option|switch)|unrecognized (?:command[- ]line )?(?:flag|option|switch)|unsupported (?:command[- ]line )?(?:flag|option|switch)|invalid (?:command[- ]line )?(?:flag|switch)/iu;
const PERMISSION = /permission denied|operation not permitted|EACCES|EPERM|No usable sandbox|sandbox_host_linux|setuid sandbox|namespace/iu;
const CRASH = /crash|Received signal|Segmentation fault|Trace\/breakpoint trap|SIGSEGV|SIGABRT|SIGTRAP|SIGBUS|SIGILL/iu;
const CRASH_SIGNALS = new Set(['SIGSEGV', 'SIGABRT', 'SIGTRAP', 'SIGBUS', 'SIGILL', 'SIGFPE']);

export function classifyStartupFailure(signals: StartupSignals): StartupFailure {
  const stderr = signals.stderr ?? '';
  if (signals.errno === 'ENOENT' || signals.exitCode === 127 && /not found|No such file/iu.test(stderr) && !MISSING_LIBRARY.test(stderr)) return 'missing-browser';
  if (signals.errno === 'EACCES' || signals.errno === 'EPERM') return 'permission-denied';
  if (MISSING_LIBRARY.test(stderr)) return 'missing-library';
  if (PROFILE_LOCKED.test(stderr)) return 'profile-locked';
  if (UNSUPPORTED_FLAG.test(stderr)) return 'unsupported-flag';
  if (PERMISSION.test(stderr) || signals.exitCode === 126) return 'permission-denied';
  if (signals.timedOut) return 'timeout';
  if ((signals.signal && CRASH_SIGNALS.has(signals.signal)) || (typeof signals.exitCode === 'number' && signals.exitCode > 128) || CRASH.test(stderr)) return 'crashed';
  return 'unknown';
}

/** A browser that did not start; `detail` (stderr tail, exit status) is for the local daemon log only. */
export class BrowserStartupError extends Error {
  constructor(readonly failure: StartupFailure, readonly detail: string) {
    super(`The browser could not start (${failure})`);
    this.name = 'BrowserStartupError';
  }
}

/** Writes a start-up failure's raw detail to the local daemon log; never to evidence. */
export function logStartupFailure(error: BrowserStartupError): void {
  console.warn(`[workbench-review] browser start-up failed (${error.failure}): ${error.detail}`);
}
