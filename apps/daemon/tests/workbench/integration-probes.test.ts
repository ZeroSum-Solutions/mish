import { ConnectorError } from '../../src/workbench/connectors/connector-error.js';
import { McpCredentialFileError } from '../../src/mcp-private-file.js';
import { mcpEndpointFingerprint } from '../../src/mcp-endpoint.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { createIntegrationProbes } from '../../src/workbench/integration-probes.js';
import { readMcpConfig } from '../../src/mcp-config.js';
import { getToken } from '../../src/mcp-tokens.js';
import { listMotionSitesTools } from '../../src/motionsites/mcp-client.js';
import { McpHttpTransportError } from '../../src/motionsites/mcp-client.js';
vi.mock('../../src/mcp-config.js', async original => ({ ...await original<typeof import('../../src/mcp-config.js')>(), readMcpConfig: vi.fn() }));
vi.mock('../../src/mcp-tokens.js', async original => ({ ...await original<typeof import('../../src/mcp-tokens.js')>(), getToken: vi.fn() }));
vi.mock('../../src/motionsites/mcp-client.js', async original => ({ ...await original<typeof import('../../src/motionsites/mcp-client.js')>(), listMotionSitesTools: vi.fn() }));
const entry = () => buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(row => row.id === 'refero')!;
const lane = () => createIntegrationProbes({ dataDir: '/isolated-stub', skillRoots: [], proxy: { search: vi.fn() } });
beforeEach(() => { vi.resetAllMocks(); vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://api.refero.design/mcp', headers: { 'x-key': 'private-value' } }] }); });
afterEach(() => { vi.unstubAllGlobals(); });
describe('D5 authorized read-only probes', () => {
  it('missing and expired credentials do not dispatch or disclose config', async () => {
    vi.mocked(getToken).mockResolvedValue(null);
    const probes = lane(); const row = entry(); const missing = await probes.inspect(row);
    expect(missing.connection).toBe('missing');
    await expect(probes.probe(row, missing)).rejects.toThrow();
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'secret', tokenType: 'Bearer', savedAt: 0, expiresAt: 1 });
    expect((await probes.inspect(row)).connection).toBe('expired');
    expect(listMotionSitesTools).not.toHaveBeenCalled();
    expect(JSON.stringify(missing)).not.toMatch(/private-value|api.refero.design\/mcp/);
  });
  it('rejects resource-mismatched OAuth before any I/O', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'secret', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://other.example/mcp'), resourceUrl: 'https://other.example/mcp' });
    const probes = lane(); const state = await probes.inspect(entry());
    expect(state.connection).toBe('missing');
    await expect(probes.probe(entry(), state)).rejects.toThrow();
    expect(listMotionSitesTools).not.toHaveBeenCalled();
  });
  it.each([
    ['https://api.refero.design/mcp', 'https://api.refero.design/mcp', true],
    ['https://api.refero.design', 'https://api.refero.design/', false],
    ['https://api.refero.design/mcp/', 'https://api.refero.design/mcp', false],
    ['https://api.refero.design/mcp?scope=other', 'https://api.refero.design/mcp', false],
  ])('compares exact endpoint %s with %s without conflating paths or queries', async (resourceUrl, url, matches) => {
    vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url }] });
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint(resourceUrl), resourceUrl });
    const probes = lane(); const row = entry(); const state = await probes.inspect(row);
    expect(state.connection).toBe(matches ? 'connected' : 'missing');
    if (matches) await probes.probe(row, state);
    else await expect(probes.probe(row, state)).rejects.toThrow();
    expect(listMotionSitesTools).toHaveBeenCalledTimes(matches ? 1 : 0);
  });
  it.each(['Authorization', 'authorization', 'AUTHORIZATION'])('uses a pinned %s header without requiring an OAuth token', async header => {
    vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://api.refero.design/mcp', headers: { [header]: 'Bearer fixture-pinned' } }] });
    vi.mocked(getToken).mockResolvedValue(null);
    vi.mocked(listMotionSitesTools).mockResolvedValue(undefined);
    const probes = lane(); const row = entry(); const state = await probes.inspect(row);
    expect(state.connection).toBe('connected');
    expect((await probes.probe(row, state)).kind).toBe('connection');
    expect(listMotionSitesTools).toHaveBeenCalledWith(expect.objectContaining({ accessToken: '', headers: { [header]: 'Bearer fixture-pinned' } }));
    expect(getToken).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain('fixture-pinned');
  });
  it.each(['', '   '])('a blank Authorization header %j still needs bound OAuth', async header => {
    vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://api.refero.design/mcp', headers: { Authorization: header } }] });
    vi.mocked(getToken).mockResolvedValue(null);
    expect((await lane().inspect(entry())).connection).toBe('missing');
  });
  it('routine OAuth refresh keeps the checked binding identity stable', async () => {
    const probes = lane();
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'before-secret', tokenType: 'Bearer', savedAt: 1, expiresAt: Date.now() + 10_000, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp', clientId: 'same-client' });
    const before = await probes.inspect(entry());
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'after-secret', tokenType: 'Bearer', savedAt: 2, expiresAt: Date.now() + 20_000, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp', clientId: 'same-client' });
    expect((await probes.inspect(entry())).verificationKey).toBe(before.verificationKey);
  });
  it('never sends an inspected token to an endpoint changed before dispatch', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' });
    const probes = lane(); const row = entry(); const state = await probes.inspect(row);
    expect(state.connection).toBe('connected');
    vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://other.example/mcp' }] });
    await expect(probes.probe(row, state)).rejects.toMatchObject({ code: 'connection-missing', runtime: { connection: 'missing', reason: expect.stringMatching(/another endpoint/) } });
    expect(listMotionSitesTools).not.toHaveBeenCalled();
  });
  it.each(['missing', 'expired', 'unbound', 'disabled'] as const)('revalidates %s authorization at dispatch rather than trusting inspection', async change => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' });
    const probes = lane(); const row = entry(); const state = await probes.inspect(row);
    if (change === 'disabled') vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: false, transport: 'http', authMode: 'oauth', url: 'https://api.refero.design/mcp' }] });
    else vi.mocked(getToken).mockResolvedValue(change === 'missing' ? null : { accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, ...(change === 'expired' ? { expiresAt: 1, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' } : {}) });
    await expect(probes.probe(row, state)).rejects.toMatchObject({ code: change === 'expired' ? 'connection-expired' : 'connection-missing' });
    expect(listMotionSitesTools).not.toHaveBeenCalled();
  });
  it('a valid binding uses tools/list as connection-only proof and maps 401 to a fixed expired diagnostic', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'secret', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' });
    vi.mocked(listMotionSitesTools).mockResolvedValue(undefined);
    const probes = lane(); const state = await probes.inspect(entry());
    const result = await probes.probe(entry(), state);
    expect(result.kind).toBe('connection');
    expect(result.runtime.workflow.lastSuccess).toBeNull();
    vi.mocked(listMotionSitesTools).mockRejectedValue(new McpHttpTransportError('Bearer secret-url?key=secret', { status: 401 }));
    await expect(probes.probe(entry(), state)).rejects.toMatchObject({ code: 'connection-expired', runtime: { connection: 'expired', reason: 'MCP authorization was rejected. Sign in again in Settings.' } });
  });
  it('keeps dispatch on the validated resource when config changes during token lookup', async () => {
    const token = { accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' };
    vi.mocked(getToken).mockResolvedValue(token);
    const probes = lane(); const row = entry(); const state = await probes.inspect(row);
    vi.mocked(getToken).mockImplementationOnce(async () => {
      vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'refero', enabled: true, transport: 'http', authMode: 'oauth', url: 'https://other.example/mcp' }] });
      return token;
    });
    await probes.probe(row, state);
    expect(listMotionSitesTools).toHaveBeenCalledWith(expect.objectContaining({ url: token.resourceUrl, accessToken: token.accessToken }));
  });
  it('does not follow redirects that could forward credentials beyond the bound resource', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp'), resourceUrl: 'https://api.refero.design/mcp' });
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: 'https://other.example/mcp' } }));
    vi.stubGlobal('fetch', fetch);
    vi.mocked(listMotionSitesTools).mockImplementationOnce(async options => { await options.fetchImpl(options.url, { method: 'POST' }); });
    const probes = lane(); const row = entry(); await probes.probe(row, await probes.inspect(row));
    expect(fetch).toHaveBeenCalledWith('https://api.refero.design/mcp', expect.objectContaining({ redirect: 'error' }));
  });
});


