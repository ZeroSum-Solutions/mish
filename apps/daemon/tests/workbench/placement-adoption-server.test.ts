import type { Server } from 'node:http';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

/**
 * B4-1 review round through the real `server.ts` (ordinary mode, isolated
 * data root): S3 the Labs key is local-owner only, NIT4 a non-boolean value is
 * a typed refusal, S4 a folder import that contains the data root is refused,
 * and the status route names every closed gate.
 */
type Started = { url: string; server: Server; shutdown?: () => Promise<void> | void };
let started: Started | null = null;
let parent: string, dataDir: string;
const originalDataDir = process.env.OD_DATA_DIR;

beforeAll(async () => {
  parent = await realpath(await mkdtemp(join(tmpdir(), 'od-adoption-server-')));
  dataDir = join(parent, 'data'); await mkdir(dataDir);
  process.env.OD_DATA_DIR = dataDir;
  vi.resetModules();
  const module = await import('../../src/server.js') as unknown as { startServer(options: { port: number; returnServer: boolean }): Promise<Started> };
  started = await module.startServer({ port: 0, returnServer: true });
}, 60_000);
afterAll(async () => {
  const current = started; started = null;
  if (current) {
    await current.shutdown?.();
    current.server.closeAllConnections?.();
    await new Promise<void>(done => current.server.close(() => done()));
  }
  if (originalDataDir === undefined) delete process.env.OD_DATA_DIR; else process.env.OD_DATA_DIR = originalDataDir;
  await rm(parent, { recursive: true, force: true });
}, 30_000);

const put = (body: unknown, headers: Record<string, string> = {}) => fetch(`${started!.url}/api/app-config`, {
  method: 'PUT', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body),
});

describe('adoption executor Labs key and import boundary (server)', () => {
  it('[S3] a workspace-member request cannot change placementAdoptionExecutor', async () => {
    const response = await put({ placementAdoptionExecutor: true }, { 'x-od-workspace-id': 'ws-1', 'x-od-workspace-member-id': 'member-1' });
    expect(response.status).toBe(403);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'FORBIDDEN', details: { reason: 'local-owner-required', key: 'placementAdoptionExecutor' } });
    const config = (await (await fetch(`${started!.url}/api/app-config`)).json()) as { config: Record<string, unknown> };
    expect(config.config.placementAdoptionExecutor).toBeUndefined();
  });
  it('[S3] the local owner can change it', async () => {
    const response = await put({ placementAdoptionExecutor: true });
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).config.placementAdoptionExecutor).toBe(true);
    expect((await put({ placementAdoptionExecutor: false })).status).toBe(200);
  });
  it('[NIT4] a non-boolean value is refused with the typed app-config error', async () => {
    const response = await put({ placementAdoptionExecutor: 'yes' });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'INVALID_APP_CONFIG_VALUE' });
  });
  it('[S4] refuses importing a folder that contains the data root', async () => {
    const response = await fetch(`${started!.url}/api/import/folder`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ baseDir: parent, name: 'contains data root' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as any).error).toMatchObject({ code: 'BAD_REQUEST', details: { reason: 'import-contains-data-root' } });
  });
  it('[NIT1] status names the env and Labs reasons in ordinary mode', async () => {
    const response = await fetch(`${started!.url}/api/workbench/adoption/status`);
    expect(response.status).toBe(200);
    const { status } = (await response.json()) as { status: { executor: string; placementMode: string; gates: string[] } };
    expect(status).toMatchObject({ executor: 'closed', placementMode: 'ordinary-uncoordinated' });
    expect(status.gates).toEqual(expect.arrayContaining(['ordinary-mode', 'adoption-executor-unprovisioned', 'adoption-opt-in-env-off']));
  });
  it('[BLOCK 2] after the switch was turned off, a member request without workspace headers cannot turn it back on in this daemon', async () => {
    // The owner turned it off earlier in this process (the [S3] case ends with `false`).
    const response = await put({ placementAdoptionExecutor: true }); // No x-od-workspace-* headers: indistinguishable from the owner.
    expect(response.status).toBe(200); // The preference is stored for the owner's next start ...
    const { status } = (await (await fetch(`${started!.url}/api/workbench/adoption/status`)).json()) as { status: { optIn: { labs: boolean }; gates: string[] } };
    expect(status.optIn.labs).toBe(false); // ... but this daemon stays closed.
    expect(status.gates).toContain('adoption-opt-in-labs-off');
  });
});
