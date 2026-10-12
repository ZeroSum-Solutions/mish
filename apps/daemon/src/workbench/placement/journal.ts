import type Database from 'better-sqlite3';
import path from 'node:path';

export class PlacementJournalError extends Error {
  readonly code: 'VALIDATION_FAILED' | 'NOT_FOUND' | 'IDEMPOTENCY_CONFLICT' | 'REVISION_CONFLICT' | 'STATE_CONFLICT' | 'IDENTITY_CONFLICT' | 'RECOVERY_REQUIRED' | 'INCARNATION_REUSED' | 'DURABILITY_UNQUALIFIED';
  constructor(code: PlacementJournalError['code'], message: string) { super(message); this.name = 'PlacementJournalError'; this.code = code; }
}
const fail = (code: PlacementJournalError['code'], message: string): never => { throw new PlacementJournalError(code, message); };
export interface NamedFile { device: string; inode: string; sha256: string; byteLength: number }
export interface RawSnapshot { snapshotId: string; sha256: string; byteLength: number }
export interface JournalMovement { movementId: string; kind: 'retire' | 'publish' | 'restore'; source: string; destination: string; expectedSource: NamedFile; snapshot: RawSnapshot }
export interface OperationManifest {
  operationId: string; principalId: string; projectId: string; projectRoot: string; kind: 'apply' | 'undo';
  idempotencyKey: string; inputDigest: string; planDigest: string; movements: readonly JournalMovement[];
}
export interface MovementReceipt { source: 'absent'; destination: NamedFile; verificationDigest: string }
export interface JournalOperation {
  manifest: OperationManifest; incarnationId: string; revision: number;
  state: 'queued' | 'running' | 'done' | 'failed' | 'interrupted';
  stage: 'queued' | 'running' | 'movement-intent' | 'movement-verified' | 'complete' | 'failed' | 'recovery-required';
  movements: Array<{ movementId: string; intent: boolean; receipt: MovementReceipt | null }>;
  verificationDigest: string | null; reason: string | null;
}
export interface ProcessIdentity { pid: number; bootId: string; startToken: string; handshakeId: string }
export interface LaunchIntent { launchId: string; kind: 'child' | 'helper'; operationId?: string; projectRoots: readonly string[]; intentDigest: string }
export interface JournalLaunch extends LaunchIntent { incarnationId: string; identity: ProcessIdentity | null; spawnDigest: string | null; exitDigest: string | null; drainDigest: string | null }
export type ObjectObservation = { kind: 'absent' } | { kind: 'unknown' } | { kind: 'file'; file: NamedFile };
export interface RecoveryObservation { operationId: string; revision: number; objects: readonly { location: string; observation: ObjectObservation }[] }
export interface OperationRecovery { operationId: string; projectRoot: string; revision: number; state: JournalOperation['state']; disposition: 'no-mutation' | 'verified' | 'recovery-required' | 'conflict'; partial: readonly { location: string; observation: ObjectObservation }[] }
export interface JournalRecovery { global: 'blocked' | 'clear'; unresolvedLaunches: string[]; operations: OperationRecovery[] }
const MAX_RECORD_BYTES = 2 * 1024 * 1024;

function keys(value: unknown, names: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== names.length || Object.keys(value).some(key => !names.includes(key))) fail('VALIDATION_FAILED', 'Exact journal fields required');
}

