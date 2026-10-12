import { request as httpRequest, type ClientRequest, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseReferenceFanoutResponse } from '@open-design/contracts';
import { ToolTokenRegistry } from '../../src/tool-tokens.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { registerWorkbenchReferenceRoutes } from '../../src/routes/workbench-references.js';
import { createReferenceFanout } from '../../src/workbench/references/fanout.js';
import { createReferenceJudge } from '../../src/workbench/references/jev.js';
import { runReferencesCli } from '../../src/workbench/references/cli.js';
import { resource, searchResult } from './reference-fanout-fixtures.js';

const servers: Server[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done())); });
async function setup(local = true) {
  const app = express(); app.use(express.json());
  const service = createReferenceFanout({ search: async source => searchResult(source, [resource(source, 'one')]), judge: async input => input.candidates.map(item => ({ id: item.id, relevance: 0.9, sectionFit: 0.8, evidence: 0.7 })) });
  registerWorkbenchReferenceRoutes(app, { http: { sendApiError, isLocalSameOrigin: () => local, resolvedPortRef: { current: 0 } }, service });
  const server = app.listen(0, '127.0.0.1'); servers.push(server);
  await new Promise<void>(done => server.once('listening', done));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
describe('V04 HTTP and od references parity', () => {
  it.each([
    ['http://127.0.0.1:7456', 'Bearer fixture-token'],
    ['https://other.invalid', null],
    [undefined, null],
  ])('only forwards scoped credentials to their issuer (%s)', async (issuer, expected) => {
    let authorization: string | null = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      authorization = new Headers(init?.headers).get('authorization');
      return new Response('{"error":{"code":"fixture-rejection"}}', { status: 422 });
    });
    await runReferencesCli(['fanout', '--brief-file', '-', '--daemon-url', 'http://127.0.0.1:7456', '--json'], {
      env: { OD_TOOL_TOKEN: 'fixture-token', ...(issuer ? { OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer } : {}) },
      readStdin: async () => 'dentistry website', write: () => undefined,
    });
    expect(authorization).toBe(expected);
  });
  it('does not redirect the brief or credentials to another endpoint', async () => {
    let destinationCalls = 0;
    const destination = express(); destination.post('/api/workbench/references/fanout', (_req, res) => { destinationCalls++; res.json({}); });
    const target = destination.listen(0, '127.0.0.1'); servers.push(target);
    await new Promise<void>(done => target.once('listening', done));
    const issuer = express(); issuer.post('/api/workbench/references/fanout', (_req, res) => res.redirect(307, `http://127.0.0.1:${(target.address() as AddressInfo).port}/api/workbench/references/fanout`));
    const origin = issuer.listen(0, '127.0.0.1'); servers.push(origin);
    await new Promise<void>(done => origin.once('listening', done));
    const baseUrl = `http://127.0.0.1:${(origin.address() as AddressInfo).port}`;
    expect(await runReferencesCli(['fanout', '--brief-file', '-', '--json'], {
      baseUrl, env: { OD_TOOL_TOKEN: 'fixture-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: baseUrl },
      readStdin: async () => 'dentistry website', write: () => undefined,
    })).toBe(1);
    expect(destinationCalls).toBe(0);
  });
  it('CLI stdin sends the same request and returns the same report as HTTP', async () => {
    const baseUrl = await setup(); const outputs: unknown[] = [];
    const request = { brief: 'dentistry website', sections: [{ id: 'hero', name: 'Hero', purpose: null }] };
    const direct = await fetch(`${baseUrl}/api/workbench/references/fanout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
    expect(direct.status).toBe(200);
    expect(await runReferencesCli(['fanout', '--brief-file', '-', '--json'], { baseUrl, env: {}, readStdin: async () => JSON.stringify(request), write: value => outputs.push(value) })).toBe(0);
    expect(outputs[0]).toEqual(await direct.json());
  });
  it('rejects cross-origin calls and malformed HTTP/CLI input', async () => {
    const url = await setup(false);
    expect((await fetch(`${url}/api/workbench/references/fanout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"brief":"x"}' })).status).toBe(403);
    const local = await setup();
    expect((await fetch(`${local}/api/workbench/references/fanout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"brief":""}' })).status).toBe(400);
    for (const args of [['fanout', '--json'], ['fanout', '--brief-file', '-', '--json', '--json'], ['fanout', '--brief-file', '-', '--json', '--unsafe']]) {
      expect(await runReferencesCli(args, { readStdin: async () => '', write: () => undefined })).toBe(2);
    }
  });
  it('bounds concurrent fanout requests and releases the slot on failure', async () => {
    const app = express(); app.use(express.json()); let release!: () => void;
    const blocked = new Promise<void>(done => { release = done; });
    registerWorkbenchReferenceRoutes(app, { http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } }, service: { fanout: async () => { await blocked; throw new Error('SECRET'); } } });
    const server = app.listen(0, '127.0.0.1'); servers.push(server); await new Promise<void>(done => server.once('listening', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/references/fanout`;
    const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"brief":"x"}' });
    const first = post(), second = post(); await new Promise(done => setTimeout(done, 20));
    try { expect((await post()).status).toBe(429); } finally { release(); }
    const results = await Promise.all([first, second]); expect(results.map(item => item.status)).toEqual([500, 500]);
    expect(await results[0]!.text()).not.toContain('SECRET');
    expect((await post()).status).toBe(500);
  });
  it.each(['search', 'ranking'] as const)('a disconnect during %s aborts work and promptly frees its slot', async stage => {
    const signals: AbortSignal[] = [];
    const releases: Array<() => void> = [];
    const block = () => new Promise<void>(done => { releases.push(done); });
    let blocked = 0, settled = 0;
    const fanout = createReferenceFanout({
      search: async (source, input, options) => {
        if (stage === 'search' && input.query.includes('abandoned')) {
          signals.push(options.signal); blocked++;
          await block();
        }
        return searchResult(source, Array.from({ length: 5 }, (_, i) => resource(source, `${i}`)));
      },
      judge: createReferenceJudge({ key: async () => 'fixture-token', fetchImpl: async (_url, init) => {
        const body = JSON.parse(init!.body as string);
        // Ten candidates require two batches. Disconnect during the second batch.
        if (stage === 'ranking' && body.state.brief.includes('abandoned') && JSON.parse(body.state.candidates).length === 2) {
          signals.push(init!.signal as AbortSignal); blocked++;
          await block();
        }
        return new Response(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map(key => [key, { type: 'noul', noul: 0.8 }])) }));
      } }),
    });
    const app = express(); app.use(express.json());
    registerWorkbenchReferenceRoutes(app, {
      http: { sendApiError, isLocalSameOrigin: () => true, resolvedPortRef: { current: 0 } },
      service: { fanout: async (input, context) => {
        try { return await fanout.fanout(input, context); } finally { settled++; }
      } },
    });
    const server = app.listen(0, '127.0.0.1'); servers.push(server);
    await new Promise<void>(done => server.once('listening', done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/workbench/references/fanout`;
    const body = (brief: string) => JSON.stringify({ brief, sections: [{ id: 'hero', name: 'Hero', purpose: null }] });
    const clients: ClientRequest[] = [];
    try {
      for (let i = 0; i < 2; i++) {
        const client = httpRequest(url, { method: 'POST', headers: { 'content-type': 'application/json' } });
        client.on('error', () => undefined); clients.push(client); client.end(body('abandoned dentistry website'));
      }
      await vi.waitFor(() => expect(blocked).toBe(stage === 'search' ? 4 : 2));
      const post = () => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: body('dentistry website') });
      expect((await post()).status).toBe(429);
      clients[0]!.destroy();
      await vi.waitFor(() => {
        expect(signals.filter(signal => signal.aborted)).toHaveLength(stage === 'search' ? 2 : 1);
        expect(settled).toBe(1);
      }, { timeout: 500, interval: 5 });
      const replacement = await post();
      expect(replacement.status).toBe(200);
      expect(parseReferenceFanoutResponse(await replacement.json()).ranking.status).toBe('ranked');
      clients[1]!.destroy();
      await vi.waitFor(() => {
        expect(signals.every(signal => signal.aborted)).toBe(true);
        expect(settled).toBe(3);
      }, { timeout: 500, interval: 5 });
    } finally {
      for (const client of clients) client.destroy();
      for (const release of releases) release();
    }
  });
});

it('a scoped OD_TOOL_TOKEN cannot fan out through the owner Mobbin seat', async () => {
  const url = await setup();
  const registry = new ToolTokenRegistry();
  const grant = registry.mint({ runId: 'fixture-run', projectId: 'fixture-project' });
  expect(registry.validate(grant.token).ok).toBe(true);
  const response = await fetch(`${url}/api/workbench/references/fanout`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${grant.token}` }, body: JSON.stringify({ brief: 'dentistry website' }) });
  const result = parseReferenceFanoutResponse(await response.json());
  expect(result.references.every((item: any) => item.resource.connectorId !== 'mobbin')).toBe(true);
  expect(result.sources.filter((item: any) => item.source === 'mobbin').every((item: any) => item.code === 'connector-principal-forbidden')).toBe(true);
});
