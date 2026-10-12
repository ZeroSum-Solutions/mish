/** Saved references, optional private upstream demos, and local alternatives. */
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { Express } from 'express';
import { filterTwenty1stItems, type Twenty1stItem, Twenty1stItemResponse, Twenty1stListResponse, Twenty1stSourceResponse } from '@mish/contracts';
import twenty1stJson from '@mish/21st-catalog/generated/21st-items.json' with { type: 'json' };
import originalsJson from '@mish/21st-catalog/generated/21st-originals.json' with { type: 'json' };
import twenty1stThumbnailsJson from '@mish/21st-catalog/generated/21st-thumbnails.json' with { type: 'json' };
import { findRealTagOffset, HTML_TAG_PATTERNS } from '@mish/contracts/runtime/html-injection-points';
import { mishPackGeneration, packTwentyFirstThumbnails } from '../mish-packs/overlay.js';
import { PREVIEW_CONTENT_SIZE_REPORTER } from '../preview-content-size.js';
import type { RouteDeps } from '../server-context.js';
import { twenty1stLiveThumbnailBytes, twenty1stLiveThumbnailIndex } from '../services/twenty1st-thumbnails.js';
import { Twenty1stPrivatePreviews } from '../services/twenty1st-private-previews.js';

export interface RegisterTwenty1stRoutesDeps extends RouteDeps<'http'> {}

/**
 * Adds the content-size bridge to a private preview shell at response time. The saved source,
 * compiled assets and their hashes are unchanged; only this served shell gains one inline script,
 * permitted by its exact hash in `script-src` (no 'unsafe-inline'). A shell or policy that does
 * not have the expected form is served unchanged, and the host keeps the full stage.
 */
export function withPrivatePreviewSizeBridge(preview: { html: string; csp: string }, id: string): { html: string; csp: string } {
  const bodyEnd = findRealTagOffset(preview.html, HTML_TAG_PATTERNS.bodyClose);
  if (bodyEnd < 0 || !preview.csp.includes("script-src 'self'")) return preview;
  const script = `(function(){var start=(${PREVIEW_CONTENT_SIZE_REPORTER})(function(width,height){parent.postMessage({source:"twentyfirst-preview-size",id:${JSON.stringify(id).replace(/</g, '\\u003c')},type:"size",width:width,height:height},"*")},"root");`
    + 'if(document.readyState==="complete")start();else addEventListener("load",start);})()';
  const hash = createHash('sha256').update(script).digest('base64');
  return {
    html: `${preview.html.slice(0, bodyEnd)}<script>${script}</script>${preview.html.slice(bodyEnd)}`,
    csp: preview.csp.replace("script-src 'self'", `script-src 'self' 'sha256-${hash}'`),
  };
}

interface Twenty1stInventoryRow {
  id: string;
  slug: string;
  name: string;
  author: string;
  authorProfileUrl: string;
  itemUrl: string;
  rights: 'mit' | 'reference-only';
  licenseLabel: string | null;
  licenseUrl: string | null;
  licenseNotice: string | null;
  copyable: boolean;
}

interface Twenty1stInventory {
  schema: '21st-catalog/1';
  source: { profile: string; itemCount: number };
  rows: Twenty1stInventoryRow[];
}

interface Twenty1stThumbnailEntry { file: string }
interface Twenty1stThumbnailManifest { items: Record<string, Twenty1stThumbnailEntry> }

const inventory = twenty1stJson as unknown as Twenty1stInventory;
const bundledThumbnails = twenty1stThumbnailsJson as unknown as Twenty1stThumbnailManifest;

/** The bundled manifest plus an installed pack's thumbnails (a pack fills ids the bundle lacks). */
function thumbnailIndex(): { items: Record<string, Twenty1stThumbnailEntry & { packDir?: string }> } {
  const pack = packTwentyFirstThumbnails();
  if (!pack) return bundledThumbnails;
  const items: Record<string, Twenty1stThumbnailEntry & { packDir?: string }> = { ...bundledThumbnails.items };
  for (const [id, entry] of Object.entries(pack.manifest.items)) {
    if (!items[id] && entry && typeof entry.file === 'string') items[id] = { file: entry.file, packDir: pack.dir };
  }
  return { items };
}
/** A generated file name only ever `<slug>.webp` (scripts/twenty-first-thumbnails.ts), never request text. */
const TWENTY1ST_PREVIEW_FILE_PATTERN = /^[a-z0-9][a-z0-9-]*\.webp$/;

