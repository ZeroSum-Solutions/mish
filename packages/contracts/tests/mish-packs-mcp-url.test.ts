// The MCP server URL guard in a Mish pack manifest: a pack must not carry a literal credential in
// the URL's query, path, user info or fragment. Every value here is invented.

import { describe, expect, it } from 'vitest';

import { mishPackManifestSchema } from '../src/api/mish-packs.js';

const FAKE_KEY = `sk-${'a'.repeat(24)}`;

function accepts(url: string): boolean {
  return mishPackManifestSchema.safeParse({
    schemaVersion: 1,
    id: 'test-pack',
    name: 'Test pack',
    version: '1',
    provides: { mcpServers: [{ id: 'srv', transport: 'http', url }] },
  }).success;
}

describe('Mish pack MCP server url', () => {
  it('accepts a plain url and harmless query parameters', () => {
    expect(accepts('https://mcp.example.test/mcp')).toBe(true);
    expect(accepts('https://mcp.example.test/mcp?region=eu&format=json')).toBe(true);
    expect(accepts('https://mcp.example.test/v1/servers/abc?mode=fast')).toBe(true);
  });

  it('refuses credential-like query names whatever their spelling', () => {
    for (const name of ['api_key', 'api-key', 'API-KEY', 'apiKey', 'access_token', 'x-auth-token', 'client-secret', 'password', 'auth', 'sig']) {
      expect(accepts(`https://mcp.example.test/mcp?${name}=abc`), name).toBe(false);
    }
    // Percent-encoded names are decoded before they are compared.
    expect(accepts('https://mcp.example.test/mcp?api%2Dkey=abc')).toBe(false);
    expect(accepts(`https://mcp.example.test/mcp?api-key=${FAKE_KEY}`)).toBe(false);
  });

  it('refuses a credential shape in any query value, path segment, user info or fragment', () => {
    expect(accepts(`https://mcp.example.test/mcp?q=${FAKE_KEY}`)).toBe(false);
    expect(accepts(`https://mcp.example.test/mcp?q=${encodeURIComponent(FAKE_KEY)}`)).toBe(false);
    expect(accepts(`https://mcp.example.test/${FAKE_KEY}/mcp`)).toBe(false);
    expect(accepts(`https://mcp.example.test/mcp/ghp_${'b'.repeat(30)}`)).toBe(false);
    expect(accepts(`https://${FAKE_KEY}@mcp.example.test/mcp`)).toBe(false);
    expect(accepts(`https://mcp.example.test/mcp#${FAKE_KEY}`)).toBe(false);
  });

  it('still refuses placeholders in the url', () => {
    expect(accepts('https://mcp.example.test/mcp?api-key=${MCP_KEY}')).toBe(false);
  });
});
