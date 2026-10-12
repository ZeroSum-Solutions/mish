// Route coverage for GET /api/21st and its item, source, preview, asset, implementation-thumbnail
// and reference-preview routes (PRD Addendum 3 / G13), plus a byte comparison with the responses
// the old /api/cult/21st paths returned before the P1-4a rename (fixtures/twenty1st-baseline), plus
// the cross-route proof that a 21st id is never copyable through Mishh: the Cult UI Pro remix
// routes (`/api/cult/r/*`, `/api/cult/copy/*`) and `od cult add` (which reads `/api/cult/r/*`) all
// refuse a 21st id — in every case/encoding variant — because these ids are never part of that
// route's data. The remix routes are registered here with the REAL 311-row Cult catalog (not a
// throwaway fixture), so this proves no 21st slug or name is, or ever becomes, a real Cult id.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import JSZip from 'jszip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import cultInventoryJson from '@mish/cult-ui-catalog/catalog.json' with { type: 'json' };
import cultSlugsJson from '@mish/cult-ui-catalog/generated/slugs.json' with { type: 'json' };
import twentyFirstJson from '@mish/21st-catalog/generated/21st-items.json' with { type: 'json' };
import originalSourcesJson from '@mish/21st-catalog/generated/21st-originals.json' with { type: 'json' };
import { twenty1stBrowseTags, parseTwenty1stListResponse, parseTwenty1stSourceResponse } from '@mish/contracts';
import { registerTwenty1stRoutes } from '../src/routes/twenty1st.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import type { CultRegistryRow } from '../src/cult-registry.js';
import { runCultAddCli } from '../src/cult-add-cli.js';

const ROWS = (twentyFirstJson as unknown as { rows: Array<{ id: string; slug: string; name: string; rights: string }> }).rows;
const CULT_ROWS = (cultInventoryJson as unknown as { rows: CultRegistryRow[] }).rows;
const CULT_SLUGS = new Map(Object.entries((cultSlugsJson as unknown as { items: Record<string, string> }).items));

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let baseUrl: string;

beforeAll(async () => {
  // Every assertion here describes a daemon with no private preview kit, as in public CI.
  delete process.env.TWENTY1ST_PREVIEW_DIR;
  const app = express();
  registerTwenty1stRoutes(app, { http: { sendApiError } } as never);
  // The real Cult UI Pro remix routes, mounted alongside, with the REAL catalog rows and no kit
  // configured (kitDir: null): a refused id never needs kit access to be refused, and this proves
  // the refusal against the actual 311-row inventory, not a throwaway fixture.
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { rows: CULT_ROWS, kitDir: null, slugs: CULT_SLUGS });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/21st', () => {
  it('lists all 22 hand-picked items with correct rights, 2 mit and 20 reference-only', async () => {
    const resp = await fetch(`${baseUrl}/api/21st`);
    expect(resp.status).toBe(200);
    const body = parseTwenty1stListResponse(await resp.json());
    expect(body.catalog.items).toHaveLength(22);
    expect(body.catalog.items.filter((item) => item.rights === 'mit')).toHaveLength(2);
    expect(body.catalog.items.filter((item) => item.rights === 'reference-only')).toHaveLength(20);
    for (const item of body.catalog.items) {
      expect(item.copyable, item.id).toBe(item.rights === 'mit');
      if (item.rights === 'reference-only') {
        expect(item.licenseLabel, item.id).toBeNull();
        expect(item.licenseUrl, item.id).toBeNull();
        expect(item.licenseNotice, item.id).toBeNull();
      } else {
        expect(item.licenseNotice, item.id).toMatch(/^MIT License\n/);
      }
    }
  });

  it('presents all22 as short factual summaries while retaining saved source titles and hashes', async () => {
    const body = parseTwenty1stListResponse(await(await fetch(`${baseUrl}/api/21st`)).json());
    const descriptions = new Set<string>();
    for (const item of body.catalog.items) {
      const implementation = item.privateImplementation ?? item.ownedAlternative!;
      expect(implementation.description.length, item.id).toBeLessThanOrEqual(85);
      expect(implementation.description, item.id).not.toMatch(/premium|beautiful|stunning|high.fidelity|sleek|cutting.edge|comprehensive/i);
      descriptions.add(implementation.description);
      const source = parseTwenty1stSourceResponse(await(await fetch(`${baseUrl}${implementation.sourceUrl}`)).json());
      expect(source.sourceSha256, item.id).toBe(implementation.sourceSha256);
      expect(source.title, item.id).toBe(originalSourcesJson.items.find(row => row.id === item.id)!.title);
      expect(source.provenance, item.id).toBe(implementation.provenance);
    }
    expect(descriptions.size).toBe(22);
    expect(body.catalog.items.find(item => item.id === '21st:ravikatiyar162-card')!.ownedAlternative!.title).toBe('Opportunity Card');
    expect(body.catalog.items.find(item => item.id === '21st:hero-ui-card')!.ownedAlternative!.title).toBe('Flexible Card');
  });

  it('GET /api/21st/:id answers one row by id or slug, 404 for an unknown one', async () => {
    const known = ROWS[0]!;
    for (const key of [known.id, known.id.slice('21st:'.length)]) {
      const resp = await fetch(`${baseUrl}/api/21st/${encodeURIComponent(key)}`);
      expect(resp.status, key).toBe(200);
    }
    const missing = await fetch(`${baseUrl}/api/21st/21st:not-a-real-item`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });
});

