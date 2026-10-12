import { lstatSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { PlacementCoordinationError, type PlacementWriteCoordinator, type MutationPermit, type PlacementRootObservation } from './write-coordinator.js';

export type PlacementProjectKind = 'managed' | 'imported';
/** Server-authorized project record (database row); never a request body. */
export interface PlacementProjectSource { id: string; metadata?: unknown }
export interface PlacementProjectLocation { kind: PlacementProjectKind; path: string }
export interface PhysicalIdentity { device: string; inode: string }
export interface PlacementProjectRegistration {
  readonly projectId: string; readonly kind: PlacementProjectKind;
  /** Canonical physical root and its identity; distinct from the coalesced gate key. */
  readonly physicalRoot: string; readonly identity: PhysicalIdentity | null;
  readonly gateKey: string;
}
export class PlacementCapabilityError extends Error {
  readonly reason = 'unsupported-capability' as const;
  constructor(message: string) { super(message); this.name = 'PlacementCapabilityError'; }
}
export interface PlacementProjectRegistryOptions {
  /** Managed-project root under the resolved daemon data root. */
  projectsRoot: string;
  readProject(projectId: string): PlacementProjectSource | null;
  listProjects(): readonly PlacementProjectSource[];
  /** Existing server project-directory resolution; the default mirrors managed/imported `metadata.baseDir`. */
  locate?(source: PlacementProjectSource, projectsRoot: string): PlacementProjectLocation;
}
interface Entry { projectId: string; kind: PlacementProjectKind; physicalRoot: string; identity: PhysicalIdentity | null; location: string }

export function defaultPlacementProjectLocation(source: PlacementProjectSource, projectsRoot: string): PlacementProjectLocation {
  const baseDir = (source.metadata as { baseDir?: unknown } | null | undefined)?.baseDir;
  if (typeof baseDir === 'string' && path.isAbsolute(path.normalize(baseDir))) return { kind: 'imported', path: path.normalize(baseDir) };
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(source.id) || source.id === '.' || source.id === '..') throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Unsafe managed project id');
  return { kind: 'managed', path: path.join(projectsRoot, source.id) };
}
// Case/Unicode folding is deliberately conservative: over-coalescing only serializes.
const fold = (value: string) => value.normalize('NFC').toLowerCase();
function contains(outer: string, inner: string): boolean {
  const o = fold(outer), i = fold(inner);
  return o === i || i.startsWith(o.endsWith(path.sep) ? o : o + path.sep);
}
const sameIdentity = (a: PhysicalIdentity | null, b: PhysicalIdentity | null) => a === null ? b === null : b !== null && a.device === b.device && a.inode === b.inode;
const overlaps = (a: Pick<Entry, 'physicalRoot' | 'identity'>, b: Pick<Entry, 'physicalRoot' | 'identity'>) =>
  contains(a.physicalRoot, b.physicalRoot) || contains(b.physicalRoot, a.physicalRoot)
  || (a.identity !== null && b.identity !== null && a.identity.device === b.identity.device && a.identity.inode === b.identity.inode);

/** Exact (unfolded) strict containment of one canonical path inside another; equality is not containment. */
export function isStrictlyInside(outer: string, inner: string): boolean {
  const relative = path.relative(outer, inner);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}
