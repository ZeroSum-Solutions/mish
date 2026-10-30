/**
 * The `fetch` the link-page engine reads creators' sites with. Every hop goes through the daemon's
 * SSRF guard (`fetchExternalBrandAsset`: public hosts only, pinned at connect time, redirects
 * re-checked), with a time limit and a cap on how much of a body is read.
 */
import { fetchExternalBrandAsset } from '../brands/safe-fetch.js';

export const LINKPAGE_FETCH_TIMEOUT_MS = 15_000;
export const LINKPAGE_FETCH_MAX_BYTES = 5 * 1024 * 1024;

export type LinkPageFetch = typeof fetch;
type GuardedFetch = (url: string, init?: RequestInit) => Promise<Response>;

async function readCapped(response: Response, max: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) throw new Error('the response is too large');
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error('the response is too large');
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export function createLinkPageFetch(guarded: GuardedFetch = fetchExternalBrandAsset): LinkPageFetch {
  return (async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(LINKPAGE_FETCH_TIMEOUT_MS)]) : AbortSignal.timeout(LINKPAGE_FETCH_TIMEOUT_MS);
    const response = await guarded(url, { ...init, signal });
    const bytes = await readCapped(response, LINKPAGE_FETCH_MAX_BYTES);
    const headers = new Headers(response.headers);
    headers.delete('content-encoding');
    headers.delete('content-length');
    return new Response(bytes as unknown as ConstructorParameters<typeof Response>[0], { status: response.status, statusText: response.statusText, headers });
  }) as LinkPageFetch;
}
