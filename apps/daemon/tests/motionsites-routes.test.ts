import { mcpEndpointFingerprint } from '../src/mcp-endpoint.js';
// Route coverage for GET /api/motionsites/{connection,catalog,starting-points} (design doc §1,
// §4). Follows the same bare-Express harness as tests/genui-catalog-routes.test.ts. No real
// network for the catalog merge — /catalog's federated half goes through the local-corpus source
// only in these tests (no stored token), so no MotionSites MCP call happens at all; the bridge's
// own MCP wire behavior is covered by motionsites-mcp-client.test.ts and motionsites-bridge.test.ts.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { MotionSitesCatalogResponse, MotionSitesConnectionStatusDto, MotionSitesStartingPointsResponse } from '@mish/contracts/api/motionsites';
import { sendApiError } from '../src/http/api-errors.js';
import { registerMotionSitesRoutes } from '../src/routes/motionsites.js';
import { setToken } from '../src/mcp-tokens.js';
import { MOTIONSITES_MCP_SERVER_ID, MOTIONSITES_MCP_URL } from '../src/motionsites/config.js';
import { resetLocalCorpusCache } from '../src/motionsites/local-corpus-source.js';
import type { LocalCorpusRow } from '@mish/section-catalog/local-corpus';

const ZEROSUM_ROW: LocalCorpusRow = {
  id: 'zs-route-fixture-01',
  our_title: 'Fixture Route Hero',
  title: 'Route Hero',
  category: 'Local Presence',
  type: null,
  kind: 'section',
  slot: 'hero',
  use_case: 'local-presence',
  niche: 'generic',
  vertical: 'local-services',
  action: 'contact',
  motion_level: 'micro',
  requires_motion_review: 0,
  risk_reasons: null,
  image_preview_url: null,
  video_preview_url: null,
  source_url: null,
  origin: 'zerosum',
  status: 'rewritten',
  our_text: 'Fixture-only route-test prompt text, invented for this test.',
};

let server: http.Server;
let baseUrl: string;
let dataDir: string;

beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'od-motionsites-routes-'));
  resetLocalCorpusCache([ZEROSUM_ROW]);

  const app = express();
  registerMotionSitesRoutes(app, {
    http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } } as any,
    paths: { RUNTIME_DATA_DIR: dataDir } as any,
  });
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  resetLocalCorpusCache(null);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
});

describe('GET /api/motionsites/connection', () => {
  it('reports not_connected with no stored token', async () => {
    const resp = await fetch(`${baseUrl}/api/motionsites/connection`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as MotionSitesConnectionStatusDto;
    expect(body).toEqual({ status: 'not_connected' });
  });

  it('reports connected once a token is stored', async () => {
    await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
    const resp = await fetch(`${baseUrl}/api/motionsites/connection`);
    const body = (await resp.json()) as MotionSitesConnectionStatusDto;
    expect(body.status).toBe('connected');
  });
});

describe('GET /api/motionsites/catalog', () => {
  it('never errors when signed out — returns the local-corpus entries, connection not_connected, no upstream field', async () => {
    const resp = await fetch(`${baseUrl}/api/motionsites/catalog`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as MotionSitesCatalogResponse;
    expect(body.catalog.schema).toBe('section-catalog/1');
    expect(body.catalog.entries).toHaveLength(1);
    expect(body.catalog.entries[0]!.sourceKind).toBe('local-corpus');
    expect(body.connection).toBe('not_connected');
    expect('upstream' in body).toBe(false);
  });

  it('reports connection "connected" once a token is stored', async () => {
    await setToken(dataDir, MOTIONSITES_MCP_SERVER_ID, { endpointFingerprint: mcpEndpointFingerprint(MOTIONSITES_MCP_URL), accessToken: 'tok', tokenType: 'Bearer', savedAt: Date.now() });
    const body = (await (await fetch(`${baseUrl}/api/motionsites/catalog`)).json()) as MotionSitesCatalogResponse;
    expect(body.connection).toBe('connected');
  });

  it('never carries a prompt body in the response', async () => {
    const text = await (await fetch(`${baseUrl}/api/motionsites/catalog`)).text();
    expect(text).not.toContain(ZEROSUM_ROW.our_text);
  });

  it('ignores an unrecognized kind/access query param rather than erroring', async () => {
    const resp = await fetch(`${baseUrl}/api/motionsites/catalog?kind=not-a-real-kind&access=whatever`);
    expect(resp.status).toBe(200);
  });
});

// The route's `upstream`-surfacing behavior itself (FIX 3: a transport failure degrades to
// local-only but is not swallowed) is exercised at the `fetchMotionSitesCatalogEntries` unit level
// in motionsites-bridge.test.ts, which can inject a `fetchImpl` — this route registrar has no
// fetch-injection seam of its own (it only forwards `RUNTIME_DATA_DIR`), so a route-level
// transport-failure test would need a real unreachable MotionSites endpoint rather than a fake.

describe('GET /api/motionsites/starting-points', () => {
  it('returns exactly the 40 paid live templates, as text cards + deep links only', async () => {
    const resp = await fetch(`${baseUrl}/api/motionsites/starting-points`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as MotionSitesStartingPointsResponse;
    expect(body.startingPoints).toHaveLength(40);
    for (const point of body.startingPoints) {
      expect(Object.keys(point).every((key) => ['id', 'title', 'category', 'spineAffinity', 'url'].includes(key))).toBe(true);
      expect(point.url).toMatch(/^https:\/\/motionsites\.ai\/templates#/);
      expect(typeof point.id).toBe('string');
      expect(typeof point.title).toBe('string');
    }
  });

  it('carries no image, remix-target, or GitHub-repo fields anywhere in the payload', async () => {
    const text = await (await fetch(`${baseUrl}/api/motionsites/starting-points`)).text();
    for (const forbidden of ['image_url', 'imageUrl', 'preview_url', 'previewUrl', 'github', 'lovable', 'bolt', 'remix']) {
      expect(text.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('has unique ids', async () => {
    const body = (await (await fetch(`${baseUrl}/api/motionsites/starting-points`)).json()) as MotionSitesStartingPointsResponse;
    const ids = body.startingPoints.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('MotionSites routes on the booted daemon', () => {
  let bootedServer: http.Server;
  let bootedUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
    const { startServer } = await import('../src/server.js');
    const started = (await startServer({ port: 0, returnServer: true })) as {
      url: string;
      server: http.Server;
      shutdown?: () => Promise<void> | void;
    };
    bootedUrl = started.url;
    bootedServer = started.server;
    shutdown = started.shutdown;
  });

  afterAll(async () => {
    await Promise.resolve(shutdown?.());
    await new Promise<void>((resolve) => bootedServer.close(() => resolve()));
  });

  it('registers GET /api/motionsites/starting-points', async () => {
    const resp = await fetch(`${bootedUrl}/api/motionsites/starting-points`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as MotionSitesStartingPointsResponse;
    expect(body.startingPoints.length).toBe(40);
  });
});
