/**
 * Catalog tab thumbnails for every catalog row that has no converter preview.
 *
 *   node --experimental-strip-types scripts/thumbnails.ts          render from the kit, write generated/
 *   node --experimental-strip-types scripts/thumbnails.ts --check  write nothing; exit 1 on a failure
 *
 * Rows with a `previewId` keep the converter's preview (`generated/previews/`, scripts/adapters.ts;
 * that script deletes any file there that is not an insertable row's, so thumbnails live apart).
 * For every other row this writes one entry in `generated/thumbnails.json`, in this order of
 * preference:
 *
 *   client-render     the installed live-preview harness, with its real UI dependencies and
 *                     disclosed offline example data (same renderer as the Catalog modal)
 *
 *   converter-source  the kit's `converted/<name>/preview-source.png`: the converter already
 *                     rendered the item's own source (with its own text) before refusing it
 *   demo              a primitive shares the thumbnail of its `<name>-demo` row
 *   page-render       an item with a page.tsx, rendered by the converter's SSR stage
 *                     (scripts/thumbnail-harness.ts `renderPage`)
 *   client-render     a demo module, or a page the SSR stage refused, mounted in a browser
 *                     (`renderClient`)
 *   placeholder       none of these produced a non-blank image; the entry records why
 *
 * Every image shows the item's own component markup, rendered locally with no network. The
 * live harness may supply disclosed example records or original local illustrations where the
 * registry omitted data or remote media. No vendor marketing screenshot is used (docs/legal/cult-ui-pro-rights.md). Each is a 480x300 WebP at most
 * THUMBNAIL_BYTE_LIMIT bytes. The kit path is CULT_KIT_DIR; `--check` needs no kit.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { CultCatalog, CultCatalogRow } from '../src/types.ts';
import {
  checkThumbnails,
  THUMBNAIL_BYTE_LIMIT,
  THUMBNAIL_SCHEMA,
  type ThumbnailEntry,
  type ThumbnailManifest,
} from './thumbnail-check.ts';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const generatedDir = join(PACKAGE_DIR, 'generated');
const manifestPath = join(generatedDir, 'thumbnails.json');
const thumbnailsDir = join(generatedDir, 'thumbnails');

const OUT = { width: 480, height: 300 } as const;
const ASPECT = OUT.width / OUT.height;

function fail(title: string, lines: readonly string[]): never {
  console.error(`${title} (${lines.length})`);
  for (const line of lines.slice(0, 60)) console.error(`  - ${line}`);
  if (lines.length > 60) console.error(`  … ${lines.length - 60} more`);
  process.exit(1);
}

function loadCatalog(): CultCatalog {
  return JSON.parse(readFileSync(join(PACKAGE_DIR, 'catalog.json'), 'utf8')) as CultCatalog;
}

function runCheck(): void {
  const manifest: unknown = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const result = checkThumbnails(loadCatalog(), manifest, thumbnailsDir);
  if (result.errors.length > 0) fail('Cult thumbnail check failed', result.errors);
  console.log(
    `Cult thumbnails valid: ${result.files} files (${result.bytes} B, largest limit ${THUMBNAIL_BYTE_LIMIT} B), `
    + `${result.shared} shared with a demo, ${result.placeholders} placeholders`,
  );
}

// ---- image processing (sharp is a dev dependency, used only when writing) ---------------------

type SharpModule = (typeof import('sharp'))['default'];
type SharpInstance = import('sharp').Sharp;

async function loadSharp(): Promise<SharpModule> {
  return (await import('sharp')).default;
}

const WHITE = { r: 255, g: 255, b: 255, alpha: 1 };

/** A full-page render (1280 px wide): the top 16:10 of it, letterboxed white when shorter. */
async function framePage(sharp: SharpModule, png: string): Promise<Buffer> {
  const meta = await sharp(png).metadata();
  const width = meta.width ?? 1280;
  const height = Math.min(meta.height ?? 800, Math.round(width / ASPECT));
  return sharp(png).extract({ left: 0, top: 0, width, height })
    .resize(OUT.width, OUT.height, { fit: 'contain', position: 'top', background: WHITE })
    .png().toBuffer();
}

