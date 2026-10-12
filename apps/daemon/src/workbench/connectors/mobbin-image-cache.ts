import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseConnectorDetailResponse, type ConnectorReferenceDetailResponse, type ConnectorResource } from '@mish/contracts';
import { ConnectorError } from './connector-error.js';

export const MOBBIN_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
const KEY = /^[a-f0-9]{64}$/u;
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const invalid = () => new ConnectorError(422, 'connector-image-invalid', 'Mobbin image must be a bounded PNG, JPEG or WebP from a Mobbin host; search again if the URL expired');

/** HTTPS Mobbin-owned hosts only. No custom port, credentials, fragment or lookalike suffix. */
export function mobbinImageUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash) return null;
    if (url.hostname !== 'mobbin.com' && !url.hostname.endsWith('.mobbin.com')) return null;
    return url.toString();
  } catch { return null; }
}

function matchesType(bytes: Buffer, type: string): boolean {
  if (type === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return type === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}

/** Bounded reads, no symlink targets; filenames come only from validated hashes. */
async function readBounded(file: string, max: number): Promise<Buffer> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > max) throw invalid();
    const bytes = Buffer.alloc(max + 1);
    let total = 0;
    while (total < bytes.length) {
      const { bytesRead } = await handle.read(bytes, total, bytes.length - total, null);
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > max) throw invalid();
    return bytes.subarray(0, total);
  } finally { await handle.close(); }
}

interface CacheRecord {
  schema: 'mobbin-image/1'; sourceUrl: string; fetchedAt: string;
  resource: ConnectorResource;
  detail: ConnectorReferenceDetailResponse;
}
export interface MobbinImageCacheDeps { dataDir: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: () => number }

/** Private selected bytes derive from the resolved daemon data root, outside public static trees. */
export class MobbinImageCache {
  readonly #dir: string;
  readonly #pending = new Map<string, Promise<ConnectorReferenceDetailResponse>>();
  constructor(readonly deps: MobbinImageCacheDeps) { this.#dir = path.join(deps.dataDir, 'workbench', 'connectors', 'mobbin'); }
  key(itemId: string, capturedAt: string): string { return sha(JSON.stringify([itemId, capturedAt])); }

  /** A provider revocation remains closed across restart until a fresh search succeeds. */
  async revoked(): Promise<boolean> {
    try { await readBounded(path.join(this.#dir, 'revoked'), 100); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  async revoke(): Promise<void> { await mkdir(this.#dir, { recursive: true, mode: 0o700 }); await this.#atomic('revoked', Buffer.from('revoked')); }
  async allow(): Promise<void> { await rm(path.join(this.#dir, 'revoked'), { force: true }); }

  async read(key: string): Promise<{ detail: ConnectorReferenceDetailResponse; bytes: Buffer } | null> {
    if (!KEY.test(key)) throw invalid();
    try {
      const record = JSON.parse((await readBounded(path.join(this.#dir, `${key}.json`), 64 * 1024)).toString('utf8')) as CacheRecord;
      const detail = parseConnectorDetailResponse(record.detail);
      const image = detail.resource.cachedImage;
      if (record.schema !== 'mobbin-image/1' || !mobbinImageUrl(record.sourceUrl) || !image || detail.connectorId !== 'mobbin'
        || image.url !== `/api/workbench/connectors/mobbin/images/${key}` || image.fetchedAt !== record.fetchedAt
        || this.key(detail.resource.itemId, detail.resource.capturedAt) !== key) throw invalid();
      const bytes = await readBounded(path.join(this.#dir, `${image.sha256}.blob`), MOBBIN_IMAGE_MAX_BYTES);
      if (bytes.length !== image.byteLength || sha(bytes) !== image.sha256 || !matchesType(bytes, image.contentType)) throw invalid();
      return { detail, bytes };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new ConnectorError(503, 'connector-cache-unavailable', 'The saved Mobbin image cannot be verified; search and select again');
    }
  }

  async select(detail: ConnectorReferenceDetailResponse, sourceUrl: unknown): Promise<ConnectorReferenceDetailResponse> {
    const key = this.key(detail.resource.itemId, detail.resource.capturedAt);
    const existing = await this.read(key);
    if (existing) return existing.detail;
    const pending = this.#pending.get(key);
    if (pending) return pending;
    const work = this.#download(key, detail, sourceUrl);
    this.#pending.set(key, work);
    try { return await work; } finally { this.#pending.delete(key); }
  }

  async #download(key: string, detail: ConnectorReferenceDetailResponse, rawUrl: unknown): Promise<ConnectorReferenceDetailResponse> {
    const sourceUrl = mobbinImageUrl(rawUrl);
    if (!sourceUrl) throw invalid();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deps.timeoutMs ?? 15_000);
    try {
      let url = sourceUrl;
      let response: Response;
      for (let redirects = 0; ; redirects++) {
        response = await (this.deps.fetchImpl ?? fetch)(url, { signal: controller.signal, redirect: 'manual' });
        if (![301, 302, 303, 307, 308].includes(response.status)) break;
        const location = response.headers.get('location');
        await response.body?.cancel();
        if (!location || redirects >= 3) throw invalid();
        const next = mobbinImageUrl(new URL(location, url).toString());
        if (!next) throw invalid();
        url = next;
      }
      const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
      const length = response.headers.get('content-length');
      if (!response.ok || !['image/png', 'image/jpeg', 'image/webp'].includes(type ?? '') || !response.body
        || (length !== null && (!/^\d+$/u.test(length) || Number(length) > MOBBIN_IMAGE_MAX_BYTES))) {
        await response.body?.cancel(); throw invalid();
      }
      const reader = response.body.getReader();
      const chunks: Buffer[] = []; let size = 0;
      try {
        while (true) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > MOBBIN_IMAGE_MAX_BYTES) throw invalid();
          chunks.push(Buffer.from(chunk.value));
        }
      } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
      const bytes = Buffer.concat(chunks);
      if (!matchesType(bytes, type!)) throw invalid();
      const fetchedAt = new Date((this.deps.now ?? Date.now)()).toISOString();
      const digest = sha(bytes);
      const selected = parseConnectorDetailResponse({ ...detail, resource: { ...detail.resource, cachedImage: {
        url: `/api/workbench/connectors/mobbin/images/${key}`, fetchedAt, sha256: digest, contentType: type, byteLength: bytes.length,
      } } });
      const record: CacheRecord = { schema: 'mobbin-image/1', sourceUrl, fetchedAt, resource: selected.resource, detail: selected };
      await mkdir(this.#dir, { recursive: true, mode: 0o700 });
      await this.#atomic(`${digest}.blob`, bytes);
      await this.#atomic(`${key}.json`, Buffer.from(JSON.stringify(record)));
      return selected;
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      if (controller.signal.aborted) throw new ConnectorError(504, 'connector-timeout', 'Mobbin image download timed out', { retryable: true });
      throw new ConnectorError(503, 'connector-cache-unavailable', 'Mobbin image could not be saved; select again');
    } finally { clearTimeout(timer); }
  }

  async #atomic(name: string, bytes: Buffer): Promise<void> {
    const temporary = path.join(this.#dir, `.${randomUUID()}.tmp`);
    try { await writeFile(temporary, bytes, { mode: 0o600, flag: 'wx' }); await rename(temporary, path.join(this.#dir, name)); }
    finally { await rm(temporary, { force: true }); }
  }
}
