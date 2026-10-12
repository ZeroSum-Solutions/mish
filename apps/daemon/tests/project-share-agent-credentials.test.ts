import { mkdtemp, mkdir, rm, symlink, writeFile, readFile, readdir, stat, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createVelaCliResourceAdapter } from '../src/collab/vela-cli-resource-adapter.js';

const { snapshotIo } = vi.hoisted(() => ({ snapshotIo: { failCopy: false, failCleanup: false, vanishCopy: false } }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (snapshotIo.failCleanup && path.basename(path.dirname(String(args[0]))) === 'snapshots') {
      throw Object.assign(new Error('synthetic-cleanup-path-canary'), { code: 'EBUSY' });
    }
    return actual.rm(...args);
  }, copyFile: async (...args: Parameters<typeof actual.copyFile>) => {
    if (snapshotIo.vanishCopy) {
      await actual.rm(args[0], { force: true });
      throw Object.assign(new Error('synthetic-vanished-file-path-canary'), { code: 'ENOENT' });
    }
    if (snapshotIo.failCopy) throw Object.assign(new Error('synthetic-filesystem-path-canary'), { code: 'EIO' });
    return actual.copyFile(...args);
  } };
});

let projectDir: string;
let dataDir: string;
beforeEach(async () => {
  snapshotIo.failCopy = false;
  snapshotIo.vanishCopy = false;
  snapshotIo.failCleanup = false;
  dataDir = await mkdtemp(path.join(tmpdir(), 'project-share-private-'));
  projectDir = path.join(dataDir, 'project');
  await mkdir(projectDir);
});
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }); });
function adapter() {
  const run = vi.fn(async (_args: string[]) => JSON.stringify({ version: 1 }));
  return { run, client: createVelaCliResourceAdapter({ resolveProjectDir: () => projectDir, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true, run }) };
}
it.each(['.MCP.JSON', '.ClAuDe', '.mcp.JSON.synthetic.tmp'])('refuses private case variants %s before invoking the snapshot transport', async name => {
  await writeFile(path.join(projectDir, name), 'synthetic-private-canary');
  const { run, client } = adapter();
  await expect(client.publish({ projectId: 'p', reason: 'edit' })).rejects.toMatchObject({ code: 'TEAM_PROJECT_PRIVATE_PATH' });
  expect(run).not.toHaveBeenCalled();
});
it('refuses a public-looking alias to agent credentials before invoking the snapshot transport', async () => {
  await writeFile(path.join(projectDir, '.mcp.json'), 'synthetic-private-canary');
  await symlink('.mcp.json', path.join(projectDir, 'innocent.json'));
  const { run, client } = adapter();
  await expect(client.publish({ projectId: 'p', reason: 'edit' })).rejects.toMatchObject({ code: 'TEAM_PROJECT_PRIVATE_PATH' });
  expect(run).not.toHaveBeenCalled();
});
it('allows canonical excluded agent files and homes alongside real project content', async () => {
  await writeFile(path.join(projectDir, 'index.html'), '<h1>Public</h1>');
  await writeFile(path.join(projectDir, '.mcp.json'), 'synthetic-private-canary');
  await writeFile(path.join(projectDir, '.mcp.json.synthetic.tmp'), 'synthetic-private-canary');
  await mkdir(path.join(projectDir, '.claude'));
  await writeFile(path.join(projectDir, '.claude', 'config.json'), 'synthetic-private-canary');
  const { run, client } = adapter();
  await expect(client.publish({ projectId: 'p', reason: 'edit' })).resolves.toMatchObject({ version: 1 });
  const args = run.mock.calls[0]![0];
  expect(args).toContain('.mcp.json');
  expect(args).toContain('.claude');
  expect(args).toContain('.mcp.json.');
});