interface BaselineRecord {
  name: string;
  path: string;
  status: number;
  headers: Record<string, string>;
  bodyFile?: string;
  bodyKind?: 'binary' | 'zip';
  bodySha256?: string;
  bodyBytes?: number;
  bodyStartsWith?: string;
}

const BASELINE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'twenty1st-baseline');
const BASELINE = JSON.parse(readFileSync(path.join(BASELINE_DIR, 'manifest.json'), 'utf8')) as {
  routePrefix: string;
  ids: string[];
  records: BaselineRecord[];
};
/** The one intended difference: links inside a body now name the new route prefix. */
const renamed = (text: string) => text.replaceAll('/api/cult/21st', '/api/21st');

describe('GET /api/21st matches the pre-rename /api/cult/21st responses (P1-4a spec 1)', () => {
  it('the baseline covers the list and all six per-item routes for three fixed ids', () => {
    expect(BASELINE.routePrefix).toBe('/api/cult/21st');
    expect(BASELINE.ids).toHaveLength(3);
    const suffixes = new Set(BASELINE.records.map((record) => record.name.replace(/^[^.]+\.?/, '')));
    expect([...suffixes].sort()).toEqual(['', 'assets', 'implementation-thumbnail', 'item', 'preview', 'reference-preview', 'source', 'source-zip']);
  });

  it.each(BASELINE.records.map((record) => [record.name, record] as const))('%s: same status, headers and body', async (_name, record) => {
    const response = await fetch(`${baseUrl}/api/21st${record.path}`);
    expect(response.status).toBe(record.status);
    for (const [header, value] of Object.entries(record.headers)) {
      // Express derives a weak ETag from the body bytes: the body comparison below covers it, and
      // it differs exactly where a body's links name the new prefix (or the zip's time stamps).
      if (header === 'etag' && value.startsWith('W/')) continue;
      expect(response.headers.get(header), header).toBe(renamed(value));
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (record.bodyFile) {
      const expected = renamed(readFileSync(path.join(BASELINE_DIR, record.bodyFile), 'utf8'));
      expect(bytes.toString('utf8')).toBe(expected);
    } else if (record.bodyKind === 'zip') {
      expect(bytes.subarray(0, 2).toString('latin1')).toBe(record.bodyStartsWith);
      // JSZip stamps the time, so compare the entries with the baseline source bundle instead of bytes.
      const sourceRecord = BASELINE.records.find((entry) => entry.name === record.name.replace(/\.source-zip$/, '.source'))!;
      const source = JSON.parse(readFileSync(path.join(BASELINE_DIR, sourceRecord.bodyFile!), 'utf8')) as { files: Array<{ path: string; content: string }> };
      const zip = await JSZip.loadAsync(bytes);
      const entries = Object.values(zip.files).filter((entry) => !entry.dir).map((entry) => entry.name).sort();
      expect(entries).toEqual(source.files.map((file) => file.path).sort());
      for (const file of source.files) expect(await zip.file(file.path)!.async('string'), file.path).toBe(file.content);
    } else {
      expect(bytes.length).toBe(record.bodyBytes);
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(record.bodySha256);
    }
  });

  it('the old /api/cult/21st paths now answer 404', async () => {
    for (const record of BASELINE.records) {
      const response = await fetch(`${baseUrl}${BASELINE.routePrefix}${record.path}`);
      expect(response.status, record.name).toBe(404);
    }
  });
});

describe('no 21st row is copyable through Mishh (real 311-row catalog, every id variant)', () => {
  it('positive control: a real Cult slug on the same server gets its expected non-404 response, so an unmounted remix route cannot pass this file by blanket-404ing everything', async () => {
    const realSlug = [...CULT_SLUGS.values()][0]!;
    // kitDir is null in this suite's setup (no source files on disk), so a REAL, catalogued slug
    // reaches the row lookup, matches, and then fails on the (deliberately absent) kit content —
    // 503 KIT_UNAVAILABLE, never 404 NOT_FOUND. A 404 here would mean the route only ever 404s,
    // which would make every "refused" assertion below vacuous.
    const r = await fetch(`${baseUrl}/api/cult/r/${encodeURIComponent(realSlug)}.json`);
    expect(r.status, realSlug).toBe(503);
    expect(((await r.json()) as { error: { code: string } }).error.code, realSlug).toBe('KIT_UNAVAILABLE');

    const copy = await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent(realSlug)}`);
    expect(copy.status, realSlug).toBe(503);
    expect(((await copy.json()) as { error: { code: string } }).error.code, realSlug).toBe('KIT_UNAVAILABLE');
  });

  it('no 21st slug or name is, or collides with, a real Cult catalog slug or name', () => {
    const cultSlugSet = new Set(CULT_SLUGS.values());
    const cultNameSet = new Set(CULT_ROWS.map((row) => row.name));
    for (const row of ROWS) {
      expect(cultSlugSet.has(row.slug), row.id).toBe(false);
      expect(cultNameSet.has(row.slug), row.id).toBe(false);
      // Moved here from packages/cult-ui-catalog/tests/twenty-first.test.ts when the 21st.dev data
      // left that package (P1-4a), so packages/21st-catalog needs no Cult dependency.
      expect(cultNameSet.has(row.name), row.id).toBe(false);
    }
  });

  it('/api/cult/r/*.json refuses every 21st id: bare slug, full 21st: id, case and encoding variants', async () => {
    for (const row of ROWS) {
      const slug = row.id.slice('21st:'.length);
      const variants = [
        slug, // bare slug
        row.id, // full id with the 21st: prefix
        row.id.toUpperCase(), // UPPERCASE
        `21St:${slug}`, // mixed case prefix
        `21st%3A${slug}`, // percent-encoded colon
        `21st%253A${slug}`, // double-encoded colon
      ];
      for (const variant of variants) {
        const resp = await fetch(`${baseUrl}/api/cult/r/${encodeURIComponent(variant)}.json`);
        expect([400, 404], `${row.id} variant "${variant}"`).toContain(resp.status);
      }
    }
  });

  it('/api/cult/copy/* refuses every 21st id: bare slug, full 21st: id, case and encoding variants', async () => {
    for (const row of ROWS) {
      const slug = row.id.slice('21st:'.length);
      const variants = [slug, row.id, row.id.toUpperCase(), `21St:${slug}`, `21st%3A${slug}`, `21st%253A${slug}`, `cult:${slug}`];
      for (const variant of variants) {
        const resp = await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent(variant)}`);
        expect([400, 404], `${row.id} variant "${variant}"`).toContain(resp.status);
      }
    }
  });

  it('od cult add refuses every id form: the 21st: id shape client-side, a bare/cult:-prefixed slug at the daemon (404)', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'cult-21st-add-'));
    const referenceOnly = ROWS.find((row) => row.rights === 'reference-only')!;
    const mit = ROWS.find((row) => row.rights === 'mit')!;
    for (const row of [referenceOnly, mit]) {
      const slug = row.id.slice('21st:'.length);
      // These carry the 21st: prefix (or uppercase it, or percent-encode the colon a shell would
      // never decode), so `cultRegistryName` rejects them before any request — the CLI's own
      // id-shape check, not a daemon round trip.
      for (const arg of [row.id, row.id.toUpperCase(), `21St:${slug}`, `21st%3A${slug}`, `21st%253A${slug}`]) {
        const result = await runCultAddCli([arg, '--into', root], { resolveBaseUrl: async () => baseUrl });
        expect(result.kind, `${row.id} arg "${arg}"`).toBe('usage');
        if (result.kind === 'usage') expect(result.stderr.join(' '), arg).toMatch(/not a catalog id/);
      }
      // These look like a plausible catalog id (no colon), so they pass the client-side shape
      // check and are refused by the daemon instead: 404, no 21st slug is in its data.
      for (const arg of [slug, `cult:${slug}`]) {
        const result = await runCultAddCli([arg, '--into', root], { resolveBaseUrl: async () => baseUrl });
        expect(result.kind, `${row.id} arg "${arg}"`).toBe('http-failure');
        if (result.kind === 'http-failure') expect(result.response.status, arg).toBe(404);
      }
    }
  });
});

