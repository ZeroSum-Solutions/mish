import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import path from 'node:path';
import {
  isAdoptionPlanUnexpired, isRestrictedAdoptionPath, type AdoptionOperationView, type ApplyAdoptionRequest, type PrepareAdoptionRequest, type PreparedAdoptionPlan,
} from '@open-design/contracts';
import { AdoptionBlobStore, readNamedRegularFile, sameNamedFile, writeExclusiveFile, type StoredBlob } from './adoption-files.js';
import { resolveInstalledPackage, type InstalledPackage } from '../adoption/installed-packages.js';
import type { AdoptionMover } from './adoption-mover.js';
import type { MoveResult } from './driver.js';
import { buildPreparedPlan, digestOf, planDigest, type ObservedExpectation, type SourceAdmission } from './adoption-plan.js';
import { AdoptionStore, type StoredAdoptionPlan } from './adoption-store.js';
import { PlacementJournalError, type JournalMovement, type JournalOperation, type NamedFile, type OperationManifest, type PlacementJournal } from './journal.js';
import { isStrictlyInside, type PlacementProjectRegistration } from './project-registry.js';
import type { PlacementFinalIO, PlacementProjectWrites } from './project-writes.js';

/** Typed adoption refusal; `reason` travels in the error details next to the shared envelope code. */
export class AdoptionError extends Error {
  constructor(readonly status: 404 | 409 | 422 | 500, readonly reason: string, message: string, readonly operationId: string | null = null) {
    super(message); this.name = 'AdoptionError';
  }
}
export interface AdoptionExecutorDeps {
  journal: PlacementJournal; store: AdoptionStore; blobs: AdoptionBlobStore; mover: AdoptionMover;
  /** Canonical adoption work root (staging/retention) under the resolved daemon data root, same volume as managed projects. */
  workRoot: string;
  /** Canonical managed projects root (realpath of PROJECTS_DIR); every adoption target must lie strictly inside it. */
  managedRoot: string;
  projectWrites: PlacementProjectWrites;
  /** Registry adoption target: managed roots only (imported roots refuse 422). */
  resolveTarget(projectId: string): PlacementProjectRegistration;
  now?: () => number;
}
const SOURCE_AUTHORITY_GATE = 'source-authority-executor-preparer';
/** Aggregate budgets the prepared-plan contract enforces; prepare refuses before retaining or storing anything. */
const ADOPTION_MAX_PREIMAGE_BYTES = 32 * 1024 * 1024;
const ADOPTION_MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const DEPENDENCY_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'] as const;
const expectationOf = (read: ReturnType<typeof readNamedRegularFile>, where: string): ObservedExpectation => {
  if (read.kind === 'absent') return { kind: 'absent' };
  if (read.kind === 'file') return { kind: 'file', sha256: read.file.sha256, bytes: read.file.byteLength, identity: { device: read.file.device, inode: read.file.inode, kind: 'file' } };
  throw new AdoptionError(409, 'path-unverifiable', `Project path cannot be read as one regular file: ${where}`);
};
const matches = (expected: ObservedExpectation, observed: ReturnType<typeof readNamedRegularFile>) => expected.kind === 'absent'
  ? observed.kind === 'absent'
  : observed.kind === 'file' && observed.file.sha256 === expected.sha256 && observed.file.byteLength === expected.bytes
    && observed.file.device === expected.identity.device && observed.file.inode === expected.identity.inode;
