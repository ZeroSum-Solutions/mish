// Task 4 of the agency capability restoration plan
// (`docs/superpowers/plans/2026-09-13-agency-capability-restoration.md`):
// a project that references a resource the clean-slate catalog removed must
// stay readable, and each persisted-binding resolution path must answer with an
// explicit existing error/result instead of crashing, hanging, or silently
// substituting a different resource.
//
// The catalogs here are intentionally "removed on disk": none of these ids
// resolve against `plugins/_official/` on this branch. These are regression
// locks — the daemon already behaves this way, and the value is that a future
// resolver refactor or catalog change cannot regress the behavior silently.

import type http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  insertProject,
  openDatabase,
} from '../../src/db.js';
import { resolvePluginSnapshot } from '../../src/plugins/resolve-snapshot.js';
import {
  createSnapshot,
  linkSnapshotToProject,
  markSnapshotStale,
} from '../../src/plugins/snapshots.js';
import { registerProjectRoutes } from '../../src/routes/project/index.js';
import { resolveEffectiveDesignSystemSelection } from '../../src/runtimes/chat-prompt-inputs.js';

// A removed bundled scenario/example: the clean-slate catalog dropped
// `example-hyperframes`, so a historical project can still carry its id.
const REMOVED_PLUGIN_ID = 'example-hyperframes';
const REMOVED_EXAMPLE_SOURCE = '/plugins/_official/examples/hyperframes';
const REMOVED_DESIGN_SYSTEM_ID = 'removed-brand-system';
const REMOVED_SKILL_ID = 'removed-skill';
const REMOVED_SNAPSHOT_ID = 'removed-snapshot';
const APP_DEFAULT_DESIGN_SYSTEM_ID = 'app-default-brand-system';

/**
 * A project row exactly as it would persist if every binding it recorded was
 * later removed from the shipped catalog. The ids are the assertion: a read
 * must hand them back verbatim rather than swap in a surviving look-alike.
 */
const danglingProject = {
  id: 'legacy-project',
  name: 'Legacy project',
  skillId: REMOVED_SKILL_ID,
  designSystemId: REMOVED_DESIGN_SYSTEM_ID,
  appliedPluginSnapshotId: REMOVED_SNAPSHOT_ID,
  metadata: {
    kind: 'prototype',
    intent: 'hyperframes',
    exampleBinding: {
      schemaVersion: 1,
      provenance: 'example_card',
      pluginId: REMOVED_PLUGIN_ID,
      pluginSource: REMOVED_EXAMPLE_SOURCE,
      manifestSourceDigest: `sha256:${'a'.repeat(64)}`,
      boundAt: 1,
    },
  },
  createdAt: 1,
  updatedAt: 1,
};

const servers: http.Server[] = [];
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
  })));
  closeDatabase();
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, {
    recursive: true,
    force: true,
  })));
});

function noop() {}

function functionProxy(overrides: Record<string, unknown> = {}) {
  return new Proxy(overrides, {
    get(target, property) {
      return property in target ? target[property as string] : noop;
    },
  });
}

function buildDeps(input: {
  validateProjectDesignSystemId?: ReturnType<typeof vi.fn>;
  insertProject?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    db: {},
    design: { runs: { list: () => [], isTerminal: () => true } },
    http: {
      createSseResponse: noop,
      sendApiError: (
        res: express.Response,
        status: number,
        code: string,
        message: string,
      ) => res.status(status).json({ error: { code, message } }),
    },
    paths: {
      DESIGN_SYSTEMS_DIR: '',
      PROJECTS_DIR: '/tmp/od-removed-resource-projects',
      SKILLS_DIR: '',
      BRANDS_DIR: '',
      USER_DESIGN_SYSTEMS_DIR: '',
      RUNTIME_DATA_DIR: '/tmp/od-removed-resource-runtime',
    },
    projectStore: functionProxy({
      validateLinkedDirs: () => ({ dirs: [] }),
      getProject: () => danglingProject,
      insertProject: input.insertProject ?? vi.fn(),
      getWorkspaceProject: () => null,
      getWorkspaceProjectByProjectId: () => null,
      listWorkspaceProjects: () => [],
    }),
    projectFiles: functionProxy({
      listFiles: () => [],
      listTabs: () => [],
      resolveProjectDir: () => path.join('/tmp/od-removed-resource-projects', danglingProject.id),
    }),
    conversations: functionProxy({ insertConversation: vi.fn() }),
    templates: functionProxy({ listTemplates: () => [] }),
    status: functionProxy({
      listLatestProjectRunStatuses: () => new Map(),
      listProjectsAwaitingInput: () => new Set(),
      listProjects: () => [danglingProject],
      listUnboundProjects: () => [danglingProject],
      normalizeProjectDisplayStatus: (value: unknown) => value,
      composeProjectDisplayStatus: (status: unknown) => status,
    }),
    events: functionProxy({ activeProjectEventSinks: new Map() }),
    ids: { randomId: () => 'conversation-id' },
    telemetry: { reportFinalizedMessage: noop },
    appConfig: { readAppConfig: async () => ({}), writeAppConfig: noop },
    agents: {},
    validation: {
      validateProjectDesignSystemId:
        input.validateProjectDesignSystemId ?? vi.fn(async (id: string) => ({ ok: true, id })),
      validateProjectSkillId: vi.fn(async (id: string) => ({ ok: true, id })),
    },
    collabSync: functionProxy(),
    authorizeProjectRequest: vi.fn(async () => true),
  } as unknown as Parameters<typeof registerProjectRoutes>[1];
}