/** Conservative physical overlap (equal, ancestor or descendant after case/Unicode folding). */
export function placementRootsOverlap(a: string, b: string): boolean { return contains(a, b) || contains(b, a); }
const registrationCancelled = () => new PlacementCoordinationError('ADMISSION_CANCELLED', 'Registration cancelled');
/** Rejects this caller on abort while `work` keeps settling (its outcome stays observed). */
function abandonOnAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(registrationCancelled());
    signal.addEventListener('abort', abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
/** Canonical physical root of a located project; throws INVALID_PROJECT_ROOT when it cannot be resolved. */
export function resolvePlacementPhysicalRoot(location: PlacementProjectLocation): { physicalRoot: string; identity: PhysicalIdentity | null } { return physical(location); }
function physical(location: PlacementProjectLocation): { physicalRoot: string; identity: PhysicalIdentity | null } {
  try {
    const physicalRoot = realpathSync.native(location.path);
    const stat = lstatSync(physicalRoot, { bigint: true });
    if (!stat.isDirectory()) throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project root is not a directory');
    return { physicalRoot, identity: { device: String(stat.dev), inode: String(stat.ino) } };
  } catch (error) {
    if (error instanceof PlacementCoordinationError) throw error;
    // A not-yet-created managed root is named under its canonical parent; unknown imported authority never is.
    if (location.kind === 'managed' && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      try { return { physicalRoot: path.join(realpathSync.native(path.dirname(location.path)), path.basename(location.path)), identity: null }; } catch { /* fall through */ }
    }
    throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project physical root is unavailable');
  }
}

/**
 * One server-owned same-data-root registry for managed and imported roots.
 * It feeds the coordinator's `resolveProjectRoot` injection with coalesced
 * gate keys and maps journal recovery fences through the same registrations.
 * Overlapping/identity-alias changes replace the epoch only after global
 * admission closes and every live permit drains. No claim covers other data
 * roots or external/native editors.
 */
export class PlacementProjectRegistry {
  readonly #options: PlacementProjectRegistryOptions;
  readonly #locate: NonNullable<PlacementProjectRegistryOptions['locate']>;
  #entries = new Map<string, Entry>();
  #gates = new Map<string, string>();
  #epoch = 0;
  #coordinator: PlacementWriteCoordinator | null = null;
  #exclusive: Promise<unknown> = Promise.resolve();
  #unavailable = new Set<string>();
  constructor(options: PlacementProjectRegistryOptions) {
    this.#options = options; this.#locate = options.locate ?? defaultPlacementProjectLocation;
  }
  get epoch(): number { return this.#epoch; }
  get unavailableProjects(): readonly string[] { return [...this.#unavailable].sort(); }
  /** Bind the single coordinator whose admission must drain before epoch replacement. */
  attach(coordinator: PlacementWriteCoordinator): void {
    if (this.#coordinator) throw new PlacementCoordinationError('COORDINATOR_BUSY', 'Registry already has a coordinator');
    this.#coordinator = coordinator;
  }
  /** Initial epoch only, before a coordinator attaches; later changes go through drained replacement. */
  load(): void {
    if (this.#coordinator || this.#epoch !== 0) throw new PlacementCoordinationError('COORDINATOR_BUSY', 'Registry load is initial-only; use drained registration');
    const next = new Map<string, Entry>(); this.#unavailable.clear();
    for (const source of this.#options.listProjects()) {
      try { next.set(source.id, this.#derive(source)); } catch { this.#unavailable.add(source.id); }
    }
    this.#install(next);
  }
  /** The coordinator injection: canonical gate key for an authorized project id. */
  readonly resolveProjectRoot = async (projectId: string): Promise<string> => this.#current(projectId).gateKey;
  /** The coordinator's synchronous final-I/O injection: CURRENT authorized root, fresh identity and epoch. */
  readonly observeProjectRoot = (projectId: string): PlacementRootObservation => {
    const { entry, fresh } = this.#verified(projectId);
    return Object.freeze({ gateKey: this.#gates.get(entry.projectId)!, physicalRoot: entry.physicalRoot, identity: fresh.identity, epoch: this.#epoch });
  };
  describe(projectId: string): PlacementProjectRegistration { return this.#current(projectId); }
  registrations(): readonly PlacementProjectRegistration[] { return [...this.#entries.values()].map(entry => this.#view(entry)); }
  /**
   * Managed adoption targets only; imported roots are 422 and preserve caller choices.
   * A managed target's physical root must lie strictly inside the canonical managed
   * projects root, so a managed directory that is a symlink elsewhere is never a target.
   */
  resolveAdoptionTarget(projectId: string): PlacementProjectRegistration {
    const registration = this.#current(projectId);
    if (registration.kind !== 'managed') throw new PlacementCapabilityError('Adoption into imported project roots is unsupported');
    let managedRoot: string;
    try { managedRoot = realpathSync.native(this.#options.projectsRoot); }
    catch { throw new PlacementCapabilityError('Adoption target is outside the managed projects root (root unavailable)'); }
    if (!isStrictlyInside(managedRoot, registration.physicalRoot)) throw new PlacementCapabilityError('Adoption target is outside the managed projects root');
    return registration;
  }
  /** Journal-fenced physical roots → gate keys; unregistered fences remain their own key. */
  mapBlockedRoots(roots: readonly string[]): readonly string[] {
    const keys = new Set<string>();
    for (const root of roots) {
      const hits = [...this.#entries.values()].filter(entry => contains(entry.physicalRoot, root) || contains(root, entry.physicalRoot));
      if (hits.length === 0) keys.add(root); else for (const entry of hits) keys.add(this.#gates.get(entry.projectId)!);
    }
    return [...keys].sort();
  }
  projectIdsForGateKeys(keys: readonly string[]): readonly string[] {
    const wanted = new Set(keys);
    return [...this.#entries.values()].filter(entry => wanted.has(this.#gates.get(entry.projectId)!)).map(entry => entry.projectId).sort();
  }
  /**
   * Adds a non-overlapping root directly; overlapping roots replace the epoch after drain.
   * `signal` refuses before any effect and while queued; once a replacement has begun its
   * drain, aborting only stops this caller's wait. The drain, install and reopen still settle.
   */
  registerProject(projectId: string, options: { signal?: AbortSignal } = {}): Promise<PlacementProjectRegistration> {
    const { signal } = options;
    if (signal?.aborted) return Promise.reject(registrationCancelled());
    const registration = this.#serial(async () => {
      if (signal?.aborted) throw registrationCancelled(); // cancelled while queued: no effect
      const source = this.#options.readProject(projectId);
      if (!source) throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project is not authorized');
      const entry = this.#derive(source); const existing = this.#entries.get(projectId);
      const samePlace = existing && existing.physicalRoot === entry.physicalRoot && existing.kind === entry.kind && existing.location === entry.location;
      if (samePlace && sameIdentity(existing.identity, entry.identity)) return this.#view(existing);
      const next = new Map(this.#entries); next.set(projectId, entry);
      // First observation of a not-yet-created root at the same place: the gate key and coalescence are
      // unchanged unless the identity aliases another registration, so no admission drain is needed.
      if (samePlace && existing.identity === null && entry.identity !== null
        && [...this.#entries.values()].every(other => other.projectId === projectId || !overlaps(other, entry) || overlaps(other, existing))) {
        this.#install(next, false); return this.#view(entry);
      }
      const isolated = !existing && [...this.#entries.values()].every(other => !overlaps(other, entry));
      if (isolated) this.#install(next, false); else await this.#replace(next);
      this.#unavailable.delete(projectId);
      return this.#view(entry);
    });
    return signal ? abandonOnAbort(registration, signal) : registration;
  }
  /** Delete/retarget: replace the epoch only after global close and actual drain. */
  unregisterProject(projectId: string): Promise<void> {
    return this.#serial(async () => {
      if (!this.#entries.has(projectId)) return;
      const next = new Map(this.#entries); next.delete(projectId); await this.#replace(next);
    });
  }
  /**
   * New managed/imported project: root-store admission before creation, then
   * registration, then project I/O under that project's gate.
   */
  async createProjectUnderAdmission<T>(input: { projectId: string; persist(): Promise<void>; initialize(write: <R>(work: () => Promise<R>) => Promise<R>): Promise<T> }): Promise<{ result: T; registration: PlacementProjectRegistration }> {
    const coordinator = this.#requireCoordinator();
    const root = await coordinator.acquireMutation({ projectRoots: [] });
    try { await coordinator.withDataRootWrite(root, input.persist); } finally { coordinator.releaseMutation(root); }
    await this.registerProject(input.projectId);
    const permit: MutationPermit = await coordinator.acquireMutation({ projectRoots: [input.projectId] });
    let result: T;
    try { result = await input.initialize(work => coordinator.withProjectWrite(permit, input.projectId, work)); }
    finally { coordinator.releaseMutation(permit); }
    // Record the identity the initialization actually created (or a drained replacement if it aliased).
    return { result, registration: await this.registerProject(input.projectId) };
  }
  /** Shared serialization with recovery refresh so admission reopen cannot interleave a replacement. */
  exclusive<T>(work: () => Promise<T>): Promise<T> { return this.#serial(work); }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#exclusive.then(work, work); this.#exclusive = run.catch(() => undefined); return run;
  }
  #requireCoordinator(): PlacementWriteCoordinator {
    if (!this.#coordinator) throw new PlacementCoordinationError('ADMISSION_CLOSED', 'No coordinated runtime owns this registry');
    return this.#coordinator;
  }
  async #replace(next: Map<string, Entry>): Promise<void> {
    const coordinator = this.#coordinator;
    if (!coordinator) { this.#install(next); return; }
    await coordinator.closeAdmission(); // Waits for every live permit, ticket and accepted callback.
    this.#install(next);
    coordinator.openAdmission();
  }
  #derive(source: PlacementProjectSource): Entry {
    const location = this.#locate(source, this.#options.projectsRoot);
    return { projectId: source.id, kind: location.kind, location: location.path, ...physical(location) };
  }
  #current(projectId: string): PlacementProjectRegistration { return this.#view(this.#verified(projectId).entry); }
  #verified(projectId: string): { entry: Entry; fresh: Entry } {
    const entry = this.#entries.get(projectId);
    if (!entry) throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project root is not registered in the current epoch');
    const source = this.#options.readProject(projectId);
    if (!source) throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project is no longer authorized');
    const fresh = this.#derive(source);
    // A changed authorized location or physical root needs a drained epoch replacement first.
    if (fresh.kind !== entry.kind || fresh.location !== entry.location || fresh.physicalRoot !== entry.physicalRoot
      || (entry.identity && (!fresh.identity || fresh.identity.device !== entry.identity.device || fresh.identity.inode !== entry.identity.inode))) {
      throw new PlacementCoordinationError('INVALID_PROJECT_ROOT', 'Project registration is stale; epoch replacement required');
    }
    return { entry, fresh };
  }
  #view(entry: Entry): PlacementProjectRegistration {
    return Object.freeze({ projectId: entry.projectId, kind: entry.kind, physicalRoot: entry.physicalRoot, identity: entry.identity, gateKey: this.#gates.get(entry.projectId)! });
  }
  #install(next: Map<string, Entry>, bumpEpoch = true): void {
    const entries = [...next.values()];
    const gates = new Map<string, string>();
    const unseen = new Set(entries);
    for (const entry of entries) {
      if (!unseen.delete(entry)) continue;
      // Identity aliases can bridge path-overlap chains; all connected roots need one gate.
      const component = [entry];
      for (let index = 0; index < component.length; index += 1) {
        for (const other of unseen) {
          if (!overlaps(component[index]!, other)) continue;
          unseen.delete(other); component.push(other);
        }
      }
      const outer = component.sort((a, b) => a.physicalRoot.length - b.physicalRoot.length
        || (a.physicalRoot < b.physicalRoot ? -1 : a.physicalRoot > b.physicalRoot ? 1 : 0))[0]!;
      for (const member of component) gates.set(member.projectId, outer.physicalRoot);
    }
    this.#entries = next; this.#gates = gates;
    if (bumpEpoch) this.#epoch += 1;
  }
}
