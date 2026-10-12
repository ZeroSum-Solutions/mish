// Atlas Digest pilot (G1): a local design-system install used to symlink the
// user's source folder into the daemon's design-system root. Every later
// daemon write for that kit — the Workspace claim in metadata.json, a status
// PATCH, the workspace-project link, revisions, the derived README/SKILL.md
// backfill on a file listing — then followed the symlink and landed INSIDE the
// frozen source kit. The pilot saw `metadata.json` appear in a kit whose tree
// hash had been receipted before install.
//
// Invariant pinned here: a local install never changes the source tree. The
// installed entry is a real directory under the daemon-managed root, and every
// install-owned file lives there.

import express from 'express';
import type http from 'node:http';
import { createHash } from 'node:crypto';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  ensureWorkspaceProject,
  getWorkspaceResource,
  getWorkspaceResourceByResourceId,
  openDatabase,
} from '../../src/db.js';
import { workspaceContextFromDirectoryItem } from '../../src/collab/vela-workspace-context.js';
import {
  backfillDesignSystemWorkspaceResources,
  createUserDesignSystemRevision,
  isTeamSyncedUserDesignSystem,
  linkUserDesignSystemProject,
  listDesignSystems,
  listUserDesignSystemFiles,
  readUserDesignSystemFile,
  syncUserDesignSystemAssetsFromFiles,
  updateUserDesignSystem,
  updateUserDesignSystemRevisionStatus,
} from '../../src/design-systems/index.js';
import {
  cleanupInstallStaging,
  DEFAULT_KIT_COPY_BUDGET,
  materializeLinkedEntryForWrite,
} from '../../src/design-systems/kit-materialize.js';
import { installFromTarget } from '../../src/library-install.js';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import { registerStaticResourceRoutes } from '../../src/routes/static-resource.js';

const KIT = 'atlas-frozen-kit';
const DESIGN_MD = '# Atlas Frozen Kit\n\nA receipted kit body with no blockquote metadata.\n';

let server: http.Server | null = null;
let workRoot = '';
let sourceRoot = '';
let source = '';
let userDir = '';

beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'od-ds-local-install-'));
  sourceRoot = path.join(workRoot, 'kit-sources');
  source = path.join(sourceRoot, KIT);
  userDir = path.join(workRoot, 'data', 'design-systems');
  await mkdir(userDir, { recursive: true });
  await writeTree(source, {
    'DESIGN.md': DESIGN_MD,
    'tokens.css': ':root { --ink: #111; }\n',
    'system/kit.html': '<main>kit</main>\n',
    'fonts/Face[wght].ttf': 'font-bytes',
    'iterations/r1/STAGE-FREEZE-RECEIPT.json': '{"frozen":true}\n',
  });
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  closeDatabase();
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(root, ...rel.split('/'));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
}

/** Sorted relative paths plus a sha256 over every path and its bytes. Never
 * follows a symlink: a link is hashed by its target string. */
async function treeDigest(root: string): Promise<{ files: string[]; sha256: string }> {
  const files: string[] = [];
  const hash = createHash('sha256');
  async function walk(dir: string, rel: string): Promise<void> {
    const entries = (await readdir(dir, { withFileTypes: true }))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        files.push(`${childRel} -> ${await readlink(childAbs)}`);
        hash.update(`L:${childRel}:${await readlink(childAbs)}\n`);
      } else if (entry.isDirectory()) {
        hash.update(`D:${childRel}\n`);
        await walk(childAbs, childRel);
      } else {
        files.push(childRel);
        hash.update(`F:${childRel}\n`);
        hash.update(await readFile(childAbs));
      }
    }
  }
  await walk(root, '');
  return { files, sha256: hash.digest('hex') };
}

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function workspaceHeaders(): Record<string, string> {
  return {
    'x-od-workspace-id': 'workspace-a',
    'x-od-workspace-member-id': 'member-a',
    'x-od-workspace-type': 'team',
    'x-od-workspace-role': 'owner',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
  };
}