function id(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(value)) fail('VALIDATION_FAILED', 'Bounded identifier required');
}
function hash(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) fail('VALIDATION_FAILED', 'SHA-256 required');
}
function canonical(value: unknown): asserts value is string {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value) || path.resolve(value) !== value) fail('VALIDATION_FAILED', 'Bounded canonical physical location required');
}
function file(value: NamedFile): void {
  keys(value, ['device', 'inode', 'sha256', 'byteLength']);
  if (typeof value.device !== 'string' || typeof value.inode !== 'string' || value.device.length > 20 || value.inode.length > 20 || !/^(0|[1-9][0-9]*)$/.test(value.device) || !/^(0|[1-9][0-9]*)$/.test(value.inode)) fail('VALIDATION_FAILED', 'Bounded lossless device/inode identity required');
  hash(value.sha256);
  if (!Number.isSafeInteger(value.byteLength) || value.byteLength < 0 || value.byteLength > 32 * 1024 * 1024) fail('VALIDATION_FAILED', 'Bounded file size required');
}
function json(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(json).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => JSON.stringify(k) + ':' + json(v)).join(',') + '}';
  const encoded = JSON.stringify(value); if (encoded === undefined) return fail('VALIDATION_FAILED', 'JSON value required'); return encoded;
}
const equal = (a: unknown, b: unknown) => json(a) === json(b);
function encodeRecord(value: unknown): string {
  const encoded = json(value);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_RECORD_BYTES) fail('VALIDATION_FAILED', 'Journal record exceeds its reserved budget');
  return encoded;
}
function validateManifest(m: OperationManifest): void {
  keys(m, ['operationId', 'principalId', 'projectId', 'projectRoot', 'kind', 'idempotencyKey', 'inputDigest', 'planDigest', 'movements']);
  for (const v of [m.operationId, m.principalId, m.projectId, m.idempotencyKey]) id(v);
  canonical(m.projectRoot); hash(m.inputDigest); hash(m.planDigest);
  if (m.kind !== 'apply' && m.kind !== 'undo') fail('VALIDATION_FAILED', 'Unknown operation kind');
  if (!Array.isArray(m.movements) || m.movements.length < 1 || m.movements.length > 512) fail('VALIDATION_FAILED', 'Complete bounded movement manifest required');
  const ids = new Set<string>();
  for (const move of m.movements) {
    keys(move, ['movementId', 'kind', 'source', 'destination', 'expectedSource', 'snapshot']);
    id(move.movementId); if (ids.has(move.movementId)) fail('VALIDATION_FAILED', 'Duplicate movement'); ids.add(move.movementId);
    if (!['retire', 'publish', 'restore'].includes(move.kind)) fail('VALIDATION_FAILED', 'Unknown movement kind');
    canonical(move.source); canonical(move.destination); if (move.source === move.destination) fail('VALIDATION_FAILED', 'Distinct movement locations required');
    file(move.expectedSource); keys(move.snapshot, ['snapshotId', 'sha256', 'byteLength']); id(move.snapshot.snapshotId); hash(move.snapshot.sha256);
    if (move.snapshot.sha256 !== move.expectedSource.sha256 || move.snapshot.byteLength !== move.expectedSource.byteLength) fail('VALIDATION_FAILED', 'Independent raw snapshot must match planned bytes');
  }
}
function validateIdentity(identity: ProcessIdentity): void {
  keys(identity, ['pid', 'bootId', 'startToken', 'handshakeId']);
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0) fail('VALIDATION_FAILED', 'Observed PID required');
  for (const v of [identity.bootId, identity.startToken, identity.handshakeId]) id(v);
}
function processKey({ pid, bootId, startToken }: ProcessIdentity): string { return json({ pid, bootId, startToken }); }

