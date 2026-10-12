import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { AdoptionBlobStore } from './adoption-files.js';
import { PlacementAdoptionExecutor } from './adoption-executor.js';
import { createNativeAdoptionMover } from './adoption-mover.js';
import { AdoptionExposure, closedAdoptionGates, prepareAdoptionWorkRoot } from './adoption-provisioning.js';
import { AdoptionStore } from './adoption-store.js';
import type { Helper } from './driver.js';
import { PlacementJournal, type JournalOperation, type RecoveryObservation } from './journal.js';
import { registerOwnedWorkbenchMigrations, OwnedMigrationError } from './owned-migrations.js';
import { confirmRootSeal, markRootSealConsumed, recordRootSeal, writeRootSeal } from './root-seal.js';
import type { PlacementBootstrap } from './owner-bootstrap.js';
import {
  defaultPlacementProjectLocation, placementRootsOverlap, PlacementProjectRegistry, resolvePlacementPhysicalRoot,
  type PlacementProjectLocation, type PlacementProjectSource,
} from './project-registry.js';
import { createCoordinatedProjectWrites, createFenceOnlyProjectWrites, type PlacementProjectWrites } from './project-writes.js';
import { PlacementRunLifetime } from './run-lifetime.js';
import { PLACEMENT_ACTIVATION_GATES, mapPlacementFailure, type PlacementHttpMapping, type PlacementMode, type PlacementPredecessorProof, type PlacementRuntimeStatus } from './runtime-status.js';
import {
  collectPriorLaunchRecovery, createDarwinProcessInspector, darwinSampledTreeCompleteness, PlacementLaunchSupervisor,
  type PlacementProcessInspector, type PlacementTreeCompleteness, type PriorLaunchRecovery,
} from './supervisor.js';
import {
  authorizePlacementRecovery, bindPlacementRuntimeOwner, PlacementCoordinationError, PlacementWriteCoordinator,
  type PlacementRuntimeOwner,
} from './write-coordinator.js';

export interface PlacementRuntimeDependencies {
  db: Database.Database;
  /** Managed-project root derived from the resolved daemon data root. */
  projectsDir: string;
  readProject(projectId: string): PlacementProjectSource | null;
  listProjects(): readonly PlacementProjectSource[];
  locate?(source: PlacementProjectSource, projectsRoot: string): PlacementProjectLocation;
  inspector?: PlacementProcessInspector;
  /** Owned-tree completeness proof; defaults to the Darwin sampler, which never certifies same-boot drainage. */
  completeness?: PlacementTreeCompleteness;
  /**
   * Adoption executor inputs: the explicitly provisioned native movement
   * helper and the adoption work root derived from the resolved daemon data
   * root (same volume as managed projects, checked when the executor is
   * built). `toolRoot` is the data-root directory holding the tool
   * directory; no project root may overlap it. Absent: adoption stays closed.
   */
  adoption?: { helper: Helper; workRoot: string; toolRoot?: string };
  /** Named provisioning gates when the daemon refused to provision (`adoption-provisioning.ts`); reported in status. */
  adoptionRefusal?: readonly string[];
  /** The user's Settings → Labs switch, read on every access (default on for direct callers). */
  adoptionEnabled?: () => boolean;
}
/** The single daemon placement runtime. Consumers receive these exports; they never construct owners or stores. */
export interface PlacementRuntime {
  readonly mode: PlacementMode;
  status(): PlacementRuntimeStatus;
  readonly registry: PlacementProjectRegistry | null;
  readonly coordinator: PlacementWriteCoordinator | null;
  readonly supervisor: PlacementLaunchSupervisor | null;
  readonly runLifetime: PlacementRunLifetime | null;
  /** Standalone manual project-file admission and final-I/O checks (coordinated gates or fence-only). */
  readonly projectWrites: PlacementProjectWrites;
  /** Prepare/apply/undo executor; null unless coordinated with an owned journal and a provisioned helper. */
  readonly adoption: PlacementAdoptionExecutor | null;
  /**
   * B4-1b clean stop: closes admission, and when this incarnation is eligible
   * (a proven root, open, nothing admitted, every operation settled without
   * recovery, every launch drained) records the next seal generation, closes
   * the database through `closeDatabase`, writes the root seal and only then
   * releases the native owner. Always closes the database and releases the
   * owner; an ineligible stop seals nothing, so the next boot stays unproven.
   */
  sealAndClose(options: { closeDatabase: () => void }): Promise<PlacementSealOutcome>;
  /** Choke-point guard for runs and other daemon mutations; throws mapped coordination errors. */
  assertMutationAdmissible(projectId?: string): void;
  /** HTTP mutation fence for mutating requests; null admits. */
  checkMutationRequest(request: { method: string; path: string; body?: unknown }): PlacementHttpMapping | null;
  /** Collect fresh exact facts; reopens admission only when the trusted predicate now clears. */
  refreshRecovery(): Promise<PlacementRuntimeStatus>;
  close(): void;
}

