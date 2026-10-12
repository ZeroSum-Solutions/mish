import { mcpEndpointFingerprint } from '../../src/mcp-endpoint.js';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SOURCE_OPERATIONS, connectorResourceRef, parseConnectorDetailResponse, parseConnectorSearchResponse, parseRightsAssessment } from '@mish/contracts';
import { writeMcpConfig } from '../../src/mcp-config.js';
import { getToken, setToken } from '../../src/mcp-tokens.js';
import { sendApiError } from '../../src/http/api-errors.js';
import { isLocalSameOrigin } from '../../src/origin-validation.js';
import { registerWorkbenchConnectorRoutes } from '../../src/routes/workbench-connectors.js';
import { ConnectorProxy, connectorDeriveDecision } from '../../src/workbench/connectors/connector-proxy.js';
import { connectorReferenceSource } from '../../src/workbench/connectors/connector-references.js';
import { MOBBIN_EVIDENCE, MOBBIN_FROZEN_TOOLS, MOBBIN_OWNER_DECISION, MOBBIN_RIGHTS_ASSESSMENT, MOBBIN_TOOL_SET_DIGEST } from '../../src/workbench/connectors/mobbin.js';
import { selectReferences } from '../../src/workbench/brief/references.js';
import { createIntegrationProbes } from '../../src/workbench/integration-probes.js';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { runWorkbenchCli } from '../../src/workbench-cli.js';

/**
 * G29 / AC-R12.2: Mobbin through the same typed read-only proxy as MotionSites.
 * The schemas are frozen from the committed agent-run receipt; the daemon dispatches
 * only through its own Mobbin MCP binding and saved OAuth token. A Mobbin login held
 * by Claude Code, Codex or any other agent's own MCP config is never read or borrowed.
 * The provider here is a local fixture speaking the receipt's recorded item fields;
 * it is not a live authorized probe.
 */
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const MOBBIN_TOKEN = 'fixture-mobbin-token-never-echoed';
const OTHER_TOKEN = 'fixture-motionsites-token-never-borrowed';
const NOTICE = 'AI usage notice\n\nResults are references; credit the original app.';
const row = (id: string, app: string) => ({ id, app_name: app, platform: 'web', mobbin_url: `https://mobbin.com/screens/${id}`, image_url: `https://cdn.mobbin.com/${id}.webp` });
const ROWS = [
  row('d6cac496-7f42-4ddf-ad94-bf72570cfbb0', 'Patreon'),
  row('262e3ea0-7bd5-4906-a2d8-c41f0c5633f4', 'Assembly'),
  row('6451f7bc-4548-48ee-9f64-4225f28c7a54', 'Rows'),
];
type Mode = 'ok' | 'revoked' | 'deep-denied';