/** A client render (a demo centred in a 1280x800 page): trim the white margin, then frame it 16:10. */
async function frameClient(sharp: SharpModule, png: string): Promise<Buffer> {
  let trimmed: { data: Buffer; info: { width: number; height: number } };
  try {
    trimmed = await sharp(png).trim({ background: '#ffffff', threshold: 8 }).png().toBuffer({ resolveWithObject: true });
  } catch {
    return framePage(sharp, png); // nothing to trim (a uniform image); the blank check decides
  }
  const pad = 32;
  const w = trimmed.info.width + pad * 2;
  const h = trimmed.info.height + pad * 2;
  const canvasW = Math.max(w, Math.ceil(h * ASPECT), 560);
  const canvasH = Math.round(canvasW / ASPECT);
  const left = Math.floor((canvasW - trimmed.info.width) / 2);
  const top = Math.max(0, Math.floor((canvasH - trimmed.info.height) / 2));
  // Two passes: sharp runs resize before extend within one pipeline, whatever the call order.
  const canvas = await sharp(trimmed.data)
    .extend({ left, right: canvasW - trimmed.info.width - left, top, bottom: Math.max(0, canvasH - trimmed.info.height - top), background: WHITE })
    .png().toBuffer();
  return sharp(canvas).resize(OUT.width, OUT.height, { fit: 'contain', position: 'top', background: WHITE }).png().toBuffer();
}

/** True when the framed image is one flat colour (an empty render). */
async function isBlank(sharp: SharpModule, framed: Buffer): Promise<boolean> {
  const stats = await sharp(framed).stats();
  return stats.channels.slice(0, 3).every((c) => c.stdev < 3);
}

/** Smallest acceptable WebP: lower quality, then size, until it fits the byte limit. */
async function encode(sharp: SharpModule, framed: Buffer): Promise<Buffer> {
  for (const width of [OUT.width, 400, 320]) {
    for (const quality of [70, 60, 50, 40, 32]) {
      const img: SharpInstance = width === OUT.width ? sharp(framed) : sharp(framed).resize(width, Math.round(width / ASPECT));
      const out = await img.webp({ quality, effort: 6 }).toBuffer();
      if (out.length <= THUMBNAIL_BYTE_LIMIT) return out;
    }
  }
  throw new Error(`no WebP rendition fits ${THUMBNAIL_BYTE_LIMIT} B`);
}

// ---- rendering -----------------------------------------------------------------------------------

type Rendered = { framed: Buffer; source: 'converter-source' | 'converted-preview' | 'page-render' | 'client-render' } | { reason: string };

async function renderRow(
  row: CultCatalogRow,
  sharp: SharpModule,
  harness: typeof import('./thumbnail-harness.ts'),
  workDir: string,
): Promise<Rendered> {
  const reasons: string[] = [];
  const png = join(workDir, `${row.name}.png`);
  // Explicit integration mode keeps derived thumbnails equal to their actual daemon frame,
  // including disclosed original artwork in preview-only image slots.
  const previewDaemon = process.env.CULT_PREVIEW_DAEMON_URL;
  if (row.derivedFrom && previewDaemon) {
    const converted = await harness.renderConverted(row.name, png, previewDaemon);
    if ('error' in converted) return { reason: converted.error };
    const framed = await framePage(sharp, converted.png);
    return await isBlank(sharp, framed) ? { reason: 'converted preview is blank' } : { framed, source: 'converted-preview' };
  }
  const live = await harness.renderLive(row.name, png);
  if ('png' in live) {
    const framed = await frameClient(sharp, live.png);
    if (!(await isBlank(sharp, framed))) return { framed, source: 'client-render' };
    reasons.push('live preview is blank');
  } else {
    reasons.push(live.error);
  }
  const converted = join(harness.KIT_DIR, 'converted', row.name, 'preview-source.png');
  if (existsSync(converted)) {
    const framed = await framePage(sharp, converted);
    if (!(await isBlank(sharp, framed))) return { framed, source: 'converter-source' };
    reasons.push('converter source render is blank');
  }
  if (row.derivedFrom !== undefined) return { reason: [...reasons, 'a derived section has no module of its own to render'].join('; ') };

  const page = harness.pageEntry(row.name);
  if (page !== null) {
    const ssr = await harness.renderPage(row.name, png);
    if ('png' in ssr) {
      const framed = await framePage(sharp, ssr.png);
      if (!(await isBlank(sharp, framed))) return { framed, source: 'page-render' };
      reasons.push('server render is blank');
    } else {
      reasons.push(ssr.error);
    }
  }
  const module = page ?? harness.moduleEntry(row.name);
  if (module === null) return { reason: [...reasons, 'the kit has no page or component module for this item'].join('; ') };
  const client = await harness.renderClient(module, png);
  if ('error' in client) return { reason: [...reasons, `client render ${client.error}`].join('; ') };
  const framed = await frameClient(sharp, client.png);
  if (await isBlank(sharp, framed)) return { reason: [...reasons, 'client render is blank'].join('; ') };
  return { framed, source: 'client-render' };
}

