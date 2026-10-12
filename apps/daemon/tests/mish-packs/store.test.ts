// Mish packs: install (folder and .zip), list, remove, the overlay on existing loaders, the MCP
// merge and the environment allow-list. Fixtures are owned test data written into temp folders.

import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { cultInventoryData } from '../../src/cult-data.js';
import { cultPublicId } from '../../src/cult-public-ids.js';
import { resolveCultKitDir } from '../../src/cult-registry.js';
import { readMcpConfig, writeMcpConfig } from '../../src/mcp-config.js';
import { isMishPackError } from '../../src/mish-packs/errors.js';
import { readMcpConfigForSpawn, resolveMcpEnvRefs } from '../../src/mish-packs/mcp.js';
import {
  activeMishPacks,
  mishPackGeneration,
  overlayCultJson,
  packSectionEntries,
  resetMishPacksForTests,
} from '../../src/mish-packs/overlay.js';
import { createMishPackStore, type MishPackStore } from '../../src/mish-packs/store.js';
import { cultSlugs } from '../../src/routes/cult-registry.js';
import { sectionCatalogData } from '../../src/section-catalog-data.js';
import { cleanupDirs, tempDir, writeFile, writeFixturePack, zipFolder } from './pack-fixture.js';

let dataDir: string;
let skillsRoot: string;
let dsRoot: string;
let env: NodeJS.ProcessEnv;
let store: MishPackStore;

function makeStore(externalDir: string | null = null): MishPackStore {
  return createMishPackStore({ dataDir, externalDir, userRoots: { skills: skillsRoot, designSystems: dsRoot }, env });
}

async function expectPackError(promise: Promise<unknown>, code: string, pattern?: RegExp): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(isMishPackError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  if (pattern) expect((error as Error).message).toMatch(pattern);
}

beforeEach(async () => {
  dataDir = tempDir('mish-data-');
  skillsRoot = path.join(dataDir, 'skills');
  dsRoot = path.join(dataDir, 'design-systems');
  env = {};
  store = makeStore();
  await store.start();
});

