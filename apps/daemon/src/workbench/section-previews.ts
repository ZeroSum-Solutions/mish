import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { ResourceCandidate } from '@mish/contracts';
import { cultRegistryName } from '@mish/contracts';
import type { SectionCatalogEntry } from '@mish/contracts/api/section-catalog';
import { convertedDir, convertedPreviewHtml, escapeHtml } from '../cult-live-preview.js';
import { cultInternalId } from '../cult-public-ids.js';

/**
 * AC-R07 preamble: the "compiled HTML section" preview adapter. Two section families already
 * carry compiled, self-contained bytes in the bundled resources:
 *
 * - HyperUI blocks: vendored markup (no script, image or URL; `scripts/vendor-hyperui.ts`) plus
 *   `css/preview.css`, every block's Tailwind utilities compiled at vendoring time
 *   (`scripts/build-ui-kit-css.ts --preview`). Its first line records the block bytes it was
 *   compiled from; a stale stylesheet is refused rather than rendering a half-styled block.
 * - Cult sections and pages: the converter's static layout (`converted/<name>/template.html` +
 *   `styles.css`) from the bundled licensed kit, served to this machine only.
 *
 * Neither loads a Tailwind runtime or anything from the network. The document runs in an opaque
 * origin with inline script allowed only so the Enlarge host's keyboard bridge works.
 */
export const SECTION_PREVIEW_DOCUMENT_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'", 'img-src data:', 'font-src data:',
  "media-src 'none'", "connect-src 'none'", "object-src 'none'", "frame-src 'none'", "base-uri 'none'", "form-action 'none'",
].join('; ');
export const SECTION_PREVIEW_FRAME_CSP = `${SECTION_PREVIEW_DOCUMENT_CSP}; sandbox allow-scripts`;

export interface SectionPreviewRoots {
  /** `plugins/_official/shared/ui-kits/hyperui` under the bundled-plugins resource root. */
  hyperuiRoot: string | null;
  /** The bundled licensed Cult kit (`resolveCultKitDir`). */
  cultKitDir: string | null;
}

export const sectionPreviewPath = (publicId: string) => `/api/sections/${encodeURIComponent(publicId)}/preview`;
const PREVIEW_CSS = path.join('css', 'preview.css');
const HEADER = /^\/\* od:hyperui-preview blocks-sha256=([0-9a-f]{64}) tailwindcss=([0-9.]+) \*\//u;
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Same formula as `scripts/build-ui-kit-css.ts`'s `previewBlocksDigest`, over the catalog pins. */
function blocksDigest(entries: readonly SectionCatalogEntry[]): string {
  const lines = entries.flatMap(entry => entry.content.kind === 'vendored-block' ? [`${entry.content.blockId}:${entry.content.sha256}`] : []).sort();
  return sha256(lines.join('\n'));
}

type CssState = { state: 'ready'; css: string } | { state: 'missing' | 'stale' };
/** Keyed by the stylesheet file's identity as well as the catalog pins, so a stylesheet that
 * appears, is replaced or is removed under the same root is read again, never served from a
 * stale answer. Only the latest identity per root is kept. */
