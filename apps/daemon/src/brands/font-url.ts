// A brand's font stylesheet URL is interpolated into the registered DESIGN.md,
// which every prompt path receives verbatim. It therefore has to be a plain
// URL token and nothing else: no whitespace or control characters that could
// open a new markdown block, no characters outside RFC 3986, and only a font
// host the daemon knows how to load from. Hosts match exactly: a subdomain or
// a lookalike suffix is a different host.

const FONT_STYLESHEET_HOSTS = new Set([
  'fonts.googleapis.com',
  'fonts.bunny.net',
  'use.typekit.net',
  'api.fontshare.com',
]);
const URL_TOKEN_RE = /^[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+$/;
const MAX_FONT_URL_LENGTH = 2048;

/**
 * Return `raw` (with any `|` percent-encoded) when it is a well-formed https
 * stylesheet URL on an allowed font host, otherwise null. Callers omit the
 * field on null rather than repair the URL.
 */
export function safeFontStylesheetUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  // Bunny Fonts separates families with a raw `|`; its percent-encoded form
  // is the same request and keeps the URL inside RFC 3986.
  const url = raw.replace(/\|/g, '%7C');
  if (!url || url.length > MAX_FONT_URL_LENGTH || !URL_TOKEN_RE.test(url)) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port) return null;
  if (!FONT_STYLESHEET_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return url;
}