/** Catalog presentation only; saved source titles, source files, hashes, and authorship stay intact. */
const cardPresentation: Record<string, { description: string; title?: string }> = {
  '21st:dhileepkumargm-3d-cards-slider': { description: 'An image-card slider with perspective and pointer-driven rotation.' },
  '21st:jatin-yadav05-animated-geometric-card': { description: 'A card with animated geometric shapes and floating particles.' },
  '21st:ravikatiyar162-card': { title: 'Opportunity Card', description: 'A project offer with participant details, specifications, and actions.' },
  '21st:hero-ui-card': { title: 'Flexible Card', description: 'Cards for creator applications, payments, groups, and events.' },
  '21st:isaiahbjork-coach-scheduling-card': { description: 'A weekly availability card with time-slot and location selection.' },
  '21st:uniquesonu-dashboard-activities': { description: 'A dashboard panel listing recent activity.' },
  '21st:efferd-dialog': { description: 'A modal dialog with a backdrop and close control.' },
  '21st:ruixen-ui-gallery-hover-carousel': { description: 'An image carousel with navigation arrows and captions on hover.' },
  '21st:jahed-glass-testimonial-swiper': { description: 'A draggable stack of testimonial cards.' },
  '21st:moumensoliman-glassmorphism-listen-app': { description: 'A music-player layout with playlist cards and a Spotify embed.' },
  '21st:moumensoliman-glassmorphism-portfolio': { description: 'A profile layout with a portrait, highlights, and social links.' },
  '21st:ruixen-ui-image-stream-hero': { description: 'Two looping image rails move outward through a perspective scene.' },
  '21st:ravikatiyar162-offer-carousel': { description: 'A horizontal offer-card carousel with arrow navigation.' },
  '21st:xordev-phosphor-30': { description: 'An animated shader scene with glowing ribbons of colour.' },
  '21st:legionwebdev-radar-chart': { description: 'A radial chart comparing values across monthly axes.' },
  '21st:ruixen-ui-ruixenmonochat': { description: 'A chat layout with a contact sidebar and message thread.' },
  '21st:rahil1202-scannercardstream': { description: 'A moving card stream with a central scanner and particle effects.' },
  '21st:jahed-shared-element-gallery': { description: 'A masonry image gallery with animated expansion between views.' },
  '21st:ruixen-ui-socialpostcard': { description: 'A social post with author details, reactions, and a link preview.' },
  '21st:serafimcloud-spline-scene': { description: 'An interactive Spline scene with a robot and spotlight.' },
  '21st:isaiahbjork-system-monitor': { description: 'A monitor panel with resource metrics and time-series charts.' },
  '21st:kokonutd-background-paths': { description: 'An animated path background behind a gradient title.' },
};
function presentItem(item: Twenty1stItem): Twenty1stItem {
  const presentation = cardPresentation[item.id];
  if (!presentation) return item;
  const field = item.privateImplementation ? 'privateImplementation' : 'ownedAlternative';
  const implementation = item[field];
  return {
    ...item,
    ...(presentation.title ? { name: presentation.title } : {}),
    ...(implementation ? { [field]: { ...implementation, description: presentation.description, ...(presentation.title ? { title: presentation.title } : {}) } } : {}),
  };
}

function toItem(row: Twenty1stInventoryRow): Twenty1stItem {
  return {
    id: row.id,
    slug: row.slug,
    name: cardPresentation[row.id]?.title ?? row.name,
    author: row.author,
    authorProfileUrl: row.authorProfileUrl,
    itemUrl: row.itemUrl,
    rights: row.rights,
    licenseLabel: row.licenseLabel,
    licenseUrl: row.licenseUrl,
    licenseNotice: row.licenseNotice,
    copyable: row.copyable,
    ...(findOriginal(row.id) ? { ownedAlternative: descriptor(findOriginal(row.id)!) } : {}),
    preview: thumbnailIndex().items[row.id] ? { kind: 'image', source: 'twenty-first-dev-cdn' } : { kind: 'none' },
  };
}

const originals = originalsJson.items as Twenty1stSourceResponse[];
function findOriginal(id: string): Twenty1stSourceResponse | undefined {
  return originals.find(item => item.id === id || item.id === `21st:${id}`);
}
function descriptor(item: Twenty1stSourceResponse) {
  const path = `/api/21st/${encodeURIComponent(item.id)}`;
  return { title: item.title, description: (item as Twenty1stSourceResponse & {description: string}).description, provenance: 'independently-authored' as const, sourceSha256: item.sourceSha256, sourceUrl: `${path}/source`, previewUrl: `${path}/preview` };
}

let cached: { generation: number; catalog: Twenty1stListResponse['catalog'] } | null = null;

/** The projected 21st list, built on first use and reused until the set of installed packs changes. */
export function twenty1stCatalog(): Twenty1stListResponse['catalog'] {
  const generation = mishPackGeneration();
  if (cached?.generation !== generation) {
    cached = { generation, catalog: { profile: inventory.source.profile, items: inventory.rows.map(row => presentItem(toItem(row))) } };
  }
  return cached.catalog;
}

