// Mish packs: saved projects (imported once under their own ids, never over a project the person
// has, never deleted by the pack) and the two-phase install (nothing current is touched before the
// commit; after it the install only moves forward, also across a crash). Fixtures are owned test
// data written into temp folders. Failures and crashes are injected at the store's install steps.

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MishPackManifest } from '@mish/contracts';

import { closeDatabase, getProject, insertConversation, insertProject, openDatabase } from '../../src/db.js';
import { readMcpConfig } from '../../src/mcp-config.js';
import { isMishPackError } from '../../src/mish-packs/errors.js';
import { packServerToConfig } from '../../src/mish-packs/mcp.js';
import { resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore, type MishPackInstallStep, type MishPackStore, type MishPackStoreOptions } from '../../src/mish-packs/store.js';
import { cleanupDirs, tempDir, writeFile, writeFixturePack } from './pack-fixture.js';

type Db = ReturnType<typeof openDatabase>;

let dataDir: string;
let skillsRoot: string;
let dsRoot: string;
let projectsDir: string;
let db: Db;

function makeStore(extra: Partial<MishPackStoreOptions> = {}): MishPackStore {
  return createMishPackStore({
    dataDir,
    userRoots: { skills: skillsRoot, designSystems: dsRoot },
    projectsDir,
    db: () => db,
    env: {},
    ...extra,
  });
}

/** Fails (throw) or stops for good (a promise that never settles, as if the process died) at one install step. */
function at(target: MishPackInstallStep, action: 'fail' | 'crash', reached?: () => void): NonNullable<MishPackStoreOptions['onInstallStep']> {
  return (step) => {
    if (step !== target) return;
    reached?.();
    if (action === 'fail') throw new Error(`injected failure at ${step}`);
    return new Promise<void>(() => undefined);
  };
}

/** The fixture pack plus a `projects` folder: two projects with files, one empty, one pointing outside. */
function writeProjectsPack(root: string, options: { extraProjects?: boolean } = {}): void {
  writeFixturePack(root, { provides: { projects: 'projects' } });
  const rows: Array<Record<string, unknown>> = [
    { id: 'ds-pack-ds', name: 'Pack design system', designSystemId: 'user:pack-ds', metadata: { kind: 'other', importedFrom: 'design-system', entryFile: 'DESIGN.md' }, createdAt: 1000, updatedAt: 2000 },
    { id: 'proj-one', name: 'Project one', metadata: { kind: 'prototype', linkedDirs: ['/somewhere/else'] }, customInstructions: 'Be brief.', createdAt: 1000, updatedAt: 3000 },
    { id: 'proj-empty', name: 'Empty project', metadata: null, createdAt: 1000, updatedAt: 1000 },
    { id: 'proj-outside', name: 'Imported folder', metadata: { kind: 'prototype', baseDir: '/somewhere/outside' }, createdAt: 1000, updatedAt: 1000 },
  ];
  if (options.extraProjects) rows.push({ id: 'proj-two', name: 'Project two', createdAt: 1000, updatedAt: 1000 });
  writeFile(root, 'projects/projects.json', JSON.stringify({ schema: 'mish-pack-projects/1', projects: rows }));
  writeFile(root, 'projects/ds-pack-ds/DESIGN.md', '# Pack design system preview\n');
  writeFile(root, 'projects/ds-pack-ds/assets/logo.svg', '<svg/>');
  writeFile(root, 'projects/proj-one/index.html', '<h1>One</h1>');
  writeFile(root, 'projects/proj-outside/index.html', '<h1>Outside</h1>');
  if (options.extraProjects) writeFile(root, 'projects/proj-two/index.html', '<h1>Two</h1>');
}

/** Version 2 of the fixture: other skill text, one more skill, one more project, another MCP url, one more MCP server. */
function writeVersionTwo(source: string): void {
  writeProjectsPack(source, { extraProjects: true });
  const file = path.join(source, 'mish-pack.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8').replace('https://mcp.example.test/mcp', 'https://mcp-v2.example.test/mcp')) as {
    version: string; provides: { mcpServers: Array<Record<string, unknown>> };
  };
  manifest.version = '2.0.0';
  manifest.provides.mcpServers.push({ id: 'pack-new', transport: 'http', url: 'https://new.example.test/mcp', authMode: 'oauth' });
  writeFile(source, 'mish-pack.json', JSON.stringify(manifest, null, 2));
  writeFile(source, 'skills/pack-skill-a/SKILL.md', '---\nname: pack-skill-a\ndescription: v2\n---\nVersion two\n');
  writeFile(source, 'skills/pack-skill-c/SKILL.md', '---\nname: pack-skill-c\ndescription: v2\n---\nNew in two\n');
}

/** Version 3: version 2 plus a skill only version 3 has. */
function writeVersionThree(source: string): void {
  writeVersionTwo(source);
  const file = path.join(source, 'mish-pack.json');
  writeFile(source, 'mish-pack.json', readFileSync(file, 'utf8').replace('"version": "2.0.0"', '"version": "3.0.0"'));
  writeFile(source, 'skills/pack-skill-d/SKILL.md', '---\nname: pack-skill-d\ndescription: v3\n---\nOnly in three\n');
}

function serverIds(): Promise<string[]> {
  return readMcpConfig(dataDir).then((config) => config.servers.map((server) => server.id).sort());
}