describe('Mobbin through the read-only connector proxy (G29, AC-R12.2)', () => {
  let dataDir: string;
  let provider: Awaited<ReturnType<typeof listen>>;
  let daemon: Awaited<ReturnType<typeof listen>>;
  let mode: Mode;
  let toolCalls: Array<{ tool: string; args: unknown }>;
  let seenAuthorization: string[];
  let proxy: ConnectorProxy;
  const servers: Server[] = [];
  const endpoint = () => `${provider.url}/mcp`;

  beforeEach(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'od-mobbin-connector-'));
    mode = 'ok'; toolCalls = []; seenAuthorization = [];
    const app = express(); app.use(express.json());
    app.post('/mcp', (req, res) => {
      seenAuthorization.push(req.get('Authorization') ?? '');
      if (req.get('Authorization') !== `Bearer ${MOBBIN_TOKEN}` || mode === 'revoked') { res.status(401).end(); return; }
      const { id, method, params } = req.body;
      if (method === 'notifications/initialized') { res.status(202).end(); return; }
      if (method === 'initialize') { res.json({ jsonrpc: '2.0', id, result: { protocolVersion: '2025-06-18', capabilities: {} } }); return; }
      toolCalls.push({ tool: params.name, args: params.arguments });
      if (mode === 'deep-denied' && params.arguments.mode === 'deep') { res.json({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: 'Deep unavailable' }] } }); return; }
      const body = params.name === 'search_flows' ? { flows: ROWS.slice(0, 1) } : { results: ROWS, ai_usage_notice: { text: NOTICE } };
      res.json({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(body) }] } });
    });
    provider = await listen(app); servers.push(provider.server);
    // The daemon holds MotionSites, but no Mobbin binding: Mobbin must not borrow it.
    await writeMcpConfig(dataDir, { servers: [{ id: 'motionsites', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint() }] });
    await setToken(dataDir, 'motionsites', { accessToken: OTHER_TOKEN, tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint(endpoint()), resourceUrl: endpoint(), savedAt: Date.now() });
    const api = express(); api.use(express.json());
    proxy = new ConnectorProxy({ dataDir, fetchImpl: async (url, init) => String(url).startsWith('https://cdn.mobbin.com/') ? new Response(Buffer.from('89504e470d0a1a0a00000000', 'hex'), { headers: { 'content-type': 'image/png' } }) : fetch(url, init), timeoutMs: 1000, sleep: async () => undefined, random: () => 0.5 });
    const portRef = { current: 0 };
    registerWorkbenchConnectorRoutes(api, { http: { sendApiError, isLocalSameOrigin: (req, port) => isLocalSameOrigin(req, port, { OD_BIND_HOST: '127.0.0.1' }), resolvedPortRef: portRef }, proxy });
    daemon = await listen(api); servers.push(daemon.server);
    portRef.current = Number(new URL(daemon.url).port);
  });
  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
    await rm(dataDir, { recursive: true, force: true });
  });
  const bindMobbin = async (withToken = true) => {
    await writeMcpConfig(dataDir, { servers: [
      { id: 'motionsites', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint() },
      { id: 'mobbin', enabled: true, transport: 'http', authMode: 'oauth', url: endpoint() },
    ] });
    if (withToken) await setToken(dataDir, 'mobbin', { accessToken: MOBBIN_TOKEN, tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint(endpoint()), resourceUrl: endpoint(), savedAt: Date.now() });
  };
  const post = async (route: string, body: unknown) => {
    const response = await fetch(`${daemon.url}/api/workbench/connectors/${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  };
  const search = (body: unknown, connector = 'mobbin') => post(`${connector}/search`, body);
  const detail = (itemId: string) => post('mobbin/detail', { itemId });
  const od = async (args: string[]) => { let body: any; const code = await runWorkbenchCli(['connector', ...args, '--json'], { baseUrl: daemon.url, write: value => { body = value; } }); return { code, body }; };
  const screens = { query: 'pricing page', kind: 'screens', platform: 'web', limit: 3 };

  it.each([307, 308])('refuses HTTP %i during image-access OAuth refresh without forwarding the refresh body', async status => {
    const publicEndpoint = 'https://api.mobbin.com/mcp';
    const refreshToken = 'fixture-refresh-token-image-access';
    const receivedBodies: string[] = [];
    let refreshRequests = 0;
    let imageRequests = 0;
    const sink = express(); sink.use(express.urlencoded({ extended: false }));
    sink.post('/capture', (req, res) => {
      receivedBodies.push(req.body.refresh_token);
      res.json({ access_token: MOBBIN_TOKEN, token_type: 'Bearer' });
    });
    const destination = await listen(sink); servers.push(destination.server);
    const issuer = express();
    issuer.post('/token', (_req, res) => { refreshRequests++; res.redirect(status, `${destination.url}/capture`); });
    const tokenServer = await listen(issuer); servers.push(tokenServer.server);
    await writeMcpConfig(dataDir, { servers: [{ id: 'mobbin', enabled: true, transport: 'http', authMode: 'oauth', url: publicEndpoint }] });
    const stored = { accessToken: MOBBIN_TOKEN, tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint(publicEndpoint), resourceUrl: publicEndpoint, savedAt: Date.now() };
    await setToken(dataDir, 'mobbin', stored);
    // Only the MCP handshake uses the existing fixture. Refresh and its cross-origin
    // redirect use real Node fetch against two synthetic local HTTP servers.
    const imageProxy = new ConnectorProxy({ dataDir, timeoutMs: 1000, fetchImpl: async (url, init) => {
      if (String(url) === publicEndpoint) return fetch(endpoint(), init);
      if (String(url).startsWith('https://cdn.mobbin.com/')) { imageRequests++; return new Response(Buffer.from('89504e470d0a1a0a00000000', 'hex'), { headers: { 'content-type': 'image/png' } }); }
      return fetch(url, init);
    } });
    const resource = (await imageProxy.search('mobbin', screens)).results[0]!;
    await setToken(dataDir, 'mobbin', { ...stored, expiresAt: 1, refreshToken, clientId: 'fixture-client', tokenEndpoint: `${tokenServer.url}/token` });
    const result = await imageProxy.select('mobbin', { itemId: resource.itemId, capturedAt: resource.capturedAt }).then(value => value, error => error);
    expect(refreshRequests).toBe(1);
    expect(receivedBodies).toEqual([]);
    expect(result).toMatchObject({ code: 'connector-needs-sign-in' });
    expect(imageRequests).toBe(0);
    expect(await getToken(dataDir, 'mobbin')).toMatchObject({ accessToken: MOBBIN_TOKEN, refreshToken, expiresAt: 1 });
    expect(JSON.stringify(result)).not.toContain(refreshToken);
  });

  it('overall cancellation aborts transport, prevents deep fallback, and stores no late capture', async () => {
    await bindMobbin();
    const controller = new AbortController();
    let transportSignal: AbortSignal | null = null;
    let calls = 0;
    const cancelled = new ConnectorProxy({ dataDir, timeoutMs: 1000, fetchImpl: async (_url, init) => {
      calls++; transportSignal = init?.signal ?? null;
      controller.abort(new DOMException('Deadline', 'TimeoutError'));
      return new Promise<never>(() => undefined);
    } });
    await expect(cancelled.search('mobbin', screens, { signal: controller.signal })).rejects.toMatchObject({ code: 'connector-timeout' });
    expect((transportSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(calls).toBe(1);
    expect(cancelled.capturedReference('mobbin', ROWS[0]!.id)).toBeNull();
  });

  it('D5 Test runs the real frozen Mobbin plan (deep-first screens) with one web screen search', async () => {
    await bindMobbin();
    const entry = buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(row => row.id === 'mobbin')!;
    const probes = createIntegrationProbes({ dataDir, skillRoots: [], proxy });
    const result = await probes.probe(entry, await probes.inspect(entry));
    expect(result.kind).toBe('workflow');
    expect(toolCalls).toEqual([{ tool: 'search_screens', args: expect.objectContaining({ query: 'navigation', platform: 'web', limit: 1, mode: 'deep' }) }]);
  });

  it('without a daemon-side Mobbin binding, search and detail refuse with connector-binding-missing and how to bind; nothing is dispatched or borrowed', async () => {
    const refused = await search(screens);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('connector-binding-missing');
    const steps = (refused.body.error.details.nextSteps as string[]).join('\n');
    expect(steps).toMatch(/Settings → External MCP/);
    expect(steps).toMatch(/api\.mobbin\.com\/mcp/);
    expect(steps).toMatch(/OAuth/);
    expect(steps).toMatch(/not shared with the daemon/);
    const missingDetail = await detail(ROWS[0]!.id);
    expect(missingDetail.status).toBe(409);
    expect(missingDetail.body.error.code).toBe('connector-binding-missing');
    const promptFile = path.join(dataDir, 'query.txt');
    await writeFile(promptFile, 'pricing page');
    const cli = await od(['search', '--connector', 'mobbin', '--kind', 'screens', '--platform', 'web', '--prompt-file', promptFile]);
    expect(cli.code).toBe(3);
    expect(cli.body.error.code).toBe('connector-binding-missing');
    expect(seenAuthorization).toEqual([]);
    expect(toolCalls).toEqual([]);
    expect(JSON.stringify(refused.body)).not.toContain(OTHER_TOKEN);
  });

  it('a configured Mobbin server without its own saved token asks for sign-in and never sends another server\'s token', async () => {
    await bindMobbin(false);
    const refused = await search(screens);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('connector-needs-sign-in');
    expect(seenAuthorization).toEqual([]);
  });

  it('searches screens through the frozen search_screens schema with attribution, the scoped rights and the provider notice', async () => {
    await bindMobbin();
    const response = await search(screens);
    expect(response.status).toBe(200);
    const parsed = parseConnectorSearchResponse(response.body);
    expect(toolCalls).toEqual([{ tool: 'search_screens', args: { query: 'pricing page', platform: 'web', limit: 3, mode: 'deep', output_destination: 'design_tool', output_tool: 'Mishh Mashh' } }]);
    expect(parsed.results.map(item => item.title)).toEqual(['Patreon', 'Assembly', 'Rows']);
    const first = parsed.results[0]!;
    expect(first).toMatchObject({
      connectorId: 'mobbin', itemId: ROWS[0]!.id, canonicalUrl: ROWS[0]!.mobbin_url, category: 'screen · web', access: 'unknown',
      attribution: { provider: 'Mobbin', url: 'https://mobbin.com' }, untrusted: true, supportedOperations: ['open-source-link'],
    });
    const decision = (operation: string) => first.rights.operations.find(item => item.operation === operation)!;
    expect(first.rights.status).toBe('restricted');
    expect(first.rights.operations.map(item => item.operation).sort()).toEqual([...SOURCE_OPERATIONS].sort());
    expect(decision('host-preview')).toMatchObject({ decision: 'allowed', evidenceRefs: [MOBBIN_EVIDENCE.rightsAssessment] });
    // Owner decision 2026-10-09: private repository, licences ignored for now. Clause readings stay as metadata.
    for (const operation of ['cache-source-content', 'save-private-unit', 'private-backup', 'derive-from-reference', 'incorporate-project', 'reuse-private-project', 'export-application']) {
      expect(decision(operation)).toMatchObject({ decision: 'allowed', evidenceRefs: [MOBBIN_EVIDENCE.rightsAssessment] });
      expect(decision(operation).reason).toMatch(/owner decision 2026-10-09/i);
    }
    expect(decision('cache-source-content').reason).toMatch(/3\.2\.5/);
    expect(decision('derive-from-reference').reason).toMatch(/3\.4/);
    expect(decision('redistribute-unit').decision).toBe('blocked');
    expect(parsed.receipt).toMatchObject({ binding: 'daemon-mcp-config', toolName: 'search_screens', schemaDigest: MOBBIN_FROZEN_TOOLS.screens.schemaDigest, attempts: 1 });
    expect(parsed.providerNotice).toBe(NOTICE);
    const raw = JSON.stringify(response.body);
    expect(raw).not.toContain(MOBBIN_TOKEN);
    expect(raw).not.toContain(OTHER_TOKEN);
    expect(raw).not.toContain('images.example.invalid');
    expect(raw).not.toContain(provider.url);
    expect(seenAuthorization.every(value => value === `Bearer ${MOBBIN_TOKEN}`)).toBe(true);
  });

  it('falls back from deep to standard and records the reason and both attempts', async () => {
    await bindMobbin(); mode = 'deep-denied';
    const response = await search(screens);
    expect(response.status).toBe(200);
    expect(toolCalls.map(call => (call.args as { mode: string }).mode)).toEqual(['deep', 'standard']);
    expect(response.body.receipt).toMatchObject({ attempts: 2, searchMode: { requested: 'deep', used: 'standard', fallbackReason: 'connector-tool-denied' } });
  });

  it('flows and sections use their own frozen tools and bounds; an inapplicable kind or platform is refused before dispatch', async () => {
    await bindMobbin();
    const flows = parseConnectorSearchResponse((await search({ query: 'checkout with payment method selection', kind: 'flows', platform: 'ios', limit: 20 })).body);
    expect(toolCalls[0]).toEqual({ tool: 'search_flows', args: { query: 'checkout with payment method selection', platform: 'ios', limit: 10, output_destination: 'design_tool', output_tool: 'Mishh Mashh' } });
    expect(flows.receipt.schemaDigest).toBe(MOBBIN_FROZEN_TOOLS.flows.schemaDigest);
    expect(flows.results.map(item => item.category)).toEqual(['flow · web']);
    const sections = parseConnectorSearchResponse((await search({ query: 'pricing section with plan comparison table', kind: 'sections', limit: 4 })).body);
    expect(toolCalls[1]).toEqual({ tool: 'search_sections', args: { query: 'pricing section with plan comparison table', limit: 4, output_destination: 'design_tool', output_tool: 'Mishh Mashh' } });
    expect(sections.receipt.schemaDigest).toBe(MOBBIN_FROZEN_TOOLS.sections.schemaDigest);
    for (const body of [
      { query: 'x', kind: 'sections', platform: 'web' }, { query: 'x', kind: 'screens' }, { query: 'x', platform: 'web' }, { query: 'x' },
    ]) {
      const refused = await search(body);
      expect(refused.status).toBe(400);
      expect(refused.body.error.code).toBe('connector-request-invalid');
    }
    const motionsitesKind = await search({ query: 'hero', kind: 'screens', platform: 'web' }, 'motionsites');
    expect(motionsitesKind.status).toBe(400);
    expect(toolCalls).toHaveLength(2);
  });

  it('detail returns the captured search reference; Mobbin exposes no detail tool', async () => {
    await bindMobbin();
    await search(screens);
    const response = await detail(ROWS[1]!.id);
    expect(response.status).toBe(200);
    const parsed = parseConnectorDetailResponse(response.body);
    expect(parsed).toMatchObject({ source: 'captured-reference', resource: { title: 'Assembly', canonicalUrl: ROWS[1]!.mobbin_url } });
    expect(toolCalls.map(call => call.tool)).toEqual(['search_screens']);
    expect((await detail('never-seen')).status).toBe(404);
  });

  it('od explicit selection returns the same private image and notice as the HTTP route', async () => {
    await bindMobbin();
    const resource = parseConnectorSearchResponse((await search(screens)).body).results[0]!;
    const cli = await od(['select', '--connector', 'mobbin', '--item', resource.itemId, '--captured-at', resource.capturedAt]);
    expect(cli.code).toBe(0);
    const selected = parseConnectorDetailResponse(cli.body);
    expect(selected.providerNotice).toBe(NOTICE);
    expect((await detail(resource.itemId)).body.resource.cachedImage).toEqual(selected.resource.cachedImage);
    const response = await fetch(`${daemon.url}${selected.resource.cachedImage!.url}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    expect((await fetch(`${daemon.url}${selected.resource.cachedImage!.url}`, { headers: { Origin: 'https://evil.invalid' } })).status).toBe(403);
    expect((await fetch(`${daemon.url}/api/workbench/connectors/mobbin/select`, { method: 'POST', headers: { Origin: 'https://evil.invalid', 'content-type': 'application/json' }, body: JSON.stringify({ itemId: resource.itemId, capturedAt: resource.capturedAt }) })).status).toBe(403);
  });

  it('revoked access is typed and clears captured references', async () => {
    await bindMobbin();
    await search(screens);
    mode = 'revoked';
    const refused = await search(screens);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('connector-access-revoked');
    expect((await detail(ROWS[0]!.id)).body.error.code).toBe('connector-access-revoked');
  });

  it('od passes --kind and --platform to the same route and DTOs', async () => {
    await bindMobbin();
    const promptFile = path.join(dataDir, 'query.txt');
    await writeFile(promptFile, 'pricing page');
    const cli = await od(['search', '--connector', 'mobbin', '--kind', 'screens', '--platform', 'web', '--limit', '3', '--prompt-file', promptFile]);
    expect(cli.code).toBe(0);
    expect(parseConnectorSearchResponse(cli.body).results.map(item => item.itemId)).toEqual(ROWS.map(item => item.id));
    const cliDetail = await od(['detail', '--connector', 'mobbin', '--item', ROWS[2]!.id]);
    expect(cliDetail.code).toBe(0);
    expect(cliDetail.body).toEqual((await detail(ROWS[2]!.id)).body);
    expect((await od(['search', '--connector', 'mobbin', '--kind', 'apps', '--prompt-file', promptFile])).code).toBe(2);
  });

  it('retains frozen schema metadata and parsed rights without claiming the removed private G29 receipts', async () => {
    for (const frozen of Object.values(MOBBIN_FROZEN_TOOLS)) {
      expect(frozen.schemaDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(frozen.evidenceRef).toBe(MOBBIN_EVIDENCE.agentRunReceipt);
    }
    expect(parseRightsAssessment(MOBBIN_RIGHTS_ASSESSMENT)).toEqual(MOBBIN_RIGHTS_ASSESSMENT);
    expect(MOBBIN_RIGHTS_ASSESSMENT.terms).toMatchObject({ canonicalUrl: 'https://mobbin.com/terms', sha256: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(MOBBIN_RIGHTS_ASSESSMENT.terms!.clauseRefs).toEqual(expect.arrayContaining(['3.2.1', '3.2.5', '3.4.1', '3.5']));
    expect(MOBBIN_RIGHTS_ASSESSMENT.source.contentSha256).toBe(MOBBIN_TOOL_SET_DIGEST);
    expect(MOBBIN_RIGHTS_ASSESSMENT.evaluator.basis).toBe('owner-accepted-private-use');
    expect(MOBBIN_RIGHTS_ASSESSMENT.ownerDecision).toEqual(MOBBIN_OWNER_DECISION);
    expect(MOBBIN_OWNER_DECISION.decidedAt).toBe('2026-10-09');
    const right = (operation: string) => MOBBIN_RIGHTS_ASSESSMENT.operationRights.find(item => item.operation === operation)!;
    // The owner rule applies in full: every private operation, including exporting the user's own built app.
    for (const operation of SOURCE_OPERATIONS.filter(item => item !== 'redistribute-unit')) expect(right(operation).decision).toBe('allowed');
    expect(right('export-application').scope.visibility).toBe('finished-application');
    expect(MOBBIN_RIGHTS_ASSESSMENT.revision).toBe(3);
    expect(right('redistribute-unit').decision).toBe('blocked');
  });

  it('R15 reference selection accepts a captured Mobbin reference with attribution under the owner decision', async () => {
    expect(connectorDeriveDecision('mobbin')).toBe('permitted');
    expect(connectorDeriveDecision('motionsites')).toBe('blocked');
    await bindMobbin();
    const found = parseConnectorSearchResponse((await search(screens)).body).results[0]!;
    const ref = connectorResourceRef(found);
    const source = connectorReferenceSource(proxy);
    const context = { principalId: 'local-owner', projectId: 'project-1' };
    const [selected] = await selectReferences([ref], context, source, 2000);
    expect(selected!.document).toMatchObject({ ref, title: 'Patreon', review: 'reviewed', deriveFromReference: 'permitted', projectId: null });
    expect(selected!.document.attribution).toContain('Mobbin');
    expect(selected!.document.attribution).toContain(found.canonicalUrl);
    expect(selected!.document.excerpt).toContain(found.canonicalUrl);
    await expect(selectReferences([{ ...ref, revisionOrDigest: 'captured:2020-01-01T00:00:00.000Z' }], context, source, 2000)).rejects.toMatchObject({ code: 'reference-stale' });
    await expect(selectReferences([{ ...ref, itemId: 'never-captured' }], context, source, 2000)).rejects.toMatchObject({ code: 'reference-unknown' });
    expect(toolCalls).toHaveLength(1);
  });
});
