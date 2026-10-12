// AC-R12.4: an owned import is advertised up to OWNED_IMPORT_LIMITS.bytes of
// file bytes, sent as base64 inside JSON. Base64 alone makes that 4/3 larger,
// so an import near the limit is over the daemon's global 4mb JSON ceiling. The
// route needs its own bounded parser, mounted before the global one; only a
// real startServer() app over a real socket can observe that mount order.
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OWNED_IMPORT_LIMITS } from '@open-design/contracts';

let daemon: http.Server | undefined;
let daemonShutdown: (() => Promise<void> | void) | undefined;
let baseUrl = '';
let dataDir = '';
const PREV_DATA_DIR = process.env.OD_DATA_DIR;

function post(url: string, body: string): Promise<{ status: number | null; body: string; transportError: string | null }> {
  return new Promise((resolve) => {
    const target = new URL(url);
    const req = http.request({
      hostname: target.hostname, port: target.port, path: target.pathname, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? null, body: Buffer.concat(chunks).toString('utf8'), transportError: null }));
      res.on('error', () => resolve({ status: res.statusCode ?? null, body: '', transportError: 'response_stream_error' }));
    });
    req.on('error', (error: NodeJS.ErrnoException) => resolve({ status: null, body: '', transportError: error.code ?? error.message }));
    req.end(body);
  });
}

function importOf(fileBytes: number[]): string {
  const files = fileBytes.map((size, index) => ({
    path: index === 0 ? 'index.html' : `assets/part-${index}.bin`,
    contentBase64: Buffer.alloc(size, index === 0 ? 0x3c : 0x61).toString('base64'),
  }));
  return JSON.stringify({ provider: 'magic-patterns', name: 'Large export', entryPath: 'index.html', ownership: { declaration: 'owner-provided-export', exportedFrom: null }, files });
}

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(os.tmpdir(), 'od-owned-import-body-limit-'));
  process.env.OD_DATA_DIR = dataDir;
  const { startServer } = await import('../../src/server.js');
  const started = (await startServer({ port: 0, host: '127.0.0.1', returnServer: true })) as { url: string; server: http.Server; shutdown?: () => Promise<void> | void };
  baseUrl = started.url; daemon = started.server; daemonShutdown = started.shutdown;
});

afterEach(async () => {
  if (daemonShutdown) await Promise.race([Promise.resolve(daemonShutdown()), new Promise((resolve) => setTimeout(resolve, 2000))]);
  daemon?.closeAllConnections?.();
  if (daemon) await new Promise<void>((resolve) => daemon!.close(() => resolve()));
  daemon = undefined; daemonShutdown = undefined;
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  if (PREV_DATA_DIR === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = PREV_DATA_DIR;
}, 20_000);

describe('owned import body limit, through the real express app', () => {
  it('accepts an import just under the advertised byte limit even though its JSON exceeds 4mb', async () => {
    // 64 files that together hold the advertised limit minus a little: the worst JSON overhead an accepted import can carry.
    const per = Math.floor((OWNED_IMPORT_LIMITS.bytes - 1024) / OWNED_IMPORT_LIMITS.files);
    const body = importOf(Array.from({ length: OWNED_IMPORT_LIMITS.files }, () => per));
    expect(Buffer.byteLength(body)).toBeGreaterThan(4 * 1024 * 1024);
    const result = await post(`${baseUrl}/api/workbench/imports`, body);
    expect({ status: result.status, transportError: result.transportError }, result.body.slice(0, 300)).toEqual({ status: 201, transportError: null });
    expect(JSON.parse(result.body)).toMatchObject({ schema: 'owned-import/1', files: expect.any(Array) });
  }, 60_000);

  it('still refuses a body far past what any valid import can be', async () => {
    const result = await post(`${baseUrl}/api/workbench/imports`, importOf([12 * 1024 * 1024]));
    expect(result.status === 413 || result.transportError !== null, `${result.status} ${result.transportError}`).toBe(true);
  }, 60_000);
});