function receiptOf(id = 'team-kit'): { version: string; seededMcp: Array<{ id: string }>; mcpApplied?: boolean; copied: { skills: string[] } } {
  return JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', '.receipts', `${id}.json`), 'utf8'));
}

async function expectPackError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(isMishPackError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

/** What makes a version of the fixture active, read back from disk and the database. */
async function activeState() {
  const receipt = JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', '.receipts', 'team-kit.json'), 'utf8')) as { version: string };
  return {
    receipt: receipt.version,
    tree: (JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', 'team-kit', 'mish-pack.json'), 'utf8')) as { version: string }).version,
    skillA: readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8'),
    skillB: readFileSync(path.join(skillsRoot, 'pack-skill-b', 'SKILL.md'), 'utf8'),
    skillC: existsSync(path.join(skillsRoot, 'pack-skill-c')),
    designSystem: readFileSync(path.join(dsRoot, 'pack-ds', 'DESIGN.md'), 'utf8'),
    projects: ['ds-pack-ds', 'proj-one', 'proj-empty', 'proj-two'].map((id) => getProject(db, id)?.name ?? null),
    servers: (await readMcpConfig(dataDir)).servers.map((server) => JSON.stringify(server)).sort(),
  };
}

/** Work folders an install leaves behind; empty once every install has settled. */
function leftovers(): string[] {
  const out: string[] = [];
  for (const dir of ['.journal', '.incoming', '.previous', '.staging']) {
    const abs = path.join(dataDir, 'mish-packs', dir);
    if (existsSync(abs) && readdirSync(abs).length > 0) out.push(dir);
  }
  for (const userRoot of [skillsRoot, dsRoot]) {
    for (const dir of ['.mish-pack-staging', '.mish-pack-retiring']) if (existsSync(path.join(userRoot, dir))) out.push(`${path.basename(userRoot)}/${dir}`);
  }
  return out;
}

beforeEach(async () => {
  dataDir = tempDir('mish-data-');
  skillsRoot = path.join(dataDir, 'skills');
  dsRoot = path.join(dataDir, 'design-systems');
  projectsDir = path.join(dataDir, 'projects');
  db = openDatabase(dataDir, { dataDir });
  await makeStore().start();
});

afterEach(async () => {
  closeDatabase();
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('saved projects', () => {
  it('imports each project under its own id, with its row', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const { pack } = await makeStore().install(source);

    expect(getProject(db, 'ds-pack-ds')).toMatchObject({ id: 'ds-pack-ds', name: 'Pack design system', designSystemId: 'user:pack-ds', createdAt: 1000, updatedAt: 2000 });
    expect(readFileSync(path.join(projectsDir, 'ds-pack-ds', 'DESIGN.md'), 'utf8')).toContain('preview');
    expect(existsSync(path.join(projectsDir, 'ds-pack-ds', 'assets', 'logo.svg'))).toBe(true);
    // Links to folders on another computer are dropped; the rest of the row travels.
    expect(getProject(db, 'proj-one')).toMatchObject({ metadata: { kind: 'prototype' }, customInstructions: 'Be brief.' });
    expect(getProject(db, 'proj-one')!.metadata).not.toHaveProperty('linkedDirs');
    // A row without a folder is a project with no files.
    expect(getProject(db, 'proj-empty')).toMatchObject({ name: 'Empty project' });
    expect(readdirSync(path.join(projectsDir, 'proj-empty'))).toEqual([]);
    // A project whose files live outside the pack is not added.
    expect(getProject(db, 'proj-outside')).toBeNull();
    expect(existsSync(path.join(projectsDir, 'proj-outside'))).toBe(false);
    expect(pack.warnings.join(' ')).toMatch(/projects\/proj-outside was not added because its files live in a folder outside the pack/);
    expect(pack.warnings.join(' ')).toMatch(/linked folders on another computer/);
    expect(pack.provides).toEqual(expect.arrayContaining([{ resource: 'projects', items: 4 }]));
  });

  it('never replaces a project the person already has', async () => {
    const now = Date.now();
    insertProject(db, { id: 'proj-one', name: 'Mine', metadata: { kind: 'prototype' }, createdAt: now, updatedAt: now });
    writeFile(projectsDir, 'proj-one/mine.txt', 'mine');
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore();
    const { pack } = await store.install(source);
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Mine' });
    expect(readdirSync(path.join(projectsDir, 'proj-one'))).toEqual(['mine.txt']);
    expect(pack.warnings.join(' ')).toMatch(/1 saved project\(s\) already exist and were left as they are: proj-one/);

    // The person's own project is not one the pack imported, so remove does not list it.
    const removed = await store.remove('team-kit');
    expect(removed.keptProjects?.sort()).toEqual(['ds-pack-ds', 'proj-empty']);
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Mine' });
  });

  it('keeps every imported project on remove, with its files, row, edits and conversations', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore();
    await store.install(source);
    await fsp.writeFile(path.join(projectsDir, 'ds-pack-ds', 'DESIGN.md'), 'edited by the user');
    insertConversation(db, { id: 'conv-1', projectId: 'proj-one', title: 'Hello', createdAt: 1, updatedAt: 1 });

    const result = await store.remove('team-kit');
    expect(result.keptProjects?.sort()).toEqual(['ds-pack-ds', 'proj-empty', 'proj-one']);
    expect(readFileSync(path.join(projectsDir, 'ds-pack-ds', 'DESIGN.md'), 'utf8')).toBe('edited by the user');
    expect(getProject(db, 'proj-one')).not.toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE project_id = ?').get('proj-one')).toEqual({ n: 1 });
    expect(getProject(db, 'proj-empty')).not.toBeNull();
    // The other things the pack added are gone.
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
  });

  it('a new version imports only new projects and leaves the ones already imported as they are', async () => {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    const store = makeStore();
    await store.install(v1);
    await fsp.writeFile(path.join(projectsDir, 'proj-one', 'index.html'), 'edited');
    // A project the person deleted after the import does not come back.
    await fsp.rm(path.join(projectsDir, 'proj-empty'), { recursive: true });
    db.prepare('DELETE FROM projects WHERE id = ?').run('proj-empty');

    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    const second = await store.install(v2);
    expect(second.pack.version).toBe('2.0.0');
    expect(readFileSync(path.join(projectsDir, 'proj-one', 'index.html'), 'utf8')).toBe('edited');
    expect(getProject(db, 'proj-two')).toMatchObject({ name: 'Project two' });
    expect(getProject(db, 'proj-empty')).toBeNull();
    expect(second.pack.warnings.join(' ')).not.toMatch(/already exist/);
  });

  it('refuses a pack whose projects.json is invalid, and installs nothing', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    writeFile(source, 'projects/projects.json', JSON.stringify({ schema: 'mish-pack-projects/1', projects: [{ id: '../up', name: 'x', createdAt: 1, updatedAt: 1 }] }));
    await expectPackError(makeStore().install(source), 'INVALID_MANIFEST');
    expect((await makeStore().list()).packs).toEqual([]);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
  });
});

describe('replacing a pack', () => {
  async function installVersionOne(): Promise<Awaited<ReturnType<typeof activeState>>> {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await makeStore().install(v1);
    const state = await activeState();
    expect(state).toMatchObject({ receipt: '1.0.0', tree: '1.0.0', skillC: false });
    return state;
  }

  function expectVersionTwo(state: Awaited<ReturnType<typeof activeState>>): void {
    expect(state).toMatchObject({ receipt: '2.0.0', tree: '2.0.0', skillC: true });
    expect(state.skillA).toContain('Version two');
    expect(state.projects).toEqual(['Pack design system', 'Project one', 'Empty project', 'Project two']);
    expect(state.servers.join(' ')).toContain('mcp-v2.example.test');
    expect(state.servers.join(' ')).toContain('pack-new');
    expect(state.servers.join(' ')).not.toContain('https://mcp.example.test');
  }

  it('leaves the installed version fully intact when the new one fails before the commit', async () => {
    const before = await installVersionOne();
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await expect(makeStore({ onInstallStep: at('staged', 'fail') }).install(v2)).rejects.toThrow('injected failure at staged');
    expect(await activeState()).toEqual(before);
    expect(leftovers()).toEqual([]);
    expect((await makeStore().list()).packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(['team-kit@1.0.0']);
  });

  it('installs over an unreadable MCP settings file, keeps the journal, and finishes MCP once the file is readable', async () => {
    await installVersionOne();
    await fsp.rm(path.join(dataDir, 'mcp-config.json'), { force: true });
    await fsp.mkdir(path.join(dataDir, 'mcp-config.json'));
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    const store = makeStore();
    const { pack } = await store.install(v2);
    expect(pack.version).toBe('2.0.0');
    expect(pack.warnings.join(' ')).toMatch(/MCP settings file could not be updated; the earlier ones were kept/);
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Version two');
    expect(receiptOf().mcpApplied).toBeFalsy();
    expect(leftovers()).toContain('.journal');

    await fsp.rmdir(path.join(dataDir, 'mcp-config.json'));
    resetMishPacksForTests();
    await makeStore().start();
    expectVersionTwo(await activeState());
    expect(leftovers()).toEqual([]);
  });

  it('discards an install that stopped before the commit, on the next start', async () => {
    const before = await installVersionOne();
    let reached!: () => void;
    const stopped = new Promise<void>((resolve) => { reached = resolve; });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    void makeStore({ onInstallStep: at('staged', 'crash', reached) }).install(v2);
    await stopped;
    expect(existsSync(path.join(skillsRoot, '.mish-pack-staging'))).toBe(true);

    resetMishPacksForTests();
    await makeStore().start();
    expect(await activeState()).toEqual(before);
    expect(leftovers()).toEqual([]);
  });

  for (const point of ['committed', 'swapped'] as const) {
    it(`finishes an install that stopped after the commit (at ${point}) on the next start`, async () => {
      await installVersionOne();
      let reached!: () => void;
      const stopped = new Promise<void>((resolve) => { reached = resolve; });
      const v2 = tempDir('mish-src-');
      writeVersionTwo(v2);
      void makeStore({ onInstallStep: at(point, 'crash', reached) }).install(v2);
      await stopped;

      resetMishPacksForTests();
      const restarted = makeStore();
      await restarted.start();
      expectVersionTwo(await activeState());
      expect(leftovers()).toEqual([]);
      expect((await restarted.list()).packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(['team-kit@2.0.0']);
    });
  }

  it('finishes an install whose process died half way through swapping the trees', async () => {
    await installVersionOne();
    let reached!: () => void;
    const stopped = new Promise<void>((resolve) => { reached = resolve; });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    void makeStore({ onInstallStep: at('committed', 'crash', reached) }).install(v2);
    await stopped;
    // The first half of the swap: the old tree moved aside, the new one not yet in place.
    const journalDir = path.join(dataDir, 'mish-packs', '.journal');
    const [journalName] = readdirSync(journalDir);
    const journal = JSON.parse(readFileSync(path.join(journalDir, journalName!), 'utf8')) as { previousTree: string };
    await fsp.mkdir(path.dirname(journal.previousTree), { recursive: true });
    renameSync(path.join(dataDir, 'mish-packs', 'team-kit'), journal.previousTree);

    resetMishPacksForTests();
    await makeStore().start();
    expectVersionTwo(await activeState());
    expect(leftovers()).toEqual([]);
  });

  it('keeps the new version when cleanup fails after the commit, and cleans up on the next start', async () => {
    await installVersionOne();
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    const { pack } = await makeStore({ onInstallStep: at('cleanup', 'fail') }).install(v2);
    expect(pack.version).toBe('2.0.0');
    expect(pack.warnings.join(' ')).toMatch(/earlier version could not be deleted yet/);
    expectVersionTwo(await activeState());
    expect(leftovers()).toEqual(expect.arrayContaining(['.journal', '.previous']));

    resetMishPacksForTests();
    await makeStore().start();
    expectVersionTwo(await activeState());
    expect(leftovers()).toEqual([]);
  });

  it('reports an install that failed after the commit, and finishes it on the next start', async () => {
    await installVersionOne();
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await expectPackError(makeStore({ onInstallStep: at('swapped', 'fail') }).install(v2), 'INTERNAL_ERROR');
    // Committed: the new tree is in place and nothing was rolled back.
    expect((JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', 'team-kit', 'mish-pack.json'), 'utf8')) as { version: string }).version).toBe('2.0.0');

    resetMishPacksForTests();
    await makeStore().start();
    expectVersionTwo(await activeState());
    expect(leftovers()).toEqual([]);
  });

  it('puts the earlier MCP servers back when writing the new ones fails, and retries at the next start', async () => {
    const before = await installVersionOne();
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    const store = makeStore({ onInstallStep: at('mcp-unseeded', 'fail') });
    const { pack } = await store.install(v2);
    expect(pack.version).toBe('2.0.0');
    expect(pack.warnings.join(' ')).toMatch(/MCP servers were not added/);
    // The earlier version's servers are back, exactly; nothing of version 2 is there yet.
    expect((await activeState()).servers).toEqual(before.servers);
    expect(receiptOf().mcpApplied).toBeFalsy();
    expect(leftovers()).toContain('.journal');

    resetMishPacksForTests();
    await makeStore().start();
    expectVersionTwo(await activeState());
    expect(receiptOf().seededMcp.map((entry) => entry.id).sort()).toEqual(['pack-http', 'pack-new', 'pack-stdio']);
    expect(leftovers()).toEqual([]);
  });

  it('owns MCP servers an interrupted install wrote but did not record, so removal takes them away', async () => {
    await installVersionOne();
    let reached!: () => void;
    const stopped = new Promise<void>((resolve) => { reached = resolve; });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    void makeStore({ onInstallStep: at('mcp-written', 'crash', reached) }).install(v2);
    await stopped;
    expect(await serverIds()).toContain('pack-new');
    expect(receiptOf().seededMcp.map((entry) => entry.id)).not.toContain('pack-new');

    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect(receiptOf().seededMcp.map((entry) => entry.id).sort()).toEqual(['pack-http', 'pack-new', 'pack-stdio']);
    await restarted.remove('team-kit');
    expect(await serverIds()).toEqual([]);
  });

  it('settles an earlier install that only has cleanup left, so a new install is never blocked or replayed', async () => {
    await installVersionOne();
    const failingCleanup = makeStore({ onInstallStep: at('cleanup', 'fail') });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await failingCleanup.install(v2);
    expect(readdirSync(path.join(dataDir, 'mish-packs', '.journal'))).toHaveLength(1);
    const v3 = tempDir('mish-src-');
    writeVersionThree(v3);
    // Version 2's cleanup is finished first, then version 3 goes in.
    expect((await makeStore().install(v3)).pack.version).toBe('3.0.0');
    expect(leftovers()).toEqual([]);
    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect(receiptOf()).toMatchObject({ version: '3.0.0' });
    expect(receiptOf().copied.skills).toContain('pack-skill-d');
    await restarted.remove('team-kit');
    expect(existsSync(path.join(skillsRoot, 'pack-skill-d'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('leaves nothing behind when a first install fails before the commit', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await expect(makeStore({ onInstallStep: at('staged', 'fail') }).install(source)).rejects.toThrow('injected failure');
    expect((await makeStore().list()).packs).toEqual([]);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
    expect(getProject(db, 'ds-pack-ds')).toBeNull();
    expect((await readMcpConfig(dataDir)).servers).toEqual([]);
    expect(leftovers()).toEqual([]);
  });
});

describe('retiring a copy', () => {
  it('moves the copy aside before comparing it, so an edit saved meanwhile is kept', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    const store = makeStore({
      now: () => new Date('2026-10-12T10:00:00.000Z'),
      onRetireHeld: async (held, original) => {
        if (path.basename(original) !== 'pack-skill-a') return;
        // An editor with the file open saves into the moved folder...
        await fsp.writeFile(path.join(held, 'SKILL.md'), 'late edit');
        // ...and another save by path recreates the old place.
        writeFile(original, 'NEW.md', 'saved by path after the move');
      },
    });
    const result = await store.remove('team-kit');
    const backup = path.join(skillsRoot, '.mish-pack-backups', 'team-kit-2026-10-12T10-00-00-000Z', 'pack-skill-a');
    expect(result.backups).toEqual([{ resource: 'skills', name: 'pack-skill-a', path: backup }]);
    expect(readFileSync(path.join(backup, 'SKILL.md'), 'utf8')).toBe('late edit');
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'NEW.md'), 'utf8')).toBe('saved by path after the move');
    // The untouched copy is deleted, and nothing is left in the holding folder.
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b'))).toBe(false);
    expect(existsSync(path.join(skillsRoot, '.mish-pack-retiring'))).toBe(false);
  });
});

describe('start', () => {
  it('leaves work folders it cannot match to an install in place, and says so', async () => {
    const packs = path.join(dataDir, 'mish-packs');
    // An interrupted install from an earlier build, and leftovers no journal names.
    writeFile(packs, '.previous/old-token/mish-pack.json', '{"id":"team-kit"}');
    writeFile(packs, '.previous/old-token.json', '{"token":"old-token"}');
    writeFile(packs, '.incoming/stray/mish-pack.json', '{}');
    writeFile(skillsRoot, '.mish-pack-staging/stray/pack-skill-a/SKILL.md', 'staged');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resetMishPacksForTests();
      await makeStore().start();
      for (const file of [
        path.join(packs, '.previous', 'old-token', 'mish-pack.json'),
        path.join(packs, '.previous', 'old-token.json'),
        path.join(packs, '.incoming', 'stray', 'mish-pack.json'),
        path.join(skillsRoot, '.mish-pack-staging', 'stray', 'pack-skill-a', 'SKILL.md'),
      ]) expect(existsSync(file), file).toBe(true);
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toMatch(/left in place, not matched to an install/);
      expect(logged).toContain(path.join(packs, '.previous', 'old-token'));
    } finally {
      warn.mockRestore();
    }
  });
});

/** Replaces `mcp-config.json` with a link, the shape the MCP code refuses to read or replace. */
async function linkMcpConfig(): Promise<{ target: string; text: string }> {
  const target = path.join(tempDir('mish-elsewhere-'), 'mcp.json');
  const text = JSON.stringify({ servers: [{ id: 'mine', transport: 'http', url: 'https://mine.example.test/mcp', authMode: 'none' }] });
  await fsp.writeFile(target, text, { mode: 0o600 });
  await fsp.symlink(target, path.join(dataDir, 'mcp-config.json'));
  return { target, text };
}

describe('audit round 1', () => {
  it('never replaces an unsafe MCP settings file, and does not block the pack', async () => {
    const { target, text } = await linkMcpConfig();
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore();
    const { pack } = await store.install(source);
    expect(pack.warnings.join(' ')).toMatch(/MCP servers were not added/);
    expect(readFileSync(target, 'utf8')).toBe(text);
    expect((await fsp.lstat(path.join(dataDir, 'mcp-config.json'))).isSymbolicLink()).toBe(true);
    // The install is not settled, yet removal is not blocked by it.
    await store.remove('team-kit');
    expect((await store.list()).packs).toEqual([]);
    expect(readFileSync(target, 'utf8')).toBe(text);
    expect(leftovers()).toEqual([]);
  });

  it('finishes a removal that stopped after the tree left, without bringing projects back', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    db.prepare('DELETE FROM projects WHERE id = ?').run('proj-one');
    const dying = makeStore({
      now: () => new Date('2026-10-12T10:00:00.000Z'),
      onRetireHeld: (_held, original) => {
        if (path.basename(original) === 'pack-skill-a') throw new Error('process died');
      },
    });
    await expect(dying.remove('team-kit')).rejects.toThrow('process died');
    expect(existsSync(path.join(dataDir, 'mish-packs', 'team-kit'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'mish-packs', '.receipts', 'team-kit.json'))).toBe(true);

    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect((await restarted.list()).packs).toEqual([]);
    expect(existsSync(path.join(dataDir, 'mish-packs', '.receipts', 'team-kit.json'))).toBe(false);
    expect(existsSync(path.join(dataDir, 'mish-packs', '.trash'))).toBe(false);
    expect(await serverIds()).toEqual([]);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b'))).toBe(false);
    // The copy that was set aside is kept, not lost.
    const kept = path.join(skillsRoot, '.mish-pack-backups', 'team-kit-2026-10-12T10-00-00-000Z', 'pack-skill-a', 'SKILL.md');
    expect(existsSync(kept)).toBe(true);
    expect(existsSync(path.join(skillsRoot, '.mish-pack-retiring'))).toBe(false);
    // The deleted project did not come back; the others stay.
    expect(getProject(db, 'proj-one')).toBeNull();
    expect(getProject(db, 'proj-empty')).not.toBeNull();
  });

  it('keeps a copy an interrupted update set aside, and names it in the pack warnings', async () => {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await makeStore().install(v1);
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    const dying = makeStore({
      now: () => new Date('2026-10-12T10:00:00.000Z'),
      onRetireHeld: (_held, original) => {
        if (path.basename(original) === 'pack-skill-a') throw new Error('process died');
      },
    });
    await expect(dying.install(v2)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    const kept = path.join(skillsRoot, '.mish-pack-backups', 'team-kit-2026-10-12T10-00-00-000Z', 'pack-skill-a');
    expect(existsSync(path.join(kept, 'SKILL.md'))).toBe(true);
    expect(receiptOf()).toMatchObject({ version: '2.0.0' });
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Version two');
    const warnings = (await restarted.list()).packs[0]!.warnings.join('\n');
    expect(warnings).toContain(`an interrupted update was kept at ${kept}`);
    expect(existsSync(path.join(skillsRoot, '.mish-pack-retiring'))).toBe(false);
  });

  it('keeps the backup warnings across restarts', async () => {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await makeStore().install(v1);
    await fsp.writeFile(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'my edit');
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await makeStore().install(v2);
    for (let round = 0; round < 2; round += 1) {
      resetMishPacksForTests();
      const restarted = makeStore();
      await restarted.start();
      const warnings = (await restarted.list()).packs[0]!.warnings;
      expect(warnings.filter((text) => text.includes('had changed since the pack added it'))).toHaveLength(1);
    }
  });

  it('builds a copy it re-places at start outside the scanned roots', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    await fsp.rm(path.join(skillsRoot, 'pack-skill-a'), { recursive: true });
    const sources: string[] = [];
    const rename = fsp.rename.bind(fsp);
    const spy = vi.spyOn(fsp, 'rename').mockImplementation(async (from, to) => {
      if (path.dirname(String(to)) === skillsRoot) sources.push(String(from));
      return rename(from, to);
    });
    try {
      resetMishPacksForTests();
      await makeStore().start();
    } finally {
      spy.mockRestore();
    }
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'))).toBe(true);
    expect(sources).toHaveLength(1);
    expect(path.dirname(path.dirname(sources[0]!))).toBe(path.join(skillsRoot, '.mish-pack-staging'));
    expect(readdirSync(skillsRoot).filter((name) => name.startsWith('.mish-pack-') && name !== '.mish-pack-backups')).toEqual([]);
  });

  it('does not act on a journal whose paths are not the ones its token derives', async () => {
    const outside = tempDir('mish-outside-');
    writeFile(outside, 'precious.txt', 'keep me');
    const journalDir = path.join(dataDir, 'mish-packs', '.journal');
    const token = '11111111-2222-4333-8444-555555555555';
    const base = {
      token, packId: 'team-kit', version: '1.0.0', phase: 'preparing', incomingTree: path.join(dataDir, 'mish-packs', '.incoming', token),
      previousTree: path.join(dataDir, 'mish-packs', '.previous', token),
      stagingDirs: [path.join(skillsRoot, '.mish-pack-staging', token), path.join(dsRoot, '.mish-pack-staging', token)],
      stagedCopies: [], oldReceipt: null, warnings: [],
    };
    writeFile(journalDir, `${token}.json`, JSON.stringify({ ...base, incomingTree: outside }));
    const other = '22222222-2222-4333-8444-555555555555';
    writeFile(journalDir, `${other}.json`, JSON.stringify({
      ...base, token: other, phase: 'committed', incomingTree: path.join(dataDir, 'mish-packs', '.incoming', other), previousTree: path.join(dataDir, 'mish-packs', '.previous', other),
      stagingDirs: [path.join(skillsRoot, '.mish-pack-staging', other), path.join(dsRoot, '.mish-pack-staging', other)],
      stagedCopies: [{ bucket: 'skills', name: '../escape', path: path.join(outside, 'x'), digest: null }],
    }));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resetMishPacksForTests();
      await makeStore().start();
    } finally {
      warn.mockRestore();
    }
    expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me');
    expect(existsSync(path.join(journalDir, `${token}.json`))).toBe(true);
    expect(existsSync(path.join(journalDir, `${other}.json`))).toBe(true);
  });

  it('adds saved projects without settings only the daemon sets, and refuses over-long instructions', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { projects: 'projects' } });
    const row = {
      id: 'proj-meta', name: 'Meta', designSystemId: 'user:elsewhere', createdAt: 1, updatedAt: 1,
      metadata: { kind: 'prototype', localCatalogScopes: { skill: 'workspace:other' }, fromTrustedPicker: true, orchestratorWorkspace: '/etc', importedFrom: 'folder', keep: 'yes' },
    };
    writeFile(source, 'projects/projects.json', JSON.stringify({ schema: 'mish-pack-projects/1', projects: [row] }));
    await makeStore().install(source);
    expect(getProject(db, 'proj-meta')).toMatchObject({ designSystemId: null, metadata: { kind: 'prototype', keep: 'yes' } });
    const imported = getProject(db, 'proj-meta') as unknown as { metadata: Record<string, unknown> };
    for (const key of ['localCatalogScopes', 'fromTrustedPicker', 'orchestratorWorkspace', 'importedFrom']) expect(imported.metadata[key], key).toBeUndefined();

    const long = tempDir('mish-src-');
    writeFixturePack(long, { id: 'long-kit', provides: { projects: 'projects' } });
    writeFile(long, 'projects/projects.json', JSON.stringify({ schema: 'mish-pack-projects/1', projects: [{ ...row, id: 'proj-long', customInstructions: 'x'.repeat(5001) }] }));
    await expectPackError(makeStore().install(long), 'INVALID_MANIFEST');
    expect(getProject(db, 'proj-long')).toBeNull();
  });

  it('tries a project again at the next start when its row could not be added', async () => {
    db.exec("CREATE TRIGGER block_one BEFORE INSERT ON projects WHEN NEW.id = 'proj-one' BEGIN SELECT RAISE(ABORT, 'blocked'); END");
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const { pack } = await makeStore().install(source);
    expect(pack.warnings.join(' ')).toMatch(/projects\/proj-one could not be added/);
    expect(getProject(db, 'proj-one')).toBeNull();
    expect(existsSync(path.join(projectsDir, 'proj-one'))).toBe(false);
    expect(getProject(db, 'proj-empty')).not.toBeNull();
    db.exec('DROP TRIGGER block_one');
    resetMishPacksForTests();
    await makeStore().start();
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Project one' });
    expect(existsSync(path.join(projectsDir, 'proj-one', 'index.html'))).toBe(true);
  });
});