const buildReadDeps = () => buildDeps();

async function start(deps: Parameters<typeof registerProjectRoutes>[1]) {
  const app = express();
  app.use(express.json());
  registerProjectRoutes(app, deps);
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

describe('removed resource bindings keep a project readable', () => {
  it('returns the project detail with every dangling binding preserved verbatim', async () => {
    const baseUrl = await start(buildReadDeps());

    const response = await fetch(`${baseUrl}/api/projects/${danglingProject.id}`);
    expect(response.status).toBe(200);

    const body = await response.json() as {
      project: Record<string, unknown>;
      resolvedDir: string;
    };
    // No substitution: the removed ids survive the read untouched.
    expect(body.project.skillId).toBe(REMOVED_SKILL_ID);
    expect(body.project.designSystemId).toBe(REMOVED_DESIGN_SYSTEM_ID);
    expect(body.project.appliedPluginSnapshotId).toBe(REMOVED_SNAPSHOT_ID);
    expect(body.project.metadata).toMatchObject({
      intent: 'hyperframes',
      exampleBinding: {
        pluginId: REMOVED_PLUGIN_ID,
        pluginSource: REMOVED_EXAMPLE_SOURCE,
      },
    });
    expect(typeof body.resolvedDir).toBe('string');
  });

  it('still lists the project instead of dropping it from the catalog', async () => {
    const baseUrl = await start(buildReadDeps());

    const response = await fetch(`${baseUrl}/api/projects`);
    expect(response.status).toBe(200);

    const body = await response.json() as { projects: Array<Record<string, unknown>> };
    const listed = body.projects.find((project) => project.id === danglingProject.id);
    expect(listed).toBeDefined();
    expect(listed).toMatchObject({
      skillId: REMOVED_SKILL_ID,
      designSystemId: REMOVED_DESIGN_SYSTEM_ID,
      appliedPluginSnapshotId: REMOVED_SNAPSHOT_ID,
    });
  });
});

describe('an immutable plugin snapshot survives its bundle source', () => {
  let tempDir: string;
  let db: ReturnType<typeof openDatabase>;

  function seedProjectPinnedTo(pluginId: string): string {
    insertProject(db, {
      id: 'legacy-project',
      name: 'Legacy project',
      createdAt: 1,
      updatedAt: 1,
    });
    const snapshot = createSnapshot(db, {
      projectId: 'legacy-project',
      conversationId: null,
      runId: null,
      pluginId,
      pluginVersion: '1.0.0',
      pluginTitle: 'Removed plugin',
      pluginDescription: 'No longer shipped',
      manifestSourceDigest: 'digest-removed',
      sourceMarketplaceId: null,
      pinnedRef: null,
      taskKind: 'new-generation',
      inputs: {},
      resolvedContext: { items: [] },
      capabilitiesGranted: [],
      capabilitiesRequired: [],
      assetsStaged: [],
      connectorsRequired: [],
      connectorsResolved: [],
      mcpServers: [],
      query: '',
    });
    linkSnapshotToProject(db, snapshot.snapshotId, 'legacy-project');
    return snapshot.snapshotId;
  }

  const emptyRegistry = {
    skills: [],
    designSystems: [],
    craft: [],
    atoms: [],
    scenarios: [],
  };

  function freshDb() {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-removed-resource-'));
    temporaryRoots.push(tempDir);
    db = openDatabase(tempDir, { dataDir: tempDir });
  }

  it('reuses a pinned snapshot even though the plugin is no longer installed', () => {
    freshDb();
    // The plugin row is never written: its bundle source is gone, which is
    // exactly the post-clean-slate state for `example-hyperframes`.
    const snapshotId = seedProjectPinnedTo(REMOVED_PLUGIN_ID);

    const resolved = resolvePluginSnapshot({
      db,
      body: { appliedPluginSnapshotId: snapshotId },
      projectId: 'legacy-project',
      registry: emptyRegistry as Parameters<typeof resolvePluginSnapshot>[0]['registry'],
    });

    expect(resolved).not.toBeNull();
    expect(resolved && 'ok' in resolved && resolved.ok).toBe(true);
    if (!resolved || !('ok' in resolved) || !resolved.ok) return;
    expect(resolved.created).toBe(false);
    expect(resolved.snapshot.pluginId).toBe(REMOVED_PLUGIN_ID);
  });

  it('answers an unknown snapshot id with the existing explicit 404', () => {
    freshDb();
    insertProject(db, {
      id: 'legacy-project',
      name: 'Legacy project',
      createdAt: 1,
      updatedAt: 1,
    });

    const resolved = resolvePluginSnapshot({
      db,
      body: { appliedPluginSnapshotId: REMOVED_SNAPSHOT_ID },
      projectId: 'legacy-project',
      registry: emptyRegistry as Parameters<typeof resolvePluginSnapshot>[0]['registry'],
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 404,
      body: { error: { code: 'snapshot-not-found' } },
    });
  });

  it('answers a removed plugin id with the existing explicit 404, not a fallback', () => {
    freshDb();
    insertProject(db, {
      id: 'legacy-project',
      name: 'Legacy project',
      createdAt: 1,
      updatedAt: 1,
    });

    const resolved = resolvePluginSnapshot({
      db,
      body: { pluginId: REMOVED_PLUGIN_ID },
      projectId: 'legacy-project',
      registry: emptyRegistry as Parameters<typeof resolvePluginSnapshot>[0]['registry'],
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 404,
      body: { error: { code: 'plugin-not-found' } },
    });
  });

  it('answers a snapshot the doctor retired with the existing explicit 409', () => {
    freshDb();
    const snapshotId = seedProjectPinnedTo('od-removed-scenario');
    markSnapshotStale(db, snapshotId);

    const resolved = resolvePluginSnapshot({
      db,
      body: { appliedPluginSnapshotId: snapshotId },
      projectId: 'legacy-project',
      registry: emptyRegistry as Parameters<typeof resolvePluginSnapshot>[0]['registry'],
    });

    expect(resolved).toMatchObject({
      ok: false,
      status: 409,
      body: { error: { code: 'snapshot-stale' } },
    });
  });
});

describe('a removed design-system source is never silently substituted', () => {
  it('rejects a project create whose design system was removed with the typed error', async () => {
    const insertProject = vi.fn();
    const baseUrl = await start(buildDeps({
      insertProject,
      validateProjectDesignSystemId: vi.fn(async () => ({
        ok: false,
        code: 'DESIGN_SYSTEM_NOT_FOUND',
        message: 'design system not found',
      })),
    }));

    const response = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        id: 'removed-ds-project',
        name: 'Removed DS project',
        designSystemId: REMOVED_DESIGN_SYSTEM_ID,
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'DESIGN_SYSTEM_NOT_FOUND', message: 'design system not found' },
    });
    // The removed binding is refused outright — never dropped and replaced by
    // the app default, and never persisted as a dangling project row.
    expect(insertProject).not.toHaveBeenCalled();
  });

  it('lets a project-named design system outrank the app default', () => {
    // The run-start resolver reads the project's persisted id first. A removed
    // id is therefore answered as-is and later resolves to no design system —
    // it never becomes the app default brand behind the user's back.
    const selection = resolveEffectiveDesignSystemSelection({
      requestDesignSystemId: null,
      pluginDesignSystemId: null,
      projectDesignSystemId: REMOVED_DESIGN_SYSTEM_ID,
      appDefaultDesignSystemId: APP_DEFAULT_DESIGN_SYSTEM_ID,
      allowAppDefault: true,
    });

    expect(selection).toEqual({ id: REMOVED_DESIGN_SYSTEM_ID, source: 'project' });
  });

  it('keeps "no design system" for an existing project instead of applying the default', () => {
    // `server.ts` passes `allowAppDefault: project === null`, so an existing
    // project that recorded no design system stays unbound.
    const selection = resolveEffectiveDesignSystemSelection({
      requestDesignSystemId: null,
      pluginDesignSystemId: null,
      projectDesignSystemId: null,
      appDefaultDesignSystemId: APP_DEFAULT_DESIGN_SYSTEM_ID,
      allowAppDefault: false,
    });

    expect(selection).toEqual({ id: null, source: 'none' });
  });
});
