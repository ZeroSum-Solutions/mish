import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchAdoptionRoutes } from '../../src/routes/workbench-adoption.js';
import { parseDependencySpec } from '../../src/workbench/adoption/catalogue-material.js';
import { checkDependencies, rangesCompatible } from '../../src/workbench/adoption/dependency-report.js';
import { lineDiff } from '../../src/workbench/adoption/replacement-diff.js';
import type { PlacementAdoptionExecutor } from '../../src/workbench/placement/adoption-executor.js';
import type { PlacementRuntimeStatus } from '../../src/workbench/placement/runtime-status.js';

const servers: Server[] = [];
afterEach(async () => { for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done())); });

describe('catalogue dependency report', () => {
  it('parses scoped and versioned specs', () => {
    expect(parseDependencySpec('@radix-ui/react-slot')).toEqual({ name: '@radix-ui/react-slot', range: '*' });
    expect(parseDependencySpec('@radix-ui/react-slot@^1.1.0')).toEqual({ name: '@radix-ui/react-slot', range: '^1.1.0' });
    expect(parseDependencySpec('tailwind-merge@3')).toEqual({ name: 'tailwind-merge', range: '3' });
  });
  it('uses caret release lines and never invents a conflict it cannot read', () => {
    expect(rangesCompatible('^3.0.0', '^3.2.1')).toBe(true);
    expect(rangesCompatible('^3.0.0', '~2.6.0')).toBe(false);
    expect(rangesCompatible('^0.7.0', '^0.6.2')).toBe(false);
    expect(rangesCompatible('*', '^1.0.0')).toBe(true);
    expect(rangesCompatible('^1.0.0', 'workspace:*')).toBe(true);
  });
  it('treats a project without a manifest as missing every declared package', () => {
    expect(checkDependencies([{ name: 'clsx', range: '*' }, { name: 'clsx', range: '*' }], null)).toEqual({ missing: [{ name: 'clsx', range: '*' }], incompatible: [], satisfied: [] });
    expect(checkDependencies([{ name: 'clsx', range: '^2' }], { devDependencies: { clsx: '^2.1.1' } }).satisfied).toEqual([{ name: 'clsx', range: '^2', installed: '^2.1.1' }]);
  });
});

describe('replacement diff', () => {
  it('shows removed and added lines and summarizes binary content', () => {
    expect(lineDiff(Buffer.from('a\nb\nc'), Buffer.from('a\nB\nc'))).toBe(' a\n-b\n+B\n c');
    expect(lineDiff(Buffer.from([0, 1, 2]), Buffer.from('text'))).toBe('binary content differs (3 → 4 bytes)');
  });
});

describe('catalogue prepare route provisioning', () => {
  const status = { mode: 'coordinated', activation: { adoption: 'open', gates: [] } } as unknown as PlacementRuntimeStatus;
  it('provisions the selected shadcn catalogue by default whenever the executor is wired (server.ts passes no catalogue dep)', async () => {
    const app = express(); app.use(express.json());
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: {} as PlacementAdoptionExecutor, status: () => status } });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/adoption/catalogue/prepare`;
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectId: 'p1', refKey: 'abc', entryPath: 'src/App.tsx' }) });
    // The default manager decodes the reference (and refuses this malformed one); it is not the unprovisioned refusal.
    expect(response.status).toBe(404);
    expect(((await response.json()) as any).error.details).toMatchObject({ kind: 'adoption', reason: 'resource-ref-unknown' });
  });
  it('answers a typed 422 when catalogue apply is explicitly disabled and never reaches the executor', async () => {
    const app = express(); app.use(express.json());
    registerWorkbenchAdoptionRoutes(app, { componentGateForRequest: async () => {}, http: { sendApiError }, authorizeProjectRequest: async () => true, placement: { adoption: {} as PlacementAdoptionExecutor, status: () => status }, catalogue: null });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', () => done()));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/adoption/catalogue/prepare`;
    const post = (body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const refused = await post({ projectId: 'p1', refKey: 'abc', entryPath: 'src/App.tsx' });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).error.details).toMatchObject({ kind: 'adoption', reason: 'catalogue-unprovisioned' });
    expect((await post({ projectId: 'p1', refKey: 'abc', entryPath: '../escape' })).status).toBe(400);
  });
});
