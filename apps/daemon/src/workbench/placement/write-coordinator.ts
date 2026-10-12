import { AsyncLocalStorage } from 'node:async_hooks';
import path from 'node:path';

export type PlacementCoordinationCode =
  | 'OWNER_UNQUALIFIED' | 'OWNER_RECOVERING' | 'PROJECT_RECOVERING'
  | 'ADMISSION_CLOSED' | 'COORDINATOR_BUSY' | 'INVALID_PROJECT_ROOT'
  | 'INVALID_PERMIT' | 'PERMIT_RELEASED' | 'RUN_STATE' | 'RUN_SCOPE_CHANGED'
  | 'DRAIN_ACTIVE' | 'ADMISSION_CANCELLED';
export class PlacementCoordinationError extends Error {
  constructor(readonly code: PlacementCoordinationCode, message: string) {
    super(message); this.name = 'PlacementCoordinationError';
  }
}
const fail = (code: PlacementCoordinationCode, message: string): never => { throw new PlacementCoordinationError(code, message); };
declare const capabilityKind: unique symbol;
export type PlacementRuntimeOwner = Readonly<{ [capabilityKind]: 'owner' }>;
export type PlacementRecoveryCapability = Readonly<{ [capabilityKind]: 'recovery' }>;
export type MutationPermit = Readonly<{ [capabilityKind]: 'mutation' }>;
export type RunPermit = Readonly<{ [capabilityKind]: 'run' }>;
export type RunDrainPermit = Readonly<{ [capabilityKind]: 'drain' }>;
export type RunDrainKind = 'child' | 'publication' | 'cleanup';
export interface PlacementOwnerBinding {
  canonicalDataRoot: string;
  /** Trusted native boundary checks live ownership AND stable root/lock identity. */
  inspect(): Readonly<{ held: boolean; qualified: boolean }>;
  /** Throws until prior launch intents and actual child/helper exit reconcile. */
  readPreviousIncarnationRecovery(): Readonly<{ blockedProjectRoots: readonly string[] }>;
}
interface OwnerRecord extends PlacementOwnerBinding { invalidated: boolean; coordinatorBound: boolean; hasRegistrations?: () => boolean }
interface RecoveryRecord { owner: PlacementRuntimeOwner; invalidated: boolean }
const owners = new WeakMap<object, OwnerRecord>();
// In-process rebinding must not discard a live predecessor's fences. Kernel
// ownership and prior-incarnation recovery remain separate injected proof.
const ownersByRoot = new Map<string, OwnerRecord>();
const recoveries = new WeakMap<object, RecoveryRecord>();
function object(value: unknown): value is object { return typeof value === 'object' && value !== null; }
function canonical(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && path.isAbsolute(value) && path.resolve(value) === value;
}
function inspectOwner(owner: PlacementRuntimeOwner): OwnerRecord {
  const record = object(owner) ? owners.get(owner) : undefined;
  if (!record || record.invalidated) return fail('OWNER_UNQUALIFIED', 'Runtime ownership is unavailable');
  try {
    const state = record.inspect();
    if (state.held !== true || state.qualified !== true) throw new Error('ownership unavailable');
  } catch {
    record.invalidated = true;
    return fail('OWNER_UNQUALIFIED', 'Runtime ownership lost qualification');
  }
  return record;
}
function readRecovery(owner: PlacementRuntimeOwner): ReadonlySet<string> {
  try {
    const result = inspectOwner(owner).readPreviousIncarnationRecovery();
    if (!Array.isArray(result.blockedProjectRoots) || !result.blockedProjectRoots.every(canonical)) throw new Error('invalid recovery roots');
    return new Set(result.blockedProjectRoots);
  } catch (error) {
    if (error instanceof PlacementCoordinationError && error.code === 'OWNER_UNQUALIFIED') throw error;
    return fail('OWNER_RECOVERING', 'Previous-incarnation drainage is unresolved');
  }
}
function inspectRecovery(owner: PlacementRuntimeOwner, recovery: PlacementRecoveryCapability | undefined): ReadonlySet<string> {
  const record = object(recovery) ? recoveries.get(recovery) : undefined;
  if (!record || record.owner !== owner || record.invalidated) return fail('OWNER_RECOVERING', 'Current owner recovery authorization is required');
  try { return readRecovery(owner); } catch (error) { record.invalidated = true; throw error; }
}
/** Trusted bootstrap adapter only. This does not acquire a kernel lock or prove drainage. */
export function bindPlacementRuntimeOwner(binding: PlacementOwnerBinding): PlacementRuntimeOwner {
  if (!canonical(binding.canonicalDataRoot)) return fail('OWNER_UNQUALIFIED', 'Owner root must be canonical');
  const previous = ownersByRoot.get(binding.canonicalDataRoot);
  if (previous) {
    let released = false;
    try { released = previous.inspect().held === false; } catch { /* Unknown is not released. */ }
    if (!released || previous.hasRegistrations?.()) fail('OWNER_RECOVERING', 'Prior in-process owner has not released and drained');
    previous.invalidated = true;
  }
  const owner = Object.freeze({}) as PlacementRuntimeOwner;
  const record: OwnerRecord = { canonicalDataRoot: binding.canonicalDataRoot,
    inspect: binding.inspect.bind(binding), readPreviousIncarnationRecovery: binding.readPreviousIncarnationRecovery.bind(binding),
    invalidated: false, coordinatorBound: false };
  owners.set(owner, record); inspectOwner(owner); ownersByRoot.set(record.canonicalDataRoot, record);
  return owner;
}
/** Only the bound owner's trusted prior-incarnation predicate can mint this capability. */
export function authorizePlacementRecovery(owner: PlacementRuntimeOwner): PlacementRecoveryCapability {
  readRecovery(owner);
  const recovery = Object.freeze({}) as PlacementRecoveryCapability;
  recoveries.set(recovery, { owner, invalidated: false });
  return recovery;
}

