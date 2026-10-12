import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  MEDIA_SURFACES,
  mediaTaskInterruptReason,
  type MediaGalleryQuery,
  type MediaGalleryRequestRecord,
  type MediaLineageRelation,
  type MediaSurface,
  type MediaTaskLineage,
  type MediaTaskStatus,
} from '@open-design/contracts';

import { redactMediaErrorJson } from './redact.js';
import { normalizeMediaTaskError, type MediaTaskError } from './tasks.js';

/**
 * Durable media history: one row per media task, written when the task is
 * created and kept until its project is deleted.
 *
 * `media_tasks` is the live queue and deliberately forgets terminal rows an
 * hour after they end (the in-memory GC and the boot sweep both delete them).
 * The gallery, version chains and retry need the opposite: a record that
 * outlives the sweep and every restart. This table is that record. It mirrors
 * the task's status, output and error as they change, and carries what the
 * live row never did: lineage (root, parent, relation, attempt), the
 * idempotency key that created a retry, and the replayable request.
 *
 * Nothing secret is stored: the request is rebuilt from an allowlist of
 * generation fields (`sanitizeMediaRequestRecord`), so a stray `apiKey` or
 * header in a request body never reaches disk.
 */

export interface MediaLineageRow {
  taskId: string;
  projectId: string;
  sequence: number;
  rootTaskId: string;
  parentTaskId: string | null;
  parentProjectId: string | null;
  relation: MediaLineageRelation;
  attempt: number;
  idempotencyKey: string | null;
  idempotencyPrincipal: string | null;
  surface: MediaSurface | null;
  model: string | null;
  providerId: string | null;
  promptDigest: string | null;
  request: MediaGalleryRequestRecord | null;
  status: MediaTaskStatus;
  file: Record<string, unknown> | null;
  error: MediaTaskError | null;
  stub: boolean;
  unlinkedAt: number | null;
  createdAt: number;
  endedAt: number | null;
  updatedAt: number;
}

interface RawLineageRow {
  taskId: string;
  projectId: string;
  sequence: number;
  rootTaskId: string;
  parentTaskId: string | null;
  parentProjectId: string | null;
  relation: string;
  attempt: number;
  idempotencyKey: string | null;
  idempotencyPrincipal: string | null;
  surface: string | null;
  model: string | null;
  providerId: string | null;
  promptDigest: string | null;
  requestJson: string | null;
  status: string;
  fileJson: string | null;
  errorJson: string | null;
  stub: number;
  unlinkedAt: number | null;
  createdAt: number;
  endedAt: number | null;
  updatedAt: number;
}

const COLS = `
  task_id AS taskId,
  seq AS sequence,
  project_id AS projectId,
  root_task_id AS rootTaskId,
  parent_task_id AS parentTaskId,
  parent_project_id AS parentProjectId,
  relation,
  attempt,
  idempotency_key AS idempotencyKey,
  idempotency_principal AS idempotencyPrincipal,
  surface,
  model,
  provider_id AS providerId,
  prompt_digest AS promptDigest,
  request_json AS requestJson,
  status,
  file_json AS fileJson,
  error_json AS errorJson,
  stub,
  unlinked_at AS unlinkedAt,
  created_at AS createdAt,
  ended_at AS endedAt,
  updated_at AS updatedAt
`;

