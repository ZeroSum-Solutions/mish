// Builds small owned Mish pack fixtures in a temp folder. Nothing here is licensed content: the
// catalogue rows, skills and design systems are invented test data.

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import JSZip from 'jszip';

export const cleanupDirs: string[] = [];

export function tempDir(prefix = 'mish-pack-test-'): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

export function writeFile(root: string, relative: string, content: string | Buffer): void {
  const file = path.join(root, ...relative.split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export function testInventoryRow(name: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `cult:${name}`,
    name,
    title: 'Pack Hero',
    description: 'A hero from a test pack.',
    original: { category: 'marketing-heroes', tags: ['hero'] },
    source: { snapshotId: 'test-pack@1', registrySha256: null, files: [{ bytes: 10, path: 'x.tsx', target: 'components/x.tsx', type: 'registry:component' }] },
    assetKind: 'section',
    taxonomy: { sectionKind: 'hero' },
    spineAffinities: [],
    dependencies: [],
    runtimeFeatures: [],
    conversion: { status: 'unconverted' },
    ...overrides,
  };
}

export interface FixturePackOptions {
  id?: string;
  version?: string;
  /** Extra `provides` keys merged over the defaults. */
  provides?: Record<string, unknown>;
  /** Extra top-level manifest keys. */
  manifest?: Record<string, unknown>;
}

/** A pack with a one-row Cult catalogue, two skills, one design system, one study and a section file. */
export function writeFixturePack(root: string, options: FixturePackOptions = {}): { id: string; rowName: string } {
  const id = options.id ?? 'team-kit';
  const rowName = 'pack-hero';
  writeFile(root, 'catalog/catalog.json', JSON.stringify({
    schema: 'cult-ui-catalog/1',
    snapshot: { id: 'test-pack@1', expectedItems: 1, fetchedItems: 1, pendingItems: 0 },
    rows: [testInventoryRow(rowName)],
  }));
  writeFile(root, 'catalog/generated/slugs.json', JSON.stringify({ schema: 'cult-slugs/1', items: { [`cult:${rowName}`]: 'hero-series-pack' } }));
  writeFile(root, 'skills/pack-skill-a/SKILL.md', '---\nname: pack-skill-a\ndescription: test skill\n---\nBody A\n');
  writeFile(root, 'skills/pack-skill-b/SKILL.md', '---\nname: pack-skill-b\ndescription: test skill\n---\nBody B\n');
  writeFile(root, 'design-systems/pack-ds/DESIGN.md', '# Pack design system\n');
  writeFile(root, 'studies/study-one/DESIGN.md', '# Study one\n');
  writeFile(root, 'sections/sections.json', JSON.stringify({ entries: [{ id: 'pack-section-1', title: 'Pack section' }] }));
  writeFile(root, 'mish-pack.json', JSON.stringify({
    schemaVersion: 1,
    id,
    name: 'Team kit',
    version: options.version ?? '1.0.0',
    description: 'Owned test fixture',
    provides: {
      catalogs: { cultCatalog: 'catalog', sections: 'sections/sections.json' },
      skills: 'skills',
      designSystems: 'design-systems',
      studies: 'studies',
      env: { MISH_AMR_CONSOLE_URL: 'https://console.example.test' },
      mcpServers: [
        { id: 'pack-http', transport: 'http', url: 'https://mcp.example.test/mcp', authMode: 'oauth' },
        { id: 'pack-stdio', transport: 'stdio', command: 'node', args: ['server.mjs'], env: { TOKEN: '${PACK_TEST_TOKEN}' } },
      ],
      ...options.provides,
    },
    ...options.manifest,
  }, null, 2));
  return { id, rowName };
}

/** Zips a folder into `zipFile`; `wrapper` puts everything under one top-level folder, as Finder does. */
export async function zipFolder(sourceDir: string, zipFile: string, wrapper?: string): Promise<void> {
  const { promises: fsp } = await import('node:fs');
  const zip = new JSZip();
  const walk = async (dir: string, prefix: string) => {
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
      else zip.file(wrapper ? `${wrapper}/${rel}` : rel, await fsp.readFile(path.join(dir, entry.name)));
    }
  };
  await walk(sourceDir, '');
  await fsp.writeFile(zipFile, await zip.generateAsync({ type: 'nodebuffer' }));
}
