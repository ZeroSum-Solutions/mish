import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

describe('project metadata.archived', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  beforeAll(async () => {
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
    };
    baseUrl = started.url;
    server = started.server;
  });

  afterAll(async () => {
    for (const id of projectsToClean.splice(0)) {
      await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }).catch(() => {});
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  function uniqueId(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }

  async function createProject(body: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function patchProject(id: string, patch: Record<string, unknown>) {
    return fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  }

  async function getProject(id: string) {
    const resp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
    return (await resp.json()) as { project: { metadata?: Record<string, unknown> } };
  }

  describe('POST /api/projects', () => {
    it('creates a project already archived when metadata.archived is true', async () => {
      const id = uniqueId('p');
      const resp = await createProject({
        id,
        name: 'Ladder run project',
        metadata: { kind: 'prototype', archived: true },
      });
      expect(resp.status).toBe(200);
      projectsToClean.push(id);
      const body = (await resp.json()) as { project: { metadata?: Record<string, unknown> } };
      expect(body.project.metadata?.archived).toBe(true);
      expect(body.project.metadata?.kind).toBe('prototype');
    });

    it('rejects a non-boolean metadata.archived with 400 BAD_REQUEST', async () => {
      const id = uniqueId('p');
      const resp = await createProject({
        id,
        name: 'Bad archived type',
        metadata: { kind: 'prototype', archived: 'yes' },
      });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('BAD_REQUEST');
      const getResp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
      expect(getResp.status).toBe(404);
    });
  });

  describe('PATCH /api/projects/:id', () => {
    it('toggles archived false without touching other metadata keys', async () => {
      const id = uniqueId('p');
      const created = await createProject({
        id,
        name: 'Archived toggle',
        metadata: {
          kind: 'prototype',
          intent: 'marketing',
          tags: ['ladder'],
          archived: true,
        } as Record<string, unknown>,
      });
      expect(created.status).toBe(200);
      projectsToClean.push(id);

      const resp = await patchProject(id, { metadata: { archived: false } });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { metadata?: Record<string, unknown> } };
      expect(body.project.metadata?.archived).toBe(false);
      // Unrelated keys survive the merge (the review's main risk: a patch
      // that only sends `{ archived }` must not wipe the rest of metadata).
      expect(body.project.metadata?.kind).toBe('prototype');
      expect(body.project.metadata?.intent).toBe('marketing');
      expect(body.project.metadata?.tags).toEqual(['ladder']);

      const persisted = await getProject(id);
      expect(persisted.project.metadata?.archived).toBe(false);
      expect(persisted.project.metadata?.kind).toBe('prototype');
      expect(persisted.project.metadata?.intent).toBe('marketing');
      expect(persisted.project.metadata?.tags).toEqual(['ladder']);
    });

    it('preserves other metadata keys when archiving an existing project by id alone', async () => {
      const id = uniqueId('p');
      const created = await createProject({
        id,
        name: 'Archive by id',
        metadata: { kind: 'prototype', templateLabel: 'Landing page' } as Record<string, unknown>,
      });
      expect(created.status).toBe(200);
      projectsToClean.push(id);

      const resp = await patchProject(id, { metadata: { archived: true } });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { metadata?: Record<string, unknown> } };
      expect(body.project.metadata?.archived).toBe(true);
      expect(body.project.metadata?.kind).toBe('prototype');
      expect(body.project.metadata?.templateLabel).toBe('Landing page');
    });

    it('carries archived over when a metadata patch never names the key at all', async () => {
      const id = uniqueId('p');
      const created = await createProject({
        id,
        name: 'Omitted archived key',
        metadata: {
          kind: 'prototype',
          archived: true,
          templateLabel: 'Landing page',
        } as Record<string, unknown>,
      });
      expect(created.status).toBe(200);
      projectsToClean.push(id);

      // A generic metadata patch unrelated to archiving — it never mentions
      // `archived` at all, unlike the merge tests above which send it.
      const resp = await patchProject(id, {
        metadata: { kind: 'prototype', templateLabel: 'Updated label' },
      });
      expect(resp.status).toBe(200);
      const body = (await resp.json()) as { project: { metadata?: Record<string, unknown> } };
      expect(body.project.metadata?.archived).toBe(true);
      expect(body.project.metadata?.templateLabel).toBe('Updated label');

      const persisted = await getProject(id);
      expect(persisted.project.metadata?.archived).toBe(true);
      expect(persisted.project.metadata?.templateLabel).toBe('Updated label');
    });

    it('rejects a non-boolean metadata.archived with 400 BAD_REQUEST', async () => {
      const id = uniqueId('p');
      const created = await createProject({
        id,
        name: 'Bad archived patch',
        metadata: { kind: 'prototype', archived: false },
      });
      expect(created.status).toBe(200);
      projectsToClean.push(id);

      const resp = await patchProject(id, { metadata: { archived: 'nope' } });
      expect(resp.status).toBe(400);
      const body = (await resp.json()) as { error: { code: string } };
      expect(body.error.code).toBe('BAD_REQUEST');

      const persisted = await getProject(id);
      expect(persisted.project.metadata?.archived).toBe(false);
    });
  });
});
