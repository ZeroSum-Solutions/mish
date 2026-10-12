// Single deletions cancel active runs (#5468); bulk deletion refuses active work.
// These tests exercise the real HTTP registrars with the real run service.

import express from 'express';
import type { Response } from 'express';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  closeDatabase,
  countWorkspaceProjectRefs,
  deleteConversation,
  deleteProject as dbDeleteProject,
  deleteWorkspaceProject,
  ensureProjectCommentAnchorConversation,
  ensureWorkspaceProject,
  getConversation,
  getProject,
  getWorkspaceProject,
  getWorkspaceProjectByProjectId,
  listWorkspaceProjects,
  rebindWorkspaceProject,
  updateWorkspaceProject,
  insertConversation,
  insertProject,
  listConversations,
  listMessages,
  openDatabase,
  updateConversation,
  updateProject,
  upsertMessage,
} from '../src/db.js';
import { createChatRunService } from '../src/runtimes/runs.js';
import {
  registerProjectRoutes,
  type RegisterProjectRoutesDeps,
} from '../src/routes/project/index.js';
import {
  registerProjectConversationRoutes,
  type RegisterProjectConversationRoutesDeps,
} from '../src/routes/project/conversations.js';

type Db = ReturnType<typeof openDatabase>;

function makeRunService() {
  return createChatRunService({
    createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
    createSseErrorPayload: (code: string, message: string) => ({ error: { code, message } }),
    shutdownGraceMs: 10,
    ttlMs: 60_000,
  });
}

