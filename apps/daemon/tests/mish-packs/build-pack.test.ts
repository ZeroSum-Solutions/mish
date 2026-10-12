// scripts/build-pack.mjs against a small invented "private checkout", then the result through the
// real install path. The fixture holds no licensed content.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, promises as fsp, symlinkSync } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { mishPackManifestSchema } from '@mish/contracts';
import { listSectionAdapterIds, resolveSectionAdapter } from '@mish/agency-fast-lane/section-overlay';

import { cultInventoryData } from '../../src/cult-data.js';
import { resolveCultKitDir } from '../../src/cult-registry.js';
import { installFastLanePackOverlay } from '../../src/mish-packs/fast-lane-bridge.js';
import { resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore } from '../../src/mish-packs/store.js';
import { sectionCatalogData } from '../../src/section-catalog-data.js';
import { cleanupDirs, tempDir, testInventoryRow, writeFile } from './pack-fixture.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const script = path.join(repoRoot, 'scripts', 'build-pack.mjs');

function build(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

let source: string;
let mapFile: string;

/** An invented private checkout laid out the way the committed map expects. */
async function writeSource(root: string): Promise<void> {
  writeFile(root, 'data/component-kits/cult-ui-pro/manifest.json', '{"schemaVersion":1,"files":[]}');
  writeFile(root, 'packages/cult-ui-catalog/catalog.json', JSON.stringify({
    schema: 'cult-ui-catalog/1',
    snapshot: { id: 's@1', expectedItems: 1, fetchedItems: 1, pendingItems: 0 },
    rows: [testInventoryRow('pack-hero')],
  }));
  writeFile(root, 'packages/cult-ui-catalog/generated/slugs.json', JSON.stringify({ schema: 'cult-slugs/1', items: { 'cult:pack-hero': 'hero-series-pack' } }));
  writeFile(root, 'packages/cult-ui-catalog/generated/index.ts', `export const CULT_ADAPTERS = { 'cult:pack-hero': async () => ({ id: 'cult:pack-hero' }) } as const;\n`);
  writeFile(root, 'packages/genui-catalog/catalog.json', JSON.stringify({ components: [
    { id: 'pack-card', name: 'Pack card', source: { name: 'cult-ui-pro' } },
    { id: 'public-card', name: 'Public', source: { name: 'original' } },
  ] }));
  writeFile(root, 'packages/section-catalog/catalog.json', JSON.stringify({ entries: [{ id: 'pack-only-section', title: 'Only in the private checkout' }] }));
  writeFile(root, '.od/design-systems/atlas-one/DESIGN.md', '# Atlas');
  writeFile(root, '.od/design-systems/study-one/DESIGN.md', '# Study');
  writeFile(root, '.od/skills/team-skill/SKILL.md', '---\nname: team-skill\n---\n');
  writeFile(root, '.od/skills/team-skill/.env', 'SECRET=1');
  writeFile(root, '.od/skills/team-skill/node_modules/dep/index.js', 'x');
  writeFile(root, '.od/skills/team-skill/mcp-tokens.json', '{}');
  writeFile(root, 'skills/agency-demo/SKILL.md', '---\nname: agency-demo\n---\n');
  writeFile(root, 'skills/not-included/SKILL.md', 'x');
  symlinkSync('/etc/hosts', path.join(root, '.od', 'skills', 'team-skill', 'link'));
}

beforeEach(async () => {
  source = tempDir('mish-private-');
  await writeSource(source);
  mapFile = path.join(tempDir('mish-map-'), 'map.json');
  await fsp.writeFile(mapFile, JSON.stringify({
    schemaVersion: 1,
    pack: { id: 'built-pack', name: 'Built pack', version: '9.9.9' },
    resources: [
      { provides: 'catalogs.cultKit', type: 'dir', from: 'data/component-kits/cult-ui-pro', to: 'catalogs/cult-kit', optional: false },
      { provides: 'catalogs.cultCatalog', type: 'files', to: 'catalogs/cult-catalog', files: [
        { from: 'packages/cult-ui-catalog/catalog.json', to: 'catalog.json' },
        { from: 'packages/cult-ui-catalog/generated/slugs.json', to: 'generated/slugs.json', optional: true },
        { from: 'packages/cult-ui-catalog/generated/previews', to: 'generated/previews', optional: true },
      ] },
      { provides: 'catalogs.cultAdapters', type: 'bundle', entry: 'packages/cult-ui-catalog/generated/index.ts', to: 'catalogs/cult-adapters/index.mjs' },
      { provides: 'catalogs.genui', type: 'genui-overlay', catalog: 'packages/genui-catalog/catalog.json', sourceName: 'cult-ui-pro', to: 'catalogs/genui' },
      { provides: 'catalogs.sections', type: 'catalog-delta', from: 'packages/section-catalog/catalog.json', againstPublic: 'packages/section-catalog/catalog.json', to: 'catalogs/sections.json' },
      { provides: 'designSystems', type: 'children', to: 'design-systems', sources: [{ from: '.od/design-systems', include: ['atlas-*'] }] },
      { provides: 'studies', type: 'children', to: 'studies', sources: [{ from: '.od/design-systems', include: ['study-*'] }] },
      { provides: 'skills', type: 'children', to: 'skills', sources: [{ from: '.od/skills', include: ['*'] }, { from: 'skills', include: ['agency-*'] }] },
      { provides: 'assets.pets', type: 'dir', from: 'assets/community-pets', to: 'assets/pets' },
    ],
    env: { MISH_AMR_CONSOLE_URL: 'https://console.example.test' },
    mcpServers: [{ id: 'refero', transport: 'http', url: 'https://api.example.test/mcp', authMode: 'oauth' }],
  }));
});

afterEach(async () => {
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('scripts/pack-map.json', () => {
  it('is well formed: known types, unique targets, and MCP servers the schema accepts', async () => {
    const map = JSON.parse(await fsp.readFile(path.join(repoRoot, 'scripts', 'pack-map.json'), 'utf8')) as {
      resources: Array<{ provides: string; type: string; to: string }>;
      env: Record<string, string>;
      mcpServers: unknown[];
    };
    const types = new Set(['dir', 'files', 'children', 'bundle', 'genui-overlay', 'catalog-delta']);
    expect(map.resources.every((resource) => types.has(resource.type))).toBe(true);
    expect(new Set(map.resources.map((resource) => resource.provides)).size).toBe(map.resources.length);
    expect(new Set(map.resources.map((resource) => resource.to)).size).toBe(map.resources.length);
    const provides: Record<string, unknown> = { mcpServers: map.mcpServers, env: map.env };
    expect(mishPackManifestSchema.safeParse({ schemaVersion: 1, id: 'team-packet', name: 'x', version: '1', provides }).success).toBe(true);
    // Credentials are placeholders only.
    expect(JSON.stringify(map.mcpServers)).toMatch(/\$\{[A-Z_]+\}/);
  });
});

describe('build-pack', () => {
  it('builds a pack from the private checkout that installs and overlays everything', async () => {
    const out = path.join(tempDir('mish-out-'), 'packet.zip');
    const result = build([source, out, '--map', mapFile, '--json']);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { files: number; resources: Array<{ resource: string; status: string }>; skipped: Record<string, string[]> };
    expect(summary.resources.filter((entry) => entry.status === 'packed').map((entry) => entry.resource)).toEqual(expect.arrayContaining([
      'catalogs.cultKit', 'catalogs.cultCatalog', 'catalogs.cultAdapters', 'catalogs.genui', 'catalogs.sections', 'designSystems', 'studies', 'skills',
    ]));
    // The pets folder is absent in the checkout: skipped, not an error.
    expect(summary.resources.find((entry) => entry.resource === 'assets.pets')?.status).toBe('skipped');
    expect(Object.keys(summary.skipped)).toEqual(expect.arrayContaining(['looks like a credential file', 'symbolic link']));

    // What is inside the zip: no credential file, no dependency folder, no link.
    const zip = await JSZip.loadAsync(await fsp.readFile(out));
    const names = Object.keys(zip.files);
    expect(names).toContain('mish-pack.json');
    expect(names.some((name) => /\.env$|mcp-tokens|node_modules|\/link$/.test(name))).toBe(false);
    expect(names).toContain('skills/team-skill/SKILL.md');
    expect(names).toContain('skills/agency-demo/SKILL.md');
    expect(names).not.toContain('skills/not-included/SKILL.md');
    const overlay = JSON.parse(await zip.file('catalogs/genui/overlay.json')!.async('string')) as { entries: Array<{ id: string }> };
    expect(overlay.entries.map((entry) => entry.id)).toEqual(['pack-card']);
    const sections = JSON.parse(await zip.file('catalogs/sections.json')!.async('string')) as { entries: Array<{ id: string }> };
    expect(sections.entries.map((entry) => entry.id)).toEqual(['pack-only-section']);

    // Install it for real.
    const dataDir = tempDir('mish-data-');
    const store = createMishPackStore({ dataDir, userRoots: { skills: path.join(dataDir, 'skills'), designSystems: path.join(dataDir, 'ds') }, env: {} });
    await store.start();
    installFastLanePackOverlay();
    const { pack } = await store.install(out);
    expect(pack).toMatchObject({ id: 'built-pack', version: '9.9.9', mcpServerIds: ['refero'] });
    expect((cultInventoryData() as unknown as { rows: Array<{ name: string }> }).rows.map((row) => row.name)).toEqual(['pack-hero']);
    expect(resolveCultKitDir({}, null)).toBeTruthy();
    expect(sectionCatalogData().entries.some((entry) => entry.id === 'pack-only-section')).toBe(true);
    expect(existsSync(path.join(dataDir, 'ds', 'atlas-one', 'DESIGN.md'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'ds', 'study-one', 'DESIGN.md'))).toBe(true);
    expect(existsSync(path.join(dataDir, 'skills', 'team-skill', '.env'))).toBe(false);

    // The bundled adapter module is loaded by the fast lane.
    expect(await listSectionAdapterIds()).toContain('cult:pack-hero');
    expect((await resolveSectionAdapter('cult:pack-hero')).id).toBe('cult:pack-hero');
  });

  it('is reproducible', async () => {
    const dir = tempDir('mish-out-');
    expect(build([source, path.join(dir, 'a.zip'), '--map', mapFile]).status).toBe(0);
    expect(build([source, path.join(dir, 'b.zip'), '--map', mapFile]).status).toBe(0);
    const [a, b] = await Promise.all([fsp.readFile(path.join(dir, 'a.zip')), fsp.readFile(path.join(dir, 'b.zip'))]);
    expect(a.equals(b)).toBe(true);
  });

  it('dry run writes nothing', async () => {
    const out = path.join(tempDir('mish-out-'), 'packet.zip');
    const result = build([source, out, '--map', mapFile, '--dry-run']);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/Would pack/);
    expect(existsSync(out)).toBe(false);
  });

  it('never writes into the source checkout, over an existing file, or into this repository', async () => {
    expect(build([source, path.join(source, 'out.zip'), '--map', mapFile]).stderr).toMatch(/outside the source checkout/);
    expect(existsSync(path.join(source, 'out.zip'))).toBe(false);
    const existing = path.join(tempDir('mish-out-'), 'there.zip');
    await fsp.writeFile(existing, 'keep');
    expect(build([source, existing, '--map', mapFile]).stderr).toMatch(/already exists/);
    expect(await fsp.readFile(existing, 'utf8')).toBe('keep');
    expect(build([source, path.join(repoRoot, 'leak.zip'), '--map', mapFile]).stderr).toMatch(/outside this repository/);
    expect(existsSync(path.join(repoRoot, 'leak.zip'))).toBe(false);
  });

  it('refuses a map path that leaves the checkout, a missing required resource and an unknown type', async () => {
    const write = async (resources: unknown[]) => {
      const file = path.join(tempDir('mish-map-'), 'map.json');
      await fsp.writeFile(file, JSON.stringify({ schemaVersion: 1, resources }));
      return file;
    };
    const out = () => path.join(tempDir('mish-out-'), 'p.zip');
    const climbing = await write([{ provides: 'skills', type: 'dir', from: '../outside', to: 'skills' }]);
    expect(build([source, out(), '--map', climbing]).stderr).toMatch(/leaves the source checkout/);
    const required = await write([{ provides: 'catalogs.cultKit', type: 'dir', from: 'nope', to: 'kit', optional: false }]);
    expect(build([source, out(), '--map', required]).status).toBe(1);
    const unknown = await write([{ provides: 'skills', type: 'magic', to: 'skills' }]);
    expect(build([source, out(), '--map', unknown]).stderr).toMatch(/unknown resource type/);
  });

  it('leaves out files reached through a linked folder or resolving outside the checkout', async () => {
    const outside = tempDir('mish-outside-');
    writeFile(outside, 'skills/stolen/SKILL.md', 'outside');
    writeFile(outside, 'catalog.json', JSON.stringify({ entries: [{ id: 'outside-section' }] }));
    // A linked ancestor of a mapped folder, and a mapped parent that is itself a link.
    symlinkSync(path.join(outside, 'skills'), path.join(source, 'linked-skills'));
    await fsp.mkdir(path.join(source, 'nested'), { recursive: true });
    symlinkSync(outside, path.join(source, 'nested', 'mapped'));
    const file = path.join(tempDir('mish-map-'), 'map.json');
    await fsp.writeFile(file, JSON.stringify({
      schemaVersion: 1,
      resources: [
        { provides: 'skills', type: 'dir', from: 'linked-skills/stolen', to: 'skills' },
        { provides: 'studies', type: 'files', to: 'studies', files: [{ from: 'nested/mapped/skills/stolen/SKILL.md', to: 'SKILL.md' }] },
        { provides: 'catalogs.sections', type: 'catalog-delta', from: 'nested/mapped/catalog.json', againstPublic: 'packages/section-catalog/catalog.json', to: 'catalogs/sections.json' },
      ],
    }));
    const out = path.join(tempDir('mish-out-'), 'p.zip');
    const result = build([source, out, '--map', file, '--json']);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { skipped: Record<string, string[]> };
    expect(summary.skipped['reached through a symbolic link']).toEqual(expect.arrayContaining(['skills/SKILL.md', 'studies/SKILL.md', 'nested/mapped/catalog.json']));
    const names = Object.keys((await JSZip.loadAsync(await fsp.readFile(out))).files);
    expect(names).toEqual(['mish-pack.json']);
  });

  it('refuses to write a manifest the daemon would refuse', async () => {
    const file = path.join(tempDir('mish-map-'), 'map.json');
    await fsp.writeFile(file, JSON.stringify({
      schemaVersion: 1,
      resources: [],
      mcpServers: [{ id: 'bad', transport: 'http', url: 'https://x.example.test/mcp', headers: { Authorization: 'Bearer sk-abcdefghijklmnopqrstuvwxyz' } }],
    }));
    const out = path.join(tempDir('mish-out-'), 'p.zip');
    const result = build([source, out, '--map', file]);
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/would be refused/);
    expect(existsSync(out)).toBe(false);
  });

  it('prints usage', () => {
    expect(execFileSync(process.execPath, [script, '--help'], { encoding: 'utf8' })).toContain('Usage: node scripts/build-pack.mjs');
  });
});