export function findTwenty1stItem(id: string): Twenty1stItem | undefined {
  return twenty1stCatalog().items.find((item) => item.id === id || item.slug === id);
}

/**
 * The catalog package's `generated/` directory, resolved at run time through the package's own
 * `21st-items.json` export (the images are files, not modules, so they are read from disk) — the
 * same pattern `cult-catalog.ts`'s `cultGeneratedDir` uses for the licensed Cult UI Pro previews.
 */
function twenty1stGeneratedDir(): string {
  const require = createRequire(import.meta.url);
  return path.dirname(require.resolve('@mish/21st-catalog/generated/21st-items.json'));
}

/** The absolute path of a row's 21st.dev preview image, or null. The row id only selects a
 * manifest entry; the file name is validated as one `.webp` segment and the joined path must stay
 * inside the fixed `21st-thumbnails/` directory, so no request text ever reaches the filesystem. */
function twenty1stPreviewPath(rowId: string, generatedDir: string): string | null {
  const entry = thumbnailIndex().items[rowId];
  if (!entry || !TWENTY1ST_PREVIEW_FILE_PATTERN.test(entry.file)) return null;
  const base = path.resolve(entry.packDir ?? generatedDir, '21st-thumbnails');
  const file = path.resolve(base, entry.file);
  if (path.dirname(file) !== base) return null;
  return existsSync(file) ? file : null;
}

/** Previews change only with a catalog release; a day of caching, then revalidation. */
const TWENTY1ST_PREVIEW_CACHE_CONTROL = 'public, max-age=86400';

