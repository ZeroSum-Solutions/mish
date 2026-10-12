// Atlas Builds request 003: reinstalling a user design system must refresh
// its `ds-<id>` workspace project, which is the copy the app opens for the
// kit. Before this fix `ensureUserDesignSystemWorkspaceProject` rewrote an
// existing project's files only when they were legacy placeholders, so every
// real kit file stayed on the old install forever.
//
// The sync is three-way: package (new) vs project (current) vs the baseline
// recorded when the file was last materialised. Unedited files follow the
// package; user edits survive and are reported as conflicts.
//
// The same copy path also used to rename bracketed file names
// (`Face[wght].ttf` -> `Face_wght_.ttf`), which broke the kit's own CSS
// references. Kit materialisation must preserve portable names and refuse,
// never rename, the rest.

import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  deleteUserDesignSystem,
  LEGACY_DESIGN_SYSTEM_ARTIFACTS,
  linkUserDesignSystemProject,
  listDesignSystems,
  listUserDesignSystemFiles,
  readDesignSystem,
  readDesignSystemPackageInfo,
  readDesignSystemStaticFile,
  readUserDesignSystemFile,
  readUserDesignSystemFileBytes,
  syncUserDesignSystemAssetsFromFiles,
} from '../../src/design-systems/index.js';
import { createDesignSystemServerServices } from '../../src/design-systems/server-services.js';
import { designSystemWorkspaceSyncTestHooks } from '../../src/design-systems/workspace-sync.js';
import {
  closeDatabase,
  getProject,
  insertProject,
  openDatabase,
  updateProject,
} from '../../src/db.js';
import { installFromTarget } from '../../src/library-install.js';
import {
  isSafeId,
  listFiles,
  readProjectFile,
  resolveProjectDir,
  writeProjectFile,
} from '../../src/projects.js';

const KIT_DIR = 'atlas-kit';
const DS_ID = `user:${KIT_DIR}`;
const PROJECT_ID = `ds-${KIT_DIR}`;
const DESIGN_MD = '# Atlas Kit\n\n> Category: SaaS\n> Surface: web\n\nAtlas body copy.\n';

type SyncConflict = { path: string; reason: string };