/** Called from `migrateMediaTasks`, so it runs wherever the task table does. */
export function migrateMediaTaskLineage(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS media_task_lineage (
      task_id TEXT PRIMARY KEY,
      -- Explicit, monotonic creation order for the gallery cursor. rowid is
      -- not used: VACUUM may renumber it, which would break a live cursor.
      seq INTEGER NOT NULL UNIQUE,
      project_id TEXT NOT NULL,
      root_task_id TEXT NOT NULL,
      parent_task_id TEXT,
      parent_project_id TEXT,
      relation TEXT NOT NULL CHECK (relation IN ('original','retry','edit','reuse')),
      attempt INTEGER NOT NULL DEFAULT 1,
      idempotency_key TEXT,
      -- Who used the key: the Workspace member, or 'local' without one. Keys
      -- are scoped per project and principal and expire after 30 days.
      idempotency_principal TEXT,
      surface TEXT,
      model TEXT,
      provider_id TEXT,
      prompt_digest TEXT,
      request_json TEXT,
      status TEXT NOT NULL CHECK (status IN
        ('queued','running','done','failed','interrupted')),
      file_json TEXT,
      error_json TEXT,
      stub INTEGER NOT NULL DEFAULT 0,
      unlinked_at INTEGER,
      created_at INTEGER NOT NULL,
      ended_at INTEGER,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_task_lineage_gallery
      ON media_task_lineage(project_id, created_at DESC, seq DESC);

    CREATE INDEX IF NOT EXISTS idx_media_task_lineage_root
      ON media_task_lineage(project_id, root_task_id);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_media_task_lineage_idempotency
      ON media_task_lineage(project_id, idempotency_principal, idempotency_key)
      WHERE idempotency_key IS NOT NULL;
  `);
  // Tasks that existed before this table get a history row too, so a gallery
  // opened right after the upgrade is not empty. They recorded no request,
  // so they are listed but never replayable.
  db.exec(`
    INSERT INTO media_task_lineage
      (task_id, seq, project_id, root_task_id, relation, attempt, surface, model,
       status, file_json, error_json, created_at, ended_at, updated_at)
    SELECT id,
           (SELECT COALESCE(MAX(seq), 0) FROM media_task_lineage)
             + ROW_NUMBER() OVER (ORDER BY created_at, rowid),
           project_id, id, 'original', 1, surface, model,
           status, file_json, error_json, created_at, ended_at, updated_at
      FROM media_tasks
     WHERE id NOT IN (SELECT task_id FROM media_task_lineage)
  `);
  redactStoredMediaErrors(db);
}

/**
 * At-rest redaction for rows an older build wrote verbatim. Idempotent: a row
 * is rewritten only when redaction changes it. Runs at every migration so a
 * database restored from an older backup is cleaned on its first boot too.
 */
export function redactStoredMediaErrors(db: Database.Database): number {
  let changed = 0;
  const tx = db.transaction(() => {
    for (const [table, idColumn] of [['media_tasks', 'id'], ['media_task_lineage', 'task_id']] as const) {
      const rows = db
        .prepare(`SELECT ${idColumn} AS id, error_json AS errorJson FROM ${table} WHERE error_json IS NOT NULL`)
        .all() as Array<{ id: string; errorJson: string }>;
      const update = db.prepare(`UPDATE ${table} SET error_json = ? WHERE ${idColumn} = ?`);
      for (const row of rows) {
        const redacted = redactMediaErrorJson(row.errorJson);
        if (redacted !== row.errorJson) {
          update.run(redacted, row.id);
          changed += 1;
        }
      }
    }
  });
  tx();
  return changed;
}

/** How long an idempotency key keeps answering with its first result. */
export const MEDIA_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Raised when an insert loses the race for an idempotency key. */
export class MediaIdempotencyKeyTakenError extends Error {
  constructor() {
    super('idempotency key already used');
    this.name = 'MediaIdempotencyKeyTakenError';
  }
}

export function mediaPromptDigest(prompt: unknown): string | null {
  return typeof prompt === 'string' && prompt.length > 0
    ? createHash('sha256').update(prompt).digest('hex')
    : null;
}

const MAX_TEXT_FIELD = 4096;
const MAX_REFERENCE_IMAGES = 16;

function boundedString(value: unknown, max = MAX_TEXT_FIELD): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The replayable part of a generate request, from an allowlist. Anything not
 * named here — credentials, headers, tokens, unknown fields — is dropped.
 * Returns null when the request cannot be replayed at all.
 */
export function sanitizeMediaRequestRecord(body: unknown): MediaGalleryRequestRecord | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const input = body as Record<string, unknown>;
  const surface = input.surface;
  if (typeof surface !== 'string' || !(MEDIA_SURFACES as readonly string[]).includes(surface)) return null;
  const model = boundedString(input.model, 256);
  if (!model) return null;
  const record: MediaGalleryRequestRecord = { surface: surface as MediaSurface, model };
  // The prompt is the one field kept whole: a retry must send what the user
  // wrote. The request body limit already bounds it.
  if (typeof input.prompt === 'string' && input.prompt.length > 0) record.prompt = input.prompt;
  const strings = ['output', 'aspect', 'quality', 'resolution', 'voice', 'audioKind', 'language', 'compositionDir', 'image'] as const;
  for (const key of strings) {
    const value = boundedString(input[key]);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ['length', 'duration', 'promptInfluence'] as const) {
    const value = finiteNumber(input[key]);
    if (value !== undefined) record[key] = value;
  }
  if (input.loop === true) record.loop = true;
  if (Array.isArray(input.images)) {
    const images = input.images
      .map((value) => boundedString(value))
      .filter((value): value is string => value !== undefined)
      .slice(0, MAX_REFERENCE_IMAGES);
    if (images.length > 0) record.images = images;
  }
  return record;
}

export interface RecordMediaLineageInput {
  taskId: string;
  projectId: string;
  status: MediaTaskStatus;
  createdAt: number;
  surface?: string | undefined;
  model?: string | undefined;
  providerId?: string | undefined;
  request: MediaGalleryRequestRecord | null;
  parent?: { taskId: string; relation: Exclude<MediaLineageRelation, 'original'> } | undefined;
  idempotencyKey?: string | undefined;
  /** Who used the key; defaults to the local principal. */
  idempotencyPrincipal?: string | undefined;
  /** For rows that start terminal (a reuse copy). */
  file?: Record<string, unknown> | null;
  endedAt?: number | null;
  promptDigest?: string | null;
  stub?: boolean;
}

export function recordMediaTaskLineage(
  db: Database.Database,
  input: RecordMediaLineageInput,
): MediaLineageRow {
  const parent = input.parent ? getMediaLineage(db, input.parent.taskId) : null;
  if (input.parent && !parent) {
    throw new Error(`media lineage parent not found: ${input.parent.taskId}`);
  }
  const relation: MediaLineageRelation = input.parent?.relation ?? 'original';
  // A reuse starts a new chain in its own project: the copy is an original
  // there, with a pointer back across the project boundary.
  const sameProjectChain = parent !== null && parent.projectId === input.projectId && relation !== 'reuse';
  const rootTaskId = sameProjectChain ? parent.rootTaskId : input.taskId;
  const attempt = relation === 'retry' && parent ? parent.attempt + 1 : 1;
  const surface = typeof input.surface === 'string' && (MEDIA_SURFACES as readonly string[]).includes(input.surface)
    ? input.surface
    : null;
  const now = Date.now();
  const insert = db.prepare(
    `INSERT INTO media_task_lineage
       (task_id, seq, project_id, root_task_id, parent_task_id, parent_project_id, relation,
        attempt, idempotency_key, idempotency_principal, surface, model, provider_id,
        prompt_digest, request_json, status, file_json, error_json, stub, created_at,
        ended_at, updated_at)
     VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 1 FROM media_task_lineage),
             ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
  );
  try {
    insert.run(
    input.taskId,
    input.projectId,
    rootTaskId,
    parent?.taskId ?? null,
    parent?.projectId ?? null,
    relation,
    attempt,
    input.idempotencyKey ?? null,
    input.idempotencyKey ? input.idempotencyPrincipal ?? MEDIA_LOCAL_PRINCIPAL : null,
    surface,
    input.model ?? null,
    input.providerId ?? null,
    input.promptDigest !== undefined ? input.promptDigest : mediaPromptDigest(input.request?.prompt),
    input.request ? JSON.stringify(input.request) : null,
    input.status,
    input.file ? JSON.stringify(input.file) : null,
    input.stub ? 1 : 0,
    input.createdAt,
    input.endedAt ?? null,
    now,
    );
  } catch (err) {
    if (
      input.idempotencyKey
      && (err as { code?: unknown })?.code === 'SQLITE_CONSTRAINT_UNIQUE'
      && String((err as Error).message).includes('idempotency')
    ) {
      throw new MediaIdempotencyKeyTakenError();
    }
    throw err;
  }
  const row = getMediaLineage(db, input.taskId);
  if (!row) throw new Error(`failed to read media lineage after insert: ${input.taskId}`);
  return row;
}

