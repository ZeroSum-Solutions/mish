import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import path from 'node:path';
import { CATALOGUE_TARGET_ADAPTERS, RESOURCE_SOURCE_IDS, type CatalogueSavedUnit, type CatalogueTargetReport, type ResourceRef } from '@open-design/contracts';
import { ADOPTION_MAX_FILE_BYTES, readNamedRegularFile, writeExclusiveFile } from '../placement/adoption-files.js';
import { canonicalJson } from '../placement/adoption-plan.js';

/** One saved unit file: project bytes as they were when saved, relative to the unit's directory. */
export interface SavedUnitFile { path: string; role: 'source' | 'asset' | 'style'; bytes: Buffer }
/** The stored record. Bytes are inline (units are small and bounded); the identity is a digest of the whole record. */
export interface SavedUnitRecord {
  id: string;
  principalId: string;
  ref: ResourceRef;
  title: string;
  target?: CatalogueTargetReport['adapter'];
  sourceProjectId: string;
  sourceOperationId: string;
  files: SavedUnitFile[];
}
/** What listing returns: the index entry, never the bytes. */
export type SavedUnitMetadata = Omit<SavedUnitRecord, 'files'> & { files: { path: string; role: SavedUnitFile['role']; sha256: string; bytes: number }[] };

const SAVED_UNIT_SCHEMA = 'catalogue-saved-unit/1';
const INDEX_SCHEMA = 'catalogue-saved-unit-index/1';
const MAX_SAVED_UNIT_BYTES = 32 * 1024 * 1024;
/** Per-principal cap, below the 500-item wire limit of a saved-unit listing. */
export const SAVED_UNITS_PER_PRINCIPAL = 200;
const ID = /^[a-f0-9]{64}$/u;
const ROLES = ['source', 'asset', 'style'] as const;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

export class SavedUnitError extends Error {
  constructor(readonly reason: 'saved-unit-budget' | 'saved-unit-corrupt' | 'saved-unit-invalid' | 'saved-unit-limit', message: string) {
    super(message);
    this.name = 'SavedUnitError';
  }
}

/** Same lexical rules as the contract's project-relative path. */
function validPath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 1000 && !/[\p{Cc}\p{Cf}\\]/u.test(value)
    && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value) && value.split('/').every(part => part !== '' && part !== '.' && part !== '..');
}
function validRef(value: unknown): value is ResourceRef {
  if (!value || typeof value !== 'object') return false;
  const ref = value as Record<string, unknown>;
  return ['library', 'plugin', 'section', 'genui', 'font', 'skill', 'reference'].includes(ref.sourceType as string)
    && (RESOURCE_SOURCE_IDS as readonly unknown[]).includes(ref.sourceId)
    && typeof ref.itemId === 'string' && ref.itemId.length > 0 && typeof ref.revisionOrDigest === 'string' && ref.revisionOrDigest.length > 0;
}
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u.test(value);

/** The stored body, digested whole: the ID covers principal, reference, source project and every byte. */
function bodyOf(input: Omit<SavedUnitRecord, 'id'>) {
  return {
    schema: SAVED_UNIT_SCHEMA, principalId: input.principalId, ref: input.ref, title: input.title, target: input.target ?? null,
    sourceProjectId: input.sourceProjectId, sourceOperationId: input.sourceOperationId,
    files: input.files.map(file => ({ path: file.path, role: file.role, sha256: sha256(file.bytes), contentBase64: file.bytes.toString('base64') })),
  };
}
const idOf = (body: ReturnType<typeof bodyOf>) => sha256(canonicalJson(body));

function assertValid(input: Omit<SavedUnitRecord, 'id'>): void {
  const ok = identifier(input.principalId) && validRef(input.ref) && typeof input.title === 'string' && input.title.length > 0 && input.title.length <= 200
    && identifier(input.sourceProjectId) && identifier(input.sourceOperationId)
    && (input.target === undefined || (CATALOGUE_TARGET_ADAPTERS as readonly string[]).includes(input.target))
    && input.files.length > 0 && input.files.length <= 256
    && input.files.every(file => validPath(file.path) && (ROLES as readonly string[]).includes(file.role) && Buffer.isBuffer(file.bytes))
    && new Set(input.files.map(file => file.path)).size === input.files.length;
  if (!ok) throw new SavedUnitError('saved-unit-invalid', 'Saved unit identity, path or role breaks the contract');
}

