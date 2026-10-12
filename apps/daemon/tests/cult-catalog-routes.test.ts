// Route coverage for GET /api/cult/catalog, GET /api/cult/catalog/:id and
// GET /api/cult/catalog/:id/preview.
//
// `registerCultCatalogRoutes` is mounted on a bare Express app, the genui-catalog-routes harness;
// one boot case goes through `startServer` to prove the route is registered on the real daemon.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CULT_CATALOG_SECTION_KINDS,
  parseCultCatalogItemResponse,
  parseCultCatalogListResponse,
  type CultCatalogListResponse,
} from '@open-design/contracts';
import cultInventoryJson from '@open-design/cult-ui-catalog/catalog.json' with { type: 'json' };
import cultCurationJson from '@open-design/cult-ui-catalog/catalog-curation.json' with { type: 'json' };
import cultThumbnailsJson from '@open-design/cult-ui-catalog/generated/thumbnails.json' with { type: 'json' };
import cultSlugsJson from '@open-design/cult-ui-catalog/generated/slugs.json' with { type: 'json' };
import sectionCatalogJson from '@open-design/section-catalog/catalog.json' with { type: 'json' };
import { cultGeneratedDir, cultPreviewPath, registerCultCatalogRoutes } from '../src/routes/cult-catalog.js';
import { startServer } from '../src/server.js';
import {
  CULT_INVENTORY_CONVERSION_STATUSES,
  cultDisplayCategory,
  cultDisplayTags,
  cultDisplayText,
  cultDisplayTitle,
  cultPreviewIndex,
  cultState,
  projectCultItem,
  curateCultCatalogItems,
  type CultCatalogCuration,
  type CultInventoryRow,
  type CultThumbnailManifest,
} from '../src/cult-catalog-projection.js';

const INVENTORY_ROWS = (cultInventoryJson as unknown as { rows: CultInventoryRow[] }).rows;
const CURATION = cultCurationJson as CultCatalogCuration;
const THUMBNAILS = cultThumbnailsJson as unknown as CultThumbnailManifest;
const SLUGS = (cultSlugsJson as unknown as { items: Record<string, string> }).items;
/** The public id the catalog serves for an inventory row id. */
const publicId = (rowId: string) => `cult:${SLUGS[rowId]}`;

// Written independently of the projection's deny list (from a read of the shipped inventory's
// provider text), so a name the projection forgets fails here instead of passing by construction.
const BRANDS = new RegExp(
  '(?<![a-z0-9])(?:'
  + [
    'vercel', 'vite', 'apple', 'shadcn', 'heerich', 'iphone', 'ipad', 'mac', 'macos', 'macbook',
    'dynamic island', 'watch ultra', 'xdr', 'openai', 'gpt', 'chatgpt', 'dall-e', 'gemini',
    'google', 'claude', 'anthropic', 'perplexity', 'sonar', 'stripe', 'supabase', 'resend',
    'jina', 'reddit', 'trigger\\.dev', 'polar', 'v0', 'next\\.js', 'nextjs', 'redis', 'upstash',
    'radix', 'zod', 'cheerio', 'cobe', 'sonner', 'react', 'paper design', 'postgres', 'pgvector',
    'mozilla',
  ].join('|')
  + ")(?:['’]s|s)?(?![a-z0-9])",
  'i',
);

