import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildIntegrationRoster } from '../../src/workbench/integration-roster.js';
import { createIntegrationProbes } from '../../src/workbench/integration-probes.js';
import { readMcpConfig, type McpServerConfig } from '../../src/mcp-config.js';
import { getToken } from '../../src/mcp-tokens.js';
import { mcpEndpointFingerprint } from '../../src/mcp-endpoint.js';

vi.mock('../../src/mcp-config.js', async original => ({ ...await original<typeof import('../../src/mcp-config.js')>(), readMcpConfig: vi.fn() }));
vi.mock('../../src/mcp-tokens.js', async original => ({ ...await original<typeof import('../../src/mcp-tokens.js')>(), getToken: vi.fn() }));

/** A real loopback MCP endpoint that records every request's headers. */
let server: Server;
let url: string;
const seen: IncomingHttpHeaders[] = [];
beforeEach(async () => {
  vi.resetAllMocks();
  seen.length = 0;
  server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += chunk; });
    req.on('end', () => {
      seen.push(req.headers);
      const body = JSON.parse(raw) as { id?: number; method: string };
      if (body.id === undefined) { res.writeHead(202).end(); return; }
      const result = body.method === 'tools/list' ? { tools: [] } : { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub', version: '1' } };
      res.writeHead(200, { 'content-type': 'application/json', 'mcp-session-id': 'stub-session' }).end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
});
afterEach(async () => { await new Promise(resolve => server.close(resolve)); });

const jev = () => buildIntegrationRoster({ mcpServers: [], licences: [] }).entries.find(row => row.id === 'jev')!;
async function testBinding(binding: Partial<McpServerConfig>) {
  vi.mocked(readMcpConfig).mockResolvedValue({ servers: [{ id: 'jev', enabled: true, transport: 'http', url, ...binding } as McpServerConfig] });
  const probes = createIntegrationProbes({ dataDir: '/isolated-stub', skillRoots: [], proxy: { search: vi.fn() } });
  const state = await probes.inspect(jev());
  expect(state.connection).toBe('connected');
  return probes.probe(jev(), state);
}

describe('V03-2 HTTP MCP probe authorization header', () => {
  it('sends no Authorization header at all to a no-auth binding', async () => {
    expect((await testBinding({ authMode: 'none' })).operation).toBe('mcp-tools-list');
    expect(seen.length).toBe(3);
    for (const headers of seen) expect(headers).not.toHaveProperty('authorization');
    expect(getToken).not.toHaveBeenCalled();
  });

  it('drops a blank pinned Authorization header instead of sending it empty', async () => {
    await testBinding({ authMode: 'none', headers: { Authorization: '  ' } });
    for (const headers of seen) expect(headers).not.toHaveProperty('authorization');
  });

  it('keeps a pinned Authorization header from the binding unchanged', async () => {
    await testBinding({ authMode: 'none', headers: { Authorization: 'Bearer fixture-pinned' } });
    expect(seen.length).toBe(3);
    for (const headers of seen) expect(headers.authorization).toBe('Bearer fixture-pinned');
  });

  it('still sends the bound OAuth token as a Bearer header', async () => {
    vi.mocked(getToken).mockResolvedValue({ accessToken: 'fixture-token', tokenType: 'Bearer', savedAt: 0, resourceUrl: url, endpointFingerprint: mcpEndpointFingerprint(url) });
    await testBinding({ authMode: 'oauth' });
    expect(seen.length).toBe(3);
    for (const headers of seen) expect(headers.authorization).toBe('Bearer fixture-token');
  });
});
