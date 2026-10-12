import { mcpEndpointFingerprint } from '../../src/mcp-endpoint.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeMcpConfig } from '../../src/mcp-config.js';
import { setToken } from '../../src/mcp-tokens.js';
import { ConnectorProxy } from '../../src/workbench/connectors/connector-proxy.js';

export const referoScreen = { uuid: 'u1', refero_url: 'https://refero.design/s/u1', site: { name: 'Notion' }, platform: 'web' };
export const mobbinSection = { index: 1, id: 's1', image_url: 'https://cdn.mobbin.com/s1.png', mobbin_url: 'https://mobbin.com/sections/s1', site_name: 'Linear' };

/** Real proxy and MCP transport; only the remote providers are replaced. */
export async function referenceProviderFixture(rows: { refero?: unknown[]; mobbin?: unknown[] } = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'reference-provider-'));
  try {
    const endpoints = { refero: 'https://api.refero.design/mcp', mobbin: 'https://api.mobbin.com/mcp' };
    const servers = (['refero', 'mobbin'] as const).map(id => ({ id, enabled: true, transport: 'http' as const, authMode: 'oauth' as const, url: endpoints[id] }));
    await writeMcpConfig(dataDir, { servers });
    for (const server of servers) await setToken(dataDir, server.id, { accessToken: 'fixture-token', tokenType: 'Bearer', endpointFingerprint: mcpEndpointFingerprint(server.url), resourceUrl: server.url, savedAt: Date.now() });
    const schema = { type: 'object', properties: { query: { type: 'string' }, platform: { type: 'string', enum: ['web', 'ios'] }, response_format: { type: 'string', enum: ['json', 'md'] } }, required: ['query', 'platform'] };
    const fetchImpl: typeof fetch = async (url, init) => {
      const source = servers.find(server => server.url === String(url))?.id;
      if (!source) throw new Error('Unexpected provider URL');
      const request = JSON.parse(String(init?.body));
      if (request.method === 'notifications/initialized') return new Response(null, { status: 202 });
      let result: unknown;
      if (request.method === 'initialize') result = { protocolVersion: '2025-06-18', capabilities: { tools: {} } };
      else if (request.method === 'tools/list' && source === 'refero') result = { tools: ['refero_search_screens', 'refero_search_flows'].map(name => ({ name, inputSchema: schema })) };
      else if (request.method === 'tools/call' && source === 'refero' && ['refero_search_screens', 'refero_search_flows'].includes(request.params.name)) {
        result = { content: [{ type: 'text', text: JSON.stringify({ pagination: {}, records: rows.refero ?? [referoScreen] }) }] };
      } else if (request.method === 'tools/call' && source === 'mobbin' && request.params.name === 'search_sections') {
        result = { structuredContent: { sections: rows.mobbin ?? [mobbinSection] }, content: [] };
      } else throw new Error('Unexpected MCP request');
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    };
    return { proxy: new ConnectorProxy({ dataDir, fetchImpl, timeoutMs: 1000 }), dispose: () => rm(dataDir, { recursive: true, force: true }) };
  } catch (error) {
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
}
