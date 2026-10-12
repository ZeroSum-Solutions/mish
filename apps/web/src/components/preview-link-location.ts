/**
 * Location carried by a same-project HTML link clicked inside a preview
 * (`index.html?tab=2#work`). The preview bridge reports it in the
 * `od:preview-open-file` message; the host opens `index.html` and the opened
 * preview applies this location so the page lands on `#work` instead of the
 * top.
 *
 * Both parts come from an untrusted document, so each one either passes a
 * strict shape check or becomes `''`. A rejected part never blocks the open:
 * the file still opens, just without that part. An empty location is a
 * plain link: the opened preview shows the page from the top.
 *
 * The URL-load preview applies both parts to its iframe src. A srcDoc
 * document has no URL of its own, so there only the fragment applies: the
 * frame's bridge navigates to it once the document is ready.
 */
export interface PreviewLinkLocation {
  /** `''` or a query string that starts with `?`. */
  search: string;
  /** `''` or a fragment that starts with `#` and names a target. */
  hash: string;
}

/**
 * A navigation the workspace asks one opened preview to perform. Each link
 * click gets a new nonce, so clicking the same link again navigates again.
 */
export interface PreviewLocationRequest extends PreviewLinkLocation {
  /** Increments per request so a repeated link click applies again. */
  nonce: number;
}

export const PREVIEW_LINK_HASH_MAX_LENGTH = 256;
export const PREVIEW_LINK_SEARCH_MAX_LENGTH = 1024;

// Kept in sync with the bridge copies in apps/daemon/src/routes/project/index.ts
// and apps/web/src/runtime/srcdoc.ts, which re-check the hash in the frame.
// Well-formed `%XX` escapes are allowed so ids such as `billing details` or
// `Résumé` (`#billing%20details`, `#R%C3%A9sum%C3%A9`) still resolve.
const PREVIEW_LINK_HASH_PATTERN = /^#(?:[A-Za-z0-9_:.-]|%[0-9A-Fa-f]{2})*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export function sanitizePreviewLinkHash(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length < 2 || value.length > PREVIEW_LINK_HASH_MAX_LENGTH) return '';
  return PREVIEW_LINK_HASH_PATTERN.test(value) ? value : '';
}

export function sanitizePreviewLinkSearch(value: unknown): string {
  if (typeof value !== 'string') return '';
  if (value.length < 2 || value.length > PREVIEW_LINK_SEARCH_MAX_LENGTH) return '';
  if (value.charAt(0) !== '?' || value.includes('#')) return '';
  return CONTROL_CHARACTER_PATTERN.test(value) ? '' : value;
}

export function sanitizePreviewLinkLocation(input: {
  search?: unknown;
  hash?: unknown;
}): PreviewLinkLocation {
  return {
    search: sanitizePreviewLinkSearch(input.search),
    hash: sanitizePreviewLinkHash(input.hash),
  };
}

/**
 * Apply a link location to a URL-load preview src. The link's query params
 * are appended after the host's own transport params, and its fragment goes
 * last so the browser scrolls to it and the page reads it from
 * `location.hash` on load.
 */
export function applyPreviewLinkLocationToSrc(
  src: string,
  location: PreviewLinkLocation | null | undefined,
): string {
  if (!location || src === 'about:blank') return src;
  const search = sanitizePreviewLinkSearch(location.search);
  const hash = sanitizePreviewLinkHash(location.hash);
  if (!search && !hash) return src;
  const hashIndex = src.indexOf('#');
  let next = hashIndex >= 0 ? src.slice(0, hashIndex) : src;
  if (search) next = `${next}${next.includes('?') ? '&' : '?'}${search.slice(1)}`;
  return `${next}${hash}`;
}
