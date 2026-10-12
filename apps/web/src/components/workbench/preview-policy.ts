import { findRealTagEnd, HTML_TAG_PATTERNS } from '@mish/contracts/runtime/html-injection-points';

/**
 * AC-R07 preamble ("no CDN Tailwind") and the batch-4 preview model: the floor policy every
 * Enlarge HTML preview runs under, whatever the route answered. It is added next to the route's
 * own policy, and a browser enforces every policy it is given, so a looser route policy can never
 * re-admit another origin. Nothing loads from any other origin and the document opens no
 * connection at all (`connect-src 'none'`).
 *
 * `connect-src` does not cover `<img>`, `<script>`, `<link>` or media, so local sources are not
 * the origin either: they are only the exact asset paths the preview's own route serves
 * (`previewAssetSources`). A preview can therefore never make a GET to any other `/api` route.
 */
export function previewFloorPolicy(origin: string, previewPathname = ''): string {
  const { assets, media } = previewAssetSources(origin, previewPathname);
  const local = (sources: readonly string[]) => sources.map((source) => ` ${source}`).join('');
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline' 'unsafe-eval' blob:${local(assets)}`,
    `style-src 'unsafe-inline' blob:${local(assets)}`,
    `img-src data: blob:${local([...assets, ...media])}`,
    `font-src data: blob:${local(assets)}`,
    `media-src data: blob:${local([...assets, ...media])}`,
    "connect-src 'none'",
    'worker-src blob:',
    "frame-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "manifest-src 'none'",
  ].join('; ');
}

/** A path segment that is safe to place verbatim in a CSP source expression. */
const SEGMENT = /^[A-Za-z0-9._~%-]+$/u;

/**
 * The local URL prefixes a preview route's document may load subresources from:
 * - a plugin preview or example: its own `asset/` directory (the daemon rewrites relative
 *   references there), and for images and media the existing remote-media proxy
 *   (`/api/asset-cache`, media types only, never script, CSS or fonts);
 * - a design-system preview or package page: that kit's package files (`static` and `static/`);
 * - an owned import's stored file (AC-R12.4): that import's own stored files (`imports/<id>/files/`);
 * - every other preview (GenUI demos, compiled sections, token specimens, GSAP recipes, React95
 *   kit templates, AC-R17.2): none — those documents are self-contained.
 * Neither prefix holds a route that redirects to an arbitrary target, so CSP's redirect rule
 * (path ignored after a redirect) cannot carry a load outside them.
 */
export function previewAssetSources(origin: string, pathname: string): { assets: string[]; media: string[] } {
  if (!/^https?:\/\/[^\s;,'"/]+$/u.test(origin)) return { assets: [], media: [] };
  const plugin = /^\/api\/plugins\/([^/]+)\/(?:preview|example\/[^/]+)$/u.exec(pathname);
  if (plugin && SEGMENT.test(plugin[1]!)) return { assets: [`${origin}/api/plugins/${plugin[1]}/asset/`], media: [`${origin}/api/asset-cache`] };
  const kit = /^\/api\/design-systems\/([^/]+)\/(?:preview|static\/.+)$/u.exec(pathname);
  if (kit && SEGMENT.test(kit[1]!)) return { assets: [`${origin}/api/design-systems/${kit[1]}/static`, `${origin}/api/design-systems/${kit[1]}/static/`], media: [] };
  const owned = /^\/api\/workbench\/imports\/(import-[a-f0-9]{16})\/files\/.+$/u.exec(pathname);
  if (owned) return { assets: [`${origin}/api/workbench/imports/${owned[1]}/files/`], media: [] };
  return { assets: [], media: [] };
}

const escapeAttribute = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** Each policy becomes a meta tag at the very start of the real head, before any author tag. */
export function withHeadPolicies(html: string, policies: readonly string[]): string {
  const metas = policies.map((policy) => `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy)}">`).join('');
  if (!metas) return html;
  const headEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  return headEnd >= 0 ? html.slice(0, headEnd) + metas + html.slice(headEnd) : `<!doctype html><html><head>${metas}</head><body>${html}</body></html>`;
}
