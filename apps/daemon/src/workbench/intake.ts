import type Database from 'better-sqlite3';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, constants, existsSync } from 'node:fs';
import { copyFile, link, lstat, mkdir, open, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { parseCreateIntakeBatchRequest, type ApiError, type ApiErrorCode, type CreateIntakeBatchRequest, type IntakeBatchSnapshot, type IntakeFileOutcome, type IntakeFilePutResponse, type AttachIntakeRequest, type AttachIntakeResponse, type ClearIntakeRequest, type LibraryAssetKind } from '@open-design/contracts';
import { kindForMime, libraryObjectPath, registerStreamedLibraryAsset, resolveAssetBytesPath } from '../library.js';
import { addLibraryAssetSource, getLibraryAsset } from '../library-store.js';
import { IntakeTextProbe, detectIntakeMime } from './intake-mime.js';
import { INTAKE_FILE_MAX_BYTES, INTAKE_SIZE_EXCEEDED_MESSAGE } from './intake-policy.js';
import { sanitizeName } from '../projects.js';
import { bumpIntake, getIntakeBatch, getIntakeItem, intakeDescriptor, intakeItems, intakeManifest, materializations, setIntakeError, type IntakeSelector, type IntakeItemRow, type Materialization } from './intake-store.js';
import type { PlacementFinalIO, PlacementProjectWrites } from './placement/project-writes.js';
import type { PlacementRuntime } from './placement/runtime.js';
import { PlacementCoordinationError } from './placement/write-coordinator.js';

export class IntakeError extends Error {
  constructor(public status: number, public code: ApiErrorCode, message: string, public retryable = false) { super(message); }
  wire(): ApiError { return { code: this.code, message: this.message, retryable: this.retryable }; }
}
/**
 * Daemon-local Intake custody. `rootWrite` admits data-root work (manifest and
 * receipt SQL, stream temp, content-addressed object, owned-temp cleanup) and
 * hands a final-I/O guard to call immediately before each effect; it holds the
 * admission until the callback, cleanup included, settles. `projectWrites` is
 * the shared standalone project admission. A root callback never enters
 * `projectWrites`: root custody settles first, then project admission.
 */
export interface IntakeWriteAuthority {
  rootWrite<T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T>;
  projectWrites: PlacementProjectWrites;
}
/**
 * Ordinary mode keeps its fence-only behavior: the runtime fence at entry and
 * again before each final effect. Coordinated mode holds a root-only mutation
 * permit until accepted root work settles; without the owned coordinator it
 * fails closed with the runtime's own refusal.
 */
export function createIntakeWriteAuthority(placement: Pick<PlacementRuntime, 'mode' | 'coordinator' | 'projectWrites' | 'assertMutationAdmissible'>): IntakeWriteAuthority {
  const fenced = async <T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T> => {
    placement.assertMutationAdmissible();
    const accepted = { active: true };
    const finalIO: PlacementFinalIO = Object.freeze({ assertCurrent: () => {
      if (!accepted.active) throw new PlacementCoordinationError('PERMIT_RELEASED', 'Final I/O is outside its accepted write');
      placement.assertMutationAdmissible();
    } });
    try { return await work(finalIO); } finally { accepted.active = false; }
  };
  const coordinated = async <T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T> => {
    const coordinator = placement.coordinator;
    if (!coordinator) {
      placement.assertMutationAdmissible();
      throw new PlacementCoordinationError('ADMISSION_CLOSED', 'Coordinated Intake writes require the owned coordinator');
    }
    const permit = await coordinator.acquireMutation({ projectRoots: [] });
    try { return await coordinator.withDataRootWrite(permit, work); } finally { coordinator.releaseMutation(permit); }
  };
  return Object.freeze({ rootWrite: placement.mode === 'ordinary-uncoordinated' ? fenced : coordinated, projectWrites: placement.projectWrites });
}
interface IntakeServiceDeps {
  db: Database.Database; libraryDir: string; projectsDir: string;
  authority: IntakeWriteAuthority;
  /** Creates/validates the destination folder; calls `finalIO.assertCurrent()` before each directory it creates. */
  projectDirectory(projectId: string, dir: string, finalIO: PlacementFinalIO): Promise<string>;
  /** Test fault injection for the copy/receipt crash gap. */
  afterCopy?: () => Promise<void>;
  /** Test fault injection before verifying/publishing the temporary project copy. */
  beforePublish?: (temporaryPath: string) => Promise<void>;
  /** Test injection for destination link capability failures. */
  linkProjectCopy?: (temporaryPath: string, target: string) => Promise<void>;
}
async function fileHash(file: string): Promise<string> {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new IntakeError(409, 'intake-conflict', 'The reserved project file is no longer an ordinary file');
  const hash = createHash('sha256'); for await (const chunk of createReadStream(file)) hash.update(chunk); return hash.digest('hex');
}
function isCode(error: unknown, code: string): boolean { return typeof error === 'object' && error !== null && 'code' in error && error.code === code; }
/** Owned-temp cleanup is a final effect too: when custody is no longer current, uncertain bytes stay for recovery. */
function custodyCurrent(finalIO: PlacementFinalIO): boolean { try { finalIO.assertCurrent(); return true; } catch { return false; } }
export class IntakeService {
  private active = new Map<string, Set<Readable>>();
  private transfers = 0;
  private locks = new Map<string, Promise<void>>();
  private publicationContext = new AsyncLocalStorage<{ active: boolean }>();
  /** Persisted state contains no upload lease: rows a lost process left queued need reselection. */
  private interruptedPending = true;
  constructor(private deps: IntakeServiceDeps) {}
  /** Every Intake data-root effect runs here; a deferred interrupted-transfer recovery applies first, under the same guard. */
  private root<T>(work: (finalIO: PlacementFinalIO) => Promise<T>): Promise<T> {
    return this.deps.authority.rootWrite(async finalIO => {
      if (this.interruptedPending) {
        finalIO.assertCurrent();
        this.deps.db.prepare("UPDATE workbench_intake_items SET state = 'needs-reselection', error_json = ? WHERE state = 'queued'").run(JSON.stringify({ code: 'intake-interrupted', message: 'Reselect the original file to resume', retryable: true }));
        this.interruptedPending = false;
      }
      return work(finalIO);
    });
  }
  /**
   * Startup recovery as admitted root work, awaited before Intake serves. A
   * placement refusal defers it to the next admitted Intake root write instead
   * of failing daemon startup; any other failure propagates.
   */
  async recoverInterrupted(): Promise<'recovered' | 'deferred'> {
    if (!this.interruptedPending) return 'recovered';
    try { await this.root(async () => undefined); return 'recovered'; }
    catch (error) { if (error instanceof PlacementCoordinationError) return 'deferred'; throw error; }
  }
  batch(id: string) {
    const row = getIntakeBatch(this.deps.db, id); if (!row) throw new IntakeError(404, 'intake-ref-unknown', 'Intake batch not found'); return row;
  }
  item(batchId: string, fileId: string) {
    this.batch(batchId); const row = getIntakeItem(this.deps.db, batchId, fileId); if (!row) throw new IntakeError(404, 'intake-ref-unknown', 'Intake file not found'); return row;
  }
  assertSelector(id: string, selector: IntakeSelector): void {
    if (this.batch(id).selector_json !== JSON.stringify(selector)) throw new IntakeError(403, 'FORBIDDEN', 'Intake namespace selector does not match');
  }
  async create(value: CreateIntakeBatchRequest, selector: IntakeSelector): Promise<IntakeBatchSnapshot> {
    const input = parseCreateIntakeBatchRequest(value), db = this.deps.db;
    return this.root(async finalIO => {
      finalIO.assertCurrent();
      db.transaction(() => {
        const existing = getIntakeBatch(db, input.intakeBatchId);
        if (existing) {
          if (existing.manifest_json !== JSON.stringify(input) || existing.selector_json !== JSON.stringify(selector)) throw new IntakeError(409, 'intake-conflict', 'Batch identity has a different frozen manifest or destination');
          return;
        }
        const now = Date.now();
        db.prepare('INSERT INTO workbench_intake_batches (id, manifest_json, selector_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(input.intakeBatchId, JSON.stringify(input), JSON.stringify(selector), now, now);
        const insert = db.prepare('INSERT INTO workbench_intake_items (batch_id, client_file_id, descriptor_json, state, error_json) VALUES (?, ?, ?, ?, ?)');
        for (const descriptor of input.files) {
          const oversize = descriptor.size > INTAKE_FILE_MAX_BYTES;
          insert.run(input.intakeBatchId, descriptor.clientFileId, JSON.stringify(descriptor), oversize ? 'failed' : 'queued', oversize ? JSON.stringify({ code: 'intake-size-exceeded', message: INTAKE_SIZE_EXCEEDED_MESSAGE, retryable: false }) : null);
        }
      }).immediate();
      return this.snapshot(input.intakeBatchId);
    });
  }
  private outcome(row: IntakeItemRow): IntakeFileOutcome {
    const descriptor = intakeDescriptor(row);
    const result: IntakeFileOutcome = { clientFileId: descriptor.clientFileId, order: descriptor.order, descriptor, state: row.state, retryable: ['queued', 'needs-reselection', 'cancelled'].includes(row.state), hasSuccessfulAttachment: materializations(row).some(item => item.complete) };
    if (row.error_json) { result.error = JSON.parse(row.error_json) as ApiError; result.retryable = result.error.retryable === true; }
    if (row.state === 'cleared') return result;
    const asset = row.asset_id ? getLibraryAsset(this.deps.db, row.asset_id) : null;
    if (row.content_hash && (!asset || !existsSync(resolveAssetBytesPath(asset, this.deps.projectsDir) ?? ''))) return { ...result, state: 'needs-reselection', retryable: true, error: { code: 'bytes-removed', message: 'Library bytes were removed; reselect the original file', retryable: true } };
    if (asset && row.content_hash && row.detected_mime && row.intake_kind) {
      const materialized = materializations(row).find(item => item.complete);
      result.stored = { assetId: asset.id, contentHash: row.content_hash, size: descriptor.size, filename: descriptor.filename, ...(descriptor.declaredMime ? { declaredMime: descriptor.declaredMime } : {}), detectedMime: row.detected_mime, kind: row.intake_kind as LibraryAssetKind,
        ...(materialized ? { projectFile: { projectId: materialized.projectId, relPath: materialized.relPath } } : {}), downloadUrl: `/api/workbench/intake/${row.batch_id}/files/${row.client_file_id}/download` };
    }
    return result;
  }
  snapshot(id: string): IntakeBatchSnapshot {
    const batch = this.batch(id); return { intakeBatchId: id, revision: batch.revision, destination: intakeManifest(batch).destination, files: intakeItems(this.deps.db, id).map(row => this.outcome(row)).sort((a,b) => a.order-b.order), createdAt: batch.created_at, updatedAt: batch.updated_at };
  }
  list(selector: IntakeSelector, projectId?: string): IntakeBatchSnapshot[] {
    const rows = this.deps.db.prepare('SELECT id FROM workbench_intake_batches WHERE selector_json = ? ORDER BY created_at').all(JSON.stringify(selector)) as { id: string }[];
    return rows.map(row => this.snapshot(row.id)).filter(batch => projectId
      ? batch.destination.kind === 'project' && batch.destination.projectId === projectId && batch.files.some(file => file.state !== 'cleared' && !file.hasSuccessfulAttachment)
      : batch.destination.kind === 'pending' && batch.files.some(file => file.state !== 'cleared'));
  }
  /** Process-wide for this daemon's intake routes; acquired before reading or creating a temp file. */
  admit(): () => void {
    if (this.transfers >= 2) throw new IntakeError(429, 'intake-transfer-busy', 'Two intake transfers are active; retry shortly', true);
    this.transfers++; let released = false; return () => { if (!released) { released = true; this.transfers--; } };
  }
  /**
   * Root custody (temp stream, object, receipt) settles inside one admitted
   * root write; a project destination then materializes under its own project
   * admission. `signal` cancels only a pending project admission.
   */
  async put(batchId: string, fileId: string, stream: Readable, admittedRelease?: () => void, verifyWrite?: () => Promise<boolean>, options: { signal?: AbortSignal } = {}): Promise<IntakeFilePutResponse> {
    const release = admittedRelease ?? this.admit(), key = `${batchId}/${fileId}`;
    // Clear may abort during temp preparation, before the iterator attaches.
    // The iterator still propagates the transfer error to the normal failure path.
    const absorbStreamError = () => {}; stream.on('error', absorbStreamError);
    const streams = this.active.get(key) ?? new Set<Readable>(); streams.add(stream); this.active.set(key, streams);
    try {
      await this.root(finalIO => this.store(batchId, fileId, stream, finalIO, verifyWrite));
      const destination = intakeManifest(this.batch(batchId)).destination;
      if (destination.kind === 'project') await this.materializeAdmitted(batchId, fileId, destination.projectId, destination.conversationId, destination.dir ?? '', verifyWrite, options.signal);
      const snapshot = this.snapshot(batchId); return { intakeBatchId: batchId, revision: snapshot.revision, file: snapshot.files.find(file => file.clientFileId === fileId)! };
    } finally { stream.off('error', absorbStreamError); streams.delete(stream); if (!streams.size) this.active.delete(key); release(); }
  }
  /** Retry only the frozen project placement from already accepted Library bytes. */
  async retryProjectPlacement(batchId: string, fileId: string, verifyWrite?: () => Promise<boolean>, options: { signal?: AbortSignal } = {}): Promise<IntakeFilePutResponse> {
    const destination = intakeManifest(this.batch(batchId)).destination;
    if (destination.kind !== 'project') throw new IntakeError(409, 'intake-conflict', 'This intake has no frozen project destination');
    const row = this.item(batchId, fileId);
    if (row.state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared');
    if (!row.asset_id || !row.content_hash) throw new IntakeError(409, 'intake-conflict', 'Upload the file before retrying project placement');
    if (!this.outcome(row).stored) throw new IntakeError(409, 'bytes-removed', 'Stored bytes are unavailable; reselect the original file', true);
    await this.materializeAdmitted(batchId, fileId, destination.projectId, destination.conversationId, destination.dir ?? '', verifyWrite, options.signal, 'project-retry');
    const snapshot = this.snapshot(batchId);
    return { intakeBatchId: batchId, revision: snapshot.revision, file: snapshot.files.find(file => file.clientFileId === fileId)! };
  }
  /** One accepted root callback: every effect is guarded, and owned cleanup finishes before the permit releases. */
  private async store(batchId: string, fileId: string, stream: Readable, finalIO: PlacementFinalIO, verifyWrite?: () => Promise<boolean>): Promise<void> {
    let temporaryPath: string | undefined, published = false;
    try {
      const original = this.item(batchId, fileId), descriptor = intakeDescriptor(original);
      if (original.state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared');
      if (descriptor.size > INTAKE_FILE_MAX_BYTES) throw new IntakeError(413, 'intake-size-exceeded', INTAKE_SIZE_EXCEEDED_MESSAGE);
      const tempDir = path.join(this.deps.libraryDir, 'intake-temp'); finalIO.assertCurrent(); await mkdir(tempDir, { recursive: true });
      temporaryPath = path.join(tempDir, `${randomUUID()}.tmp`); finalIO.assertCurrent(); const handle = await open(temporaryPath, 'wx');
      let size = 0, prefix = Buffer.alloc(0); const hash = createHash('sha256'), textProbe = new IntakeTextProbe();
      try {
        for await (const chunk of stream.iterator({ destroyOnReturn: false })) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk); size += bytes.length;
          if (size > INTAKE_FILE_MAX_BYTES) throw new IntakeError(413, 'intake-size-exceeded', INTAKE_SIZE_EXCEEDED_MESSAGE);
          if (size > descriptor.size) throw new IntakeError(422, 'intake-size-mismatch', 'Uploaded byte length does not match the frozen descriptor', true);
          hash.update(bytes); textProbe.push(bytes); if (prefix.length < 65536) prefix = Buffer.concat([prefix, bytes.subarray(0, 65536-prefix.length)]);
          finalIO.assertCurrent(); await handle.writeFile(bytes);
        }
        finalIO.assertCurrent(); await handle.sync();
      } finally { await handle.close(); }
      if (size !== descriptor.size) throw new IntakeError(422, 'intake-size-mismatch', 'Uploaded byte length does not match the frozen descriptor', true);
      if (verifyWrite && !await verifyWrite()) throw new IntakeError(403, 'project-forbidden', 'Project write authorization changed during transfer');
      const contentHash = hash.digest('hex'), mime = detectIntakeMime(prefix, textProbe.finish(), size);
      const kind: LibraryAssetKind = /^(image\/|video\/|font\/|text\/)/.test(mime) || mime === 'application/font-woff' ? kindForMime(mime) : 'file';
      const objectPath = libraryObjectPath(this.deps.libraryDir, contentHash, '.bin'); finalIO.assertCurrent(); await mkdir(path.dirname(objectPath), { recursive: true });
      // Publish a fully verified object atomically. A copy into its final name
      // could leave partial bytes after process loss or race another PUT.
      await this.locked(`object:${contentHash}`, async () => {
        if (existsSync(objectPath)) {
          if (await fileHash(objectPath) !== contentHash) throw new IntakeError(409, 'intake-conflict', 'Existing Library object differs from its hash');
        } else { finalIO.assertCurrent(); await rename(temporaryPath!, objectPath); published = true; }
      });
      if (verifyWrite && !await verifyWrite()) throw new IntakeError(403, 'project-forbidden', 'Project write authorization changed before commit');
      finalIO.assertCurrent();
      this.deps.db.transaction(() => {
        const current = this.item(batchId, fileId);
        if (current.state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared');
        if (current.content_hash && current.content_hash !== contentHash) throw new IntakeError(409, 'intake-conflict', 'File identity already holds different bytes');
        const destination = intakeManifest(this.batch(batchId)).destination;
        const asset = registerStreamedLibraryAsset({ db: this.deps.db, objectPath, contentHash, size, mime, kind, prefix, ...(destination.kind === 'project' ? { projectId: destination.projectId } : {}) });
        // Project admission follows this root callback. Record unfinished
        // placement now so a later refusal cannot erase the retry path.
        const pendingCopy = destination.kind === 'project'
          ? JSON.stringify({ code: 'intake-copy-failed', message: 'Bytes are stored; project placement has not completed', retryable: true })
          : null;
        this.deps.db.prepare("UPDATE workbench_intake_items SET state = 'stored', asset_id = ?, content_hash = ?, detected_mime = ?, intake_kind = ?, error_json = ? WHERE batch_id = ? AND client_file_id = ?").run(asset.id, contentHash, mime, kind, pendingCopy, batchId, fileId); bumpIntake(this.deps.db, batchId);
      }).immediate();
    } catch (error) {
      // A placement refusal leaves the truthful prior state for a safe retry; no unguarded error SQL.
      if (error instanceof PlacementCoordinationError) throw error;
      const current = getIntakeItem(this.deps.db, batchId, fileId);
      if (current && current.state !== 'stored' && current.state !== 'cleared') {
        const failure = error instanceof IntakeError ? error : new IntakeError(422, 'intake-interrupted', 'Transfer interrupted; reselect the original file', true);
        finalIO.assertCurrent();
        setIntakeError(this.deps.db, batchId, fileId, failure.retryable ? 'needs-reselection' : 'failed', failure.wire());
      }
      throw error;
    } finally { if (temporaryPath && !published && custodyCurrent(finalIO)) await rm(temporaryPath, { force: true }); }
  }
  async clear(batchId: string, request: ClearIntakeRequest): Promise<IntakeBatchSnapshot> {
    this.batch(batchId); const ids = [...new Set(request.clientFileIds ?? intakeItems(this.deps.db, batchId).map(row => row.client_file_id))].sort();
    for (const id of ids) this.item(batchId, id);
    // A callback inside publication cannot await its own lock. Refuse it rather
    // than acknowledge Clear early or deadlock a fault/authorization hook.
    if (this.publicationContext.getStore()?.active) throw new IntakeError(409, 'intake-conflict', 'Retry Clear after the current attachment finishes', true);
    // Root admission precedes the publication locks; Clear never waits for a project gate while holding them.
    return this.root(async finalIO => {
      const clear = async (index: number): Promise<IntakeBatchSnapshot> => {
        const id = ids[index];
        if (id !== undefined) return this.locked(`publication:${batchId}/${id}`, () => clear(index + 1));
        finalIO.assertCurrent();
        this.deps.db.transaction(() => { for (const id of ids) this.deps.db.prepare("UPDATE workbench_intake_items SET state = 'cleared', error_json = NULL WHERE batch_id = ? AND client_file_id = ?").run(batchId, id); bumpIntake(this.deps.db, batchId); }).immediate();
        for (const id of ids) for (const stream of this.active.get(`${batchId}/${id}`) ?? []) stream.destroy(new IntakeError(409, 'intake-cleared', 'Intake reference was cleared'));
        return this.snapshot(batchId);
      };
      return clear(0);
    });
  }
  private async locked<T>(key: string, work: () => Promise<T>): Promise<T> {
    const prior = this.locks.get(key) ?? Promise.resolve(); let unlock!: () => void;
    const next = new Promise<void>(resolve => { unlock = resolve; }); this.locks.set(key, next);
    await prior; try { return await work(); } finally { unlock(); if (this.locks.get(key) === next) this.locks.delete(key); }
  }
  private async publication<T>(batchId: string, fileId: string, work: () => Promise<T>): Promise<T> {
    const key = `${batchId}/${fileId}`;
    // This service instance orders Clear against publication AND receipt commit.
    // Preparation stays outside so Clear can cancel it without waiting for copy.
    return this.locked(`publication:${key}`, async () => {
      const context = { active: true };
      try { return await this.publicationContext.run(context, work); }
      finally { context.active = false; }
    });
  }
  private async publishProjectCopy<T>(source: string, target: string, expectedHash: string, batchId: string, fileId: string, complete: () => Promise<T>, finalIO: PlacementFinalIO, verifyWrite?: () => Promise<boolean>): Promise<T> {
    const temporaryPath = path.join(path.dirname(target), `.intake-${randomUUID()}.tmp`);
    let owned: { dev: number; ino: number } | undefined;
    try {
      // EXCL creates a separate project-local inode; never link a Library object.
      finalIO.assertCurrent(); await copyFile(source, temporaryPath, constants.COPYFILE_EXCL | constants.COPYFILE_FICLONE);
      owned = await lstat(temporaryPath);
      await this.deps.beforePublish?.(temporaryPath);
      const handle = await open(temporaryPath, 'r');
      try { finalIO.assertCurrent(); await handle.sync(); } finally { await handle.close(); }
      if (await fileHash(temporaryPath) !== expectedHash) throw new IntakeError(422, 'intake-copy-failed', 'Temporary project copy is incomplete; retry attachment', true);
      const prepared = owned;
      return await this.publication(batchId, fileId, async () => {
        if (verifyWrite && !await verifyWrite()) throw new IntakeError(403, 'project-forbidden', 'Project attachment authorization changed before publication');
        if (this.item(batchId, fileId).state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared before publication');
        const current = await lstat(temporaryPath);
        if (current.dev !== prepared.dev || current.ino !== prepared.ino) throw new IntakeError(422, 'intake-copy-failed', 'Temporary project copy changed; retry attachment', true);
        // link publishes complete local bytes atomically and refuses any existing final.
        finalIO.assertCurrent();
        try { await (this.deps.linkProjectCopy ?? link)(temporaryPath, target); }
        catch (error) {
          if (!isCode(error, 'EEXIST')) {
            if (['ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EPERM'].some(code => isCode(error, code))) throw new IntakeError(422, 'intake-destination-unsupported', 'This destination filesystem cannot publish the attachment atomically. Select a supported project destination.');
            throw error;
          }
        }
        return complete();
      });
    } finally {
      if (owned) {
        const current = await lstat(temporaryPath).catch(() => undefined);
        if (current?.dev === owned.dev && current.ino === owned.ino && custodyCurrent(finalIO)) await unlink(temporaryPath);
      }
    }
  }
  /** The physical project gate precedes every project effect; never entered from inside a root callback. */
  private materializeAdmitted(batchId: string, fileId: string, projectId: string, conversationId: string | undefined, dir: string, verifyWrite?: () => Promise<boolean>, signal?: AbortSignal, retryMode?: 'project-retry' | 'pending-attach'): Promise<Materialization | undefined> {
    return this.deps.authority.projectWrites.run(projectId, finalIO => this.materialize(batchId, fileId, projectId, conversationId, dir, finalIO, verifyWrite, retryMode), signal ? { signal } : {});
  }
  private async materialize(batchId: string, fileId: string, projectId: string, conversationId: string | undefined, dir: string, finalIO: PlacementFinalIO, verifyWrite?: () => Promise<boolean>, retryMode?: 'project-retry' | 'pending-attach'): Promise<Materialization | undefined> {
    return this.locked(`${batchId}/${fileId}/${projectId}`, async () => {
      let row = this.item(batchId, fileId);
      const priorReceipt = materializations(row).find(item => item.projectId === projectId && item.conversationId === conversationId);
      const priorError = row.error_json ? JSON.parse(row.error_json) as ApiError : undefined;
      // A final authorization refusal can leave an incomplete reservation;
      // this attempt checks authorization again before moving it.
      const reassignOccupied = retryMode === 'project-retry' || (retryMode === 'pending-attach' && priorReceipt?.complete === false && (!priorError || priorError.retryable || priorError.code === 'project-forbidden'));
      if (row.state === 'cleared' && !priorReceipt?.complete) return undefined;
      const asset = row.asset_id ? getLibraryAsset(this.deps.db, row.asset_id) : null;
      if (!asset || !row.content_hash) return undefined;
      const source = resolveAssetBytesPath(asset, this.deps.projectsDir); if (!source) return undefined;
      try {
        if (verifyWrite && !await verifyWrite()) throw new IntakeError(403, 'project-forbidden', 'Project attachment authorization changed');
        const descriptor = intakeDescriptor(row);
        const relativeDir = descriptor.relativePath ? path.posix.dirname(descriptor.relativePath) : '.';
        const targetDir = path.posix.join(dir, relativeDir === '.' ? '' : relativeDir);
        const normalizedDir = targetDir === '.' ? '' : targetDir;
        finalIO.assertCurrent(); const directory = await this.deps.projectDirectory(projectId, normalizedDir, finalIO);
        let receipt = materializations(row).find(item => item.projectId === projectId && item.conversationId === conversationId);
        if (!receipt) {
          const name = sanitizeName(descriptor.filename) || 'file'; const ext = path.extname(name), stem = name.slice(0, name.length-ext.length);
          finalIO.assertCurrent();
          this.deps.db.transaction(() => {
            row = this.item(batchId, fileId); if (row.state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared');
            receipt = materializations(row).find(item => item.projectId === projectId && item.conversationId === conversationId);
            if (receipt) return;
            const reserved = new Set((this.deps.db.prepare('SELECT materializations_json FROM workbench_intake_items').all() as Pick<IntakeItemRow,'materializations_json'>[]).flatMap(item => JSON.parse(item.materializations_json) as Materialization[]).filter(item => item.projectId === projectId).map(item => item.relPath));
            const shared = materializations(row).find(item => item.projectId === projectId && path.posix.dirname(item.relPath) === (normalizedDir || '.'));
            let suffix = 0, candidate = name, relPath = shared?.relPath ?? path.posix.join(normalizedDir, candidate);
            if (!shared) while (existsSync(path.join(directory, candidate)) || reserved.has(relPath)) { candidate = `${stem}-${++suffix}${ext}`; relPath = path.posix.join(normalizedDir, candidate); }
            receipt = { projectId, ...(conversationId ? { conversationId } : {}), relPath, complete: false };
            this.deps.db.prepare('UPDATE workbench_intake_items SET materializations_json = ? WHERE batch_id = ? AND client_file_id = ?').run(JSON.stringify([...materializations(row), receipt]), batchId, fileId); bumpIntake(this.deps.db, batchId);
          }).immediate();
        }
        if (!receipt) return undefined;
        let target = path.join(directory, path.posix.basename(receipt.relPath));
        if (!receipt.complete && existsSync(target)) {
          const occupantHash = await fileHash(target);
          if (occupantHash !== row.content_hash && reassignOccupied) {
            // Retry may move only this incomplete reservation. The
            // occupied physical file stays untouched, regardless of whether
            // it came from an overlapping imported root or an external edit.
            const oldReceipt = receipt;
            const name = sanitizeName(descriptor.filename) || 'file';
            const ext = path.extname(name), stem = name.slice(0, name.length - ext.length);
            const reserved = new Set((this.deps.db.prepare('SELECT materializations_json FROM workbench_intake_items').all() as Pick<IntakeItemRow, 'materializations_json'>[])
              .flatMap(item => JSON.parse(item.materializations_json) as Materialization[]).filter(item => item.projectId === projectId).map(item => item.relPath));
            let suffix = 1, candidate = `${stem}-${suffix}${ext}`, relPath = path.posix.join(normalizedDir, candidate);
            while (existsSync(path.join(directory, candidate)) || reserved.has(relPath)) {
              candidate = `${stem}-${++suffix}${ext}`; relPath = path.posix.join(normalizedDir, candidate);
            }
            finalIO.assertCurrent();
            this.deps.db.transaction(() => {
              const current = this.item(batchId, fileId);
              const previous = materializations(current).find(item => item.projectId === projectId && item.conversationId === conversationId);
              if (!previous || previous.complete || previous.relPath !== oldReceipt.relPath || current.state === 'cleared') throw new IntakeError(409, 'intake-conflict', 'Project placement changed during retry');
              const updated = materializations(current).map(item => item.projectId === projectId && item.conversationId === conversationId ? { ...item, relPath } : item);
              this.deps.db.prepare('UPDATE workbench_intake_items SET materializations_json = ? WHERE batch_id = ? AND client_file_id = ?').run(JSON.stringify(updated), batchId, fileId);
              bumpIntake(this.deps.db, batchId);
            }).immediate();
            receipt = { ...oldReceipt, relPath };
            target = path.join(directory, candidate);
          }
        }
        if (row.state === 'cleared') {
          return priorReceipt?.complete && await fileHash(target) === row.content_hash ? priorReceipt : undefined;
        }
        const reservedReceipt = receipt;
        const complete = async () => {
          if (this.item(batchId, fileId).state === 'cleared') return undefined;
          if (await fileHash(target) !== row.content_hash) throw new IntakeError(409, 'intake-conflict', 'Reserved project file contains different bytes; external edits were preserved');
          await this.deps.afterCopy?.();
          if (verifyWrite && !await verifyWrite()) throw new IntakeError(403, 'project-forbidden', 'Project attachment authorization changed before receipt commit');
          const completed = { ...reservedReceipt, complete: true };
          finalIO.assertCurrent();
          this.deps.db.transaction(() => {
            const current = this.item(batchId, fileId); if (current.state === 'cleared') return;
            if (current.asset_id) addLibraryAssetSource(this.deps.db, { assetId: current.asset_id, sourceKind: 'drop', projectId });
            const copies = materializations(current).map(item => item.projectId === projectId && item.conversationId === conversationId ? completed : item);
            this.deps.db.prepare("UPDATE workbench_intake_items SET state = 'stored', materializations_json = ?, error_json = NULL WHERE batch_id = ? AND client_file_id = ?").run(JSON.stringify(copies), batchId, fileId); bumpIntake(this.deps.db, batchId);
          }).immediate();
          return this.item(batchId, fileId).state === 'cleared' ? undefined : completed;
        };
        if (!existsSync(target)) return await this.publishProjectCopy(source, target, row.content_hash, batchId, fileId, complete, finalIO, verifyWrite);
        return await this.publication(batchId, fileId, complete);
      } catch (error) {
        // Placement refusals propagate typed; the stored state stays truthful and retryable.
        if (error instanceof PlacementCoordinationError) throw error;
        const failure = error instanceof IntakeError ? error : new IntakeError(422, 'intake-copy-failed', 'Bytes are stored; retry project attachment', true);
        finalIO.assertCurrent();
        setIntakeError(this.deps.db, batchId, fileId, 'stored', failure.wire());
        if (failure.status === 403) throw failure;
        return undefined;
      }
    });
  }
  async attach(batchId: string, request: AttachIntakeRequest, verifyWrite?: () => Promise<boolean>, options: { signal?: AbortSignal } = {}): Promise<AttachIntakeResponse> {
    const destination = intakeManifest(this.batch(batchId)).destination;
    if (destination.kind === 'project' && (destination.projectId !== request.projectId || (destination.conversationId && destination.conversationId !== request.conversationId))) throw new IntakeError(409, 'intake-conflict', 'Project destination is frozen');
    const ids = request.clientFileIds ?? intakeItems(this.deps.db, batchId).map(row => row.client_file_id);
    for (const id of ids) this.item(batchId, id);
    const attachments: AttachIntakeResponse['attachments'] = [];
    for (const id of ids) {
      const receipt = await this.materializeAdmitted(batchId, id, request.projectId, request.conversationId, destination.kind === 'project' ? destination.dir ?? '' : '', verifyWrite, options.signal, destination.kind === 'pending' ? 'pending-attach' : undefined);
      const row = this.item(batchId, id);
      const stored = this.outcome(row).stored ?? (receipt && row.asset_id && row.content_hash ? { assetId: row.asset_id, contentHash: row.content_hash, filename: intakeDescriptor(row).filename, size: intakeDescriptor(row).size } : undefined);
      if (receipt && stored) attachments.push({ clientFileId: id, assetId: stored.assetId, contentHash: stored.contentHash, projectId: request.projectId, conversationId: request.conversationId, relPath: receipt.relPath, filename: stored.filename, size: stored.size });
    }
    const snapshot = this.snapshot(batchId); return { intakeBatchId: batchId, revision: snapshot.revision, attachments, files: snapshot.files };
  }
  download(batchId: string, fileId: string): { path: string; filename: string; size: number } {
    const row = this.item(batchId, fileId), outcome = this.outcome(row);
    if (outcome.state === 'cleared') throw new IntakeError(409, 'intake-cleared', 'Intake reference was cleared');
    if (!outcome.stored) throw new IntakeError(404, 'bytes-removed', 'Original bytes are unavailable', true);
    const asset = getLibraryAsset(this.deps.db, outcome.stored.assetId)!;
    const source = resolveAssetBytesPath(asset, this.deps.projectsDir); if (!source) throw new IntakeError(404, 'bytes-removed', 'Original bytes are unavailable', true);
    return { path: source, filename: outcome.stored.filename, size: outcome.stored.size };
  }
}
