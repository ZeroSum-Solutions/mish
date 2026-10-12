// Remix into project, brand-free: an item is served and installed under its public slug, with
// brand-free file and folder names and export names, while its old internal name still resolves.
// A small branded fixture kit; tests/cult-brand-free-surfaces.test.ts covers every catalog row.

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseCultCopyResponse, parseCultRegistryItem } from '@mish/contracts';
import { runCultAddCli } from '../src/cult-add-cli.js';
import { CultRegistry, scrubPageMetadata } from '../src/cult-registry.js';
import { registerCultRegistryRoutes } from '../src/routes/cult-registry.js';
import { writeFixtureKit, type FixtureItem } from './helpers/cult-kit-fixture.js';

const ITEMS: FixtureItem[] = [
  {
    name: 'vercel-glow',
    type: 'registry:ui',
    files: [{
      path: 'registry/components/vercel-glow.tsx',
      type: 'registry:ui',
      target: 'components/vercel-glow.tsx',
      content: 'export interface VercelGlowProps { on: boolean }\nexport function VercelGlow(props: VercelGlowProps) { return <i data-on={props.on} />; }\n',
    }],
  },
  {
    name: 'marketing-pricing-vercel',
    type: 'registry:block',
    dependencies: ['motion'],
    registryDependencies: ['vercel-glow', 'button'],
    files: [
      {
        path: 'registry/blocks/marketing-pricing-vercel/app/pricing-vercel.tsx',
        type: 'registry:page',
        target: 'app/pricing-vercel.tsx',
        content: [
          "import { VercelGlow } from '@/components/vercel-glow';",
          "import { StripeCheckout } from './stripe-checkout';",
          '// VercelPricing renders the shelf.',
          'export default function VercelPricing() { return <VercelGlow on />; }',
          'VercelPricing.displayName = "VercelPricing";',
          'export function assertShelf(ok: boolean) { if (!ok) throw new Error("VercelPricing must be inside a shelf"); }',
          "export function VercelBadge() { return <span title=\"VercelBadge\">{'VercelBadge'}</span>; }",
          'export const HeroSeriesV = 1;',
          'export function HeroVercel() { return HeroSeriesV; }',
          'export { StripeCheckout };',
          '',
        ].join('\n'),
      },
      {
        path: 'registry/blocks/marketing-pricing-vercel/app/stripe-checkout.tsx',
        type: 'registry:component',
        target: 'app/stripe-checkout.tsx',
        content: 'export function StripeCheckout() { return null; }\n',
      },
    ],
  },
];

const SLUGS = new Map([
  ['cult:vercel-glow', 'glow-series-v'],
  ['cult:marketing-pricing-vercel', 'pricing-series-v'],
]);

function sendApiError(res: express.Response, status: number, code: string, message: string) {
  res.status(status).json({ error: { code, message } });
}

let server: http.Server;
let baseUrl: string;
let registry: CultRegistry;

