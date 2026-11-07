// Encrypted token file: <dataDir>/connectors/native-tokens.json, mode 0600, temp-file-then-rename.
// All access goes through one queue, so read-modify-write never loses a concurrent update.
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import type { Keyring } from './key-source.js';
import { decryptTokens, encryptTokens, type NativeTokens, type TokenEnvelope } from './token-crypto.js';

interface StoredRecord extends TokenEnvelope { connectorId: string; updatedAt: string }
interface Doc { schemaVersion: 1; records: Record<string, StoredRecord> }

export class EncryptedTokenStore {
  private readonly file: string;
  private queue: Promise<unknown> = Promise.resolve();

  /** `getKeyring` rejects (fail closed) when no key is configured. */
  constructor(dataDir: string, private readonly getKeyring: () => Promise<Keyring>) {
    this.file = path.join(dataDir, 'connectors', 'native-tokens.json');
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async read(): Promise<Doc> {
    let text: string;
    try { text = await readFile(this.file, 'utf8'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { schemaVersion: 1, records: {} };
      throw new Error('the connector token file could not be read');
    }
    try {
      const doc = JSON.parse(text) as Doc;
      if (doc.schemaVersion !== 1 || typeof doc.records !== 'object' || doc.records === null) throw new Error('shape');
      return doc;
    } catch {
      throw new Error('the connector token file is malformed');
    }
  }

  private async write(doc: Doc): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await writeFile(tmp, `${JSON.stringify(doc)}\n`, { mode: 0o600 });
      await rename(tmp, this.file);
    } catch (error) {
      await unlink(tmp).catch(() => undefined);
      throw error;
    }
  }

  /** Rejects (fail closed) when no key is configured. */
  async ready(): Promise<void> {
    await this.getKeyring();
  }

  get(connectorId: string, accountId: string): Promise<NativeTokens | undefined> {
    return this.serial(async () => {
      const record = (await this.read()).records[accountId];
      if (!record) return undefined;
      return decryptTokens(await this.getKeyring(), { connectorId, accountId }, record);
    });
  }

  put(connectorId: string, accountId: string, tokens: NativeTokens): Promise<void> {
    return this.serial(async () => {
      const ring = await this.getKeyring();
      const doc = await this.read();
      doc.records[accountId] = { ...encryptTokens(ring, { connectorId, accountId }, tokens), connectorId, updatedAt: new Date().toISOString() };
      await this.write(doc);
    });
  }

  delete(accountId: string): Promise<void> {
    return this.serial(async () => {
      const doc = await this.read();
      if (!(accountId in doc.records)) return;
      delete doc.records[accountId];
      await this.write(doc);
    });
  }

  /** Re-encrypts every record under the current key. Returns how many were rewritten. */
  rotate(): Promise<number> {
    return this.serial(async () => {
      const ring = await this.getKeyring();
      const doc = await this.read();
      let count = 0;
      for (const [accountId, record] of Object.entries(doc.records)) {
        const owner = { connectorId: record.connectorId, accountId };
        const tokens = decryptTokens(ring, owner, record);
        doc.records[accountId] = { ...encryptTokens(ring, owner, tokens), connectorId: record.connectorId, updatedAt: new Date().toISOString() };
        count += 1;
      }
      if (count > 0) await this.write(doc);
      return count;
    });
  }
}
