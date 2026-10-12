import express from 'express';
import type http from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { registerStaticResourceRoutes } from '../src/routes/static-resource.js';

const servers: http.Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => server.close(() => resolve())),
    ),
  );
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function context(
  workspaceId: string,
  workspaceMemberId: string,
): WorkspaceCollabContext {
  return {
    workspaceId,
    workspaceName: workspaceId,
    workspaceType: 'team',
    workspaceMemberId,
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: {
      seatLimit: 5,
      usedSeats: 1,
      availableSeats: 4,
      isSeatFull: false,
    },
    permissions: {
      canManageMembers: false,
      canManageBilling: false,
      canInviteMembers: false,
      canManageAutoRecharge: false,
      canShareProjects: true,
      canWriteSyncedFiles: true,
      canViewWorkspaceSettings: true,
      canManageSharedResources: false,
    },
  } as WorkspaceCollabContext;
}

async function fixture(hiddenAncestor = false) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'od-skill-navigation-scope-'));
  roots.push(tempRoot);
  const root = hiddenAncestor ? path.join(tempRoot, '.installation') : tempRoot;
  const entries = new Map<string, {
    id: string;
    name: string;
    description: string;
    body: string;
    dir: string;
    source: 'user';
  }>();
  for (const workspaceId of ['workspace-a', 'workspace-b']) {
    const dir = path.join(root, workspaceId);
    await mkdir(path.join(dir, 'assets'), { recursive: true });
    await writeFile(
      path.join(dir, 'example.html'),
      `<img src="./assets/secret.txt"><p>${workspaceId}</p>`,
    );
    await writeFile(path.join(dir, 'assets', 'secret.txt'), `${workspaceId}-bytes`);
    await mkdir(path.join(dir, 'assets', '.private'), { recursive: true });
    await writeFile(path.join(dir, 'assets', '.private', 'secret.txt'), 'private-nested-canary');
    await writeFile(path.join(dir, 'assets', '.secret.txt'), 'private-file-canary');
    entries.set(workspaceId, {
      id: 'same-skill',
      name: 'Same skill',
      description: workspaceId,
      body: `# ${workspaceId}`,
      dir,
      source: 'user',
    });
  }

  const app = express();
  const paths = {
    ARTIFACTS_DIR: path.join(root, 'artifacts'),
    BRANDS_DIR: path.join(root, 'brands'),
    BUNDLED_PETS_DIR: path.join(root, 'pets'),
    CRAFT_DIR: path.join(root, 'craft'),
    DESIGN_SYSTEMS_DIR: path.join(root, 'design-systems'),
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
    USER_DESIGN_SYSTEMS_DIR: path.join(root, 'user-design-systems'),
    USER_DESIGN_TEMPLATES_DIR: path.join(root, 'user-design-templates'),
    USER_SKILLS_DIR: path.join(root, 'user-skills'),
  };
  registerStaticResourceRoutes(app, {
    db: {} as never,
    verifyWorkspaceRequestAuthority: async (req: any) => {
      const workspaceId = req.get('x-od-workspace-id')?.trim();
      const workspaceMemberId = req.get('x-od-workspace-member-id')?.trim();
      if (workspaceId === 'workspace-removed') {
        return {
          ok: false,
          status: 403,
          code: 'WORKSPACE_ACCESS_DENIED',
          message: 'removed',
        };
      }
      if (workspaceId === 'workspace-outage') {
        return {
          ok: false,
          status: 503,
          code: 'WORKSPACE_AUTHORITY_UNAVAILABLE',
          message: 'outage',
          retryable: true,
        };
      }
      return {
        ok: true,
        context: context(workspaceId, workspaceMemberId),
      };
    },
    http: {
      createSseResponse: () => undefined,
      getPublicBaseUrl: () => '',
      isLocalSameOrigin: () => true,
      requireLocalDaemonRequest: (_req: unknown, _res: unknown, next: () => void) =>
        next(),
      resolvedPortRef: { current: 0 },
      sendApiError: (
        res: express.Response,
        status: number,
        code: string,
        message: string,
        options?: { retryable?: boolean },
      ) =>
        res.status(status).json({
          error: code,
          message,
          ...(options?.retryable ? { retryable: true } : {}),
        }),
      sendLiveArtifactRouteError: () => undefined,
      sendMulterError: () => undefined,
    },
    paths,
    resources: {
      listAllDesignSystems: async () => [],
      resolveWorkspaceScope: async () => null,
      listAllSkills: async () => [],
      listAllDesignTemplates: async () => [],
      listAllSkillLikeEntries: (async (
          options?: { workspaceId?: string | null },
        ) => {
          const entry = options?.workspaceId
            ? entries.get(options.workspaceId)
            : undefined;
          return entry ? [entry] : [];
        }) as never,
      mimeFor: () => 'text/plain',
    },
  });
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

