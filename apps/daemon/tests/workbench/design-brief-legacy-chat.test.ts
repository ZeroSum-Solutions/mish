// AC-R15.3: an accepted design brief binds only through POST /api/runs. The
// legacy POST /api/chat must refuse a `brief` field instead of silently
// starting a turn without the brief the caller asked for.
import type http from 'node:http';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { startServer } from '../../src/server.js';

let server: http.Server;
let baseUrl: string;
beforeAll(async () => {
  const started = await startServer({ upstreamCloudEnabled: true, port: 0, returnServer: true }) as { url: string; server: http.Server };
  baseUrl = started.url; server = started.server;
});
afterAll(async () => { if (server) { server.closeAllConnections?.(); await new Promise<void>(resolve => server.close(() => resolve())); } });

it.each([
  ['a binding', { id: 'brief_0123', revision: 1, hash: 'a'.repeat(64) }],
  ['a malformed value', 'not-a-binding'],
  ['null', null],
])('refuses %s in `brief` with a typed 400 that names /api/runs', async (_label, brief) => {
  const response = await fetch(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ agentId: 'claude', message: 'hello', brief }),
  });
  expect(response.status).toBe(400);
  const body = await response.json() as { error: { code: string; message: string } };
  expect(body.error.code).toBe('BRIEF_REQUIRES_RUNS_API');
  expect(body.error.message).toContain('/api/runs');
});