afterEach(async () => {
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('with no pack installed', () => {
  it('changes nothing: bundled data comes back untouched', async () => {
    expect((await store.list()).packs).toEqual([]);
    const bundled = { schema: 'cult-ui-catalog/1', rows: [] };
    expect(overlayCultJson('catalog.json', bundled)).toBe(bundled);
    expect(packSectionEntries()).toEqual([]);
    expect(resolveCultKitDir({}, null)).toBeNull();
  });
});

describe('install and list', () => {
  it('installs a folder pack, lists it and overlays one catalogue', async () => {
    const source = tempDir('mish-src-');
    const { id, rowName } = writeFixturePack(source);

    const before = mishPackGeneration();
    const result = await store.install(source);
    expect(result.replaced).toBe(false);
    expect(result.pack).toMatchObject({ id, name: 'Team kit', version: '1.0.0', origin: 'installed' });
    expect(mishPackGeneration()).toBeGreaterThan(before);

    const listed = await store.list();
    expect(listed.packs.map((pack) => pack.id)).toEqual([id]);
    const summary = listed.packs[0]!;
    expect(summary.provides).toEqual(expect.arrayContaining([
      { resource: 'cultCatalog', items: null },
      { resource: 'sections', items: null },
      { resource: 'skills', items: 2 },
      { resource: 'designSystems', items: 1 },
      { resource: 'studies', items: 1 },
    ]));
    expect(summary.mcpServerIds).toEqual(['pack-http', 'pack-stdio']);
    expect(summary.requiredEnv).toEqual([{ name: 'PACK_TEST_TOKEN', set: false }]);
    expect(summary.envKeys).toEqual(['MISH_AMR_CONSOLE_URL']);

    // The catalogue loaders now see the pack's data.
    const rows = (cultInventoryData() as unknown as { rows: Array<{ id: string; name: string }> }).rows;
    expect(rows.map((row) => row.name)).toEqual([rowName]);
    expect(cultSlugs().get(`cult:${rowName}`)).toBe('hero-series-pack');
    expect(cultPublicId(`cult:${rowName}`)).toBe('cult:hero-series-pack');

    // Section entries are added; the bundled entries stay.
    const sections = sectionCatalogData().entries;
    expect(sections.some((entry) => entry.id === 'pack-section-1')).toBe(true);
    expect(sections.length).toBeGreaterThan(1);
  });

  it('copies skills, design systems and studies into the user roots', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Body A');
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(dsRoot, 'pack-ds', 'DESIGN.md'))).toBe(true);
    expect(existsSync(path.join(dsRoot, 'study-one', 'DESIGN.md'))).toBe(true);
  });

  it('leaves a folder the user already has alone and says so', async () => {
    writeFile(skillsRoot, 'pack-skill-a/SKILL.md', 'mine');
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const { pack } = await store.install(source);
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(pack.warnings.join(' ')).toMatch(/skills\/pack-skill-a already exists/);
    await store.remove('team-kit');
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toBe('mine');
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b'))).toBe(false);
  });

  it('installs a .zip, including one wrapped in a single top-level folder', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const zipDir = tempDir('mish-zip-');
    const plain = path.join(zipDir, 'plain.zip');
    await zipFolder(source, plain);
    expect((await store.install(plain)).pack.id).toBe('team-kit');
    await store.remove('team-kit');
    const wrapped = path.join(zipDir, 'wrapped.zip');
    await zipFolder(source, wrapped, 'My Packet');
    expect((await store.install(wrapped)).pack.id).toBe('team-kit');
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'))).toBe(true);
  });

  it('replaces a pack with the same id and reports it', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    writeFile(source, 'skills/pack-skill-b/SKILL.md', 'Body B2');
    const second = await store.install(source);
    expect(second.replaced).toBe(true);
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-b', 'SKILL.md'), 'utf8')).toBe('Body B2');
    expect((await store.list()).packs).toHaveLength(1);
  });

  it('serves a cult kit from the pack when CULT_KIT_DIR is not set', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { catalogs: { cultKit: 'kit' } } });
    writeFile(source, 'kit/manifest.json', '{"schemaVersion":1,"files":[]}');
    await store.install(source);
    const kit = resolveCultKitDir({}, null);
    expect(kit && existsSync(path.join(kit, 'manifest.json'))).toBe(true);
    // An explicit CULT_KIT_DIR still wins.
    expect(resolveCultKitDir({ CULT_KIT_DIR: '/tmp/elsewhere' }, null)).toBe('/tmp/elsewhere');
  });
});

