import { mcpEndpointFingerprint } from '../../src/mcp-endpoint.js';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectorResourceRef } from '@mish/contracts';
import { writeMcpConfig } from '../../src/mcp-config.js';
import { setToken } from '../../src/mcp-tokens.js';
import { CONNECTOR_DEFINITIONS, ConnectorProxy } from '../../src/workbench/connectors/connector-proxy.js';
import { mobbinImageUrl } from '../../src/workbench/connectors/mobbin-image-cache.js';
import { connectorReferenceSource } from '../../src/workbench/connectors/connector-references.js';
import { selectReferences } from '../../src/workbench/brief/references.js';
import { createDesignBriefService } from '../../src/workbench/brief/service.js';

const IMAGE = Buffer.from('89504e470d0a1a0a00000000', 'hex');
const row = { id: 'screen-1', app_name: 'Example app', mobbin_url: 'https://mobbin.com/screens/screen-1', image_url: 'https://cdn.mobbin.com/screen-1.png?expires=30' };
const search = { query: 'pricing page', kind: 'screens', platform: 'web', limit: 1 };

describe('selected Mobbin image cache (B067+B068, stubbed network)', () => {
  let dataDir: string;
  let proxy: ConnectorProxy;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
  let imageResponse: () => Response;
  let deepMode: 'ok' | 'timeout' | 'malformed' | 'revoked';
  const imageCalls = () => fetchImpl.mock.calls.filter(([url]) => String(url).startsWith('https://cdn.mobbin.com/'));
  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'mobbin-select-'));
    await writeMcpConfig(dataDir, { servers: [{ id: 'mobbin', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://api.mobbin.com/mcp' }] });
    await setToken(dataDir, 'mobbin', { accessToken: 'fixture-token', tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint('https://api.mobbin.com/mcp'), resourceUrl: 'https://api.mobbin.com/mcp', savedAt: Date.now() });
    imageResponse = () => new Response(IMAGE, { headers: { 'content-type': 'image/png' } });
    deepMode = 'ok';
    fetchImpl = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).startsWith('https://cdn.mobbin.com/')) return imageResponse();
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (request.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: request.id, result: { protocolVersion: '2025-06-18', capabilities: {} } });
      if (request.params.arguments.mode === 'deep') {
        if (deepMode === 'revoked') return new Response(null, { status: 401 });
        if (deepMode === 'timeout') return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
        if (deepMode === 'malformed') return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: '{}' }] } });
      }
      return Response.json({ jsonrpc: '2.0', id: request.id, result: { content: [{ type: 'text', text: JSON.stringify({ results: [row], ai_usage_notice: { text: 'Credit Mobbin\nKeep the app name.' } }) }] } });
    });
    proxy = new ConnectorProxy({ dataDir, fetchImpl, timeoutMs: 100 });
  });
  afterEach(async () => { vi.useRealTimers(); await rm(dataDir, { recursive: true, force: true }); });
  const found = async () => (await proxy.search('mobbin', search)).results[0]!;

  it('does no download on search or detail; selecting saves bytes and provenance, then serves after restart without CDN I/O', async () => {
    const resource = await found();
    await proxy.detail('mobbin', { itemId: resource.itemId });
    expect(imageCalls()).toHaveLength(0);
    const selected = await proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt });
    const image = selected.resource.cachedImage!;
    expect(image).toMatchObject({ contentType: 'image/png', byteLength: IMAGE.length });
    expect(selected.providerNotice).toBe('Credit Mobbin\nKeep the app name.');
    expect(imageCalls()).toHaveLength(1);
    expect(imageCalls()[0]![1]).toMatchObject({ redirect: 'manual' });
    expect(imageCalls()[0]![1]?.headers).toBeUndefined();
    const files = await readdir(path.join(dataDir, 'workbench', 'connectors', 'mobbin'));
    const metadata = JSON.parse(await readFile(path.join(dataDir, 'workbench', 'connectors', 'mobbin', files.find(file => file.endsWith('.json'))!), 'utf8'));
    expect(metadata).toMatchObject({ sourceUrl: row.image_url, resource: { itemId: row.id, canonicalUrl: row.mobbin_url, title: row.app_name }, fetchedAt: image.fetchedAt });
    proxy = new ConnectorProxy({ dataDir, fetchImpl, timeoutMs: 100 });
    expect((await proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt })).resource.cachedImage).toEqual(image);
    const source = connectorReferenceSource(proxy);
    const context = { principalId: 'local-owner', projectId: 'project-1' };
    expect(await source.resolve({ ...connectorResourceRef(resource), revisionOrDigest: resource.capturedAt }, context)).toEqual({ kind: 'stale' });
    expect((await source.resolve(connectorResourceRef(resource), context)).kind).toBe('found');
    const key = image.url.split('/').at(-1)!;
    expect((await proxy.selectedImage('mobbin', key)).bytes).toEqual(IMAGE);
    expect(imageCalls()).toHaveLength(1);
  });

  it('caches the exact user-selected R15 reference and refuses stale selection before downloading', async () => {
    const resource = await found();
    const source = connectorReferenceSource(proxy);
    const context = { principalId: 'local-owner', projectId: 'project-1' };
    await expect(selectReferences([{ ...connectorResourceRef(resource), revisionOrDigest: 'captured:2000-01-01T00:00:00.000Z' }], context, source, 2000)).rejects.toMatchObject({ code: 'reference-stale' });
    expect(imageCalls()).toHaveLength(0);
    await selectReferences([connectorResourceRef(resource)], context, source, 2000);
    expect(imageCalls()).toHaveLength(1);
  });

  it('keeps the image on the row whose ID is normalized and returns typed R15 cache failures', async () => {
    const old = row.id; row.id = ' screen-1 ';
    try {
      const resource = await found();
      expect(resource.itemId).toBe('screen-1');
      await proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt });
      expect(imageCalls()).toHaveLength(1);
    } finally { row.id = old; }
    // New capture so this failure cannot reuse the selected bytes above.
    proxy = new ConnectorProxy({ dataDir, fetchImpl, now: () => Date.now() + 1000 });
    const resource = await found();
    imageResponse = () => new Response('<html/>', { headers: { 'content-type': 'text/html' } });
    const briefs = createDesignBriefService({ dataDir, generator: null, references: connectorReferenceSource(proxy) });
    await expect(briefs.create({ projectId: 'project-1', originalText: 'Pricing page', selectedReferenceRefs: [connectorResourceRef(resource)] }, { principalId: 'local-owner', projectId: 'project-1' })).rejects.toMatchObject({ name: 'BriefError', status: 422, code: 'connector-image-invalid' });
  });

  it('treats a corrupt saved record as a cache miss and re-downloads on select', async () => {
    const resource = await found();
    const input = { itemId: resource.itemId, capturedAt: resource.capturedAt };
    const selected = await proxy.select('mobbin', input);
    const key = selected.resource.cachedImage!.url.split('/').at(-1)!;
    const { writeFile } = await import('node:fs/promises');
    await writeFile(path.join(dataDir, 'workbench', 'connectors', 'mobbin', `${key}.json`), '{ truncated');
    const healed = await proxy.select('mobbin', input);
    expect(healed.resource.cachedImage).toMatchObject({ byteLength: IMAGE.length });
    expect(imageCalls()).toHaveLength(2);
    expect((await proxy.selectedImage('mobbin', key)).bytes).toEqual(IMAGE);
  });

  it('refuses Workspace principal selection before owner-account image I/O', async () => {
    const resource = await found();
    await expect(selectReferences([connectorResourceRef(resource)], { principalId: 'workspace:one:member', projectId: 'project-1' }, connectorReferenceSource(proxy), 2000)).rejects.toMatchObject({ code: 'reference-forbidden' });
    expect(imageCalls()).toHaveLength(0);
  });

  it('enforces daemon cache rights and safe origins before downloading', async () => {
    const resource = await found();
    const decide = CONNECTOR_DEFINITIONS.mobbin.rights.decide;
    const policy = vi.spyOn(CONNECTOR_DEFINITIONS.mobbin.rights, 'decide').mockImplementation(operation => operation === 'cache-source-content' ? { operation, decision: 'blocked', reason: 'Fixture denial' } : decide(operation));
    try {
      await expect(proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt })).rejects.toMatchObject({ code: 'connector-operation-blocked' });
      expect(imageCalls()).toHaveLength(0);
    } finally { policy.mockRestore(); }
    for (const url of ['https://mobbin.com.evil.invalid/a', 'https://user:pass@cdn.mobbin.com/a', 'http://cdn.mobbin.com/a', 'https://cdn.mobbin.com:8443/a', 'https://127.0.0.1/a', 'https://cdn.mobbin.com/a#fragment']) expect(mobbinImageUrl(url)).toBeNull();
  });

  it('follows a same-Mobbin redirect and deduplicates concurrent selection', async () => {
    const resource = await found();
    imageResponse = () => new Response(null, { status: 302, headers: { location: 'https://cdn.mobbin.com/final.png' } });
    const base = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => String(url) === 'https://cdn.mobbin.com/final.png' ? new Response(IMAGE, { headers: { 'content-type': 'image/png' } }) : base(url, init));
    const input = { itemId: resource.itemId, capturedAt: resource.capturedAt };
    const [first, second] = await Promise.all([proxy.select('mobbin', input), proxy.select('mobbin', input)]);
    expect(first).toEqual(second);
    expect(imageCalls()).toHaveLength(2);
  });

  it('does not replace a newer search capture when an older selection finishes downloading', async () => {
    let tick = 1000;
    proxy = new ConnectorProxy({ dataDir, fetchImpl, now: () => tick });
    const first = await found();
    let release!: (response: Response) => void;
    let started!: () => void;
    const image = new Promise<Response>(resolve => { release = resolve; });
    const downloading = new Promise<void>(resolve => { started = resolve; });
    const base = fetchImpl.getMockImplementation()!;
    fetchImpl.mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://cdn.mobbin.com/')) return base(url, init);
      started(); return image;
    });
    const selected = proxy.select('mobbin', { itemId: first.itemId, capturedAt: first.capturedAt });
    await downloading;
    tick = 2000;
    const latest = await found();
    release(new Response(IMAGE, { headers: { 'content-type': 'image/png' } }));
    await selected;
    expect(proxy.capturedReference('mobbin', first.itemId)?.capturedAt).toBe(latest.capturedAt);
  });

  it('applies the download deadline to a stalled response body', async () => {
    const resource = await found();
    const base = fetchImpl.getMockImplementation()!;
    let bodyStarted = false;
    fetchImpl.mockImplementation(async (url, init) => {
      if (!String(url).startsWith('https://cdn.mobbin.com/')) return base(url, init);
      return new Response(new ReadableStream({ start(controller) { bodyStarted = true; init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); } }), { headers: { 'content-type': 'image/png' } });
    });
    vi.useFakeTimers();
    const pending = proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt });
    const refused = expect(pending).rejects.toMatchObject({ code: 'connector-timeout' });
    await vi.waitFor(() => expect(bodyStarted).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    await refused;
    expect(await readdir(path.join(dataDir, 'workbench', 'connectors', 'mobbin')).catch(() => [])).toEqual([]);
  });

  it('keeps a provider revocation closed after restart until a successful fresh search', async () => {
    const resource = await found();
    const selected = await proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt });
    const key = selected.resource.cachedImage!.url.split('/').at(-1)!;
    deepMode = 'revoked';
    await expect(proxy.search('mobbin', search)).rejects.toMatchObject({ code: 'connector-access-revoked' });
    proxy = new ConnectorProxy({ dataDir, fetchImpl });
    await expect(proxy.selectedImage('mobbin', key)).rejects.toMatchObject({ code: 'connector-access-revoked' });
    deepMode = 'ok'; await found();
    expect((await proxy.selectedImage('mobbin', key)).bytes).toEqual(IMAGE);
  });

  it.each([
    ['html', () => new Response('<script>bad</script>', { headers: { 'content-type': 'text/html' } })],
    ['svg', () => new Response('<svg/>', { headers: { 'content-type': 'image/svg+xml' } })],
    ['wrong bytes', () => new Response('<html/>', { headers: { 'content-type': 'image/png' } })],
    ['declared oversize', () => new Response(IMAGE, { headers: { 'content-type': 'image/png', 'content-length': String(10 * 1024 * 1024 + 1) } })],
    ['streamed oversize', () => new Response(new Uint8Array(10 * 1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } })],
    ['external redirect', () => new Response(null, { status: 302, headers: { location: 'https://evil.invalid/image.png' } })],
  ])('refuses %s without publishing a cache record', async (_name, response) => {
    const resource = await found(); imageResponse = response;
    await expect(proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt })).rejects.toMatchObject({ code: 'connector-image-invalid' });
    expect(await readdir(path.join(dataDir, 'workbench', 'connectors', 'mobbin')).catch(() => [])).toEqual([]);
    expect(fetchImpl.mock.calls.some(([url]) => String(url).includes('evil.invalid'))).toBe(false);
  });

  it('refuses non-Mobbin URLs, signed-out cache reads and cross-connector cache requests', async () => {
    const old = row.image_url; row.image_url = 'https://evil.invalid/image.png';
    try {
      const resource = await found();
      await expect(proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt })).rejects.toMatchObject({ code: 'connector-image-invalid' });
      expect(imageCalls()).toHaveLength(0);
    } finally { row.image_url = old; }
    const resource = await found();
    const selected = await proxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt });
    const key = selected.resource.cachedImage!.url.split('/').at(-1)!;
    await expect(proxy.selectedImage('motionsites', key)).rejects.toMatchObject({ code: 'connector-request-invalid' });
    await writeMcpConfig(dataDir, { servers: [] });
    await expect(proxy.selectedImage('mobbin', key)).rejects.toMatchObject({ code: 'connector-binding-missing' });
  });

  it('bounds a timed-out deep pass and records the successful standard fallback', async () => {
    vi.useFakeTimers(); deepMode = 'timeout';
    const pending = proxy.search('mobbin', search);
    // Wait for the stub's deep request before advancing the deadline.
    await vi.waitFor(() => expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('"mode":"deep"'))).toBe(true));
    await vi.advanceTimersByTimeAsync(100);
    expect((await pending).receipt).toMatchObject({ attempts: 2, searchMode: { requested: 'deep', used: 'standard', fallbackReason: 'connector-timeout' } });
  });

  it('falls back for malformed deep data but never retries revoked access in standard mode', async () => {
    deepMode = 'malformed';
    expect((await proxy.search('mobbin', search)).receipt.searchMode).toMatchObject({ used: 'standard', fallbackReason: 'connector-response-invalid' });
    deepMode = 'revoked'; fetchImpl.mockClear();
    await expect(proxy.search('mobbin', search)).rejects.toMatchObject({ code: 'connector-access-revoked' });
    expect(fetchImpl.mock.calls.some(([, init]) => String(init?.body).includes('"mode":"standard"'))).toBe(false);
  });
});
