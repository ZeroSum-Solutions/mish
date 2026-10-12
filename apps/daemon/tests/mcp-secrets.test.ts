// B-121 masking rules (`src/mcp-secrets.ts`): what counts as a secret, what never does, and how
// a mask is placed back on PUT.

import { describe, expect, it } from 'vitest';
import { MCP_SECRET_MASK as M } from '@mish/contracts';
import { maskArgs, maskMcpServer, maskUrl, McpSecretMaskError, restoreMcpSecrets } from '../src/mcp-secrets.js';

describe('opaque saved connection fields', () => {
  it('masks all nonempty arguments, retaining empty slots', () => {
    expect(maskArgs(['--token', 'ordinary', '', 'Authorization: sentinel'])).toEqual([M, M, '', M]);
  });
  it('masks a complete URL regardless of credential names or location', () => {
    expect(maskUrl('https://h.test/path?pass=sentinel#fragment')).toBe(M);
    expect(maskUrl('')).toBe('');
  });
});

describe('maskMcpServer', () => {
  it('masks every non-empty header and env value, keeping keys', () => {
    expect(maskMcpServer({ id: 'a', transport: 'http', enabled: true, url: 'https://h.test', headers: { Authorization: 'x', Accept: '' } }).headers)
      .toEqual({ Authorization: M, Accept: '' });
  });
});

describe('restoreMcpSecrets', () => {
  const stored = [{ id: 'a', transport: 'stdio' as const, enabled: true, command: 'npx', args: ['--token', 'T1'], env: { K: 'V' } }];

  it('places each mask back from the same server and slot', () => {
    expect(restoreMcpSecrets([{ ...stored[0]!, args: ['--token', M], env: { K: M } }], stored)).toEqual(stored);
  });

  it('refuses a mask in the wrong slot, a renamed server, a mask inside a longer value, or a mask in any other field', () => {
    const cases = [
      [{ ...stored[0]!, args: [M, '--token'] }],
      [{ ...stored[0]!, id: 'renamed', env: { K: M } }],
      [{ ...stored[0]!, env: { K: `prefix-${M}` } }],
      [{ ...stored[0]!, label: M }],
    ];
    for (const incoming of cases) expect(() => restoreMcpSecrets(incoming, stored), JSON.stringify(incoming)).toThrow(McpSecretMaskError);
  });

  it('never keeps a secret for a re-pointed server: new host, new transport or new command', () => {
    const remote = [{ id: 'r', transport: 'http' as const, enabled: true, url: 'https://mcp.good.test/mcp', headers: { Authorization: 'Bearer T' } }];
    expect(restoreMcpSecrets([{ ...remote[0]!, headers: { Authorization: M } }], remote)[0]!.headers).toEqual({ Authorization: 'Bearer T' });
    expect(() => restoreMcpSecrets([{ ...remote[0]!, url: 'https://attacker.test/mcp', headers: { Authorization: M } }], remote)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...remote[0]!, transport: 'sse', headers: { Authorization: M } }], remote)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...stored[0]!, command: 'sh', env: { K: M } }], stored)).toThrow(McpSecretMaskError);
  });

  it('a masked arg cannot move under another flag or swap with another secret flag', () => {
    const saved = [{ id: 'a', transport: 'stdio' as const, enabled: true, command: 'npx', args: ['--password', 'saved-password!', '--api-key', 'AK', '--token', 'TK'] }];
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['--display', M, '--api-key', M, '--token', M] }], saved)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['--password', M, '--token', M, '--api-key', M] }], saved)).toThrow(McpSecretMaskError);
    expect(restoreMcpSecrets([{ ...saved[0]!, args: ['--password', M, '--api-key', M, '--token', M] }], saved)).toEqual(saved);
  });

  it('a short secret never trips the save because it also appears in an unrelated field', () => {
    const saved = [{ id: 'none', transport: 'http' as const, enabled: true, authMode: 'none' as const, url: 'https://h.test/mcp', headers: { 'X-Mode': 'none' } }];
    expect(restoreMcpSecrets([{ ...saved[0]!, headers: { 'X-Mode': M } }], saved)).toEqual(saved);
  });

  it('rotating one stdio secret needs the others entered again (args are code; the strict rule)', () => {
    const saved = [{ id: 'a', transport: 'stdio' as const, enabled: true, command: 'npx', args: ['--api-key=old-A', '--token=old-B'] }];
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['--api-key=new-A', `--token=${M}`] }], saved)).toThrow(McpSecretMaskError);
    expect(restoreMcpSecrets([{ ...saved[0]!, args: ['--api-key=new-A', '--token=new-B'] }], saved)[0]!.args).toEqual(['--api-key=new-A', '--token=new-B']);
  });

  it('env that adds, changes or deletes a key keeps no secret (Sol rounds 4 and 5)', () => {
    const saved = [{ id: 'n', transport: 'stdio' as const, enabled: true, command: 'node', args: ['./mcp.mjs'], env: { API_KEY: 'K', NODE_OPTIONS: '--max-old-space-size=512', DEBUG: '1' } }];
    expect(() => restoreMcpSecrets([{ ...saved[0]!, env: { API_KEY: M, NODE_OPTIONS: M, DEBUG: M, EXTRA: '--require ./inject.cjs' } }], saved)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...saved[0]!, env: { API_KEY: M, NODE_OPTIONS: '--require ./inject.cjs', DEBUG: M } }], saved)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...saved[0]!, env: { API_KEY: M, NODE_OPTIONS: M } }], saved)).toThrow(McpSecretMaskError);
    expect(restoreMcpSecrets([{ ...saved[0]!, env: { API_KEY: M, NODE_OPTIONS: M, DEBUG: M } }], saved)).toEqual(saved);
  });

  it('header-shaped code cannot be rewritten under its masked projection (Sol round 4)', () => {
    const saved = [{ id: 'n', transport: 'stdio' as const, enabled: true, command: 'node', args: ['-e', 'Authorization: void 0', '--header', 'Authorization: secret'] }];
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['-e', 'Authorization: console.log(process.argv[3])', '--header', `Authorization: ${M}`] }], saved)).toThrow(McpSecretMaskError);
  });

  it('a kept header needs the same URL, not just the same origin (Sol round 4)', () => {
    const remote = [{ id: 'r', transport: 'http' as const, enabled: true, url: 'https://mcp.good.test/mcp?team=a', headers: { Authorization: 'Bearer T' } }];
    expect(() => restoreMcpSecrets([{ ...remote[0]!, url: 'https://mcp.good.test/other', headers: { Authorization: M } }], remote)).toThrow(McpSecretMaskError);
    expect(() => restoreMcpSecrets([{ ...remote[0]!, url: 'https://mcp.good.test/mcp?team=b', headers: { Authorization: M } }], remote)).toThrow(McpSecretMaskError);
    expect(restoreMcpSecrets([{ ...remote[0]!, headers: { Authorization: M } }], remote)).toEqual(remote);
  });

  it('an unchanged round trip never fails because a secret is also a substring of another value', () => {
    for (const args of [['--password', '1', '--port', '1234'], ['--password', 'OD']]) {
      const saved = [{ id: 'a', transport: 'stdio' as const, enabled: true, command: 'npx', args }];
      const masked = maskMcpServer(saved[0]!);
      expect(restoreMcpSecrets([{ ...masked, label: 'renamed' }], saved)[0]!.args, JSON.stringify(args)).toEqual(args);
    }
  });

  it('a stdio server whose args change keeps no secret: no exfiltration through new code', () => {
    const saved = [{ id: 'n', transport: 'stdio' as const, enabled: true, command: 'node', args: ['./mcp.mjs', '--header', 'Authorization: secret'], env: { API_KEY: 'K' } }];
    // Sol round 3: the composite header re-bound to an `-e` script.
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['-e', 'console.log(process.argv[1])', `Authorization: ${M}`] }], saved)).toThrow(McpSecretMaskError);
    // The same trick through a kept env value.
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['-e', 'console.log(process.env.API_KEY)'], env: { API_KEY: M } }], saved)).toThrow(McpSecretMaskError);
    // An unrelated arg change also needs the secrets entered again (documented trade-off).
    expect(() => restoreMcpSecrets([{ ...saved[0]!, args: ['./mcp.mjs', '--header', `Authorization: ${M}`, '--verbose'], env: { API_KEY: M } }], saved)).toThrow(McpSecretMaskError);
    // Unchanged args keep everything.
    expect(restoreMcpSecrets([{ ...saved[0]!, args: ['./mcp.mjs', '--header', M], env: { API_KEY: M } }], saved)).toEqual(saved);
  });

  it('errors name the server and field, never a value', () => {
    try {
      restoreMcpSecrets([{ ...stored[0]!, env: { K: `x${M}` } }], stored);
      expect.unreachable();
    } catch (error) {
      expect((error as Error).message).not.toContain('V');
      expect((error as Error).message).toContain('env K');
    }
  });
});

