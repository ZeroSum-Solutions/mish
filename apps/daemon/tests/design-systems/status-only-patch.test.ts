// Atlas Digest pilot (G2): PATCH /api/design-systems/:id with only a `status`
// (the Publish toggle) rewrote DESIGN.md. updateUserDesignSystem always ran
// `withDesignSystemHeader`, so the H1 was re-stamped from metadata.json's
// title (stale after the kit's own heading moved on) and `> Category:` /
// `> Surface:` lines were inserted into a kit that never declared them. The
// same call also backfilled the derived README/SKILL.md/preview set.
//
// Invariant: DESIGN.md changes only when the PATCH carries a field DESIGN.md
// actually holds (body, title heading, Category, Surface) with a new value.

import express from 'express';
import type http from 'node:http';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, getWorkspaceResource, getWorkspaceResourceByResourceId, openDatabase } from '../../src/db.js';
import { workspaceContextFromDirectoryItem } from '../../src/collab/vela-workspace-context.js';
import {
  listDesignSystems,
  listUserDesignSystemFiles,
  readUserDesignSystemFile,
  updateUserDesignSystem,
} from '../../src/design-systems/index.js';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';

const KIT = 'atlas-status-kit';
const DESIGN_MD = '# Atlas Kit — current heading\n\nKit body without blockquote metadata.\n';

let server: http.Server | null = null;
let workRoot = '';
let userDir = '';

beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'od-ds-status-patch-'));
  userDir = path.join(workRoot, 'design-systems');
  const kitDir = path.join(userDir, KIT);
  await mkdir(kitDir, { recursive: true });
  await writeFile(path.join(kitDir, 'DESIGN.md'), DESIGN_MD, 'utf8');
  // A title recorded at install time that the kit's heading has since moved on from.
  await writeFile(
    path.join(kitDir, 'metadata.json'),
    `${JSON.stringify({ title: 'Atlas Kit — old title', status: 'draft' }, null, 2)}\n`,
    'utf8',
  );
});

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  closeDatabase();
  if (workRoot) await rm(workRoot, { recursive: true, force: true });
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