describe('saved reference preview images', () => {
  // Only a `mit` row may carry a committed copy of 21st.dev's own CDN preview
  // (generated/21st-thumbnails/, twenty1stMayShipLocalImage) — serving a `reference-only` row's
  // image here would redistribute the other creator's screenshot same-origin, which this route
  // must never do.
  it('serves the 2 mit rows\' reference images, separately from original HTML, including hidden checkout ancestors', async () => {
    for (const row of ROWS.filter((row) => row.rights === 'mit')) {
      const response = await fetch(`${baseUrl}/api/21st/${row.slug}/reference-preview`);
      expect(response.status, row.slug).toBe(200);
      expect(response.headers.get('content-type')).toBe('image/webp');
      const bytes = Buffer.from(await response.arrayBuffer());
      expect(bytes.subarray(0, 4).toString()).toBe('RIFF');
      expect(bytes.subarray(8, 12).toString()).toBe('WEBP');
    }
  });

  it('refuses a reference-preview for every one of the 20 reference-only rows: no local copy of another creator\'s screenshot is ever served', async () => {
    const referenceOnly = ROWS.filter((row) => row.rights === 'reference-only');
    expect(referenceOnly).toHaveLength(20);
    for (const row of referenceOnly) {
      const response = await fetch(`${baseUrl}/api/21st/${row.slug}/reference-preview`);
      expect(response.status, row.slug).toBe(404);
      expect(((await response.json()) as { error: { code: string } }).error.code, row.slug).toBe('NOT_FOUND');
    }
  });
});

