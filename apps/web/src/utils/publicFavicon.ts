// The one gate in front of the third-party favicon service (audit L8).
//
// Invariant: a value reaches the favicon service only when it parses (through
// the WHATWG URL parser, so IDNA/punycode is validated) to a hostname whose
// last label is a delegated public TLD from the explicit allowlists below: a
// delegated country code or a fixed set of common generic TLDs. Punycode TLDs
// are not admitted; add one to an allowlist only when a real domain needs it.
// Project names, single words, IP addresses, reserved names (.test, .example,
// .localhost, .home.arpa, ...) and unknown TLDs return null, so callers render
// their local fallback and nothing user-named leaves the machine.

const FAVICON_SERVICE = 'https://www.google.com/s2/favicons';

const GENERIC_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'io', 'co', 'ai', 'app', 'dev', 'design',
  'studio', 'agency', 'shop', 'store', 'site', 'online', 'tech', 'xyz', 'info',
  'biz', 'me', 'tv', 'cloud', 'digital', 'health', 'dental', 'clinic', 'care',
  'law', 'finance', 'media', 'news', 'blog', 'page', 'art', 'website', 'style',
  'gallery',
]);

// Delegated two-letter country-code TLDs in the IANA root zone (ISO 3166-1
// alpha-2 codes plus ac, eu, su and uk). Unassigned codes such as aa, xx or zz
// are deliberately absent.
const COUNTRY_CODE_TLDS = new Set([
  'ac', 'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'ao', 'aq', 'ar', 'as', 'at',
  'au', 'aw', 'ax', 'az', 'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj',
  'bm', 'bn', 'bo', 'br', 'bs', 'bt', 'bv', 'bw', 'by', 'bz', 'ca', 'cc',
  'cd', 'cf', 'cg', 'ch', 'ci', 'ck', 'cl', 'cm', 'cn', 'co', 'cr', 'cu', 'cv',
  'cw', 'cx', 'cy', 'cz', 'de', 'dj', 'dk', 'dm', 'do', 'dz', 'ec', 'ee', 'eg',
  'er', 'es', 'et', 'eu', 'fi', 'fj', 'fk', 'fm', 'fo', 'fr', 'ga', 'gb', 'gd',
  'ge', 'gf', 'gg', 'gh', 'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt',
  'gu', 'gw', 'gy', 'hk', 'hm', 'hn', 'hr', 'ht', 'hu', 'id', 'ie', 'il', 'im',
  'in', 'io', 'iq', 'ir', 'is', 'it', 'je', 'jm', 'jo', 'jp', 'ke', 'kg', 'kh',
  'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'ky', 'kz', 'la', 'lb', 'lc', 'li', 'lk',
  'lr', 'ls', 'lt', 'lu', 'lv', 'ly', 'ma', 'mc', 'md', 'me', 'mg', 'mh', 'mk',
  'ml', 'mm', 'mn', 'mo', 'mp', 'mq', 'mr', 'ms', 'mt', 'mu', 'mv', 'mw', 'mx',
  'my', 'mz', 'na', 'nc', 'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr', 'nu',
  'nz', 'om', 'pa', 'pe', 'pf', 'pg', 'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps',
  'pt', 'pw', 'py', 'qa', 're', 'ro', 'rs', 'ru', 'rw', 'sa', 'sb', 'sc', 'sd',
  'se', 'sg', 'sh', 'si', 'sj', 'sk', 'sl', 'sm', 'sn', 'so', 'sr', 'ss', 'st',
  'su', 'sv', 'sx', 'sy', 'sz', 'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl',
  'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tw', 'tz', 'ua', 'ug', 'uk', 'us', 'uy',
  'uz', 'va', 'vc', 've', 'vg', 'vi', 'vn', 'vu', 'wf', 'ws', 'ye', 'yt', 'za',
  'zm', 'zw',
]);

// Reserved or private names. Checked before the allowlist so a reserved name
// can never be admitted by a later allowlist edit.
const RESERVED_TLDS = new Set([
  'test', 'example', 'invalid', 'localhost', 'local', 'internal', 'lan', 'home',
  'corp', 'intranet', 'private', 'arpa', 'onion',
]);

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// A bare host, optionally followed by a path, query or fragment. No port, no
// userinfo, no whitespace.
const BARE_HOST = /^([A-Za-z0-9.-]+)(?:[/?#].*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function isPublicTld(tld: string): boolean {
  if (RESERVED_TLDS.has(tld)) return false;
  return COUNTRY_CODE_TLDS.has(tld) || GENERIC_TLDS.has(tld);
}

function isPublicHostname(host: string): boolean {
  if (host.length === 0 || host.length > 253) return false;
  const labels = host.split('.');
  if (labels.length < 2) return false;
  if (!labels.every((label) => LABEL.test(label))) return false;
  // No punycode (IDN) label: URL parsers disagree on which ones are valid
  // (CI's Node accepted `xn--a.com` where a local build refused it), so an
  // IDN host gets the local fallback glyph and no third-party request.
  if (labels.some((label) => label.startsWith('xn--'))) return false;
  return isPublicTld(labels[labels.length - 1]!);
}

// Parse through the URL parser so bare hosts get the same IDNA validation as
// full URLs; returns the normalized hostname or null.
function parseHttpHostname(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    return url.hostname;
  } catch {
    return null;
  }
}

/**
 * Return the public hostname inside an http(s) URL or a bare host string, or
 * null when the input is not a real public DNS name.
 */
export function publicFaviconHost(input: string | null | undefined): string | null {
  const raw = input?.trim();
  if (!raw || /\s/.test(raw)) return null;

  let host: string | null;
  if (SCHEME.test(raw)) {
    if (!/^https?:\/\//i.test(raw)) return null;
    host = parseHttpHostname(raw);
  } else {
    const match = BARE_HOST.exec(raw);
    host = match ? parseHttpHostname(`https://${match[1]}`) : null;
  }
  if (!host) return null;

  host = host.toLowerCase().replace(/\.$/, '');
  return isPublicHostname(host) ? host : null;
}

/**
 * Favicon-service URL for a real public hostname, else null. Callers render
 * their own fallback (initial, glyph, palette) when this returns null.
 */
export function publicFaviconUrl(input: string | null | undefined, size: number): string | null {
  const host = publicFaviconHost(input);
  if (!host) return null;
  return `${FAVICON_SERVICE}?sz=${size}&domain=${encodeURIComponent(host)}`;
}
