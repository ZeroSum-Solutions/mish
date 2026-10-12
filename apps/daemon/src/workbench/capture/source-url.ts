/**
 * Provenance URL for a capture. Only http(s) origin and path survive:
 * credentials, query strings and fragments often carry session tokens, so they
 * are dropped rather than stored. Other schemes (file:, data:, about:) are not
 * a public source and are omitted entirely.
 */
export function redactSourceUrl(raw: string | null | undefined): { sourceUrl: string | null; redacted: boolean } {
  if (raw === null || raw === undefined || raw.trim() === '') return { sourceUrl: null, redacted: false };
  let url: URL;
  try { url = new URL(raw.trim()); } catch { return { sourceUrl: null, redacted: true }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { sourceUrl: null, redacted: true };
  const redacted = Boolean(url.username || url.password || url.search || url.hash);
  const value = `${url.protocol}//${url.host}${url.pathname}`;
  if (value.length > 2048 || /[\p{Cc}]/u.test(value)) return { sourceUrl: null, redacted: true };
  return { sourceUrl: value, redacted };
}