interface OperationRow { incarnation_id: string; record_json: string }
interface LaunchRow { id: string; incarnation_id: string; identity_key: string | null; record_json: string }
function decodeRecord<T>(value: unknown): T {
  try { if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > MAX_RECORD_BYTES) throw new Error('invalid record'); return JSON.parse(value) as T; }
  catch { return fail('RECOVERY_REQUIRED', 'Journal record is unreadable'); }
}
function decodeOperation(row: OperationRow, operationId: string): JournalOperation {
  const op = decodeRecord<JournalOperation>(row.record_json); validateManifest(op.manifest);
  if (op.incarnationId !== row.incarnation_id || op.manifest.operationId !== operationId || !Number.isSafeInteger(op.revision) || op.revision < 0 || !Array.isArray(op.movements) || op.movements.length !== op.manifest.movements.length || !['queued', 'running', 'done', 'failed', 'interrupted'].includes(op.state)) fail('RECOVERY_REQUIRED', 'Journal operation is inconsistent');
  for (const [i, entry] of op.movements.entries()) {
    const move = op.manifest.movements[i]!;
    if (entry.movementId !== move.movementId || typeof entry.intent !== 'boolean' || (entry.receipt && (!entry.intent || entry.receipt.source !== 'absent' || !equal(entry.receipt.destination, move.expectedSource)))) fail('RECOVERY_REQUIRED', 'Journal receipt is inconsistent');
    if (entry.receipt) hash(entry.receipt.verificationDigest);
  }
  if (op.state === 'done' && (!op.movements.every(m => m.receipt) || !op.verificationDigest)) fail('RECOVERY_REQUIRED', 'Done label lacks verified receipts');
  return op;
}
function decodeLaunch(row: LaunchRow): JournalLaunch {
  const l = decodeRecord<JournalLaunch>(row.record_json); id(l.launchId); id(l.incarnationId); hash(l.intentDigest);
  if (l.launchId !== row.id || l.incarnationId !== row.incarnation_id || !['child', 'helper'].includes(l.kind) || !Array.isArray(l.projectRoots)) fail('RECOVERY_REQUIRED', 'Invalid launch intent');
  l.projectRoots.forEach(canonical); if (l.identity) validateIdentity(l.identity);
  if (row.identity_key !== (l.identity ? processKey(l.identity) : null) || (l.identity && !l.spawnDigest) || (l.spawnDigest && !l.identity) || (l.exitDigest && !l.spawnDigest) || (l.drainDigest && !l.exitDigest)) fail('RECOVERY_REQUIRED', 'Launch facts are incomplete');
  for (const d of [l.spawnDigest, l.exitDigest, l.drainDigest]) if (d !== null) hash(d);
  return l;
}

export const PLACEMENT_JOURNAL_TABLES = ['placement_journal_incarnations', 'placement_journal_current', 'placement_journal_operations', 'placement_journal_launches'] as const;
export type PlacementJournalReadOnlyInspection =
  | { kind: 'absent' }
  | { kind: 'inspected'; incarnations: number; operations: number; launches: number; unresolvedLaunches: readonly string[]; fencedProjectRoots: readonly string[] };
/**
 * C2a ordinary-transition pre-check over an explicitly read-only connection.
 * It never constructs an incarnation, migrates or repairs. Missing tables in a
 * never-activated root report `absent`; a partial table set is ambiguous and
 * throws. Every launch without recorded drainage is unresolved (no current
 * incarnation exists in ordinary mode). Every unfinished operation, and every
 * failed/interrupted one with movement intent or a linked launch, fences its
 * canonical project root. Strict decoding throws on any malformed record.
 */
