import http from 'node:http';
import { afterEach, expect, it } from 'vitest';
import { createSseResponse } from '../src/server.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import { createTerminalService } from '../src/terminals.js';

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  })));
});

it.each(['run', 'terminal'])('D21 replays a large %s backlog to a healthy real HTTP client', async (kind) => {
  const events = Array.from({ length: 600 }, (_, i) => ({ id: i + 1, event: 'stdout', data: { chunk: 'x'.repeat(4096), index: i } }));
  events.push({ id: 601, event: 'end', data: { chunk: '', index: 600 } });
  const runs = createChatRunService({ createSseResponse, createSseErrorPayload: () => ({}) });
  const terminals = createTerminalService();
  const server = http.createServer((req, res) => {
    const request = { get: () => null, query: {} };
    if (kind === 'run') runs.stream({ status: 'succeeded', events, clients: new Set() }, request, res);
    else terminals.stream({ status: 'exited', events, clients: new Set() }, request, res, createSseResponse);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  const response = await fetch(`http://127.0.0.1:${address.port}`);
  const body = await response.text();
  expect(body.match(/^id: /gm)).toHaveLength(601);
  expect(body).toContain('id: 601\nevent: end');
});