function routePaths(root: string) {
  return {
    ARTIFACTS_DIR: path.join(root, 'artifacts'),
    BRANDS_DIR: path.join(root, 'brands'),
    BUNDLED_PETS_DIR: path.join(root, 'pets'),
    CRAFT_DIR: path.join(root, 'craft'),
    DESIGN_SYSTEMS_DIR: path.join(root, 'built-in-design-systems'),
    DESIGN_TEMPLATES_DIR: path.join(root, 'design-templates'),
    LIBRARY_DIR: path.join(root, 'library'),
    DESIGN_INDEX_DIR: path.join(root, 'design-index'),
    OD_BIN: path.join(root, 'od'),
    PROJECT_ROOT: root,
    PROJECTS_DIR: path.join(root, 'projects'),
    PROMPT_TEMPLATES_DIR: path.join(root, 'prompt-templates'),
    RUNTIME_DATA_DIR: path.join(root, 'data'),
    RUNTIME_DATA_DIR_CANONICAL: path.join(root, 'data'),
    SKILLS_DIR: path.join(root, 'skills'),
    USER_DESIGN_SYSTEMS_DIR: userDir,
    USER_DESIGN_TEMPLATES_DIR: path.join(root, 'user-design-templates'),
    USER_SKILLS_DIR: path.join(root, 'user-skills'),
  };
}

const listUserSystems = () => listDesignSystems(userDir, {
  idPrefix: 'user:',
  source: 'user',
  isEditable: true,
  defaultStatus: 'draft',
});

/** The real install route (POST /api/design-systems/install) and the real
 * PATCH route on one app, backed by the real design-system module. */
async function startDaemonRoutes(): Promise<string> {
  const db = openDatabase(workRoot, { dataDir: workRoot });
  const verifyWorkspaceRequestAuthority = async (req: any) => ({
    ok: true as const,
    context: workspaceContextFromDirectoryItem({
      workspaceId: req.get('x-od-workspace-id'),
      workspaceName: 'Workspace A',
      workspaceType: 'team',
      workspaceMemberId: req.get('x-od-workspace-member-id'),
      role: 'owner',
      memberStatus: 'active',
      lifecycleState: 'active',
    }),
  });
  const app = express();
  app.use(express.json());
  registerStaticResourceRoutes(app, {
    db,
    verifyWorkspaceRequestAuthority,
    http: {
      createSseResponse: () => undefined,
      getPublicBaseUrl: () => '',
      isLocalSameOrigin: () => true,
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) => next(),
      resolvedPortRef: { current: 0 },
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: code, message }),
      sendLiveArtifactRouteError: () => undefined,
      sendMulterError: () => undefined,
    },
    paths: routePaths(workRoot),
    resources: {
      listAllDesignSystems: listUserSystems,
      resolveWorkspaceScope: async () => 'workspace-a',
      listAllSkills: async () => [],
      listAllDesignTemplates: async () => [],
      listAllSkillLikeEntries: async () => [],
      mimeFor: () => 'application/octet-stream',
    },
  } as never);
  registerDesignSystemRoutes(app, {
    db,
    paths: { CRAFT_DIR: '', USER_DESIGN_SYSTEMS_DIR: userDir } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    verifyWorkspaceRequestAuthority,
    workspaceResources: { getWorkspaceResource, getWorkspaceResourceByResourceId },
    designSystems: {
      buildUserDesignSystemArchive: async () => null,
      canMutateUserDesignSystem: async () => true,
      createUserDesignSystem: async () => { throw new Error('not used'); },
      deleteUserDesignSystem: async () => false,
      // Reaches the real metadata write the workspace project route performs.
      ensureUserDesignSystemWorkspaceProject: async (_db: unknown, id: string) => {
        const linked = await linkUserDesignSystemProject(userDir, id, `ds-${KIT}`);
        return linked ? { project: { id: `ds-${KIT}` }, designSystem: linked } : null;
      },
      listAllDesignSystems: listUserSystems,
      listUserDesignSystemFiles,
      listUserDesignSystemRevisions: async () => null,
      prepareDesignTokenContractRebuild: async () => ({ decision: { available: false } }) as never,
      readAvailableDesignSystem: async () => null,
      readAvailableDesignSystemPackageInfo: async () => null,
      readAvailableDesignSystemStaticFile: async () => null,
      readDesignSystemWorkspaceTextFile: async () => null,
      readUserDesignSystemFile,
      renderDesignSystemPreview: () => '<!doctype html>',
      renderDesignSystemShowcase: () => '<!doctype html>',
      // Reaches the real canonical asset write the sync route performs.
      syncUserDesignSystemAssetsFromWorkspace: async (_db: unknown, id: string) => {
        const result = await syncUserDesignSystemAssetsFromFiles(userDir, id, [
          { path: 'assets/probe.svg', content: Buffer.from('<svg/>') },
        ]);
        return { ok: true, synced: result.synced };
      },
      unshareTeamDesignSystemIfShared: async () => false,
      updateUserDesignSystem,
      updateUserDesignSystemRevisionStatus,
    },
    generationJobs: {
      get: () => null,
      rebuildTokenContract: () => ({}) as never,
      revise: () => ({}) as never,
      start: () => ({}) as never,
    },
  } as never);
  return listen(app);
}