/** A sourced plan always carries its licence notice files; a missing notice is a refusal, never a silent omission. */
function assertAdmissionMatchesDraft(admission: SourceAdmission, draft: PrepareAdoptionRequest): void {
  const ref = draft.source.resourceRef;
  if (draft.source.implementationOrigin !== admission.implementationOrigin || !ref || digestOf(ref) !== digestOf(admission.resourceRef)) {
    throw new AdoptionError(422, SOURCE_AUTHORITY_GATE, 'Draft source does not match its catalogue admission; the draft is unchanged');
  }
  const noticeWrites = new Set(draft.writes.filter(w => w.role === 'notice').map(w => w.path));
  if (!admission.terms.text.trim() || admission.notices.length === 0 || admission.notices.some(path => !noticeWrites.has(path))) {
    throw new AdoptionError(422, 'notice-missing', 'A sourced item must carry its licence notice with every applied file set');
  }
}
const fileOf = (expected: Extract<ObservedExpectation, { kind: 'file' }>): NamedFile => ({ device: expected.identity.device, inode: expected.identity.inode, sha256: expected.sha256, byteLength: expected.bytes });
/** Exact decoded length of canonical or padded base64 without decoding it. */
const base64Bytes = (encoded: string) => Math.floor(encoded.length * 3 / 4) - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0);
const operationIdFor = (kind: 'apply' | 'undo', key: unknown) => `${kind}-${digestOf(key).slice(0, 40)}`;

/**
 * F5 executor: prepare → apply → undo for regular-file plans in managed
 * project roots. Every movement is the qualified native exclusive move,
 * preceded by a committed journal intent and followed by exact content
 * verification and a committed receipt. Replaced files and published outputs
 * are retained (never deleted), so undo restores the original objects. A
 * failure stops with the journal's recovery stage: there is no automatic
 * retry, cleanup or compensation of a partial operation.
 */
export class PlacementAdoptionExecutor {
  readonly #deps: AdoptionExecutorDeps;
  constructor(deps: AdoptionExecutorDeps) {
    if (!path.isAbsolute(deps.workRoot) || path.resolve(deps.workRoot) !== deps.workRoot) throw new Error('Canonical adoption work root required');
    if (!path.isAbsolute(deps.managedRoot) || path.resolve(deps.managedRoot) !== deps.managedRoot) throw new Error('Canonical managed projects root required');
    this.#deps = deps;
  }
  #now(): number { return (this.#deps.now ?? Date.now)(); }
  /** The registry target, refused (422) unless its physical root lies strictly inside the managed root. */
  #target(projectId: string): PlacementProjectRegistration {
    const registration = this.#deps.resolveTarget(projectId);
    if (registration.kind !== 'managed' || !isStrictlyInside(this.#deps.managedRoot, registration.physicalRoot)) {
      throw new AdoptionError(422, 'root-outside-managed', 'Adoption target physical root is outside the managed projects root');
    }
    return registration;
  }
  #location(registration: PlacementProjectRegistration, relative: string): string { return path.join(registration.physicalRoot, ...relative.split('/')); }
  /**
   * Every read or write location's parent is an existing qualified directory
   * whose real path is exactly its name under the project's real root: no
   * symlinked directory anywhere between the root and the file. Refused 422
   * `parent-unqualified` before the file is opened.
   */
  async #qualifyParent(registration: PlacementProjectRegistration, relative: string): Promise<void> {
    const parent = path.dirname(this.#location(registration, relative));
    const inspected = await this.#deps.mover.inspectDirectory(parent);
    let contained = false;
    try {
      const root = realpathSync(registration.physicalRoot);
      contained = realpathSync(parent) === path.join(root, ...path.posix.dirname(relative).split('/').filter(part => part !== '.'));
    } catch { contained = false; }
    if (inspected.kind !== 'qualified' || !contained) throw new AdoptionError(422, 'parent-unqualified', `Path parent must be an existing qualified directory inside the project: ${relative}`);
  }

