import http from 'node:http';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  API_RATE_LIMIT_DEFAULT_MAX,
  apiRateLimitMaxFromEnv,
  createApiRateLimiter,
} from '../src/http/api-rate-limit.js';
import { startServer } from '../src/server.js';

function get(port: number, path: string): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () =>
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
      );
    });
    req.on('error', reject);
    req.end();
  });
}

function pretendNonLoopback(target: http.Server): void {
  target.prependListener('connection', (socket) => {
    Object.defineProperty(socket, 'remoteAddress', { configurable: true, value: '203.0.113.9' });
  });
}

describe('apiRateLimitMaxFromEnv', () => {
  it('falls back to the default for missing or invalid values', () => {
    expect(apiRateLimitMaxFromEnv({})).toBe(API_RATE_LIMIT_DEFAULT_MAX);
    expect(apiRateLimitMaxFromEnv({ OD_API_RATE_LIMIT_PER_MINUTE: 'abc' })).toBe(API_RATE_LIMIT_DEFAULT_MAX);
    expect(apiRateLimitMaxFromEnv({ OD_API_RATE_LIMIT_PER_MINUTE: '0' })).toBe(API_RATE_LIMIT_DEFAULT_MAX);
    expect(apiRateLimitMaxFromEnv({ OD_API_RATE_LIMIT_PER_MINUTE: '25' })).toBe(25);
  });
});

describe('createApiRateLimiter', () => {
  let server: http.Server;
  let loopbackServer: http.Server;
  let port: number;
  let loopbackPort: number;

  function build(spoof: boolean): Promise<[http.Server, number]> {
    const app = express();
    app.use('/api', createApiRateLimiter({ max: 3 }));
    app.get('/api/ping', (_req, res) => res.json({ ok: true }));
    const srv = http.createServer(app);
    if (spoof) pretendNonLoopback(srv);
    return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve([srv, (srv.address() as { port: number }).port])));
  }

  beforeAll(async () => {
    [server, port] = await build(true);
    [loopbackServer, loopbackPort] = await build(false);
  });
  afterAll(() => {
    server.close();
    loopbackServer.close();
  });

  it('answers 429 RATE_LIMITED with Retry-After once a non-loopback peer exceeds its budget', async () => {
    for (let i = 0; i < 3; i += 1) expect((await get(port, '/api/ping')).status).toBe(200);
    const limited = await get(port, '/api/ping');
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();
    expect(JSON.parse(limited.body).error.code).toBe('RATE_LIMITED');
  });

  it('does not count loopback peers (desktop UI)', async () => {
    for (let i = 0; i < 10; i += 1) expect((await get(loopbackPort, '/api/ping')).status).toBe(200);
  });
});

describe('daemon wiring', () => {
  const previous = process.env.OD_API_RATE_LIMIT_PER_MINUTE;
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    process.env.OD_API_RATE_LIMIT_PER_MINUTE = '4';
    const started = (await startServer({ port: 0, returnServer: true })) as { server: http.Server };
    server = started.server;
    pretendNonLoopback(server);
    port = (server.address() as { port: number }).port;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.OD_API_RATE_LIMIT_PER_MINUTE;
    else process.env.OD_API_RATE_LIMIT_PER_MINUTE = previous;
    server.close();
  });

  it('puts /api behind the limiter for non-loopback peers', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await get(port, '/api/health')).status);
    expect(statuses).toContain(429);
    expect(statuses[0]).toBe(200);
  });
});