/** Whether a task's output came from the placeholder renderer. */
export function mediaOutputIsStub(file: unknown): boolean {
  if (!file || typeof file !== 'object') return false;
  const meta = file as Record<string, unknown>;
  return meta.usedStubFallback === true
    || meta.intentionalStub === true
    || (typeof meta.providerNote === 'string' && meta.providerNote.startsWith('[stub]'));
}

/**
 * Mirror a live task's state onto its history row. A no-op for a task that
 * has no history row. The provider id is taken from the output when the
 * dispatcher reports which renderer actually ran.
 */
export function syncMediaTaskLineage(
  db: Database.Database,
  task: {
    id: string;
    status: MediaTaskStatus;
    file: unknown;
    error: MediaTaskError | null;
    endedAt: number | null;
  },
): void {
  const file = task.file && typeof task.file === 'object' ? task.file as Record<string, unknown> : null;
  const providerId = typeof file?.providerId === 'string' && file.providerId ? file.providerId : null;
  db.prepare(
    `UPDATE media_task_lineage
        SET status = ?,
            file_json = ?,
            error_json = ?,
            ended_at = ?,
            provider_id = COALESCE(?, provider_id),
            stub = CASE WHEN ? THEN 1 ELSE stub END,
            updated_at = ?
      WHERE task_id = ?`,
  ).run(
    task.status,
    file ? JSON.stringify(file) : null,
    redactMediaErrorJson(task.error ? JSON.stringify(task.error) : null),
    task.endedAt,
    providerId,
    mediaOutputIsStub(file) ? 1 : 0,
    Date.now(),
    task.id,
  );
}