/** One part of the split module `kit`: one skill with the given text, and the given projects. */
function writePart(root: string, id: string, version: string, skills: Record<string, string>, projects: string[]): void {
  for (const [name, text] of Object.entries(skills)) writeFile(root, `skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: part\n---\n${text}\n`);
  writeFile(root, 'projects/projects.json', JSON.stringify({
    schema: 'mish-pack-projects/1',
    projects: projects.map((projectId) => ({ id: projectId, name: projectId, createdAt: 1, updatedAt: 1 })),
  }));
  for (const projectId of projects) writeFile(root, `projects/${projectId}/index.html`, `<h1>${projectId}</h1>`);
  writeFile(root, 'mish-pack.json', JSON.stringify({ schemaVersion: 1, id, name: id, version, provides: { skills: 'skills', projects: 'projects' } }));
}

describe('audit round 2', () => {
  it('deletes an unchanged copy only at a start a day later, and keeps one an editor saved into meanwhile', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    await makeStore({ now: () => new Date('2026-10-12T10:00:00.000Z') }).remove('team-kit');
    const retired = path.join(skillsRoot, '.mish-pack-retired', 'team-kit-2026-10-12T10-00-00-000Z');
    // Set aside, not deleted yet.
    expect(existsSync(path.join(retired, 'pack-skill-a', 'SKILL.md'))).toBe(true);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
    // An editor that still had the file open saves after the comparison.
    await fsp.writeFile(path.join(retired, 'pack-skill-a', 'SKILL.md'), 'saved late');
    // A start within a day leaves it alone.
    resetMishPacksForTests();
    await makeStore({ now: () => new Date('2026-10-12T20:00:00.000Z') }).start();
    expect(existsSync(path.join(retired, 'pack-skill-b', 'SKILL.md'))).toBe(true);
    resetMishPacksForTests();
    await makeStore().start();
    const kept = path.join(skillsRoot, '.mish-pack-backups', 'team-kit-2026-10-12T10-00-00-000Z', 'pack-skill-a', 'SKILL.md');
    expect(readFileSync(kept, 'utf8')).toBe('saved late');
    expect(existsSync(path.join(skillsRoot, '.mish-pack-retired'))).toBe(false);
    expect(existsSync(path.join(skillsRoot, '.mish-pack-backups', 'team-kit-2026-10-12T10-00-00-000Z', 'pack-skill-b'))).toBe(false);
  });

  it('leaves a copy to the pack that placed it, and places it once that pack lets it go', async () => {
    const first = tempDir('mish-src-');
    writePart(first, 'kit-1', '1.0.0', { 'moving-skill': 'from part one', 'shared-skill': 'part one', 'stay-skill': 'stays' }, ['proj-moving']);
    await makeStore().install(first);
    // A new build moved two folders and a project to the second part.
    const second = tempDir('mish-src-');
    writePart(second, 'kit-2', '2.0.0', { 'moving-skill': 'from part two', 'shared-skill': 'part two' }, ['proj-moving']);
    const { pack } = await makeStore().install(second);
    expect(pack.warnings.join('\n')).toMatch(/skills\/moving-skill is provided by the pack kit-1 too/);
    expect(readFileSync(path.join(skillsRoot, 'moving-skill', 'SKILL.md'), 'utf8')).toContain('from part one');
    expect(receiptOf('kit-1').copied.skills.sort()).toEqual(['moving-skill', 'shared-skill', 'stay-skill']);
    expect(receiptOf('kit-2').copied.skills).toEqual([]);

    // The first part's new version no longer has moving-skill: the second part places its own.
    const firstV2 = tempDir('mish-src-');
    writePart(firstV2, 'kit-1', '2.0.0', { 'shared-skill': 'part one', 'stay-skill': 'stays' }, []);
    await makeStore().install(firstV2);
    expect(readFileSync(path.join(skillsRoot, 'moving-skill', 'SKILL.md'), 'utf8')).toContain('from part two');
    expect(receiptOf('kit-2').copied.skills).toEqual(['moving-skill']);

    // Removing the first part: its copies go, and the second part places the one it shares.
    await makeStore().remove('kit-1');
    expect(existsSync(path.join(skillsRoot, 'stay-skill'))).toBe(false);
    expect(readFileSync(path.join(skillsRoot, 'shared-skill', 'SKILL.md'), 'utf8')).toContain('part two');
    expect(receiptOf('kit-2').copied.skills.sort()).toEqual(['moving-skill', 'shared-skill']);
    const warnings = (await makeStore().list()).packs.find((entry) => entry.id === 'kit-2')!.warnings.join('\n');
    expect(warnings).not.toMatch(/left as it is/);
    expect(getProject(db, 'proj-moving')).not.toBeNull();
  });

  it('does not bring back a project the person deleted when another pack now provides it', async () => {
    const first = tempDir('mish-src-');
    writePart(first, 'kit-1', '1.0.0', { 'one-skill': 'one' }, ['proj-moving']);
    await makeStore().install(first);
    db.prepare('DELETE FROM projects WHERE id = ?').run('proj-moving');
    await fsp.rm(path.join(projectsDir, 'proj-moving'), { recursive: true, force: true });
    const second = tempDir('mish-src-');
    writePart(second, 'kit-2', '2.0.0', { 'two-skill': 'two' }, ['proj-moving']);
    await makeStore().install(second);
    expect(getProject(db, 'proj-moving')).toBeNull();
    // Still known once the pack that imported it is gone.
    await makeStore().remove('kit-1');
    const later = tempDir('mish-src-');
    writePart(later, 'kit-2', '3.0.0', { 'two-skill': 'two' }, ['proj-moving']);
    await makeStore().install(later);
    expect(getProject(db, 'proj-moving')).toBeNull();
  });

  it('claims MCP entries an in-place update wrote before it was cut short', async () => {
    const external = tempDir('mish-external-');
    const packDir = path.join(external, 'team-kit');
    writeProjectsPack(packDir);
    resetMishPacksForTests();
    await makeStore({ externalDir: external }).start();
    // What a start leaves when it stops after writing v2's MCP entries, before the receipt: the
    // person's ids written down, v2's entries in the settings, the receipt still at v1.
    const theirs = (await readMcpConfig(dataDir)).servers.filter((server) => !server.id.startsWith('pack-'));
    writeVersionTwo(packDir);
    const v2 = JSON.parse(readFileSync(path.join(packDir, 'mish-pack.json'), 'utf8')) as MishPackManifest;
    const intentDir = path.join(dataDir, 'mish-packs', '.mcp-intent');
    await fsp.mkdir(intentDir, { recursive: true });
    await fsp.writeFile(path.join(intentDir, 'team-kit.json'), JSON.stringify(theirs.map((server) => server.id)));
    const written = (v2.provides.mcpServers ?? []).map((server) => packServerToConfig(server)!);
    await fsp.writeFile(path.join(dataDir, 'mcp-config.json'), JSON.stringify({ servers: [...theirs, ...written] }), { mode: 0o600 });

    resetMishPacksForTests();
    const store = makeStore({ externalDir: external });
    await store.start();
    expect(receiptOf().seededMcp.map((entry) => entry.id).sort()).toEqual(['pack-http', 'pack-new', 'pack-stdio']);
    expect((await store.list()).packs[0]!.warnings.join('\n')).not.toMatch(/MCP server .* already exists/);
    expect(existsSync(intentDir)).toBe(false);
  });

  it('brings a new version found at start fully in: removed copies go, MCP changes apply, a study cannot replace a design system', async () => {
    const external = tempDir('mish-external-');
    const packDir = path.join(external, 'team-kit');
    writeProjectsPack(packDir);
    resetMishPacksForTests();
    await makeStore({ externalDir: external }).start();
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b'))).toBe(true);

    writeVersionTwo(packDir);
    await fsp.rm(path.join(packDir, 'skills', 'pack-skill-b'), { recursive: true });
    writeFile(packDir, 'studies/pack-ds/DESIGN.md', '# A study with the design system name\n');
    resetMishPacksForTests();
    const store = makeStore({ externalDir: external });
    await store.start();
    expect(existsSync(path.join(skillsRoot, 'pack-skill-b'))).toBe(false);
    expect(receiptOf().copied.skills).not.toContain('pack-skill-b');
    expect(readFileSync(path.join(dsRoot, 'pack-ds', 'DESIGN.md'), 'utf8')).toBe('# Pack design system\n');
    const servers = (await readMcpConfig(dataDir)).servers;
    expect(servers.find((server) => server.id === 'pack-http')).toMatchObject({ url: 'https://mcp-v2.example.test/mcp' });
    expect(servers.map((server) => server.id)).toContain('pack-new');
    const warnings = (await store.list()).packs[0]!.warnings.join('\n');
    expect(warnings).toMatch(/studies\/pack-ds is provided twice/);
    expect(warnings).not.toMatch(/MCP server pack-http already exists/);
  });

  it('drops a retry warning once the retry succeeds', async () => {
    const { target } = await linkMcpConfig();
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const { pack } = await makeStore().install(source);
    expect(pack.warnings.join(' ')).toMatch(/the app tries again when it starts/);
    await fsp.rm(path.join(dataDir, 'mcp-config.json'));
    await fsp.rm(target);
    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect((await restarted.list()).packs[0]!.warnings.join(' ')).not.toMatch(/tries again/);
    expect(await serverIds()).toEqual(['pack-http', 'pack-stdio']);
    expect(leftovers()).toEqual([]);
  });

  it('puts back only the MCP entries that were there when a failed update took them away', async () => {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await makeStore().install(v1);
    // The person deletes one of the pack's entries.
    const config = await readMcpConfig(dataDir);
    await fsp.writeFile(path.join(dataDir, 'mcp-config.json'), JSON.stringify({ servers: config.servers.filter((server) => server.id !== 'pack-http') }), { mode: 0o600 });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await makeStore({ onInstallStep: at('mcp-unseeded', 'fail') }).install(v2);
    expect(await serverIds()).toEqual(['pack-stdio']);
  });
});
