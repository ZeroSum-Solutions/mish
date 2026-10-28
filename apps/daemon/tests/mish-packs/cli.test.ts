// `od packs`: argument handling and the calls it makes. The daemon is a fake fetch.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runMishPacksCli } from '../../src/mish-packs/cli.js';
import { cleanupDirs, tempDir } from './pack-fixture.js';

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

const summary = {
  id: 'team-kit', name: 'Team kit', version: '1.0.0', description: null, origin: 'installed' as const,
  provides: [{ resource: 'skills', items: 2 }, { resource: 'cultCatalog', items: null }],
  envKeys: [], mcpServerIds: ['pack-stdio'], requiredEnv: [{ name: 'PACK_TEST_TOKEN', set: false }], installedAt: null, warnings: [],
};

function fakeFetch(handler: (url: string, init?: RequestInit) => { status?: number; body: unknown }) {
  const calls: Array<{ url: string; init?: RequestInit | undefined }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const { status = 200, body } = handler(url, init);
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const opts = (fetchImpl: typeof fetch, cwd = '/') => ({ resolveBaseUrl: async () => 'http://127.0.0.1:7456', fetchImpl, cwd });

describe('od packs', () => {
  it('prints usage with no arguments and exits 2 on a bad one', async () => {
    const { fn } = fakeFetch(() => ({ body: {} }));
    expect((await runMishPacksCli([], opts(fn))).stdout).toContain('od packs install');
    expect((await runMishPacksCli(['frob'], opts(fn))).code).toBe(2);
    expect((await runMishPacksCli(['list', '--nope'], opts(fn))).code).toBe(2);
    expect((await runMishPacksCli(['install'], opts(fn))).code).toBe(2);
    expect((await runMishPacksCli(['remove'], opts(fn))).code).toBe(2);
  });

  it('lists packs as text and as JSON', async () => {
    const { fn, calls } = fakeFetch(() => ({ body: { packs: [summary], installDir: '/x', externalDir: null } }));
    const text = await runMishPacksCli(['list'], opts(fn));
    expect(text.code).toBe(0);
    expect(text.stdout).toContain('team-kit\t1.0.0');
    expect(text.stdout).toContain('skills (2)');
    expect(text.stdout).toContain('PACK_TEST_TOKEN');
    expect(calls[0]!.url).toBe('http://127.0.0.1:7456/api/mish-packs');
    const asJson = await runMishPacksCli(['list', '--json'], opts(fn));
    expect(JSON.parse(asJson.stdout).packs[0].id).toBe('team-kit');
    const empty = fakeFetch(() => ({ body: { packs: [], installDir: '/x', externalDir: null } }));
    expect((await runMishPacksCli(['list'], opts(empty.fn))).stdout).toContain('No packs installed');
  });

  it('resolves the install path against the cwd and posts it', async () => {
    const dir = tempDir('mish-cli-');
    await fsp.mkdir(path.join(dir, 'packet'));
    const { fn, calls } = fakeFetch(() => ({ body: { pack: summary, replaced: false } }));
    const result = await runMishPacksCli(['install', 'packet'], opts(fn, dir));
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('Installed pack team-kit 1.0.0');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ source: path.join(dir, 'packet') });
    expect((await runMishPacksCli(['install', 'missing'], opts(fn, dir))).code).toBe(2);
  });

  it('refuses a local path for a daemon on another machine', async () => {
    const dir = tempDir('mish-cli-');
    const { fn } = fakeFetch(() => ({ body: {} }));
    const result = await runMishPacksCli(['install', dir], { resolveBaseUrl: async () => 'https://daemon.example.test', fetchImpl: fn });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('this machine');
  });

  it('removes a pack and reports a refusal with its code', async () => {
    const ok = fakeFetch(() => ({ body: { removed: 'team-kit' } }));
    const removed = await runMishPacksCli(['remove', 'team-kit'], opts(ok.fn));
    expect(removed.stdout).toContain('Removed pack team-kit');
    expect(removed.stdout).not.toContain('Kept');
    expect(ok.calls[0]!.init?.method).toBe('DELETE');
    const withProjects = fakeFetch(() => ({ body: { removed: 'team-projects', keptProjects: ['ds-one', 'proj-two'] } }));
    const kept = await runMishPacksCli(['remove', 'team-projects'], opts(withProjects.fn));
    expect(kept.stdout).toContain('Kept the 2 saved project(s) it added; they stay in your project list: ds-one, proj-two');
    const refused = fakeFetch(() => ({ status: 404, body: { error: { code: 'NOT_FOUND', message: 'no installed pack has that id' } } }));
    const result = await runMishPacksCli(['remove', 'nope'], opts(refused.fn));
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('NOT_FOUND');
  });

  it('says so when the daemon is not running', async () => {
    const { fn } = fakeFetch(() => ({ body: {} }));
    const result = await runMishPacksCli(['list'], { resolveBaseUrl: async () => { throw new Error('down'); }, fetchImpl: fn });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not running');
  });
});