it('gives the transport only a sanitized stage, independent of its exclusion semantics', async () => {
  await mkdir(path.join(projectDir, 'nested'));
  await writeFile(path.join(projectDir, 'index.html'), '<h1>Public</h1>');
  await mkdir(path.join(projectDir, '.mish'));
  await writeFile(path.join(projectDir, '.mish', 'project.json'), '{"publicMetadata":true}');
  await writeFile(path.join(projectDir, '.mcp.json'), 'root-private-canary');
  await writeFile(path.join(projectDir, 'nested', '.mcp.json'), 'nested-private-canary');
  await writeFile(path.join(projectDir, 'nested', '.mcp.json.synthetic.tmp'), 'temp-private-canary');
  await mkdir(path.join(projectDir, 'nested', '.codex'));
  await writeFile(path.join(projectDir, 'nested', '.codex', 'config.json'), 'home-private-canary');
  let staged = '';
  const client = createVelaCliResourceAdapter({
    resolveProjectDir: () => projectDir, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true,
    run: async args => {
      staged = args[3]!;
      expect(staged).not.toBe(projectDir);
      expect(await readFile(path.join(staged, 'index.html'), 'utf8')).toBe('<h1>Public</h1>');
      expect((await readdir(staged)).sort()).toEqual(['.mish', 'index.html', 'nested']);
      expect(await readFile(path.join(staged, '.mish', 'project.json'), 'utf8')).toBe('{"publicMetadata":true}');
      expect(await readdir(path.join(staged, 'nested'))).toEqual([]);
      if (process.platform !== 'win32') expect((await stat(staged)).mode & 0o777).toBe(0o700);
      return JSON.stringify({ version: 1 });
    },
  });
  await client.publish({ projectId: 'p', reason: 'share' });
  await expect(stat(staged)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('materializes safe internal public links and accepts a user-selected symlink root', async () => {
  await mkdir(path.join(projectDir, 'assets'));
  await mkdir(path.join(projectDir, 'public'));
  await writeFile(path.join(projectDir, 'assets', 'logo.svg'), '<svg>Public</svg>');
  await symlink('../assets/logo.svg', path.join(projectDir, 'public', 'logo.svg'));
  const selected = path.join(dataDir, 'selected');
  await symlink(projectDir, selected);
  const client = createVelaCliResourceAdapter({
    resolveProjectDir: () => selected, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true,
    run: async args => {
      const logo = path.join(args[3]!, 'public', 'logo.svg');
      expect(await readFile(logo, 'utf8')).toBe('<svg>Public</svg>');
      expect((await lstat(logo)).isSymbolicLink()).toBe(false);
      return JSON.stringify({ version: 1 });
    },
  });
  await expect(client.publish({ projectId: 'p', reason: 'share' })).resolves.toMatchObject({ version: 1 });
});

it('cleans the private stage when the transport fails', async () => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  const snapshotRoot = path.join(dataDir, 'snapshots');
  const client = createVelaCliResourceAdapter({ resolveProjectDir: () => projectDir, snapshotRoot, hasTeamIdentity: () => true, run: async () => { throw new Error('synthetic-network-failure'); } });
  await expect(client.publish({ projectId: 'p', reason: 'share' })).rejects.toThrow('synthetic-network-failure');
  expect(await readdir(snapshotRoot)).toEqual([]);
});

it('refuses public-looking aliases outside the selected project tree', async () => {
  await writeFile(path.join(dataDir, 'outside.json'), 'synthetic-outside-canary');
  await symlink('../outside.json', path.join(projectDir, 'public.json'));
  const { run, client } = adapter();
  await expect(client.publish({ projectId: 'p', reason: 'edit' })).rejects.toMatchObject({ code: 'TEAM_PROJECT_PRIVATE_PATH', retryable: false });
  expect(run).not.toHaveBeenCalled();
});


it.each(['dist', '.next'])('omits a generated directory symlink %s before resolving its outside target', async name => {
  const generated = path.join(dataDir, 'generated');
  await mkdir(generated);
  await writeFile(path.join(generated, 'private.json'), 'synthetic-generated-canary');
  await symlink(generated, path.join(projectDir, name));
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  const client = createVelaCliResourceAdapter({
    resolveProjectDir: () => projectDir, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true,
    run: async args => {
      expect(await readdir(args[3]!)).toEqual(['index.html']);
      expect(await readFile(path.join(args[3]!, 'index.html'), 'utf8')).toBe('Public');
      return JSON.stringify({ version: 1 });
    },
  });
  await expect(client.publish({ projectId: 'p', reason: 'share' })).resolves.toMatchObject({ version: 1 });
});

it('retains an ordinary public file named dist while excluding generated directories', async () => {
  await writeFile(path.join(projectDir, 'dist'), 'Public file');
  const client = createVelaCliResourceAdapter({
    resolveProjectDir: () => projectDir, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true,
    run: async args => {
      expect(await readFile(path.join(args[3]!, 'dist'), 'utf8')).toBe('Public file');
      return JSON.stringify({ version: 1 });
    },
  });
  await expect(client.publish({ projectId: 'p', reason: 'share' })).resolves.toMatchObject({ version: 1 });
});


it('marks missing project content as retryable unavailable rather than a private-path refusal', async () => {
  await rm(projectDir, { recursive: true });
  const { run, client } = adapter();
  await expect(client.publish({ projectId: 'p', reason: 'share' })).rejects.toMatchObject({ code: 'TEAM_PROJECT_SNAPSHOT_UNAVAILABLE', retryable: true });
  expect(run).not.toHaveBeenCalled();
});
it('reports transient snapshot filesystem failure safely and permits retry', async () => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  snapshotIo.failCopy = true;
  const { run, client } = adapter();
  const error = await client.publish({ projectId: 'p', reason: 'share' }).catch(error => error);
  expect(error).toMatchObject({ code: 'TEAM_PROJECT_SNAPSHOT_UNAVAILABLE', retryable: true });
  expect(error.message).not.toContain('synthetic-filesystem-path-canary');
  expect(error.message).not.toContain(projectDir);
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(path.join(dataDir, 'snapshots'))).toEqual([]);
});


