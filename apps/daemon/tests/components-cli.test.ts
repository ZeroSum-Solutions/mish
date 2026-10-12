import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseComponentLedgerReport } from '@open-design/contracts';
import { runComponentsCli } from '../src/components-cli.js';
import { registerComponentLedgerRoutes } from '../src/routes/component-ledger.js';
import { requireLocalDaemonRequest } from '../src/http/local-daemon-request.js';
import { createPackRegistry, packsDirForDataDir } from '../src/packs/registry.js';
import { createPackService } from '../src/packs/service.js';
import { packManifestDigest } from '../src/packs/manifest.js';
import { writeFixturePack } from './fixtures/licensed-pack/pack-fixture.js';
import type { HttpDeps } from '../src/server-context.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const resolveBaseUrl = async () => 'http://127.0.0.1:1';

describe('od components ledger', () => {
  it('reads the committed core offline without accessing any daemon', async () => {
    const result = await runComponentsCli(['ledger', '--core-only', '--json'], { resolveBaseUrl: async () => { throw new Error('No daemon'); } });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).components['genui:atc-shader']).toMatchObject({ built: true, verified: false });
  });
  it.each([{ args: ['unknown'] }, { args: ['ledger', '--wat'] }, { args: ['ledger', '--daemon-url'] }])('rejects malformed arguments %j', async ({ args }) => {
    expect((await runComponentsCli(args, { resolveBaseUrl })).code).toBe(2);
  });
  it('refuses a remote URL and a forged ledger response', async () => {
    expect((await runComponentsCli(['ledger'], { resolveBaseUrl: async () => 'https://example.com' })).code).toBe(2);
    expect((await runComponentsCli(['ledger', '--json'], { resolveBaseUrl, fetchImpl: async () => new Response('{}') })).code).toBe(1);
  });
  it('prints row-level duplicate errors in the text error column', async () => {
    const core = await runComponentsCli(['ledger', '--core-only', '--json'], { resolveBaseUrl });
    const report = JSON.parse(core.stdout);
    report.components['genui:atc-shader'].errors = [{ code: 'duplicate-id', packId: 'conflict-pack' }];
    const result = await runComponentsCli(['ledger'], { resolveBaseUrl, fetchImpl: async () => Response.json(report) });
    expect(result.code).toBe(0);
    expect(result.stdout.split('\n').find(line => line.startsWith('genui:atc-shader\t'))?.split('\t')[6]).toBe('duplicate-id (conflict-pack)');
  });
  it('reads installed packs through the real read-only route and fails closed after metadata drift', async () => {
    const data = mkdtempSync(path.join(tmpdir(), 'r13-api-'));
    const fixture = writeFixturePack();
    cleanup.push(() => rmSync(data, { recursive: true, force: true }), () => rmSync(fixture.dir, { recursive: true, force: true }));
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    const service = createPackService({ registry });
    await service.install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    const app = express();
    const http = { requireLocalDaemonRequest, sendApiError: (res, status, code, message) => res.status(status).json({ code, message }) } as HttpDeps;
    registerComponentLedgerRoutes(app, { http }, registry);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const resolveBaseUrl = async () => `http://127.0.0.1:${address.port}`;
    const result = await runComponentsCli(['ledger', '--json'], { resolveBaseUrl });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).components['cult:glow-card']).toMatchObject({ source: 'pack', installed: true, verified: false });
    const text = await runComponentsCli(['ledger'], { resolveBaseUrl });
    expect(text.stdout.split('\n').find(line => line.startsWith('cult:glow-card\t'))?.split('\t')[2]).toBe('licensed (pack-declared)');
    const refused = await fetch(`${await resolveBaseUrl()}/api/components/ledger`, { headers: { Origin: 'https://example.com' } });
    expect(refused.status).toBe(403);
    writeFileSync(path.join(registry.packsDir, fixture.manifest.id, 'kits/demo/registry/glow-card.json'), '{}');
    expect((await runComponentsCli(['ledger', '--json'], { resolveBaseUrl })).code).toBe(1);
  });

  it('reports both conflicting packs with HTTP 200 and CLI row errors', async () => {
    const itemId = 'round-three-conflict';
    const data = mkdtempSync(path.join(tmpdir(), 'r13-pack-conflict-'));
    cleanup.push(() => rmSync(data, { recursive: true, force: true }));
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(data) });
    const service = createPackService({ registry });
    const packIds = ['conflict-a', 'conflict-b'];
    for (const id of packIds) {
      const fixture = writeFixturePack({
        id,
        files: [{ path: 'kit/registry/item.json', content: JSON.stringify({ name: itemId, title: id, files: [{ content: `export const provider = '${id}';` }] }) }],
        contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id, path: 'kit' }],
      });
      cleanup.push(() => rmSync(fixture.dir, { recursive: true, force: true }));
      await service.install({ kind: 'folder', path: fixture.dir, sha256: packManifestDigest(fixture.manifest) });
    }
    const app = express();
    const http = { requireLocalDaemonRequest, sendApiError: (res, status, code, message) => res.status(status).json({ code, message }) } as HttpDeps;
    registerComponentLedgerRoutes(app, { http }, registry);
    const server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No fixture port');
    const resolveBaseUrl = async () => `http://127.0.0.1:${address.port}`;
    const response = await fetch(`${await resolveBaseUrl()}/api/components/ledger`);
    expect(response.status).toBe(200);
    const report = parseComponentLedgerReport(await response.json());
    expect(report.components[`cult:${itemId}`]).toMatchObject({ verified: false, evidenceDate: null });
    expect(report.components[`cult:${itemId}`]?.errors).toEqual(packIds.map(packId => ({ code: 'duplicate-id', packId })));
    expect(report.components['shadcn:button']).toBeDefined();
    const text = await runComponentsCli(['ledger'], { resolveBaseUrl });
    expect(text.code).toBe(0);
    const row = text.stdout.split('\n').find(line => line.startsWith(`cult:${itemId}\t`));
    expect(row?.split('\t')[6]).toBe('duplicate-id (conflict-a); duplicate-id (conflict-b)');
    expect(text.stdout.split('\n').find(line => line.startsWith('shadcn:button\t'))?.split('\t')[6]).toBe('');
  });
});