export type PlacementSealOutcome = { sealed: true; generation: number } | { sealed: false; reason: string };

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/**
 * Request-derived project candidates. They can only cause a refusal, never an
 * admission: route-authorized and tool-grant scopes are fenced again at the
 * write-mode authorization boundary (server `authorizeProjectRequest`).
 */
function requestProjectId(method: string, path: string, body: unknown): string | null {
  const match = /^\/api\/projects\/([^/?#]+)/.exec(path);
  if (match) { try { return decodeURIComponent(match[1]!); } catch { return match[1]!; } }
  const fields = body as { projectId?: unknown; id?: unknown } | null | undefined;
  if (typeof fields?.projectId === 'string' && fields.projectId) return fields.projectId;
  if (method === 'POST' && path === '/api/projects' && typeof fields?.id === 'string' && fields.id) return fields.id;
  return null;
}
function fenceCheck(method: string, path: string, body: unknown, assert: (projectId?: string) => void, assertBaseDir: (baseDir: string) => void): PlacementHttpMapping | null {
  if (!MUTATING.has(method.toUpperCase()) || !path.startsWith('/api/')) return null;
  try {
    assert(requestProjectId(method.toUpperCase(), path, body) ?? undefined);
    const baseDir = (body as { baseDir?: unknown } | null | undefined)?.baseDir;
    if (typeof baseDir === 'string' && baseDir) assertBaseDir(baseDir);
    return null;
  } catch (error) { return mapPlacementFailure(error) ?? mapPlacementFailure(new PlacementCoordinationError('ADMISSION_CLOSED', 'Placement fence is unavailable')); }
}
/**
 * Physical recovery fences stay authoritative; a project's CURRENT authorized
 * location is resolved at each check, so later imports or rebinds onto an
 * overlapping root refuse. Unresolvable roots fail closed while fences exist.
 */
function physicalFence(deps: PlacementRuntimeDependencies) {
  let projectsRoot = deps.projectsDir; try { projectsRoot = realpathSync.native(deps.projectsDir); } catch { /* lexical until created */ }
  const locate = deps.locate ?? defaultPlacementProjectLocation;
  const touches = (location: () => PlacementProjectLocation, fences: readonly string[]): boolean => {
    if (!fences.length) return false;
    try { const { physicalRoot } = resolvePlacementPhysicalRoot(location()); return fences.some(fence => placementRootsOverlap(fence, physicalRoot)); }
    catch { return true; }
  };
  return {
    project: (projectId: string, fences: readonly string[]) => touches(() => locate(deps.readProject(projectId) ?? { id: projectId }, projectsRoot), fences),
    baseDir: (baseDir: string, fences: readonly string[]) => touches(() => ({ kind: 'imported', path: baseDir }), fences),
    projectIds: (fences: readonly string[]) => fences.length ? deps.listProjects().filter(source => touches(() => locate(source, projectsRoot), fences)).map(source => source.id).sort() : [],
  };
}
const PROJECT_FENCED = 'Project root overlaps an unfinished coordinated placement; qualified coordinated recovery is required';

// Darwin O_NOFOLLOW_ANY (as in driver.ts): no symlink anywhere in the named path.
const NOFOLLOW_ANY = process.platform === 'darwin' ? 0x20000000 : constants.O_NOFOLLOW;
const MAX_OBSERVED_BYTES = 32 * 1024 * 1024;
type NamedObservation = RecoveryObservation['objects'][number]['observation'];
/**
 * One exact observation of a named regular file: identity and bytes come from
 * the same descriptor, which must stay unchanged while read, and the name must
 * still resolve to that inode afterwards. Anything else is `unknown`. This is
 * readback evidence only, never movement or compensation authority.
 */
export function observeNamedRegularFile(location: string, hooks: { beforeRevalidate?: () => void } = {}): NamedObservation {
  let fd: number | null = null;
  try {
    try { fd = openSync(location, constants.O_RDONLY | constants.O_NONBLOCK | NOFOLLOW_ANY); }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { kind: 'absent' } : { kind: 'unknown' }; }
    const before = fstatSync(fd, { bigint: true });
    if (!before.isFile() || before.size > BigInt(MAX_OBSERVED_BYTES)) return { kind: 'unknown' };
    const bytes = Buffer.alloc(Number(before.size) + 1); let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length;) { read = readSync(fd, bytes, length, bytes.length - length, length); length += read; }
    const after = fstatSync(fd, { bigint: true });
    if (length !== Number(before.size) || after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs || after.ino !== before.ino) return { kind: 'unknown' };
    hooks.beforeRevalidate?.();
    const named = lstatSync(location, { bigint: true });
    if (!named.isFile() || named.dev !== before.dev || named.ino !== before.ino) return { kind: 'unknown' };
    return { kind: 'file', file: { device: String(before.dev), inode: String(before.ino), sha256: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), byteLength: length } };
  } catch { return { kind: 'unknown' }; }
  finally { if (fd !== null) closeSync(fd); }
}
/** Fresh exact-location readback for prior operations with movement intent. Facts only. */
export function observePriorOperations(journal: PlacementJournal): readonly RecoveryObservation[] {
  return journal.readPriorOperations().filter((op: JournalOperation) => op.movements.some(m => m.intent)).map(op => {
    const locations = new Set<string>();
    op.manifest.movements.forEach((move, i) => { if (op.movements[i]!.intent) { locations.add(move.source); locations.add(move.destination); } });
    return { operationId: op.manifest.operationId, revision: op.revision, objects: [...locations].map(location => ({ location, observation: observeNamedRegularFile(location) })) };
  });
}