export function registerTwenty1stRoutes(app: Express, ctx: RegisterTwenty1stRoutesDeps, options: {previewDir?: string; resourceRoot?: string; generatedDir?: string} = {}): void {
  const { sendApiError } = ctx.http;
  // A hint for shells still exporting the pre-P1-4a name. The old name is never read as a fallback.
  if (process.env.CULT_21ST_PREVIEW_DIR?.trim() && !process.env.TWENTY1ST_PREVIEW_DIR?.trim()) {
    console.warn('[od] CULT_21ST_PREVIEW_DIR is set: renamed to TWENTY1ST_PREVIEW_DIR; ignored');
  }
  let privatePreviews: Twenty1stPrivatePreviews;
  try {
    // Packaged kits are read-only resources, independent of this Mac's source checkout.
    const bundled = options.resourceRoot
      ? path.join(options.resourceRoot, 'data', 'component-kits', '21st-private') : undefined;
    const directory = options.previewDir?.trim() || process.env.TWENTY1ST_PREVIEW_DIR?.trim()
      || (bundled && existsSync(bundled) ? bundled : undefined);
    privatePreviews = new Twenty1stPrivatePreviews(directory, twenty1stCatalog().items);
  } catch {
    // Refuse an invalid optional kit without taking unrelated daemon capabilities down.
    app.use('/api/21st', (_req, res) => sendApiError(res, 503, 'INTERNAL_ERROR', 'Saved 21st source kit is unavailable. Rebuild the private previews and restart the daemon.'));
    return;
  }
  // `generatedDir` lets a test point the live-thumbnail and reference-image reads at a synthetic copy.
  const generatedDir = options.generatedDir ?? twenty1stGeneratedDir();
  let builtState: { generation: number; catalog: Twenty1stListResponse['catalog']; liveThumbnails: ReturnType<typeof twenty1stLiveThumbnailIndex> } | null = null;
  const state = () => {
    const generation = mishPackGeneration();
    if (builtState?.generation === generation) return builtState;
    const projectedItems = twenty1stCatalog().items.map(item => presentItem(privatePreviews.project(item)));
    const liveThumbnails = twenty1stLiveThumbnailIndex(generatedDir, projectedItems);
    const catalog = { ...twenty1stCatalog(), items: projectedItems.map(item => {
      const thumbnail = liveThumbnails.get(item.id);
      if (!thumbnail) return item;
      const field = item.privateImplementation ? 'privateImplementation' : 'ownedAlternative';
      return { ...item, [field]: { ...item[field]!, thumbnail: { revision: thumbnail.revision } } };
    }) };
    builtState = { generation, catalog, liveThumbnails };
    return builtState;
  };

  app.get('/api/21st/:id/implementation-thumbnail', (req, res) => {
    const { catalog, liveThumbnails } = state();
    const item = catalog.items.find(item => item.id === req.params.id || item.slug === req.params.id);
    const thumbnail = item ? liveThumbnails.get(item.id) : undefined;
    if (!thumbnail || (req.query.revision !== undefined && req.query.revision !== thumbnail.revision)) return sendApiError(res, 404, 'NOT_FOUND', 'no matching local implementation thumbnail');
    const bytes = twenty1stLiveThumbnailBytes(thumbnail);
    if (!bytes) return sendApiError(res, 404, 'NOT_FOUND', 'local implementation thumbnail revision changed');
    res.setHeader('Cache-Control', req.query.revision ? 'public, max-age=31536000, immutable' : TWENTY1ST_PREVIEW_CACHE_CONTROL);
    res.setHeader('ETag', `"${thumbnail.revision}"`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('image/webp').send(bytes);
  });

  app.get('/api/21st', (req, res) => {
    try {
      const param = (key: string) => typeof req.query[key] === 'string' ? req.query[key] as string : undefined;
      const { catalog } = state();
      res.json({ catalog: { ...catalog, items: filterTwenty1stItems(catalog.items, {
        query: param('query'), tag: param('tag'), rights: param('rights'),
      }) } } satisfies Twenty1stListResponse);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/21st/:id/source', async (req, res) => {
    const item = privatePreviews.source(req.params.id) ?? findOriginal(req.params.id);
    if (!item) return sendApiError(res, 404, 'NOT_FOUND', 'no saved implementation with that id');
    if (req.query.download === 'zip') {
      if (item.provenance === 'upstream-private' && item.localImportClosure?.status !== 'resolved') {
        const closure = item.localImportClosure;
        const detail = closure?.status === 'missing'
          ? `Missing local source file: ${closure.missing[0]?.resolvedCandidate ?? 'unknown'}. Inspect source JSON and restore the original bundle.`
          : `Local source imports could not be verified (${closure?.status === 'unverified' ? closure.reason : 'unknown'}). Inspect source JSON and restore the original bundle.`;
        return sendApiError(res, 422, 'SOURCE_DEPENDENCY_INCOMPLETE', detail);
      }
      const zip = new JSZip();
      for (const file of item.files) zip.file(file.path, file.content);
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });
      res.setHeader('Content-Disposition', `attachment; filename="${item.id.slice(5)}-${item.provenance === 'upstream-private' ? 'source' : 'original'}.zip"`);
      return res.type('application/zip').send(buffer);
    }
    res.json(item);
  });
  app.get('/api/21st/:id/preview', (req, res) => {
    const saved = privatePreviews.preview(req.params.id);
    if (saved) {
      // The same canonical ID the private preview store resolved this request to.
      const id = req.params.id.startsWith('21st:') ? req.params.id : `21st:${req.params.id}`;
      const preview = withPrivatePreviewSizeBridge(saved, id);
      res.setHeader('Content-Security-Policy', preview.csp);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'no-cache');
      return res.type('html').send(preview.html);
    }
    const item = findOriginal(req.params.id);
    if (!item) return sendApiError(res, 404, 'NOT_FOUND', 'no owned alternative with that id');
    const html = item.files.find(file => file.path === 'index.html')!.content;
    const csp = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
    if (!csp) return sendApiError(res, 500, 'INTERNAL_ERROR', 'owned preview is missing its content policy');
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.type('html').send(html);
  });

  app.get('/api/21st/:id/assets/:file', (req, res) => {
    const bytes = privatePreviews.asset(req.params.id, req.params.file);
    if (!bytes) return sendApiError(res, 404, 'NOT_FOUND', 'no saved preview asset with that id');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache');
    return res.type(req.params.file.endsWith('.css') ? 'text/css' : 'application/javascript').send(bytes);
  });

  app.get('/api/21st/:id', (req, res) => {
    try {
      const item = state().catalog.items.find(item => item.id === req.params.id || item.slug === req.params.id);
      if (!item) return sendApiError(res, 404, 'NOT_FOUND', 'no 21st.dev item with that id');
      res.json({ item } satisfies Twenty1stItemResponse);
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });

  app.get('/api/21st/:id/reference-preview', (req, res) => {
    try {
      const item = findTwenty1stItem(req.params.id);
      if (!item) return sendApiError(res, 404, 'NOT_FOUND', 'no 21st.dev item with that id');
      const file = twenty1stPreviewPath(item.id, generatedDir);
      if (!file) return sendApiError(res, 404, 'NOT_FOUND', 'this 21st.dev item has no preview image');
      res.setHeader('Cache-Control', TWENTY1ST_PREVIEW_CACHE_CONTROL);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.sendFile(path.basename(file), { root: path.dirname(file), dotfiles: 'deny', headers: { 'Content-Type': 'image/webp' } }, (err) => {
        if (err && !res.headersSent) sendApiError(res, 404, 'NOT_FOUND', 'preview image unavailable');
      });
    } catch (err) {
      sendApiError(res, 500, 'INTERNAL_ERROR', err instanceof Error ? err.message : String(err));
    }
  });
}
