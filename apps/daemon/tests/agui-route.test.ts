// Phase 4 / spec §10.3.5 — GET /api/runs/:id/agui smoke.
//
// Covers the basic shape of the AG-UI canonical event stream:
//   - 404 for an unknown run id.
//   - Replays existing events through the encoder when a client
//     reconnects with a Last-Event-ID.

import type http from 'node:http';
import { EventEmitter } from 'node:events';
import type { Express, Request, Response } from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSseResponse, startServer } from '../src/server.js';
import { registerRunRoutes } from '../src/routes/runs.js';

let server: http.Server;
let baseUrl: string;
let shutdown: (() => Promise<void> | void) | undefined;

beforeAll(async () => {
  const started = (await startServer({ port: 0, returnServer: true })) as {
    url: string;
    server: http.Server;
    shutdown?: () => Promise<void> | void;
  };
  baseUrl = started.url;
  server = started.server;
  shutdown = started.shutdown;
});

afterAll(async () => {
  await Promise.resolve(shutdown?.());
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/runs/:id/agui', () => {
  it('returns 404 for an unknown run', async () => {
    const resp = await fetch(`${baseUrl}/api/runs/no-such-run/agui`);
    expect(resp.status).toBe(404);
  });

  it.each([false, true])('D21 preserves history and sends live events once across drain waits (prune=%s)', async (pruneHistory) => {
    type Client = { send: (event: string, data: unknown, id?: number) => void; end: () => void };
    const run = {
      id: 'agui-replay', status: 'running',
      events: [
        { id: 1, event: 'run_started', data: {}, timestamp: 1 },
        { id: 2, event: 'message_chunk', data: { text: 'history' }, timestamp: 2 },
      ],
      clients: new Set<Client>(),
    };
    type Handler = (req: Request, res: Response) => Promise<unknown>;
    const handlers = new Map<string, Handler>();
    const app = {
      get: (route: string, handler: Handler) => handlers.set(route, handler),
      post: () => {},
    } as unknown as Express;
    registerRunRoutes(app, {
      db: {},
      design: { runs: { get: () => run, isTerminal: () => false } },
      http: { createSseResponse, sendApiError: () => { throw new Error('unexpected API error'); } },
      paths: { PROJECTS_DIR: process.env.OD_DATA_DIR!, RUNTIME_DATA_DIR: process.env.OD_DATA_DIR! },
      agents: {}, chat: {}, plugins: {}, telemetry: {}, messages: {}, internalRuns: {},
    } as unknown as Parameters<typeof registerRunRoutes>[1]);
    const handler = handlers.get('/api/runs/:id/agui');
    if (!handler) throw new Error('AGUI route not registered');
    const res = new AguiBackpressureResponse();
    try {
      await handler({ params: { id: run.id }, query: {}, get: () => undefined } as unknown as Request, res as unknown as Response);
      expect(res.writes).toHaveLength(1);
      expect(run.clients.size).toBe(1);
      const client = [...run.clients][0]!;
      // Live records are appended and the bounded ring may prune history
      // while the socket is paused. Neither mutation may affect replay.
      run.events.push({ id: 3, event: 'message_chunk', data: { text: 'live' }, timestamp: 3 });
      if (pruneHistory) run.events.splice(0, 2);
      client.send('message_chunk', { text: 'live' }, 3);
      client.send('end', { status: 'succeeded' }, 4);
      client.end();
      expect(res.writes).toHaveLength(1);
      expect(res.writableEnded).toBe(false);
      res.writeAccepted = true;
      res.emit('drain');
      expect(res.writes.map((frame) => frame.match(/^id: (\d+)/)?.[1])).toEqual(['1', '2', '3', '4']);
      expect(res.writes[1]).toContain('"text":"history"');
      expect(res.writes[2]).toContain('"text":"live"');
      expect(res.writableEnded).toBe(true);
      expect(res.listenerCount('drain')).toBe(0);
    } finally {
      res.emit('close');
    }
    expect(run.clients.size).toBe(0);
  });
});

class AguiBackpressureResponse extends EventEmitter {
  writes: string[] = [];
  destroyed = false;
  writableEnded = false;
  writableLength = 0;
  writeAccepted = false;

  setHeader(_name: string, _value: string): void {}
  flushHeaders(): void {}
  // The SSE pump writes Buffer chunks under byte backpressure; record them as text.
  write(frame: string | Uint8Array): boolean { this.writes.push(typeof frame === 'string' ? frame : Buffer.from(frame).toString('utf8')); return this.writeAccepted; }
  end(): void { this.writableEnded = true; this.emit('finish'); }
  destroy(): void { this.destroyed = true; this.emit('close'); }
}