describe('independently authored alternatives', () => {
  it('filters list by name, tags, description, and combined facets without changing its envelope', async () => {
    const search = async (params: string) => parseTwenty1stListResponse(await (await fetch(`${baseUrl}/api/21st?${params}`)).json());
    const byName = await search('query=System%20Monitor');
    expect(byName.catalog.items.map(item => item.slug)).toEqual(['isaiahbjork-system-monitor']);
    const byDescription = await search('query=time-series');
    expect(byDescription.catalog.items.map(item => item.slug)).toEqual(['isaiahbjork-system-monitor']);
    const byTag = await search('query=dashboard');
    expect(byTag.catalog.items.map(item => item.slug)).toContain('isaiahbjork-system-monitor');
    const faceted = await search('query=listen&tag=app&rights=mit');
    expect(Object.keys(faceted)).toEqual(['catalog']);
    expect(faceted.catalog.items.length).toBeGreaterThan(0);
    expect(faceted.catalog.items.every(item => item.rights === 'mit' && twenty1stBrowseTags(item).includes('app'))).toBe(true);
    expect((await search('rights=invalid')).catalog.items).toHaveLength(0);
  });
  it('all 22 source/preview routes work, with separate provenance and exact CSP', async () => {
    const list = parseTwenty1stListResponse(await (await fetch(`${baseUrl}/api/21st`)).json());
    for (const item of list.catalog.items) {
      expect(item.ownedAlternative?.provenance, item.id).toBe('independently-authored');
      const source = await fetch(`${baseUrl}${item.ownedAlternative!.sourceUrl}`);
      expect(source.status).toBe(200);
      const bundle = parseTwenty1stSourceResponse(await source.json());
      expect(bundle.files).toHaveLength(7);
      expect(bundle.referenceUrl).toBe(item.itemUrl);
      const preview = await fetch(`${baseUrl}${item.ownedAlternative!.previewUrl}`);
      expect(preview.status).toBe(200);
      expect(preview.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(preview.headers.get('content-security-policy')).not.toContain('unsafe-inline');
      expect(await preview.text()).toContain('mount(document.getElementById');
    }
  });
  it('downloads a real original ZIP and refuses unknown source IDs', async () => {
    const slug = ROWS[0]!.slug;
    const zip = await fetch(`${baseUrl}/api/21st/${slug}/source?download=zip`);
    expect(zip.headers.get('content-type')).toContain('application/zip');
    const bytes = Buffer.from(await zip.arrayBuffer());
    expect(bytes.subarray(0,2).toString()).toBe('PK');
    expect((await fetch(`${baseUrl}/api/21st/missing/source`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/21st/missing/preview`)).status).toBe(404);
  });
});