/** Boot reconciliation's half: history rows of tasks the restart abandoned. */
export function interruptOpenMediaLineage(
  db: Database.Database,
  error: MediaTaskError,
  now: number,
): number {
  return db
    .prepare(
      `UPDATE media_task_lineage
          SET status = 'interrupted',
              error_json = ?,
              ended_at = COALESCE(ended_at, ?),
              updated_at = ?
        WHERE status IN ('queued', 'running')`,
    )
    .run(JSON.stringify(error), now, now).changes;
}

export function getMediaLineage(db: Database.Database, taskId: string): MediaLineageRow | null {
  const raw = db
    .prepare(`SELECT ${COLS} FROM media_task_lineage WHERE task_id = ?`)
    .get(taskId) as RawLineageRow | undefined;
  return raw ? normalize(raw) : null;
}

/** The principal used when a request carries no Workspace member identity. */
export const MEDIA_LOCAL_PRINCIPAL = 'local';

/**
 * The live row a key already produced for this project and principal, or
 * null. Keys older than the TTL are released first, so an expired key is free
 * to start new work.
 */
export function findMediaLineageByIdempotencyKey(
  db: Database.Database,
  projectId: string,
  principal: string,
  key: string,
  now = Date.now(),
): MediaLineageRow | null {
  db.prepare(
    `UPDATE media_task_lineage
        SET idempotency_key = NULL, idempotency_principal = NULL
      WHERE idempotency_key IS NOT NULL AND created_at < ?`,
  ).run(now - MEDIA_IDEMPOTENCY_TTL_MS);
  const raw = db
    .prepare(
      `SELECT ${COLS} FROM media_task_lineage
        WHERE project_id = ? AND idempotency_principal = ? AND idempotency_key = ?`,
    )
    .get(projectId, principal, key) as RawLineageRow | undefined;
  return raw ? normalize(raw) : null;
}

/** Keyset cursor over (created_at DESC, seq DESC). Opaque to clients. */
export function encodeGalleryCursor(row: Pick<MediaLineageRow, 'createdAt' | 'sequence'>): string {
  return Buffer.from(`${row.createdAt}.${row.sequence}`, 'utf8').toString('base64url');
}

export function decodeGalleryCursor(cursor: string): { createdAt: number; sequence: number } | null {
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const match = /^(\d{1,16})\.(\d{1,16})$/.exec(decoded);
  if (!match) return null;
  return { createdAt: Number(match[1]), sequence: Number(match[2]) };
}

export class InvalidGalleryCursorError extends Error {
  constructor() {
    super('cursor is not one this daemon issued');
    this.name = 'InvalidGalleryCursorError';
  }
}

/**
 * One page of a project's history, newest first. Reads `limit + 1` rows to
 * learn whether another page exists; never more.
 */