interface Waiter { resolve(release: () => void): void; reject(error: unknown): void; signal: AbortSignal; abort(): void }
class ProjectGate {
  #held = false;
  #waiters: Waiter[] = [];
  readonly #idle: () => void;
  constructor(idle: () => void) { this.#idle = idle; }
  acquire(signal: AbortSignal): Promise<() => void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(new PlacementCoordinationError('ADMISSION_CANCELLED', 'Admission cancelled')); return; }
      if (!this.#held) { this.#held = true; resolve(this.#releaseHandle()); return; }
      const waiter: Waiter = { resolve, reject, signal, abort: () => {
        this.#waiters = this.#waiters.filter(item => item !== waiter);
        signal.removeEventListener('abort', waiter.abort);
        reject(new PlacementCoordinationError('ADMISSION_CANCELLED', 'Admission cancelled'));
      } };
      this.#waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
    });
  }
  #releaseHandle(): () => void {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.#waiters.shift();
      if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(this.#releaseHandle()); }
      else { this.#held = false; this.#idle(); }
    };
  }
}
export interface PlacementAdmission { projectRoots: readonly string[]; signal?: AbortSignal }
/** CURRENT authorized physical root of one project, read synchronously at final I/O. */
export interface PlacementRootObservation {
  readonly gateKey: string; readonly physicalRoot: string;
  /** Fresh physical identity; null while a managed root is not yet created. */
  readonly identity: Readonly<{ device: string; inode: string }> | null;
  readonly epoch: number;
}
/**
 * Handed to every accepted write callback. Call `assertCurrent()` synchronously
 * immediately before each actual filesystem mutation: it rechecks owner,
 * recovery and project fences and, for project writes, that the CURRENT
 * authorized root still is the accepted one. The first observed root is pinned
 * for the whole permit, across every callback and final ticket; a root absent
 * at admission pins the first identity observed. It never refuses merely because admission
 * closed or the caller cancelled. Valid only while its callback runs.
 */
