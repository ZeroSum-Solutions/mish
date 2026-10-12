import { mkdtemp, rm, stat, symlink, writeFile, readFile, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readMcpConfig } from '../src/mcp-config.js';
import { readTokensFile } from '../src/mcp-tokens.js';
import { getOrRegisterClient } from '../src/mcp-oauth.js';

let dataDir: string;
beforeEach(async () => { dataDir = await mkdtemp(path.join(tmpdir(), 'mcp-private-read-')); });
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
const cached = { authServerIssuer: 'https://auth.test', redirectUri: 'https://app.test/callback', clientId: 'id', clientSecret: 'synthetic-secret' };
const readers = [
  { file: 'mcp-config.json', body: { servers: [] }, read: () => readMcpConfig(dataDir) },
  { file: 'mcp-tokens.json', body: { servers: {} }, read: () => readTokensFile(dataDir) },
  { file: 'mcp-oauth-clients.json', body: { clients: [cached] }, read: () => getOrRegisterClient(dataDir, { issuer: cached.authServerIssuer } as never, cached.redirectUri) },
];
it.skipIf(process.platform === 'win32').each(readers)('tightens legacy $file to owner-only on read', async entry => {
  const file = path.join(dataDir, entry.file);
  await writeFile(file, JSON.stringify(entry.body), { mode: 0o644 });
  await entry.read();
  expect((await stat(file)).mode & 0o777).toBe(0o600);
});
it.skipIf(process.platform === 'win32').each(readers)('refuses symlink $file without modifying its unrelated target', async entry => {
  const target = path.join(dataDir, 'unrelated.json');
  const contents = JSON.stringify(entry.body);
  await writeFile(target, contents, { mode: 0o644 });
  await symlink(target, path.join(dataDir, entry.file));
  await expect(entry.read()).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE' });
  expect((await stat(target)).mode & 0o777).toBe(0o644);
  expect(await readFile(target, 'utf8')).toBe(contents);
});

it.skipIf(process.platform === 'win32')('refuses credential bytes when owner-only permissions cannot be established', async () => {
  const file = path.join(dataDir, 'mcp-config.json');
  await writeFile(file, '{"servers":[]}', { mode: 0o644 });
  const handle = await open(file, 'r');
  const prototype = Object.getPrototypeOf(handle) as { chmod: (mode: number) => Promise<void> };
  await handle.close();
  const chmod = vi.spyOn(prototype, 'chmod').mockRejectedValue(new Error('synthetic-permission-denied'));
  try {
    await expect(readMcpConfig(dataDir)).rejects.toMatchObject({ code: 'MCP_CREDENTIAL_FILE_UNSAFE' });
    expect((await stat(file)).mode & 0o777).toBe(0o644);
  } finally { chmod.mockRestore(); }
});
