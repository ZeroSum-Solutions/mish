import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { MCP_SECRET_MASK as M } from '@open-design/contracts';
import { maskMcpServer, restoreMcpSecrets } from '../src/mcp-secrets.js';
import { readMcpConfig, writeMcpConfig } from '../src/mcp-config.js';

let dataDir: string | undefined;
afterEach(async () => { if (dataDir) await rm(dataDir, { recursive: true, force: true }); });

it('masks arbitrary credentials in saved command, positional and short arguments', () => {
  const saved = { id: 'local', transport: 'stdio' as const, enabled: true,
    command: '/private/command-sentinel/server', args: ['-p', 'pw-sentinel', '-k', 'key-sentinel', 'positional-sentinel', 'Authorization: sentinel', 'console.log("script-sentinel")'] };
  const masked = maskMcpServer(saved);
  expect(masked.command).toBe(M);
  expect(masked.args).toEqual(saved.args.map(() => M));
  expect(restoreMcpSecrets([{ ...masked, label: 'Renamed' }], [saved])).toEqual([{ ...saved, label: 'Renamed' }]);
  expect(() => restoreMcpSecrets([{ ...masked, command: 'malicious-command' }], [saved])).toThrow();
});

it.each(['https://mcp.test/path-sentinel', 'https://mcp.test/mcp?pass=pw-sentinel', 'https://mcp.test/mcp?pw=pw-sentinel', 'https://mcp.test/mcp#fragment-sentinel'])('masks the entire saved endpoint %s', url => {
  const saved = { id: 'remote', transport: 'http' as const, enabled: true, authMode: 'oauth' as const, url };
  expect(maskMcpServer(saved).url).toBe(M);
});

it('restores an opaque URL through the actual config save sanitizer', async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-opaque-'));
  const saved = await writeMcpConfig(dataDir, { servers: [{ id: 'remote', transport: 'http', enabled: true, authMode: 'none', url: 'http://localhost:3999/path-sentinel', headers: { Authorization: 'header-sentinel' } }] });
  const incoming = { ...saved.servers[0]!, url: M, headers: { Authorization: M } };
  await writeMcpConfig(dataDir, { servers: [incoming] }, (next, previous) => ({ servers: restoreMcpSecrets(next.servers, previous.servers) }));
  expect(await readMcpConfig(dataDir)).toEqual(saved);
});
