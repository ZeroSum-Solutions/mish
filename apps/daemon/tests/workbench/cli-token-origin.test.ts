import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it, vi } from 'vitest';
import { runWorkbenchCli } from '../../src/workbench-cli.js';
import { runFontCheckCli } from '../../src/workbench/font-cli.js';
import { runIntegrationsCli } from '../../src/workbench/integrations-cli.js';

import { runConnectorsToolCli } from '../../src/tools-connectors-cli.js';
import { runLiveArtifactsToolCli } from '../../src/tools-live-artifacts-cli.js';
import { runDesignSystemsToolCli } from '../../src/tools-design-systems-cli.js';
import { runDeliverableSyntaxToolCli } from '../../src/tools-deliverable-syntax-cli.js';

import { handleLiveArtifactsMcpRequest } from '../../src/mcp-live-artifacts-server.js';

const servers: Server[] = [];
afterEach(async () => { vi.unstubAllEnvs(); vi.restoreAllMocks(); await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve())))); });
async function listener(redirect?: () => string) {
  const observed: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    observed.push(req.headers.authorization);
    req.resume();
    if (redirect && req.url !== '/redirect-target') { res.writeHead(307, { location: redirect() }); res.end(); return; }
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'SYNTHETIC_SCOPE_REFUSAL', message: 'Synthetic scope refusal' } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, observed };
}
async function tool(invoke: () => Promise<{ exitCode: number }>, env: NodeJS.ProcessEnv, url: string) {
  vi.stubEnv('OD_DAEMON_URL', url);
  vi.stubEnv('OD_TOOL_TOKEN', env.OD_TOOL_TOKEN);
  vi.stubEnv('OD_TOOL_TOKEN_ISSUER_ORIGIN', env.OD_TOOL_TOKEN_ISSUER_ORIGIN);
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  try { return (await invoke()).exitCode; } finally { stdout.mockRestore(); stderr.mockRestore(); }
}
const clients = [
  { name: 'font-check', invoke: (env: NodeJS.ProcessEnv, url: string) => runFontCheckCli(['--ref', 'synthetic-font', '--daemon-url', url, '--json'], { env, write: () => {} }) },
  { name: 'integrations', invoke: (env: NodeJS.ProcessEnv, url: string) => runIntegrationsCli(['integrations', '--daemon-url', url, '--json'], { env, write: () => {} }) },
  ...[
    ['resources', ['search', '--json']],
    ['context', ['context', 'get', '--project', 'synthetic-project', '--json']],
    ['model', ['model', 'get', '--project', 'synthetic-project', '--session', 'synthetic-session', '--json']],
    ['review', ['review', 'list', '--project', 'synthetic-project', '--json']],
    ['intake', ['intake', 'show', '--json']],
    ['adoption', ['adoption', 'status', '--json']],
    ['owned imports', ['import', 'list', '--json']],
    ['connectors', ['connector', 'detail', '--connector', 'refero', '--item', 'synthetic-item', '--json']],
    ['brief', ['brief', 'show', '--project', 'synthetic-project', '--brief', 'synthetic-brief', '--json']],
    ['recipes', ['recipe', 'preview', '--ref', 'synthetic-ref', '--out', '/synthetic-custody-unused.html', '--json']],
  ].map(([name, args]) => ({ name: name as string, invoke: (env: NodeJS.ProcessEnv, url: string) => runWorkbenchCli([...(args as string[]), '--daemon-url', url], { env, write: () => {} }) })),
  { name: 'MCP live artifacts companion', refusalCode: 1, invoke: (env: NodeJS.ProcessEnv, url: string) => tool(async () => {
    const response = await handleLiveArtifactsMcpRequest({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'live_artifacts_list' } });
    expect(response).toHaveProperty('error');
    return { exitCode: 1 };
  }, env, url) },
  ...[
    ['tools connectors', () => runConnectorsToolCli(['list', '--format', 'json'])],
    ['tools live artifacts', () => runLiveArtifactsToolCli(['list'])],
    ['tools design systems', () => runDesignSystemsToolCli(['read', '--path', 'preview/colors.html'])],
    ['tools deliverable syntax', () => runDeliverableSyntaxToolCli(['check', '--json'])],
  ].map(([name, invoke]) => ({ name: name as string, refusalCode: 1, rejectsRedirect: name === 'tools design systems', invoke: (env: NodeJS.ProcessEnv, url: string) => tool(invoke as () => Promise<{ exitCode: number }>, env, url) })),
];
for (const client of clients) {
  const refusalCode = 'refusalCode' in client ? client.refusalCode : 3;
  it(`${client.name} keeps a scoped bearer at its issuing origin`, async () => {
    const issuer = await listener();
    const foreign = await listener();
    const env = { OD_TOOL_TOKEN: 'synthetic-origin-custody-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer.origin };
    expect(await client.invoke(env, issuer.origin)).toBe(refusalCode);
    expect(issuer.observed).toEqual(['Bearer synthetic-origin-custody-token']);
    expect(await client.invoke(env, foreign.origin)).toBe(refusalCode);
    expect(foreign.observed).toEqual([undefined]);
    expect(env.OD_TOOL_TOKEN).toBe('synthetic-origin-custody-token');
  });
  it.each([undefined, 'not-an-origin'])(`${client.name} omits a scoped bearer without a valid issuer (%s)`, async issuer => {
    const destination = await listener();
    expect(await client.invoke({ OD_TOOL_TOKEN: 'synthetic-origin-custody-token', ...(issuer ? { OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer } : {}) }, destination.origin)).toBe(refusalCode);
    expect(destination.observed).toEqual([undefined]);
  });
  it(`${client.name} refuses an authenticated redirect before a second origin is contacted`, async () => {
    const foreign = await listener();
    const issuer = await listener(() => `${foreign.origin}/redirect-target`);
    const request = client.invoke({ OD_TOOL_TOKEN: 'synthetic-origin-custody-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer.origin }, issuer.origin);
    if ('rejectsRedirect' in client && client.rejectsRedirect) await expect(request).rejects.toThrow('fetch failed');
    else expect(await request).toBe(1);
    expect(issuer.observed).toEqual(['Bearer synthetic-origin-custody-token']);
    expect(foreign.observed).toEqual([]);
  });
  if (!('refusalCode' in client)) it(`${client.name} retains ordinary unauthenticated redirect behavior`, async () => {
    const destination = await listener();
    const source = await listener(() => `${destination.origin}/public`);
    expect(await client.invoke({}, source.origin)).toBe(refusalCode);
    expect(destination.observed).toEqual([undefined]);
  });
}

it('font-check refuses a same-origin redirect rather than replaying scoped authority at another route', async () => {
  const issuer = await listener(() => `${issuer.origin}/redirect-target`);
  expect(await runFontCheckCli(['--ref', 'synthetic-font', '--daemon-url', issuer.origin, '--json'], {
    env: { OD_TOOL_TOKEN: 'synthetic-origin-custody-token', OD_TOOL_TOKEN_ISSUER_ORIGIN: issuer.origin }, write: () => {},
  })).toBe(1);
  expect(issuer.observed).toEqual(['Bearer synthetic-origin-custody-token']);
});

// Valid initial DTOs deliberately reach the actual follow-up transports. These
// synthetic servers do not stand in for a provider or authorization decision.
const custodyCases = ['matching', 'foreign', 'missing', 'invalid'] as const;
async function followupListener(reply: (pathname: string) => { status: number; body?: unknown; redirect?: string }) {
  const observed: { pathname: string; method: string; authorization: string | undefined; workspaceId?: string | string[]; workspaceMemberId?: string | string[] }[] = [];
  const server = createServer((req, res) => {
    const pathname = req.url!;
    observed.push({ pathname, method: req.method!, authorization: req.headers.authorization,
      ...(req.headers['x-od-workspace-id'] ? { workspaceId: req.headers['x-od-workspace-id'] } : {}),
      ...(req.headers['x-od-workspace-member-id'] ? { workspaceMemberId: req.headers['x-od-workspace-member-id'] } : {}),
    });
    req.resume();
    const response = reply(pathname);
    res.writeHead(response.status, response.redirect ? { location: response.redirect } : { 'content-type': 'application/json' });
    res.end(JSON.stringify(response.body ?? { error: { code: 'SYNTHETIC_SCOPE_REFUSAL', message: 'Synthetic follow-up refusal' } }));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, observed };
}
function followupEnv(kind: typeof custodyCases[number], origin: string, foreign: string): NodeJS.ProcessEnv {
  return { OD_TOOL_TOKEN: 'synthetic-followup-custody', ...(kind === 'missing' ? {} : { OD_TOOL_TOKEN_ISSUER_ORIGIN: kind === 'matching' ? origin : kind === 'foreign' ? foreign : 'not-an-origin' }) };
}
const followupDetail = {
  resource: {
    refKey: 'synthetic-ref', ref: { sourceType: 'plugin', sourceId: 'plugins', itemId: 'synthetic-preview', revisionOrDigest: 'synthetic-revision' },
    title: 'Synthetic preview', category: 'motion', readiness: 'unverified', rightsStatus: 'unknown', fitReasons: [],
    compatibility: { nativeFormat: 'html', targets: [], state: 'unverified', reason: null },
    previewCapability: { available: true, kind: 'html', url: '/synthetic-preview', reason: null },
    adoptionCapability: { available: false, reason: 'Synthetic fixture' }, sourceAttribution: { title: 'Synthetic fixture' },
    operationGrants: [], admissionStage: 'discovered', needDecision: 'not-assessed', needReason: 'Synthetic fixture',
  },
  sourceStatus: { sourceId: 'plugins', state: 'searched', reason: null, itemCount: 1, listingDigest: 'synthetic-listing' },
};
const batchId = '00000000-0000-4000-8000-000000000001';
const fileId = '00000000-0000-4000-8000-000000000002';
const followupBatch = {
  intakeBatchId: batchId, revision: 1, destination: { kind: 'pending' }, createdAt: 0, updatedAt: 0,
  files: [{ clientFileId: fileId, order: 0, descriptor: { clientFileId: fileId, order: 0, filename: 'synthetic.txt', size: 3 }, state: 'stored',
    stored: { assetId: 'synthetic-asset', contentHash: 'a'.repeat(64), size: 3, filename: 'synthetic.txt', detectedMime: 'text/plain', kind: 'text', downloadUrl: `/api/workbench/intake/${batchId}/files/${fileId}/download` },
    retryable: false, hasSuccessfulAttachment: false }],
};
const createdAt = '2026-10-09T00:00:00.000Z';
const followupReview = {
  run: {
    schema: 'workbench-review-run/1', id: 'rr_synthetic_custody', projectId: 'synthetic-project',
    operation: { id: 'op_synthetic_custody', kind: 'collect-review', status: 'running', stage: 'mechanical', interruptReason: null, attempt: 1, idempotencyKey: 'synthetic', inputDigest: 'a'.repeat(64), cancelRequested: false, error: null, createdAt, updatedAt: createdAt },
    frozen: { snapshot: { entry: 'synthetic.html', versionId: null, contentDigest: null }, scope: { kind: 'all' }, rubricRevision: 0, contextRevision: 0, sourceHashes: [], plan: { mechanicalCheckIds: [], judgmentCheckIds: [], manualCheckIds: [], reviewers: [] }, reviewerModelIds: [] },
    bundleId: null, screenshotEvidenceIds: [], reviewers: [], findings: [], completedIndependentReviewers: 0, outcome: null, reasons: [], incompleteCheckIds: [], createdAt, endedAt: null,
  },
  freshness: { state: 'current', reasons: [] },
};
const followups = [
  {
    name: 'recipe preview after valid detail', target: '/synthetic-preview', expectedPaths: ['/api/workbench/resources/synthetic-ref', '/synthetic-preview'],
    initial: () => followupDetail,
    invoke: (env: NodeJS.ProcessEnv, url: string) => runWorkbenchCli(['recipe', 'preview', '--ref', 'synthetic-ref', '--out', '/synthetic-custody-unused.html', '--daemon-url', url, '--json'], { env, write: () => {} }),
  },
  {
    name: 'intake download after stored receipt', target: `/api/workbench/intake/${batchId}/files/${fileId}/download`, expectedPaths: [`/api/workbench/intake/${batchId}`, `/api/workbench/intake/${batchId}/files/${fileId}/download`],
    initial: () => followupBatch,
    invoke: (env: NodeJS.ProcessEnv, url: string) => runWorkbenchCli(['intake', 'download', '--batch', batchId, '--file-id', fileId, '--output', '/synthetic-custody-unused.bin', '--daemon-url', url, '--json'], { env, write: () => {} }),
  },
  {
    name: 'review default resolution and wait after valid start', target: '/api/workbench/reviews/rr_synthetic_custody',
    expectedPaths: ['/api/active', '/api/projects/synthetic-project/files', '/api/workbench/projects/synthetic-project/reviews', '/api/workbench/reviews', '/api/workbench/reviews/rr_synthetic_custody'],
    initial: (pathname: string) => pathname === '/api/active' ? { active: true, projectId: 'synthetic-project', fileName: 'synthetic.html' }
      : pathname.endsWith('/files') ? { files: [{ name: 'synthetic.html', type: 'file' }] }
        : pathname.endsWith('/projects/synthetic-project/reviews') ? { runs: [] } : followupReview,
    invoke: (env: NodeJS.ProcessEnv, url: string) => runWorkbenchCli(['review', 'start', '--project', 'synthetic-project', '--input-file', '-', '--wait', '--daemon-url', url, '--json'], { env, readStdin: async () => JSON.stringify({ snapshot: {}, scope: { kind: 'all' }, rubricRevision: 0, reviewerPlan: { reviewers: [{ role: 'jev-text', required: true }] } }), write: () => {} }),
  },
];
for (const client of followups) {
  it.each(custodyCases)(`${client.name} reaches the follow-up with %s issuer custody`, async kind => {
    const foreign = await listener();
    const server = await followupListener(pathname => pathname === client.target ? { status: 403 } : { status: 200, body: client.initial(pathname) });
    const env = followupEnv(kind, server.origin, foreign.origin), original = { ...env };
    expect(await client.invoke(env, server.origin)).toBe(client.name.startsWith('review') ? 1 : 3);
    expect(server.observed.map(row => row.pathname)).toEqual(client.expectedPaths);
    expect(server.observed.map(row => row.authorization)).toEqual(client.expectedPaths.map(() => kind === 'matching' ? 'Bearer synthetic-followup-custody' : undefined));
    expect(env).toEqual(original);
    expect(foreign.observed).toEqual([]);
  });
  it(`${client.name} refuses an authenticated follow-up redirect`, async () => {
    const target = await listener();
    const server = await followupListener(pathname => pathname === client.target ? { status: 307, redirect: target.origin } : { status: 200, body: client.initial(pathname) });
    expect(await client.invoke(followupEnv('matching', server.origin, target.origin), server.origin)).toBe(1);
    expect(server.observed.map(row => row.pathname)).toEqual(client.expectedPaths);
    expect(server.observed.every(row => row.authorization === 'Bearer synthetic-followup-custody')).toBe(true);
    expect(target.observed).toEqual([]);
  });
}

it.each(custodyCases)('created-session model PUT preserves its original explicit workspace lane despite %s ambient issuer', async kind => {
  const foreign = await listener(), server = await followupListener(() => ({ status: 403 }));
  const env = followupEnv(kind, server.origin, foreign.origin);
  vi.stubEnv('OD_TOOL_TOKEN', env.OD_TOOL_TOKEN);
  vi.stubEnv('OD_TOOL_TOKEN_ISSUER_ORIGIN', env.OD_TOOL_TOKEN_ISSUER_ORIGIN);
  const { applyCreatedSessionChoice } = await import('../../src/workbench/model-cli.js');
  expect(await applyCreatedSessionChoice(server.origin, 'synthetic-project', { conversation: { id: 'synthetic-created-session' } }, { agentId: 'claude', modelId: 'default' }, { 'x-od-workspace-id': 'synthetic-workspace', 'x-od-workspace-member-id': 'synthetic-member' })).toMatchObject({ partial: { projectId: 'synthetic-project', conversationId: 'synthetic-created-session', status: 403 } });
  expect(server.observed).toEqual([{ pathname: '/api/workbench/sessions/synthetic-created-session/model', method: 'PUT', authorization: undefined, workspaceId: 'synthetic-workspace', workspaceMemberId: 'synthetic-member' }]);
  expect(foreign.observed).toEqual([]);
});
it('created-session model PUT retains ordinary redirect behavior without adding ambient run authority', async () => {
  const target = await listener(), server = await followupListener(() => ({ status: 307, redirect: target.origin }));
  vi.stubEnv('OD_TOOL_TOKEN', 'synthetic-followup-custody'); vi.stubEnv('OD_TOOL_TOKEN_ISSUER_ORIGIN', server.origin);
  const { applyCreatedSessionChoice } = await import('../../src/workbench/model-cli.js');
  expect(await applyCreatedSessionChoice(server.origin, 'synthetic-project', { conversation: { id: 'synthetic-created-session' } }, { agentId: 'claude', modelId: 'default' }, {})).toEqual({ partial: { code: 'session-model-create-partial', projectId: 'synthetic-project', conversationId: 'synthetic-created-session', status: 403 } });
  expect(server.observed).toHaveLength(1); expect(server.observed[0]?.authorization).toBeUndefined();
  expect(target.observed).toEqual([undefined]);
});
