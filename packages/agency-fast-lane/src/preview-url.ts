/**
 * The one test a preview URL has to pass before anything hands it to a browser.
 *
 * `meta.previewImage` / `meta.previewVideo` are the only profile values the app turns into a URL
 * the browser loads. Three places decide whether such a value is acceptable — the daemon's
 * `POST /api/design-index` parser, the catalog preview hydration, and the web card builder — and
 * before this module they each had their own rule, so a value the daemon would have refused could
 * still reach a card by way of a hydrated index file.
 *
 * Deliberately dependency-free and browser-safe: no `node:` import, no package import, nothing but
 * the `URL` constructor every runtime has. That is what lets the web bundle import it alongside
 * the daemon and the hydration script.
 *
 * The rule: a string of at most 2048 characters that `new URL` parses as an absolute `https:` URL.
 * `new URL` accepts `javascript:`, `data:` and `http:` happily — the protocol test is what refuses
 * them. No host allowlist: preview sources vary (R2, an image proxy, a CDN) and the app only ever
 * loads these as media, never navigates to them.
 */

/** A URL, not a data blob pasted into the index. */
export const PUBLIC_PREVIEW_URL_MAX_CHARS = 2_048;

/** Why a value is not a public preview URL, for a caller that reports the reason. */
export type PublicPreviewUrlProblem = 'not-a-string' | 'too-long' | 'malformed' | 'not-https';

/**
 * The reason `value` fails, or `undefined` when it passes. `isPublicPreviewUrl` is this function
 * with the reason thrown away; the daemon parser keeps the reason so its 400 names it.
 */
export function publicPreviewUrlProblem(value: unknown): PublicPreviewUrlProblem | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'not-a-string';
  if (value.length > PUBLIC_PREVIEW_URL_MAX_CHARS) return 'too-long';
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'malformed';
  }
  return url.protocol === 'https:' ? undefined : 'not-https';
}

/** Whether `value` is a URL this app may hand to the browser as preview media. */
export function isPublicPreviewUrl(value: unknown): value is string {
  return publicPreviewUrlProblem(value) === undefined;
}
