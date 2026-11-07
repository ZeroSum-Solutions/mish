// AES-256-GCM for native connector tokens. Fresh 12-byte nonce per write; the AAD binds a record to
// its connector, account and schema version so a record copied elsewhere does not decrypt.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { Keyring } from './key-source.js';

export const TOKEN_SCHEMA_VERSION = 1 as const;

/** The secret material of one connected account. Never leaves the daemon. */
export interface NativeTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  accessExpiresAt: number;
  refreshExpiresAt: number;
  scope: string;
  openId: string;
}

export interface TokenEnvelope {
  schemaVersion: typeof TOKEN_SCHEMA_VERSION;
  keyId: string;
  nonce: string;
  ciphertext: string;
  tag: string;
}

export interface TokenOwner { connectorId: string; accountId: string }

/** Fixed message: the cause (wrong key, tampering) is deliberately not told apart. */
export class TokenDecryptError extends Error {
  constructor() {
    super('stored connector tokens could not be decrypted; reconnect the account');
    this.name = 'TokenDecryptError';
  }
}

const aad = (owner: TokenOwner, schemaVersion: number): Buffer => Buffer.from(JSON.stringify([owner.connectorId, owner.accountId, schemaVersion]));

export function encryptTokens(ring: Keyring, owner: TokenOwner, tokens: NativeTokens): TokenEnvelope {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', ring.current.key, nonce);
  cipher.setAAD(aad(owner, TOKEN_SCHEMA_VERSION));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return {
    schemaVersion: TOKEN_SCHEMA_VERSION,
    keyId: ring.current.id,
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

export function decryptTokens(ring: Keyring, owner: TokenOwner, envelope: TokenEnvelope): NativeTokens {
  try {
    const entry = ring.byId.get(envelope.keyId);
    if (!entry) throw new Error('unknown key');
    const decipher = createDecipheriv('aes-256-gcm', entry.key, Buffer.from(envelope.nonce, 'base64'));
    decipher.setAAD(aad(owner, envelope.schemaVersion));
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
    const value = JSON.parse(plain.toString('utf8')) as NativeTokens;
    if (typeof value.accessToken !== 'string' || typeof value.refreshToken !== 'string') throw new Error('shape');
    return value;
  } catch {
    throw new TokenDecryptError();
  }
}
