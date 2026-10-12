// Every surface that shows a person a Cult UI Pro item stays free of other companies' names, for
// every catalog row: the catalog response, the served registry item and copy info (install URL,
// item name, file paths and targets, export names in the copied code), `od cult add`'s plan (the
// folders, routes and file names it would write) and `od cult list`. Old internal names still
// resolve as aliases, and are never shown.
//
// This kit is synthetic, so it runs in CI (the licensed kit is not there): one registry item per
// inventory row with the row's real file paths and targets, and a stub file per target that
// exports a name made from its file name (`pricing-vercel.tsx` → `PricingVercel`) and imports a
// sibling by path, so file names, import paths and export names are all exercised. The real
// kit's own export names are covered by tests/cult-brand-free-real-kit.test.ts.
//
// Deliberately not checked: npm package names (`dependencies`, the install command) and the
// `npx shadcn@latest add` tool name, which must stay exact for the install to work.

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

import { parseCultCatalogListResponse, parseCultCatalogItemResponse, type CultCatalogItem } from '@mish/contracts';
import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import { runCultAddCli } from '../src/cult-add-cli.js';
import type { CultRegistryRow } from '../src/cult-registry.js';
import { registerCultCatalogRoutes } from '../src/routes/cult-catalog.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { expectBrandFree } from './helpers/cult-brands.js';
import { writeFixtureKit, type FixtureItem } from './helpers/cult-kit-fixture.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI_SRC = path.resolve(HERE, '../src/cli.ts');
const TSX_CLI = path.resolve(HERE, '../../../node_modules/tsx/dist/cli.mjs');

interface InventoryRow extends CultRegistryRow {
  title: string;
  original: { registryDependencies: string[] };
  source: CultRegistryRow['source'] & { files: Array<{ path: string; target: string; type: string }> };
}

const ROWS = (cultInventoryJson as unknown as { rows: InventoryRow[] }).rows;

function exportName(file: { path: string; target: string }): string {
  const stem = path.posix.basename(file.target || file.path).replace(/\.[^.]+$/, '');
  const pascal = stem.split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join('');
  return /^[A-Za-z]/.test(pascal) ? pascal : `Item${pascal}`;
}

function stubContent(file: { path: string; target: string }, siblings: Array<{ path: string; target: string }>): string {
  if (!/\.(?:tsx?|jsx?)$/.test(file.path)) return `/* ${path.posix.basename(file.path)} */\n`;
  const lines = ["import { cn } from '@/lib/utils';"];
  const other = siblings.find((entry) => entry !== file && /\.(?:tsx?|jsx?)$/.test(entry.path) && entry.target && exportName(entry) !== exportName(file));
  if (other) lines.push(`import { ${exportName(other)} } from '@/${other.target.replace(/\.(?:tsx?|jsx?)$/, '')}';`);
  lines.push(`export function ${exportName(file)}() { return cn(${other ? `String(${exportName(other)})` : "'x'"}); }`);
  return `${lines.join('\n')}\n`;
}

function fixtureItems(): FixtureItem[] {
  return ROWS.filter((row) => row.derivedFrom === undefined).map((row) => {
    const files = row.source.files.map(({ path: p, target, type }) => ({ path: p, target, type }));
    return {
      name: row.name,
      type: 'registry:block',
      // One row lists `shadcn/ui` as an npm package; `od cult add` refuses that name (a separate,
      // existing guard), so it is left out here to reach the plan.
      dependencies: row.dependencies.filter((dep) => dep !== 'shadcn/ui'),
      registryDependencies: row.original.registryDependencies,
      files: files.map((file) => ({ ...file, content: stubContent(file, files) })),
    };
  });
}

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let baseUrl: string;
let items: CultCatalogItem[];
let browseItems: CultCatalogItem[];