export function listMediaGalleryPage(
  db: Database.Database,
  projectId: string,
  query: MediaGalleryQuery,
): { rows: MediaLineageRow[]; nextCursor: string | null } {
  const where: string[] = ['project_id = ?'];
  const params: Array<string | number> = [projectId];
  if (!query.includeUnlinked) where.push('unlinked_at IS NULL');
  if (query.kind) {
    where.push('surface = ?');
    params.push(query.kind);
  }
  if (query.status && query.status.length > 0) {
    where.push(`status IN (${query.status.map(() => '?').join(', ')})`);
    params.push(...query.status);
  }
  if (query.provider) {
    where.push('provider_id = ?');
    params.push(query.provider);
  }
  if (query.from !== undefined) {
    where.push('created_at >= ?');
    params.push(query.from);
  }
  if (query.to !== undefined) {
    where.push('created_at < ?');
    params.push(query.to);
  }
  if (query.cursor) {
    const cursor = decodeGalleryCursor(query.cursor);
    if (!cursor) throw new InvalidGalleryCursorError();
    where.push('(created_at < ? OR (created_at = ? AND seq < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.sequence);
  }
  const raw = db
    .prepare(
      `SELECT ${COLS}
         FROM media_task_lineage
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC, seq DESC
        LIMIT ?`,
    )
    .all(...params, query.limit + 1) as RawLineageRow[];
  const rows = raw.map(normalize);
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page.at(-1);
  return { rows: page, nextCursor: hasMore && last ? encodeGalleryCursor(last) : null };
}

/** Upper bound on one chain read; a chain is a handful of versions in practice. */
export const MEDIA_CHAIN_LIMIT = 100;

/** Every entry of `rootTaskId`'s chain inside one project, oldest first. */
export function listMediaLineageChain(
  db: Database.Database,
  projectId: string,
  rootTaskId: string,
): MediaLineageRow[] {
  const raw = db
    .prepare(
      `SELECT ${COLS}
         FROM media_task_lineage
        WHERE project_id = ? AND root_task_id = ?
        ORDER BY created_at ASC, seq ASC
        LIMIT ?`,
    )
    .all(projectId, rootTaskId, MEDIA_CHAIN_LIMIT) as RawLineageRow[];
  return raw.map(normalize);
}

/** Hide an entry from the default gallery. Never touches bytes. Idempotent. */
export function unlinkMediaLineage(
  db: Database.Database,
  projectId: string,
  taskId: string,
  now = Date.now(),
): boolean {
  return db
    .prepare(
      `UPDATE media_task_lineage
          SET unlinked_at = COALESCE(unlinked_at, ?), updated_at = ?
        WHERE project_id = ? AND task_id = ?`,
    )
    .run(now, now, projectId, taskId).changes > 0;
}

export function mediaLineageView(row: MediaLineageRow): MediaTaskLineage {
  return {
    rootId: row.rootTaskId,
    parentId: row.parentTaskId,
    relation: row.relation,
    attempt: row.attempt,
    parentInProject: row.parentTaskId === null || row.parentProjectId === row.projectId,
  };
}

export function mediaLineageInterruptReason(row: Pick<MediaLineageRow, 'status' | 'error'>) {
  return mediaTaskInterruptReason(row.status, row.error?.code);
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    const value = JSON.parse(json) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function normalize(raw: RawLineageRow): MediaLineageRow {
  const error = normalizeMediaTaskError(parseObject(raw.errorJson));
  return {
    taskId: raw.taskId,
    projectId: raw.projectId,
    sequence: Number(raw.sequence),
    rootTaskId: raw.rootTaskId,
    parentTaskId: raw.parentTaskId,
    parentProjectId: raw.parentProjectId,
    relation: raw.relation as MediaLineageRelation,
    attempt: Number(raw.attempt),
    idempotencyKey: raw.idempotencyKey,
    idempotencyPrincipal: raw.idempotencyPrincipal,
    surface: raw.surface && (MEDIA_SURFACES as readonly string[]).includes(raw.surface)
      ? raw.surface as MediaSurface
      : null,
    model: raw.model,
    providerId: raw.providerId,
    promptDigest: raw.promptDigest,
    request: sanitizeMediaRequestRecord(parseObject(raw.requestJson)),
    status: raw.status as MediaTaskStatus,
    file: parseObject(raw.fileJson),
    error,
    stub: Number(raw.stub) === 1,
    unlinkedAt: raw.unlinkedAt == null ? null : Number(raw.unlinkedAt),
    createdAt: Number(raw.createdAt),
    endedAt: raw.endedAt == null ? null : Number(raw.endedAt),
    updatedAt: Number(raw.updatedAt),
  };
}