/** The Labs switch; a throwing reader reads as off. Direct callers without one default to on. */
function labsOn(deps: PlacementRuntimeDependencies): boolean {
  try { return deps.adoptionEnabled ? deps.adoptionEnabled() === true : true; } catch { return false; }
}

function ordinaryRuntime(bootstrap: Extract<PlacementBootstrap, { mode: 'ordinary-uncoordinated' }>, deps: PlacementRuntimeDependencies): PlacementRuntime {
  const transition = bootstrap.transition;
  // Physical fences are fixed for this process (ordinary mode cannot run recovery); project membership is current.
  const fences = transition.fencedProjectRoots;
  const fence = physicalFence(deps);
  const assertMutationAdmissible = (projectId?: string) => {
    if (transition.global) throw new PlacementCoordinationError('ADMISSION_CLOSED', `Ordinary mutations are closed: ${transition.global}; qualified coordinated recovery is required`);
    if (projectId !== undefined && fence.project(projectId, fences)) throw new PlacementCoordinationError('PROJECT_RECOVERING', PROJECT_FENCED);
  };
  const assertBaseDir = (baseDir: string) => { if (fence.baseDir(baseDir, fences)) throw new PlacementCoordinationError('PROJECT_RECOVERING', PROJECT_FENCED); };
  const status = (): PlacementRuntimeStatus => ({
    schema: 'mishmash.placement-runtime-status/v1', mode: 'ordinary-uncoordinated',
    reason: bootstrap.reason === 'host-outside-cohort' ? `host-outside-cohort:${bootstrap.hostFact}` : 'not-activated',
    host: bootstrap.host, binding: null, dataRoot: null, incarnationId: null,
    recovery: { global: 'not-applicable', unresolvedLaunches: transition.unresolvedLaunches, priorLaunches: [], blockedGateKeys: [], blockedProjectIds: [] },
    transition: { kind: transition.kind, global: transition.global, fencedProjectRoots: fences, fencedProjectIds: fence.projectIds(fences), sidecars: transition.sidecars },
    registry: null,
    activation: { adoption: 'closed', gates: [
      ...PLACEMENT_ACTIVATION_GATES, 'ordinary-mode', ...closedAdoptionGates(deps.adoptionRefusal ?? [], labsOn(deps)),
      ...(transition.global || fences.length ? ['transition-fenced'] : []),
    ] },
  });
  return {
    mode: 'ordinary-uncoordinated', status, registry: null, coordinator: null, supervisor: null, runLifetime: null, adoption: null,
    projectWrites: createFenceOnlyProjectWrites({ assertMutationAdmissible }),
    assertMutationAdmissible,
    checkMutationRequest: ({ method, path, body }) => fenceCheck(method, path, body, assertMutationAdmissible, assertBaseDir),
    refreshRecovery: async () => status(),
    sealAndClose: async ({ closeDatabase }) => {
      try { closeDatabase(); } catch { /* nothing to seal in ordinary mode */ }
      bootstrap.rootLock?.release();
      return { sealed: false, reason: 'ordinary-mode' };
    },
    // The shared root lock lives as long as this ordinary daemon (root-seal.ts); stopping releases it.
    close: () => { bootstrap.rootLock?.release(); },
  };
}