export function inspectPlacementJournalReadOnly(db: Database.Database): PlacementJournalReadOnlyInspection {
  if (!db.readonly) fail('DURABILITY_UNQUALIFIED', 'Transition pre-check requires a read-only connection');
  return db.transaction((): PlacementJournalReadOnlyInspection => {
    const present = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const found = PLACEMENT_JOURNAL_TABLES.filter(name => present.has(name));
    if (found.length === 0) {
      // A retained version record proves the journal once existed: its loss is ambiguous history, never legacy absence.
      const registered = present.has('workbench_owned_migrations')
        && db.prepare("SELECT 1 FROM workbench_owned_migrations WHERE name='placement-journal'").get() !== undefined;
      if (registered) fail('RECOVERY_REQUIRED', 'Registered placement journal is missing');
      return { kind: 'absent' };
    }
    if (found.length !== PLACEMENT_JOURNAL_TABLES.length) fail('RECOVERY_REQUIRED', 'Partial placement journal schema is ambiguous');
    const incarnations = new Set((db.prepare('SELECT id FROM placement_journal_incarnations').all() as { id: string }[]).map(row => { id(row.id); return row.id; }));
    const launches = (db.prepare('SELECT id, incarnation_id, identity_key, record_json FROM placement_journal_launches ORDER BY id').all() as LaunchRow[]).map(decodeLaunch);
    const rows = db.prepare('SELECT id, incarnation_id, record_json FROM placement_journal_operations ORDER BY id').all() as (OperationRow & { id: string })[];
    const fenced = new Set<string>();
    for (const row of rows) {
      const op = decodeOperation(row, row.id);
      if (!incarnations.has(op.incarnationId)) fail('RECOVERY_REQUIRED', 'Operation references an unknown incarnation');
      const linked = launches.some(l => l.operationId === op.manifest.operationId);
      if (op.state === 'queued' || op.state === 'running' || (op.state !== 'done' && (linked || op.movements.some(m => m.intent)))) fenced.add(op.manifest.projectRoot);
    }
    for (const l of launches) if (!incarnations.has(l.incarnationId)) fail('RECOVERY_REQUIRED', 'Launch references an unknown incarnation');
    return { kind: 'inspected', incarnations: incarnations.size, operations: rows.length, launches: launches.length,
      unresolvedLaunches: launches.filter(l => !l.drainDigest).map(l => l.launchId), fencedProjectRoots: [...fenced].sort() };
  })();
}

