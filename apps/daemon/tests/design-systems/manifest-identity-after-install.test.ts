// Atlas Digest pilot (G3): a kit's manifest.json declares its catalog name and
// category, and the DESIGN.md H1 / `> Category:` line are only the fallback for
// DESIGN.md-only systems. The catalog listing already honoured that order, but
// every write that re-stamps metadata.json (the Publish toggle's status-only
// PATCH, an accepted revision) filled `title`/`category` from the DESIGN.md
// heading. Because metadata.json outranks the manifest in the listing, the
// first Publish after install silently replaced the manifest name with the
// heading — the pilot had to keep the two strings identical by hand.
//
// Invariant pinned here: after install and Publish, the catalog shows the
// manifest's name and category — over HTTP and through `od design-systems list`.

import express from 'express';
import type http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  getWorkspaceResource,
  getWorkspaceResourceByResourceId,
  openDatabase,
} from '../../src/db.js';
import { workspaceContextFromDirectoryItem } from '../../src/collab/vela-workspace-context.js';
import {
  listDesignSystems,
  listUserDesignSystemFiles,
  readUserDesignSystemFile,
  updateUserDesignSystem,
  updateUserDesignSystemRevisionStatus,
} from '../../src/design-systems/index.js';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';
import { registerStaticResourceRoutes } from '../../src/routes/static-resource.js';

const daemonRoot = fileURLToPath(new URL('../..', import.meta.url));
const cliEntry = fileURLToPath(new URL('../../src/cli.ts', import.meta.url));

const KIT = 'atlas-manifest-kit';
const MANIFEST_NAME = 'Atlas · Manifest Name (reference rebuild)';
const MANIFEST_CATEGORY = 'Atlas reference';
const DESIGN_MD = [
  '# Heading Title From DESIGN.md',
  '> Category: Heading Category',
  '> Surface: web',
  '',
  'A kit whose manifest name differs from its DESIGN.md heading.',
  '',
].join('\n');

let server: http.Server | null = null;
let workRoot = '';
let source = '';
let userDir = '';

beforeEach(async () => {
  workRoot = await mkdtemp(path.join(os.tmpdir(), 'od-ds-manifest-identity-'));
  source = path.join(workRoot, 'kit-sources', KIT);
  userDir = path.join(workRoot, 'data', 'design-systems');
  await mkdir(userDir, { recursive: true });
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, 'DESIGN.md'), DESIGN_MD, 'utf8');
  await writeFile(path.join(source, 'tokens.css'), ':root { --ink: #111; }\n', 'utf8');
  await writeFile(path.join(source, 'manifest.json'), `${JSON.stringify({
    schemaVersion: 'od-design-system-project/v1',
    id: KIT,
    name: MANIFEST_NAME,
    category: MANIFEST_CATEGORY,
    description: 'Private reference kit.',
    files: { design: 'DESIGN.md', tokens: 'tokens.css' },
  }, null, 2)}\n`, 'utf8');
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

function workspaceHeaders(): Record<string, string> {
  return {
    'x-od-workspace-id': 'workspace-a',
    'x-od-workspace-member-id': 'member-a',
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

/** The real install, catalog and PATCH routes on one app. */
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
      ensureUserDesignSystemWorkspaceProject: async () => null,
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
      syncUserDesignSystemAssetsFromWorkspace: async () => ({ ok: true, synced: [] }),
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

function runCli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', cliEntry, ...args], {
      cwd: daemonRoot,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

type CatalogRow = { id: string; title: string; category: string; status?: string };

describe('installed kit keeps its manifest identity in the catalog', () => {
  it('shows the manifest name and category after install and Publish, over HTTP and od', async () => {
    const baseUrl = await startDaemonRoutes();

    const installed = await fetch(`${baseUrl}/api/design-systems/install`, {
      method: 'POST',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'local', path: source }),
    });
    expect(installed.status).toBe(200);
    const installedBody = await installed.json() as { designSystem: CatalogRow };
    expect(installedBody.designSystem).toMatchObject({
      id: `user:${KIT}`,
      title: MANIFEST_NAME,
      category: MANIFEST_CATEGORY,
    });

    // The Design Systems tab Publish toggle: a status-only PATCH.
    const patched = await fetch(`${baseUrl}/api/design-systems/user:${KIT}`, {
      method: 'PATCH',
      headers: { ...workspaceHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'published' }),
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      status: 'published',
      title: MANIFEST_NAME,
      category: MANIFEST_CATEGORY,
    });

    const catalog = await fetch(`${baseUrl}/api/design-systems`, { headers: workspaceHeaders() });
    expect(catalog.status).toBe(200);
    const catalogBody = await catalog.json() as { designSystems: CatalogRow[] };
    expect(catalogBody.designSystems.find((row) => row.id === `user:${KIT}`)).toMatchObject({
      title: MANIFEST_NAME,
      category: MANIFEST_CATEGORY,
      status: 'published',
    });

    const flags = ['--daemon-url', baseUrl, '--workspace', 'workspace-a', '--workspace-member', 'member-a'];
    const json = await runCli(['design-systems', 'list', '--json', ...flags]);
    expect(json.code, json.stderr).toBe(0);
    const listed = JSON.parse(json.stdout) as { designSystems: CatalogRow[] };
    expect(listed.designSystems.find((row) => row.id === `user:${KIT}`)).toMatchObject({
      title: MANIFEST_NAME,
      category: MANIFEST_CATEGORY,
    });
    const text = await runCli(['design-systems', 'list', ...flags]);
    expect(text.code, text.stderr).toBe(0);
    expect(text.stdout).toContain(`user:${KIT}\t${MANIFEST_NAME}`);

    // The installed DESIGN.md is untouched: the manifest owns the catalog
    // identity, the kit's own heading stays as authored.
    await expect(readFile(path.join(userDir, KIT, 'DESIGN.md'), 'utf8')).resolves.toBe(DESIGN_MD);
  }, 60_000);
});
