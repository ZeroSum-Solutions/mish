// Mish packs: saved projects (placed under their own ids, never over a project the person has,
// retired or backed up on remove) and recoverable replacement (a failed or interrupted install puts
// the previous generation back). Fixtures are owned test data written into temp folders.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, getProject, insertConversation, insertProject, openDatabase } from '../../src/db.js';
import { readMcpConfig } from '../../src/mcp-config.js';
import { isMishPackError } from '../../src/mish-packs/errors.js';
import { resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore, type MishPackStore, type MishPackStoreOptions } from '../../src/mish-packs/store.js';
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

/** The fixture pack plus a `projects` folder: two projects with files, one empty, one pointing outside. */
function writeProjectsPack(root: string, options: { version?: string; extraProjects?: boolean } = {}): void {
  writeFixturePack(root, { version: options.version ?? '1.0.0', provides: { projects: 'projects' } });
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

function bumpVersion(root: string, version: string): void {
  const file = path.join(root, 'mish-pack.json');
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { version: string };
  manifest.version = version;
  writeFile(root, 'mish-pack.json', JSON.stringify(manifest, null, 2));
}

async function expectPackError(promise: Promise<unknown>, code: string): Promise<void> {
  const error = await promise.then(() => null, (caught: unknown) => caught);
  expect(isMishPackError(error), String(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
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
  it('places each project under its own id, with its row', async () => {
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

  it('never replaces a project the person already has, and leaves it on remove', async () => {
    const now = Date.now();
    insertProject(db, { id: 'proj-one', name: 'Mine', metadata: { kind: 'prototype' }, createdAt: now, updatedAt: now });
    writeFile(projectsDir, 'proj-one/mine.txt', 'mine');
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore();
    const { pack } = await store.install(source);
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Mine' });
    expect(readdirSync(path.join(projectsDir, 'proj-one'))).toEqual(['mine.txt']);
    expect(pack.warnings.join(' ')).toMatch(/projects\/proj-one already exists and was left as it is/);

    await store.remove('team-kit');
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Mine' });
    expect(readFileSync(path.join(projectsDir, 'proj-one', 'mine.txt'), 'utf8')).toBe('mine');
    expect(getProject(db, 'ds-pack-ds')).toBeNull();
  });

  it('removes untouched projects and moves an edited one to a backup folder', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    await fsp.writeFile(path.join(projectsDir, 'ds-pack-ds', 'DESIGN.md'), 'edited by the user');

    const timed = makeStore({ now: () => new Date('2026-10-12T09:00:00.000Z') });
    const result = await timed.remove('team-kit');
    const backup = path.join(projectsDir, '.mish-pack-backups', 'team-kit-2026-10-12T09-00-00-000Z', 'ds-pack-ds');
    expect(result.backups).toEqual([{ resource: 'projects', name: 'ds-pack-ds', path: backup }]);
    expect(result.kept).toBeUndefined();
    expect(readFileSync(path.join(backup, 'DESIGN.md'), 'utf8')).toBe('edited by the user');
    for (const id of ['ds-pack-ds', 'proj-one', 'proj-empty']) {
      expect(getProject(db, id), id).toBeNull();
      expect(existsSync(path.join(projectsDir, id)), id).toBe(false);
    }
  });

  it('keeps a project the person has chatted in as their own', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    await makeStore().install(source);
    insertConversation(db, { id: 'conv-1', projectId: 'proj-one', title: 'Hello', createdAt: 1, updatedAt: 1 });

    const result = await makeStore().remove('team-kit');
    expect(result.kept).toEqual([{ resource: 'projects', name: 'proj-one', reason: expect.stringMatching(/changed or used/) }]);
    expect(getProject(db, 'proj-one')).not.toBeNull();
    expect(existsSync(path.join(projectsDir, 'proj-one', 'index.html'))).toBe(true);
    expect(getProject(db, 'ds-pack-ds')).toBeNull();
  });

  it('replaces an untouched project on reinstall and backs up an edited one', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore();
    await store.install(source);
    await fsp.writeFile(path.join(projectsDir, 'proj-one', 'index.html'), 'edited');

    const second = await store.install(source);
    expect(second.replaced).toBe(true);
    expect(second.backups.map((backup) => `${backup.resource}/${backup.name}`)).toEqual(['projects/proj-one']);
    expect(readFileSync(path.join(second.backups[0]!.path, 'index.html'), 'utf8')).toBe('edited');
    expect(readFileSync(path.join(projectsDir, 'proj-one', 'index.html'), 'utf8')).toBe('<h1>One</h1>');
    expect(getProject(db, 'proj-one')).toMatchObject({ name: 'Project one' });
    expect(getProject(db, 'ds-pack-ds')).not.toBeNull();
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

/** Everything that makes version 1 of the fixture "active", read back from disk and the database. */
async function activeState() {
  const servers = (await readMcpConfig(dataDir)).servers.map((server) => JSON.stringify(server)).sort();
  const receipt = JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', '.receipts', 'team-kit.json'), 'utf8')) as { version: string };
  return {
    version: receipt.version,
    skillA: readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8'),
    skillB: readFileSync(path.join(skillsRoot, 'pack-skill-b', 'SKILL.md'), 'utf8'),
    skillC: existsSync(path.join(skillsRoot, 'pack-skill-c')),
    designSystem: readFileSync(path.join(dsRoot, 'pack-ds', 'DESIGN.md'), 'utf8'),
    projectOne: readFileSync(path.join(projectsDir, 'proj-one', 'index.html'), 'utf8'),
    projectRows: ['ds-pack-ds', 'proj-one', 'proj-empty', 'proj-two'].map((id) => getProject(db, id)?.name ?? null),
    projectTwo: existsSync(path.join(projectsDir, 'proj-two')),
    servers,
    packVersion: (JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', 'team-kit', 'mish-pack.json'), 'utf8')) as { version: string }).version,
  };
}

function leftovers(): string[] {
  const out: string[] = [];
  for (const root of [skillsRoot, dsRoot, projectsDir]) if (existsSync(path.join(root, '.mish-pack-previous'))) out.push(root);
  const previous = path.join(dataDir, 'mish-packs', '.previous');
  if (existsSync(previous) && readdirSync(previous).length > 0) out.push(previous);
  return out;
}

/** Version 2 of the fixture: other skill text, one more skill, one more project, another MCP url. */
function writeVersionTwo(source: string): void {
  writeProjectsPack(source, { extraProjects: true });
  bumpVersion(source, '2.0.0');
  writeFile(source, 'skills/pack-skill-a/SKILL.md', '---\nname: pack-skill-a\ndescription: v2\n---\nVersion two\n');
  writeFile(source, 'skills/pack-skill-c/SKILL.md', '---\nname: pack-skill-c\ndescription: v2\n---\nNew in two\n');
  const file = path.join(source, 'mish-pack.json');
  writeFile(source, 'mish-pack.json', readFileSync(file, 'utf8').replace('https://mcp.example.test/mcp', 'https://mcp-v2.example.test/mcp'));
}

describe('recoverable replacement', () => {
  it('puts the previous version back, fully active, when the new one fails to activate', async () => {
    let fail = false;
    const store = makeStore({ afterActivate: () => { if (fail) throw new Error('injected activation failure'); } });
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await store.install(v1);
    // A copy the person changed: replacing moves it to a backup, a rollback must put it back.
    await fsp.writeFile(path.join(skillsRoot, 'pack-skill-b', 'SKILL.md'), 'edited by the user');
    const before = await activeState();
    expect(before).toMatchObject({ version: '1.0.0', skillC: false, projectTwo: false });

    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    fail = true;
    await expect(store.install(v2)).rejects.toThrow('injected activation failure');

    expect(await activeState()).toEqual(before);
    expect(leftovers()).toEqual([]);
    const [summary] = (await store.list()).packs;
    expect(summary).toMatchObject({ id: 'team-kit', version: '1.0.0' });
    expect(readdirSync(skillsRoot).filter((name) => name.startsWith('.mish-pack-backups'))).toEqual([]);

    // The same store then replaces it cleanly.
    fail = false;
    const replaced = await store.install(v2);
    expect(replaced.pack.version).toBe('2.0.0');
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Version two');
    expect(getProject(db, 'proj-two')).not.toBeNull();
    expect(leftovers()).toEqual([]);
  });

  it('leaves nothing behind when a first install fails to activate', async () => {
    const source = tempDir('mish-src-');
    writeProjectsPack(source);
    const store = makeStore({ afterActivate: () => { throw new Error('injected activation failure'); } });
    await expect(store.install(source)).rejects.toThrow('injected activation failure');
    expect((await store.list()).packs).toEqual([]);
    expect(existsSync(path.join(skillsRoot, 'pack-skill-a'))).toBe(false);
    expect(existsSync(path.join(dsRoot, 'pack-ds'))).toBe(false);
    expect(getProject(db, 'ds-pack-ds')).toBeNull();
    expect(existsSync(path.join(projectsDir, 'ds-pack-ds'))).toBe(false);
    expect((await readMcpConfig(dataDir)).servers).toEqual([]);
    expect(existsSync(path.join(dataDir, 'mish-packs', '.receipts', 'team-kit.json'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('rolls an interrupted replacement back on the next start', async () => {
    const v1 = tempDir('mish-src-');
    writeProjectsPack(v1);
    await makeStore().install(v1);
    const before = await activeState();

    // The install stops for good after activating version 2, as if the process had died there.
    let reached!: () => void;
    const stopped = new Promise<void>((resolve) => { reached = resolve; });
    const dying = makeStore({ afterActivate: () => { reached(); return new Promise<void>(() => undefined); } });
    const v2 = tempDir('mish-src-');
    writeVersionTwo(v2);
    void dying.install(v2);
    await stopped;
    expect(readFileSync(path.join(skillsRoot, 'pack-skill-a', 'SKILL.md'), 'utf8')).toContain('Version two');

    resetMishPacksForTests();
    const restarted = makeStore();
    await restarted.start();
    expect(await activeState()).toEqual(before);
    expect(leftovers()).toEqual([]);
    expect((await restarted.list()).packs.map((pack) => `${pack.id}@${pack.version}`)).toEqual(['team-kit@1.0.0']);
  });
});
