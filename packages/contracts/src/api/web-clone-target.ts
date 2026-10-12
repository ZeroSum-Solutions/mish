// Website Clone target URLs (D15). A Website Clone brief is free text — Home
// seeds "Website URL to clone: " and the user types after it — so the clone
// targets are the web addresses the brief names. Web and daemon share this
// one reading: Home refuses a brief that names no address before it calls
// create, and POST /api/projects refuses the same brief, or one naming any
// address that is not public, with REFERENCE_URL_REFUSED before it creates a
// project.
//
// This is a best-effort pre-check on user intent, not an SSRF or DNS-rebinding
// control: the agent later fetches with its own tools, and those carry their
// own network policy.

const EXPLICIT_URL = /\bhttps?:\/\/[^\s<>"'`]+/gi;
// A bare host such as `example.com` or `docs.example.com/pricing`, not preceded
// or followed by a character that would make it part of an email address
// (either side of `@`), a path or a longer word.
const BARE_HOST =
  /(?:^|[^\w.@/:=&?#%-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+([a-z]{2,63})(?::\d{1,5})?(?:[/?#][^\s<>"'`]*)?)(?![\w@-])/gi;
const TRAILING_PUNCTUATION = /[.,;:!?\]}'"。，；：！？）]$/u;
// Endings that make a bare `name.ext` token a file name, not a web host.
const FILE_LIKE_TLDS = new Set([
  'txt', 'md', 'markdown', 'html', 'htm', 'xhtml', 'js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx',
  'css', 'scss', 'less', 'json', 'yaml', 'yml', 'toml', 'xml', 'csv', 'tsv', 'log', 'ini', 'cfg', 'conf',
  'zip', 'gz', 'tgz', 'tar', 'rar', '7z', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp',
  'tif', 'tiff', 'heic', 'avif', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'key', 'pages',
  'mp3', 'mp4', 'mov', 'wav', 'webm', 'avi', 'mkv', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'php',
  'sh', 'bat', 'exe', 'dmg', 'pkg', 'apk', 'jar', 'lock', 'env', 'sql', 'db', 'sqlite', 'woff', 'woff2',
  'ttf', 'otf', 'eot', 'map', 'vue', 'svelte', 'astro', 'psd', 'ai', 'sketch', 'fig',
]);

/** Drop trailing sentence punctuation, keeping a `)` the URL itself opened. */
function trimTrailing(candidate: string): string {
  let out = candidate;
  for (;;) {
    if (out.endsWith(')')) {
      const opens = out.split('(').length - 1;
      const closes = out.split(')').length - 1;
      if (closes > opens) { out = out.slice(0, -1); continue; }
      return out;
    }
    if (TRAILING_PUNCTUATION.test(out)) { out = out.slice(0, -1); continue; }
    return out;
  }
}

function hostLooksAddressable(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '');
  if (host.includes(':')) return true; // IPv6 literal
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return true; // IPv4 literal
  return /\.[a-z]{2,63}$/i.test(host) || host === 'localhost';
}

function normalizeCandidate(candidate: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(trimTrailing(candidate));
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!parsed.hostname || !hostLooksAddressable(parsed.hostname)) return null;
  return parsed.toString();
}

/**
 * Every http(s) URL a Website Clone brief names, in order: explicit
 * `http(s)://` addresses, then bare domains read as `https://<domain>`
 * (file-like names such as `notes.txt` are not domains). Empty when the brief
 * names none. A syntactic reading only — whether each address is public is
 * the daemon's call.
 */
export function extractWebCloneTargetUrls(brief: string): string[] {
  if (typeof brief !== 'string') return [];
  const urls: string[] = [];
  const add = (url: string | null) => { if (url && !urls.includes(url)) urls.push(url); };
  for (const match of brief.matchAll(EXPLICIT_URL)) add(normalizeCandidate(match[0]));
  // Blank out explicit URLs so their paths and queries are not re-read as hosts.
  const rest = brief.replace(EXPLICIT_URL, ' ');
  for (const match of rest.matchAll(BARE_HOST)) {
    const tld = (match[2] ?? '').toLowerCase();
    if (FILE_LIKE_TLDS.has(tld)) continue;
    add(normalizeCandidate(`https://${match[1]}`));
  }
  return urls;
}

/** The first URL a Website Clone brief names, or `null` when it names none. */
export function extractWebCloneTargetUrl(brief: string): string | null {
  return extractWebCloneTargetUrls(brief)[0] ?? null;
}