/** A string literal array (`export const NAME = [ ... ]`) read from a cult-ui-catalog source file. */
function inventoryConst(file: string, name: string): string[] {
  const source = readFileSync(new URL(`../../../packages/cult-ui-catalog/src/${file}`, import.meta.url), 'utf8');
  const body = source.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\]`))?.[1];
  if (body === undefined) throw new Error(`${name} not found in ${file}`);
  return [...body.matchAll(/'([^']+)'/g)].map((match) => match[1]!);
}

function row(overrides: Partial<CultInventoryRow> = {}): CultInventoryRow {
  return {
    id: 'cult:test',
    name: 'test',
    title: 'Marketing Hero Simple',
    description: 'A hero.',
    original: { category: 'marketing-heroes', tags: ['hero'] },
    source: { snapshotId: 'cult-ui-pro@abc', files: [{ bytes: 10 }] },
    assetKind: 'section',
    taxonomy: { sectionKind: 'hero' },
    spineAffinities: [],
    dependencies: [],
    runtimeFeatures: [],
    conversion: { status: 'unconverted' },
    ...overrides,
  };
}

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  registerCultCatalogRoutes(app, { http: { sendApiError } } as never);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function list(query = ''): Promise<CultCatalogListResponse> {
  const resp = await fetch(`${baseUrl}/api/cult/catalog${query}`);
  expect(resp.status).toBe(200);
  return parseCultCatalogListResponse(await resp.json());
}

describe('GET /api/cult/catalog', () => {
  it('serves the curated inventory as valid brand-free items while preserving full snapshot counts', async () => {
    const body = await list();
    const inventory = cultInventoryJson as unknown as { snapshot: CultCatalogListResponse['catalog']['snapshot']; rows: Array<{ id: string }> };
    const hidden = new Set(CURATION.relations.map((relation) => relation.childId));
    const visible = inventory.rows.filter((row) => !hidden.has(publicId(row.id)));
    expect(body.catalog.schema).toBe('cult-catalog/1');
    expect(body.catalog.snapshot.id).toBe(inventory.snapshot.id);
    expect(inventory.snapshot).toMatchObject(body.catalog.snapshot);
    expect(body.catalog.items.map((item) => item.id)).toEqual(visible.map((row) => publicId(row.id)));
    expect(body.catalog.items).toHaveLength(inventory.rows.length - 78);
    expect(body.catalog.items.map((item) => item.slug)).toEqual(visible.map((row) => SLUGS[row.id]));
    for (const item of body.catalog.items) {
      expect(item.displayTitle, item.id).not.toMatch(BRANDS);
      expect(item.summary, item.id).not.toMatch(BRANDS);
      expect(item.stateReason ?? '', item.id).not.toMatch(BRANDS);
      expect(item.sourceCategory.replace(/[-_/]/g, ' '), item.id).not.toMatch(BRANDS);
      for (const tag of item.tags) expect(tag.replace(/[-_/]/g, ' '), item.id).not.toMatch(BRANDS);
      expect(item.slug.replace(/-/g, ' '), item.id).not.toMatch(BRANDS);
      const inventoryRow = INVENTORY_ROWS.find((entry) => publicId(entry.id) === item.id)!;
      const thumbnail = THUMBNAILS.items[inventoryRow.id];
      const expected = typeof inventoryRow.previewId === 'string'
        ? { kind: 'image', source: 'adapter' }
        : thumbnail?.file ? { kind: 'image', source: 'source-render' } : { kind: 'none' };
      expect(item.preview, item.id).toMatchObject(expected);
      if (item.preview.kind === "image") expect(item.preview.revision, item.id).toMatch(/^[a-f0-9]{64}$/);
      expect(item.provenance.snapshotId).toBe(inventory.snapshot.id);
    }
  });

  it('curates all 58 audited examples and all 20 derived page sections under their parents', async () => {
    const catalog = (await list()).catalog;
    expect(CURATION.relations.filter((relation) => relation.relationship === 'example')).toHaveLength(58);
    expect(CURATION.relations.filter((relation) => relation.relationship === 'section')).toHaveLength(20);
    expect(new Set(CURATION.relations.filter((relation) => relation.relationship === 'example').map((relation) => relation.childId)))
      .toEqual(new Set(INVENTORY_ROWS.filter((row) => row.demoOf).map((row) => publicId(row.id))));
    expect(new Set(CURATION.relations.filter((relation) => relation.relationship === 'section').map((relation) => relation.childId)))
      .toEqual(new Set(INVENTORY_ROWS.filter((row) => row.derivedFrom).map((row) => publicId(row.id))));
    const visible = new Map(catalog.items.map((item) => [item.id, item]));
    const known = new Set(INVENTORY_ROWS.map((row) => publicId(row.id)));
    for (const relation of CURATION.relations) {
      expect(known.has(relation.parentId), relation.parentId).toBe(true);
      expect(known.has(relation.childId), relation.childId).toBe(true);
      expect(visible.has(relation.childId), relation.childId).toBe(false);
      const child = INVENTORY_ROWS.find((row) => publicId(row.id) === relation.childId)!;
      expect(visible.get(relation.parentId)?.relatedItems).toContainEqual({
        id: relation.childId, title: cultDisplayTitle(child.title), relationship: relation.relationship,
      });
      if (relation.relationship === 'section') {
        expect(publicId(child.derivedFrom!)).toBe(relation.parentId);
      } else {
        // Independent inventory evidence: all audited demos identify the source they demonstrate.
        expect(publicId(child.demoOf!), relation.childId).toBe(relation.parentId);
      }
    }
    // Shared thumbnails alone never merge independently authored sections.
    expect(visible.has('cult:nav-minimal')).toBe(true);
    expect(visible.has('cult:saas-colorful')).toBe(true);
  });

  it('ships no branded provider text anywhere, ids included, and no source', async () => {
    const text = await (await fetch(`${baseUrl}/api/cult/catalog`)).text();
    // Ids are public (`cult:<slug>`), so every string in the body is checked, keys and values alike.
    expect(text.replace(/[-_:]/g, ' ')).not.toMatch(BRANDS);
    const rows = (cultInventoryJson as unknown as { rows: CultInventoryRow[] }).rows;
    const branded = rows.filter((entry) => BRANDS.test(entry.description));
    expect(branded.length).toBeGreaterThan(40);
    for (const entry of branded) expect(text, entry.id).not.toContain(JSON.stringify(entry.description));
    expect(text).not.toContain('"sha256"');
    expect(text).not.toMatch(/<script/i);
  });

  it('filters by kind group and by state', async () => {
    const blocks = await list('?kind=blocks');
    expect(blocks.catalog.items.length).toBeGreaterThan(0);
    expect(new Set(blocks.catalog.items.map((item) => item.assetKind))).toEqual(new Set(['section', 'page']));
    const apps = await list('?kind=app&state=app-only');
    expect(apps.catalog.items.length).toBeGreaterThan(0);
    for (const item of apps.catalog.items) {
      expect(item.assetKind).toBe('app');
      expect(item.state).toBe('app-only');
    }
    const components = await list('?kind=components');
    expect(blocks.catalog.items.length + components.catalog.items.length).toBe((await list()).catalog.items.length);
  });

  it('rejects an unknown kind or state', async () => {
    expect((await fetch(`${baseUrl}/api/cult/catalog?kind=widget`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/cult/catalog?kind=constructor`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/api/cult/catalog?state=adapter-needed`)).status).toBe(400);
  });
});

describe('GET /api/cult/catalog/:id', () => {
  it('serves one item and 404s an unknown id', async () => {
    const resp = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent('cult:pricing-series-v')}`);
    expect(resp.status).toBe(200);
    const { item } = parseCultCatalogItemResponse(await resp.json());
    expect(item.id).toBe('cult:pricing-series-v');
    expect(item.slug).toBe('pricing-series-v');
    expect(item.displayTitle).toBe('Pricing (series V)');
    expect(item.assetKind).toBe('section');
    expect(item.sectionKind).toBe('pricing');
    expect((await fetch(`${baseUrl}/api/cult/catalog/cult%3Anope`)).status).toBe(404);
  });

  it('keeps each hidden example and section addressable by all aliases, with the same preview bytes', async () => {
    for (const relation of CURATION.relations) {
      const inventoryRow = INVENTORY_ROWS.find((row) => publicId(row.id) === relation.childId)!;
      for (const key of [relation.childId, SLUGS[inventoryRow.id]!, inventoryRow.id, inventoryRow.name]) {
        const response = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(key)}`);
        expect(response.status, key).toBe(200);
        const { item } = parseCultCatalogItemResponse(await response.json());
        expect(item.id, key).toBe(relation.childId);
      }
      const image = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(relation.childId)}/preview`);
      expect(image.status, relation.childId).toBe(200);
      const aliasImage = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(inventoryRow.id)}/preview`);
      expect(aliasImage.status, inventoryRow.id).toBe(200);
      expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(await aliasImage.arrayBuffer()));
    }
  }, 15_000);

  it('resolves a bare slug and the old internal id or name as aliases, and answers with the public id', async () => {
    for (const key of ['pricing-series-v', 'cult:marketing-pricing-vercel', 'marketing-pricing-vercel']) {
      const resp = await fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(key)}`);
      expect(resp.status, key).toBe(200);
      const text = await resp.text();
      expect(text, key).not.toContain('vercel');
      expect(parseCultCatalogItemResponse(JSON.parse(text)).item.id).toBe('cult:pricing-series-v');
    }
    const missing = await fetch(`${baseUrl}/api/cult/catalog/cult%3Avercel-nope`);
    expect(await missing.text()).not.toContain('vercel');
  });
});

