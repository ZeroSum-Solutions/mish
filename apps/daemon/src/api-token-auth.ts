import { timingSafeEqual } from 'node:crypto';

export const API_TOKEN_BASIC_USERNAME = 'mish';
export const API_TOKEN_BASIC_CHALLENGE = 'Basic realm="Mishh Mashh", charset="UTF-8"';

export function isTruthyEnvFlag(value: unknown): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function isApiAuthDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthyEnvFlag(env.OD_DISABLE_API_AUTH);
}

export function apiTokenFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  return (env.OD_API_TOKEN ?? '').trim();
}

export function isApiTokenMiddlewareEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return apiTokenFromEnv(env).length > 0 && !isApiAuthDisabled(env);
}

function secretsMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual, 'utf8');
  const expectedBytes = Buffer.from(expected, 'utf8');
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

const BASE64_PAYLOAD_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isBlank(code: number): boolean {
  return code === 0x20 || code === 0x09;
}

/**
 * Split `<scheme><SP|HTAB>+<token><SP|HTAB>*` in one pass. The previous
 * regex let CodeQL flag the blank runs around the token as polynomial
 * (js/polynomial-redos) because adjacent quantifiers could split a run of
 * blanks in many ways; scanning by index is linear by construction. The
 * scheme match is case-insensitive and the token must be non-empty with no
 * whitespace inside.
 */
function splitAuthorization(value: string, scheme: string): string | null {
  const n = value.length;
  if (n <= scheme.length || value.slice(0, scheme.length).toLowerCase() !== scheme) return null;

  let start = scheme.length;
  if (!isBlank(value.charCodeAt(start))) return null;
  while (start < n && isBlank(value.charCodeAt(start))) start += 1;

  let end = n;
  while (end > start && isBlank(value.charCodeAt(end - 1))) end -= 1;
  if (end === start) return null;

  const token = value.slice(start, end);
  return /\s/.test(token) ? null : token;
}

function decodeBasicCredentials(value: string): { username: string; password: string } | null {
  const encoded = splitAuthorization(value, 'basic');
  if (!encoded || !BASE64_PAYLOAD_RE.test(encoded)) return null;

  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return null;

  const decoded = bytes.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(bytes)) return null;

  const separator = decoded.indexOf(':');
  if (separator < 0) return null;
  return {
    username: decoded.slice(0, separator),
    password: decoded.slice(separator + 1),
  };
}

export function apiTokenAuthorizationMatches(value: unknown, apiToken: string): boolean {
  if (typeof value !== 'string' || apiToken.length === 0) return false;

  const bearer = splitAuthorization(value, 'bearer');
  if (bearer) return secretsMatch(bearer, apiToken);

  const basic = decodeBasicCredentials(value);
  return basic !== null
    && basic.username === API_TOKEN_BASIC_USERNAME
    && secretsMatch(basic.password, apiToken);
}
