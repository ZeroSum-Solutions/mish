// Public CLI coverage: retained HyperUI entries and absent licensed Cult entries.

import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerSectionsRoutes } from '../src/routes/sections.js';
import { brandHit } from './helpers/cult-brands.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(HERE, '../src/cli.ts');
const TSX_CLI = path.resolve(HERE, '../../../node_modules/tsx/dist/cli.mjs');

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  registerSectionsRoutes(app, { http: { sendApiError }, paths: { RUNTIME_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'sections-cli-')) } } as never);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const od = (...args: string[]) => execFileP(process.execPath, [TSX_CLI, CLI_SRC, ...args, '--daemon-url', baseUrl], { maxBuffer: 16 * 1024 * 1024 });

describe('od sections without the private Cult pack', () => {
  it('lists public sections and omits Cult entries in text', async () => {
    const { stdout } = await od('sections', 'list');
    expect(stdout).toContain('hyperui:application/charts/1');
    expect(stdout.split('\n').filter(line => line.startsWith('cult:'))).toEqual([]);
    expect(brandHit(stdout)).toBeNull();
  }, 60_000);

  it('refuses a removed Cult section by its public id', async () => {
    await expect(od('sections', 'get', 'cult:pricing-series-v')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('NOT_FOUND') });
  }, 60_000);

  it('lists public sections and omits Cult entries in JSON', async () => {
    const { stdout } = await od('sections', 'list', '--json');
    const body = JSON.parse(stdout) as { catalog: { entries: Array<{ id: string; sourceKind: string }> } };
    expect(body.catalog.entries.some(entry => entry.sourceKind === 'hyperui')).toBe(true);
    expect(body.catalog.entries.filter(entry => entry.sourceKind === 'cult-pro')).toEqual([]);
  }, 60_000);

  it('refuses a removed Cult section with get --json', async () => {
    await expect(od('sections', 'get', 'cult:pricing-series-v', '--json')).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('NOT_FOUND') });
  }, 60_000);
});