describe('GET /api/cult/catalog/:id/preview', () => {
  const preview = (id: string) => fetch(`${baseUrl}/api/cult/catalog/${encodeURIComponent(id)}/preview`);
  const isWebp = (bytes: Uint8Array) =>
    Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP';

  it('serves a converter preview as a cacheable WebP', async () => {
    const withPreview = INVENTORY_ROWS.find((entry) => typeof entry.previewId === 'string')!;
    const resp = await preview(publicId(withPreview.id));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('image/webp');
    expect(resp.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(resp.headers.get('x-content-type-options')).toBe('nosniff');
    expect(resp.headers.get('etag')).toBeTruthy();
    expect(isWebp(new Uint8Array(await resp.arrayBuffer()))).toBe(true);
  });

  it('serves a rendered thumbnail for a row without a converter preview', async () => {
    const [id] = Object.entries(THUMBNAILS.items).find(([, entry]) => typeof entry.file === 'string')!;
    const resp = await preview(publicId(id));
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toBe('image/webp');
    expect(isWebp(new Uint8Array(await resp.arrayBuffer()))).toBe(true);
  });

  it('serves every committed image, including from hidden checkout ancestors', async () => {
    for (const item of (await list()).catalog.items) {
      expect(item.preview.kind, item.id).toBe('image');
      const response = await preview(item.id);
      expect(response.status, item.id).toBe(200);
      const bytes = new Uint8Array(await response.arrayBuffer());
      expect(isWebp(bytes), item.id).toBe(true);
      if (item.preview.kind === 'image') expect(item.preview.revision).toBe(createHash('sha256').update(bytes).digest('hex'));
    }
  }, 15_000);

  it('404s an unknown id and a row without an image', async () => {
    expect((await preview('cult:nope')).status).toBe(404);
    const placeholder = Object.entries(THUMBNAILS.items).find(([, entry]) => typeof entry.placeholder === 'string');
    if (placeholder) expect((await preview(publicId(placeholder[0]))).status).toBe(404);
  });

  it.each([
    '../catalog.json',
    '..%2F..%2Fpackage.json',
    'cult:../../catalog',
    'cult:marketing-hero-warp/../../../package.json',
    '....//....//etc/passwd',
    '%2e%2e%2fcatalog.json',
  ])('never serves a file for a traversal id (%j)', async (id) => {
    const encoded = await preview(id);
    expect(encoded.status).toBe(404);
    expect(encoded.headers.get('content-type')).not.toBe('image/webp');
    const raw = await fetch(`${baseUrl}/api/cult/catalog/${id}/preview`);
    expect([400, 404]).toContain(raw.status);
    expect(raw.headers.get('content-type') ?? '').not.toContain('image/webp');
  });

  it('refuses a preview file name that is not one .webp path segment', () => {
    const rows = [{ id: 'cult:a', previewId: '../catalog.json' }, { id: 'cult:b', previewId: null }, { id: 'cult:c', previewId: null }] as CultInventoryRow[];
    const index = cultPreviewIndex({ rows }, {
      schema: 'cult-thumbnails/1',
      items: { 'cult:b': { file: 'x/../../catalog.webp', source: 'client-render' }, 'cult:c': { placeholder: 'rendered blank' } },
    });
    expect(index.size).toBe(0);
    // And the path join stays inside its directory even for an index built by hand.
    const forged = new Map([['cult:x', { dir: 'thumbnails' as const, file: '../catalog.json', source: 'source-render' as const }]]);
    expect(cultPreviewPath('cult:x', cultGeneratedDir(), forged)).toBeNull();
  });
});

describe('Cult display projection', () => {
  it('retains unknown and unique rows and never hides a child when its reviewed parent is absent', () => {
    const rows = [row({ id: 'cult:unknown-demo', name: 'unknown-demo' }), row({ id: 'cult:unique', name: 'unique' })];
    const items = rows.map((row) => projectCultItem(row));
    expect(curateCultCatalogItems(items, { rows }, CURATION).items).toEqual(items);
    const missingParent: CultCatalogCuration = { schema: 'cult-catalog-curation/1', relations: [{ parentId: 'cult:absent', childId: 'cult:unknown-demo', relationship: 'example' }] };
    expect(curateCultCatalogItems(items, { rows }, missingParent).items).toEqual(items);
  });

  it('fails closed on conflicting or unsupported curation instead of silently dropping rows', () => {
    const rows = [row({ id: 'cult:parent', name: 'parent', assetKind: 'page' }), row({ id: 'cult:child', name: 'child', derivedFrom: 'cult:other', demoOf: 'cult:parent' })];
    const items = rows.map((row) => projectCultItem(row));
    const relation = { parentId: 'cult:parent', childId: 'cult:child', relationship: 'example' as const };
    expect(() => curateCultCatalogItems(items, { rows }, { schema: 'bad' as never, relations: [] })).toThrow('schema');
    expect(() => curateCultCatalogItems(items, { rows }, { schema: 'cult-catalog-curation/1', relations: [relation, relation] })).toThrow('repeated child');
    expect(() => curateCultCatalogItems(items, { rows }, { schema: 'cult-catalog-curation/1', relations: [{ ...relation, relationship: 'section' }] })).toThrow('parent evidence');
    const curated = curateCultCatalogItems(items, { rows }, { schema: 'cult-catalog-curation/1', relations: [relation] });
    expect(curated.items.map((item) => item.id)).toEqual(['cult:parent']);
    expect(curated.allItems.map((item) => item.id)).toEqual(['cult:parent', 'cult:child']);
    expect(items[0]!.relatedItems).toBeUndefined();
  });

  it('projects a preview image from previewId, from the thumbnail manifest, or none', () => {
    const rows = [
      row({ id: 'cult:with-preview', name: 'with-preview', previewId: 'with-preview.webp' }),
      row({ id: 'cult:with-thumbnail', name: 'with-thumbnail', previewId: null }),
      row({ id: 'cult:placeholder', name: 'placeholder', previewId: null }),
      row({ id: 'cult:absent', name: 'absent' }),
    ];
    const index = cultPreviewIndex({ rows }, {
      schema: 'cult-thumbnails/1',
      items: {
        'cult:with-thumbnail': { file: 'with-thumbnail.webp', source: 'page-render' },
        'cult:placeholder': { placeholder: 'client render is blank' },
      },
    });
    expect(projectCultItem(rows[0]!, index).preview).toEqual({ kind: 'image', source: 'adapter' });
    expect(projectCultItem(rows[1]!, index).preview).toEqual({ kind: 'image', source: 'source-render' });
    expect(projectCultItem(rows[2]!, index).preview).toEqual({ kind: 'none' });
    expect(projectCultItem(rows[3]!, index).preview).toEqual({ kind: 'none' });
    expect(projectCultItem(rows[0]!).preview).toEqual({ kind: 'none' });
    expect(() => cultPreviewIndex({ rows }, { schema: 'cult-thumbnails/9', items: {} })).toThrow('unexpected schema');
  });

  it('titles every projected section and page exactly as the section catalog does', () => {
    const entries = (sectionCatalogJson as { entries: Array<{ sourceKind: string; title: string; content: { sourceTitle?: string } }> }).entries
      .filter((entry) => entry.sourceKind === 'cult-pro');
    expect(entries.length).toBeGreaterThan(100);
    for (const entry of entries) expect(cultDisplayTitle(entry.content.sourceTitle ?? '')).toBe(entry.title);
  });

  it('replaces brand labels with a series letter', () => {
    expect(cultDisplayTitle('Marketing CTA — Heerich')).toBe('CTA (series H)');
    expect(cultDisplayTitle('Apple Keyboard')).toBe('Keyboard (series A)');
    expect(cultDisplayTitle('apple-iphone-17-pro-demo')).toBe('Phone Demo (series A)');
    expect(cultDisplayTitle('Marketing Hero Simple')).toBe('Hero Simple');
    expect(cultDisplayText('Vercel-inspired 404 page with dot-grid background')).toBe('Series V 404 page with dot-grid background');
    expect(cultDisplayText('Tabs with Vercel-style illustrations')).toBe('Tabs with series V illustrations');
    expect(cultDisplayText('text generation through the Vercel AI SDK')).toBe('text generation through the AI SDK');
    expect(cultDisplayText('border-beam glow around shadcn Button')).toBe('border-beam glow around Button');
    expect(cultDisplayText('Demo for the Apple Watch Ultra–style watch chrome')).toBe('Demo for the series A watch chrome');
    expect(cultDisplayText('iPhone-style device frame with Dynamic Island')).toBe('Series A phone device frame with camera cutout');
    expect(cultDisplayText('matching the hero-vite design language')).toBe('matching the hero (series VT) design language');
  });

  it('cleans a dash left by a removed name however it was spaced', () => {
    expect(cultDisplayTitle('Marketing CTA —Heerich')).toBe('CTA (series H)');
    expect(cultDisplayTitle('Marketing CTA—Heerich')).toBe('CTA (series H)');
    expect(cultDisplayTitle('Heerich — Marketing CTA')).toBe('CTA (series H)');
    expect(cultDisplayTitle('Marketing CTA - Vercel')).toBe('CTA (series V)');
    expect(cultDisplayTitle('Hero -Simple')).toBe('Hero -Simple');
  });

  it('humanizes a slug title in any case', () => {
    expect(cultDisplayTitle('Apple-Keyboard')).toBe('Keyboard (series A)');
    expect(cultDisplayTitle('Marketing-Pricing-Vercel')).toBe('Pricing (series V)');
    expect(cultDisplayTitle('marketing-pricing-vercel')).toBe('Pricing (series V)');
    expect(cultDisplayTitle('ai-chat-demo')).toBe('AI Chat Demo');
  });

  it('scrubs vendor, service and library names from titles', () => {
    expect(cultDisplayTitle('Stripe Subscription')).toBe('Card Payment Subscription');
    expect(cultDisplayTitle('OpenAI and AI SDK Chatbot')).toBe('Hosted Model and AI SDK Chatbot');
    expect(cultDisplayTitle('Globe (COBE)')).toBe('Globe');
    expect(cultDisplayTitle('Next.js + Forms')).toBe('Web App + Forms');
    expect(cultDisplayTitle('AI SDK Gemini Flash Image')).toBe('AI SDK Image');
    expect(cultDisplayTitle('V0 Clone')).toBe('Interface Builder Clone');
  });

  // The audit's leaking examples (cult-b1-deepseek BLOCK 1): other providers, possessives,
  // plurals, "-style" / "-inspired" / "-powered" clauses, "inspired by", odd case and spacing.
  it.each([
    ["uses OpenAI's GPT-5-nano model for conversations", 'uses a hosted language model for conversations'],
    ["Uses Perplexity's Sonar model to provide answers", 'Uses a hosted search model to provide answers'],
    ["using Google's Gemini 2.5 Flash model through the Vercel AI SDK", 'using a hosted model through the AI SDK'],
    ['Compare AI models like GPT-4, Claude, and Gemini.', 'Compare AI models from several providers.'],
    ['Subscription management system with Stripe and Redis.', 'Subscription management system with a payments service and a cache.'],
    ['Sonner-backed polished toasts', 'Polished toasts'],
    ['COBE-powered 3D globe', '3D globe'],
    ['AI interface builder inspired by V0. Features chat.', 'AI interface builder. Features chat.'],
    ['Payment system powered by Polar.sh. Features webhooks.', 'Payment system powered by a payments service. Features webhooks.'],
    ["A block using Trigger.dev v3", 'A block using a background job service'],
    ["VERCEL’S pricing grid", 'Series V pricing grid'],
    ['Two Vercels side by side', 'Two series V side by side'],
    ['Stripe-inspired checkout', 'Checkout'],
    ['A Linear-style task list', 'A task list'],
    ['A linear gradient', 'A linear gradient'],
    ['Heerich\nhero with\ttabs', 'Series H hero with tabs'],
    ['Pricing table in the style of Acme Corp.', 'Pricing table.'],
  ])('cultDisplayText(%j) is brand-free', (raw, expected) => {
    const text = cultDisplayText(raw);
    expect(text).toBe(expected);
    expect(text).not.toMatch(BRANDS);
  });

  it('drops tags and categories that name a brand', () => {
    expect(cultDisplayTags(['ai', 'stripe-payments', 'openai-gpt4', 'next-js', 'redis-cache', 'linear', 'hero'])).toEqual(['ai', 'linear', 'hero']);
    expect(cultDisplayCategory('marketing-pricing')).toBe('marketing-pricing');
    expect(cultDisplayCategory('vercel-templates')).toBe('other');
  });

  it('never lets the raw text of a branded row into the projected item', () => {
    const item = projectCultItem(row({
      title: 'Marketing Pricing Stripe',
      description: "Stripe's pricing table, Vercel-inspired, with OpenAI’s GPT-4o",
      original: { category: 'openai-apps', tags: ['stripe', 'pricing'] },
      conversion: { status: 'adapter-needed', reason: 'needs Supabase\nand Redis' },
    }));
    const text = JSON.stringify(item);
    expect(text).not.toMatch(BRANDS);
    expect(item.stateReason).toBe('needs a vector store and a cache');
    expect(item.sourceCategory).toBe('other');
    expect(item.tags).toEqual(['pricing']);
  });

  it('reads each conversion status as its own honest state', () => {
    expect(cultState('pending-fetch')).toBe('pending');
    expect(cultState('unconverted')).toBe('not-converted');
    expect(cultState('adapter-needed')).toBe('needs-adaptation');
    expect(cultState('app-only')).toBe('app-only');
    expect(cultState('insertable')).toBe('insertable');
    const states = CULT_INVENTORY_CONVERSION_STATUSES.map(cultState);
    expect(new Set(states).size).toBe(CULT_INVENTORY_CONVERSION_STATUSES.length);
  });

  it('throws on an unknown status, section kind or port queue instead of guessing', () => {
    expect(() => cultState('half-converted')).toThrow('unknown conversion status "half-converted"');
    expect(() => projectCultItem(row({ taxonomy: { sectionKind: 'widget-wall' } }))).toThrow('unknown section kind');
    expect(() => projectCultItem(row({ portQueue: 'rewrite' }))).toThrow('unknown port queue');
  });

  it("mirrors the inventory package's closed lists", () => {
    expect([...CULT_INVENTORY_CONVERSION_STATUSES]).toEqual(inventoryConst('types.ts', 'CONVERSION_STATUSES'));
    expect([...CULT_CATALOG_SECTION_KINDS]).toEqual([...inventoryConst('taxonomy.ts', 'TAXONOMY_SECTION_IDS'), 'page-composition', 'unclassified']);
  });
});

describe('GET /api/cult/catalog on the booted daemon', () => {
  let bootedServer: http.Server | undefined;
  let bootedUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    bootedUrl = started.url;
    bootedServer = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    const startedServer = bootedServer;
    if (startedServer) await new Promise<void>((resolve) => startedServer.close(() => resolve()));
  });

  it('is registered', async () => {
    const resp = await fetch(`${bootedUrl}/api/cult/catalog?kind=page`);
    expect(resp.status).toBe(200);
    const body = parseCultCatalogListResponse(await resp.json());
    expect(body.catalog.items.every((item) => item.assetKind === 'page')).toBe(true);
  });
});
