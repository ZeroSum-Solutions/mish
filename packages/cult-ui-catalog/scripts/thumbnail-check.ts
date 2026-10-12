/**
 * The contract of `generated/thumbnails.json` and `generated/thumbnails/`: the Catalog tab
 * thumbnails for every row that has no converter preview (`previewId` null).
 *
 * A row with a `previewId` keeps its converter preview (`generated/previews/`, owned by
 * scripts/adapters.ts). Every other row has exactly one manifest entry: a rendered thumbnail
 * (`file`), a thumbnail it shares with its demo row (`file` + `via`), or a neutral placeholder with
 * the reason it has no image (`placeholder`). Pure: `scripts/thumbnails.ts --check` and the tests
 * call it; it needs no source kit.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import type { CultCatalog } from '../src/types.ts';

export const THUMBNAIL_SCHEMA = 'cult-thumbnails/1';
/** Per-file cap. The target is well under it; the check fails any file above it. */
export const THUMBNAIL_BYTE_LIMIT = 20 * 1024;
/** Whole-directory cap for `generated/thumbnails/`. */
export const THUMBNAIL_TOTAL_BYTE_LIMIT = 4 * 1024 * 1024;
/** Thumbnail file names: the row name plus `.webp`, nothing a path could escape through. */
export const THUMBNAIL_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.webp$/;

export const THUMBNAIL_SOURCES = ['converter-source', 'converted-preview', 'page-render', 'client-render', 'demo'] as const;
export type ThumbnailSource = (typeof THUMBNAIL_SOURCES)[number];

export type ThumbnailEntry =
  | { file: string; source: Exclude<ThumbnailSource, 'demo'>; bytes: number }
  | { file: string; source: 'demo'; via: string }
  | { placeholder: string };

export interface ThumbnailManifest {
  schema: typeof THUMBNAIL_SCHEMA;
  byteLimit: number;
  items: Record<string, ThumbnailEntry>;
}

export interface ThumbnailCheckResult {
  errors: string[];
  files: number;
  bytes: number;
  placeholders: number;
  shared: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Structural issues of a parsed manifest (empty when it is a valid `ThumbnailManifest`). */
export function manifestIssues(raw: unknown): string[] {
  if (!isObject(raw)) return ['manifest must be an object'];
  const errors: string[] = [];
  if (raw.schema !== THUMBNAIL_SCHEMA) errors.push(`schema must be "${THUMBNAIL_SCHEMA}"`);
  if (raw.byteLimit !== THUMBNAIL_BYTE_LIMIT) errors.push(`byteLimit must be ${THUMBNAIL_BYTE_LIMIT}`);
  if (!isObject(raw.items)) return [...errors, 'items must be an object'];
  for (const [id, entry] of Object.entries(raw.items)) {
    if (!isObject(entry)) { errors.push(`${id}: entry must be an object`); continue; }
    if ('placeholder' in entry) {
      if (typeof entry.placeholder !== 'string' || entry.placeholder.trim() === '') errors.push(`${id}: placeholder needs a reason`);
      if ('file' in entry) errors.push(`${id}: a placeholder has no file`);
      continue;
    }
    if (typeof entry.file !== 'string' || !THUMBNAIL_FILE_PATTERN.test(entry.file)) errors.push(`${id}: file must match ${THUMBNAIL_FILE_PATTERN}`);
    if (!THUMBNAIL_SOURCES.includes(entry.source as ThumbnailSource)) errors.push(`${id}: unknown source ${String(entry.source)}`);
    if (entry.source === 'demo' && typeof entry.via !== 'string') errors.push(`${id}: a demo thumbnail names the row it comes from (via)`);
    if (entry.source !== 'demo' && typeof entry.bytes !== 'number') errors.push(`${id}: bytes must be a number`);
  }
  return errors;
}

/**
 * Check the manifest against catalog.json and the files on disk: one entry per row without a
 * `previewId` and none for any other row, every file present, named by its own row (or shared
 * from the row named by `via`), inside the byte limits, and no file that no entry names.
 */
export function checkThumbnails(catalog: CultCatalog, manifest: unknown, thumbnailsDir: string): ThumbnailCheckResult {
  const result: ThumbnailCheckResult = { errors: manifestIssues(manifest), files: 0, bytes: 0, placeholders: 0, shared: 0 };
  if (result.errors.length > 0) return result;
  const items = (manifest as ThumbnailManifest).items;
  const rows = new Map(catalog.rows.map((row) => [row.id, row]));
  for (const row of catalog.rows) {
    if (row.previewId === null && !Object.hasOwn(items, row.id)) result.errors.push(`${row.id}: no thumbnail entry (render it or record a placeholder reason)`);
  }
  const named = new Set<string>();
  for (const [id, entry] of Object.entries(items)) {
    const row = rows.get(id);
    if (!row) { result.errors.push(`${id}: not a catalog row`); continue; }
    if (row.previewId !== null) { result.errors.push(`${id}: has a converter preview (${row.previewId}); it needs no thumbnail`); continue; }
    if ('placeholder' in entry) { result.placeholders += 1; continue; }
    if (entry.source === 'demo') {
      result.shared += 1;
      const from = items[entry.via];
      if (!from || !('file' in from) || from.file !== entry.file || from.source === 'demo') result.errors.push(`${id}: via ${entry.via} does not own ${entry.file}`);
      continue;
    }
    if (entry.file !== `${row.name}.webp`) result.errors.push(`${id}: file ${entry.file} is not named by the row (${row.name}.webp)`);
    named.add(entry.file);
    const file = join(thumbnailsDir, entry.file);
    if (!existsSync(file)) { result.errors.push(`${id}: ${entry.file} is missing`); continue; }
    const size = statSync(file).size;
    if (size !== entry.bytes) result.errors.push(`${id}: ${entry.file} is ${size} B, the manifest says ${entry.bytes} B`);
    if (size > THUMBNAIL_BYTE_LIMIT) result.errors.push(`${id}: ${entry.file} is ${size} B, over the ${THUMBNAIL_BYTE_LIMIT} B limit`);
    result.files += 1;
    result.bytes += size;
  }
  const onDisk = existsSync(thumbnailsDir) ? readdirSync(thumbnailsDir) : [];
  for (const file of onDisk) if (!named.has(file)) result.errors.push(`generated/thumbnails/${file} belongs to no manifest entry`);
  if (result.bytes > THUMBNAIL_TOTAL_BYTE_LIMIT) result.errors.push(`thumbnails total ${result.bytes} B, over the ${THUMBNAIL_TOTAL_BYTE_LIMIT} B budget`);
  return result;
}
