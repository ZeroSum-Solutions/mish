import type { PlacementWriteCoordinator, PlacementWriteGuard, RunDrainPermit, RunPermit } from './write-coordinator.js';
import type { PlacementLaunchHandle, PlacementLaunchRequest, PlacementLaunchSupervisor } from './supervisor.js';

/** Reserved final publication/cleanup work that survives cancellation and sealing until settled. */
export interface PlacementFinalWork {
  readonly kind: 'publication' | 'cleanup';
  /** `guard.assertCurrent()` immediately before each actual mutation (owner/recovery/root drift refuse). */
  projectWrite<T>(projectId: string, work: (guard: PlacementWriteGuard) => Promise<T>): Promise<T>;
  dataRootWrite<T>(work: (guard: PlacementWriteGuard) => Promise<T>): Promise<T>;
  /** Attests that this final work actually settled. */
  settle(): void;
}
/**
 * One admitted run. Scope is frozen at admission; the run reuses this permit
 * for every write and must not request a nested overlapping admission.
 */
export interface AdmittedPlacementRun {
  readonly projectIds: readonly string[];
  allocate<T>(work: () => Promise<T>): Promise<T>;
  start(): Promise<void>;
  /** Durable intent records the run's frozen canonical physical roots. */
  launch(request: Omit<PlacementLaunchRequest, 'projectRoots'>): PlacementLaunchHandle;
  reserveFinal(kind: 'publication' | 'cleanup'): PlacementFinalWork;
  /** The run's own (borrowed) permit; helpers receive its guard, never a nested admission. */
  projectWrite<T>(projectId: string, work: (guard: PlacementWriteGuard) => Promise<T>): Promise<T>;
  dataRootWrite<T>(work: (guard: PlacementWriteGuard) => Promise<T>): Promise<T>;
  cancel(): void;
  /** Seals new work; resolves after children, final tickets and accepted callbacks drain. */
  finish(): Promise<void>;
}

/** Coordinated run admission adapter for the internal-run choke point. */
export class PlacementRunLifetime {
  readonly #coordinator: PlacementWriteCoordinator; readonly #supervisor: PlacementLaunchSupervisor;
  readonly #physicalRoots: (projectIds: readonly string[]) => readonly string[];
  constructor(options: { coordinator: PlacementWriteCoordinator; supervisor: PlacementLaunchSupervisor; physicalRoots(projectIds: readonly string[]): readonly string[] }) {
    this.#coordinator = options.coordinator; this.#supervisor = options.supervisor; this.#physicalRoots = options.physicalRoots;
  }
  async admit(input: { projectIds: readonly string[]; signal?: AbortSignal }): Promise<AdmittedPlacementRun> {
    const coordinator = this.#coordinator, supervisor = this.#supervisor, physicalRoots = this.#physicalRoots;
    const projectIds = Object.freeze([...input.projectIds]);
    const permit: RunPermit = await coordinator.admitRun({ projectRoots: projectIds, ...(input.signal ? { signal: input.signal } : {}) });
    const final = (kind: 'publication' | 'cleanup'): PlacementFinalWork => {
      const ticket: RunDrainPermit = coordinator.registerRunDrain(permit, kind);
      return Object.freeze({
        kind,
        projectWrite: <T>(projectId: string, work: (guard: PlacementWriteGuard) => Promise<T>) => coordinator.withDrainProjectWrite(ticket, projectId, work),
        dataRootWrite: <T>(work: (guard: PlacementWriteGuard) => Promise<T>) => coordinator.withDrainDataRootWrite(ticket, work),
        settle: () => coordinator.confirmRunDrain(ticket),
      });
    };
    return Object.freeze({
      projectIds,
      allocate: <T>(work: () => Promise<T>) => coordinator.withRunAllocation(permit, work),
      start: () => coordinator.startRun(permit, { projectRoots: projectIds }),
      launch: (request: Omit<PlacementLaunchRequest, 'projectRoots'>) => supervisor.beginLaunch(permit, { ...request, projectRoots: physicalRoots(projectIds) }),
      reserveFinal: final,
      projectWrite: <T>(projectId: string, work: (guard: PlacementWriteGuard) => Promise<T>) => coordinator.withProjectWrite(permit, projectId, work),
      dataRootWrite: <T>(work: (guard: PlacementWriteGuard) => Promise<T>) => coordinator.withDataRootWrite(permit, work),
      cancel: () => coordinator.cancelRun(permit),
      finish: () => coordinator.finishRun(permit),
    });
  }
}
