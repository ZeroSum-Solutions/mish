/**
 * Strip credentials from media failure text before it is stored or shown.
 *
 * Provider adapters put the upstream response body into their error message,
 * and upstream bodies routinely echo signed download URLs, bearer tokens and
 * API keys. That text lands in `media_tasks`, in the durable media history
 * (which outlives the hourly task sweep), in API responses and in CLI output.
 * Every write and every read of a media task error passes through here.
 *
 * What survives is what a person needs to triage: the URL's origin and path,
 * the HTTP status, the provider's own sentence. What goes:
 * - URL userinfo, query string and fragment (signatures, credentials, tokens);
 * - `Bearer <token>` / `Basic <token>`;
 * - provider-key shapes (`sk-…`, `sk_live_…`, `pk_…`, `rk_…`), JWTs and AWS
 *   access-key ids;
 * - `name=value` / `name: value` pairs whose name says credential (api key,
 *   token, secret, password, signature, credential, AWS signing params).
 *
 * The function is idempotent: redacted text redacts to itself.
 */

const REDACTED = '[REDACTED]';

const URL_RE = /\b[a-z][a-z0-9+.-]{1,15}:\/\/[^\s"'<>`)\]}]+/gi;
const AUTH_SCHEME_RE = /\b(Bearer|Basic|Token)\s+(?!\[REDACTED\])[A-Za-z0-9._~+/=-]{6,}/g;
const PROVIDER_KEY_RE = /\b(?:sk|pk|rk)[-_](?:live[-_]|test[-_]|proj[-_]|ant[-_])?[A-Za-z0-9_-]{8,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g;
const AWS_KEY_ID_RE = /\b(?:AKIA|ASIA)[A-Z0-9]{12,}\b/g;
const CREDENTIAL_PAIR_RE =
  /\b((?:x-amz-)?(?:api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|signature|credential|security[_-]?token|session[_-]?token|authorization))(["']?\s*[=:]\s*["']?)(?!\[REDACTED\]|(?:Bearer|Basic|Token)\s)[^\s"'&,;)]+/gi;

function redactUrl(raw: string): string {
  // Keep trailing sentence punctuation outside the URL.
  const trailing = /[.,;:!?]+$/.exec(raw)?.[0] ?? '';
  const candidate = trailing ? raw.slice(0, -trailing.length) : raw;
  try {
    const url = new URL(candidate);
    const hadSecrets = url.username || url.password || url.search || url.hash;
    if (!hadSecrets) return raw;
    return `${url.origin}${url.pathname}${trailing}`;
  } catch {
    return `${REDACTED}${trailing}`;
  }
}

export function redactMediaErrorText(text: string): string {
  if (!text) return text;
  return text
    .replace(URL_RE, redactUrl)
    .replace(AUTH_SCHEME_RE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    .replace(JWT_RE, REDACTED)
    .replace(PROVIDER_KEY_RE, REDACTED)
    .replace(AWS_KEY_ID_RE, REDACTED)
    .replace(CREDENTIAL_PAIR_RE, (_match, name: string, separator: string) => `${name}${separator}${REDACTED}`);
}

/**
 * Redact a serialized error object (`{"message": …}`) as stored in a JSON
 * column. Returns the input unchanged when nothing needed redacting or the
 * value is not an error object.
 */
export function redactMediaErrorJson(json: string | null): string | null {
  if (!json) return json;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return json;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return json;
  const error = parsed as Record<string, unknown>;
  if (typeof error.message !== 'string') return json;
  const message = redactMediaErrorText(error.message);
  return message === error.message ? json : JSON.stringify({ ...error, message });
}