describe('local design-system install never writes into the source kit', () => {
  it('keeps the source tree byte-identical through install, claim, status PATCH, link, listing and revision', async () => {
    const before = await treeDigest(source);
    const baseUrl = await startDaemonRoutes();

    const installed = await fetch(`${baseUrl}/api/design-systems/install`, {
      method: 'POST',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'local', path: source }),
    });
    expect(installed.status).toBe(200);
    const installedBody = await installed.json() as { designSystem: { id: string; workspaceId?: string } };
    expect(installedBody.designSystem).toMatchObject({ id: `user:${KIT}`, workspaceId: 'workspace-a' });

    // The Design Systems tab Publish toggle: a status-only PATCH from the
    // Workspace that claimed the kit resolves the personal user root.
    const patched = await fetch(`${baseUrl}/api/design-systems/user:${KIT}`, {
      method: 'PATCH',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({ status: 'published' });

    await linkUserDesignSystemProject(userDir, `user:${KIT}`, `ds-${KIT}`);
    await listUserDesignSystemFiles(userDir, `user:${KIT}`);
    await createUserDesignSystemRevision(userDir, `user:${KIT}`, {
      feedback: 'Tighten spacing.',
      baseBody: DESIGN_MD,
      proposedBody: `${DESIGN_MD}\nTighter.\n`,
    });

    const after = await treeDigest(source);
    expect(after.files).toEqual(before.files);
    expect(after.sha256).toBe(before.sha256);

    // Install-owned state lives in the installed entry under the managed root.
    const entry = path.join(userDir, KIT);
    expect((await lstat(entry)).isSymbolicLink()).toBe(false);
    expect((await lstat(entry)).isDirectory()).toBe(true);
    const metadata = JSON.parse(await readFile(path.join(entry, 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({
      status: 'published',
      workspaceId: 'workspace-a',
      projectId: `ds-${KIT}`,
    });
    // The kit's own files were materialised verbatim, bracketed names included.
    await expect(readFile(path.join(entry, 'fonts', 'Face[wght].ttf'), 'utf8')).resolves.toBe('font-bytes');
    await expect(readFile(path.join(entry, 'DESIGN.md'), 'utf8')).resolves.toBe(DESIGN_MD);
  });

  it('starts a fresh install with its own bookkeeping, ignoring metadata.json, revisions/ and the generated manifest in the source', async () => {
    await writeTree(source, {
      'metadata.json': `${JSON.stringify({
        teamSynced: true,
        workspaceId: 'workspace-other',
        status: 'published',
        projectId: 'ds-somebody-else',
        artifactMode: 'agent-managed',
      })}\n`,
      'revisions/stale.json': '{"id":"stale"}\n',
      '.od-generated.json': '{"README.md":"0000"}\n',
    });
    const before = await treeDigest(source);
    const baseUrl = await startDaemonRoutes();

    const installed = await fetch(`${baseUrl}/api/design-systems/install`, {
      method: 'POST',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'local', path: source }),
    });

    expect(installed.status).toBe(200);
    const { designSystem, selectability } = await installed.json() as {
      designSystem: Record<string, unknown>;
      selectability: Record<string, unknown>;
    };
    expect(designSystem).toMatchObject({ id: `user:${KIT}`, workspaceId: 'workspace-a', status: 'draft' });
    // Installation never imports the source's approval. The new local
    // revision must be inspected and approved before generation.
    expect(selectability).toMatchObject({
      selectable: false,
      reason: 'unreviewed',
      approveCommand: `od design-system approve user:${KIT}`,
      publishCommand: `od design-system approve user:${KIT}`,
    });
    expect(designSystem.teamSynced).toBeUndefined();
    expect(designSystem.projectId).toBeUndefined();
    await expect(isTeamSyncedUserDesignSystem(userDir, `user:${KIT}`)).resolves.toBe(false);
    const entry = path.join(userDir, KIT);
    const metadata = JSON.parse(await readFile(path.join(entry, 'metadata.json'), 'utf8'));
    expect(metadata).not.toHaveProperty('teamSynced');
    expect(metadata).not.toHaveProperty('projectId');
    expect(metadata).not.toHaveProperty('artifactMode');
    expect(metadata).toMatchObject({ workspaceId: 'workspace-a' });
    await expect(lstat(path.join(entry, 'revisions'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(path.join(entry, '.od-generated.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await treeDigest(source)).toEqual(before);
  });

  it('refuses a source kit with a hard-linked file', async () => {
    await link(path.join(source, 'tokens.css'), path.join(source, 'tokens-alias.css'));

    const result = await installFromTarget({ source: 'local', path: source }, userDir, 'design-system');

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/hard link/i) });
    expect(await readdir(userDir)).toEqual([]);
  });

  it('refuses a source kit that contains a symbolic link and leaves no entry behind', async () => {
    const outside = path.join(workRoot, 'outside-secret.txt');
    await writeFile(outside, 'secret', 'utf8');
    await symlink(outside, path.join(source, 'linked.txt'));
    const before = await treeDigest(source);

    const result = await installFromTarget({ source: 'local', path: source }, userDir, 'design-system');

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/symbolic link/i) });
    expect(await readdir(userDir)).toEqual([]);
    expect(await treeDigest(source)).toEqual(before);
  });

  it('refuses when a dangling symlink already occupies the install path and writes nothing through it', async () => {
    const elsewhere = path.join(workRoot, 'elsewhere', KIT);
    await symlink(elsewhere, path.join(userDir, KIT));

    const result = await installFromTarget({ source: 'local', path: source }, userDir, 'design-system');

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/already installed/) });
    await expect(lstat(path.join(workRoot, 'elsewhere'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect((await lstat(path.join(userDir, KIT))).isSymbolicLink()).toBe(true);
  });

  it('refuses a kit over the copy budget and cleans up the partial copy', async () => {
    const result = await installFromTarget(
      { source: 'local', path: source },
      userDir,
      'design-system',
      { copyBudget: { maxEntries: 3, maxBytes: 1024 * 1024, maxDepth: 16 } },
    );

    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/too many files/i) });
    expect(await readdir(userDir)).toEqual([]);
  });

  it('refuses to install the managed root itself or a folder that contains it', async () => {
    await writeFile(path.join(workRoot, 'data', 'DESIGN.md'), '# Data\n', 'utf8');
    const result = await installFromTarget(
      { source: 'local', path: path.join(workRoot, 'data') },
      userDir,
      'design-system',
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/managed design-system directory/i) });
    expect(await readdir(userDir)).toEqual([]);
  });
});