beforeAll(async () => {
  const kit = writeFixtureKit(ITEMS);
  const rows = kit.rows.map((row) => ({
    ...row,
    title: row.name === 'vercel-glow' ? 'Vercel Glow' : 'Marketing Pricing Vercel',
    description: 'A Vercel-inspired pricing shelf.',
  }));
  registry = new CultRegistry(rows, kit.kitDir, SLUGS);
  const app = express();
  registerCultRegistryRoutes(app, { http: { sendApiError } } as never, { rows, kitDir: kit.kitDir, slugs: SLUGS });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function served(name: string) {
  const resp = await fetch(`${baseUrl}/api/cult/r/${name}.json`);
  expect(resp.status, name).toBe(200);
  const text = await resp.text();
  return { text, item: parseCultRegistryItem(JSON.parse(text)), body: JSON.parse(text) as Record<string, unknown> };
}

describe('the served item', () => {
  it('is published under its slug, with brand-free names, paths, title and description', async () => {
    const { item, body } = await served('pricing-series-v');
    expect(item.name).toBe('pricing-series-v');
    expect(body.title).toBe('Pricing (series V)');
    expect(body.description).toBe('A series V pricing shelf.');
    expect(body).not.toHaveProperty('author');
    expect(body).not.toHaveProperty('meta');
    expect(body).not.toHaveProperty('$schema');
    expect(item.registryDependencies).toEqual([`${baseUrl}/api/cult/r/glow-series-v.json`, 'button']);
    expect(item.files.map((file) => file.target)).toEqual(['app/pricing-series-v.tsx', 'app/card-payment-checkout.tsx']);
    expect(item.files.map((file) => file.path)).toEqual([
      'registry/blocks/pricing-series-v/app/pricing-series-v.tsx',
      'registry/blocks/pricing-series-v/app/card-payment-checkout.tsx',
    ]);
  });

  it('renames branded exports consistently across the item and what it installs', async () => {
    const pricing = (await served('pricing-series-v')).item.files[0]!.content;
    expect(pricing).toContain("import { GlowSeriesV } from '@/components/glow-series-v';");
    expect(pricing).toContain("import { CardPaymentCheckout } from './card-payment-checkout';");
    expect(pricing).toContain('export default function PricingSeriesV() { return <GlowSeriesV on />; }');
    expect(pricing).toContain('// PricingSeriesV renders the shelf.');
    expect(pricing).toContain('PricingSeriesV.displayName = "PricingSeriesV";');
    expect(pricing).toContain('throw new Error("PricingSeriesV must be inside a shelf")');
    expect(pricing).toContain('export { CardPaymentCheckout };');
    const glow = (await served('glow-series-v')).item.files[0]!.content;
    expect(glow).toContain('export interface GlowPropsSeriesV');
    expect(glow).toContain('export function GlowSeriesV(props: GlowPropsSeriesV)');
    const checkout = (await served('pricing-series-v')).item.files[1]!.content;
    expect(checkout).toBe('export function CardPaymentCheckout() { return null; }\n');
  });

  it('keeps an export name that is also a key and says why; a taken new name gets a number', async () => {
    const pricing = (await served('pricing-series-v')).item.files[0]!.content;
    expect(pricing).toContain("export function VercelBadge() { return <span title=\"VercelBadge\">{'VercelBadge'}</span>; }");
    // `HeroVercel` would be `HeroSeriesV`, which the item already defines: it takes `HeroSeriesV2`.
    expect(pricing).toContain('export function HeroSeriesV2() { return HeroSeriesV; }');
    const decisions = registry.exportRenames('pricing-series-v');
    expect(decisions.find((entry) => entry.from === 'VercelBadge')).toMatchObject({ to: null, skipped: expect.stringContaining('key') });
    expect(decisions.find((entry) => entry.from === 'HeroVercel')).toEqual({ from: 'HeroVercel', to: 'HeroSeriesV2' });
    expect(decisions.find((entry) => entry.from === 'VercelPricing')).toEqual({ from: 'VercelPricing', to: 'PricingSeriesV' });
  });
});

describe('aliases', () => {
  it('never repeats a requested name or file path in a 404', async () => {
    const item = await fetch(`${baseUrl}/api/cult/r/marketing-vercel-nope.json`);
    expect(item.status).toBe(404);
    expect(await item.text()).not.toMatch(/vercel/i);
    const file = await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent('cult:pricing-series-v')}?file=${encodeURIComponent('app/vercel-nope.tsx')}`);
    expect(file.status).toBe(404);
    expect(await file.text()).not.toMatch(/vercel/i);
  });

  it('serves the same item for the old internal name, and never echoes it', async () => {
    const bySlug = await served('pricing-series-v');
    const byAlias = await served('marketing-pricing-vercel');
    expect(byAlias.text).toBe(bySlug.text);
    const copy = parseCultCopyResponse(await (await fetch(`${baseUrl}/api/cult/copy/${encodeURIComponent('cult:marketing-pricing-vercel')}`)).json()).copy;
    expect(copy.id).toBe('cult:pricing-series-v');
    expect(copy.name).toBe('pricing-series-v');
    expect(copy.registryUrl).toBe(`${baseUrl}/api/cult/r/pricing-series-v.json`);
    expect(copy.mainFile.target).toBe('app/pricing-series-v.tsx');
  });

  it('`od cult add` with the old name installs under the slug and prints only the slug', async () => {
    const into = mkdtempSync(path.join(tmpdir(), 'cult-alias-'));
    const result = await runCultAddCli(['cult:marketing-pricing-vercel', '--into', into], { resolveBaseUrl: async () => baseUrl });
    expect(result.kind).toBe('done');
    if (result.kind !== 'done') return;
    expect(result.code, result.stderr.join('\n')).toBe(0);
    expect(result.stdout).toContain('Copied cult:pricing-series-v, cult:glow-series-v into');
    expect(result.stdout).not.toMatch(/vercel/i);
    expect(readdirSync(path.join(into, 'app', '(cult)'))).toEqual(['pricing-series-v']);
    expect(readdirSync(path.join(into, 'app', '(cult)', 'pricing-series-v')).sort()).toEqual(['card-payment-checkout.tsx', 'pricing-series-v.tsx']);
    const page = readFileSync(path.join(into, 'app', '(cult)', 'pricing-series-v', 'pricing-series-v.tsx'), 'utf8');
    expect(page).toContain("from '@/app/(cult)/pricing-series-v/card-payment-checkout'");
    expect(readFileSync(path.join(into, 'components', 'glow-series-v.tsx'), 'utf8')).toContain('export function GlowSeriesV');
  });
});

describe('page metadata', () => {
  it('scrubs the title and description a Next page shows, and nothing else', () => {
    const page = [
      "import { cn } from '@/lib/utils';",
      'export const metadata = {',
      '  title: "Marketing Pricing Vercel",',
      '  description:',
      '    "Vercel-inspired pricing section with a billing toggle.",',
      '};',
      "const other = { title: 'Vercel' };",
      '',
    ].join('\n');
    const out = scrubPageMetadata(page);
    expect(out).toContain('title: "Pricing (series V)"');
    expect(out).toContain('"Series V pricing section with a billing toggle."');
    expect(out).toContain("const other = { title: 'Vercel' };");
  });
});
