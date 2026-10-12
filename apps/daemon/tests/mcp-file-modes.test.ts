// B-121: the temp file each MCP config/token write renames into place is opened owner-only
// (0600) and exclusively before a byte is written. A partial write removes this attempt's own
// file; an exclusive-create collision leaves the other writer's file alone.
// `node:fs/promises` `open` and `rm` are wrapped to record and inject failures.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const opens: Array<{ file: string; flags: unknown; mode: unknown }> = [];
const removed: string[] = [];
const inject = { collide: false, failWrite: false };

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (file: any, flags?: any, mode?: any) => {
    if (typeof file === 'string' && file.endsWith('.tmp')) {
      opens.push({ file, flags, mode });
      if (inject.collide) {
        inject.collide = false;
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      }
      const handle = await actual.open(file, flags, mode);
      if (inject.failWrite) {
        inject.failWrite = false;
        return Object.assign(Object.create(Object.getPrototypeOf(handle)), handle, {
          writeFile: async () => { throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); },
          close: () => handle.close(),
        });
      }
      return handle;
    }
    return actual.open(file, flags, mode);
  }) as typeof actual.open;
  const rm = (async (target: any, options?: any) => {
    removed.push(String(target));
    return actual.rm(target, options);
  }) as typeof actual.rm;
  return { ...actual, default: { ...actual, open, rm }, open, rm };
});

const { writeMcpConfig } = await import('../src/mcp-config.js');
const { setToken } = await import('../src/mcp-tokens.js');

let dataDir = '';
beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), 'od-b121-modes-'));
  opens.length = 0;
  removed.length = 0;
  inject.collide = false;
  inject.failWrite = false;
});
afterEach(() => { rmSync(dataDir, { recursive: true, force: true }); });

it.skipIf(process.platform === 'win32')('config and token temp files are opened 0600 and exclusively', async () => {
  await writeMcpConfig(dataDir, { servers: [{ id: 'remote', transport: 'http', enabled: true, url: 'https://x.test/mcp', headers: { Authorization: 'Bearer secret' } }] });
  await setToken(dataDir, 'remote', { accessToken: 'secret-access', tokenType: 'Bearer', savedAt: 1 });
  expect(opens.map((entry) => path.basename(entry.file).split('.')[0])).toEqual(['mcp-config', 'mcp-tokens']);
  for (const entry of opens) {
    expect(entry.flags, entry.file).toBe('wx');
    expect(entry.mode, entry.file).toBe(0o600);
  }
});

it('an exclusive-create collision fails the write and removes no file it did not create', async () => {
  inject.collide = true;
  await expect(writeMcpConfig(dataDir, { servers: [] })).rejects.toMatchObject({ code: 'EEXIST' });
  inject.collide = true;
  await expect(setToken(dataDir, 'remote', { accessToken: 'secret-access', tokenType: 'Bearer', savedAt: 1 })).rejects.toMatchObject({ code: 'EEXIST' });
  expect(removed.filter((file) => file.endsWith('.tmp'))).toEqual([]);
});

it('a partial write removes this attempt\'s own temp file', async () => {
  inject.failWrite = true;
  await expect(writeMcpConfig(dataDir, { servers: [] })).rejects.toMatchObject({ code: 'ENOSPC' });
  inject.failWrite = true;
  await expect(setToken(dataDir, 'remote', { accessToken: 'secret-access', tokenType: 'Bearer', savedAt: 1 })).rejects.toMatchObject({ code: 'ENOSPC' });
  expect(removed.filter((file) => file.endsWith('.tmp'))).toEqual(opens.map((entry) => entry.file));
});