const cssCache = new Map<string, { key: string; result: CssState }>();
function compiledCss(root: string | null, catalog: readonly SectionCatalogEntry[]): CssState {
  if (!root) return { state: 'missing' };
  const file = path.join(root, PREVIEW_CSS);
  let identity: string;
  try {
    const stat = statSync(file, { bigint: true });
    if (!stat.isFile()) return { state: 'missing' };
    identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch { return { state: 'missing' }; }
  const expected = blocksDigest(catalog);
  const key = `${identity}\0${expected}`;
  const cached = cssCache.get(root);
  if (cached?.key === key) return cached.result;
  let result: CssState;
  try {
    const css = readFileSync(file, 'utf8');
    result = HEADER.exec(css)?.[1] === expected ? { state: 'ready', css } : { state: 'stale' };
  } catch { result = { state: 'missing' }; }
  cssCache.set(root, { key, result });
  return result;
}

function blockFile(root: string, blockId: string): string | null {
  if (!/^[a-z0-9-]+(?:\/[a-z0-9-]+)+$/u.test(blockId)) return null;
  const base = path.resolve(root, 'blocks');
  const file = path.resolve(base, `${blockId}.html`);
  return file.startsWith(base + path.sep) ? file : null;
}

const unavailable = (reason: string): ResourceCandidate['previewCapability'] => ({ available: false, kind: 'none', reason });

/**
 * The preview capability of one catalog entry, or null when the section family has no compiled
 * bytes at all (the listing keeps its `adapter-missing` default). `entry` is the served entry
 * (public id); `catalog` is every static entry, for the stylesheet freshness check.
 */
export function sectionPreviewCapability(entry: SectionCatalogEntry, catalog: readonly SectionCatalogEntry[], roots: SectionPreviewRoots): ResourceCandidate['previewCapability'] | null {
  if (entry.content.kind === 'vendored-block') {
    const css = compiledCss(roots.hyperuiRoot, catalog);
    if (css.state !== 'ready') return unavailable(css.state === 'stale' ? 'compiled-section-stale' : 'compiled-section-missing');
    const file = blockFile(roots.hyperuiRoot!, entry.content.blockId);
    if (!file || !existsSync(file)) return unavailable('compiled-section-missing');
    return { available: true, kind: 'html', url: sectionPreviewPath(entry.id), reason: null, adapter: 'compiled-html-section' };
  }
  if (entry.content.kind === 'cult-item') {
    if (!roots.cultKitDir) return unavailable('licensed-kit-not-configured');
    const name = cultRegistryName(cultInternalId(entry.id));
    return name && convertedDir(roots.cultKitDir, name) ? { available: true, kind: 'html', url: sectionPreviewPath(entry.id), reason: null, adapter: 'compiled-html-section' } : unavailable('compiled-section-missing');
  }
  return null;
}

/** The Tailwind release `css/preview.css` and the page-kind stylesheets are compiled with. */
export const HYPERUI_TAILWIND_VERSION = '4.3.3';

/**
 * AC-R07 preamble: HyperUI ships numbered designs of one block kind (`application/charts/1…11`);
 * they are variants of each other. Each brings only utilities already compiled into the unit.
 */
export function sectionVariantFields(entry: SectionCatalogEntry): Pick<ResourceCandidate, 'variantGroup' | 'variantLabel' | 'targetDependencies'> {
  if (entry.content.kind !== 'vendored-block') return {};
  const match = /^(.+)\/(\d+)$/u.exec(entry.content.blockId);
  return {
    ...(match ? { variantGroup: `hyperui:${match[1]}`, variantLabel: match[2] } : {}),
    targetDependencies: [{ name: 'tailwindcss', range: HYPERUI_TAILWIND_VERSION, scope: 'compiled' }],
  };
}

export type SectionPreviewDocument =
  | { status: 200; html: string; licensed: boolean }
  | { status: 404 | 422; code: string; message: string; licensed: boolean };

/** The preview document of one served entry. Block bytes are checked against the catalog pin first. */
export function renderSectionPreview(entry: SectionCatalogEntry, catalog: readonly SectionCatalogEntry[], roots: SectionPreviewRoots): SectionPreviewDocument {
  const missing = (licensed: boolean): SectionPreviewDocument => ({ status: 404, code: 'NOT_FOUND', message: 'this section has no compiled preview', licensed });
  if (entry.content.kind === 'vendored-block') {
    const css = compiledCss(roots.hyperuiRoot, catalog);
    const file = roots.hyperuiRoot ? blockFile(roots.hyperuiRoot, entry.content.blockId) : null;
    if (css.state !== 'ready' || !file || !existsSync(file)) return css.state === 'stale'
      ? { status: 422, code: 'SECTION_PREVIEW_STALE', message: 'the compiled section stylesheet does not match the vendored blocks', licensed: false }
      : missing(false);
    const bytes = readFileSync(file);
    if (sha256(bytes) !== entry.content.sha256) return { status: 422, code: 'SECTION_PREVIEW_INTEGRITY', message: 'the vendored block bytes do not match the catalog pin', licensed: false };
    const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
      + `<meta http-equiv="Content-Security-Policy" content="${escapeHtml(SECTION_PREVIEW_DOCUMENT_CSP)}">`
      + `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(entry.title)}</title>`
      + `<style>${css.css.replace(/<\/style/giu, '<\\/style')}</style>`
      + '<style>html,body{margin:0;background:#fff}body{padding:24px}</style></head>'
      + `<body>${bytes.toString('utf8')}</body></html>`;
    return { status: 200, html, licensed: false };
  }
  if (entry.content.kind === 'cult-item') {
    const name = cultRegistryName(cultInternalId(entry.id));
    const html = name ? convertedPreviewHtml(roots.cultKitDir, name, 'light', SECTION_PREVIEW_DOCUMENT_CSP) : null;
    return html === null ? missing(true) : { status: 200, html, licensed: true };
  }
  return missing(false);
}
