import type http from 'node:http';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startServer } from '../src/server.js';

// No real DNS in this suite: the Website Clone target check (D15) resolves
// through a stub (tests/helpers/web-clone-dns-stub.ts).
vi.mock('../src/web-clone-target-check.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/web-clone-target-check.js')>();
  const { stubWebCloneLookup } = await import('./helpers/web-clone-dns-stub.js');
  return {
    ...actual,
    webCloneTargetRefusal: (metadata: unknown, pendingPrompt: unknown) =>
      actual.webCloneTargetRefusal(metadata, pendingPrompt, stubWebCloneLookup),
  };
});

// POST /api/projects derives `metadata.skipDiscoveryBrief` for Website Clone
// projects whose pending prompt already carries the target URL: the URL is
// the brief for that scenario, so the turn-1 discovery question form must
// not stall the run. An explicit client-provided flag wins in both
// directions, and other intents/kinds keep the normal discovery flow.
describe('web-clone project create skips discovery when a URL is present', () => {
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

  async function createProject(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const id = `web-clone-discovery-${randomUUID()}`;
    projectsToClean.push(id);
    const resp = await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, name: 'web-clone discovery gate', ...body }),
    });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { project: { metadata: Record<string, unknown> | null } };
    return json.project.metadata ?? {};
  }

  it('sets skipDiscoveryBrief for a web-clone project whose prompt carries a URL', async () => {
    const metadata = await createProject({
      metadata: { kind: 'prototype', intent: 'web-clone' },
      pendingPrompt: '想要复刻的网站链接：https://github.com/ZeroSum-Solutions',
    });
    expect(metadata.skipDiscoveryBrief).toBe(true);
  });

  // A web-clone prompt with no URL at all is now refused before create (D15,
  // project-create-web-clone-url-refused.test.ts). A bare domain is accepted as
  // the target but is not an explicit URL, so discovery still runs for it.
  it('keeps discovery when the web-clone prompt names a bare domain', async () => {
    const metadata = await createProject({
      metadata: { kind: 'prototype', intent: 'web-clone' },
      pendingPrompt: '想要复刻的网站链接：example.com',
    });
    expect(metadata.skipDiscoveryBrief).toBeUndefined();
  });

  it('lets an explicit client skipDiscoveryBrief=false win over the derivation', async () => {
    const metadata = await createProject({
      metadata: { kind: 'prototype', intent: 'web-clone' },
      pendingPrompt: 'clone https://github.com/ZeroSum-Solutions please',
      skipDiscoveryBrief: false,
    });
    expect(metadata.skipDiscoveryBrief).toBeUndefined();
  });

  it('does not derive the skip for non-web-clone projects with URLs', async () => {
    const metadata = await createProject({
      metadata: { kind: 'prototype' },
      pendingPrompt: 'build a landing page like https://github.com/ZeroSum-Solutions',
    });
    expect(metadata.skipDiscoveryBrief).toBeUndefined();
  });
});