beforeAll(async () => {
  const kit = writeFixtureKit(fixtureItems());
  const byId = new Map(kit.rows.map((row) => [row.id, row]));
  const rows: CultRegistryRow[] = ROWS.map((row) => (row.derivedFrom === undefined
    ? byId.get(row.id)!
    : { ...byId.get(row.derivedFrom)!, id: row.id, name: row.name, derivedFrom: row.derivedFrom }));
  const app = express();
  registerCultCatalogRoutes(app, { http: { sendApiError } } as never);
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { rows, kitDir: kit.kitDir });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  browseItems = parseCultCatalogListResponse(await (await fetch(`${baseUrl}/api/cult/catalog`)).json()).catalog.items;
  // Curation changes browsing, not the inventory/source APIs this audit owns.
  items = await Promise.all(ROWS.map(async (row) => {
    const response = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(row.id)}`);
    expect(response.status, row.id).toBe(200);
    return parseCultCatalogItemResponse(await response.json()).item;
  }));
}, 60_000);

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A served body without the npm package names, which must stay exact. */
function withoutPackages(body: Record<string, unknown>): Record<string, unknown> {
  const { dependencies: _deps, ...rest } = body;
  return rest;
}

describe('brand-free Cult surfaces, every catalog row', () => {
  it('covers every inventory row', () => {
    expect(items).toHaveLength(ROWS.length);
    expect(ROWS.length).toBeGreaterThanOrEqual(311);
    const visibleAndRelated = browseItems.flatMap((item) => [item.id, ...(item.relatedItems ?? []).map((related) => related.id)]);
    expect(new Set(visibleAndRelated)).toEqual(new Set(items.map((item) => item.id)));
  });

  it('the catalog response names no brand anywhere, ids included', async () => {
    const text = await (await fetch(`${baseUrl}/api/cult/catalog`)).text();
    expectBrandFree(text, '/api/cult/catalog');
    expectBrandFree(JSON.stringify(items), '/api/cult/catalog/:id (all source rows)');
  });

  it('the registry item and copy info the install URL and copy buttons serve are brand-free', async () => {
    for (const item of items) {
      const copyResp = await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent(item.id)}`);
      expect(copyResp.status, item.id).toBe(200);
      const copy = (await copyResp.json()) as { copy: Record<string, unknown> & { registryUrl: string } };
      expectBrandFree(JSON.stringify(withoutPackages(copy.copy)), `copy ${item.id}`);
      const resp = await fetch(copy.copy.registryUrl);
      expect(resp.status, copy.copy.registryUrl).toBe(200);
      expectBrandFree(JSON.stringify(withoutPackages((await resp.json()) as Record<string, unknown>)), `registry ${item.id}`);
    }
  }, 120_000);

  it('`od cult add` plans only brand-free folders, routes and file names', async () => {
    const into = mkdtempSync(path.join(tmpdir(), 'cult-brand-free-'));
    for (const item of items) {
      const result = await runCultAddCli([item.id, '--into', into, '--dry-run', '--json'], { resolveBaseUrl: async () => baseUrl });
      expect(result.kind, item.id).toBe('done');
      if (result.kind !== 'done') continue;
      expect(result.code, `${item.id}: ${result.stderr.join(' ')}`).toBe(0);
      const summary = JSON.parse(result.stdout) as Record<string, unknown> & { files: Array<{ target: string; item: string }> };
      const { dependencies: _d, missingDependencies: _m, installCommand: _i, projectDir: _p, ...shown } = summary;
      expectBrandFree(JSON.stringify(shown), `od cult add ${item.id}`);
      const human = await runCultAddCli([item.id, '--into', into, '--dry-run'], { resolveBaseUrl: async () => baseUrl });
      if (human.kind === 'done') {
        // Package lines name npm packages, and the base-components line names the install tool.
        const lines = human.stdout.split('\n').filter((line) => !/^(?:Packages|Install with|Installed with|Base components)/.test(line));
        expectBrandFree(lines.join('\n').replace(into, '<dir>'), `od cult add ${item.id} (text)`);
      }
    }
  }, 300_000);

  it('`od cult list` prints brand-free lines', async () => {
    const { stdout } = await execFileP(process.execPath, [TSX_CLI, CLI_SRC, 'cult', 'list', '--daemon-url', baseUrl], { maxBuffer: 16 * 1024 * 1024 });
    expect(stdout.trim().split('\n').length).toBe(browseItems.length + 1);
    expectBrandFree(stdout, 'od cult list');
  }, 60_000);
});