it.each(['mcp-config.json', 'mcp-tokens.json'])('retains Settings recovery guidance during read-only inspection of unsafe %s', async file => {
  const failure = new McpCredentialFileError(`/synthetic-private-root/${file}`);
  if (file === 'mcp-config.json') vi.mocked(readMcpConfig).mockRejectedValue(failure);
  else vi.mocked(getToken).mockRejectedValue(failure);
  const runtime = await lane().inspect(entry());
  expect(runtime.connection).toBe('missing');
  expect(runtime.reason).toContain(file);
  expect(runtime.reason).toMatch(/Settings/);
  expect(JSON.stringify(runtime)).not.toContain('/synthetic-private-root');
  expect(listMotionSitesTools).not.toHaveBeenCalled();
});
it.each(['mcp-config.json', 'mcp-tokens.json'])('retains typed Settings recovery guidance when testing unsafe %s', async file => {
  vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint('https://api.refero.design/mcp') });
  const probes = lane();
  const current = await probes.inspect(entry());
  expect(current.connection).toBe('connected');
  const failure = new McpCredentialFileError(`/synthetic-private-root/${file}`);
  if (file === 'mcp-config.json') vi.mocked(readMcpConfig).mockRejectedValue(failure);
  else vi.mocked(getToken).mockRejectedValue(failure);
  const error = await probes.probe(entry(), current).catch(error => error);
  expect(error).toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE', runtime: { connection: 'missing', reason: expect.stringContaining(file) } });
  expect(error.runtime.reason).toMatch(/Settings/);
  expect(JSON.stringify(error.runtime)).not.toContain('/synthetic-private-root');
  expect(listMotionSitesTools).not.toHaveBeenCalled();
});


it('preserves local credential recovery from the connector when storage turns unsafe after inspection', async () => {
  const url = 'https://mcp.example.test/mcp';
  vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'motionsites', enabled: true, transport: 'http', authMode: 'oauth', url }] });
  vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, endpointFingerprint: mcpEndpointFingerprint(url) });
  const message = 'mcp-tokens.json cannot be read securely. Open Settings → External MCP servers to repair saved credentials.';
  const search = vi.fn().mockRejectedValue(new ConnectorError(409, 'connector-binding-missing', message, {
    retryable: false, nextSteps: ['Repair saved credentials in Settings → External MCP servers'],
  }));
  const probes = createIntegrationProbes({ dataDir: '/isolated-stub', skillRoots: [], proxy: { search } });
  const row = buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(item => item.id === 'motionsites')!;
  const current = await probes.inspect(row);
  expect(current.connection).toBe('connected');
  const error = await probes.probe(row, current).catch(error => error);
  expect(error).toMatchObject({ code: 'connector-binding-missing', runtime: { connection: 'missing', reason: message } });
  expect(search).toHaveBeenCalledOnce();
  expect(listMotionSitesTools).not.toHaveBeenCalled();
});