describe('a design system installed by symlink before this fix', () => {
  it('stays readable, and its first write moves install-owned state out of the source', async () => {
    // Pre-fix layout: the entry is a symlink to the source, and an earlier
    // daemon write already left metadata.json (the Workspace claim) inside it.
    await writeFile(
      path.join(source, 'metadata.json'),
      `${JSON.stringify({ workspaceId: 'workspace-a', status: 'draft' }, null, 2)}\n`,
      'utf8',
    );
    await symlink(source, path.join(userDir, KIT));
    const before = await treeDigest(source);

    // Reads keep following the legacy link: the claim and status still apply.
    const listed = await listDesignSystems(userDir, {
      idPrefix: 'user:',
      source: 'user',
      isEditable: true,
      workspaceId: 'workspace-a',
    });
    expect(listed.find((system) => system.id === `user:${KIT}`)).toMatchObject({
      workspaceId: 'workspace-a',
      status: 'draft',
    });

    const updated = await updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' });
    expect(updated).toMatchObject({ status: 'published', workspaceId: 'workspace-a' });

    expect(await treeDigest(source)).toEqual(before);
    const entry = path.join(userDir, KIT);
    expect((await lstat(entry)).isSymbolicLink()).toBe(false);
    const metadata = JSON.parse(await readFile(path.join(entry, 'metadata.json'), 'utf8'));
    expect(metadata).toMatchObject({ workspaceId: 'workspace-a', status: 'published' });
    expect((await readdir(userDir)).sort()).toEqual([KIT]);
  });

  it('refuses a write through a dangling legacy link instead of recreating the source', async () => {
    const gone = path.join(workRoot, 'gone', KIT);
    await symlink(gone, path.join(userDir, KIT));

    await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
      .resolves.toBeNull();
    await expect(lstat(path.join(workRoot, 'gone'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('a legacy symlinked install whose source cannot be copied safely', () => {
  async function seedRefusedLegacyKit(): Promise<void> {
    await symlink(path.join(workRoot, 'outside.txt'), path.join(source, 'linked.txt'));
    await symlink(source, path.join(userDir, KIT));
  }

  it('maps the refusal to 422 KIT_MATERIALIZE_REFUSED on every write route and writes nothing into the source', async () => {
    await writeFile(path.join(workRoot, 'outside.txt'), 'outside', 'utf8');
    await seedRefusedLegacyKit();
    const before = await treeDigest(source);
    const baseUrl = await startDaemonRoutes();
    const routes: Array<[string, string, Record<string, unknown>]> = [
      ['PATCH', `/api/design-systems/user:${KIT}`, { status: 'published' }],
      ['PATCH', `/api/design-systems/user:${KIT}/revisions/any-revision`, { status: 'accepted' }],
      ['POST', `/api/design-systems/user:${KIT}/workspace`, {}],
      ['POST', `/api/design-systems/user:${KIT}/sync-assets`, {}],
    ];

    for (const [method, url, body] of routes) {
      const response = await fetch(`${baseUrl}${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect({ method, url, status: response.status }).toEqual({ method, url, status: 422 });
      const refusal = await response.json();
      expect(refusal).toMatchObject({
        error: 'KIT_MATERIALIZE_REFUSED',
        reason: 'SYMLINK',
        message: expect.stringMatching(/reinstall .*clean folder/i),
      });
      // The typed shape, not a stringified error carrying the class name.
      expect(JSON.stringify(refusal)).not.toContain('KitMaterializeError');
    }
    expect(await treeDigest(source)).toEqual(before);
    expect((await lstat(path.join(userDir, KIT))).isSymbolicLink()).toBe(true);
  });

  it('remembers the refusal, logs it once, and retries after the source changes', async () => {
    await writeFile(path.join(workRoot, 'outside.txt'), 'outside', 'utf8');
    await seedRefusedLegacyKit();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .rejects.toMatchObject({ code: 'SYMLINK' });
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .rejects.toMatchObject({ code: 'SYMLINK' });
      // Read paths skip the conversion while it is refused and still serve the link.
      const files = await listUserDesignSystemFiles(userDir, `user:${KIT}`);
      expect(files?.map((file) => file.path)).toContain('DESIGN.md');
      const refusalLogs = warn.mock.calls.filter((call) => String(call[0]).includes(KIT));
      expect(refusalLogs).toHaveLength(1);

      // The user removes the link from the kit: the next write converts it.
      await rm(path.join(source, 'linked.txt'));
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .resolves.toMatchObject({ status: 'published' });
      expect((await lstat(path.join(userDir, KIT))).isSymbolicLink()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  // The remembered refusal must not outlive a repair made below the kit root:
  // removing a nested file or truncating one changes neither the kit root's
  // identity nor its mtime.
  it('retries after a symbolic link is removed from a nested folder', async () => {
    await writeFile(path.join(workRoot, 'outside.txt'), 'outside', 'utf8');
    await symlink(path.join(workRoot, 'outside.txt'), path.join(source, 'system', 'linked.txt'));
    await symlink(source, path.join(userDir, KIT));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .rejects.toMatchObject({ code: 'SYMLINK' });
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .rejects.toMatchObject({ code: 'SYMLINK' });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes(KIT))).toHaveLength(1);

      await rm(path.join(source, 'system', 'linked.txt'));
      await expect(updateUserDesignSystem(userDir, `user:${KIT}`, { status: 'published' }))
        .resolves.toMatchObject({ status: 'published' });
      expect((await lstat(path.join(userDir, KIT))).isSymbolicLink()).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('retries after an oversized file is truncated', async () => {
    const budget = { ...DEFAULT_KIT_COPY_BUDGET, maxBytes: 4096 };
    await writeFile(path.join(source, 'system', 'kit.html'), 'x'.repeat(8192), 'utf8');
    await symlink(source, path.join(userDir, KIT));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(materializeLinkedEntryForWrite(userDir, KIT, budget)).rejects.toMatchObject({ code: 'BUDGET' });
      await expect(materializeLinkedEntryForWrite(userDir, KIT, budget)).rejects.toMatchObject({ code: 'BUDGET' });
      expect(warn.mock.calls.filter((call) => String(call[0]).includes(KIT))).toHaveLength(1);

      await writeFile(path.join(source, 'system', 'kit.html'), '<main>kit</main>\n', 'utf8');
      await expect(materializeLinkedEntryForWrite(userDir, KIT, budget)).resolves.toBe('materialized');
      expect(await readFile(path.join(userDir, KIT, 'system', 'kit.html'), 'utf8')).toBe('<main>kit</main>\n');
    } finally {
      warn.mockRestore();
    }
  });

  it('does not stop the startup workspace backfill for later design systems', async () => {
    await writeFile(path.join(workRoot, 'outside.txt'), 'outside', 'utf8');
    // `aaa-` sorts first: an ownerless legacy kit whose claim must be written.
    const badSource = path.join(sourceRoot, 'aaa-legacy');
    await writeTree(badSource, {
      'DESIGN.md': '# AAA\n',
      'metadata.json': `${JSON.stringify({ projectId: 'project-a' })}\n`,
    });
    await symlink(path.join(workRoot, 'outside.txt'), path.join(badSource, 'linked.txt'));
    await symlink(badSource, path.join(userDir, 'aaa-legacy'));
    await writeTree(path.join(userDir, 'zzz-claimed'), {
      'DESIGN.md': '# ZZZ\n',
      'metadata.json': `${JSON.stringify({ workspaceId: 'workspace-a' })}\n`,
    });
    const db = openDatabase(workRoot, { dataDir: workRoot });
    db.prepare('INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run('project-a', 'Project A', 1, 1);
    ensureWorkspaceProject(db, {
      workspaceId: 'workspace-a',
      projectId: 'project-a',
      visibility: 'personal',
      resourceState: 'active',
      createdByWorkspaceMemberId: 'member-a',
      updatedByWorkspaceMemberId: 'member-a',
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(backfillDesignSystemWorkspaceResources(db, userDir)).resolves.toBe(1);
      // The skipped kit is named by its design-system id in the log.
      expect(warn.mock.calls.some((call) => call.map(String).join(' ').includes('user:aaa-legacy')))
        .toBe(true);
    } finally {
      warn.mockRestore();
    }
    expect(getWorkspaceResourceByResourceId(db, 'design_system', 'user:zzz-claimed'))
      .toMatchObject({ workspaceId: 'workspace-a' });
  });
});

describe('startup cleanup of the install staging area', () => {
  it('restores a link set aside by an interrupted conversion and removes stale staging copies', async () => {
    const staging = path.join(userDir, '.od-install-staging');
    await mkdir(path.join(staging, 'stale-copy'), { recursive: true });
    await writeFile(path.join(staging, 'stale-copy', 'DESIGN.md'), '# stale\n', 'utf8');
    await symlink(source, path.join(staging, `${KIT}.0b7a1c2e.link`));
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(path.join(staging, 'stale-copy'), old, old);

    await cleanupInstallStaging(userDir);

    expect((await lstat(path.join(userDir, KIT))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(userDir, KIT))).toBe(source);
    await expect(lstat(staging)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readdir(userDir)).toEqual([KIT]);
  });
});
