import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, expect, it, vi } from 'vitest';
import { registerProjectArtifactRoutes } from '../src/routes/project/index.js';

let server: Server | undefined;
let root: string | undefined;
afterEach(async () => {
  vi.useRealTimers();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (root) await fs.promises.rm(root, { recursive: true, force: true });
});

it('D16 same-second saves retain separate HTML and served URLs', async () => {
  root = await fs.promises.mkdtemp(path.join(tmpdir(), 'od-save-collisions-'));
  const app = express();
  app.use(express.json());
  registerProjectArtifactRoutes(app, {
    uploads: { upload: { array: () => (_req: unknown, _res: unknown, next: () => void) => next() } },
    paths: { ARTIFACTS_DIR: root },
    node: { path, fs },
    artifacts: { sanitizeSlug: () => 'same', lintArtifact: () => [], renderFindingsForAgent: () => '' },
  } as unknown as Parameters<typeof registerProjectArtifactRoutes>[1]);
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no port');
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-09T20:00:00Z'));
  const inputs = ['<h1>first</h1>', '<h1>second</h1>', '<h1>third</h1>'];
  const outputs = await Promise.all(inputs.map(async (html) => {
    const res = await fetch(`http://127.0.0.1:${address.port}/api/artifacts/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: 'same', html }),
    });
    expect(res.status).toBe(200);
    return await res.json() as { path: string; url: string };
  }));
  expect(new Set(outputs.map((out) => out.path)).size).toBe(inputs.length);
  expect(new Set(outputs.map((out) => out.url)).size).toBe(inputs.length);
  for (const [index, out] of outputs.entries()) {
    expect(await fs.promises.readFile(out.path, 'utf8')).toBe(inputs[index]);
  }
});
