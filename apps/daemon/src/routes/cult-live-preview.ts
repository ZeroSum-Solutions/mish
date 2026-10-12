/**
 * Live preview — `GET /api/cult/preview/:id` and `GET /api/cult/preview/:id/frame?theme=light|dark`.
 *
 * The Catalog tab's preview modal asks the first whether a Blocks or Components row can preview
 * live (and whether it has a dark theme), then loads the second in a sandboxed iframe:
 *
 * - a section or page row gets the converter's static page for the item
 *   (`convertedPreviewHtml`), served with the family CSP a build ships (`COMPOSED_PAGE_CSP`, also
 *   in the page's own meta tag) plus a `sandbox` directive in the header.
 * - a primitive or app row gets the local preview harness's page for the item's own demo,
 *   started on demand (`CultPreviewHarness`). It runs script, so its CSP allows inline script
 *   and nothing else: no network (`connect-src 'none'`), data/blob media only, and
 *   `sandbox allow-scripts`. A harness that cannot build the item answers a small page that posts
 *   the reason to the modal.
 *
 * The sandbox lives in the response header, not only on the modal's iframe, so the browser gives
 * the page an opaque origin however it is opened: in the modal, from `od cult preview`'s printed
 * frame URL, from a bookmark or from history. Its script can never act as the daemon or web origin.
 * The modal's iframe carries the same sandbox (`""` / `allow-scripts`) as a second layer.
 *
 * Both routes render licensed source, so both answer this machine only, through the same rule
 * as the copy routes (`cultLocalOnlyRefusal`, docs/legal/cult-ui-pro-rights.md). The id is the
 * row's public brand-free slug (`cult:<slug>`, from `generated/slugs.json`); an internal name or
 * `cult:<name>` id still resolves as an alias, as on the copy routes. It only selects a catalog
 * row: the kit path comes from the row's internal name, validated before use, and never reaches a
 * response. Every reason is brand-scrubbed (`cultDisplayText`) before it is sent.
 */

import type { Express, Request, Response } from 'express';
import type { CultPreviewInfoResponse, CultPreviewTheme } from '@open-design/contracts';
import { CULT_PREVIEW_MESSAGE_SOURCE, cultDisplayText, cultLocalOnlyRefusal, cultRegistryName } from '@open-design/contracts';
import { findRealTagOffset, HTML_TAG_PATTERNS } from '@open-design/contracts/runtime/html-injection-points';
import { COMPOSED_PAGE_CSP } from '@open-design/agency-fast-lane/block-compose';
import cultInventoryJson from '@open-design/cult-ui-catalog/catalog.json' with { type: 'json' };

import { BundledCultPreviews } from '../services/bundled-cult-previews.js';
import { resolveCultKitDir } from '../cult-registry.js';
import { cultPreviewPresentationCss } from '../cult-preview-presentation.js';
import { withCultPreviewReadiness } from '../cult-preview-readiness.js';
import { cultSlugs } from './cult-registry.js';
import {
  convertedDir,
  convertedPreviewHtml,
  convertedPreviewMockNote,
  CultHarnessUnavailable,
  CultPreviewHarness,
  escapeHtml,
  resolveCultPreviewHarnessDir,
} from '../cult-live-preview.js';
import type { RouteDeps } from '../server-context.js';

export interface RegisterCultLivePreviewRoutesDeps extends RouteDeps<'http'> {}

export interface CultPreviewRow {
  id: string;
  name: string;
  assetKind: string;
}

export interface CultLivePreviewRouteOptions {
  /** Defaults to the shipped inventory. */
  rows?: readonly CultPreviewRow[];
  /** The server supplies its validated bundled-kit fallback; a bare registrar defaults to `CULT_KIT_DIR`. */
  kitDir?: string | null;
  /** Row id → public slug. Defaults to the catalog package's `generated/slugs.json`. */
  slugs?: ReadonlyMap<string, string>;
  /** Defaults to a harness in `CULT_PREVIEW_HARNESS_DIR` or next to the kit. */
  harness?: Pick<CultPreviewHarness, 'info' | 'page'>;
}

/**
 * The converted frame's header policy: the build CSP plus a sandbox with no permission at all, so
 * even a page opened outside the modal runs no script in an opaque origin.
 */
// Original preview imagery is embedded as data, with no remote image/network permission.
export const CULT_CONVERTED_DOCUMENT_CSP = COMPOSED_PAGE_CSP.replace("img-src 'none'", 'img-src data:');
export const CULT_CONVERTED_FRAME_CSP = `${CULT_CONVERTED_DOCUMENT_CSP}; sandbox`;

/**
 * The harness frame's policy: inline script and style, local media, no network, framed by us
 * only, and sandboxed to scripts in an opaque origin however the page is opened.
 */
export const CULT_HARNESS_FRAME_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  'worker-src blob:',
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "frame-ancestors 'self'",
  'sandbox allow-scripts',
].join('; ');

const CONVERTED_KINDS = new Set(['section', 'page']);
const HARNESS_KINDS = new Set(['primitive', 'app']);

