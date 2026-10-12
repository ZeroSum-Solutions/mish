/**
 * Writes a small synthetic source kit to a temp dir. Every item and file here is invented test
 * data in the registry's shape; no real kit content is used, so tests run without the private kit.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

interface FixtureItem {
  name: string;
  type: string;
  category: string;
  tags?: string[];
  useCases?: string[];
  style?: Record<string, unknown>;
  dependencies?: string[];
  env?: Array<{ name: string }>;
  /** path → content (content is ignored for unfetched items). */
  files: Record<string, string>;
  fetched: boolean;
}

export const FIXTURE_ITEMS: FixtureItem[] = [
  {
    name: 'hero-alpha', type: 'registry:block', category: 'marketing-heroes',
    tags: ['hero'], useCases: ['SaaS landing pages'], style: { spacing: 'large' }, dependencies: ['motion'],
    files: { 'registry/sections/hero-alpha/page.tsx': "import { motion } from 'motion/react';\nexport default function P() { return <img src=\"https://img.example.org/a.png\" onClick={() => {}} />; }\n" },
    fetched: true,
  },
  {
    name: 'pricing-beta', type: 'registry:block', category: 'marketing-pricing',
    tags: ['pricing', 'toggle', 'comparison'], useCases: ['Online store checkout'],
    files: { 'registry/sections/pricing-beta/page.tsx': 'export default function P() { return null; }\n' },
    fetched: true,
  },
  {
    name: 'cta-gamma', type: 'registry:block', category: 'marketing-cta',
    useCases: ['Nonprofit campaigns', 'Online courses', 'Event booking', 'Newsletter growth'],
    files: { 'registry/sections/cta-gamma/page.tsx': 'export default function P() { return <canvas />; }\n' },
    fetched: true,
  },
  {
    name: 'chat-delta', type: 'registry:block', category: 'ai', dependencies: ['ai'], env: [{ name: 'KEY' }],
    useCases: ['SaaS support'],
    files: {
      'registry/blocks/chat-delta/app/page.tsx': 'export default function P() { return null; }\n',
      'registry/blocks/chat-delta/app/api/chat/route.ts': "'use server';\nexport async function POST() {}\n",
    },
    fetched: true,
  },
  { name: 'button-epsilon', type: 'registry:ui', category: 'ui', files: { 'registry/components/button-epsilon.tsx': '' }, fetched: false },
  { name: 'button-epsilon-demo', type: 'registry:component', category: 'ui', files: { 'registry/examples/button-epsilon-demo.tsx': '' }, fetched: false },
  { name: 'page-zeta', type: 'registry:block', category: 'landing-page', useCases: ['Startup landing pages'], files: { 'registry/pages/page-zeta/page.tsx': '' }, fetched: false },
];

function indexEntry(item: FixtureItem) {
  return {
    name: item.name,
    type: item.type,
    title: item.name.replace(/-/g, ' '),
    description: `Synthetic ${item.name}`,
    dependencies: item.dependencies ?? [],
    registryDependencies: [],
    files: Object.keys(item.files).map((path) => ({ path, type: 'registry:component', target: path })),
    meta: {
      category: item.category,
      tags: item.tags ?? [],
      useCases: item.useCases ?? [],
      ...(item.style ? { style: item.style } : {}),
      externalServices: [],
      env: item.env ?? [],
    },
  };
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Creates the kit and returns its directory. `broken` adds an item whose file is truncated JSON. */
export function writeFixtureKit(options: { broken?: boolean } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'cult-kit-'));
  const items = [...FIXTURE_ITEMS];
  if (options.broken) {
    items.push({ name: 'broken-eta', type: 'registry:ui', category: 'ui', files: { 'registry/components/broken-eta.tsx': '' }, fetched: false });
  }
  write(join(dir, 'registry', 'index.json'), JSON.stringify({ name: 'fixture', items: items.map(indexEntry) }));
  for (const item of items) {
    if (!item.fetched) continue;
    const files = Object.entries(item.files).map(([path, content]) => ({ path, type: 'registry:component', target: path, content }));
    write(join(dir, 'registry', `${item.name}.json`), JSON.stringify({ ...indexEntry(item), files }));
    for (const [path, content] of Object.entries(item.files)) write(join(dir, 'src', item.name, path), content);
  }
  if (options.broken) write(join(dir, 'registry', 'broken-eta.json'), '{"name": "broken-eta", "files": [');
  return dir;
}
