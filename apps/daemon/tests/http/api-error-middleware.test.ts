import express from 'express';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiErrorMiddleware } from '../../src/http/api-errors.js';

let server: Server | undefined;
let staticRoot: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  if (staticRoot) await fs.rm(staticRoot, { recursive: true, force: true });
  staticRoot = undefined;
});

async function serve(): Promise<string> {
  const app = express();
  app.use(express.json({ limit: '32b' }));
  app.post('/body', (_req, res) => res.json({ ok: true }));
  app.get('/failure', () => { throw new Error('SQLite failed at /private/customer/database.sqlite'); });
  app.get('/untrusted-status', () => { throw Object.assign(new Error('private error'), { status: 400 }); });
  app.get('/http-status/:status', (req) => { throw Object.assign(new Error('private error'), { statusCode: Number(req.params.status) }); });
  app.get('/range', () => { throw Object.assign(new Error('private range'), { statusCode: 416 }); });
  app.get('/decoded/:value', (_req, res) => res.json({ ok: true }));
  staticRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'od-static-range-'));
  await fs.writeFile(path.join(staticRoot, 'file.txt'), 'hello');
  app.use('/static', express.static(staticRoot));
  app.use(apiErrorMiddleware);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return `http://127.0.0.1:${address.port}`;
}

describe('final API error middleware', () => {
  it.each([[401, 'UNAUTHORIZED'], [403, 'FORBIDDEN'], [404, 'NOT_FOUND'], [409, 'CONFLICT'], [429, 'RATE_LIMITED']])('keeps the contract code aligned with HTTP %s', async (status, code) => {
    const base = await serve();
    const response = await fetch(`${base}/http-status/${status}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ error: { code } });
  });
  it.each([500, 503, 399, 400.5])('keeps unrecognised status %s as a safe internal failure', async (status) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = await serve();
    const response = await fetch(`${base}/http-status/${status}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
  });
  it('marks HTTP 429 retryable', async () => {
    const base = await serve();
    expect(await (await fetch(`${base}/http-status/429`)).json()).toMatchObject({ error: { code: 'RATE_LIMITED', retryable: true } });
  });
  it('keeps a real static-file range failure at 416', async () => {
    const base = await serve();
    const response = await fetch(`${base}/static/file.txt`, { headers: { Range: 'bytes=9000-' } });
    expect(response.status).toBe(416);
    expect(await response.json()).toEqual({ error: { code: 'RANGE_NOT_SATISFIABLE', message: 'the requested range is not satisfiable' } });
  });
  it.each([['/untrusted-status', 400], ['/decoded/%ZZ', 400], ['/range', 416]])('honours client HTTP status for %s without leaking details', async (route, status) => {
    const base = await serve();
    const response = await fetch(`${base}${route}`);
    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload).toMatchObject({ error: { message: expect.any(String) } });
    expect(JSON.stringify(payload)).not.toMatch(/private|Failed to decode/);
  });
  it.each([
    ['{"secret":"private-value"', 400, 'BAD_REQUEST'],
    [JSON.stringify({ secret: 'private-value'.repeat(5) }), 413, 'PAYLOAD_TOO_LARGE'],
  ])('returns a safe contract for rejected request bodies (%s)', async (body, status, code) => {
    const base = await serve();
    const response = await fetch(`${base}/body`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload).toEqual({ error: { code, message: expect.any(String) } });
    expect(JSON.stringify(payload)).not.toContain('private-value');
  });

  it.each(['/failure'])('logs unknown errors and returns a safe 500 for %s', async (route) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const base = await serve();
    const response = await fetch(`${base}${route}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'INTERNAL_ERROR', message: expect.any(String) } });
    expect(log).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
  });
});