describe('refusals', () => {
  it('rejects a missing source, a relative path and a wrong file type', async () => {
    await expectPackError(store.install(path.join(dataDir, 'nope')), 'SOURCE_NOT_FOUND');
    await expectPackError(store.install('relative/path'), 'SOURCE_NOT_FOUND', /absolute/);
    const file = path.join(tempDir(), 'pack.tar');
    await fsp.writeFile(file, 'x');
    await expectPackError(store.install(file), 'INVALID_ARCHIVE');
  });

  it('rejects a pack without a manifest or with a bad one', async () => {
    const empty = tempDir('mish-src-');
    writeFile(empty, 'readme.txt', 'hi');
    await expectPackError(store.install(empty), 'INVALID_MANIFEST', /mish-pack\.json/);
    const bad = tempDir('mish-src-');
    writeFile(bad, 'mish-pack.json', JSON.stringify({ schemaVersion: 1, id: 'x', name: 'x', version: '1', provides: { skills: '../up' } }));
    await expectPackError(store.install(bad), 'INVALID_MANIFEST', /provides\.skills/);
  });

  it('rejects a declared path that is not in the pack, or has the wrong type', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { skills: 'does-not-exist' } });
    await expectPackError(store.install(source), 'MISSING_RESOURCE', /skills/);
    const wrongType = tempDir('mish-src-');
    writeFixturePack(wrongType, { provides: { catalogs: { cultCatalog: 'skills/pack-skill-a/SKILL.md' } } });
    await expectPackError(store.install(wrongType), 'MISSING_RESOURCE', /folder/);
    const noCatalog = tempDir('mish-src-');
    writeFixturePack(noCatalog, { provides: { catalogs: { cultKit: 'skills' } } });
    await expectPackError(store.install(noCatalog), 'MISSING_RESOURCE', /manifest\.json/);
  });

  it('rejects a zip entry that climbs out of the folder, and installs nothing', async () => {
    const zip = new JSZip();
    zip.file('mish-pack.json', JSON.stringify({ schemaVersion: 1, id: 'evil', name: 'Evil', version: '1' }));
    zip.file('../escaped.txt', 'x');
    const file = path.join(tempDir('mish-zip-'), 'evil.zip');
    await fsp.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await expectPackError(store.install(file), 'UNSAFE_PATH');
    expect(existsSync(path.join(path.dirname(file), 'escaped.txt'))).toBe(false);
    expect((await store.list()).packs).toEqual([]);
  });

  it('rejects absolute and backslash zip entries', async () => {
    for (const name of ['/abs.txt', 'a\\b.txt', 'C:/x.txt']) {
      const zip = new JSZip();
      zip.file('mish-pack.json', JSON.stringify({ schemaVersion: 1, id: 'evil', name: 'Evil', version: '1' }));
      zip.file(name, 'x');
      const file = path.join(tempDir('mish-zip-'), 'evil.zip');
      await fsp.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
      await expectPackError(store.install(file), 'UNSAFE_PATH');
    }
  });

  it('rejects a symbolic link in a zip and in a folder', async () => {
    const zip = new JSZip();
    zip.file('mish-pack.json', JSON.stringify({ schemaVersion: 1, id: 'evil', name: 'Evil', version: '1' }));
    zip.file('link', '/etc/passwd', { unixPermissions: 0o120777 });
    const file = path.join(tempDir('mish-zip-'), 'evil.zip');
    await fsp.writeFile(file, await zip.generateAsync({ type: 'nodebuffer', platform: 'UNIX' }));
    await expectPackError(store.install(file), 'INVALID_ARCHIVE', /link/);

    const folder = tempDir('mish-src-');
    writeFixturePack(folder);
    symlinkSync('/etc/hosts', path.join(folder, 'skills', 'pack-skill-a', 'hosts'));
    await expectPackError(store.install(folder), 'INVALID_ARCHIVE', /link/);
  });

  it('rejects two entries that differ only by case', async () => {
    const zip = new JSZip();
    zip.file('mish-pack.json', JSON.stringify({ schemaVersion: 1, id: 'evil', name: 'Evil', version: '1' }));
    zip.file('A.txt', '1');
    zip.file('a.txt', '2');
    const file = path.join(tempDir('mish-zip-'), 'case.zip');
    await fsp.writeFile(file, await zip.generateAsync({ type: 'nodebuffer' }));
    await expectPackError(store.install(file), 'INVALID_ARCHIVE', /letter case/);
  });

  it('enforces the size limits while writing', async () => {
    const limited = createMishPackStore({
      dataDir, userRoots: { skills: skillsRoot, designSystems: dsRoot }, env,
      limits: { archiveMaxBytes: 1 << 20, extractedMaxBytes: 100, maxEntries: 50, fileMaxBytes: 60 },
    });
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await expectPackError(limited.install(source), 'TOO_LARGE');
    const few = createMishPackStore({
      dataDir, userRoots: { skills: skillsRoot, designSystems: dsRoot }, env,
      limits: { archiveMaxBytes: 1 << 20, extractedMaxBytes: 1 << 20, maxEntries: 3, fileMaxBytes: 1 << 20 },
    });
    await expectPackError(few.install(source), 'TOO_LARGE', /too many/);
    const zipFile = path.join(tempDir('mish-zip-'), 'p.zip');
    await zipFolder(source, zipFile);
    const tiny = createMishPackStore({
      dataDir, userRoots: { skills: skillsRoot, designSystems: dsRoot }, env,
      limits: { archiveMaxBytes: 10, extractedMaxBytes: 1 << 20, maxEntries: 100, fileMaxBytes: 1 << 20 },
    });
    await expectPackError(tiny.install(zipFile), 'TOO_LARGE', /archive/);
    expect((await store.list()).packs).toEqual([]);
  });

  it('keeps one install at a time', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const first = store.install(source);
    await expectPackError(store.install(source), 'BUSY');
    await first;
  });
});

