import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  OWNED_IMPORT_LIMITS, PLACEHOLDER_KINDS, parseOwnedImportRecord, parseOwnedImportRequest,
  type OwnedImportRecord, type ResourceCandidate, type ResourceRef, type ResourceRequestContext,
} from '@open-design/contracts';
import type { CatalogueMaterial, CatalogueMaterialSource } from '../adoption/catalogue-material.js';
import type { ResourceSourceAdapter } from '../resources.js';

/**
 * AC-R12.4 (Q7 A): owner-provided Magic Patterns exports imported from local files.
 * No provider account, MCP or generation is touched. The record binds exact file and
 * artifact hashes and labels placeholder data/actions; bytes live in the daemon's own
 * SQLite database (under the resolved data root). Imports are private to the
 * importing principal. Apply, second-project reuse and undo go through the existing
 * catalogue adoption preparer and executor; nothing here writes project files.
 */
export class OwnedImportError extends Error {
  constructor(readonly status: 400 | 404 | 413, readonly code: string, message: string) { super(message); this.name = 'OwnedImportError'; }
}
type Db = Database.Database;
type Placeholder = OwnedImportRecord['placeholders'][number];

const TERMS_VERSION = '2025-04-01';
const TERMS_EVIDENCE = 'docs/plans/2026-10-02-design-workbench/evidence/aisdkagents-magicpatterns-audit.md';
const PROVIDER_URL = 'https://www.magicpatterns.com';
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const TEXT_EXTENSIONS = new Set(['.html', '.htm', '.css', '.scss', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.svg', '.txt']);
const STYLE_EXTENSIONS = new Set(['.css', '.scss', '.less']);
const SOURCE_EXTENSIONS = new Set(['.html', '.htm', '.js', '.mjs', '.jsx', '.ts', '.tsx', '.json', '.md', '.txt', '.vue', '.svelte']);
const role = (file: string): 'source' | 'asset' | 'style' => {
  const extension = path.posix.extname(file).toLowerCase();
  return STYLE_EXTENSIONS.has(extension) ? 'style' : SOURCE_EXTENSIONS.has(extension) ? 'source' : 'asset';
};

/** One rule set per kind; a line contributes at most one label per kind. Labels describe, never edit. */
const PLACEHOLDER_RULES: Record<(typeof PLACEHOLDER_KINDS)[number], RegExp[]> = {
  'placeholder-link': [/href\s*=\s*["']\s*(?:#[^"']*)?["']/iu, /javascript:\s*void/iu],
  'placeholder-action': [/\balert\s*\(/u, /console\.log\s*\(/u, /on[Cc]lick\s*=\s*\{\s*\(\s*\)\s*=>\s*\{\s*\}\s*\}/u, /action\s*=\s*["']\s*["']/iu, /\bTODO\b/u],
  'placeholder-text': [/lorem ipsum/iu, /\bexample\.(?:com|org)\b/iu, /\b(?:john|jane) doe\b/iu, /\b555-\d{4}\b/u, /\byour company\b/iu],
  'placeholder-media': [/via\.placeholder\.com/iu, /placehold\.co/iu, /picsum\.photos/iu, /placeholder\.(?:svg|png|jpg)/iu, /source\.unsplash\.com/iu],
};
export function detectPlaceholders(file: string, bytes: Buffer): Placeholder[] {
  if (!TEXT_EXTENSIONS.has(path.posix.extname(file).toLowerCase())) return [];
  const found: Placeholder[] = [];
  bytes.toString('utf8').split(/\r?\n/u).forEach((line, index) => {
    for (const kind of PLACEHOLDER_KINDS) {
      if (!PLACEHOLDER_RULES[kind].some(rule => rule.test(line))) continue;
      const excerpt = line.replace(/[\p{Cc}\p{Cf}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 160);
      if (excerpt) found.push({ path: file, line: index + 1, kind, excerpt });
    }
  });
  return found;
}

/** Called by the existing database migration owner. */
export function migrateOwnedImports(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS workbench_owned_imports (
    id TEXT PRIMARY KEY,
    principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK(json_valid(record_json))
  );
  CREATE INDEX IF NOT EXISTS workbench_owned_imports_principal ON workbench_owned_imports(principal_id, created_at);
  CREATE TABLE IF NOT EXISTS workbench_owned_import_files (
    import_id TEXT NOT NULL REFERENCES workbench_owned_imports(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    bytes BLOB NOT NULL,
    PRIMARY KEY(import_id, path)
  );`);
}

/** Resource search principals (`local-daemon`, `workspace:<ws>:<member>`) as adoption principals. */
export function importPrincipal(context: ResourceRequestContext): string {
  if (context.principalId === 'local-daemon') return 'local-owner';
  const member = /^workspace:[^:]+:(.+)$/u.exec(context.principalId)?.[1];
  return member ? `member:${member}` : context.principalId;
}

export class OwnedImportStore {
  readonly #db: Db;
  constructor(db: Db) { this.#db = db; }

  create(principalId: string, input: unknown, now = new Date()): OwnedImportRecord {
    let request;
    try { request = parseOwnedImportRequest(input); } catch { throw new OwnedImportError(400, 'owned-import-invalid', 'Invalid import: provider, name, entry and normalized relative file paths are required'); }
    const files = request.files.map(file => {
      const bytes = Buffer.from(file.contentBase64, 'base64');
      if (bytes.toString('base64').replace(/=+$/u, '') !== file.contentBase64.replace(/=+$/u, '')) throw new OwnedImportError(400, 'owned-import-invalid', `File ${file.path} is not canonical base64`);
      return { path: file.path, bytes, sha256: sha256(bytes) };
    }).sort((a, b) => a.path.localeCompare(b.path, 'en'));
    if (files.reduce((total, file) => total + file.bytes.length, 0) > OWNED_IMPORT_LIMITS.bytes) throw new OwnedImportError(413, 'owned-import-too-large', 'Import exceeds the 4 MiB limit');
    const artifactSha256 = sha256(JSON.stringify(files.map(file => [file.path, file.sha256])));
    const record = parseOwnedImportRecord({
      schema: 'owned-import/1', id: `import-${randomBytes(8).toString('hex')}`, revision: 1,
      provider: request.provider, name: request.name, principalId, entryPath: request.entryPath, artifactSha256,
      files: files.map(file => ({ path: file.path, sha256: file.sha256, bytes: file.bytes.length, role: role(file.path) })),
      placeholders: files.flatMap(file => detectPlaceholders(file.path, file.bytes)).slice(0, 500),
      provenance: {
        origin: 'owned', acquisition: 'owner-provided-local-file', declaration: request.ownership.declaration, exportedFrom: request.ownership.exportedFrom,
        providerAccountUsed: false, providerMcpUsed: false, termsVersion: TERMS_VERSION, evidenceRef: TERMS_EVIDENCE,
      },
      createdAt: now.toISOString(),
    });
    this.#db.transaction(() => {
      this.#db.prepare('INSERT INTO workbench_owned_imports (id, principal_id, created_at, record_json) VALUES (?, ?, ?, ?)').run(record.id, principalId, record.createdAt, JSON.stringify(record));
      const insert = this.#db.prepare('INSERT INTO workbench_owned_import_files (import_id, path, sha256, bytes) VALUES (?, ?, ?, ?)');
      for (const file of files) insert.run(record.id, file.path, file.sha256, file.bytes);
    })();
    return record;
  }

  list(principalId: string): OwnedImportRecord[] {
    const rows = this.#db.prepare('SELECT record_json FROM workbench_owned_imports WHERE principal_id = ? ORDER BY created_at, id').all(principalId) as { record_json: string }[];
    return rows.map(row => parseOwnedImportRecord(JSON.parse(row.record_json)));
  }

  /** The principal's own record, or null. Another principal's import is indistinguishable from a missing one. */
  find(principalId: string, id: string): OwnedImportRecord | null {
    const row = this.#db.prepare('SELECT record_json FROM workbench_owned_imports WHERE id = ? AND principal_id = ?').get(id, principalId) as { record_json: string } | undefined;
    return row ? parseOwnedImportRecord(JSON.parse(row.record_json)) : null;
  }
  read(principalId: string, id: string): OwnedImportRecord {
    const record = this.find(principalId, id);
    if (!record) throw new OwnedImportError(404, 'owned-import-unknown', 'Import not found');
    return record;
  }

  /** Stored bytes, re-verified against the record digest before they leave the store. */
  files(principalId: string, id: string): { record: OwnedImportRecord; files: { path: string; bytes: Buffer }[] } {
    const record = this.read(principalId, id);
    const rows = this.#db.prepare('SELECT path, sha256, bytes FROM workbench_owned_import_files WHERE import_id = ? ORDER BY path').all(id) as { path: string; sha256: string; bytes: Buffer }[];
    const files = rows.map(row => ({ path: row.path, bytes: Buffer.from(row.bytes) }));
    const intact = files.length === record.files.length && files.every((file, index) => file.path === record.files[index]!.path && sha256(file.bytes) === record.files[index]!.sha256);
    if (!intact) throw new OwnedImportError(404, 'owned-import-unknown', 'Import bytes failed verification');
    return { record, files };
  }
  file(principalId: string, id: string, file: string): Buffer {
    const found = this.files(principalId, id).files.find(entry => entry.path === file);
    if (!found) throw new OwnedImportError(404, 'owned-import-unknown', 'File not found in this import');
    return found.bytes;
  }
}

const ownedRef = (record: OwnedImportRecord): ResourceRef => ({ sourceType: 'library', sourceId: 'magic-patterns', itemId: record.id, revisionOrDigest: `sha256:${record.artifactSha256}` });

function notice(record: OwnedImportRecord): string {
  return [
    `Owner-provided ${record.provider} export "${record.name}", imported from local files.`,
    `Artifact SHA-256: ${record.artifactSha256}`,
    `Creator owns the output under Magic Patterns terms ${record.provenance.termsVersion}; no provider account, MCP or generation was used.`,
    ...record.files.map(file => `- ${file.path} sha256:${file.sha256}`),
    '',
    record.placeholders.length ? 'Placeholder data and actions to replace before shipping:' : 'No placeholder data or actions were detected.',
    ...record.placeholders.map(item => `- ${item.kind} ${item.path}:${item.line} ${item.excerpt}`),
  ].join('\n');
}

/** Catalogue material for apply/second-project reuse: the principal's own record only. */
export function createOwnedImportMaterials(store: OwnedImportStore): CatalogueMaterialSource {
  return {
    sourceId: 'magic-patterns',
    async materialize(itemId, context): Promise<CatalogueMaterial | null> {
      if (!context) return null;
      let stored;
      try { stored = store.files(context.principalId, itemId); } catch { return null; }
      const { record, files } = stored;
      return {
        ref: ownedRef(record), title: record.name, origin: 'owned',
        rights: {
          status: 'permitted', licence: `Owner-provided export; creator owns output (Magic Patterns terms ${record.provenance.termsVersion})`,
          notice: notice(record), sourceUrl: record.provenance.exportedFrom ?? PROVIDER_URL, packageName: 'magic-patterns-export',
        },
        files: files.map(file => ({ path: file.path, role: role(file.path), bytes: file.bytes })),
        packageDependencies: [],
      };
    },
  };
}

/** Workbench search/inspect rows for the requesting principal's imports. */
export function createOwnedImportResourceSource(store: OwnedImportStore, options: { previewBase?: string } = {}): ResourceSourceAdapter {
  return {
    sourceId: 'magic-patterns',
    async list(context) {
      const items: ResourceCandidate[] = store.list(importPrincipal(context)).map(record => {
        const html = ['.html', '.htm'].includes(path.posix.extname(record.entryPath).toLowerCase());
        const placeholders = record.placeholders.length;
        return {
          ref: ownedRef(record), title: record.name, category: 'template', readiness: 'unverified',
          compatibility: { nativeFormat: html ? 'html' : path.posix.extname(record.entryPath).slice(1) || 'unknown', targets: html ? ['html'] : [], state: 'unverified', reason: 'Owned import; per-item acceptance receipt pending' },
          rightsStatus: 'permitted',
          fitReasons: [
            `Owner-provided ${record.provider} export, ${record.files.length} files, artifact sha256:${record.artifactSha256.slice(0, 12)}`,
            placeholders ? `${placeholders} placeholder data/action labels to replace` : 'No placeholder data or actions detected',
          ],
          previewCapability: html
            ? { available: true, kind: 'html', url: `${options.previewBase ?? '/api/workbench/imports'}/${record.id}/files/${record.entryPath.split('/').map(encodeURIComponent).join('/')}`, reason: null }
            : { available: false, kind: 'none', reason: 'No HTML entry to preview' },
          adoptionCapability: { available: false, reason: 'acceptance-receipt-pending' },
          sourceAttribution: { title: `${record.name} (owner-provided)` },
          implementationOrigin: 'owned',
          operationGrants: [
            { operation: 'incorporation', state: 'permitted', reason: null },
            { operation: 'private-save', state: 'permitted', reason: null },
            { operation: 'private-reuse', state: 'permitted', reason: null },
            { operation: 'redistribution', state: 'unknown', reason: 'Public redistribution is a separate operation; not assessed' },
          ],
          admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Owner-provided import (Q7 A); project need is decided at apply',
        };
      });
      const digest = sha256(JSON.stringify(items.map(item => [item.ref.itemId, item.ref.revisionOrDigest])));
      return { items, status: { sourceId: 'magic-patterns', state: 'searched', reason: null, itemCount: items.length, listingDigest: digest } };
    },
  };
}
