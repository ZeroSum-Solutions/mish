/**
 * Catalog tab preview images for the 21st.dev library rows (`generated/21st-items.json`,
 * scripts/twenty-first.ts, PRD Addendum 3 / G13). Rendering or storing a 21st.dev item's SOURCE is
 * not allowed here (19 of 22 rows are `reference-only`; see scripts/twenty-first.ts's docblock) —
 * this never reads a registry/<item>.json's `componentCode` or `demoCode`. The only thing this
 * writes is the preview IMAGE 21st.dev itself already publishes for the item, on its own public
 * CDN (`cdn.21st.dev`), recorded as that per-item registry file's own `previewUrl` field.
 *
 * Fetching and committing a copy of that image under `generated/21st-thumbnails/` (served
 * same-origin by `apps/daemon/src/routes/twenty1st.ts`'s `/reference-preview` route) still
 * redistributes the upstream screenshot, so it only happens for a row `twenty1stMayShipLocalImage`
 * (`@mish/contracts`) allows — today, `rights === 'mit'`. A `reference-only` row is never
 * fetched, never written to `generated/21st-thumbnails/`, and never gets a manifest entry, even
 * with `--fetch`: its card shows the neutral "no preview" placeholder instead. `e2e/scripts/
 * catalog-thumbnails.ts` gates its own, separately captured `generated/21st-live-thumbnails/` on
 * the exact same helper, so the two generators cannot drift apart on this rule.
 *
 *   node --experimental-strip-types scripts/twenty-first-thumbnails.ts --fetch   downloads every
 *     eligible row's previewUrl from cdn.21st.dev, re-encodes it and writes generated/21st-thumbnails/ +
 *     the manifest. The only network call in this package; every other command below is offline.
 *   node --experimental-strip-types scripts/twenty-first-thumbnails.ts           rebuilds the
 *     manifest from the images already on disk (no fetch; fails if an eligible row's image is missing).
 *   node --experimental-strip-types scripts/twenty-first-thumbnails.ts --check   validates the
 *     committed manifest and images; exits 1 on drift. No kit, no network.
 *
 * Every manifest entry records provenance: the row id, the file, its byte size, the exact
 * `sourceUrl` the image came from and the kit registry file that recorded it, so a reviewer can
 * verify without re-fetching anything.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { twenty1stMayShipLocalImage } from '@mish/contracts';
import twentyFirstItemsJson from '../generated/21st-items.json' with { type: 'json' };
import type { TwentyFirstCatalog } from './twenty-first.ts';

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = join(pkgDir, 'generated');
const manifestPath = join(generatedDir, '21st-thumbnails.json');
const imagesDir = join(generatedDir, '21st-thumbnails');
const kitDir = process.env.TWENTYFIRST_KIT_DIR ?? join(homedir(), 'projects', 'mm-source-kits', '21st-source-kit');

export const TWENTY_FIRST_THUMBNAIL_SCHEMA = '21st-thumbnails/1';
/** Per-file cap for one catalog card image (20 KiB). */
export const THUMBNAIL_BYTE_LIMIT = 20 * 1024;
export const OUT = { width: 480, height: 300 } as const;

export interface TwentyFirstThumbnailEntry {
  file: string;
  bytes: number;
  /** Where the image came from: 21st.dev's own CDN, never re-hosted or fabricated. */
  sourceUrl: string;
  /** The kit registry file (read-only, never copied) whose `previewUrl` field named `sourceUrl`. */
  kitFile: string;
  fetchedAt: string;
}

export interface TwentyFirstThumbnailManifest {
  schema: typeof TWENTY_FIRST_THUMBNAIL_SCHEMA;
  byteLimit: number;
  items: Record<string, TwentyFirstThumbnailEntry>;
}

interface ManifestItem { id: number; file: string }
interface Manifest { items: ManifestItem[] }
interface RegistryFile { id: number; previewUrl?: unknown }

function fail(title: string, lines: readonly string[]): never {
  console.error(`${title} (${lines.length})`);
  for (const line of lines.slice(0, 50)) console.error(`  - ${line}`);
  process.exit(1);
}

const catalog = twentyFirstItemsJson as unknown as TwentyFirstCatalog;

