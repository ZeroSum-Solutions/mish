// U9 (security): a claimed Workspace/member pair is a selector, never proof of
// membership. Per-kit design-system reads (and the mutations that share the
// same gate) must verify the pair against the membership directory before the
// persisted creator witness is compared, so a caller who knows a kit id and
// another member's pair cannot read that member's Personal kit.
import express from 'express';
import type http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  closeDatabase,
  ensureWorkspaceResource,
  getWorkspaceResource,
  getWorkspaceResourceByResourceId,
  openDatabase,
} from '../../src/db.js';
import { workspaceContextFromDirectoryItem } from '../../src/collab/vela-workspace-context.js';
import { registerDesignSystemRoutes } from '../../src/routes/design-systems.js';

const KIT_ID = 'user:member-a-kit';
const LOCAL_KIT_ID = 'user:local-kit';
const WORKSPACE_ID = 'workspace-a';
const OWNER_PAIR = { workspaceId: WORKSPACE_ID, workspaceMemberId: 'member-a' };

let server: http.Server | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = null;
  }
  closeDatabase();
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function listen(app: express.Express): Promise<string> {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server?.address() as { port: number };
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

type Pair = { workspaceId: string; workspaceMemberId: string };
type DirectoryRow = Pair & { memberStatus: 'active' | 'removed' };

function pairHeaders(pair: Pair): Record<string, string> {
  return {
    'x-od-workspace-id': pair.workspaceId,
    'x-od-workspace-member-id': pair.workspaceMemberId,
  };
}

function pairQuery(pair: Pair): string {
  return `workspaceId=${encodeURIComponent(pair.workspaceId)}`
    + `&workspaceMemberId=${encodeURIComponent(pair.workspaceMemberId)}`;
}

/**
 * Starts the design-system routes with a membership directory that lists
 * exactly `directory`. Anything else the caller claims is refused the way the
 * daemon's directory-backed verifier refuses it.
 */
async function startServer(
  directory: DirectoryRow[],
  options: { withReadVerifier?: boolean; cachedReadLease?: boolean } = {},
) {
  tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-ds-read-membership-'));
  const db = openDatabase(tempDir, { dataDir: tempDir });
  ensureWorkspaceResource(db, 'design_system', WORKSPACE_ID, KIT_ID, {
    visibility: 'personal',
    resourceState: 'active',
    createdByWorkspaceMemberId: OWNER_PAIR.workspaceMemberId,
  });
  const directoryVerifier = async (req: any) => {
    const workspaceId = req.get('x-od-workspace-id')?.trim() ?? '';
    const workspaceMemberId = req.get('x-od-workspace-member-id')?.trim() ?? '';
    const row = directory.find(
      (item) =>
        item.workspaceId === workspaceId
        && item.workspaceMemberId === workspaceMemberId
        && item.memberStatus === 'active',
    );
    if (!row) {
      return {
        ok: false as const,
        status: 403 as const,
        code: 'WORKSPACE_ACCESS_DENIED',
        message: 'the requested workspace is not available to this member',
      };
    }
    return {
      ok: true as const,
      context: workspaceContextFromDirectoryItem({
        workspaceId,
        workspaceName: 'Workspace A',
        workspaceType: 'team',
        workspaceMemberId,
        role: 'member',
        memberStatus: 'active',
        lifecycleState: 'active',
      }),
    };
  };
  const verifyWorkspaceRequestAuthority = vi.fn(directoryVerifier);
  // The daemon's cached display-read lease: same directory answer, separate
  // spy so a test can tell which verifier a route consulted.
  // With `cachedReadLease`, it behaves like the real lease: the first
  // success for a pair keeps answering until the lease TTL, even after the
  // directory removes the member.
  const leasedPairs = new Map<string, Awaited<ReturnType<typeof directoryVerifier>>>();
  const verifyWorkspaceReadAuthority = vi.fn(async (req: any) => {
    if (!options.cachedReadLease) return directoryVerifier(req);
    const key = `${req.get('x-od-workspace-id') ?? ''}\u0000${req.get('x-od-workspace-member-id') ?? ''}`;
    const leased = leasedPairs.get(key);
    if (leased) return leased;
    const answer = await directoryVerifier(req);
    if (answer.ok) leasedPairs.set(key, answer);
    return answer;
  });
  const jobs = new Map<string, Record<string, unknown>>();
  const calls = {
    archive: vi.fn(async () => ({
      buffer: Buffer.from('zip-bytes'),
      baseName: 'member-a-kit',
      title: 'Member A kit',
    })),
    file: vi.fn(async () => ({ path: 'DESIGN.md', body: '# secret' }) as never),
    static: vi.fn(async () => ({
      bytes: Buffer.from(':root{--secret:1}'),
      contentType: 'text/css',
      updatedAt: 'Wed, 30 Jul 2026 00:00:00 GMT',
    })),
    update: vi.fn(async () => null),
  };
  const summary = (id: string) => ({
    id,
    title: id,
    category: 'Custom',
    summary: 'kit',
    swatches: [],
    surface: 'web' as const,
    body: '# kit',
    source: 'user' as const,
    status: 'draft' as const,
    isEditable: true,
  });
  const app = express();
  app.use(express.json());
  registerDesignSystemRoutes(app, {
    db,
    paths: {
      CRAFT_DIR: path.join(tempDir, 'craft'),
      USER_DESIGN_SYSTEMS_DIR: path.join(tempDir, 'design-systems'),
    } as never,
    projectFiles: {} as never,
    projectStore: {} as never,
    verifyWorkspaceRequestAuthority,
    ...(options.withReadVerifier ? { verifyWorkspaceReadAuthority } : {}),
    workspaceResources: { getWorkspaceResource, getWorkspaceResourceByResourceId },
    designSystems: {
      buildUserDesignSystemArchive: calls.archive,
      canMutateUserDesignSystem: async () => true,
      createUserDesignSystem: async () => summary(KIT_ID),
      deleteUserDesignSystem: async () => true,
      ensureUserDesignSystemWorkspaceProject: async () => null,
      listAllDesignSystems: async () => [summary(KIT_ID), summary(LOCAL_KIT_ID)],
      listUserDesignSystemFiles: async () => [],
      listUserDesignSystemRevisions: async () => [],
      prepareDesignTokenContractRebuild: async () => ({
        decision: { available: false },
      }) as never,
      readAvailableDesignSystem: async () => '# kit',
      readAvailableDesignSystemPackageInfo: async () => null,
      readAvailableDesignSystemStaticFile: calls.static,
      readDesignSystemWorkspaceTextFile: async () => null,
      readUserDesignSystemFile: calls.file,
      renderDesignSystemPreview: () => '<html>preview</html>',
      renderDesignSystemShowcase: () => '<html>showcase</html>',
      syncUserDesignSystemAssetsFromWorkspace: async () => ({ ok: true, synced: [] }),
      unshareTeamDesignSystemIfShared: async () => false,
      updateUserDesignSystem: calls.update,
      updateUserDesignSystemRevisionStatus: async () => null,
    },
    generationJobs: {
      get: (jobId: string) => (jobs.get(jobId) ?? null) as never,
      rebuildTokenContract: () => ({}) as never,
      revise: () => ({}) as never,
      start: () => {
        const job = {
          id: `job-${jobs.size + 1}`,
          kind: 'create',
          status: 'running',
          designSystemId: null,
        };
        jobs.set(job.id, job);
        return job as never;
      },
    },
  });
  return {
    baseUrl: await listen(app),
    calls,
    verifyWorkspaceRequestAuthority,
    verifyWorkspaceReadAuthority,
  };
}

function kitUrl(baseUrl: string, id: string, suffix: string): string {
  return `${baseUrl}/api/design-systems/${encodeURIComponent(id)}${suffix}`;
}

const HEADER_READS = ['/file?path=DESIGN.md', '/archive', '/static?path=tokens.css'];
const NAVIGATION_READS = ['/static?path=tokens.css', '/showcase', '/preview'];

describe('design-system per-kit reads verify the claimed Workspace/member pair', () => {
  it('refuses a caller who claims another member\'s pair it does not hold', async () => {
    // The signed-in account is member B; its directory does not list member A.
    const { baseUrl, calls } = await startServer([
      { workspaceId: WORKSPACE_ID, workspaceMemberId: 'member-b', memberStatus: 'active' },
    ]);
    for (const suffix of HEADER_READS) {
      const response = await fetch(kitUrl(baseUrl, KIT_ID, suffix), {
        headers: pairHeaders(OWNER_PAIR),
      });
      expect(response.status, suffix).toBe(403);
      expect(await response.json(), suffix).toMatchObject({
        error: 'WORKSPACE_ACCESS_DENIED',
      });
    }
    for (const suffix of NAVIGATION_READS) {
      const separator = suffix.includes('?') ? '&' : '?';
      const response = await fetch(
        kitUrl(baseUrl, KIT_ID, `${suffix}${separator}${pairQuery(OWNER_PAIR)}`),
      );
      expect(response.status, `navigation ${suffix}`).toBe(403);
    }
    expect(calls.archive).not.toHaveBeenCalled();
    expect(calls.file).not.toHaveBeenCalled();
    expect(calls.static).not.toHaveBeenCalled();
  });

  it('refuses a removed member and a fabricated pair', async () => {
    const { baseUrl, calls } = await startServer([
      { ...OWNER_PAIR, memberStatus: 'removed' },
    ]);
    for (const pair of [
      OWNER_PAIR,
      { workspaceId: WORKSPACE_ID, workspaceMemberId: 'member-fabricated' },
    ]) {
      const response = await fetch(kitUrl(baseUrl, KIT_ID, '/archive'), {
        headers: pairHeaders(pair),
      });
      expect(response.status, pair.workspaceMemberId).toBe(403);
    }
    expect(calls.archive).not.toHaveBeenCalled();
  });

  it('refuses a mutation through a claimed pair the caller does not hold', async () => {
    const { baseUrl, calls } = await startServer([
      { workspaceId: WORKSPACE_ID, workspaceMemberId: 'member-b', memberStatus: 'active' },
    ]);
    const response = await fetch(kitUrl(baseUrl, KIT_ID, ''), {
      method: 'PATCH',
      headers: { ...pairHeaders(OWNER_PAIR), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen' }),
    });
    expect(response.status).toBe(403);
    expect(calls.update).not.toHaveBeenCalled();
  });

  it('keeps the verified owner reading through headers and navigation scope', async () => {
    const { baseUrl, calls, verifyWorkspaceRequestAuthority } = await startServer([
      { ...OWNER_PAIR, memberStatus: 'active' },
    ]);
    for (const suffix of HEADER_READS) {
      const response = await fetch(kitUrl(baseUrl, KIT_ID, suffix), {
        headers: pairHeaders(OWNER_PAIR),
      });
      expect(response.status, suffix).toBe(200);
    }
    const navigation = await fetch(
      kitUrl(baseUrl, KIT_ID, `/static?path=tokens.css&${pairQuery(OWNER_PAIR)}`),
    );
    expect(navigation.status).toBe(200);
    expect(calls.archive).toHaveBeenCalledTimes(1);
    expect(calls.file).toHaveBeenCalledTimes(1);
    expect(verifyWorkspaceRequestAuthority).toHaveBeenCalled();
  });

  it('leaves local kits without a Workspace binding readable without headers', async () => {
    const { baseUrl, calls, verifyWorkspaceRequestAuthority } = await startServer([]);
    for (const suffix of HEADER_READS) {
      const response = await fetch(kitUrl(baseUrl, LOCAL_KIT_ID, suffix));
      expect(response.status, suffix).toBe(200);
    }
    expect(calls.archive).toHaveBeenCalledTimes(1);
    expect(verifyWorkspaceRequestAuthority).not.toHaveBeenCalled();
  });

  it('refuses a removed member\'s next private kit read inside the cached lease TTL', async () => {
    const directory: DirectoryRow[] = [{ ...OWNER_PAIR, memberStatus: 'active' }];
    const { baseUrl, calls, verifyWorkspaceRequestAuthority } = await startServer(
      directory,
      { withReadVerifier: true, cachedReadLease: true },
    );
    const before = await fetch(kitUrl(baseUrl, KIT_ID, '/archive'), {
      headers: pairHeaders(OWNER_PAIR),
    });
    expect(before.status).toBe(200);

    // Vela removes member A; the cached display-read lease still holds A.
    directory.splice(0, directory.length, { ...OWNER_PAIR, memberStatus: 'removed' });
    for (const suffix of HEADER_READS) {
      const response = await fetch(kitUrl(baseUrl, KIT_ID, suffix), {
        headers: pairHeaders(OWNER_PAIR),
      });
      expect(response.status, suffix).toBe(403);
      expect(await response.json(), suffix).toMatchObject({
        error: 'WORKSPACE_ACCESS_DENIED',
      });
    }
    const navigation = await fetch(
      kitUrl(baseUrl, KIT_ID, `/showcase?${pairQuery(OWNER_PAIR)}`),
    );
    expect(navigation.status).toBe(403);
    expect(calls.archive).toHaveBeenCalledTimes(1);
    expect(calls.file).not.toHaveBeenCalled();
    expect(calls.static).not.toHaveBeenCalled();
    expect(verifyWorkspaceRequestAuthority).toHaveBeenCalled();
  });
});

describe('design-system generation-job reads verify the claimed Workspace/member pair', () => {
  it('refuses a caller who claims the creating member\'s pair it does not hold', async () => {
    // The directory is the signed-in account's membership list. Member A
    // creates the job, then the account becomes member B, who replays A's pair.
    const directory: DirectoryRow[] = [{ ...OWNER_PAIR, memberStatus: 'active' }];
    const { baseUrl } = await startServer(directory);
    const created = await fetch(`${baseUrl}/api/design-systems/generation-jobs`, {
      method: 'POST',
      headers: { ...pairHeaders(OWNER_PAIR), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Member A kit' }),
    });
    expect(created.status).toBe(202);
    const { job } = await created.json() as { job: { id: string } };
    const jobUrl = `${baseUrl}/api/design-systems/generation-jobs/${job.id}`;

    const ownerRead = await fetch(jobUrl, { headers: pairHeaders(OWNER_PAIR) });
    expect(ownerRead.status).toBe(200);

    directory.splice(0, directory.length, {
      workspaceId: WORKSPACE_ID,
      workspaceMemberId: 'member-b',
      memberStatus: 'active',
    });
    const replayed = await fetch(jobUrl, { headers: pairHeaders(OWNER_PAIR) });
    expect(replayed.status).toBe(403);
    expect(await replayed.json()).toMatchObject({ error: 'WORKSPACE_ACCESS_DENIED' });
  });

  it('refuses to start a job under a claimed pair the caller does not hold', async () => {
    const { baseUrl } = await startServer([
      { workspaceId: WORKSPACE_ID, workspaceMemberId: 'member-b', memberStatus: 'active' },
    ]);
    const response = await fetch(`${baseUrl}/api/design-systems/generation-jobs`, {
      method: 'POST',
      headers: { ...pairHeaders(OWNER_PAIR), 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Stolen attribution' }),
    });
    expect(response.status).toBe(403);
  });

  it('keeps headerless local jobs readable without consulting the directory', async () => {
    const { baseUrl, verifyWorkspaceRequestAuthority } = await startServer([]);
    const created = await fetch(`${baseUrl}/api/design-systems/generation-jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Local kit' }),
    });
    expect(created.status).toBe(202);
    const { job } = await created.json() as { job: { id: string } };
    const read = await fetch(`${baseUrl}/api/design-systems/generation-jobs/${job.id}`);
    expect(read.status).toBe(200);
    expect(verifyWorkspaceRequestAuthority).not.toHaveBeenCalled();
  });
});