it.each([false, true])('preserves the transport result when stage cleanup fails (transport failure=%s)', async transportFails => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  const { run, client } = adapter();
  const transportError = new Error('synthetic-transport-failure');
  if (transportFails) run.mockRejectedValueOnce(transportError);
  snapshotIo.failCleanup = true;
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    if (transportFails) await expect(client.publish({ projectId: 'p', reason: 'share' })).rejects.toBe(transportError);
    else await expect(client.publish({ projectId: 'p', reason: 'share' })).resolves.toMatchObject({ version: 1 });
    expect(run).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledOnce();
    const logged = JSON.stringify(warning.mock.calls);
    expect(logged).toMatch(/snapshot.*cleanup/i);
    expect(logged).not.toContain(dataDir);
    expect(logged).not.toContain('synthetic-cleanup-path-canary');
  } finally { warning.mockRestore(); snapshotIo.failCleanup = false; }
});


it('refuses a vanished regular file during snapshot copy as retryable unavailable', async () => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  snapshotIo.vanishCopy = true;
  const { run, client } = adapter();
  const error = await client.publish({ projectId: 'p', reason: 'share' }).catch(error => error);
  expect(error).toMatchObject({ code: 'TEAM_PROJECT_SNAPSHOT_UNAVAILABLE', retryable: true });
  expect(error.message).not.toContain(dataDir);
  expect(error.message).not.toContain('synthetic-vanished-file-path-canary');
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(path.join(dataDir, 'snapshots'))).toEqual([]);
});
it('omits an already dangling public symlink while retaining complete regular files', async () => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  await symlink('missing-public-file.txt', path.join(projectDir, 'dangling.txt'));
  const run = vi.fn(async (args: string[]) => {
    expect(await readdir(args[3]!)).toEqual(['index.html']);
    expect(await readFile(path.join(args[3]!, 'index.html'), 'utf8')).toBe('Public');
    return JSON.stringify({ version: 1 });
  });
  const client = createVelaCliResourceAdapter({ resolveProjectDir: () => projectDir, snapshotRoot: path.join(dataDir, 'snapshots'), hasTeamIdentity: () => true, run });
  await expect(client.publish({ projectId: 'p', reason: 'share' })).resolves.toMatchObject({ version: 1 });
});


it.each(['self-loop', 'two-link loop'] as const)('refuses a public %s as a permanent private-path error and cleans its stage', async shape => {
  await writeFile(path.join(projectDir, 'index.html'), 'Public');
  if (shape === 'self-loop') await symlink('a', path.join(projectDir, 'a'));
  else {
    await symlink('b', path.join(projectDir, 'a'));
    await symlink('a', path.join(projectDir, 'b'));
  }
  const { run, client } = adapter();
  const error = await client.publish({ projectId: 'p', reason: 'share' }).catch(error => error);
  expect(run).not.toHaveBeenCalled();
  expect(await readdir(path.join(dataDir, 'snapshots'))).toEqual([]);
  expect(error).toMatchObject({ code: 'TEAM_PROJECT_PRIVATE_PATH', retryable: false });
});
