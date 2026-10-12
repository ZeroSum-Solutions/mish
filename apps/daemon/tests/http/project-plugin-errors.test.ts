import express from 'express';
import { execFile, spawnSync } from 'node:child_process';
import { promisify } from 'node:util';
import type { Server } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeProjectPluginFolderPath, resolveProjectChildDirectory, sendProjectPluginFolderError } from '../../src/services/plugin-installation.js';

let server: Server | undefined;
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function respond(operation: () => unknown): Promise<Response> {
  const app = express();
  app.get('/', async (_req, res) => {
    try { await operation(); res.json({ ok: true }); }
    catch (error) { sendProjectPluginFolderError(res, error); }
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server!.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('not listening');
  return fetch(`http://127.0.0.1:${address.port}`);
}

describe('project plugin folder errors', () => {
  it('reports a synchronous missing executable as a safe 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await respond(() => {
      const result = spawnSync(path.join(os.tmpdir(), 'od-absent-executable', 'git'), ['--version']);
      if (result.error) throw result.error;
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'EXECUTABLE_NOT_FOUND' } });
  });
  it('distinguishes an actual failed executable spawn from folder lookup', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await respond(() => promisify(execFile)(path.join(os.tmpdir(), 'od-absent-executable', 'node'), ['--version']));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'EXECUTABLE_NOT_FOUND', message: 'required executable was not found' } });
  });
  it.each(['node', 'git'])('reports missing %s executable as a safe 500', async (binary) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const error = Object.assign(new Error(`spawn /private/tools/${binary} ENOENT`), {
      code: 'ENOENT', syscall: `spawn ${binary}`, path: `/private/tools/${binary}`, spawnargs: ['--version'],
    });
    const response = await respond(() => { throw error; });
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ error: { code: 'EXECUTABLE_NOT_FOUND', message: 'required executable was not found' } });
  });
  it.each(['../secret', '/private/folder', ''])('keeps validation failures at 400 for %s', async (input) => {
    const response = await respond(() => normalizeProjectPluginFolderPath(input));
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'BAD_REQUEST' } });
  });

  it('keeps missing folders at 404 without leaking the project root', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'od-plugin-errors-'));
    roots.push(root);
    const response = await respond(() => resolveProjectChildDirectory(root, 'missing'));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'PLUGIN_FOLDER_NOT_FOUND' } });
    expect(JSON.stringify(body)).not.toContain(root);
  });

  it.each(['SQLITE_IOERR', 'EACCES', 'EIO'])('reports internal %s as a safe 500', async (code) => {
    const error = Object.assign(new Error('failed at /private/customer/database'), { code });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await respond(() => { throw error; });
    expect(response.status).toBe(500);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
    expect(JSON.stringify(body)).not.toContain('/private/customer');
  });
});