function themeOf(req: Request): CultPreviewTheme {
  return req.query.theme === 'dark' ? 'dark' : 'light';
}

/** A frame that tells the modal why the harness could not render the item. */
function reasonFrame(rawReason: string): string {
  const reason = cultDisplayText(rawReason);
  const message = JSON.stringify({ source: CULT_PREVIEW_MESSAGE_SOURCE, type: 'error', reason }).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head><body><p>${escapeHtml(reason)}</p>`
    + `<script>parent.postMessage(${message}, "*")</script></body></html>`;
}

export function registerCultLivePreviewRoutes(app: Express, ctx: RegisterCultLivePreviewRoutesDeps, options: CultLivePreviewRouteOptions = {}): void {
  const { sendApiError } = ctx.http;
  const rows = options.rows ?? (cultInventoryJson as unknown as { rows: CultPreviewRow[] }).rows;
  const slugs = options.slugs ?? cultSlugs();
  const byName = new Map(rows.map((row) => [row.name, row]));
  const bySlug = new Map(rows.flatMap((row) => {
    const slug = slugs.get(row.id);
    return slug === undefined ? [] : [[slug, row] as const];
  }));
  const kitDir = options.kitDir === undefined ? resolveCultKitDir() : options.kitDir;
  const harness = options.harness ?? (BundledCultPreviews.installed(kitDir)
    ? new BundledCultPreviews(kitDir!)
    : new CultPreviewHarness({ dir: resolveCultPreviewHarnessDir(kitDir), kitDir }));

  const localOnly = (req: Request, res: Response): boolean => {
    const refusal = cultLocalOnlyRefusal({ peer: req.socket.remoteAddress, header: (name) => req.get(name) });
    if (refusal !== null) {
      sendApiError(res, 403, 'FORBIDDEN', `licensed source is served to this machine only: ${refusal}`);
      return false;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return true;
  };

  const rowFor = (req: Request, res: Response): CultPreviewRow | null => {
    const name = cultRegistryName(String(req.params.id ?? ''));
    const row = name === null ? undefined : bySlug.get(name) ?? byName.get(name);
    if (!row || !(CONVERTED_KINDS.has(row.assetKind) || HARNESS_KINDS.has(row.assetKind))) {
      sendApiError(res, 404, 'NOT_FOUND', 'no Cult catalog item with that id');
      return null;
    }
    return row;
  };

  const unavailable = (err: unknown): string =>
    (err instanceof CultHarnessUnavailable ? err.message : `the preview harness failed: ${err instanceof Error ? err.message : String(err)}`);

  app.get('/api/cult/preview/:id', async (req, res) => {
    if (!localOnly(req, res)) return;
    const row = rowFor(req, res);
    if (!row) return;
    let body: CultPreviewInfoResponse;
    if (CONVERTED_KINDS.has(row.assetKind)) {
      body = convertedDir(kitDir, row.name) !== null
        ? { preview: { live: true, mode: 'converted', supportsDark: true, mockNote: convertedPreviewMockNote(kitDir, row.name) } }
        : { preview: { live: false, mode: 'converted', reason: kitDir === null ? 'the licensed source kit is not configured on this machine' : 'the converter has no static page for it' } };
    } else {
      try {
        const info = await harness.info(row.name);
        body = info.live
          ? { preview: { live: true, mode: 'harness', supportsDark: info.supportsDark, mockNote: info.mockNote ? cultDisplayText(info.mockNote) : null } }
          : { preview: { live: false, mode: 'harness', reason: cultDisplayText(info.reason) } };
      } catch (err) {
        body = { preview: { live: false, mode: 'harness', reason: cultDisplayText(unavailable(err)) } };
      }
    }
    res.json(body);
  });

  app.get('/api/cult/preview/:id/frame', async (req, res) => {
    if (!localOnly(req, res)) return;
    const row = rowFor(req, res);
    if (!row) return;
    const theme = themeOf(req);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (CONVERTED_KINDS.has(row.assetKind)) {
      const html = convertedPreviewHtml(kitDir, row.name, theme, CULT_CONVERTED_DOCUMENT_CSP);
      if (html === null) return sendApiError(res, 404, 'NOT_FOUND', 'the converter has no static page for this item');
      res.setHeader('Content-Security-Policy', CULT_CONVERTED_FRAME_CSP);
      return res.type('html').send(html);
    }
    res.setHeader('Content-Security-Policy', CULT_HARNESS_FRAME_CSP);
    try {
      const page = await harness.page(row.name, theme);
      if ('html' in page) {
        const css = cultPreviewPresentationCss(row.name);
        const headEnd = css ? findRealTagOffset(page.html, HTML_TAG_PATTERNS.headClose) : -1;
        const html = headEnd >= 0 ? `${page.html.slice(0, headEnd)}<style>${css}</style>${page.html.slice(headEnd)}` : page.html;
        return res.type('html').send(withCultPreviewReadiness(html));
      }
      return res.status(page.status >= 400 && page.status < 500 ? 422 : 502).type('html').send(reasonFrame(page.reason));
    } catch (err) {
      return res.status(503).type('html').send(reasonFrame(unavailable(err)));
    }
  });
}
