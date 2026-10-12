// A throwaway Cult UI Pro source kit and matching inventory rows for the Remix into project tests:
// `registry/<name>.json` items whose sha256 the rows pin, like the real kit and catalog.json.

import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { CultRegistryRow } from '../../src/cult-registry.js';

export interface FixtureItem {
  name: string;
  type?: string;
  dependencies?: string[];
  registryDependencies?: string[];
  files: Array<{ path: string; type: string; target: string; content: string }>;
}

export const FIXTURE_ITEMS: FixtureItem[] = [
  {
    name: 'glow-card',
    type: 'registry:ui',
    dependencies: ['motion'],
    files: [{
      path: 'registry/components/glow-card.tsx',
      type: 'registry:ui',
      target: 'components/glow-card.tsx',
      content: "import { cn } from '@/lib/utils';\nexport function GlowCard() { return <div className={cn('a')} />; }\n",
    }],
  },
  {
    name: 'pricing-shelf',
    type: 'registry:block',
    dependencies: ['lucide-react', 'motion'],
    registryDependencies: ['glow-card', 'button'],
    files: [
      {
        path: 'registry/components/blocks/pricing-shelf.tsx',
        type: 'registry:component',
        target: 'components/pricing-shelf.tsx',
        content: "import { GlowCard } from '@/components/glow-card';\nimport { Button } from '@/registry/ui/button';\nimport { useTier } from '@/hooks/use-tier';\nexport { GlowCard as Again } from '../glow-card';\nexport function PricingShelf() { return <GlowCard />; }\n",
      },
      {
        path: 'registry/blocks/pricing-shelf/use-tier.ts',
        type: 'registry:hook',
        target: 'hooks/use-tier.ts',
        content: 'export function useTier() { return 1; }\n',
      },
    ],
  },
  {
    name: 'shop',
    type: 'registry:block',
    dependencies: ['motion'],
    files: [
      { path: 'registry/pages/shop/app/page.tsx', type: 'registry:page', target: 'app/page.tsx', content: "import { Hero } from '../components/hero';\nimport { Missing } from '../nowhere/missing';\nexport default function Page() { return <Hero />; }\n" },
      { path: 'registry/pages/shop/components/sections/hero.tsx', type: 'registry:component', target: 'components/hero.tsx', content: 'export function Hero() { return <h1>Shop</h1>; }\n' },
    ],
  },
  ...['alpha-app', 'beta-app'].map((name) => ({
    name,
    type: 'registry:block',
    files: [
      { path: `registry/blocks/${name}/app/page.tsx`, type: 'registry:page', target: 'app/page.tsx', content: "import { Demo } from './demo';\nimport { run } from '@/app/actions';\nexport default function Page() { return <Demo />; }\n" },
      { path: `registry/blocks/${name}/app/demo.tsx`, type: 'registry:component', target: 'app/demo.tsx', content: `export function Demo() { return <p>${name}</p>; }\n` },
      { path: `registry/blocks/${name}/app/actions.tsx`, type: 'registry:page', target: 'app/actions.tsx', content: `export async function run() { return '${name}'; }\n` },
      { path: `registry/blocks/${name}/app/api/chat/route.ts`, type: 'registry:page', target: 'app/api/chat/route.ts', content: `export async function POST() { return new Response('${name}'); }\n` },
      { path: `registry/blocks/${name}/AGENT_FLOW.md`, type: 'registry:lib', target: 'AGENT_FLOW.md', content: `# ${name}\n` },
    ],
  })),
];

export function writeFixtureKit(items: FixtureItem[] = FIXTURE_ITEMS): { kitDir: string; rows: CultRegistryRow[] } {
  const kitDir = mkdtempSync(path.join(tmpdir(), 'cult-kit-'));
  mkdirSync(path.join(kitDir, 'registry'), { recursive: true });
  const rows: CultRegistryRow[] = [];
  for (const item of items) {
    const body = JSON.stringify({
      $schema: 'https://ui.shadcn.com/schema/registry-item.json',
      name: item.name,
      type: item.type ?? 'registry:ui',
      dependencies: item.dependencies ?? [],
      registryDependencies: item.registryDependencies ?? [],
      files: item.files,
    }, null, 2);
    writeFileSync(path.join(kitDir, 'registry', `${item.name}.json`), body);
    rows.push({
      id: `cult:${item.name}`,
      name: item.name,
      dependencies: item.dependencies ?? [],
      source: {
        registrySha256: createHash('sha256').update(body).digest('hex'),
        files: item.files.map(({ path: p, target, type }) => ({ path: p, target, type })),
      },
    });
  }
  // A section the converter cut out of the `shop` page: not a registry item of its own.
  const shop = rows.find((row) => row.name === 'shop');
  if (shop) rows.push({ ...shop, id: 'cult:shop--hero', name: 'shop--hero', derivedFrom: 'cult:shop' });
  return { kitDir, rows };
}