describe('remove', () => {
  it('reverses everything the install did and nothing else', async () => {
    writeFile(dsRoot, 'mine/DESIGN.md', 'keep me');
    await writeMcpConfig(dataDir, { servers: [{ id: 'mine', transport: 'http', url: 'https://mine.example.test/mcp' }] });
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    expect(existsSync(path.join(dsRoot, 'pack-ds'))).toBe(true);
    expect((await readMcpConfig(dataDir)).servers.map((server) => server.id)).toEqual(['mine', 'pack-http', 'pack-stdio']);

    expect(await store.remove('team-kit')).toEqual({ removed: 'team-kit' });
    expect(existsSync(path.join(dsRoot, 'pack-ds'))).toBe(false);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
    expect(existsSync(path.join(dsRoot, 'mine', 'DESIGN.md'))).toBe(true);
    expect((await readMcpConfig(dataDir)).servers.map((server) => server.id)).toEqual(['mine']);
    expect(existsSync(path.join(dataDir, 'mish-packs', 'team-kit'))).toBe(false);
    expect(activeMishPacks()).toEqual([]);
    expect(overlayCultJson('catalog.json', 'bundled')).toBe('bundled');
    expect(packSectionEntries()).toEqual([]);
  });

  it('refuses an unknown id and an id that is not a pack id', async () => {
    await expectPackError(store.remove('missing'), 'NOT_FOUND');
    await expectPackError(store.remove('../etc'), 'NOT_FOUND');
  });
});

describe('MCP merge', () => {
  it('adds servers whose ids are free and leaves the user entry when an id clashes', async () => {
    await writeMcpConfig(dataDir, { servers: [{ id: 'pack-http', transport: 'http', url: 'https://mine.example.test/mcp', authMode: 'none' }] });
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const { pack } = await store.install(source);
    const servers = (await readMcpConfig(dataDir)).servers;
    expect(servers.find((server) => server.id === 'pack-http')?.url).toBe('https://mine.example.test/mcp');
    expect(servers.find((server) => server.id === 'pack-stdio')).toMatchObject({ transport: 'stdio', command: 'node', args: ['server.mjs'] });
    expect(pack.warnings.join(' ')).toMatch(/MCP server pack-http already exists/);
    await store.remove('team-kit');
    const after = (await readMcpConfig(dataDir)).servers;
    expect(after.map((server) => server.id)).toEqual(['pack-http']);
  });

  it('keeps an entry the user edited after install', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    const config = await readMcpConfig(dataDir);
    await writeMcpConfig(dataDir, { servers: config.servers.map((server) => (server.id === 'pack-stdio' ? { ...server, args: ['custom.mjs'] } : server)) });
    await store.remove('team-kit');
    expect((await readMcpConfig(dataDir)).servers.map((server) => server.id)).toEqual(['pack-stdio']);
  });

  it('stores the placeholder, never the credential, and resolves it only at spawn time', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    const saved = await fsp.readFile(path.join(dataDir, 'mcp-config.json'), 'utf8');
    expect(saved).toContain('${PACK_TEST_TOKEN}');

    const unset = await readMcpConfigForSpawn(dataDir, {});
    expect(unset.servers.find((server) => server.id === 'pack-stdio')?.env).toEqual({ TOKEN: '${PACK_TEST_TOKEN}' });
    const set = await readMcpConfigForSpawn(dataDir, { PACK_TEST_TOKEN: 'abc-123' });
    expect(set.servers.find((server) => server.id === 'pack-stdio')?.env).toEqual({ TOKEN: 'abc-123' });
    // The saved file is untouched by a spawn-time read.
    expect(await fsp.readFile(path.join(dataDir, 'mcp-config.json'), 'utf8')).toBe(saved);
    expect(resolveMcpEnvRefs({ servers: [] }, {}).missing).toEqual([]);
    expect(resolveMcpEnvRefs(set, {}).missing).toEqual([]);
    expect(resolveMcpEnvRefs(unset, {}).missing).toEqual(['PACK_TEST_TOKEN']);
  });

  it('reports which required variables the user has set', async () => {
    env.PACK_TEST_TOKEN = 'present';
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const { pack } = await store.install(source);
    expect(pack.requiredEnv).toEqual([{ name: 'PACK_TEST_TOKEN', set: true }]);
  });
});