async function runWrite(): Promise<void> {
  const harness = await import('./thumbnail-harness.ts');
  if (!harness.kitPresent()) fail('Source kit missing', [harness.KIT_DIR]);
  const sharp = await loadSharp();
  const catalog = loadCatalog();
  const byName = new Map(catalog.rows.map((row) => [row.name, row]));
  const rows = catalog.rows.filter((row) => row.previewId === null);
  // Demo rows first, so a primitive can share its demo's thumbnail.
  const ordered = [...rows].sort((a, b) => Number(b.name.endsWith('-demo')) - Number(a.name.endsWith('-demo')) || a.id.localeCompare(b.id));
  const onlyIndex = process.argv.indexOf('--only');
  const onlyValue = process.argv.find((arg) => arg.startsWith('--only='))?.slice('--only='.length)
    ?? (onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined);
  if (onlyIndex >= 0 && (!onlyValue || onlyValue.startsWith('--'))) fail('Invalid thumbnail selection', ['--only needs comma-separated row names']);
  const only = onlyValue?.split(',');
  if (only?.some(name => !byName.has(name))) fail('Invalid thumbnail selection', ['--only contains an unknown catalog row']);
  const previous: ThumbnailManifest | null = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) as ThumbnailManifest : null;

  mkdirSync(thumbnailsDir, { recursive: true });
  const workDir = join(tmpdir(), `cult-thumbnails-${process.pid}`);
  mkdirSync(workDir, { recursive: true });
  const items: Record<string, ThumbnailEntry> = {};
  try {
    for (const row of ordered) {
      if (only && !only.includes(row.name)) {
        const kept = previous?.items[row.id];
        if (kept) items[row.id] = kept;
        continue;
      }
      const demo = row.assetKind === 'primitive' ? byName.get(`${row.name}-demo`) : undefined;
      const demoEntry = demo ? items[demo.id] : undefined;
      if (demo && demoEntry && 'file' in demoEntry && demoEntry.source !== 'demo') {
        items[row.id] = { file: demoEntry.file, source: 'demo', via: demo.id };
        continue;
      }
      let rendered: Rendered;
      try {
        rendered = await renderRow(row, sharp, harness, workDir);
      } catch (error) {
        rendered = { reason: `render crashed: ${String(error instanceof Error ? error.message : error).split('\n')[0]}` };
      }
      if ('reason' in rendered) {
        // A non-primitive row (an 'app' with no default props, most often) that cannot render on
        // its own can still share a `-demo` sibling's thumbnail when that sibling DID render: it
        // is the same component, just instantiated with the demo's own example data instead of
        // bare defaults — the same principle the primitive short-circuit above already uses, only
        // applied as a fallback here so a row's own render is still tried and preferred first.
        const fallbackDemo = demo ?? byName.get(`${row.name}-demo`);
        const fallbackEntry = fallbackDemo ? items[fallbackDemo.id] : undefined;
        if (fallbackDemo && fallbackEntry && 'file' in fallbackEntry && fallbackEntry.source !== 'demo') {
          items[row.id] = { file: fallbackEntry.file, source: 'demo', via: fallbackDemo.id };
          console.log(`${'demo'.padEnd(16)} ${row.id} <- ${fallbackDemo.id} (own render failed: ${rendered.reason})`);
          continue;
        }
        const placeholder = demo ? `${rendered.reason}; its demo row has no thumbnail either` : rendered.reason;
        items[row.id] = { placeholder };
        console.log(`${'placeholder'.padEnd(16)} ${row.id}: ${placeholder}`);
        continue;
      }
      const webp = await encode(sharp, rendered.framed);
      const file = `${row.name}.webp`;
      writeFileSync(join(thumbnailsDir, file), webp);
      items[row.id] = { file, source: rendered.source, bytes: webp.length };
      console.log(`${rendered.source.padEnd(16)} ${row.id} ${webp.length} B`);
    }
  } finally {
    await harness.closeHarness();
    rmSync(workDir, { recursive: true, force: true });
  }

  const sorted = Object.fromEntries(Object.entries(items).sort(([a], [b]) => a.localeCompare(b)));
  const manifest: ThumbnailManifest = { schema: THUMBNAIL_SCHEMA, byteLimit: THUMBNAIL_BYTE_LIMIT, items: sorted };
  const keep = new Set(Object.values(sorted).flatMap((entry) => ('file' in entry && entry.source !== 'demo' ? [entry.file] : [])));
  for (const file of readdirSync(thumbnailsDir)) if (!keep.has(file)) rmSync(join(thumbnailsDir, file));
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  runCheck();
}

if (process.argv.includes('--check')) runCheck();
else await runWrite();