async function mountConversationApp(
  db: Db,
  runs: ReturnType<typeof createChatRunService>,
  tempDir: string,
) {
  const app = express();
  app.use(express.json());
  registerProjectConversationRoutes(app, {
    db,
    http: {
      sendApiError: (res: Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
    paths: { BRANDS_DIR: tempDir, PROJECTS_DIR: tempDir, RUNTIME_DATA_DIR: tempDir },
    projectStore: { getProject, updateProject },
    conversations: {
      insertConversation,
      getConversation,
      listConversations,
      updateConversation,
      deleteConversation,
      listMessages,
      upsertMessage,
    },
    ids: { randomId: () => 'rid-' + Math.random().toString(36).slice(2) },
    appConfig: { readAppConfig: async () => ({}) },
    agents: { getAgentDef: () => null },
    design: { runs },
  } as unknown as RegisterProjectConversationRoutesDeps);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function mountProjectApp(
  db: Db,
  runs: ReturnType<typeof createChatRunService>,
  tempDir: string,
) {
  const app = express();
  app.use(express.json());
  const noop = vi.fn();
  registerProjectRoutes(app, {
    db,
    design: { runs },
    http: {
      sendApiError: (res: Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
      createSseResponse: () => ({ send: vi.fn(() => true), end: vi.fn(), cleanup: vi.fn() }),
    },
    paths: {
      BRANDS_DIR: tempDir,
      DESIGN_SYSTEMS_DIR: tempDir,
      PROJECTS_DIR: tempDir,
      RUNTIME_DATA_DIR: tempDir,
      RUNTIME_DATA_DIR_CANONICAL: tempDir,
      SKILLS_DIR: tempDir,
      USER_DESIGN_SYSTEMS_DIR: tempDir,
    },
    projectStore: {
      insertProject,
      getProject,
      updateProject,
      dbDeleteProject,
      removeProjectDir: vi.fn(async () => {}),
      stageProjectDirsForDelete: vi.fn(async () => {}),
      validateLinkedDirs: vi.fn(() => ({ dirs: [], error: null })),
      // Real db-backed workspace-project lookups: the delete route's
      // workspace mutation gate dereferences these, and a bare project with
      // no workspace row must flow through the same legacy-allow path the
      // production server takes.
      ensureWorkspaceProject,
      getWorkspaceProject,
      getWorkspaceProjectByProjectId,
      listWorkspaceProjects,
      updateWorkspaceProject,
      rebindWorkspaceProject,
      deleteWorkspaceProject,
      countWorkspaceProjectRefs,
    },
    projectFiles: {
      ensureProject: noop,
      listFiles: noop,
      listTabs: vi.fn(() => ({ tabs: [] })),
      setTabs: noop,
      readProjectFile: noop,
      writeProjectFile: noop,
      resolveProjectDir: (_projectsRoot: string, projectId: string) => path.join(tempDir, projectId),
    },
    conversations: {
      insertConversation,
      getConversation,
      listConversations,
      updateConversation,
      deleteConversation,
      listMessages,
      upsertMessage,
    },
    templates: {
      getTemplate: noop,
      listTemplates: vi.fn(() => []),
      deleteTemplate: noop,
      insertTemplate: noop,
      findTemplateByNameAndProject: noop,
      updateTemplate: noop,
    },
    status: {
      listLatestProjectRunStatuses: vi.fn(() => []),
      listProjectsAwaitingInput: vi.fn(() => new Set()),
      normalizeProjectDisplayStatus: noop,
      composeProjectDisplayStatus: noop,
      listProjects: vi.fn(() => []),
    },
    events: {
      subscribeFileEvents: noop,
      activeProjectEventSinks: new Map(),
    },
    ids: { randomId: () => 'rid-' + Math.random().toString(36).slice(2) },
    telemetry: {},
    appConfig: {
      readAppConfig: async () => ({}),
      writeAppConfig: noop,
    },
    agents: { getAgentDef: () => null },
    validation: {
      validateProjectDesignSystemId: noop,
      validateProjectSkillId: noop,
    },
  } as unknown as RegisterProjectRoutesDeps);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    base,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe('DELETE conversation cancels its active runs (#5468)', () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-5468-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'p1', name: 'Project', createdAt: now, updatedAt: now });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('terminates a still-active run owned by the deleted conversation', async () => {
    const now = Date.now();
    insertConversation(db, {
      id: 'c1',
      projectId: 'p1',
      title: null,
      sessionMode: 'design',
      createdAt: now,
      updatedAt: now,
    });

    const runs = makeRunService();
    const run = runs.create({ projectId: 'p1', conversationId: 'c1' });
    expect(runs.isTerminal(run.status)).toBe(false);

    const app = await mountConversationApp(db, runs, tempDir);
    try {
      const res = await fetch(`${app.base}/api/projects/p1/conversations/c1`, {
        method: 'DELETE',
      });
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }

    expect(run.status).toBe('canceled');
    expect(runs.list({ conversationId: 'c1', status: 'active' })).toEqual([]);
  });

  it('leaves runs owned by other conversations untouched', async () => {
    const now = Date.now();
    insertConversation(db, {
      id: 'c1',
      projectId: 'p1',
      title: null,
      sessionMode: 'design',
      createdAt: now,
      updatedAt: now,
    });
    insertConversation(db, {
      id: 'c2',
      projectId: 'p1',
      title: null,
      sessionMode: 'design',
      createdAt: now,
      updatedAt: now,
    });

    const runs = makeRunService();
    const doomed = runs.create({ projectId: 'p1', conversationId: 'c1' });
    const bystander = runs.create({ projectId: 'p1', conversationId: 'c2' });

    const app = await mountConversationApp(db, runs, tempDir);
    try {
      const res = await fetch(`${app.base}/api/projects/p1/conversations/c1`, { method: 'DELETE' });
      expect(res.status).toBe(200);
    } finally {
      await app.close();
    }

    expect(doomed.status).toBe('canceled');
    expect(bystander.status).not.toBe('canceled');
    expect(runs.list({ conversationId: 'c2', status: 'active' })).toHaveLength(1);
  });

  it('keeps the internal comment anchor out of conversation lists and route operations', async () => {
    const now = Date.now();
    insertConversation(db, {
      id: 'c1',
      projectId: 'p1',
      title: 'User chat',
      sessionMode: 'design',
      createdAt: now - 1,
      updatedAt: now - 1,
    });
    const anchor = ensureProjectCommentAnchorConversation(db, 'p1', now);
    expect(anchor?.conversationId).toMatch(/^comment-anchor-/);

    const runs = makeRunService();
    const app = await mountConversationApp(db, runs, tempDir);
    try {
      const listed = await fetch(`${app.base}/api/projects/p1/conversations`);
      expect(listed.status).toBe(200);
      await expect(listed.json()).resolves.toEqual({
        conversations: [expect.objectContaining({ id: 'c1' })],
      });

      const anchorPath = `${app.base}/api/projects/p1/conversations/${anchor!.conversationId}`;
      for (const request of [
        fetch(anchorPath, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: '{}' }),
        fetch(anchorPath, { method: 'DELETE' }),
        fetch(`${anchorPath}/messages`),
        fetch(`${anchorPath}/messages/m1`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ role: 'user', content: 'must stay internal' }),
        }),
      ]) {
        expect((await request).status).toBe(404);
      }
    } finally {
      await app.close();
    }

    expect(getConversation(db, anchor!.conversationId)).not.toBeNull();
    expect(listMessages(db, anchor!.conversationId)).toEqual([]);
  });
});