describe('environment', () => {
  it('applies allow-listed keys, never replaces a value the user set, and reverts on remove', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    expect(env.MISH_AMR_CONSOLE_URL).toBe('https://console.example.test');
    await store.remove('team-kit');
    expect(env.MISH_AMR_CONSOLE_URL).toBeUndefined();

    env.MISH_AMR_CONSOLE_URL = 'https://mine.example.test';
    await store.install(source);
    expect(env.MISH_AMR_CONSOLE_URL).toBe('https://mine.example.test');
    await store.remove('team-kit');
    expect(env.MISH_AMR_CONSOLE_URL).toBe('https://mine.example.test');
  });

  it('maps a pack key to the variable the daemon reads', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { env: { MISH_VELA_WEB_URL: 'https://web.example.test' } } });
    await store.install(source);
    expect(env.OD_VELA_WEB_URL).toBe('https://web.example.test');
    expect(env.MISH_VELA_WEB_URL).toBeUndefined();
  });
});

describe('MISH_PACKS_DIR', () => {
  it('reads packs from a read-only folder, applies them at start, and refuses to remove them', async () => {
    const external = tempDir('mish-external-');
    writeFixturePack(path.join(external, 'team-kit'));
    resetMishPacksForTests();
    const withExternal = makeStore(external);
    await withExternal.start();
    const listed = await withExternal.list();
    expect(listed.packs).toHaveLength(1);
    expect(listed.packs[0]).toMatchObject({ id: 'team-kit', origin: 'external' });
    expect(listed.externalDir).toBe(external);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'))).toBe(true);
    expect((await readMcpConfig(dataDir)).servers.map((server) => server.id)).toContain('pack-stdio');
    expect(cultSlugs().get('cult:pack-hero')).toBe('hero-series-pack');
    await expectPackError(withExternal.remove('team-kit'), 'READ_ONLY');
  });

  it('accepts the variable naming one pack folder directly', async () => {
    const external = tempDir('mish-external-');
    writeFixturePack(external);
    resetMishPacksForTests();
    const withExternal = makeStore(external);
    await withExternal.start();
    expect((await withExternal.list()).packs.map((pack) => pack.id)).toEqual(['team-kit']);
  });

  it('ignores a pack whose folder name differs from its id', async () => {
    const external = tempDir('mish-external-');
    writeFixturePack(path.join(external, 'other-name'));
    resetMishPacksForTests();
    const withExternal = makeStore(external);
    await withExternal.start();
    expect((await withExternal.list()).packs).toEqual([]);
  });
});

describe('start', () => {
  it('picks installed packs up again after a restart without duplicating anything', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect((await restarted.list()).packs.map((pack) => pack.id)).toEqual(['team-kit']);
    expect((await readMcpConfig(dataDir)).servers.map((server) => server.id)).toEqual(['pack-http', 'pack-stdio']);
    expect(overlayCultJson('catalog.json', null)).not.toBeNull();
  });

  it('does not copy the folders again on a restart, and keeps a change made to a copy', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    await fsp.writeFile(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'edited by the user');
    resetMishPacksForTests();
    await makeStore().start();
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toBe('edited by the user');
  });

  it('copies a new version over the old copies', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    await store.install(source);
    writeFile(source, 'skills/pack-skill-a/SKILL.md', 'version two');
    writeFile(source, 'mish-pack.json', readFileSync(path.join(source, 'mish-pack.json'), 'utf8').replace('"version": "1.0.0"', '"version": "2.0.0"'));
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Body A');
    await store.install(source);
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toBe('version two');
  });

  it('reports an MCP settings file it cannot update instead of failing the install', async () => {
    await fsp.mkdir(path.join(dataDir, 'mcp-config.json'));
    const source = tempDir('mish-src-');
    writeFixturePack(source);
    const { pack } = await store.install(source);
    expect(pack.warnings.join(' ')).toMatch(/MCP servers were not added/);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'))).toBe(true);
  });
});