describe('ensureUserDesignSystemWorkspaceProject after a reinstall', () => {
  let workRoot = '';
  let userDesignSystemsDir = '';
  let projectsDir = '';
  let kitSourcesDir = '';
  let db: ReturnType<typeof openDatabase>;
  let services: ReturnType<typeof createDesignSystemServerServices>;

  beforeEach(async () => {
    workRoot = await mkdtemp(path.join(tmpdir(), 'od-ds-reinstall-sync-'));
    userDesignSystemsDir = path.join(workRoot, 'design-systems');
    projectsDir = path.join(workRoot, 'projects');
    kitSourcesDir = path.join(workRoot, 'kit-sources');
    await mkdir(userDesignSystemsDir, { recursive: true });
    await mkdir(projectsDir, { recursive: true });
    await mkdir(kitSourcesDir, { recursive: true });
    db = openDatabase(workRoot, { dataDir: workRoot });
    services = createServices(readUserDesignSystemFileBytes);
  });

  function createServices(readBytes: typeof readUserDesignSystemFileBytes) {
    return createDesignSystemServerServices({
      roots: { SKILL_ROOTS: [], DESIGN_TEMPLATE_ROOTS: [], ALL_SKILL_LIKE_ROOTS: [] },
      paths: {
        PROJECTS_DIR: projectsDir,
        DESIGN_SYSTEMS_DIR: path.join(workRoot, 'built-in-design-systems'),
        USER_DESIGN_SYSTEMS_DIR: userDesignSystemsDir,
      },
      skills: { listSkills: async () => [], findSkillById: () => undefined },
      designSystems: {
        listDesignSystems,
        readDesignSystem,
        readDesignSystemPackageInfo,
        readDesignSystemStaticFile,
        listUserDesignSystemFiles,
        readUserDesignSystemFile,
        readUserDesignSystemFileBytes: readBytes,
        linkUserDesignSystemProject,
        syncUserDesignSystemAssetsFromFiles,
        LEGACY_DESIGN_SYSTEM_ARTIFACTS,
        // See asset-sync.test.ts: the isolated test resolves the module's
        // types under two resolution modes, so widen with a cast.
      } as unknown as Parameters<typeof createDesignSystemServerServices>[0]['designSystems'],
      projects: {
        getProject,
        insertProject,
        updateProject,
        readProjectFile,
        writeProjectFile,
        listFiles,
        resolveProjectDir,
        isSafeId,
      },
    });
  }

  afterEach(async () => {
    closeDatabase();
    if (workRoot) await rm(workRoot, { recursive: true, force: true });
  });

  /** Writes a kit version to disk and (re)installs it the way the
   * DELETE + POST /api/design-systems/install repro does. */
  async function installKit(version: string, files: Record<string, string>) {
    const source = path.join(kitSourcesDir, version, KIT_DIR);
    await rm(source, { recursive: true, force: true });
    for (const [rel, content] of Object.entries({ 'DESIGN.md': DESIGN_MD, ...files })) {
      const target = path.join(source, ...rel.split('/'));
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    }
    await deleteUserDesignSystem(userDesignSystemsDir, DS_ID);
    const result = await installFromTarget(
      { source: 'local', path: source },
      userDesignSystemsDir,
      'design-system',
    );
    expect(result).toMatchObject({ ok: true });
  }

  async function ensure() {
    const workspace = await services.ensureUserDesignSystemWorkspaceProject(db, DS_ID);
    expect(workspace).not.toBeNull();
    return workspace as NonNullable<typeof workspace> & { syncConflicts?: SyncConflict[] };
  }

  async function projectText(rel: string) {
    return readFile(path.join(projectsDir, PROJECT_ID, ...rel.split('/')), 'utf8');
  }

  async function projectHas(rel: string) {
    try {
      await stat(path.join(projectsDir, PROJECT_ID, ...rel.split('/')));
      return true;
    } catch {
      return false;
    }
  }

  it('refreshes changed files, adds new files and removes dropped files', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit v1</main>',
      'system/retired.html': '<main>retired in v2</main>',
    });
    const first = await ensure();
    expect(first.project.id).toBe(PROJECT_ID);
    expect(await projectText('system/kit.html')).toBe('<main>kit v1</main>');

    await installKit('v2', {
      'system/kit.html': '<main>kit v2</main>',
      'system/added.html': '<main>new in v2</main>',
    });
    const second = await ensure();

    expect(await projectText('system/kit.html')).toBe('<main>kit v2</main>');
    expect(await projectText('system/added.html')).toBe('<main>new in v2</main>');
    expect(await projectHas('system/retired.html')).toBe(false);
    expect(second.syncConflicts ?? []).toEqual([]);
  });

  it('keeps a user-edited file, reports it as a conflict, and still refreshes the rest', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit v1</main>',
      'system/tokens.css': ':root { --a: 1; }',
      'system/notes.md': 'notes v1',
      'system/retired.html': '<main>retired</main>',
    });
    await ensure();
    const projectDir = path.join(projectsDir, PROJECT_ID);
    await writeFile(path.join(projectDir, 'system', 'kit.html'), '<main>my edit</main>', 'utf8');
    // An edit to a file the new package leaves unchanged is not a conflict.
    await writeFile(path.join(projectDir, 'system', 'tokens.css'), ':root { --a: 2; }', 'utf8');
    // An edited file the new package drops is kept and reported.
    await writeFile(path.join(projectDir, 'system', 'retired.html'), '<main>kept</main>', 'utf8');

    await installKit('v2', {
      'system/kit.html': '<main>kit v2</main>',
      'system/tokens.css': ':root { --a: 1; }',
      'system/notes.md': 'notes v2',
    });
    const second = await ensure();

    expect(await projectText('system/kit.html')).toBe('<main>my edit</main>');
    expect(await projectText('system/tokens.css')).toBe(':root { --a: 2; }');
    expect(await projectText('system/notes.md')).toBe('notes v2');
    expect(await projectText('system/retired.html')).toBe('<main>kept</main>');
    expect(second.syncConflicts).toEqual(
      expect.arrayContaining([
        { path: 'system/kit.html', reason: 'edited' },
        { path: 'system/retired.html', reason: 'removed-upstream-edited' },
      ]),
    );
    expect(second.syncConflicts).toHaveLength(2);
  });

  it('migrates a project that predates the sync baseline without overwriting differing files', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit v1</main>',
      'system/same.html': '<main>same</main>',
      'system/missing.html': '<main>missing</main>',
    });
    // A project materialised before the baseline existed: its kit.html is
    // stale (or edited — without a baseline the two cannot be told apart).
    insertProject(db, {
      id: PROJECT_ID,
      name: 'Atlas Kit',
      designSystemId: DS_ID,
      metadata: { kind: 'other', importedFrom: 'design-system', entryFile: 'DESIGN.md', sourceFileName: DS_ID },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const projectDir = path.join(projectsDir, PROJECT_ID);
    await mkdir(path.join(projectDir, 'system'), { recursive: true });
    await writeFile(path.join(projectDir, 'system', 'kit.html'), '<main>old install</main>', 'utf8');
    await writeFile(path.join(projectDir, 'system', 'same.html'), '<main>same</main>', 'utf8');

    const migrated = await ensure();
    expect(await projectText('system/kit.html')).toBe('<main>old install</main>');
    expect(await projectText('system/missing.html')).toBe('<main>missing</main>');
    expect(migrated.syncConflicts).toEqual([{ path: 'system/kit.html', reason: 'no-baseline' }]);

    // The migration recorded a baseline for files that matched, so the next
    // reinstall refreshes them like any synced file.
    await installKit('v2', {
      'system/kit.html': '<main>kit v1</main>',
      'system/same.html': '<main>same v2</main>',
      'system/missing.html': '<main>missing</main>',
    });
    const next = await ensure();
    expect(await projectText('system/same.html')).toBe('<main>same v2</main>');
    expect(await projectText('system/kit.html')).toBe('<main>old install</main>');
    // The unresolved difference is reported again, not consumed.
    expect(next.syncConflicts).toEqual([{ path: 'system/kit.html', reason: 'no-baseline' }]);
  });

  it('keeps an edited legacy README that still has an old preview reference', async () => {
    const readme = '# Atlas Kit\n\nOpen ui_kits/app/index.html to review the kit.\n';
    await installKit('v1', { 'README.md': readme, 'SKILL.md': readme });
    insertProject(db, {
      id: PROJECT_ID,
      name: 'Atlas Kit',
      designSystemId: DS_ID,
      metadata: { kind: 'other', importedFrom: 'design-system', entryFile: 'DESIGN.md', sourceFileName: DS_ID },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    const projectDir = path.join(projectsDir, PROJECT_ID);
    await mkdir(projectDir, { recursive: true });
    // Exactly the package doc as an earlier daemon wrote it: replaced.
    const legacyExact = readme.replace('ui_kits/app/index.html', 'ui_kits/generated_interface/index.html');
    await writeFile(path.join(projectDir, 'SKILL.md'), legacyExact, 'utf8');
    // The same, plus a user note: kept.
    const legacyEdited = `${legacyExact}\nMy own review notes.\n`;
    await writeFile(path.join(projectDir, 'README.md'), legacyEdited, 'utf8');

    const workspace = await ensure();
    expect(await projectText('SKILL.md')).toBe(readme);
    expect(await projectText('README.md')).toBe(legacyEdited);
    expect(workspace.syncConflicts).toEqual([{ path: 'README.md', reason: 'no-baseline' }]);
  });

  it('keeps an edit made between the decision and the write', async () => {
    await installKit('v1', { 'system/kit.html': '<main>kit v1</main>' });
    await ensure();
    await installKit('v2', { 'system/kit.html': '<main>kit v2</main>' });
    designSystemWorkspaceSyncTestHooks.beforeCommit = async ({ path: rel, absolutePath }) => {
      if (rel === 'system/kit.html') await writeFile(absolutePath, '<main>racing edit</main>', 'utf8');
    };
    try {
      const workspace = await ensure();
      expect(await projectText('system/kit.html')).toBe('<main>racing edit</main>');
      expect(workspace.syncConflicts).toEqual([{ path: 'system/kit.html', reason: 'edited' }]);
    } finally {
      delete designSystemWorkspaceSyncTestHooks.beforeCommit;
    }
    const entries = await readdir(path.join(projectsDir, PROJECT_ID, 'system'));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
  });

  it('refuses a dangling symlink to an outside path and creates no external file', async () => {
    await installKit('v1', { 'system/kit.html': '<main>kit v1</main>' });
    await ensure();
    const outside = path.join(workRoot, 'outside', 'pwned.html');
    await mkdir(path.dirname(outside), { recursive: true });
    await symlink(outside, path.join(projectsDir, PROJECT_ID, 'system', 'new.html'));
    await installKit('v2', {
      'system/kit.html': '<main>kit v1</main>',
      'system/new.html': '<main>new</main>',
    });

    const workspace = await ensure();
    await expect(stat(outside)).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(path.join(projectsDir, PROJECT_ID, 'system', 'new.html'))).isSymbolicLink()).toBe(true);
    expect(workspace.syncConflicts).toEqual([{ path: 'system/new.html', reason: 'unsafe-path' }]);
  });

  it('reports the same conflicts on consecutive ensures and keeps the removed-upstream baseline', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit v1</main>',
      'system/retired.html': '<main>retired</main>',
    });
    await ensure();
    const projectDir = path.join(projectsDir, PROJECT_ID);
    await writeFile(path.join(projectDir, 'system', 'kit.html'), '<main>my edit</main>', 'utf8');
    await writeFile(path.join(projectDir, 'system', 'retired.html'), '<main>kept</main>', 'utf8');
    await installKit('v2', { 'system/kit.html': '<main>kit v2</main>' });

    const expected = [
      { path: 'system/kit.html', reason: 'edited' },
      { path: 'system/retired.html', reason: 'removed-upstream-edited' },
    ];
    expect((await ensure()).syncConflicts).toEqual(expected);
    expect((await ensure()).syncConflicts).toEqual(expected);
    const row = db
      .prepare(`SELECT path FROM design_system_workspace_sync_baselines WHERE project_id = ? AND path = ?`)
      .get(PROJECT_ID, 'system/retired.html');
    expect(row).toEqual({ path: 'system/retired.html' });

    // Resolving clears them: delete the retired file, adopt the package kit.
    await rm(path.join(projectDir, 'system', 'retired.html'));
    await writeFile(path.join(projectDir, 'system', 'kit.html'), '<main>kit v2</main>', 'utf8');
    expect((await ensure()).syncConflicts).toEqual([]);
  });

  it('does not delete the file when a kit renames Face.ttf to face.ttf', async () => {
    await installKit('v1', { 'fonts/Face.ttf': 'face-v1' });
    await ensure();
    await installKit('v2', { 'fonts/face.ttf': 'face-v2' });

    const workspace = await ensure();
    const entries = await readdir(path.join(projectsDir, PROJECT_ID, 'fonts'));
    expect(entries).toEqual(['Face.ttf']);
    expect(await projectText('fonts/Face.ttf')).toBe('face-v1');
    expect(workspace.syncConflicts).toEqual(expect.arrayContaining([
      { path: 'fonts/face.ttf', reason: 'name-collision' },
    ]));
  });

  it('skips rehashing project files when neither the package nor the project changed', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit v1</main>',
      'system/other.html': '<main>other</main>',
    });
    await ensure();
    const reads: string[] = [];
    designSystemWorkspaceSyncTestHooks.onProjectFileRead = (rel) => { reads.push(rel); };
    try {
      await ensure();
      expect(reads).toEqual([]);

      // A project-side edit invalidates the fast path.
      await writeFile(path.join(projectsDir, PROJECT_ID, 'system', 'other.html'), '<main>edit</main>', 'utf8');
      await ensure();
      expect(reads.length).toBeGreaterThan(0);
    } finally {
      delete designSystemWorkspaceSyncTestHooks.onProjectFileRead;
    }
  });

  describe('directory ownership', () => {
    it('keeps a user-created directory after its only kit file is dropped', async () => {
      await installKit('v1', { 'system/kit.html': '<main>kit</main>' });
      await ensure();
      await mkdir(path.join(projectsDir, PROJECT_ID, 'mine'));
      await installKit('v2', { 'system/kit.html': '<main>kit</main>', 'mine/kit-note.md': 'note' });
      await ensure();
      expect(await projectText('mine/kit-note.md')).toBe('note');
      await installKit('v3', { 'system/kit.html': '<main>kit</main>' });

      const workspace = await ensure();
      expect(await projectHas('mine/kit-note.md')).toBe(false);
      expect((await lstat(path.join(projectsDir, PROJECT_ID, 'mine'))).isDirectory()).toBe(true);
      expect(workspace.syncConflicts ?? []).toEqual([]);
    });

    it('removes a directory the sync created once its files are dropped', async () => {
      await installKit('v1', { 'system/kit.html': '<main>kit</main>', 'extra/deep/x.html': '<main>x</main>' });
      await ensure();
      await installKit('v2', { 'system/kit.html': '<main>kit</main>' });

      await ensure();
      expect(await projectHas('extra')).toBe(false);
    });

    it('retries a failed directory removal on the next ensure', async () => {
      await installKit('v1', { 'system/a/b.html': '<main>b</main>' });
      await ensure();
      await installKit('v2', { 'system/a': 'file a' });
      designSystemWorkspaceSyncTestHooks.beforeRmdir = (rel) => {
        if (rel === 'system/a') throw Object.assign(new Error('injected rmdir fault'), { code: 'EBUSY' });
      };
      try {
        const first = await ensure();
        expect(first.syncConflicts).toEqual([{ path: 'system/a', reason: 'type-change' }]);
        expect((await lstat(path.join(projectsDir, PROJECT_ID, 'system', 'a'))).isDirectory()).toBe(true);
      } finally {
        delete designSystemWorkspaceSyncTestHooks.beforeRmdir;
      }

      const second = await ensure();
      expect(second.syncConflicts ?? []).toEqual([]);
      expect(await projectText('system/a')).toBe('file a');
    });

    it('never removes directories of a project that predates directory records', async () => {
      await installKit('v1', { 'system/a/b.html': '<main>b</main>' });
      await ensure();
      db.prepare(`DELETE FROM design_system_workspace_sync_dirs WHERE project_id = ?`).run(PROJECT_ID);
      await installKit('v2', { 'system/a': 'file a' });

      const workspace = await ensure();
      expect(await projectHas('system/a/b.html')).toBe(false);
      expect((await lstat(path.join(projectsDir, PROJECT_ID, 'system', 'a'))).isDirectory()).toBe(true);
      expect(workspace.syncConflicts).toEqual([{ path: 'system/a', reason: 'type-change' }]);
    });
  });

  describe('file <-> directory type changes', () => {
    it('installs a/b over an unedited file a', async () => {
      await installKit('v1', { 'system/a': 'file a' });
      await ensure();
      await installKit('v2', { 'system/a/b.html': '<main>b</main>' });

      const first = await ensure();
      expect(await projectText('system/a/b.html')).toBe('<main>b</main>');
      expect(first.syncConflicts ?? []).toEqual([]);
      expect((await ensure()).syncConflicts ?? []).toEqual([]);
    });

    it('keeps an edited file a and reports a/b as a type change', async () => {
      await installKit('v1', { 'system/a': 'file a' });
      await ensure();
      await writeFile(path.join(projectsDir, PROJECT_ID, 'system', 'a'), 'my edit', 'utf8');
      await installKit('v2', { 'system/a/b.html': '<main>b</main>' });

      const expected = expect.arrayContaining([{ path: 'system/a/b.html', reason: 'type-change' }]);
      const first = await ensure();
      expect(await projectText('system/a')).toBe('my edit');
      expect(first.syncConflicts).toEqual(expected);
      expect((await ensure()).syncConflicts).toEqual(expected);

      // Resolving it (deleting the edited file) installs a/b.
      await rm(path.join(projectsDir, PROJECT_ID, 'system', 'a'));
      expect((await ensure()).syncConflicts ?? []).toEqual([]);
      expect(await projectText('system/a/b.html')).toBe('<main>b</main>');
    });

    it('installs file a over a directory a/ whose contents were unedited', async () => {
      await installKit('v1', { 'system/a/b.html': '<main>b</main>', 'system/a/c/d.html': '<main>d</main>' });
      await ensure();
      await installKit('v2', { 'system/a': 'file a' });

      const first = await ensure();
      expect(await projectText('system/a')).toBe('file a');
      expect(first.syncConflicts ?? []).toEqual([]);
      expect((await ensure()).syncConflicts ?? []).toEqual([]);
    });

    it('keeps a directory a/ holding a user file and reports a as a type change', async () => {
      await installKit('v1', { 'system/a/b.html': '<main>b</main>' });
      await ensure();
      await writeFile(path.join(projectsDir, PROJECT_ID, 'system', 'a', 'mine.md'), 'notes', 'utf8');
      await installKit('v2', { 'system/a': 'file a' });

      const first = await ensure();
      expect(await projectText('system/a/mine.md')).toBe('notes');
      expect(await projectHas('system/a/b.html')).toBe(false);
      expect(first.syncConflicts).toEqual([{ path: 'system/a', reason: 'type-change' }]);
      expect((await ensure()).syncConflicts).toEqual([{ path: 'system/a', reason: 'type-change' }]);
    });
  });

  it('notices changed package bytes even when size and mtime are preserved', async () => {
    await installKit('v1', { 'system/kit.html': '<main>AAAA</main>' });
    await ensure();
    const installed = path.join(userDesignSystemsDir, KIT_DIR, 'system', 'kit.html');
    const before = await stat(installed);
    await writeFile(installed, '<main>BBBB</main>', 'utf8');
    await utimes(installed, before.atime, before.mtime);

    await ensure();
    expect(await projectText('system/kit.html')).toBe('<main>BBBB</main>');
  });

  it('keeps a tracked doc the user edited into the legacy form', async () => {
    const readme = '# Atlas Kit\n\nOpen ui_kits/app/index.html to review the kit.\n';
    await installKit('v1', { 'README.md': readme });
    await ensure();
    const legacy = readme.replace('ui_kits/app/index.html', 'ui_kits/generated_interface/index.html');
    await writeFile(path.join(projectsDir, PROJECT_ID, 'README.md'), legacy, 'utf8');
    await installKit('v2', { 'README.md': readme, 'system/added.html': '<main>added</main>' });

    await ensure();
    expect(await projectText('README.md')).toBe(legacy);
  });

  it('does not delete a dropped file that is saved between the hash and the unlink', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit</main>',
      'system/retired.html': '<main>retired</main>',
    });
    await ensure();
    await installKit('v2', { 'system/kit.html': '<main>kit</main>' });
    designSystemWorkspaceSyncTestHooks.beforeUnlink = async ({ path: rel, absolutePath }) => {
      if (rel === 'system/retired.html') await writeFile(absolutePath, '<main>saved just now</main>', 'utf8');
    };
    try {
      const workspace = await ensure();
      expect(await projectText('system/retired.html')).toBe('<main>saved just now</main>');
      expect(workspace.syncConflicts).toEqual([
        { path: 'system/retired.html', reason: 'removed-upstream-edited' },
      ]);
    } finally {
      delete designSystemWorkspaceSyncTestHooks.beforeUnlink;
    }
  });

  it('refuses a write whose parent directory is swapped for a symlink mid-sync', async () => {
    await installKit('v1', { 'system/kit.html': '<main>kit v1</main>' });
    await ensure();
    await installKit('v2', { 'system/kit.html': '<main>kit v2</main>' });
    const outside = path.join(workRoot, 'outside-dir');
    await mkdir(outside, { recursive: true });
    const systemDir = path.join(projectsDir, PROJECT_ID, 'system');
    designSystemWorkspaceSyncTestHooks.beforeStage = async ({ path: rel }) => {
      if (rel !== 'system/kit.html') return;
      await rename(systemDir, `${systemDir}-moved`);
      await symlink(outside, systemDir);
    };
    try {
      const workspace = await ensure();
      expect(await readdir(outside)).toEqual([]);
      expect(await readFile(path.join(`${systemDir}-moved`, 'kit.html'), 'utf8')).toBe('<main>kit v1</main>');
      expect(workspace.syncConflicts).toEqual(expect.arrayContaining([
        { path: 'system/kit.html', reason: 'unsafe-path' },
      ]));
    } finally {
      delete designSystemWorkspaceSyncTestHooks.beforeStage;
    }
  });

  it('materialises bracketed kit file names unchanged so the kit CSS still resolves', async () => {
    const css = '@font-face { font-family: Face; src: url("x/Face[wght].ttf") format("truetype"); }';
    await installKit('v1', {
      'fonts/fonts.css': css,
      'fonts/x/Face[wght].ttf': 'font-bytes',
    });
    await ensure();

    const projectCss = await projectText('fonts/fonts.css');
    const ref = /url\("([^"]+)"\)/u.exec(projectCss)?.[1];
    expect(ref).toBe('x/Face[wght].ttf');
    const resolved = path.posix.join('fonts', ref as string);
    const font = await readProjectFile(projectsDir, PROJECT_ID, resolved);
    expect(font.buffer.toString('utf8')).toBe('font-bytes');
    expect(await projectHas('fonts/x/Face_wght_.ttf')).toBe(false);
  });

  it('refuses, never renames, a kit file whose name is not portable', async () => {
    await installKit('v1', {
      'system/kit.html': '<main>kit</main>',
      'system/a|b.html': '<main>pipe</main>',
    });
    const workspace = await ensure();
    expect(await projectHas('system/a|b.html')).toBe(false);
    expect(await projectHas('system/a_b.html')).toBe(false);
    expect(await projectText('system/kit.html')).toBe('<main>kit</main>');
    expect(workspace.syncConflicts).toEqual([{ path: 'system/a|b.html', reason: 'unsupported-name' }]);
  });
});