  /**
   * Reads the project under its admission and stores outputs and preimages; never mutates the project.
   * A non-owned draft needs a trusted catalogue `admission` (never request JSON) whose origin and ref
   * match the draft and whose notice files are among the draft's notice writes.
   */
  /**
   * `options.dependencyPaths` (trusted, server-side only): further project
   * files a target gate read (nearer package.json candidates that must stay
   * absent, the gate's manifest, its lockfiles, tsconfig.json). They join the
   * root manifest and lockfiles in the plan's dependencyDigest (presence and
   * exact bytes), so any change there between prepare and apply is refused.
   */
  async prepare(principalId: string, draft: PrepareAdoptionRequest, admission?: SourceAdmission, options: { dependencyPaths?: readonly string[] } = {}): Promise<PreparedAdoptionPlan> {
    const dependencyPaths = [...new Set(options.dependencyPaths ?? [])].filter(relative => !(DEPENDENCY_FILES as readonly string[]).includes(relative)).sort();
    if (dependencyPaths.some(relative => relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => part === '' || part === '.' || part === '..') || isRestrictedAdoptionPath(relative))) {
      throw new AdoptionError(422, 'dependency-paths-invalid', 'Dependency paths must be normalized project-relative files');
    }
    if (admission) assertAdmissionMatchesDraft(admission, draft);
    else if (draft.source.implementationOrigin !== 'owned') {
      throw new AdoptionError(422, SOURCE_AUTHORITY_GATE, 'Only owner-declared drafts can be prepared until source authority is connected; the draft is unchanged');
    }
    const restricted = draft.writes.find(w => isRestrictedAdoptionPath(w.path));
    if (restricted) throw new AdoptionError(422, 'restricted-path', `Dependency and Git metadata writes require a separate capability: ${restricted.path}`);
    const { blobs, mover, store } = this.#deps;
    return this.#deps.projectWrites.run(draft.projectId, async () => {
      const registration = this.#target(draft.projectId);
      const root = await mover.inspectDirectory(registration.physicalRoot);
      if (root.kind !== 'qualified') throw new AdoptionError(422, `root-${root.kind}`, `Project root is not a qualified placement volume (${root.reason})`);
      // Observe every path and refuse typed gates before any blob is stored. The aggregate
      // budgets hold before anything is retained: no request that the plan contract would
      // reject keeps more than one over-budget read in memory or leaves a blob behind.
      const outputBytes = draft.writes.reduce((sum, write) => sum + base64Bytes(write.contentBase64), 0);
      if (outputBytes > ADOPTION_MAX_OUTPUT_BYTES) throw new AdoptionError(422, 'output-budget', 'Planned output exceeds 32 MiB');
      const observed = new Map<string, ObservedExpectation>(), currents = new Map<string, ReturnType<typeof readNamedRegularFile>>();
      let preimageBytes = 0;
      for (const write of draft.writes) {
        await this.#qualifyParent(registration, write.path);
        const current = readNamedRegularFile(this.#location(registration, write.path));
        if (current.kind === 'file') {
          preimageBytes += current.file.byteLength;
          if (preimageBytes > ADOPTION_MAX_PREIMAGE_BYTES) throw new AdoptionError(422, 'preimage-budget', 'Retained preimages exceed 32 MiB');
        }
        observed.set(write.path, expectationOf(current, write.path)); currents.set(write.path, current);
      }
      if (observed.get(draft.entryPath)?.kind !== 'file') throw new AdoptionError(422, 'entry-must-exist', `The entry must be an existing project file: ${draft.entryPath}`);
      const dependencyObservations = await this.#dependencyObservations(registration, dependencyPaths);
      const outputs = new Map<string, StoredBlob>(), preimages: Record<string, StoredBlob> = {};
      for (const write of draft.writes) {
        const current = currents.get(write.path)!;
        if (current.kind === 'file') preimages[write.path] = blobs.put(current.bytes);
        outputs.set(write.path, blobs.put(Buffer.from(write.contentBase64, 'base64')));
      }
      const plan = buildPreparedPlan({
        id: `plan-${randomUUID()}`, principalId, draft, observed, outputs, dependencyObservations, preparedAt: this.#now(), ...(admission ? { admission } : {}),
        projectRoot: { device: root.identity.device, inode: root.identity.inode, volumeUUID: root.identity.volumeUUID },
      });
      store.savePlan(principalId, { plan, preimages, ...(dependencyPaths.length ? { dependencyPaths } : {}) });
      return plan;
    });
  }

  /**
   * Read-only capability, separate from `observe` (which refuses node_modules):
   * the version Node would resolve for each package from the project-relative
   * `fromDir`, nearest node_modules first, bounded by the project's real root
   * (a symlink out of it is `unreadable`, never followed). Never writes.
   */
  async installedPackages(projectId: string, fromDir: string, names: readonly string[]): Promise<Map<string, InstalledPackage>> {
    return this.#deps.projectWrites.run(projectId, async () => {
      const registration = this.#target(projectId);
      return new Map(names.map(name => [name, resolveInstalledPackage(registration.physicalRoot, fromDir, name)]));
    });
  }

  /**
   * Current bytes of project files (null when absent), read under the project's
   * admission and only through qualified parents inside the project root. Same managed-root
   * (422 root-outside-managed) and 32 MiB read budget (422 preimage-budget) as prepare. The catalogue manager uses it for its dependency
   * report and replacement review; prepare observes again before it stores anything.
   */
  async observe(projectId: string, paths: readonly string[]): Promise<Map<string, Buffer | null>> {
    const restricted = paths.find(isRestrictedAdoptionPath);
    if (restricted) throw new AdoptionError(422, 'restricted-path', `Dependency and repository metadata paths require a separate capability: ${restricted}`);
    return this.#deps.projectWrites.run(projectId, async () => {
      const registration = this.#target(projectId);
      const observed = new Map<string, Buffer | null>();
      let observedBytes = 0;
      for (const relative of paths) {
        await this.#qualifyParent(registration, relative);
        const current = readNamedRegularFile(this.#location(registration, relative));
        expectationOf(current, relative);
        if (current.kind === 'file') {
          observedBytes += current.file.byteLength;
          if (observedBytes > ADOPTION_MAX_PREIMAGE_BYTES) throw new AdoptionError(422, 'preimage-budget', 'Observed project files exceed 32 MiB');
        }
        observed.set(relative, current.kind === 'file' ? current.bytes : null);
      }
      return observed;
    });
  }

  /**
   * Exact package/lock observations at the root plus any further dependency
   * paths a target gate read; the plan's dependencyDigest binds them and apply
   * re-checks them. With no further paths the original root keys are kept.
   */
  async #dependencyObservations(registration: PlacementProjectRegistration, extra: readonly string[] = []): Promise<Record<string, ObservedExpectation>> {
    for (const relative of extra) await this.#qualifyParent(registration, relative);
    return Object.fromEntries([...DEPENDENCY_FILES, ...extra].map(name => [name, expectationOf(readNamedRegularFile(this.#location(registration, name)), name)]));
  }

  /** Where catalogue saved units live: beside blobs, staging and retention under the work root (daemon data). */
  get savedUnitsRoot(): string { return path.join(this.#deps.workRoot, 'saved-units'); }

  readPlan(principalId: string, planId: string): PreparedAdoptionPlan {
    const stored = this.#deps.store.readPlan(planId);
    if (!stored || stored.plan.principalId !== principalId) throw new AdoptionError(404, 'plan-not-found', 'Adoption plan not found');
    return stored.plan;
  }

  /** One apply per plan digest. A repeat replays the recorded operation; it never moves again. */
  async apply(principalId: string, request: ApplyAdoptionRequest): Promise<AdoptionOperationView> {
    const stored = this.#deps.store.readPlan(request.planId);
    if (!stored || stored.plan.principalId !== principalId) throw new AdoptionError(404, 'plan-not-found', 'Adoption plan not found');
    const { plan } = stored;
    if (plan.digest !== request.planDigest || planDigest(plan) !== plan.digest) throw new AdoptionError(409, 'plan-digest-mismatch', 'Plan digest does not match the stored plan');
    const operationId = operationIdFor('apply', { planId: plan.id, planDigest: plan.digest });
    const replay = this.#replay(operationId); if (replay) return replay;
    if (!isAdoptionPlanUnexpired(plan, this.#now())) throw new AdoptionError(409, 'plan-expired', 'Plan expired; prepare it again');
    await this.#deps.projectWrites.run(plan.projectId, async finalIO => {
      const registration = this.#target(plan.projectId);
      const root = await this.#deps.mover.inspectDirectory(registration.physicalRoot);
      if (root.kind !== 'qualified' || root.identity.device !== plan.projectRoot.device || root.identity.inode !== plan.projectRoot.inode
        || root.identity.volumeUUID !== plan.projectRoot.volumeUUID) throw new AdoptionError(409, 'project-root-changed', 'Project root changed since preparation');
      for (const read of plan.reads) {
        if (!matches(read.expected, readNamedRegularFile(this.#location(registration, read.path)))) {
          throw new AdoptionError(409, 'read-set-changed', `Project changed since preparation: ${read.path}`);
        }
      }
      if (digestOf(await this.#dependencyObservations(registration, stored.dependencyPaths ?? [])) !== plan.target.dependencyDigest) {
        throw new AdoptionError(409, 'dependency-set-changed', 'Package manifest or lockfile changed since preparation');
      }
      const movements = this.#applyMovements(plan, stored, registration, operationId, finalIO);
      this.#deps.store.link({ operationId, planId: plan.id, kind: 'apply', undoOf: null });
      await this.#execute({ operationId, principalId, projectId: plan.projectId, projectRoot: registration.physicalRoot, kind: 'apply',
        idempotencyKey: operationId, inputDigest: digestOf(request), planDigest: plan.digest, movements }, finalIO);
    });
    return this.view(principalId, operationId);
  }

  /** Reverts a completed apply only when every location still holds exactly what the apply left. */
  async undo(principalId: string, applyOperationId: string): Promise<AdoptionOperationView> {
    const link = this.#deps.store.readLink(applyOperationId);
    const stored = link ? this.#deps.store.readPlan(link.planId) : null;
    if (!link || link.kind !== 'apply' || !stored || stored.plan.principalId !== principalId) throw new AdoptionError(404, 'operation-not-found', 'Apply operation not found');
    const operationId = operationIdFor('undo', { undoOf: applyOperationId });
    const replay = this.#replay(operationId); if (replay) return replay;
    const applied = this.#read(applyOperationId);
    if (applied.state !== 'done') throw new AdoptionError(409, 'operation-not-complete', 'Only a completed apply can be undone');
    const { plan } = stored;
    await this.#deps.projectWrites.run(plan.projectId, async finalIO => {
      const registration = this.#target(plan.projectId);
      if (registration.physicalRoot !== applied.manifest.projectRoot) throw new AdoptionError(409, 'project-root-changed', 'Project root changed since apply');
      const finalMap = new Map<string, NamedFile | null>();
      for (const move of applied.manifest.movements) { finalMap.set(move.source, null); finalMap.set(move.destination, move.expectedSource); }
      for (const [location, expected] of finalMap) {
        const observed = readNamedRegularFile(location);
        const same = expected === null ? observed.kind === 'absent' : observed.kind === 'file' && sameNamedFile(observed.file, expected);
        if (!same) throw new AdoptionError(409, 'changed-since-apply', 'A location changed after apply; undo would overwrite newer work');
      }
      const retention = path.join(this.#deps.workRoot, 'retention', operationId);
      finalIO.assertCurrent(); mkdirSync(retention, { recursive: true, mode: 0o700 });
      const movements: JournalMovement[] = [...applied.manifest.movements].reverse().map((move, index) => move.kind === 'publish'
        ? { ...move, movementId: `m${index}-retire`, kind: 'retire' as const, source: move.destination, destination: path.join(retention, `w${index}`) }
        : { ...move, movementId: `m${index}-restore`, kind: 'restore' as const, source: move.destination, destination: move.source });
      this.#deps.store.link({ operationId, planId: plan.id, kind: 'undo', undoOf: applyOperationId });
      await this.#execute({ operationId, principalId, projectId: plan.projectId, projectRoot: registration.physicalRoot, kind: 'undo',
        idempotencyKey: operationId, inputDigest: digestOf({ undoOf: applyOperationId }), planDigest: plan.digest, movements }, finalIO);
    });
    return this.view(principalId, operationId);
  }

  view(principalId: string, operationId: string): AdoptionOperationView {
    const link = this.#deps.store.readLink(operationId);
    const stored = link ? this.#deps.store.readPlan(link.planId) : null;
    if (!link || !stored || stored.plan.principalId !== principalId) throw new AdoptionError(404, 'operation-not-found', 'Adoption operation not found');
    const op = this.#read(operationId);
    return {
      operationId, kind: link.kind, planId: link.planId, projectId: stored.plan.projectId, state: op.state, stage: op.stage,
      undoOf: link.undoOf, undoneBy: link.kind === 'apply' ? this.#deps.store.undoOf(operationId) : null, reason: op.reason,
      writes: stored.plan.writes.map(w => ({ path: w.path, kind: w.kind, sha256: w.after.sha256, bytes: w.after.bytes })),
    };
  }

  #read(operationId: string): JournalOperation {
    try { return this.#deps.journal.readOperation(operationId); }
    catch (error) {
      if (error instanceof PlacementJournalError && error.code === 'NOT_FOUND') throw new AdoptionError(404, 'operation-not-found', 'Adoption operation not found');
      throw error;
    }
  }
  /** A linked, journaled operation is the answer to its idempotent request, whatever its state. */
  #replay(operationId: string): AdoptionOperationView | null {
    const link = this.#deps.store.readLink(operationId); if (!link) return null;
    try { this.#deps.journal.readOperation(operationId); } catch (error) { if (error instanceof PlacementJournalError && error.code === 'NOT_FOUND') return null; throw error; }
    const stored = this.#deps.store.readPlan(link.planId)!;
    return this.view(stored.plan.principalId, operationId);
  }

  /** Stages verified output blobs as fresh files and declares retire/publish steps in contract order. */
  #applyMovements(plan: PreparedAdoptionPlan, stored: StoredAdoptionPlan, registration: PlacementProjectRegistration, operationId: string, finalIO: PlacementFinalIO): JournalMovement[] {
    const staging = path.join(this.#deps.workRoot, 'staging', operationId, randomUUID());
    const retention = path.join(this.#deps.workRoot, 'retention', operationId);
    finalIO.assertCurrent();
    mkdirSync(staging, { recursive: true, mode: 0o700 }); mkdirSync(retention, { recursive: true, mode: 0o700 });
    const reads = new Map(plan.reads.map(r => [r.path, r.expected]));
    const movements: JournalMovement[] = [];
    plan.writes.forEach((write, index) => {
      const location = this.#location(registration, write.path);
      const before = reads.get(write.path)!;
      if (write.kind === 'replace') {
        if (before.kind !== 'file') throw new AdoptionError(409, 'read-set-changed', 'Replacement requires the declared existing file');
        const preimage = stored.preimages[write.path];
        if (!preimage || preimage.sha256 !== before.sha256) throw new AdoptionError(500, 'preimage-missing', 'Independent preimage was not retained');
        this.#deps.blobs.read(preimage);
        movements.push({ movementId: `m${index}-retire`, kind: 'retire', source: location, destination: path.join(retention, `w${index}`), expectedSource: fileOf(before), snapshot: { snapshotId: preimage.blobId, sha256: preimage.sha256, byteLength: preimage.byteLength } });
      }
      const blob = { blobId: write.after.blobId, sha256: write.after.sha256, byteLength: write.after.bytes };
      const staged = writeExclusiveFile(path.join(staging, `w${index}`), this.#deps.blobs.read(blob));
      movements.push({ movementId: `m${index}-publish`, kind: 'publish', source: path.join(staging, `w${index}`), destination: location, expectedSource: staged, snapshot: { snapshotId: blob.blobId, sha256: blob.sha256, byteLength: blob.byteLength } });
    });
    return movements;
  }

  /** Journal → intent → native move → exact verification → receipt, for each step in order; then completion. */
  async #execute(manifest: OperationManifest, finalIO: PlacementFinalIO): Promise<void> {
    const { journal } = this.#deps;
    const created = journal.createOperation(manifest);
    if (created.state !== 'queued') return; // Recorded elsewhere (replay); never repeat movements.
    const run: RunState = { operationId: manifest.operationId, current: journal.startOperation(manifest.operationId, created.revision) };
    try {
      for (const move of manifest.movements) await this.#move(run, move, finalIO);
    } catch (error) {
      if (error instanceof AdoptionError) throw error;
      // Placement refusal (owner/recovery/scope) or a journal failure mid-operation: stop; never retry or compensate.
      this.#stop(run, 'interrupted', 'interrupted');
      throw error;
    }
    journal.completeOperation(manifest.operationId, run.current.revision, digestOf(run.current.movements.map(m => m.receipt)));
  }

  /** Records the terminal stage (recovery-required once any intent exists). The journal keeps its last commit if this fails. */
  #stop(run: RunState, reason: string, state: 'failed' | 'interrupted' = 'failed'): void {
    const { journal } = this.#deps;
    try {
      const revision = journal.readOperation(run.operationId).revision;
      run.current = state === 'failed' ? journal.failOperation(run.operationId, revision, reason) : journal.interruptOperation(run.operationId, revision, reason);
    } catch { /* Recovery classification still sees every committed intent. */ }
  }
  #refuse(run: RunState, reason: string, status: 409 | 500, message: string): never {
    this.#stop(run, reason);
    throw new AdoptionError(status, reason, message, run.operationId);
  }

  /** Intent → one native exclusive move → exact identity/bytes verification → receipt. */
  async #move(run: RunState, move: JournalMovement, finalIO: PlacementFinalIO): Promise<void> {
    const { journal, mover } = this.#deps;
    finalIO.assertCurrent();
    const prepared = await mover.prepare({ source: move.source, destination: move.destination, expected: move.expectedSource });
    if (prepared.kind !== 'ready') return this.#refuse(run, `movement-${prepared.kind}`, 409, `Movement refused before mutation (${prepared.reason})`);
    let result: MoveResult;
    try {
      result = await prepared.move.execute(async () => {
        finalIO.assertCurrent();
        const recorded = journal.recordMovementIntent(run.operationId, run.current.revision, move.movementId);
        if (!recorded.created) throw new Error('Movement intent already exists');
        run.current = recorded.operation;
      });
    } finally { await prepared.move.close(); }
    if (result.kind !== 'observed-move') {
      return this.#refuse(run, result.kind === 'conflict' ? 'movement-conflict' : 'movement-unknown', result.kind === 'conflict' ? 409 : 500, `Movement did not complete (${result.reason}); recovery is required`);
    }
    const destination = readNamedRegularFile(move.destination), source = readNamedRegularFile(move.source);
    if (destination.kind !== 'file' || !sameNamedFile(destination.file, move.expectedSource) || source.kind !== 'absent') {
      return this.#refuse(run, 'content-verification', 409, 'Moved object does not match the declared identity and bytes; recovery is required');
    }
    run.current = journal.recordMovementReceipt(run.operationId, run.current.revision, move.movementId, {
      source: 'absent', destination: destination.file, verificationDigest: digestOf({ invocationId: result.invocationId, destination: destination.file }),
    });
  }
}
interface RunState { readonly operationId: string; current: JournalOperation }