/**
 * Attach the bootstrap to the opened daemon database. Coordinated bootstraps
 * register versioned migrations on the owned existing database, construct one
 * fresh journal incarnation and one coordinator, and bind the native owner to
 * the trusted journal reader (consulted on every check). Ordinary bootstraps
 * keep existing initialization and expose only C2a fences.
 */
export function attachPlacementRuntime(bootstrap: PlacementBootstrap, deps: PlacementRuntimeDependencies): PlacementRuntime {
  if (bootstrap.mode === 'ordinary-uncoordinated') return ordinaryRuntime(bootstrap, deps);
  const { db } = deps; const native = bootstrap.owner;
  const inspector = deps.inspector ?? createDarwinProcessInspector();
  const completeness = deps.completeness ?? darwinSampledTreeCompleteness;
  let failure: string | null = null;
  let journal: PlacementJournal | null = null;
  // B4-1b: only a root created by this boot, or a predecessor seal the owned database confirms, excludes an
  // unrecorded ordinary predecessor (RUNTIME.md "Legacy and mixed-mode roots", root-seal.ts).
  const sealEvidence = bootstrap.rootSeal ?? { kind: 'none' as const };
  const unproven = (reason: string): PlacementPredecessorProof => ({ proof: 'unproven', generation: null, reason });
  let predecessor: PlacementPredecessorProof = bootstrap.createdRoot ? { proof: 'created', generation: null, reason: null }
    : unproven(sealEvidence.kind === 'refused' ? sealEvidence.reason : 'predecessor-seal-absent');
  try {
    db.pragma('synchronous = FULL'); db.pragma('foreign_keys = ON');
    registerOwnedWorkbenchMigrations(db, bootstrap.canonicalDataRoot);
    if (!bootstrap.createdRoot && sealEvidence.kind === 'verified') {
      // Before this incarnation exists: the sealing incarnation must still be the journal's current one.
      const refused = confirmRootSeal(db, sealEvidence.seal);
      predecessor = refused ? unproven(refused) : { proof: 'sealed', generation: sealEvidence.seal.generation, reason: null };
    }
    journal = new PlacementJournal({ db, incarnationId: `incarnation-${randomUUID()}` });
    if (predecessor.proof === 'sealed') markRootSealConsumed(db, predecessor.generation!, journal.incarnationId);
    db.prepare('INSERT INTO placement_runtime_boots VALUES (?,?)').run(journal.incarnationId, JSON.stringify({
      canonicalDataRoot: bootstrap.canonicalDataRoot, rootIdentity: bootstrap.rootIdentity, createdRoot: bootstrap.createdRoot,
      bindingSHA256: bootstrap.binding.sha256, provenanceSHA256: bootstrap.provenanceSHA256, bootId: inspector.bootId(), pid: process.pid, startedAt: new Date().toISOString(),
    }));
  } catch (error) {
    failure = error instanceof OwnedMigrationError ? `migration-${error.reason}:${error.migration}` : 'owned-database-unqualified';
    journal = null;
    if (predecessor.proof === 'sealed') predecessor = unproven('predecessor-seal-unrecognized');
  }
  const rootProven = predecessor.proof !== 'unproven';
  const predecessorGates = rootProven ? [] : ['legacy-predecessor-unproven', ...(predecessor.reason ? [predecessor.reason] : [])];
  let projectsRoot = deps.projectsDir; try { projectsRoot = realpathSync.native(deps.projectsDir); } catch { /* created by server init */ }
  const registry = new PlacementProjectRegistry({ projectsRoot, readProject: deps.readProject, listProjects: deps.listProjects, ...(deps.locate ? { locate: deps.locate } : {}) });
  registry.load();
  let observations: readonly RecoveryObservation[] = [];
  let priorLaunches: readonly PriorLaunchRecovery[] = [];
  const collect = () => {
    if (!journal) return;
    try { priorLaunches = collectPriorLaunchRecovery(db, journal, inspector, completeness); } catch { /* keep closed; reader throws on unresolved facts */ }
    try {
      const next = observePriorOperations(journal);
      journal.classifyRecovery(next); // Validate before replacing; an older snapshot only ever retains fences.
      observations = next;
    } catch { /* retain previous snapshot */ }
  };
  collect();
  const rootStillOwned = () => {
    try { const s = lstatSync(bootstrap.canonicalDataRoot, { bigint: true }); return String(s.dev) === bootstrap.rootIdentity.device && String(s.ino) === bootstrap.rootIdentity.inode; } catch { return false; }
  };
  let ownerToken: PlacementRuntimeOwner | null = null, coordinator: PlacementWriteCoordinator | null = null;
  let supervisor: PlacementLaunchSupervisor | null = null, runLifetime: PlacementRunLifetime | null = null;
  if (journal) {
    const current = journal;
    ownerToken = bindPlacementRuntimeOwner({
      canonicalDataRoot: bootstrap.canonicalDataRoot,
      inspect: () => { const state = native.inspect(); return { held: state.held, qualified: state.qualified && rootStillOwned() }; },
      readPreviousIncarnationRecovery: () => ({ blockedProjectRoots: registry.mapBlockedRoots(current.readPreviousIncarnationRecovery(observations).blockedProjectRoots) }),
    });
    let recovery; try { recovery = authorizePlacementRecovery(ownerToken); } catch { recovery = undefined; }
    coordinator = new PlacementWriteCoordinator({ owner: ownerToken, ...(recovery ? { recovery } : {}), resolveProjectRoot: registry.resolveProjectRoot, observeProjectRoot: registry.observeProjectRoot });
    registry.attach(coordinator);
    supervisor = new PlacementLaunchSupervisor({ db, journal: current, inspector, coordinator, completeness });
    runLifetime = new PlacementRunLifetime({ coordinator, supervisor, physicalRoots: ids => ids.map(id => registry.describe(id).physicalRoot) });
  }
  const state = (): { mode: PlacementMode; reason: string; blockedGateKeys: readonly string[]; global: 'clear' | 'blocked' } => {
    if (!journal || !coordinator) return { mode: 'coordinated-closed', reason: failure ?? 'owned-database-unqualified', blockedGateKeys: [], global: 'blocked' };
    const native_ = native.inspect();
    if (!native_.held || !native_.qualified || !rootStillOwned()) return { mode: 'coordinated-closed', reason: 'owner-lost', blockedGateKeys: [], global: 'blocked' };
    let blocked: readonly string[];
    try { blocked = registry.mapBlockedRoots(journal.readPreviousIncarnationRecovery(observations).blockedProjectRoots); }
    catch { return { mode: 'coordinated-closed', reason: 'recovery-unresolved', blockedGateKeys: [], global: 'blocked' }; }
    if (coordinator.snapshot().recoveryRequired) return { mode: 'coordinated-closed', reason: 'recovery-authorization-pending', blockedGateKeys: blocked, global: 'clear' };
    return { mode: 'coordinated-open', reason: 'owner-qualified', blockedGateKeys: blocked, global: 'clear' };
  };
  const fence = physicalFence(deps);
  let released = false;
  const release = () => { if (released) return; released = true; native.close(); };
  /** Why this incarnation must not seal at a clean stop; null when it may (root-seal.ts). */
  const sealIneligibility = (): string | null => {
    if (!journal || !coordinator) return failure ?? 'owned-database-unqualified';
    // An unproven boot never seals: its seal would launder an unproven root for the next boot.
    if (!rootProven) return 'root-unproven';
    const current = state();
    if (current.mode !== 'coordinated-open') return `mode-${current.reason}`;
    if (coordinator.snapshot().registrations > 0) return 'admission-active';
    try {
      const own = db.prepare('SELECT id FROM placement_journal_operations WHERE incarnation_id=? ORDER BY id').all(journal.incarnationId) as { id: string }[];
      // Done, or stopped before any movement intent: nothing of this incarnation needs recovery.
      const settled = (record: JournalOperation) => record.state === 'done'
        || ((record.state === 'failed' || record.state === 'interrupted') && record.movements.every(move => !move.intent));
      if (!own.every(row => settled(journal!.readOperation(row.id)))) return 'operation-unsettled';
      if (journal.readLaunches().some(launch => launch.incarnationId === journal!.incarnationId && !launch.drainDigest)) return 'launch-undrained';
      if (path.dirname(realpathSync.native(db.name)) !== bootstrap.canonicalDataRoot) return 'database-outside-root';
    } catch { return 'journal-unreadable'; }
    return null;
  };
  const assertMutationAdmissible = (projectId?: string) => {
    const current = state();
    if (current.mode !== 'coordinated-open') throw new PlacementCoordinationError(current.reason === 'owner-lost' ? 'OWNER_UNQUALIFIED' : 'OWNER_RECOVERING', `Coordinated mutations are closed: ${current.reason}`);
    if (projectId !== undefined && fence.project(projectId, current.blockedGateKeys)) {
      throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Project root overlaps unresolved prior-incarnation placement recovery');
    }
  };
  const assertBaseDir = (baseDir: string) => {
    if (fence.baseDir(baseDir, state().blockedGateKeys)) throw new PlacementCoordinationError('PROJECT_RECOVERING', 'Project root overlaps unresolved prior-incarnation placement recovery');
  };
  const status = (): PlacementRuntimeStatus => {
    const current = state();
    // Readiness only: status never constructs the executor or touches the filesystem for it.
    const ready = exposure?.ready() ?? false;
    const unresolved = journal ? (() => { try { return journal!.readLaunches().filter(l => l.incarnationId !== journal!.incarnationId && !l.drainDigest).map(l => l.launchId); } catch { return ['journal-unreadable']; } })() : [];
    return {
      schema: 'mishmash.placement-runtime-status/v1', mode: current.mode, reason: current.reason, host: bootstrap.host,
      binding: { sha256: bootstrap.binding.sha256, provenanceSHA256: bootstrap.provenanceSHA256 },
      dataRoot: { canonical: bootstrap.canonicalDataRoot, identity: bootstrap.rootIdentity, createdThisBoot: bootstrap.createdRoot, predecessor },
      incarnationId: journal?.incarnationId ?? null,
      recovery: { global: current.global, unresolvedLaunches: unresolved, priorLaunches, blockedGateKeys: current.blockedGateKeys, blockedProjectIds: fence.projectIds(current.blockedGateKeys) },
      transition: null,
      registry: { epoch: registry.epoch, registrations: registry.registrations().length, unavailableProjects: registry.unavailableProjects },
      activation: { adoption: ready && current.mode === 'coordinated-open' ? 'executor' : 'closed', gates: [...new Set([
        ...PLACEMENT_ACTIVATION_GATES,
        ...(exposure ? exposure.gates() : closedAdoptionGates(deps.adoptionRefusal ?? [], labsOn(deps))),
        // Only a root created by this owned boot, or a confirmed predecessor seal, excludes an unrecorded ordinary predecessor.
        ...predecessorGates,
        ...(current.mode === 'coordinated-open' ? [] : [current.reason]),
      ])] },
    };
  };
  // Without an owned database there is no coordinator: the closed state refuses every admission.
  const projectWrites = coordinator ? createCoordinatedProjectWrites({ coordinator, registry }) : createFenceOnlyProjectWrites({ assertMutationAdmissible });
  // Built lazily once both opt-ins hold (see adoption-provisioning.ts); never a fallback mover.
  const exposure = journal && coordinator ? (() => {
    const current = journal;
    return new AdoptionExposure({
      provisioning: deps.adoption
        ? { kind: 'provisioned', optIn: true, helper: deps.adoption.helper, workRoot: deps.adoption.workRoot, ...(deps.adoption.toolRoot ? { toolRoot: deps.adoption.toolRoot } : {}) }
        : { kind: 'refused', optIn: false, gates: deps.adoptionRefusal ?? [] },
      enabled: () => labsOn(deps),
      projectsDir: deps.projectsDir,
      dataRoot: bootstrap.canonicalDataRoot,
      // BLOCK 1: the executor boundary enforces the predecessor exclusion, not only the status list.
      blocked: predecessorGates,
      // Every current managed and imported root, so a later import over the tool directory closes the executor.
      // A source whose location cannot be resolved is skipped here (the registry refuses it on its own).
      projectRoots: () => [deps.projectsDir, ...deps.listProjects().flatMap(source => {
        try { return [(deps.locate ?? defaultPlacementProjectLocation)(source, projectsRoot).path]; } catch { return []; }
      })],
      build: provisioned => {
        const workRoot = prepareAdoptionWorkRoot({ workRoot: provisioned.workRoot, projectsDir: deps.projectsDir, dataRoot: bootstrap.canonicalDataRoot });
        return new PlacementAdoptionExecutor({
          journal: current, store: new AdoptionStore(db), blobs: new AdoptionBlobStore(path.join(workRoot, 'blobs')),
          mover: createNativeAdoptionMover(provisioned.helper), workRoot, managedRoot: realpathSync.native(deps.projectsDir), projectWrites,
          resolveTarget: projectId => registry.resolveAdoptionTarget(projectId),
        });
      },
    });
  })() : null;
  return {
    get mode() { return state().mode; },
    get adoption() { return exposure?.current() ?? null; },
    status, registry, coordinator, supervisor, runLifetime, projectWrites, assertMutationAdmissible,
    checkMutationRequest: ({ method, path, body }) => fenceCheck(method, path, body, assertMutationAdmissible, assertBaseDir),
    refreshRecovery: () => registry.exclusive(async () => {
      collect();
      if (coordinator && ownerToken && coordinator.snapshot().recoveryRequired) {
        try { coordinator.openAdmission(authorizePlacementRecovery(ownerToken)); } catch { /* remains closed with its trusted reason */ }
      }
      return status();
    }),
    sealAndClose: async ({ closeDatabase }) => {
      if (released) { try { closeDatabase(); } catch { /* already stopped */ } return { sealed: false, reason: 'owner-released' }; }
      let outcome: PlacementSealOutcome = { sealed: false, reason: 'seal-record-failed' };
      let pending: { generation: number; nonce: string; incarnationId: string } | null = null;
      try {
        await coordinator?.closeAdmission();
        const refused = sealIneligibility();
        if (refused) outcome = { sealed: false, reason: refused };
        else {
          pending = { ...recordRootSeal(db, journal!.incarnationId), incarnationId: journal!.incarnationId };
          // Truncate the WAL; the close below then removes the WAL and shared-memory files the seal requires absent.
          db.pragma('wal_checkpoint(TRUNCATE)');
        }
      } catch { pending = null; }
      try { closeDatabase(); } catch { if (pending) { pending = null; outcome = { sealed: false, reason: 'database-close-failed' }; } }
      if (pending) {
        const held = native.inspect();
        if (!held.held || !held.qualified || !rootStillOwned()) outcome = { sealed: false, reason: 'owner-lost' };
        else {
          const written = writeRootSeal(bootstrap.canonicalDataRoot, { ...pending, databaseName: path.basename(db.name) });
          outcome = written.written ? { sealed: true, generation: pending.generation } : { sealed: false, reason: written.reason };
        }
      }
      release();
      return outcome;
    },
    close: () => release(),
  };
}