const metadataOf = (record: SavedUnitRecord): SavedUnitMetadata => ({
  ...record, files: record.files.map(file => ({ path: file.path, role: file.role, sha256: sha256(file.bytes), bytes: file.bytes.length })),
});

/**
 * W4 (AC-R08.5 save and reuse): private, principal-scoped saved units under an
 * explicit root inside the adoption work root (daemon data, per the root data
 * directory contract).
 *
 * - A record's ID is the digest of the whole stored body (principal, reference,
 *   source project and operation, every file). Reading recomputes it exactly
 *   as save derives it and validates every path and role, so swapped bytes, a
 *   relabelled principal or a moved source project are refused as corrupt.
 * - Each principal has a capped count (`saved-unit-limit`) and a metadata
 *   index; listing reads only that index, never record bytes or another
 *   principal's records.
 * - Records and indexes are written to a private temporary and renamed into
 *   place, so a concurrent reader sees either nothing or the whole file.
 */
export class CatalogueSavedUnitStore {
  readonly #root: string;
  readonly #max: number;
  constructor(root: string, options: { maxPerPrincipal?: number } = {}) {
    if (!path.isAbsolute(root) || path.resolve(root) !== root) throw new Error('Explicit canonical saved-unit root required');
    this.#root = root;
    this.#max = options.maxPerPrincipal ?? SAVED_UNITS_PER_PRINCIPAL;
  }

