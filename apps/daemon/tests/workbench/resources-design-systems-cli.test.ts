import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResourceDetailResponse, ResourceSearchResponse } from '@mish/contracts';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchRoutes } from '../../src/routes/workbench.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { localInventorySources } from './resources-inventory-fixture.js';

let server: Server | undefined;
afterEach(async () => { if (server) await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; });

describe('od workbench search/inspect parity for design systems', () => {
  it('returns the bundled design-system item through the shared HTTP API', async () => {
    const app = express(); app.use(express.json());
    registerWorkbenchRoutes(app, { http: { sendApiError }, authorizeProjectRequest: async () => true, sourcesForRequest: () => localInventorySources() });
    server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
    const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const output: unknown[] = [];
    expect(await runWorkbenchCli(['search', '--category', 'design-system', '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    const search = output[0] as ResourceSearchResponse;
    const system = search.results.find(item => item.ref.itemId === 'neutral-product');
    expect(system).toMatchObject({ ref: { sourceId: 'design-systems' }, category: 'design-system', readiness: 'unverified' });
    expect(search.sourceStatuses.find(status => status.sourceId === 'design-systems')).toMatchObject({ state: 'searched' });
    expect(await runWorkbenchCli(['inspect', '--ref', system!.refKey, '--json'], { baseUrl, write: value => output.push(value) })).toBe(0);
    expect((output[1] as ResourceDetailResponse).resource).toEqual(system);
  });
});