async function startPatchRoute(role: 'owner' | 'member' = 'owner'): Promise<string> {
  const db = openDatabase(workRoot, { dataDir: workRoot });
  const app = express();
  app.use(express.json());
  const builtInDir = path.join(workRoot, 'built-ins');
  await mkdir(path.join(builtInDir, 'neutral-product'), { recursive: true });
  await writeFile(path.join(builtInDir, 'neutral-product/DESIGN.md'), '# Neutral Product');
  const listAll = async () => [...await listDesignSystems(builtInDir, { approvalReceiptRoot: path.join(userDir, '.built-in') }), ...await listDesignSystems(userDir, {
    idPrefix: 'user:',
    source: 'user',
    isEditable: true,
    defaultStatus: 'draft',
  })];
  registerDesignSystemRoutes(app, {
    db,
    paths: { CRAFT_DIR: '', DESIGN_SYSTEMS_DIR: builtInDir, USER_DESIGN_SYSTEMS_DIR: userDir } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    verifyWorkspaceRequestAuthority: async () => ({
      ok: true as const,
      context: workspaceContextFromDirectoryItem({
        workspaceId: 'workspace-a',
        workspaceName: 'Workspace A',
        workspaceType: 'team',
        workspaceMemberId: 'member-a',
        role,
        memberStatus: 'active',
        lifecycleState: 'active',
      }),
    }),
    workspaceResources: { getWorkspaceResource, getWorkspaceResourceByResourceId },
    designSystems: {
      buildUserDesignSystemArchive: async () => null,
      canMutateUserDesignSystem: async () => true,
      createUserDesignSystem: async () => { throw new Error('not used'); },
      deleteUserDesignSystem: async () => false,
      ensureUserDesignSystemWorkspaceProject: async () => null,
      listAllDesignSystems: listAll,
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
      syncUserDesignSystemAssetsFromWorkspace: async () => ({ ok: false, reason: 'not-found' }),
      unshareTeamDesignSystemIfShared: async () => false,
      updateUserDesignSystem,
      updateUserDesignSystemRevisionStatus: async () => null,
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

async function patch(baseUrl: string, body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api/design-systems/user:${KIT}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const designPath = () => path.join(userDir, KIT, 'DESIGN.md');
const metadata = async () => JSON.parse(await readFile(path.join(userDir, KIT, 'metadata.json'), 'utf8'));

describe('PATCH /api/design-systems/:id with only a status', () => {
  it('leaves DESIGN.md byte-identical and writes no derived files', async () => {
    const before = await readFile(designPath());
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { status: 'published' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: 'published' });
    await expect(readFile(designPath(), 'utf8')).resolves.toBe(DESIGN_MD);
    expect((await readFile(designPath())).equals(before)).toBe(true);
    await expect(metadata()).resolves.toMatchObject({ status: 'published' });
    expect((await readdir(path.join(userDir, KIT))).sort()).toEqual(['DESIGN.md', 'metadata.json']);
  });

  it('does not rewrite DESIGN.md when a field it carries is sent unchanged', async () => {
    const before = await readFile(designPath());
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { status: 'published', title: 'Atlas Kit — current heading' });

    expect(response.status).toBe(200);
    expect((await readFile(designPath())).equals(before)).toBe(true);
  });

  it('still rewrites only the heading on a title change', async () => {
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { title: 'Atlas Kit Renamed' });

    expect(response.status).toBe(200);
    await expect(readFile(designPath(), 'utf8')).resolves.toBe(
      '# Atlas Kit Renamed\n\nKit body without blockquote metadata.\n',
    );
    await expect(metadata()).resolves.toMatchObject({ title: 'Atlas Kit Renamed' });
  });

  it('writes the Category line only when the category changes', async () => {
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { category: 'Healthcare' });

    expect(response.status).toBe(200);
    await expect(readFile(designPath(), 'utf8')).resolves.toBe(
      '# Atlas Kit — current heading\n> Category: Healthcare\n\nKit body without blockquote metadata.\n',
    );
  });

  it('treats an empty or null title as not sent', async () => {
    const before = await readFile(designPath());
    const baseUrl = await startPatchRoute();

    for (const title of ['', '   ', null]) {
      const response = await patch(baseUrl, { title, status: 'published' });
      expect(response.status).toBe(200);
    }

    expect((await readFile(designPath())).equals(before)).toBe(true);
    await expect(metadata()).resolves.toMatchObject({ title: 'Atlas Kit — old title' });
  });

  it('treats an empty category as not sent: no DESIGN.md rewrite and no derived files', async () => {
    const before = await readFile(designPath());
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { category: '', status: 'published' });

    expect(response.status).toBe(200);
    expect((await readFile(designPath())).equals(before)).toBe(true);
    expect((await readdir(path.join(userDir, KIT))).sort()).toEqual(['DESIGN.md', 'metadata.json']);
  });

  it('does not insert Category or Surface lines when the sent value equals the current one', async () => {
    await writeFile(
      path.join(userDir, KIT, 'metadata.json'),
      `${JSON.stringify({ title: 'Atlas Kit — current heading', category: 'Healthcare', surface: 'web' })}\n`,
      'utf8',
    );
    const before = await readFile(designPath());
    const baseUrl = await startPatchRoute();

    const response = await patch(baseUrl, { category: 'Healthcare', surface: 'web' });

    expect(response.status).toBe(200);
    expect((await readFile(designPath())).equals(before)).toBe(true);
  });

  describe('with YAML frontmatter', () => {
    const FRONTMATTER = '---\nname: Atlas\n# owner: design team\n---\n';

    it('inserts a missing H1 after the frontmatter, never inside it', async () => {
      await writeFile(designPath(), `${FRONTMATTER}\nKit body.\n`, 'utf8');
      const baseUrl = await startPatchRoute();

      const response = await patch(baseUrl, { title: 'Atlas Renamed' });

      expect(response.status).toBe(200);
      await expect(readFile(designPath(), 'utf8')).resolves.toBe(
        `${FRONTMATTER}\n# Atlas Renamed\n\nKit body.\n`,
      );
    });

    it('rewrites the H1 below the frontmatter, not a YAML comment', async () => {
      await writeFile(designPath(), `${FRONTMATTER}\n# Atlas\n\nKit body.\n`, 'utf8');
      const baseUrl = await startPatchRoute();

      const response = await patch(baseUrl, { title: 'Atlas Renamed' });

      expect(response.status).toBe(200);
      await expect(readFile(designPath(), 'utf8')).resolves.toBe(
        `${FRONTMATTER}\n# Atlas Renamed\n\nKit body.\n`,
      );
    });

    it('places a new Category line after the frontmatter', async () => {
      await writeFile(designPath(), `${FRONTMATTER}\nKit body.\n`, 'utf8');
      const baseUrl = await startPatchRoute();

      const response = await patch(baseUrl, { category: 'Healthcare' });

      expect(response.status).toBe(200);
      await expect(readFile(designPath(), 'utf8')).resolves.toBe(
        `${FRONTMATTER}\n> Category: Healthcare\n\nKit body.\n`,
      );
    });
  });
});

describe('revision-bound approval HTTP surface', () => {
  it('approves the inspected revision, publishes it, lists approval, and unapproves it', async () => {
    const base = await startPatchRoute();
    const [kit] = await listDesignSystems(userDir, { idPrefix: 'user:' });
    const request = (approved: boolean, expectedRevision: string) => fetch(`${base}/api/design-systems/user:${KIT}/approval`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approved, expectedRevision }),
    });
    const response = await request(true, kit!.approval!.revision);
    expect(response.status).toBe(200);
    const body = await response.json() as { designSystem: { approval: { revision: string } } };
    expect(body.designSystem).toMatchObject({ status: 'published', approval: { status: 'approved' } });
    expect((await request(false, body.designSystem.approval.revision)).status).toBe(200);
    expect((await listDesignSystems(userDir))[0]!.approval!.status).toBe('unreviewed');
  });
  it('rejects a stale inspected revision and malformed approval payload', async () => {
    const base = await startPatchRoute();
    for (const [body, status] of [[{ approved: true, expectedRevision: '0'.repeat(64) }, 409], [{ approved: 'yes' }, 400]] as const) {
      const response = await fetch(`${base}/api/design-systems/user:${KIT}/approval`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(status);
    }
  });
});

it.each(['owner', 'member'] as const)('allows only a verified %s with management permission to change a global built-in approval', async role => {
  const baseUrl = await startPatchRoute(role);
  const { readDesignSystemApproval } = await import('../../src/design-systems/approval.js');
  const approval = await readDesignSystemApproval(path.join(workRoot, 'built-ins'), 'neutral-product', path.join(userDir, '.built-in'));
  const response = await fetch(`${baseUrl}/api/design-systems/neutral-product/approval`, { method: 'PUT', headers: { 'Content-Type': 'application/json', 'x-od-workspace-id': 'workspace-a', 'x-od-workspace-member-id': 'member-a' }, body: JSON.stringify({ approved: true, expectedRevision: approval.revision }) });
  expect(response.status).toBe(role === 'owner' ? 200 : 403);
});
