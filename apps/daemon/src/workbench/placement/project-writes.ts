import type { PlacementProjectRegistry } from './project-registry.js';
import { PlacementCoordinationError, type MutationPermit, type PlacementWriteCoordinator, type PlacementWriteGuard } from './write-coordinator.js';

/**
 * Final-I/O check handed to project-file helpers. Call `assertCurrent()`
 * synchronously immediately before each actual filesystem mutation; it throws
 * a mapped `PlacementCoordinationError` on owner/recovery loss (503) or
 * CURRENT-authority drift (409). Admission close or caller cancellation alone
 * never refuses accepted work.
 */
export type PlacementFinalIO = PlacementWriteGuard;

/** One admitted standalone operation; its project gate is held until `settle()` resolves. */
export interface PlacementProjectWriteLease {
  readonly projectId: string;
  /** Accepted project work: rechecked on entry, `finalIO` before each mutation, held until it settles. */
  write<T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T>;
  /** Seals new work; resolves once every accepted write settled and admission released. Idempotent. */
  settle(): Promise<void>;
}

/**
 * Server-owned admission for standalone manual project writes (save, upload,
 * history capture/baseline/restore/rename/delete). Callers admit with the
 * route-authorized project id before the first project effect (ensureProject,
 * mkdir, multipart streaming, history) and settle after all accepted work,
 * including cleanup, regardless of response cancellation. Request-supplied
 * fields never select mode or permits.
 *
 * Never admit from inside an accepted write or an admitted run: such work uses
 * its own guard (`run.projectWrite(id, guard => ...)`); a nested admission is
 * refused with COORDINATOR_BUSY before any registration.
 */
export interface PlacementProjectWrites {
  /** `signal` cancels only a pending admission, never accepted work. */
  admit(projectId: string, options?: { signal?: AbortSignal }): Promise<PlacementProjectWriteLease>;
  /** Admit, one write, then settle (also when the work throws). */
  run<T>(projectId: string, work: (finalIO: PlacementFinalIO) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T>;
}

function lease(projectId: string, write: <T>(work: (finalIO: PlacementFinalIO) => Promise<T>) => Promise<T>, release: () => void): PlacementProjectWriteLease {
  let sealed = false, released = false, inflight = 0;
  let settled: { promise: Promise<void>; resolve(): void; reject(error: unknown): void } | null = null;
  const releaseIfIdle = () => {
    if (!settled || inflight > 0 || released) return;
    released = true;
    try { release(); settled.resolve(); } catch (error) { settled.reject(error); }
  };
  return Object.freeze({
    projectId,
    async write<T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T> {
      if (sealed) throw new PlacementCoordinationError('PERMIT_RELEASED', 'Project write lease is settled');
      inflight += 1;
      try { return await write(work); } finally { inflight -= 1; releaseIfIdle(); }
    },
    settle(): Promise<void> {
      if (!settled) {
        sealed = true;
        let resolve!: () => void, reject!: (error: unknown) => void;
        const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
        settled = { promise, resolve, reject }; releaseIfIdle();
      }
      return settled.promise;
    },
  });
}
function withRun(admit: PlacementProjectWrites['admit']): PlacementProjectWrites {
  return Object.freeze({
    admit,
    async run<T>(projectId: string, work: (finalIO: PlacementFinalIO) => Promise<T>, options?: { signal?: AbortSignal }): Promise<T> {
      const admitted = await admit(projectId, options);
      try { return await admitted.write(work); } finally { await admitted.settle(); }
    },
  });
}

/**
 * Coordinated mode: register the project's CURRENT authorized location (an
 * overlapping or retargeted root waits for a globally drained epoch
 * replacement; this never runs while the caller holds a permit), then acquire
 * its coalesced project gate through the single coordinator.
 */
export function createCoordinatedProjectWrites(deps: { coordinator: PlacementWriteCoordinator; registry: PlacementProjectRegistry }): PlacementProjectWrites {
  const { coordinator, registry } = deps;
  return withRun(async (projectId, options = {}) => {
    coordinator.assertOutsideAcceptedWrite();
    if (options.signal?.aborted) throw new PlacementCoordinationError('ADMISSION_CANCELLED', 'Admission cancelled');
    await registry.registerProject(projectId, options.signal ? { signal: options.signal } : {});
    let permit: MutationPermit;
    try { permit = await coordinator.acquireMutation({ projectRoots: [projectId], ...(options.signal ? { signal: options.signal } : {}) }); }
    catch (error) {
      // Not this caller's cancellation: a drained close aborted the wait. Retryable unavailability.
      if (error instanceof PlacementCoordinationError && error.code === 'ADMISSION_CANCELLED' && !options.signal?.aborted) {
        throw new PlacementCoordinationError('ADMISSION_CLOSED', 'Admission closed while waiting for the project');
      }
      throw error;
    }
    return lease(projectId, work => coordinator.withProjectWrite(permit, projectId, work), () => coordinator.releaseMutation(permit));
  });
}

/**
 * No coordinator (ordinary mode, or coordinated mode without an owned
 * database): the C2a/recovery fence over the project's CURRENT authorized
 * metadata, at admission, on each write and before each final mutation. No
 * gates are introduced, so ordinary behavior is otherwise unchanged.
 */
export function createFenceOnlyProjectWrites(deps: { assertMutationAdmissible(projectId: string): void }): PlacementProjectWrites {
  const { assertMutationAdmissible } = deps;
  return withRun(async (projectId) => {
    assertMutationAdmissible(projectId);
    return lease(projectId, async work => {
      assertMutationAdmissible(projectId);
      const accepted = { active: true };
      const finalIO: PlacementFinalIO = Object.freeze({ assertCurrent: () => {
        if (!accepted.active) throw new PlacementCoordinationError('PERMIT_RELEASED', 'Final I/O is outside its accepted write');
        assertMutationAdmissible(projectId);
      } });
      try { return await work(finalIO); } finally { accepted.active = false; }
    }, () => undefined);
  });
}
