// Mish packs: saved projects (imported once under their own ids, never over a project the person
// has, never deleted by the pack) and the two-phase install (nothing current is touched before the
// commit; after it the install only moves forward, also across a crash). Fixtures are owned test
// data written into temp folders. Failures and crashes are injected at the store's install steps.

import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDatabase, getProject, insertConversation, insertProject, openDatabase } from '../../src/db.js';
import { readMcpConfig } from '../../src/mcp-config.js';
import { isMishPackError } from '../../src/mish-packs/errors.js';
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
    // Not settled: a removal waits for it.
    await expectPackError(store.remove('team-kit'), 'BUSY');

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
    await expectPackError(store.remove('team-kit'), 'BUSY');

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

  it('refuses a new install while an earlier one is not settled, so it is never replayed over the newer one', async () => {
    await installVersionOne();
    const failingCleanup = makeStore({ onInstallStep: at('cleanup', 'fail') });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    await failingCleanup.install(v2);
    const v3 = tempDir('mish-src-');
    writeVersionThree(v3);
    // The version 2 journal still cannot settle: version 3 waits.
    await expectPackError(failingCleanup.install(v3), 'BUSY');
    expect(receiptOf().version).toBe('2.0.0');
    expect(existsSync(path.join(skillsRoot, 'pack-skill-d'))).toBe(false);

    // Once it settles, version 3 goes in, and a restart does not bring version 2 back.
    const store = makeStore();
    expect((await store.install(v3)).pack.version).toBe('3.0.0');
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
    writeFile(skillsRoot, '.mish-pack-retiring/team-kit-x/pack-skill-a/SKILL.md', 'held');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      resetMishPacksForTests();
      await makeStore().start();
      for (const file of [
        path.join(packs, '.previous', 'old-token', 'mish-pack.json'),
        path.join(packs, '.previous', 'old-token.json'),
        path.join(packs, '.incoming', 'stray', 'mish-pack.json'),
        path.join(skillsRoot, '.mish-pack-staging', 'stray', 'pack-skill-a', 'SKILL.md'),
        path.join(skillsRoot, '.mish-pack-retiring', 'team-kit-x', 'pack-skill-a', 'SKILL.md'),
      ]) expect(existsSync(file), file).toBe(true);
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).toMatch(/left in place, not matched to an install/);
      expect(logged).toContain(path.join(packs, '.previous', 'old-token'));
    } finally {
      warn.mockRestore();
    }
  });
});
