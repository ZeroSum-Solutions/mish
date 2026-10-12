// The real transform over the real licensed kit, for every catalog row: runs when the kit is on
// this machine (CULT_KIT_DIR, else the default ~/projects/mm-source-kits/cult-ui-pro) and is
// skipped in CI, which has no kit. tests/cult-brand-free-surfaces.test.ts covers the same surfaces
// with a synthetic kit that CI can run.
//
// For every row, through the real routes and `od cult add`: the served item and the copy info
// carry no vendor name outside the source text; in every served script file, each exported name
// and each local import path is brand-free, except an export the registry records as kept with a
// reason; and the install plan's folders, routes and file names are brand-free. The check is
// tests/helpers/cult-brands.ts, written apart from the production deny list and reading joined
// word runs (`IPhone`, `OpenAI`) as well as single words.
//
// Not checked: npm package names, and source text such as copy written into the markup.

import { existsSync, mkdtempSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCultCopyResponse, parseCultRegistryItem, type CultRegistryFile } from '@open-design/contracts';
import cultInventoryJson from '@open-design/cult-ui-catalog/catalog.json' with { type: 'json' };
import { runCultAddCli } from '../src/cult-add-cli.js';
import { CultRegistry, resolveCultKitDir, type CultRegistryRow } from '../src/cult-registry.js';
import { cultSlugs, registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { brandHit, expectBrandFree } from './helpers/cult-brands.js';

const KIT = resolveCultKitDir() ?? path.join(process.env.HOME ?? '', 'projects', 'mm-source-kits', 'cult-ui-pro');
const HAS_KIT = existsSync(path.join(KIT, 'registry', 'index.json'));
const ROWS = (cultInventoryJson as unknown as { rows: CultRegistryRow[] }).rows;
const SLUGS = cultSlugs();

const EXPORTED = /\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|interface|type|enum)\s+([A-Za-z_][\w]*)/g;
const EXPORT_LIST = /\bexport\s*(?:type\s*)?\{([^}]*)\}/g;
const LOCAL_IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.\.?\/|@\/)[^'"]*)\1/g;
const SCRIPT = /\.(?:tsx?|jsx?|mjs|cjs)$/;

function exportedNames(content: string): string[] {
  const names = [...content.matchAll(EXPORTED)].map((match) => match[1]!);
  for (const match of content.matchAll(EXPORT_LIST)) {
    for (const part of match[1]!.split(',')) {
      const name = part.trim().replace(/^type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name && /^[A-Za-z_]\w*$/.test(name)) names.push(name);
    }
  }
  return names;
}

/** Brand hits in what a file names: its exports and local import paths (not its prose). */
function namedHits(file: CultRegistryFile, kept: ReadonlySet<string>): string[] {
  if (!SCRIPT.test(file.path) && !SCRIPT.test(file.target)) return [];
  const names = exportedNames(file.content).filter((name) => !kept.has(name));
  const specs = [...file.content.matchAll(LOCAL_IMPORT)].map((match) => match[2]!);
  return [...names, ...specs].filter((value) => brandHit(value) !== null);
}

function withoutSource(body: Record<string, unknown>): Record<string, unknown> {
  const { dependencies: _deps, files, mainFile, ...rest } = body as Record<string, unknown> & {
    files?: Array<Record<string, unknown>>;
    mainFile?: Record<string, unknown>;
  };
  return {
    ...rest,
    files: (files ?? []).map(({ content: _content, ...file }) => file),
    ...(mainFile ? { mainFile: { ...mainFile, content: undefined } } : {}),
  };
}

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

describe.skipIf(!HAS_KIT)('the real kit, every catalog row, brand-free', () => {
  let server: http.Server;
  let baseUrl: string;
  const registry = new CultRegistry(ROWS, KIT, SLUGS);

  beforeAll(async () => {
    const app = express();
    registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { rows: ROWS, kitDir: KIT });
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('covers all rows', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(311);
    expect(SLUGS.size).toBe(ROWS.length);
  });

  it('serves every row with brand-free names, export names and import paths', async () => {
    const leaks: string[] = [];
    for (const row of ROWS) {
      const slug = SLUGS.get(row.id)!;
      const kept = new Set(registry.exportRenames(slug).filter((entry) => entry.to === null).map((entry) => entry.from));
      const resp = await fetch(`${baseUrl}/api/cult/r/${slug}.json`);
      expect(resp.status, slug).toBe(200);
      const body = (await resp.json()) as Record<string, unknown>;
      expectBrandFree(JSON.stringify(withoutSource(body)), `registry ${slug}`);
      for (const file of parseCultRegistryItem(body).files) {
        for (const hit of namedHits(file, kept)) leaks.push(`${slug} ${file.target}: ${hit}`);
      }
      const copy = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent(`cult:${slug}`)}`)).json()).copy;
      expectBrandFree(JSON.stringify(withoutSource(copy as unknown as Record<string, unknown>)), `copy ${slug}`);
      for (const hit of namedHits(copy.mainFile, kept)) leaks.push(`${slug} copy ${copy.mainFile.target}: ${hit}`);
    }
    expect(leaks).toEqual([]);
  }, 300_000);

  it('keeps exactly two export names, stripe and redis, each with its reason', () => {
    const kept = ROWS.filter((row) => row.derivedFrom === undefined)
      .flatMap((row) => registry.exportRenames(SLUGS.get(row.id)!).filter((entry) => entry.to === null)
        .map((entry) => ({ ...entry, item: SLUGS.get(row.id)! })));
    // An allow-list, not a rule: a regression that keeps one more branded name fails here.
    expect(kept.map((entry) => `${entry.item}:${entry.from}`).sort()).toEqual([
      'card-payment-subscription:redis',
      'card-payment-subscription:stripe',
    ]);
    for (const entry of kept) expect(entry.skipped, entry.from).toMatch(/module name, a string key or a property/);
    for (const row of ROWS) {
      for (const entry of registry.exportRenames(SLUGS.get(row.id)!)) {
        if (entry.to !== null) expect(brandHit(entry.to), `${entry.from} → ${entry.to}`).toBeNull();
      }
    }
  });

  it('plans brand-free folders, routes and file names for every row', async () => {
    const into = mkdtempSync(path.join(tmpdir(), 'cult-real-kit-'));
    for (const row of ROWS) {
      const slug = SLUGS.get(row.id)!;
      const result = await runCultAddCli([slug, '--into', into, '--dry-run', '--json'], { resolveBaseUrl: async () => baseUrl });
      if (result.kind !== 'done') throw new Error(`${slug}: ${result.kind}`);
      // A refusal (an unexpected npm name) is the CLI's own guard; the plan is still checked.
      const summary = result.stdout ? JSON.parse(result.stdout) as Record<string, unknown> : {};
      const { dependencies: _d, missingDependencies: _m, installCommand: _i, projectDir: _p, ...shown } = summary;
      expectBrandFree(JSON.stringify(shown), `od cult add ${slug}`);
    }
  }, 300_000);
});