export interface PlacementWriteGuard { assertCurrent(): void }
export interface PlacementCoordinatorOptions {
  owner: PlacementRuntimeOwner;
  recovery?: PlacementRecoveryCapability;
  /** Authorizes/qualifies managed roots and returns canonical physical identity. */
  resolveProjectRoot(input: string): Promise<string>;
  /** Synchronous CURRENT-authority recheck for final I/O; throws when stale or unauthorized. */
  observeProjectRoot?(input: string): PlacementRootObservation;
}
type Phase = 'acquiring' | 'active' | 'queued' | 'running' | 'draining' | 'released';
interface PermitRecord {
  token: MutationPermit | RunPermit;
  kind: 'mutation' | 'placement' | 'run'; phase: Phase; roots: readonly string[];
  abort: AbortController; releaseGates: Array<() => void>; removeSignal?: () => void;
  started: boolean; writes: number; drains: Set<RunDrainPermit>;
  /** First-observed CURRENT root per project input, kept for the whole permit (every callback and final ticket). */
  pins: Map<string, PlacementRootObservation>;
  /** Project inputs this permit was admitted for; their later stale resolution is scope drift, not invalid input. */
  inputs: readonly string[];
  finish?: { promise: Promise<void>; resolve(): void };
}
interface DrainRecord { permit: PermitRecord; kind: RunDrainKind; confirmed: boolean }
interface AcceptedWrite { active: boolean }
type GuardedWork<T> = (guard: PlacementWriteGuard) => Promise<T>;

/**
 * Inactive cooperative core, not cross-process exclusion or child recovery.
 * Synchronous registration segments are the short admission critical section.
 * No global mutex spans resolver/project-gate awaits. Domain locks and SQL follow
 * the acquired project gates. Admission from inside an accepted write callback
 * refuses (COORDINATOR_BUSY) rather than deadlock or break sorted gate order;
 * callbacks must reuse their permit. Bootstrap and every writer remain gated.
 */
