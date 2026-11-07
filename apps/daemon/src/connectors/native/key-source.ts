// Where the token key comes from: OD_CONNECTOR_TOKEN_KEY, then the machine's vault. Like
// storage/agency-config.ts, the vault is the last resort, read lazily, and a failed read is silent
// (it never names the entry). With no key the caller fails closed: nothing is stored in plaintext.
import { createHash } from 'node:crypto';

export const TOKEN_KEY_ENV = 'OD_CONNECTOR_TOKEN_KEY';
export const TOKEN_KEY_PREVIOUS_ENV = 'OD_CONNECTOR_TOKEN_KEY_PREVIOUS';
export const TOKEN_KEY_VAULT_ID = 'od_connector_token_key';
export const TOKEN_KEY_PREVIOUS_VAULT_ID = 'od_connector_token_key_previous';

export class TokenKeyUnavailableError extends Error {
  constructor(message = `no connector token key is configured: set ${TOKEN_KEY_ENV} (32 random bytes, base64 or hex) or add the vault entry ${TOKEN_KEY_VAULT_ID}`) {
    super(message);
    this.name = 'TokenKeyUnavailableError';
  }
}

export interface KeyEntry { id: string; key: Buffer }
export interface Keyring { current: KeyEntry; byId: Map<string, KeyEntry> }

/** A 32-byte key from base64 or hex, or undefined. */
export function parseTokenKey(raw: string): Buffer | undefined {
  const text = raw.trim();
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return Buffer.from(text, 'hex');
  if (/^[A-Za-z0-9+/_-]{42,44}={0,2}$/u.test(text)) {
    const buf = Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    if (buf.length === 32) return buf;
  }
  return undefined;
}

/** A short public id for a key; safe to store next to the ciphertext. */
export function keyIdOf(key: Buffer): string {
  return createHash('sha256').update('mish-token-key-id').update(key).digest('hex').slice(0, 12);
}

/** The first key is current (used to encrypt); the rest only decrypt older records. */
export function buildKeyring(keys: readonly Buffer[]): Keyring {
  const entries = keys.map((key) => ({ id: keyIdOf(key), key }));
  const [current] = entries;
  if (!current) throw new TokenKeyUnavailableError();
  return { current, byId: new Map(entries.map((entry) => [entry.id, entry])) };
}

export interface ResolveKeyringOptions {
  env: Readonly<Record<string, string | undefined>>;
  readVaultSecret: (id: string) => Promise<string>;
}

async function vault(read: (id: string) => Promise<string>, id: string): Promise<string> {
  try {
    const value = await read(id);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

function parseList(raw: string): Buffer[] {
  const keys: Buffer[] = [];
  for (const part of raw.split(',').map((p) => p.trim()).filter(Boolean)) {
    const key = parseTokenKey(part);
    if (!key) throw new TokenKeyUnavailableError(`a previous connector token key is not 32 bytes of base64 or hex`);
    keys.push(key);
  }
  return keys;
}

export async function resolveKeyring(options: ResolveKeyringOptions): Promise<Keyring> {
  const fromEnv = (options.env[TOKEN_KEY_ENV] ?? '').trim();
  let raw = fromEnv;
  if (!raw) raw = await vault(options.readVaultSecret, TOKEN_KEY_VAULT_ID);
  if (!raw) throw new TokenKeyUnavailableError();
  const current = parseTokenKey(raw);
  // A malformed key is an error, not a reason to try the next source: that would hide the mistake.
  if (!current) throw new TokenKeyUnavailableError(`${TOKEN_KEY_ENV} must be 32 bytes, base64 or hex encoded`);
  const previousRaw = (options.env[TOKEN_KEY_PREVIOUS_ENV] ?? '').trim() || (await vault(options.readVaultSecret, TOKEN_KEY_PREVIOUS_VAULT_ID));
  return buildKeyring([current, ...parseList(previousRaw)]);
}