describe('Skill example and asset Workspace authority', () => {
  it('serves A and B copies of the same id and carries exact scope into nested assets', async () => {
    const baseUrl = await fixture();
    const example = await fetch(
      `${baseUrl}/api/skills/same-skill/example?workspaceId=workspace-a&workspaceMemberId=member-a`,
    );

    expect(example.status).toBe(200);
    const html = await example.text();
    expect(html).toContain('workspace-a');
    expect(html).not.toContain('workspace-b');
    expect(html).toContain(
      '/api/skills/same-skill/assets/secret.txt?workspaceId=workspace-a&workspaceMemberId=member-a',
    );

    const [assetA, assetB] = await Promise.all([
      fetch(
        `${baseUrl}/api/skills/same-skill/assets/secret.txt?workspaceId=workspace-a&workspaceMemberId=member-a`,
      ),
      fetch(
        `${baseUrl}/api/skills/same-skill/assets/secret.txt?workspaceId=workspace-b&workspaceMemberId=member-b`,
      ),
    ]);
    expect(assetA.status).toBe(200);
    expect(assetB.status).toBe(200);
    expect(await assetA.text()).toBe('workspace-a-bytes');
    expect(await assetB.text()).toBe('workspace-b-bytes');
  });

  it.each([false, true])(
    'serves public assets with hidden installation ancestor=%s while refusing private relative paths',
    async (hiddenAncestor) => {
      const baseUrl = await fixture(hiddenAncestor);
      const assetUrl = `${baseUrl}/api/skills/same-skill/assets/`;
      const scope = '?workspaceId=workspace-a&workspaceMemberId=member-a';
      const publicAsset = await fetch(`${assetUrl}secret.txt${scope}`, {
        headers: { Origin: 'null' },
      });
      expect(publicAsset.status).toBe(200);
      expect(publicAsset.headers.get('content-type')).toContain('text/plain');
      expect(publicAsset.headers.get('access-control-allow-origin')).toBe('*');
      expect(await publicAsset.text()).toBe('workspace-a-bytes');

      for (const [relativePath, canary] of [
        ['.secret.txt', 'private-file-canary'],
        ['.private/secret.txt', 'private-nested-canary'],
      ]) {
        const denied = await fetch(`${assetUrl}${relativePath}${scope}`);
        expect(denied.status).toBe(404);
        expect(await denied.text()).not.toContain(canary);
      }
      const traversal = await fetch(`${assetUrl}%2e%2e%2fexample.html${scope}`);
      expect(traversal.status).toBe(400);
      expect(await traversal.text()).toBe('invalid asset path');
    },
  );

  it.each(['%2e%2f', 'nested/%2e%2e%2f'])(
    'returns not found when encoded asset path %s resolves to the resource root',
    async (relativePath) => {
      const baseUrl = await fixture(true);
      const response = await fetch(
        `${baseUrl}/api/skills/same-skill/assets/${relativePath}?workspaceId=workspace-a&workspaceMemberId=member-a`,
      );
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('asset not found');
    },
  );

  it.each(['workspace-removed', 'workspace-outage'] as const)(
    'does not consult remote authority for %s and never serves another Workspace bytes',
    async (workspaceId) => {
      const baseUrl = await fixture();
      const response = await fetch(
        `${baseUrl}/api/skills/same-skill/assets/secret.txt?workspaceId=${workspaceId}&workspaceMemberId=member-a`,
      );

      expect(response.status).toBe(404);
      expect(await response.text()).toBe('skill not found');
    },
  );

  it('rejects a partial navigation scope before resolving skill bytes', async () => {
    const baseUrl = await fixture();
    const response = await fetch(
      `${baseUrl}/api/skills/same-skill/assets/secret.txt?workspaceId=workspace-a`,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: 'WORKSPACE_CONTEXT_INCOMPLETE',
    });
  });
});
