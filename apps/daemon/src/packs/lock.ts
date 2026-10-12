// Licensed packs: the packs-root mutex.
//
// Assumption: exactly one daemon process owns `<RUNTIME_DATA_DIR>/packs/`.
// The CLI (`od pack`) and the web UI both go through the daemon's HTTP API,
// so an in-process lock is enough to serialise install, remove and the
// handler repair pass. A second daemon on the same data root is not
// supported (the same holds for the SQLite database beside it).
//
// The lock is a try-lock: a second install while one runs fails at once with
// INSTALL_IN_PROGRESS instead of queueing behind a 165 MB download.

export interface PackRootLock {
  /** Take the lock; returns its release function, or null when it is held. */
  tryAcquire(): (() => void) | null;
  readonly held: boolean;
}

export function createPackRootLock(): PackRootLock {
  let held = false;
  return {
    tryAcquire() {
      if (held) return null;
      held = true;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        held = false;
      };
    },
    get held() {
      return held;
    },
  };
}