describe('DELETE project cancellation and idle-only admission', () => {
  let tempDir: string;
  let db: Db;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(os.tmpdir(), 'od-5468-project-'));
    db = openDatabase(tempDir, { dataDir: tempDir });
    const now = Date.now();
    insertProject(db, { id: 'p1', name: 'Project 1', createdAt: now, updatedAt: now });
    insertProject(db, { id: 'p2', name: 'Project 2', createdAt: now, updatedAt: now });
  });

  afterEach(() => {
    closeDatabase();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('cancels owned runs before single deletion and fences creation throughout cancellation', async () => {
    const runs = makeRunService();
    const owned = runs.create({ projectId: 'p1' });
    const bystander = runs.create({ projectId: 'p2' });
    const cancel = runs.cancel;
    const cancelSpy = vi.spyOn(runs, 'cancel').mockImplementation(async (...args) => {
      expect(getProject(db, 'p1')).toBeTruthy();
      expect(() => runs.create({ projectId: 'p1' })).toThrow('deletion is in progress');
      return cancel(...args);
    });
    const app = await mountProjectApp(db, runs, tempDir);
    try {
      expect((await fetch(`${app.base}/api/projects/p1`, { method: 'DELETE' })).status).toBe(200);
      expect(cancelSpy).toHaveBeenCalled();
      expect(owned.status).toBe('canceled');
      expect(bystander.status).not.toBe('canceled');
      expect(getProject(db, 'p1')).toBeNull();
      expect(runs.beginProjectDeletion('p1')).not.toBeNull();
    } finally { await app.close(); }
  });

  it('keeps the project and its active runs intact for ifIdle', async () => {
    const runs = makeRunService();
    const first = runs.create({ projectId: 'p1', conversationId: 'c1' });
    const second = runs.create({ projectId: 'p1', conversationId: 'c2' });
    const bystander = runs.create({ projectId: 'p2', conversationId: 'c3' });

    const app = await mountProjectApp(db, runs, tempDir);
    try {
      const res = await fetch(`${app.base}/api/projects/p1?ifIdle=1`, { method: 'DELETE' });
      expect(res.status).toBe(409);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('PROJECT_BUSY');
      expect(body.error.message).toBe(
        'Project has queued or running runs (or other active work). Wait for them to finish before deleting it.',
      );
    } finally {
      await app.close();
    }

    expect(first.status).not.toBe('canceled');
    expect(second.status).not.toBe('canceled');
    expect(bystander.status).not.toBe('canceled');
    expect(runs.list({ projectId: 'p1', status: 'active' })).toHaveLength(2);
    expect(runs.list({ projectId: 'p2', status: 'active' })).toHaveLength(1);
    expect(getProject(db, 'p1')).toBeTruthy();
  });
});
