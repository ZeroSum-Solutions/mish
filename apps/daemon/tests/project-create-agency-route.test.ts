import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startServer } from '../src/server.js';

// Home's "Jev chooses" mode stamps `metadata.agencyRoute` on the project it
// creates: which family Jev picked, off which spine and archetype, and how
// sure the router was. The web side can only prove it puts the field in the
// create payload — whether the daemon KEEPS it is this file's question, and
// the answer has to come from a real create followed by a real read-back.
describe('project create keeps the Home agency route', () => {
  let server: http.Server;
  let baseUrl: string;
  const projectsToClean: string[] = [];

  const AGENCY_ROUTE = {
    familyId: 'watson',
    spine: 'TL',
    archetype: 'TL.05',
    probability: 0.82,
  };

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

  async function createProject(metadata: Record<string, unknown>): Promise<string> {
    const id = `agency-route-${randomUUID()}`;
    projectsToClean.push(id);
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name: 'Jev chooses create',
        skillId: 'agency-site',
        pendingPrompt: 'A boutique consultancy that wants enterprise clients to trust it',
        metadata,
      }),
    });
    expect(resp.status).toBe(200);
    return id;
  }

  async function readMetadata(id: string): Promise<Record<string, unknown>> {
    const resp = await fetch(`${baseUrl}/api/projects/${encodeURIComponent(id)}`);
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as {
      project: { metadata: Record<string, unknown> | null };
    };
    return json.project.metadata ?? {};
  }

  it('returns the route on create and again on read-back', async () => {
    const id = await createProject({ kind: 'prototype', agencyRoute: AGENCY_ROUTE });
    // A create that echoed the field but dropped it on write would pass a
    // create-only assertion, so the read is the one that counts.
    expect(await readMetadata(id)).toMatchObject({ agencyRoute: AGENCY_ROUTE });
  });

  it('keeps a route whose decision named no archetype', async () => {
    // `archetype` is optional in the contract: Jev can resolve a family off the
    // spine alone, and the project must not be rejected or padded for it.
    const route = { familyId: 'maren', spine: 'CO', probability: 0.61 };
    const id = await createProject({ kind: 'prototype', agencyRoute: route });
    const metadata = await readMetadata(id);
    expect(metadata.agencyRoute).toEqual(route);
  });

  it('leaves a manually picked project with no route at all', async () => {
    // A family-card send records no route because there was none; the daemon
    // must not invent an empty one.
    const id = await createProject({ kind: 'prototype' });
    expect(await readMetadata(id)).not.toHaveProperty('agencyRoute');
  });
});
