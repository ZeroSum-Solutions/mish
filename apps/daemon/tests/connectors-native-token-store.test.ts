// Native connector token store: AES-256-GCM records bound to connector + account, key rotation, fail closed.
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildKeyring, parseTokenKey, resolveKeyring, TokenKeyUnavailableError } from '../src/connectors/native/key-source.js';
import { decryptTokens, encryptTokens, TokenDecryptError } from '../src/connectors/native/token-crypto.js';
import { EncryptedTokenStore } from '../src/connectors/native/token-store.js';

const key = () => randomBytes(32);
const tokens = { accessToken: 'fake-access-1', refreshToken: 'fake-refresh-1', accessExpiresAt: 1000, refreshExpiresAt: 2000, scope: 'user.info.basic', openId: 'open-1' };
const ids = { connectorId: 'tiktok', accountId: 'native-tiktok-abc' };

let dir: string;
beforeEach(async () => { dir = await mkdtemp(path.join(tmpdir(), 'od-native-tokens-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe('token key parsing', () => {
  it('accepts 32 bytes as base64 or hex and nothing else', () => {
    const k = key();
    expect(parseTokenKey(k.toString('base64'))?.equals(k)).toBe(true);
    expect(parseTokenKey(k.toString('hex'))?.equals(k)).toBe(true);
    expect(parseTokenKey(randomBytes(16).toString('hex'))).toBeUndefined();
    expect(parseTokenKey('not a key')).toBeUndefined();
    expect(parseTokenKey('')).toBeUndefined();
  });
});

describe('token crypto', () => {
  it('round-trips and uses a fresh nonce on every write', () => {
    const ring = buildKeyring([key()]);
    const a = encryptTokens(ring, ids, tokens);
    const b = encryptTokens(ring, ids, tokens);
    expect(a.nonce).not.toBe(b.nonce);
    expect(Buffer.from(a.nonce, 'base64')).toHaveLength(12);
    expect(a.keyId).toBe(ring.current.id);
    expect(a.ciphertext).not.toContain('fake-access-1');
    expect(decryptTokens(ring, ids, a)).toEqual(tokens);
  });

  it('detects a changed connector id, account id or schema version (AAD)', () => {
    const ring = buildKeyring([key()]);
    const env = encryptTokens(ring, ids, tokens);
    expect(() => decryptTokens(ring, { ...ids, accountId: 'native-tiktok-other' }, env)).toThrow(TokenDecryptError);
    expect(() => decryptTokens(ring, { ...ids, connectorId: 'instagram' }, env)).toThrow(TokenDecryptError);
    expect(() => decryptTokens(ring, ids, { ...env, schemaVersion: 2 as 1 })).toThrow(TokenDecryptError);
  });

  it('detects tampered ciphertext, nonce or tag', () => {
    const ring = buildKeyring([key()]);
    const env = encryptTokens(ring, ids, tokens);
    const flip = (b64: string) => { const buf = Buffer.from(b64, 'base64'); buf[0] = (buf[0] ?? 0) ^ 1; return buf.toString('base64'); };
    expect(() => decryptTokens(ring, ids, { ...env, ciphertext: flip(env.ciphertext) })).toThrow(TokenDecryptError);
    expect(() => decryptTokens(ring, ids, { ...env, nonce: flip(env.nonce) })).toThrow(TokenDecryptError);
    expect(() => decryptTokens(ring, ids, { ...env, tag: flip(env.tag) })).toThrow(TokenDecryptError);
  });

  it('fails with a fixed message under the wrong key, never naming secrets', () => {
    const env = encryptTokens(buildKeyring([key()]), ids, tokens);
    let message = '';
    try { decryptTokens(buildKeyring([key()]), ids, env); } catch (e) { message = (e as Error).message; }
    expect(message).toMatch(/could not be decrypted/);
    expect(message).not.toContain('fake-access-1');
  });

  it('decrypts with an older key by keyId', () => {
    const oldKey = key();
    const env = encryptTokens(buildKeyring([oldKey]), ids, tokens);
    const rotated = buildKeyring([key(), oldKey]);
    expect(rotated.current.id).not.toBe(env.keyId);
    expect(decryptTokens(rotated, ids, env)).toEqual(tokens);
  });
});

describe('key sources', () => {
  it('prefers the environment, then the vault, and fails closed with neither', async () => {
    const envKey = key(); const vaultKey = key();
    const fromEnv = await resolveKeyring({ env: { OD_CONNECTOR_TOKEN_KEY: envKey.toString('base64') }, readVaultSecret: async () => vaultKey.toString('hex') });
    expect(fromEnv.current.key.equals(envKey)).toBe(true);
    const fromVault = await resolveKeyring({ env: {}, readVaultSecret: async (id) => { expect(id).toBe('od_connector_token_key'); return vaultKey.toString('hex'); } });
    expect(fromVault.current.key.equals(vaultKey)).toBe(true);
    await expect(resolveKeyring({ env: {}, readVaultSecret: async () => { throw new Error('boom'); } })).rejects.toThrow(TokenKeyUnavailableError);
    await expect(resolveKeyring({ env: {}, readVaultSecret: async () => '' })).rejects.toThrow(/OD_CONNECTOR_TOKEN_KEY/);
  });

  it('refuses a malformed environment key instead of falling through to the vault', async () => {
    let vaultRead = false;
    await expect(resolveKeyring({ env: { OD_CONNECTOR_TOKEN_KEY: 'short' }, readVaultSecret: async () => { vaultRead = true; return ''; } })).rejects.toThrow(/32 bytes/);
    expect(vaultRead).toBe(false);
  });

  it('adds previous keys from OD_CONNECTOR_TOKEN_KEY_PREVIOUS (comma separated)', async () => {
    const a = key(); const b = key(); const c = key();
    const ring = await resolveKeyring({ env: { OD_CONNECTOR_TOKEN_KEY: a.toString('hex'), OD_CONNECTOR_TOKEN_KEY_PREVIOUS: `${b.toString('hex')}, ${c.toString('base64')}` }, readVaultSecret: async () => '' });
    expect(ring.byId.size).toBe(3);
  });
});

describe('EncryptedTokenStore', () => {
  const file = () => path.join(dir, 'connectors', 'native-tokens.json');

  it('round-trips, writes mode 0600 and never holds plaintext on disk', async () => {
    const ring = buildKeyring([key()]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    await store.put(ids.connectorId, ids.accountId, tokens);
    expect(await store.get(ids.connectorId, ids.accountId)).toEqual(tokens);
    const raw = await readFile(file(), 'utf8');
    expect(raw).not.toContain('fake-access-1');
    expect(raw).not.toContain('fake-refresh-1');
    expect((await stat(file())).mode & 0o777).toBe(0o600);
  });

  it('fails closed when no key is available and writes nothing', async () => {
    const store = new EncryptedTokenStore(dir, async () => { throw new TokenKeyUnavailableError(); });
    await expect(store.put(ids.connectorId, ids.accountId, tokens)).rejects.toThrow(TokenKeyUnavailableError);
    await expect(readFile(file(), 'utf8')).rejects.toThrow();
  });

  it('reads as missing for an unknown account and refuses a record moved to another account', async () => {
    const ring = buildKeyring([key()]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    expect(await store.get('tiktok', 'native-tiktok-nope')).toBeUndefined();
    await store.put(ids.connectorId, ids.accountId, tokens);
    const doc = JSON.parse(await readFile(file(), 'utf8'));
    doc.records['native-tiktok-moved'] = doc.records[ids.accountId];
    await writeFile(file(), JSON.stringify(doc), { mode: 0o600 });
    await expect(store.get('tiktok', 'native-tiktok-moved')).rejects.toThrow(TokenDecryptError);
  });

  it('rotates every record to the new current key', async () => {
    const oldKey = key(); const newKey = key();
    await new EncryptedTokenStore(dir, async () => buildKeyring([oldKey])).put(ids.connectorId, ids.accountId, tokens);
    const ring = buildKeyring([newKey, oldKey]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    expect(await store.rotate()).toBe(1);
    expect(JSON.parse(await readFile(file(), 'utf8')).records[ids.accountId].keyId).toBe(ring.current.id);
    expect(await new EncryptedTokenStore(dir, async () => buildKeyring([newKey])).get(ids.connectorId, ids.accountId)).toEqual(tokens);
  });

  it('delete removes the record', async () => {
    const ring = buildKeyring([key()]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    await store.put(ids.connectorId, ids.accountId, tokens);
    await store.delete(ids.accountId);
    expect(await store.get(ids.connectorId, ids.accountId)).toBeUndefined();
  });

  it('serializes concurrent writes so none is lost', async () => {
    const ring = buildKeyring([key()]);
    const store = new EncryptedTokenStore(dir, async () => ring);
    await Promise.all(['a', 'b', 'c', 'd'].map((n) => store.put('tiktok', `native-tiktok-${n}`, { ...tokens, openId: n })));
    for (const n of ['a', 'b', 'c', 'd']) expect((await store.get('tiktok', `native-tiktok-${n}`))?.openId).toBe(n);
  });
});
