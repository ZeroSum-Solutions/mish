import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseCultCatalogListResponse, type CultCopyResponse } from '@mish/contracts';
import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import { runCultAddCli } from '../src/cult-add-cli.js';
import { registerCultCatalogRoutes } from '../src/routes/cult-catalog.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { expectBrandFree } from './helpers/cult-brands.js';
import { writeFixtureKit } from './helpers/cult-kit-fixture.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(HERE, '../src/cli.ts');
const TSX_CLI = path.resolve(HERE, '../../../node_modules/tsx/dist/cli.mjs');
const SOURCE = 'export function FixtureCard() { return <div>Owned fixture</div>; }\n';
let server: http.Server;
let baseUrl: string;
const roots: string[] = [];
const sendApiError = (res: express.Response, status: number, code: string, message: string) => {
  res.status(status).json({ error: { code, message } });
};

beforeAll(async () => {
  const kit = writeFixtureKit([{
    name: 'fixture-card',
    files: [{ path: 'registry/components/fixture-card.tsx', target: 'components/fixture-card.tsx', type: 'registry:ui', content: SOURCE }],
  }]);
  roots.push(kit.kitDir);
  const app = express();
  registerCultCatalogRoutes(app, { http: { sendApiError } } as never);
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { rows: kit.rows, kitDir: kit.kitDir });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('brand-free public stub and owned registry fixtures', () => {
  it('serves an empty public inventory with no brand or source text', async () => {
    expect((cultInventoryJson as { rows: unknown[] }).rows).toEqual([]);
    const text = await (await fetch(`${baseUrl}/api/cult/catalog`)).text();
    expect(parseCultCatalogListResponse(JSON.parse(text)).catalog.items).toEqual([]);
    expectBrandFree(text, '/api/cult/catalog');
    expect(text).not.toContain(SOURCE);
  });

  it('refuses copy and registry access for removed items at the real handlers', async () => {
    for (const route of ['copy/cult%3Aremoved-fixture', 'r/removed-fixture.json']) {
      const response = await fetch(`${baseUrl}/api/cult/${route}`);
      expect(response.status).toBe(404);
      const body = await response.json() as { error: { code: string } };
      expect(body.error.code).toBe('NOT_FOUND');
      expectBrandFree(JSON.stringify(body), route);
    }
  });

  it('serves owned copy info and registry source through the actual install URL', async () => {
    const response = await fetch(`${baseUrl}/api/cult/copy/cult%3Afixture-card`);
    expect(response.status).toBe(200);
    const { copy } = await response.json() as CultCopyResponse;
    expect(copy.registryUrl).toBe(`${baseUrl}/api/cult/r/fixture-card.json`);
    expect(copy.mainFile.content).toBe(SOURCE);
    expectBrandFree(JSON.stringify(copy), 'copy fixture');
    const registryResponse = await fetch(copy.registryUrl);
    expect(registryResponse.status).toBe(200);
    const item = await registryResponse.json() as { name: string; files: Array<{ target: string; content: string }> };
    expect(item.name).toBe('fixture-card');
    expect(item.files).toHaveLength(1);
    expect(item.files[0]?.target).toBe('components/fixture-card.tsx');
    expect(item.files[0]?.content).toBe(SOURCE);
    expectBrandFree(JSON.stringify(item), 'registry fixture');
  });

  it('`od cult add` plans the owned fixture without writing files', async () => {
    const into = mkdtempSync(path.join(tmpdir(), 'mish-registry-plan-'));
    roots.push(into);
    const result = await runCultAddCli(['cult:fixture-card', '--into', into, '--dry-run', '--json'], { resolveBaseUrl: async () => baseUrl });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') throw new Error('expected a completed fixture plan');
    expect(result.code).toBe(0);
    const plan = JSON.parse(result.stdout) as { files: Array<{ target: string }> };
    expect(plan.files.map((file) => file.target)).toEqual(['components/fixture-card.tsx']);
    expectBrandFree(result.stdout, 'od cult add fixture');
    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(into, 'components/fixture-card.tsx'))).toBe(false);
  });

  it('`od cult add` refuses an unavailable item', async () => {
    const result = await runCultAddCli(['cult:removed-fixture', '--into', tmpdir(), '--dry-run', '--json'], { resolveBaseUrl: async () => baseUrl });
    expect(result.kind).toBe('http-failure');
    if (result.kind !== 'http-failure') throw new Error('expected an unavailable registry response');
    expect(result.response.status).toBe(404);
    expectBrandFree(await result.response.text(), 'od cult add refusal');
  });

  it('`od cult list` prints only a brand-free header for the empty catalog', async () => {
    const { stdout } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, 'cult', 'list', '--daemon-url', baseUrl], { maxBuffer: 16 * 1024 * 1024 });
    expect(stdout.trim().split('\n')).toHaveLength(1);
    expectBrandFree(stdout, 'od cult list');
  });
});