/** Existing daemon migration pattern; deliberately unregistered until ownership/bootstrap adoption. */
export function migratePlacementJournal(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS placement_journal_incarnations (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS placement_journal_current (singleton INTEGER PRIMARY KEY CHECK(singleton=1), incarnation_id TEXT NOT NULL REFERENCES placement_journal_incarnations(id));
    CREATE TABLE IF NOT EXISTS placement_journal_operations (
      id TEXT PRIMARY KEY, principal_id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      idempotency_key TEXT NOT NULL, incarnation_id TEXT NOT NULL REFERENCES placement_journal_incarnations(id),
      record_json TEXT NOT NULL CHECK(json_valid(record_json)), UNIQUE(principal_id, project_id, kind, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS placement_journal_launches (
      id TEXT PRIMARY KEY, incarnation_id TEXT NOT NULL REFERENCES placement_journal_incarnations(id),
      identity_key TEXT UNIQUE, record_json TEXT NOT NULL CHECK(json_valid(record_json))
    );
  `);
}

/** Trusted injected SQLite only: no database opening, root fallback, live-object I/O or compensation. */
export class PlacementJournal {
  readonly #db: Database.Database;
  readonly #incarnationId: string;
  constructor(options: { db: Database.Database; incarnationId: string }) {
    id(options.incarnationId); this.#db = options.db; this.#incarnationId = options.incarnationId;
    this.#commit(() => {
      if (this.#db.prepare('SELECT 1 FROM placement_journal_incarnations WHERE id=?').get(this.#incarnationId)) fail('INCARNATION_REUSED', 'Each process binding requires a fresh incarnation');
      this.#db.prepare('INSERT INTO placement_journal_incarnations VALUES (?)').run(this.#incarnationId);
      this.#db.prepare('INSERT INTO placement_journal_current VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET incarnation_id=excluded.incarnation_id').run(this.#incarnationId);
    }, false);
  }
  #current(): void {
    const row = this.#db.prepare('SELECT incarnation_id FROM placement_journal_current WHERE singleton=1').get() as { incarnation_id: string } | undefined;
    if (row?.incarnation_id !== this.#incarnationId) fail('INCARNATION_REUSED', 'Journal binding was superseded');
  }
  #commit<T>(work: () => T, checkCurrent = true): T {
    if (this.#db.inTransaction || this.#db.pragma('journal_mode', { simple: true }) !== 'wal' || Number(this.#db.pragma('synchronous', { simple: true })) < 2 || Number(this.#db.pragma('foreign_keys', { simple: true })) !== 1) fail('DURABILITY_UNQUALIFIED', 'Disk WAL, outermost transaction, FULL synchronization and foreign keys required');
    return this.#db.transaction(() => { if (checkCurrent) this.#current(); return work(); }).immediate();
  }
  readOperation(operationId: string): JournalOperation {
    this.#current(); id(operationId);
    const row = this.#db.prepare('SELECT incarnation_id, record_json FROM placement_journal_operations WHERE id=?').get(operationId) as OperationRow | undefined;
    if (!row) return fail('NOT_FOUND', 'Operation is unavailable');
    return decodeOperation(row, operationId);
  }
  get incarnationId(): string { return this.#incarnationId; }
  /** Read-only prior-incarnation operations for fresh exact-location readback; grants no authority. */
  readPriorOperations(): readonly JournalOperation[] {
    this.#current();
    return (this.#db.prepare('SELECT id FROM placement_journal_operations WHERE incarnation_id<>? ORDER BY id').all(this.#incarnationId) as { id: string }[]).map(row => this.readOperation(row.id));
  }
  /** Read-only launch facts for the supervisor adapter; never a permission to record a guessed fact. */
  readLaunches(): readonly JournalLaunch[] { return this.#launches(); }
  createOperation(manifest: OperationManifest): JournalOperation {
    validateManifest(manifest);
    return this.#commit(() => {
      const row = this.#db.prepare('SELECT id FROM placement_journal_operations WHERE principal_id=? AND project_id=? AND kind=? AND idempotency_key=?').get(manifest.principalId, manifest.projectId, manifest.kind, manifest.idempotencyKey) as { id: string } | undefined;
      if (row) {
        const op = this.readOperation(row.id);
        if (!equal({ ...op.manifest, operationId: '' }, { ...manifest, operationId: '' })) fail('IDEMPOTENCY_CONFLICT', 'Scoped key already binds different input');
        return op;
      }
      if (this.#db.prepare('SELECT 1 FROM placement_journal_operations WHERE id=?').get(manifest.operationId)) fail('IDEMPOTENCY_CONFLICT', 'Operation ID is already bound');
      const op: JournalOperation = { manifest, incarnationId: this.#incarnationId, revision: 0, state: 'queued', stage: 'queued', movements: manifest.movements.map(m => ({ movementId: m.movementId, intent: false, receipt: null })), verificationDigest: null, reason: null };
      // Reserve the largest receipt/terminal form before any syscall can run.
      encodeRecord({ ...op, revision: Number.MAX_SAFE_INTEGER, state: 'interrupted', stage: 'recovery-required', reason: 'x'.repeat(200), verificationDigest: 'a'.repeat(64), movements: manifest.movements.map(m => ({ movementId: m.movementId, intent: false, receipt: { source: 'absent', destination: m.expectedSource, verificationDigest: 'a'.repeat(64) } })) });
      this.#db.prepare('INSERT INTO placement_journal_operations VALUES (?,?,?,?,?,?,?)').run(manifest.operationId, manifest.principalId, manifest.projectId, manifest.kind, manifest.idempotencyKey, this.#incarnationId, encodeRecord(op));
      return this.readOperation(manifest.operationId);
    });
  }
  #change(operationId: string, revision: number, work: (op: JournalOperation) => boolean): JournalOperation {
    if (!Number.isSafeInteger(revision) || revision < 0) fail('VALIDATION_FAILED', 'Expected revision required');
    return this.#commit(() => {
      const op = this.readOperation(operationId); const changed = work(op);
      if (!changed) return op;
      if (op.revision !== revision || op.revision === Number.MAX_SAFE_INTEGER) fail('REVISION_CONFLICT', 'Operation changed; reread before transition');
      op.revision += 1;
      this.#db.prepare('UPDATE placement_journal_operations SET record_json=? WHERE id=?').run(encodeRecord(op), operationId);
      return this.readOperation(operationId);
    });
  }
  startOperation(operationId: string, revision: number): JournalOperation {
    return this.#change(operationId, revision, op => {
      if (op.state === 'running') return false;
      if (op.state !== 'queued' || op.incarnationId !== this.#incarnationId) fail('STATE_CONFLICT', 'Prior or terminal operations require authority-bearing reconciliation');
      op.state = 'running'; op.stage = 'running'; return true;
    });
  }
  recordMovementIntent(operationId: string, revision: number, movementId: string): { created: boolean; operation: JournalOperation } {
    let created = false;
    const operation = this.#change(operationId, revision, op => {
      const index = op.movements.findIndex(m => m.movementId === movementId); const entry = op.movements[index];
      if (!entry) return fail('VALIDATION_FAILED', 'Movement is outside the manifest');
      if (entry.intent) return false;
      if (op.state !== 'running' || op.incarnationId !== this.#incarnationId || op.movements.slice(0, index).some(m => !m.receipt)) fail('STATE_CONFLICT', 'Movement order/state changed or prior operation requires reconciliation');
      created = true; entry.intent = true; op.stage = 'movement-intent'; return true;
    });
    return { created, operation };
  }
  recordMovementReceipt(operationId: string, revision: number, movementId: string, receipt: MovementReceipt): JournalOperation {
    keys(receipt, ['source', 'destination', 'verificationDigest']);
    file(receipt.destination); hash(receipt.verificationDigest);
    return this.#change(operationId, revision, op => {
      const index = op.movements.findIndex(m => m.movementId === movementId); const entry = op.movements[index]; const move = op.manifest.movements[index];
      if (!entry?.intent || !move) return fail('STATE_CONFLICT', 'Durable movement intent is required');
      if (entry.receipt) { if (!equal(entry.receipt, receipt)) fail('IDENTITY_CONFLICT', 'Receipt cannot be replaced'); return false; }
      if (op.state !== 'running' || op.incarnationId !== this.#incarnationId || receipt.source !== 'absent' || !equal(receipt.destination, move.expectedSource)) fail('IDENTITY_CONFLICT', 'Fresh-operation receipt must verify source absence and exact moved object');
      entry.receipt = receipt; op.stage = 'movement-verified'; return true;
    });
  }
  completeOperation(operationId: string, revision: number, verificationDigest: string): JournalOperation {
    hash(verificationDigest);
    return this.#change(operationId, revision, op => {
      if (op.state === 'done') { if (op.verificationDigest !== verificationDigest) fail('IDENTITY_CONFLICT', 'Completion receipt changed'); return false; }
      if (op.state !== 'running' || op.incarnationId !== this.#incarnationId || !op.movements.every(m => m.receipt) || this.#launches().some(l => l.operationId === operationId && !l.drainDigest)) fail('RECOVERY_REQUIRED', 'Fresh operation, verified receipts and actual launch drainage required');
      op.state = 'done'; op.stage = 'complete'; op.verificationDigest = verificationDigest; return true;
    });
  }
  interruptOperation(operationId: string, revision: number, reason: string): JournalOperation { return this.#stop(operationId, revision, 'interrupted', reason); }
  failOperation(operationId: string, revision: number, reason: string): JournalOperation { return this.#stop(operationId, revision, 'failed', reason); }
  #stop(operationId: string, revision: number, state: 'interrupted' | 'failed', reason: string): JournalOperation {
    id(reason);
    return this.#change(operationId, revision, op => {
      if (op.state === state && op.reason === reason) return false;
      if (op.state !== 'queued' && op.state !== 'running') fail('STATE_CONFLICT', 'Terminal state cannot be replaced');
      op.state = state; op.reason = reason; op.stage = op.movements.some(m => m.intent) ? 'recovery-required' : 'failed'; return true;
    });
  }
  #launches(): JournalLaunch[] {
    this.#current();
    return (this.#db.prepare('SELECT id, incarnation_id, identity_key, record_json FROM placement_journal_launches ORDER BY id').all() as LaunchRow[]).map(decodeLaunch);
  }
  recordLaunchIntent(intent: LaunchIntent): { created: boolean; launch: JournalLaunch } {
    id(intent.launchId); hash(intent.intentDigest); if (!['child', 'helper'].includes(intent.kind) || !Array.isArray(intent.projectRoots) || intent.projectRoots.length > 256) fail('VALIDATION_FAILED', 'Bounded launch intent required');
    intent.projectRoots.forEach(canonical); if (intent.operationId !== undefined) id(intent.operationId);
    const normalized: LaunchIntent = { launchId: intent.launchId, kind: intent.kind, projectRoots: [...new Set(intent.projectRoots)].sort(), intentDigest: intent.intentDigest, ...(intent.operationId === undefined ? {} : { operationId: intent.operationId }) };
    return this.#commit(() => {
      const previous = this.#launches().find(l => l.launchId === intent.launchId);
      if (previous) {
        const { incarnationId: _i, identity: _p, spawnDigest: _s, exitDigest: _e, drainDigest: _d, ...prior } = previous;
        if (!equal(prior, normalized)) fail('IDEMPOTENCY_CONFLICT', 'Launch intent cannot be changed');
        return { created: false, launch: previous };
      }
      if (intent.operationId) {
        const op = this.readOperation(intent.operationId);
        if (op.state !== 'running' || op.incarnationId !== this.#incarnationId || !equal(normalized.projectRoots, [op.manifest.projectRoot])) fail('STATE_CONFLICT', 'Launch is outside its current active operation');
      }
      const launch: JournalLaunch = { ...normalized, incarnationId: this.#incarnationId, identity: null, spawnDigest: null, exitDigest: null, drainDigest: null };
      encodeRecord({ ...launch, identity: { pid: Number.MAX_SAFE_INTEGER, bootId: 'x'.repeat(200), startToken: 'x'.repeat(200), handshakeId: 'x'.repeat(200) }, spawnDigest: 'a'.repeat(64), exitDigest: 'a'.repeat(64), drainDigest: 'a'.repeat(64) });
      this.#db.prepare('INSERT INTO placement_journal_launches VALUES (?,?,NULL,?)').run(intent.launchId, this.#incarnationId, encodeRecord(launch));
      return { created: true, launch };
    });
  }
  #launchFact(launchId: string, identity: ProcessIdentity, evidenceDigest: string, fact: 'spawnDigest' | 'exitDigest' | 'drainDigest'): JournalLaunch {
    id(launchId); validateIdentity(identity); hash(evidenceDigest);
    return this.#commit(() => {
      const launches = this.#launches(); const l = launches.find(item => item.launchId === launchId);
      if (!l) return fail('NOT_FOUND', 'Durable launch intent required');
      if (l.identity && !equal(l.identity, identity)) fail('IDENTITY_CONFLICT', 'PID/identity substitution cannot establish drainage');
      if (l[fact]) { if (l[fact] !== evidenceDigest) fail('IDENTITY_CONFLICT', 'Observed fact is immutable'); return l; }
      if ((fact === 'exitDigest' && !l.spawnDigest) || (fact === 'drainDigest' && !l.exitDigest)) fail('RECOVERY_REQUIRED', 'Prior observed launch/exit fact required');
      if (fact === 'spawnDigest' && launches.some(other => other.launchId !== launchId && other.identity && processKey(other.identity) === processKey(identity))) fail('IDENTITY_CONFLICT', 'Observed process already belongs to another launch');
      l.identity = identity; l[fact] = evidenceDigest;
      this.#db.prepare('UPDATE placement_journal_launches SET identity_key=?, record_json=? WHERE id=?').run(processKey(identity), encodeRecord(l), launchId);
      return l;
    });
  }
  observeLaunch(launchId: string, identity: ProcessIdentity, evidenceDigest: string): JournalLaunch { return this.#launchFact(launchId, identity, evidenceDigest, 'spawnDigest'); }
  recordLaunchExit(launchId: string, identity: ProcessIdentity, evidenceDigest: string): JournalLaunch { return this.#launchFact(launchId, identity, evidenceDigest, 'exitDigest'); }
  recordLaunchDrain(launchId: string, identity: ProcessIdentity, evidenceDigest: string): JournalLaunch { return this.#launchFact(launchId, identity, evidenceDigest, 'drainDigest'); }

  /** Read-only facts, not authority to retry, compensate, restore or remove any object. */
  classifyRecovery(observations: readonly RecoveryObservation[]): JournalRecovery {
    if (this.#db.inTransaction) fail('DURABILITY_UNQUALIFIED', 'Recovery requires a committed independent read snapshot');
    return this.#db.transaction(() => this.#classify(observations))();
  }
  #classify(observations: readonly RecoveryObservation[]): JournalRecovery {
    const launches = this.#launches();
    const unresolvedLaunches = launches.filter(l => l.incarnationId !== this.#incarnationId && !l.drainDigest).map(l => l.launchId);
    if (unresolvedLaunches.length) return { global: 'blocked', unresolvedLaunches, operations: [] };
    const ids = (this.#db.prepare('SELECT id FROM placement_journal_operations WHERE incarnation_id<>? ORDER BY id').all(this.#incarnationId) as { id: string }[]).map(row => row.id);
    const operations = ids.map(operationId => {
      const op = this.readOperation(operationId); const provided = observations.filter(o => o.operationId === operationId);
      if (provided.length > 1) fail('VALIDATION_FAILED', 'Duplicate recovery observation');
      const readback = provided[0]; const partial = readback?.objects ?? [];
      const result: OperationRecovery = { operationId, projectRoot: op.manifest.projectRoot, revision: op.revision, state: op.state, disposition: 'recovery-required', partial };
      if (!op.movements.some(m => m.intent)) { if (!launches.some(l => l.operationId === operationId)) result.disposition = 'no-mutation'; return result; }
      if (!readback || readback.revision !== op.revision) return result;
      const expected = new Map<string, ObjectObservation>(), possible = new Map<string, NamedFile[]>();
      for (const [i, record] of op.movements.entries()) {
        if (!record.intent) continue;
        const move = op.manifest.movements[i]!;
        for (const location of [move.source, move.destination]) possible.set(location, [...(possible.get(location) ?? []), move.expectedSource]);
        if (record.receipt) { expected.set(move.source, { kind: 'absent' }); expected.set(move.destination, { kind: 'file', file: record.receipt.destination }); }
      }
      const actual = new Map<string, ObjectObservation>();
      for (const item of partial) {
        canonical(item.location);
        if (!possible.has(item.location) || actual.has(item.location) || !['absent', 'unknown', 'file'].includes(item.observation.kind)) fail('VALIDATION_FAILED', 'Observation is outside exact journal locations');
        if (item.observation.kind === 'file') file(item.observation.file); actual.set(item.location, item.observation);
      }
      const complete = op.movements.every(m => m.receipt); let unknown = false, conflict = false;
      for (const [location, choices] of possible) {
        const observed = actual.get(location);
        if (!observed || observed.kind === 'unknown') { unknown = true; continue; }
        if (complete) { if (!equal(observed, expected.get(location))) conflict = true; }
        else if (observed.kind === 'file' && !choices.some(choice => equal(choice, observed.file))) conflict = true;
      }
      if (conflict) result.disposition = 'conflict';
      else if (!unknown && complete && op.state === 'done') result.disposition = 'verified';
      return result;
    });
    return { global: 'clear', unresolvedLaunches: [], operations };
  }
  /** F3-compatible trusted reader. Current counters never resolve a prior launch. */
  readPreviousIncarnationRecovery(observations: readonly RecoveryObservation[]): { blockedProjectRoots: readonly string[] } {
    const report = this.classifyRecovery(observations);
    if (report.global !== 'clear') fail('RECOVERY_REQUIRED', 'Prior launch intent or actual process drainage is unresolved');
    return { blockedProjectRoots: [...new Set(report.operations.filter(op => op.state !== 'done' && (op.disposition === 'recovery-required' || op.disposition === 'conflict')).map(op => op.projectRoot))].sort() };
  }
}