export class PlacementWriteCoordinator {
  readonly #owner: PlacementRuntimeOwner;
  #recovery: PlacementRecoveryCapability | undefined;
  readonly #resolveProjectRoot: PlacementCoordinatorOptions['resolveProjectRoot'];
  readonly #observeProjectRoot: PlacementCoordinatorOptions['observeProjectRoot'];
  readonly #accepted = new AsyncLocalStorage<AcceptedWrite>();
  #mode: 'open' | 'closed' | 'placement';
  #permits = new WeakMap<object, PermitRecord>();
  #drains = new WeakMap<object, DrainRecord>();
  #active = new Map<object, PermitRecord>();
  #gates = new Map<string, ProjectGate>();
  #idleWaiters = new Set<() => void>();
  constructor(options: PlacementCoordinatorOptions) {
    const owner = inspectOwner(options.owner);
    if (owner.coordinatorBound) fail('COORDINATOR_BUSY', 'Owner already has a coordinator');
    if (options.recovery) inspectRecovery(options.owner, options.recovery);
    owner.coordinatorBound = true; owner.hasRegistrations = () => this.#active.size > 0;
    this.#owner = options.owner; this.#recovery = options.recovery;
    this.#resolveProjectRoot = options.resolveProjectRoot;
    this.#observeProjectRoot = options.observeProjectRoot;
    this.#mode = options.recovery ? 'open' : 'closed';
  }
  acquireMutation(request: PlacementAdmission): Promise<MutationPermit> {
    return this.#acquire('mutation', request) as Promise<MutationPermit>;
  }
  acquirePlacement(request: PlacementAdmission): Promise<MutationPermit> {
    return this.#acquire('placement', request) as Promise<MutationPermit>;
  }
  admitRun(request: PlacementAdmission): Promise<RunPermit> {
    return this.#acquire('run', request) as Promise<RunPermit>;
  }
  async startRun(permit: RunPermit, request: Pick<PlacementAdmission, 'projectRoots'>): Promise<void> {
    const record = this.#permit(permit, 'run'); this.#requireOpen();
    if (record.phase !== 'queued') fail('RUN_STATE', 'Run is not queued');
    const roots = await this.#resolveRoots(this.#captureRoots(request.projectRoots));
    this.#requireOpen(); this.#permit(permit, 'run');
    if (record.phase !== 'queued' || record.finish || record.writes > 0) fail('RUN_STATE', 'Run can no longer start');
    if (roots.length !== record.roots.length || roots.some((root, index) => root !== record.roots[index])) fail('RUN_SCOPE_CHANGED', 'Frozen run scope changed');
    this.#requireProjectScope(record.roots);
    record.started = true; record.phase = 'running';
  }
  /** Registry allocation only; queued runs still cannot publish or spawn. Its gates are held: no fresh admission inside. */
  async withRunAllocation<T>(permit: RunPermit, work: () => Promise<T>): Promise<T> {
    const record = this.#permit(permit, 'run'); this.#requireOpen(); this.#requireProjectScope(record.roots);
    if (record.phase !== 'queued' || record.finish) fail('RUN_STATE', 'Run cannot allocate');
    record.writes += 1;
    const admitted: AcceptedWrite = { active: true };
    try { return await this.#accepted.run(admitted, work); }
    finally { admitted.active = false; record.writes -= 1; this.#finishIfDrained(record); }
  }
  cancelRun(permit: RunPermit): void {
    const record = this.#permit(permit, 'run');
    record.phase = 'draining';
  }
  /** Reserve immediately before spawn/work; runtime must attest actual drainage. */
  registerRunDrain(permit: RunPermit, kind: RunDrainKind): RunDrainPermit {
    const record = this.#permit(permit, 'run'); this.#checkOwnerAndRecovery();
    if (record.finish || record.phase === 'acquiring') fail('RUN_STATE', 'Drain registration is sealed');
    if (kind !== 'child' && kind !== 'publication' && kind !== 'cleanup') fail('RUN_STATE', 'Unknown drain kind');
    if (!record.started && kind !== 'cleanup') fail('RUN_STATE', 'Run has not started');
    if (kind === 'child') {
      this.#requireOpen(); this.#requireProjectScope(record.roots);
      if (record.phase !== 'running') fail('RUN_STATE', 'Child admission is closed');
    }
    const ticket = Object.freeze({}) as RunDrainPermit;
    record.drains.add(ticket); this.#drains.set(ticket, { permit: record, kind, confirmed: false });
    return ticket;
  }
  confirmRunDrain(ticket: RunDrainPermit): void {
    const drain = object(ticket) ? this.#drains.get(ticket) : undefined;
    if (!drain) return fail('INVALID_PERMIT', 'Unknown drain capability');
    if (drain.confirmed) fail('PERMIT_RELEASED', 'Drain already confirmed');
    drain.confirmed = true; drain.permit.drains.delete(ticket); this.#finishIfDrained(drain.permit);
  }
  withProjectWrite<T>(permit: MutationPermit | RunPermit, projectRoot: string, work: GuardedWork<T>): Promise<T> {
    return this.#write(permit, projectRoot, work);
  }
  /** Root-owned CAS/journal I/O only; this must not bypass physical project gates. */
  withDataRootWrite<T>(permit: MutationPermit | RunPermit, work: GuardedWork<T>): Promise<T> {
    return this.#write(permit, undefined, work);
  }
  /** A reserved final callback remains admitted after finish seals new work. */
  withDrainProjectWrite<T>(ticket: RunDrainPermit, projectRoot: string, work: GuardedWork<T>): Promise<T> {
    return this.#drainWrite(ticket, projectRoot, work);
  }
  withDrainDataRootWrite<T>(ticket: RunDrainPermit, work: GuardedWork<T>): Promise<T> {
    return this.#drainWrite(ticket, undefined, work);
  }
  /** Throws COORDINATOR_BUSY inside an accepted write or run-allocation callback, before any registration or admission side effect. */
  assertOutsideAcceptedWrite(): void {
    if (this.#accepted.getStore()?.active) fail('COORDINATOR_BUSY', 'Nested admission inside an admitted callback; reuse its permit');
  }
  releaseMutation(permit: MutationPermit): void {
    const record = this.#permit(permit, 'mutation');
    if (record.writes > 0) fail('DRAIN_ACTIVE', 'Publication has not drained');
    this.#release(record);
  }
  finishRun(permit: RunPermit): Promise<void> {
    const record = this.#permit(permit, 'run');
    if (record.finish) return record.finish.promise;
    record.phase = 'draining';
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    record.finish = { promise, resolve }; this.#finishIfDrained(record);
    return promise;
  }
  closeAdmission(): Promise<void> {
    this.#closeAcquisitions();
    if (this.#active.size === 0) return Promise.resolve();
    return new Promise(resolve => this.#idleWaiters.add(resolve));
  }
  openAdmission(recovery?: PlacementRecoveryCapability): void {
    try {
      inspectOwner(this.#owner);
      if (this.#active.size > 0) fail('COORDINATOR_BUSY', 'Registrations have not drained');
      inspectRecovery(this.#owner, recovery ?? this.#recovery);
      if (recovery) this.#recovery = recovery;
      this.#mode = 'open';
    } catch (error) {
      if (error instanceof PlacementCoordinationError && error.code.startsWith('OWNER_')) {
        const retained = this.#recovery ? recoveries.get(this.#recovery) : undefined;
        if (retained) retained.invalidated = true;
        this.#recovery = undefined; this.#closeAcquisitions();
      }
      throw error;
    }
  }
  snapshot(): Readonly<{ mode: 'open' | 'closed' | 'placement'; registrations: number; runs: number; acquiring: number; recoveryRequired: boolean }> {
    const records = [...this.#active.values()];
    return Object.freeze({ mode: this.#mode, registrations: records.length, runs: records.filter(item => item.kind === 'run').length,
      acquiring: records.filter(item => item.phase === 'acquiring').length, recoveryRequired: this.#recovery === undefined });
  }
  #checkOwnerAndRecovery(): ReadonlySet<string> {
    try { inspectOwner(this.#owner); return inspectRecovery(this.#owner, this.#recovery); }
    catch (error) { this.#recovery = undefined; this.#closeAcquisitions(); throw error; }
  }
  #requireOpen(): void {
    this.#checkOwnerAndRecovery();
    if (this.#mode !== 'open') fail('ADMISSION_CLOSED', 'New admission is closed');
  }
  #requireProjectScope(roots: readonly string[]): void {
    const blocked = this.#checkOwnerAndRecovery();
    if (roots.some(root => blocked.has(root))) fail('PROJECT_RECOVERING', 'A physical project has unresolved recovery');
  }
  #closeAcquisitions(): void {
    this.#mode = 'closed';
    for (const record of this.#active.values()) if (record.phase === 'acquiring') record.abort.abort();
  }
  #captureRoots(roots: readonly string[]): readonly string[] {
    if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string' && root.length > 0)) fail('INVALID_PROJECT_ROOT', 'Project roots are required');
    return Object.freeze([...roots]);
  }
  async #resolveRoots(inputs: readonly string[]): Promise<readonly string[]> {
    const roots = await Promise.all(inputs.map(root => this.#resolveProjectRoot(root)));
    if (!roots.every(canonical)) fail('INVALID_PROJECT_ROOT', 'Resolver must return canonical physical roots');
    return Object.freeze([...new Set(roots)].sort());
  }
  #gate(root: string): ProjectGate {
    let gate = this.#gates.get(root);
    if (!gate) {
      const created = new ProjectGate(() => { if (this.#gates.get(root) === created) this.#gates.delete(root); });
      gate = created; this.#gates.set(root, created);
    }
    return gate;
  }
  async #acquire(kind: PermitRecord['kind'], request: PlacementAdmission): Promise<MutationPermit | RunPermit> {
    this.assertOutsideAcceptedWrite(); this.#requireOpen(); const inputs = this.#captureRoots(request.projectRoots); const signal = request.signal;
    if (signal && !(signal instanceof AbortSignal)) fail('ADMISSION_CANCELLED', 'Native AbortSignal is required');
    if (signal?.aborted) fail('ADMISSION_CANCELLED', 'Admission cancelled');
    if (kind === 'placement' && this.#active.size > 0) fail('COORDINATOR_BUSY', 'Placement requires drained data-root work');
    if (kind === 'placement') this.#mode = 'placement';
    // No await between the admission decision and registration.
    const token = Object.freeze({}) as MutationPermit | RunPermit;
    const record: PermitRecord = { token, kind, phase: 'acquiring', roots: [], abort: new AbortController(), releaseGates: [], started: false, writes: 0, drains: new Set(), pins: new Map(), inputs };
    this.#permits.set(token, record); this.#active.set(token, record);
    try {
      if (signal) {
        const abort = () => record.abort.abort();
        record.removeSignal = () => signal.removeEventListener('abort', abort);
        signal.addEventListener('abort', abort, { once: true });
      }
      record.roots = await this.#resolveRoots(inputs);
      if (record.abort.signal.aborted) fail('ADMISSION_CANCELLED', 'Admission cancelled');
      this.#requireProjectScope(record.roots);
      for (const root of record.roots) {
        record.releaseGates.push(await this.#gate(root).acquire(record.abort.signal));
        if (record.abort.signal.aborted) fail('ADMISSION_CANCELLED', 'Admission cancelled');
        this.#requireProjectScope(record.roots);
      }
      record.removeSignal?.();
      record.phase = kind === 'run' ? 'queued' : 'active';
      return token;
    } catch (error) { this.#release(record); throw error; }
  }
  #permit(token: MutationPermit | RunPermit, kind?: 'mutation' | 'run'): PermitRecord {
    const record = object(token) ? this.#permits.get(token) : undefined;
    if (!record) return fail('INVALID_PERMIT', 'Unknown permit capability');
    if (record.phase === 'released') return fail('PERMIT_RELEASED', 'Permit was released');
    if (kind && (record.kind === 'run') !== (kind === 'run')) return fail('INVALID_PERMIT', 'Wrong permit kind');
    return record;
  }
  async #drainWrite<T>(ticket: RunDrainPermit, projectRoot: string | undefined, work: GuardedWork<T>): Promise<T> {
    const drain = object(ticket) ? this.#drains.get(ticket) : undefined;
    if (!drain) return fail('INVALID_PERMIT', 'Unknown final-work capability');
    if (drain.confirmed) return fail('PERMIT_RELEASED', 'Final work already drained');
    if (drain.kind === 'child') return fail('RUN_STATE', 'A child ticket cannot publish');
    return this.#write(drain.permit.token, projectRoot, work, drain);
  }
  async #write<T>(token: MutationPermit | RunPermit, projectRoot: string | undefined, work: GuardedWork<T>, drain?: DrainRecord): Promise<T> {
    const record = this.#permit(token);
    if (projectRoot === undefined) this.#checkOwnerAndRecovery(); else this.#requireProjectScope(record.roots);
    if (record.phase === 'acquiring' || ((record.phase === 'draining' || record.finish) && !drain)) fail('RUN_STATE', 'Permit cannot admit new publication');
    if (record.kind === 'run' && !record.started && !(drain?.kind === 'cleanup' && projectRoot === undefined)) fail('RUN_STATE', 'Unstarted run cannot publish');
    record.writes += 1;
    const accepted: AcceptedWrite = { active: true };
    try {
      if (projectRoot !== undefined) {
        const [root] = await this.#resolveAdmitted(record, projectRoot);
        if (!root || !record.roots.includes(root)) fail('RUN_SCOPE_CHANGED', 'Publication is outside the frozen physical scope');
        this.#pin(record, projectRoot, root!);
      }
      if (projectRoot === undefined) this.#checkOwnerAndRecovery(); else this.#requireProjectScope(record.roots);
      const guard: PlacementWriteGuard = Object.freeze({ assertCurrent: () => {
        if (!accepted.active) fail('PERMIT_RELEASED', 'Final I/O is outside its accepted write');
        if (projectRoot === undefined) { this.#checkOwnerAndRecovery(); return; }
        this.#requireProjectScope(record.roots);
        this.#pin(record, projectRoot);
      } });
      // Accepted publications survive cancellation/admission close/finish; their activity
      // holds gates until the entire callback, including cleanup, settles.
      return await this.#accepted.run(accepted, () => work(guard));
    } finally { accepted.active = false; record.writes -= 1; this.#finishIfDrained(record); }
  }
  /** An admitted input that no longer resolves (retargeted, replaced, deauthorized) left its accepted scope. */
  async #resolveAdmitted(record: PermitRecord, input: string): Promise<readonly string[]> {
    try { return await this.#resolveRoots([input]); }
    catch (error) {
      if (error instanceof PlacementCoordinationError && error.code === 'INVALID_PROJECT_ROOT' && (record.inputs.includes(input) || record.pins.has(input))) {
        return fail('RUN_SCOPE_CHANGED', 'Admitted project root authority changed');
      }
      throw error;
    }
  }
  #observe(input: string, gateKey: string, roots: readonly string[]): PlacementRootObservation | undefined {
    if (!this.#observeProjectRoot) return undefined;
    let observed: PlacementRootObservation;
    try { observed = this.#observeProjectRoot(input); } catch { return fail('RUN_SCOPE_CHANGED', 'Project root authority changed'); }
    if (observed.gateKey !== gateKey || !roots.includes(observed.gateKey)) fail('RUN_SCOPE_CHANGED', 'Project root left the accepted physical scope');
    return observed;
  }
  /**
   * Permit-lifetime pin: the first observation is kept; later ones need the same gate,
   * physical root and epoch, and the same identity once one was observed. A root absent
   * at admission pins the first identity any callback of this permit observes.
   */
  #pin(record: PermitRecord, input: string, gateKey?: string): void {
    const pinned = record.pins.get(input);
    const now = this.#observe(input, pinned?.gateKey ?? gateKey!, record.roots);
    if (!now) return;
    if (!pinned) { record.pins.set(input, now); return; }
    if (now.gateKey !== pinned.gateKey || now.physicalRoot !== pinned.physicalRoot || now.epoch !== pinned.epoch) fail('RUN_SCOPE_CHANGED', 'Project root was retargeted');
    if (!pinned.identity) { if (now.identity) record.pins.set(input, now); return; }
    if (!now.identity || now.identity.device !== pinned.identity.device || now.identity.inode !== pinned.identity.inode) fail('RUN_SCOPE_CHANGED', 'Project root was replaced');
  }
  #finishIfDrained(record: PermitRecord): void {
    if (record.finish && record.drains.size === 0 && record.writes === 0) {
      const resolve = record.finish.resolve; this.#release(record); resolve();
    }
  }
  #release(record: PermitRecord): void {
    record.phase = 'released'; record.removeSignal?.();
    for (const release of record.releaseGates.splice(0).reverse()) release();
    this.#active.delete(record.token);
    if (record.kind === 'placement' && this.#mode === 'placement') this.#mode = 'open';
    if (this.#active.size === 0) { for (const resolve of this.#idleWaiters) resolve(); this.#idleWaiters.clear(); }
  }
}