/** Row id -> the kit registry file recording its `previewUrl`, joined through the numeric id both
 * the kit's top-level manifest.json and each registry/<item>.json carry. Read-only: only `file`
 * (a path) and `previewUrl` (a public image URL) are ever read from the registry JSON — never
 * `componentCode` or `demoCode`. */
function kitFileFor(rowId: string): string | null {
  const manifest = JSON.parse(readFileSync(join(kitDir, 'manifest.json'), 'utf8')) as Manifest;
  const row = catalog.rows.find((r) => r.id === rowId);
  if (!row) return null;
  // The kit's manifest.json items are in the same order scripts/twenty-first.ts reads them in,
  // matched here by the row's own slug embedded in the kit's `file` name (`<author>__<name>__<id>.json`)
  // rather than by array index, since twenty-first.ts sorts rows by id before this ever runs.
  const bySlugFragment = manifest.items.find((item) => item.file.replace(/^registry\//, '').startsWith(`${row.author.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`)
    && slugifyFileName(item.file) === row.slug);
  return bySlugFragment?.file ?? manifest.items.find((item) => rowMatchesFile(row, item))?.file ?? null;
}

/** `<author>__<name>__<id>.json` -> the same `author-name` slug scripts/twenty-first.ts derives. */
function slugifyFileName(file: string): string {
  const base = file.replace(/^registry\//, '').replace(/\.json$/, '');
  const parts = base.split('__');
  const author = parts[0] ?? '';
  const name = parts.slice(1, -1).join('__');
  const slugPart = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `${slugPart(author)}-${slugPart(name)}`;
}

function rowMatchesFile(row: TwentyFirstCatalog['rows'][number], item: ManifestItem): boolean {
  return slugifyFileName(item.file) === row.slug;
}

function previewUrlFor(kitFile: string): string {
  const file = join(kitDir, kitFile);
  const registryItem = JSON.parse(readFileSync(file, 'utf8')) as RegistryFile;
  if (typeof registryItem.previewUrl !== 'string' || registryItem.previewUrl.length === 0) {
    throw new Error(`${kitFile}: no previewUrl recorded`);
  }
  return registryItem.previewUrl;
}

// ---- image processing (mirrors scripts/thumbnails.ts's frame/encode, same output shape) --------

type SharpModule = (input: Buffer) => SharpInstance;
interface SharpInstance {
  resize: (w: number, h: number, o?: Record<string, unknown>) => SharpInstance;
  extend: (o: Record<string, unknown>) => SharpInstance;
  webp: (o: { quality: number; effort: number }) => { toBuffer: () => Promise<Buffer> };
  png: () => { toBuffer: () => Promise<Buffer> };
  metadata: () => Promise<{ width?: number; height?: number }>;
}

async function loadSharp(): Promise<SharpModule> {
  const mod = (await import('sharp')) as { default: SharpModule };
  return mod.default;
}

async function encode(sharp: SharpModule, source: Buffer): Promise<Buffer> {
  const framed = sharp(source).resize(OUT.width, OUT.height, { fit: 'contain', position: 'centre', background: { r: 255, g: 255, b: 255, alpha: 1 } });
  for (const quality of [82, 70, 60, 50, 40, 32]) {
    const out = await framed.webp({ quality, effort: 6 }).toBuffer();
    if (out.length <= THUMBNAIL_BYTE_LIMIT) return out;
  }
  throw new Error(`no WebP rendition fits ${THUMBNAIL_BYTE_LIMIT} B`);
}

async function runFetch(): Promise<void> {
  if (!existsSync(kitDir)) fail('Source kit missing', [kitDir]);
  const sharp = await loadSharp();
  mkdirSync(imagesDir, { recursive: true });
  const items: Record<string, TwentyFirstThumbnailEntry> = {};
  const fetchedAt = new Date().toISOString();
  for (const row of catalog.rows) {
    if (!twenty1stMayShipLocalImage(row.rights)) continue;
    const kitFile = kitFileFor(row.id);
    if (!kitFile) fail('No kit registry file found for row', [row.id]);
    const sourceUrl = previewUrlFor(kitFile!);
    console.log(`fetching ${row.id} <- ${sourceUrl}`);
    const res = await fetch(sourceUrl);
    if (!res.ok) fail(`${row.id}: fetch failed`, [`${sourceUrl} -> HTTP ${res.status}`]);
    const raw = Buffer.from(await res.arrayBuffer());
    const webp = await encode(sharp, raw);
    const file = `${row.slug}.webp`;
    writeFileSync(join(imagesDir, file), webp);
    items[row.id] = { file, bytes: webp.length, sourceUrl, kitFile: kitFile!, fetchedAt };
    console.log(`  -> ${file} ${webp.length} B`);
  }
  writeManifest(items);
  runCheck();
}

function writeManifest(items: Record<string, TwentyFirstThumbnailEntry>): void {
  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: TwentyFirstThumbnailManifest = { schema: TWENTY_FIRST_THUMBNAIL_SCHEMA, byteLimit: THUMBNAIL_BYTE_LIMIT, items: sorted };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const keep = new Set(Object.values(sorted).map((e) => e.file));
  if (existsSync(imagesDir)) {
    for (const file of readdirSync(imagesDir)) if (!keep.has(file)) rmSync(join(imagesDir, file));
  }
}

/** Rebuilds the manifest from images already on disk, without fetching (used when a row's kit
 * mapping or slug changes but the image itself does not need to move). */
function runWrite(): void {
  if (!existsSync(manifestPath)) fail('No manifest to rebuild from; run --fetch first', [manifestPath]);
  const previous = JSON.parse(readFileSync(manifestPath, 'utf8')) as TwentyFirstThumbnailManifest;
  const items: Record<string, TwentyFirstThumbnailEntry> = {};
  for (const row of catalog.rows) {
    if (!twenty1stMayShipLocalImage(row.rights)) continue;
    const kept = previous.items[row.id];
    if (!kept) fail(`No previous thumbnail entry for ${row.id}; run --fetch`, []);
    items[row.id] = kept!;
  }
  writeManifest(items);
  runCheck();
}

function runCheck(): void {
  if (!existsSync(manifestPath)) fail('generated/21st-thumbnails.json is missing', [manifestPath]);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TwentyFirstThumbnailManifest;
  const errors: string[] = [];
  if (manifest.schema !== TWENTY_FIRST_THUMBNAIL_SCHEMA) errors.push(`schema must be ${TWENTY_FIRST_THUMBNAIL_SCHEMA}`);
  const rowIds = new Set(catalog.rows.map((r) => r.id));
  for (const row of catalog.rows) {
    const entry = manifest.items[row.id];
    if (!twenty1stMayShipLocalImage(row.rights)) {
      if (entry) errors.push(`${row.id}: rights is ${row.rights}; must not carry a local 21st-thumbnails entry`);
      continue;
    }
    if (!entry) { errors.push(`${row.id}: no thumbnail entry`); continue; }
    if (!/^https:\/\/cdn\.21st\.dev\//.test(entry.sourceUrl)) errors.push(`${row.id}: sourceUrl must be an https://cdn.21st.dev/ URL, got ${entry.sourceUrl}`);
    const file = join(imagesDir, entry.file);
    if (!existsSync(file)) { errors.push(`${row.id}: ${entry.file} is missing on disk`); continue; }
    const bytes = statSync(file).size;
    if (bytes !== entry.bytes) errors.push(`${row.id}: manifest says ${entry.bytes} B, file is ${bytes} B`);
    if (bytes > THUMBNAIL_BYTE_LIMIT) errors.push(`${row.id}: ${entry.file} is ${bytes} B, over the ${THUMBNAIL_BYTE_LIMIT} B limit`);
  }
  for (const id of Object.keys(manifest.items)) if (!rowIds.has(id)) errors.push(`${id}: no longer a 21st catalog row`);
  if (existsSync(imagesDir)) {
    const known = new Set(Object.values(manifest.items).map((e) => e.file));
    for (const file of readdirSync(imagesDir)) if (!known.has(file)) errors.push(`${file}: not referenced by any manifest entry`);
  }
  if (errors.length > 0) fail('generated/21st-thumbnails.json is invalid', errors);
  console.log(`21st-thumbnails.json: ${Object.keys(manifest.items).length} images, all from cdn.21st.dev, largest limit ${THUMBNAIL_BYTE_LIMIT} B`);
}

if (process.argv.includes('--check')) runCheck();
else if (process.argv.includes('--fetch')) void runFetch();
else runWrite();