describe('restoreMcpSecrets: only an otherwise unchanged server keeps its secrets (Sol round 5)', () => {
  it('deleting an env key, adding a routing header or changing any header keeps no secret', () => {
    const stdio = [{ id: 's', transport: 'stdio' as const, enabled: true, command: 'node', args: ['./mcp.mjs'], env: { API_KEY: 'K', MCP_ENDPOINT: 'https://good.test' } }];
    expect(() => restoreMcpSecrets([{ ...stdio[0]!, env: { API_KEY: M } }], stdio)).toThrow(McpSecretMaskError);
    const http = [{ id: 'h', transport: 'http' as const, enabled: true, url: 'https://good.test/mcp', headers: { Authorization: 'Bearer T' } }];
    expect(() => restoreMcpSecrets([{ ...http[0]!, headers: { Authorization: M, 'X-Original-URL': '/attacker' } }], http)).toThrow(McpSecretMaskError);
  });

  it('label, enabled and templateId may change; everything kept', () => {
    const http = [{ id: 'h', transport: 'http' as const, enabled: true, authMode: 'none' as const, url: 'https://good.test/mcp?api_key=Q', headers: { Authorization: 'Bearer T' } }];
    const sent = { ...http[0]!, label: 'Renamed', enabled: false, templateId: 'custom', url: M, headers: { Authorization: M } };
    expect(restoreMcpSecrets([sent], http)).toEqual([{ ...http[0]!, label: 'Renamed', enabled: false, templateId: 'custom' }]);
  });

  it('switching to managed OAuth keeps no secret (Sol round 6): the URL would enter an authorization flow', () => {
    const http = [{ id: 'h', transport: 'http' as const, enabled: true, authMode: 'none' as const, url: 'https://good.test/mcp?api_key=Q' }];
    expect(() => restoreMcpSecrets([{ ...http[0]!, authMode: 'oauth', url: M }], http)).toThrow(McpSecretMaskError);
  });
});


it.each(['accessKey', 'clientKey', 'api.key'])('masks a saved URL credential named %s', name => {
  expect(maskUrl(`https://mcp.example.test/mcp?${name}=synthetic-query-canary`)).toBe(M);
});
