// `od sections list|get`, text and `--json`, against the real GET /api/sections route: Cult UI
// Pro sections are shown under their brand-free public id (`cult:<slug>`), never the internal
// inventory id, and with brand-free content. `get` takes the public id.

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

describe('od sections, Cult entries', () => {
  it('lists every Cult section by its brand-free public id', async () => {
    const { stdout } = await od('sections', 'list');
    const cultLines = stdout.split('\n').filter((line) => line.startsWith('cult:'));
    expect(cultLines.length).toBeGreaterThan(100);
    expect(stdout).toContain('cult:bento-series-v\t');
    expect(stdout).not.toContain('cult:marketing-bento-vercel');
    for (const line of cultLines) expect(brandHit(line), line).toBeNull();
  }, 60_000);

  it('shows one Cult section by its public id', async () => {
    const { stdout } = await od('sections', 'get', 'cult:pricing-series-v');
    expect(stdout).toContain('Id\tcult:pricing-series-v\n');
    expect(stdout).toContain('Title\tPricing (series V)\n');
    expect(brandHit(stdout)).toBeNull();
  }, 60_000);

  it('prints brand-free JSON for every Cult section with list --json', async () => {
    const { stdout } = await od('sections', 'list', '--json');
    const body = JSON.parse(stdout) as { catalog: { entries: Array<{ id: string; sourceKind: string }> } };
    const cult = body.catalog.entries.filter((entry) => entry.sourceKind === 'cult-pro');
    expect(cult.length).toBeGreaterThan(100);
    for (const entry of cult) expect(brandHit(JSON.stringify(entry)), entry.id).toBeNull();
    expect(stdout).not.toContain('cult:marketing-');
  }, 60_000);

  it('prints brand-free JSON for one Cult section with get --json', async () => {
    const { stdout } = await od('sections', 'get', 'cult:pricing-series-v', '--json');
    expect(JSON.parse(stdout)).toMatchObject({ entry: { id: 'cult:pricing-series-v', content: { sourceTitle: 'Pricing (series V)', provenance: { cultId: 'cult:pricing-series-v' } } } });
    expect(brandHit(stdout)).toBeNull();
  }, 60_000);
});
