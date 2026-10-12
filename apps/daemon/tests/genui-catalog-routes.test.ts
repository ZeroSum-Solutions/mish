// Route coverage for GET /api/genui/catalog (catalog-design.md §E).
//
// `registerGenuiCatalogRoutes` is mounted on a bare Express app first, the harness of
// design-index-routes.test.ts. One boot case goes through `startServer` to prove the route is
// registered on the real daemon, not only in this harness.

import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { GenuiCatalogResponse } from '@mish/contracts';
import { genuiCatalog } from '@mish/genui-catalog/data';
import { registerGenuiCatalogRoutes } from '../src/routes/genui-catalog.js';
import { startServer } from '../src/server.js';

let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  const app = express();
  registerGenuiCatalogRoutes(app);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('GET /api/genui/catalog', () => {
  it('serves the catalog manifest from the ./data export', async () => {
    const resp = await fetch(`${baseUrl}/api/genui/catalog`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as GenuiCatalogResponse;
    expect(body.catalog.schema).toBe('genui-catalog/1');
    expect(body.catalog).toEqual(genuiCatalog.manifest);
    expect(body.catalog.components.length).toBeGreaterThan(0);
  });

  it('lists unique ids and gives every ported entry a demo', async () => {
    const body = (await (await fetch(`${baseUrl}/api/genui/catalog`)).json()) as GenuiCatalogResponse;
    const ids = body.catalog.components.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    const ported = body.catalog.components.filter((entry) => entry.status === 'ported');
    expect(ported.length).toBeGreaterThan(0);
    for (const entry of ported) expect(entry.demo, entry.id).toMatch(/^components\/[a-z0-9-]+\/demo\.html$/);
  });

  it('does not ship component source or built assets', async () => {
    const text = await (await fetch(`${baseUrl}/api/genui/catalog`)).text();
    expect(text).not.toContain('"assets"');
    expect(text).not.toMatch(/<script/i);
  });
});

describe('GET /api/genui/catalog on the booted daemon', () => {
  let bootedServer: http.Server | undefined;
  let bootedUrl: string;
  let shutdown: (() => Promise<void> | void) | undefined;

  beforeAll(async () => {
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
    const startedServer = bootedServer;
    if (startedServer) await new Promise<void>((resolve) => startedServer.close(() => resolve()));
  });

  it('is registered', async () => {
    const resp = await fetch(`${bootedUrl}/api/genui/catalog`);
    expect(resp.status).toBe(200);
    const body = (await resp.json()) as GenuiCatalogResponse;
    expect(body.catalog.schema).toBe('genui-catalog/1');
  });
});

describe('GET /api/genui/catalog/:id/preview', () => {
  it('serves an offline sandbox document with the selected motion mode', async () => {
    const resp = await fetch(`${baseUrl}/api/genui/catalog/glare-hover/preview?reducedMotion=true`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('content-type')).toContain('text/html');
    expect(resp.headers.get('content-security-policy')).toContain("default-src 'none'");
    const html = await resp.text();
    expect(html).toContain('data-genui="glare-hover"');
    expect(html).toContain('genui-reduced-motion');
  });

  it('rejects missing demos and invalid motion values', async () => {
    expect((await fetch(`${baseUrl}/api/genui/catalog/not-a-component/preview`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/genui/catalog/glare-hover/preview?reducedMotion=perhaps`)).status).toBe(400);
  });
});