  save(input: Omit<SavedUnitRecord, 'id'>): SavedUnitRecord {
    assertValid(input);
    const total = input.files.reduce((sum, file) => sum + file.bytes.length, 0);
    if (total > MAX_SAVED_UNIT_BYTES) throw new SavedUnitError('saved-unit-budget', 'A saved unit is limited to 32 MiB');
    const body = bodyOf(input);
    const id = idOf(body);
    // Sol B5/6 WARN: the record is base64 inside JSON, so its encoded size (not the raw bytes) must fit what read() accepts.
    const encoded = Buffer.from(JSON.stringify({ ...body, id }));
    if (encoded.length > ADOPTION_MAX_FILE_BYTES) throw new SavedUnitError('saved-unit-budget', `A saved unit's stored record is limited to 32 MiB (about 24 MiB of unit files); this one would be ${Math.ceil(encoded.length / (1024 * 1024))} MiB`);
    const index = this.#readIndex(input.principalId);
    if (!index.some(entry => entry.id === id)) {
      if (index.length >= this.#max) throw new SavedUnitError('saved-unit-limit', `A principal can keep at most ${this.#max} saved units; remove one first with \`od workbench adoption catalogue-saved delete <id>\` (or Remove saved unit in the canvas Apply panel), then save again`);
      if (readNamedRegularFile(this.#recordPath(id)).kind === 'absent') this.#publish(this.#recordPath(id), encoded);
    }
    const record = this.read(input.principalId, id);
    if (!record) throw new SavedUnitError('saved-unit-corrupt', 'Saved unit could not be read back');
    if (!index.some(entry => entry.id === id)) this.#writeIndex(input.principalId, [...index, metadataOf(record)]);
    return record;
  }

  /** The principal's record, or null when it does not exist or belongs to someone else. A damaged record is refused. */
  read(principalId: string, id: string): SavedUnitRecord | null {
    if (!ID.test(id)) return null;
    const found = readNamedRegularFile(this.#recordPath(id));
    if (found.kind === 'absent') return null;
    const corrupt = (detail: string) => new SavedUnitError('saved-unit-corrupt', `Saved unit failed verification: ${detail}`);
    if (found.kind !== 'file') throw corrupt('not one regular file');
    let value: Record<string, unknown>;
    try { value = JSON.parse(found.bytes.toString('utf8')) as Record<string, unknown>; } catch { throw corrupt('not JSON'); }
    if (value.schema !== SAVED_UNIT_SCHEMA || value.id !== id || !Array.isArray(value.files)) throw corrupt('unexpected shape');
    let record: SavedUnitRecord;
    try {
      const files = (value.files as { path: string; role: SavedUnitFile['role']; sha256: string; contentBase64: string }[]).map(file => {
        if (typeof file.contentBase64 !== 'string') throw new Error('bytes');
        return { path: file.path, role: file.role, bytes: Buffer.from(file.contentBase64, 'base64') };
      });
      record = {
        id, principalId: value.principalId as string, ref: value.ref as ResourceRef, title: value.title as string,
        ...(value.target ? { target: value.target as CatalogueTargetReport['adapter'] } : {}),
        sourceProjectId: value.sourceProjectId as string, sourceOperationId: value.sourceOperationId as string, files,
      };
      assertValid(record);
    } catch { throw corrupt('invalid identity, path or role'); }
    const recomputed = bodyOf(record);
    if (idOf(recomputed) !== id || canonicalJson(recomputed.files.map(file => file.sha256)) !== canonicalJson((value.files as { sha256: unknown }[]).map(file => file.sha256))) {
      throw corrupt('content digest does not match its identity');
    }
    return record.principalId === principalId ? record : null;
  }

  /**
   * Sol B5/6: removes one of the principal's own saved units. Ownership is the
   * principal's own index (another principal's ID is simply not there, so
   * nothing changes and the answer is false). The index is republished
   * without the entry first (an atomic rename), then the record file is
   * removed; a crash between the two leaves an unlisted record, never a
   * listed unit without bytes.
   */
  remove(principalId: string, id: string): boolean {
    if (!ID.test(id)) return false;
    const index = this.#readIndex(principalId);
    if (!index.some(entry => entry.id === id)) return false;
    this.#writeIndex(principalId, index.filter(entry => entry.id !== id));
    rmSync(this.#recordPath(id), { force: true });
    return true;
  }

  /** The principal's saved units from its own metadata index, optionally for one resource identity. */
  list(principalId: string, filter?: Pick<ResourceRef, 'sourceId' | 'itemId'>): SavedUnitMetadata[] {
    return this.#readIndex(principalId).filter(entry => !filter || (entry.ref.sourceId === filter.sourceId && entry.ref.itemId === filter.itemId));
  }

  #recordPath(id: string): string { return path.join(this.#root, `${id}.json`); }
  #indexPath(principalId: string): string { return path.join(this.#root, 'index', `${sha256(principalId)}.json`); }

  #readIndex(principalId: string): SavedUnitMetadata[] {
    const found = readNamedRegularFile(this.#indexPath(principalId));
    if (found.kind === 'absent') return [];
    if (found.kind !== 'file') throw new SavedUnitError('saved-unit-corrupt', 'Saved-unit index is not one regular file');
    try {
      const value = JSON.parse(found.bytes.toString('utf8')) as { schema?: unknown; principalId?: unknown; entries?: unknown };
      if (value.schema !== INDEX_SCHEMA || value.principalId !== principalId || !Array.isArray(value.entries)) throw new Error('shape');
      return value.entries as SavedUnitMetadata[];
    } catch { throw new SavedUnitError('saved-unit-corrupt', 'Saved-unit index failed verification'); }
  }

  #writeIndex(principalId: string, entries: SavedUnitMetadata[]): void {
    this.#publish(this.#indexPath(principalId), Buffer.from(JSON.stringify({ schema: INDEX_SCHEMA, principalId, entries })));
  }

  /** Writes a private temporary in the same directory and renames it into place: readers never see a partial file. */
  #publish(location: string, bytes: Buffer): void {
    const dir = path.dirname(location);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temporary = path.join(dir, `.incoming-${randomUUID()}`);
    writeExclusiveFile(temporary, bytes);
    renameSync(temporary, location);
  }
}

/** The wire view: identity and file digests, never the bytes. */
export function savedUnitView(unit: SavedUnitRecord | SavedUnitMetadata, refKey: string): CatalogueSavedUnit {
  return {
    id: unit.id, refKey, title: unit.title, ...(unit.target ? { target: unit.target } : {}),
    sourceProjectId: unit.sourceProjectId, sourceOperationId: unit.sourceOperationId,
    files: unit.files.map(file => ({ path: file.path, role: file.role, sha256: 'sha256' in file ? file.sha256 : sha256(file.bytes), bytes: typeof file.bytes === 'number' ? file.bytes : file.bytes.length })),
  };
}
