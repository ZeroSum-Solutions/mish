// P1-5: a pack can carry plugins. The `plugins` content handler registers
// each listed plugin through the plugin installer on install, tags it
// `pack:<id>@<version>`, and unregisters exactly those rows on remove.
//
// Real PackService + real plugin installer over a temp data root and a real
// SQLite database; synthetic fixture packs only.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type Database from 'better-sqlite3';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import type { InstalledPluginRecord } from '@mish/contracts';

import { closeDatabase, openDatabase } from '../../src/db.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import type { GithubPackFetcher } from '../../src/packs/github-fetcher.js';
import { createPackService } from '../../src/packs/service.js';
import { installFromLocalFolder } from '../../src/plugins/installer.js';
import { createPluginsPackHandler, type PluginsPackHandlerOptions } from '../../src/plugins/pack-plugins.js';
import { registerPluginRoutes } from '../../src/routes/plugins/index.js';
import {
  getInstalledPlugin,
  listInstalledPlugins,
  registryRootsForDataDir,
  upsertInstalledPlugin,
} from '../../src/plugins/registry.js';
import {
  FIXTURE_PACK_ID,
  sha256Hex,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixtureFile,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const execFileP = promisify(execFile);
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const daemonRoot = path.resolve(currentDir, '../..');
const repoRoot = path.resolve(currentDir, '../../../..');
const cliSource = path.resolve(daemonRoot, 'src/cli.ts');
const tsxCli = path.resolve(repoRoot, 'node_modules/tsx/dist/cli.mjs');

const cleanup: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  closeDatabase();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function pluginManifest(id: string, version = '1.0.0'): string {
  return `${JSON.stringify(
    {
      name: id,
      version,
      title: `Plugin ${id}`,
      od: {
        kind: 'skill',
        taskKind: 'new-generation',
        useCase: { query: 'Make a {{topic}} brief.' },
        inputs: [{ name: 'topic', type: 'string', required: true }],
      },
    },
    null,
    2,
  )}\n`;
}

function pluginFiles(id: string, version = '1.0.0'): FixtureFile[] {
  return [
    { path: `plugins/${id}/mish.json`, content: pluginManifest(id, version) },
    { path: `plugins/${id}/assets/note.txt`, content: `${id} ${version}\n` },
  ];
}

function pluginPack(ids: string[], options: FixturePackOptions & { pluginVersion?: string } = {}): FixturePackOptions {
  const { pluginVersion, ...rest } = options;
  return {
    ...rest,
    files: ids.flatMap((id) => pluginFiles(id, pluginVersion)),
    contents: [{ kind: 'plugins', schema: 'od-plugin-dir/1', path: 'plugins', ids }],
  };
}

async function archiveOf(options: FixturePackOptions): Promise<string> {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir);
  cleanup.push(path.dirname(archivePath));
  writeSidecar(archivePath);
  return archivePath;
}

interface Harness {
  dataDir: string;
  packsDir: string;
  db: Database.Database;
  pluginsRoot: string;
  service: ReturnType<typeof createPackService>;
  newService(withHandler: boolean): ReturnType<typeof createPackService>;
  /** Test seams the handler under test uses; set them per test. */
  hooks: NonNullable<PluginsPackHandlerOptions['testHooks']>;
}

function setup(options: { withHandler?: boolean; githubFetcher?: GithubPackFetcher } = {}): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-plugins-'));
  cleanup.push(dataDir);
  const db = openDatabase(dataDir, { dataDir });
  const packsDir = packsDirForDataDir(dataDir);
  const roots = registryRootsForDataDir(dataDir);
  const hooks: Harness['hooks'] = {};
  const newService = (withHandler: boolean) =>
    createPackService({
      packsDir,
      registry: createPackRegistry({ packsDir }),
      handlers: withHandler ? [createPluginsPackHandler({ db: () => db, roots, testHooks: hooks })] : [],
      ...(options.githubFetcher ? { githubFetcher: options.githubFetcher } : {}),
    });
  return {
    dataDir,
    packsDir,
    db,
    pluginsRoot: roots.userPluginsRoot,
    service: newService(options.withHandler ?? true),
    newService,
    hooks,
  };
}

function receiptHandlers(packsDir: string): Record<string, string> {
  return JSON.parse(readFileSync(path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8')).handlers;
}

function packRows(db: Database.Database): InstalledPluginRecord[] {
  return listInstalledPlugins(db, null, null)
    .filter((plugin) => plugin.resolvedSource?.startsWith(`pack:${FIXTURE_PACK_ID}@`))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function installUserPlugin(harness: Harness, id: string): Promise<InstalledPluginRecord> {
  const folder = mkdtempSync(path.join(tmpdir(), 'od-user-plugin-'));
  cleanup.push(folder);
  writeFileSync(path.join(folder, 'mish.json'), pluginManifest(id, '9.9.9'));
  let record: InstalledPluginRecord | null = null;
  for await (const event of installFromLocalFolder(harness.db, {
    source: folder,
    roots: { userPluginsRoot: harness.pluginsRoot },
  })) {
    if (event.kind === 'success') record = event.plugin;
    if (event.kind === 'error') throw new Error(event.message);
  }
  return record!;
}

/** The daemon's real plugin routes over the test database (GET /api/plugins is the one used). */
async function mountPluginRoutes(db: Database.Database): Promise<string> {
  const app = express();
  const middleware: express.RequestHandler = (_req, _res, next) => next();
  registerPluginRoutes(app, {
    db,
    paths: { PROJECTS_DIR: '', PLUGIN_REGISTRY_ROOTS: [], PLUGIN_LOCKFILE_PATH: '' },
    ids: { randomId: () => 'unused' },
    projectStore: {},
    conversations: {},
    plugins: { listInstalledPlugins, getInstalledPlugin },
    helpers: {
      requireLocalDaemonRequest: middleware,
      pluginUpload: { single: () => middleware, array: () => middleware },
      applyBakedPreviews: (plugins: unknown) => plugins,
      PLUGIN_PREVIEWS_DIR: '',
      sendApiError: (res: express.Response, status: number, code: string, message: string) =>
        res.status(status).json({ error: { code, message } }),
    },
  } as unknown as Parameters<typeof registerPluginRoutes>[1]);
  const server = http.createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function runPluginListCli(baseUrl: string): Promise<string> {
  const { stdout } = await execFileP(
    process.execPath,
    [tsxCli, cliSource, 'plugin', 'list', '--daemon-url', baseUrl],
    { cwd: daemonRoot, env: { ...process.env, NODE_OPTIONS: undefined }, timeout: 30_000 },
  );
  return stdout;
}

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** A GitHub fetcher that serves whichever archive the test set last. */
function fakeGithub() {
  let archivePath = '';
  let manifestSha256 = '';
  let version = '';
  const fetcher: GithubPackFetcher = async (_source, opts) => {
    copyFileSync(archivePath, opts.destPath);
    const bytes = readFileSync(archivePath);
    return {
      archivePath: opts.destPath,
      resolvedRef: `pack@${version} ${COMMIT}`,
      archiveIntegrity: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      expectedManifestSha256: manifestSha256,
      bytes: bytes.length,
    };
  };
  return {
    fetcher,
    async serve(options: FixturePackOptions) {
      const pack = writeFixturePack(options);
      cleanup.push(pack.dir);
      archivePath = await tarFixturePack(pack.dir, { wrapper: `acme-pack-${COMMIT.slice(0, 7)}` });
      cleanup.push(path.dirname(archivePath));
      manifestSha256 = pack.manifestSha256;
      version = pack.manifest.version;
    },
  };
}

/** A promise the test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function userPluginFolder(id: string): string {
  const folder = mkdtempSync(path.join(tmpdir(), 'od-user-plugin-'));
  cleanup.push(folder);
  writeFileSync(path.join(folder, 'mish.json'), pluginManifest(id, '9.9.9'));
  return folder;
}

async function drain(events: AsyncIterable<{ kind: string; message?: string }>): Promise<void> {
  for await (const event of events) if (event.kind === 'error') throw new Error(event.message);
}

describe('pack plugins handler (P1-5)', () => {
  it('install registers every listed plugin tagged pack:<id>@<version>, visible in the plugin list (API and CLI); remove unregisters them', async () => {
    const harness = setup();
    const result = await harness.service.install(
      { kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) },
      () => undefined,
    );
    expect(result.warnings).toEqual([]);
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'active' });

    const rows = packRows(harness.db);
    expect(rows.map((row) => row.id)).toEqual(['alpha', 'beta']);
    for (const row of rows) {
      expect(row.source).toBe(`pack:${FIXTURE_PACK_ID}@1.0.0`);
      expect(row.resolvedSource).toBe(`pack:${FIXTURE_PACK_ID}@1.0.0`);
      expect(row.sourceKind).toBe('local');
      expect(row.fsPath).toBe(path.join(harness.pluginsRoot, row.id));
      expect(readFileSync(path.join(row.fsPath, 'assets', 'note.txt'), 'utf8')).toBe(`${row.id} 1.0.0\n`);
    }

    // API: the daemon's real GET /api/plugins route, backed by the test DB.
    const baseUrl = await mountPluginRoutes(harness.db);
    const listed = (await (await fetch(`${baseUrl}/api/plugins`)).json()) as { plugins: InstalledPluginRecord[] };
    expect(
      listed.plugins
        .filter((plugin) => plugin.id === 'alpha' || plugin.id === 'beta')
        .map((plugin) => [plugin.id, plugin.resolvedSource])
        .sort(),
    ).toEqual([
      ['alpha', `pack:${FIXTURE_PACK_ID}@1.0.0`],
      ['beta', `pack:${FIXTURE_PACK_ID}@1.0.0`],
    ]);

    // CLI: `od plugin list` against that same route names the pack.
    const stdout = await runPluginListCli(baseUrl);
    expect(stdout).toMatch(/^alpha@1\.0\.0 .*source=pack:synthetic-pack@1\.0\.0/m);
    expect(stdout).toMatch(/^beta@1\.0\.0 .*source=pack:synthetic-pack@1\.0\.0/m);

    await harness.service.remove(FIXTURE_PACK_ID);
    expect(packRows(harness.db)).toEqual([]);
    expect(getInstalledPlugin(harness.db, 'alpha')).toBeNull();
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
    expect(existsSync(path.join(harness.pluginsRoot, 'beta'))).toBe(false);
  });

  it('remove of a damaged pack (unreadable pack.json) retracts by the pack:<id>@ prefix alone', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(packRows(harness.db)).toHaveLength(2);

    writeFileSync(path.join(harness.packsDir, FIXTURE_PACK_ID, 'pack.json'), '{ not json');
    await harness.service.remove(FIXTURE_PACK_ID);
    expect(packRows(harness.db)).toEqual([]);
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
  });

  it('retract with entries: [] removes every row tagged with the pack id and nothing else', async () => {
    const harness = setup();
    const user = await installUserPlugin(harness, 'gamma');
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(packRows(harness.db)).toHaveLength(2);

    const handler = createPluginsPackHandler({ db: () => harness.db, roots: { userPluginsRoot: harness.pluginsRoot } });
    await handler.retract({
      packId: FIXTURE_PACK_ID,
      version: '1.0.0',
      packDir: path.join(harness.packsDir, FIXTURE_PACK_ID),
      entries: [],
      previousVersion: null,
      installSource: '',
      repair: false,
      warn: () => undefined,
    });
    expect(packRows(harness.db)).toEqual([]);
    expect(getInstalledPlugin(harness.db, 'gamma')).toEqual(user);
  });

  it('upgrade v1 (alpha, beta) to v2 (beta, gamma): alpha removed, beta updated, gamma added', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    const upgraded = await harness.service.install(
      { kind: 'archive-file', path: await archiveOf(pluginPack(['beta', 'gamma'], { version: '2.0.0', pluginVersion: '2.0.0' })) },
      () => undefined,
    );
    expect(upgraded.outcome).toBe('upgraded');
    expect(upgraded.warnings).toEqual([]);

    const rows = packRows(harness.db);
    expect(rows.map((row) => [row.id, row.version, row.resolvedSource])).toEqual([
      ['beta', '2.0.0', `pack:${FIXTURE_PACK_ID}@2.0.0`],
      ['gamma', '2.0.0', `pack:${FIXTURE_PACK_ID}@2.0.0`],
    ]);
    expect(getInstalledPlugin(harness.db, 'alpha')).toBeNull();
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
    expect(readFileSync(path.join(harness.pluginsRoot, 'beta', 'assets', 'note.txt'), 'utf8')).toBe('beta 2.0.0\n');

    // Idempotent: the same version again changes nothing.
    const again = await harness.service.install(
      { kind: 'archive-file', path: await archiveOf(pluginPack(['beta', 'gamma'], { version: '2.0.0', pluginVersion: '2.0.0' })) },
      () => undefined,
    );
    expect(again.outcome).toBe('unchanged');
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['beta', 'gamma']);
  });

  it('a plugin id that a user or bundled plugin already holds is refused with a warning; the others activate and the existing rows are untouched', async () => {
    const harness = setup();
    const user = await installUserPlugin(harness, 'beta');
    const bundled: InstalledPluginRecord = { ...user, id: 'delta', title: 'Bundled delta', sourceKind: 'bundled', source: 'delta', trust: 'bundled', fsPath: path.join(harness.dataDir, 'bundled', 'delta') };
    upsertInstalledPlugin(harness.db, bundled);
    const bundledBefore = getInstalledPlugin(harness.db, 'delta');

    const result = await harness.service.install(
      { kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta', 'delta'])) },
      () => undefined,
    );
    expect(result.warnings).toEqual([
      'plugin beta was not registered: a plugin with that id is already installed',
      'plugin delta was not registered: a plugin with that id is already installed',
    ]);
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'active' });
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['alpha']);
    expect(getInstalledPlugin(harness.db, 'beta')).toEqual(user);
    expect(getInstalledPlugin(harness.db, 'delta')).toEqual(bundledBefore);
    expect(readFileSync(path.join(harness.pluginsRoot, 'beta', 'mish.json'), 'utf8')).toBe(pluginManifest('beta', '9.9.9'));

    // Removing the pack leaves the user's and the bundled plugin alone.
    await harness.service.remove(FIXTURE_PACK_ID);
    expect(getInstalledPlugin(harness.db, 'beta')).toEqual(user);
    expect(getInstalledPlugin(harness.db, 'delta')).toEqual(bundledBefore);
    expect(getInstalledPlugin(harness.db, 'alpha')).toBeNull();
  });

  it('activatePending at restart registers a pack installed while no plugins handler existed (unhandled -> active)', async () => {
    const harness = setup({ withHandler: false });
    const result = await harness.service.install(
      { kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) },
      () => undefined,
    );
    expect(result.warnings).toEqual(['plugins content is not registered by this build']);
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'unhandled' });
    expect(packRows(harness.db)).toEqual([]);

    const restarted = harness.newService(true);
    const report = await restarted.activatePending();
    expect(report).toEqual([{ id: FIXTURE_PACK_ID, warnings: [] }]);
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'active' });
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['alpha', 'beta']);
  });

  it('a plugin whose bytes no longer match the pack sha256 is not registered; the others are, and the pack is degraded', async () => {
    const harness = setup({ withHandler: false });
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    const tampered = path.join(harness.packsDir, FIXTURE_PACK_ID, 'plugins', 'alpha', 'assets', 'note.txt');
    writeFileSync(tampered, 'tampered\n');

    const restarted = harness.newService(true);
    const report = await restarted.activatePending();
    expect(report[0]?.warnings).toEqual([
      'plugin alpha was not registered: its files do not match the pack',
      'plugins content could not be registered (PLUGIN_INTEGRITY)',
    ]);
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'failed:PLUGIN_INTEGRITY' });
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['beta']);
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
  });

  it('a listed folder whose manifest names another id is refused with a warning', async () => {
    const harness = setup();
    const options = pluginPack(['alpha']);
    options.files = [
      { path: 'plugins/alpha/mish.json', content: pluginManifest('not-alpha') },
    ];
    const result = await harness.service.install({ kind: 'archive-file', path: await archiveOf(options) }, () => undefined);
    expect(result.warnings).toEqual([
      'plugin alpha was not registered: its manifest names a different plugin id',
      'plugins content could not be registered (PLUGIN_INVALID)',
    ]);
    expect(getInstalledPlugin(harness.db, 'not-alpha')).toBeNull();
    expect(getInstalledPlugin(harness.db, 'alpha')).toBeNull();
    expect(existsSync(path.join(harness.pluginsRoot, 'not-alpha'))).toBe(false);
  });

  // Sol review of #262, BLOCK 1.
  it('a pack from GitHub registers its plugins restricted, like a direct GitHub plugin install; a .tgz pack registers them trusted; a trust grant is not carried into a new activation', async () => {
    const github = fakeGithub();
    const harness = setup({ githubFetcher: github.fetcher });
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha'])) }, () => undefined);
    expect(packRows(harness.db).map((row) => [row.id, row.trust])).toEqual([['alpha', 'trusted']]);

    await github.serve(pluginPack(['alpha', 'beta'], { version: '2.0.0', pluginVersion: '2.0.0' }));
    await harness.service.install({ kind: 'github', source: 'github:acme/pack@2.0.0' }, () => undefined);
    expect(packRows(harness.db).map((row) => [row.id, row.version, row.trust])).toEqual([
      ['alpha', '2.0.0', 'restricted'],
      ['beta', '2.0.0', 'restricted'],
    ]);

    // The user trusts alpha; the next activation starts from the default again.
    upsertInstalledPlugin(harness.db, { ...getInstalledPlugin(harness.db, 'alpha')!, trust: 'trusted' });
    await github.serve(pluginPack(['alpha', 'beta'], { version: '3.0.0', pluginVersion: '3.0.0' }));
    await harness.service.install({ kind: 'github', source: 'github:acme/pack@3.0.0' }, () => undefined);
    expect(packRows(harness.db).map((row) => [row.id, row.version, row.trust])).toEqual([
      ['alpha', '3.0.0', 'restricted'],
      ['beta', '3.0.0', 'restricted'],
    ]);
  });

  // Sol review of #262, BLOCK 2 (activate).
  it('a user install of the same id that races the pack install waits for it, and the user plugin survives intact', async () => {
    const harness = setup();
    let user: Promise<void> | null = null;
    harness.hooks.afterOwnershipCheck = async (id) => {
      if (id !== 'alpha' || user) return;
      user = drain(installFromLocalFolder(harness.db, { source: userPluginFolder('alpha'), roots: { userPluginsRoot: harness.pluginsRoot } }));
      await new Promise((resolve) => setTimeout(resolve, 100));
    };
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(user).not.toBeNull();
    await user;

    const alpha = getInstalledPlugin(harness.db, 'alpha')!;
    expect(alpha.version).toBe('9.9.9');
    expect(alpha.resolvedSource).toBeUndefined();
    expect(readFileSync(path.join(harness.pluginsRoot, 'alpha', 'mish.json'), 'utf8')).toBe(pluginManifest('alpha', '9.9.9'));
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha', 'assets'))).toBe(false);
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['beta']);
  });

  // Sol review of #262, BLOCK 2 (retract).
  it('a user install that takes a pack plugin id before retract reaches it survives the pack removal', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    const reached: string[] = [];
    harness.hooks.beforeUnregister = async (id) => {
      reached.push(id);
      if (id === 'alpha') {
        await drain(installFromLocalFolder(harness.db, { source: userPluginFolder('alpha'), roots: { userPluginsRoot: harness.pluginsRoot } }));
      }
    };
    await harness.service.remove(FIXTURE_PACK_ID);
    expect(reached).toContain('alpha');

    const alpha = getInstalledPlugin(harness.db, 'alpha')!;
    expect(alpha?.version).toBe('9.9.9');
    expect(readFileSync(path.join(harness.pluginsRoot, 'alpha', 'mish.json'), 'utf8')).toBe(pluginManifest('alpha', '9.9.9'));
    expect(getInstalledPlugin(harness.db, 'beta')).toBeNull();
  });

  // Sol review of #262, WARN 1.
  it('a staged file changed after verification is caught at the destination and not registered; staging is private (0700)', async () => {
    const harness = setup();
    const modes: number[] = [];
    harness.hooks.afterStage = async (id, staged) => {
      modes.push(statSync(path.dirname(staged)).mode & 0o777);
      if (id === 'alpha') writeFileSync(path.join(staged, 'assets', 'note.txt'), 'swapped\n');
    };
    const result = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(modes).toEqual([0o700, 0o700]);
    expect(result.warnings).toEqual([
      'plugin alpha was not registered: its files do not match the pack',
      'plugins content could not be registered (PLUGIN_INTEGRITY)',
    ]);
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['beta']);
    expect(getInstalledPlugin(harness.db, 'alpha')).toBeNull();
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
  });

  // Sol review of #262, WARN 2.
  it('a plugin folder that cannot be removed keeps its row and fails the pack removal (RETRACT_FAILED); a retry succeeds', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    harness.hooks.removeFolder = async () => {
      throw new Error('EBUSY');
    };
    const error = await harness.service.remove(FIXTURE_PACK_ID).then(
      () => null,
      (caught: unknown) => caught as { code?: string },
    );
    expect(error?.code).toBe('RETRACT_FAILED');
    expect(packRows(harness.db).map((row) => row.id)).toEqual(['alpha', 'beta']);
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha', 'mish.json'))).toBe(true);
    expect(existsSync(path.join(harness.packsDir, FIXTURE_PACK_ID, 'pack.json'))).toBe(true);

    delete harness.hooks.removeFolder;
    await harness.service.remove(FIXTURE_PACK_ID);
    expect(packRows(harness.db)).toEqual([]);
    expect(existsSync(path.join(harness.pluginsRoot, 'alpha'))).toBe(false);
  });

  // Sol review of #262, WARN 3.
  it('installing the same version again repairs a deleted plugin folder (outcome unchanged)', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    rmSync(path.join(harness.pluginsRoot, 'alpha'), { recursive: true, force: true });

    const again = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(again.outcome).toBe('unchanged');
    expect(again.warnings).toEqual([]);
    expect(readFileSync(path.join(harness.pluginsRoot, 'alpha', 'assets', 'note.txt'), 'utf8')).toBe('alpha 1.0.0\n');
    expect(receiptHandlers(harness.packsDir)).toEqual({ plugins: 'active' });
  });

  // Sol re-verify of 13abbfba64, WARN 1: a same-version install from another kind of source.
  it('the same version and digest from a different kind of source replaces the install: local then github gives restricted plugins, github then local gives trusted ones', async () => {
    const github = fakeGithub();
    const harness = setup({ githubFetcher: github.fetcher });
    const receiptSource = (): string =>
      JSON.parse(readFileSync(path.join(harness.packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8')).source;

    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha'])) }, () => undefined);
    expect(packRows(harness.db).map((row) => row.trust)).toEqual(['trusted']);

    await github.serve(pluginPack(['alpha']));
    const viaGithub = await harness.service.install({ kind: 'github', source: 'github:acme/pack@1.0.0' }, () => undefined);
    expect(viaGithub.outcome).not.toBe('unchanged');
    expect(receiptSource()).toBe('github:acme/pack@1.0.0');
    expect(packRows(harness.db).map((row) => row.trust)).toEqual(['restricted']);

    const viaFile = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha'])) }, () => undefined);
    expect(viaFile.outcome).not.toBe('unchanged');
    expect(receiptSource()).toMatch(/^local:/);
    expect(packRows(harness.db).map((row) => row.trust)).toEqual(['trusted']);
  });

  // Sol re-verify of 13abbfba64, WARN 2: the same-version repair keeps the user's choices.
  it('a same-version reinstall leaves healthy plugin rows (and their trust and capability grants) untouched and re-registers only a broken one', async () => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    const alpha = { ...getInstalledPlugin(harness.db, 'alpha')!, trust: 'restricted' as const, capabilitiesGranted: ['fs:read'] };
    upsertInstalledPlugin(harness.db, alpha);
    const alphaBefore = getInstalledPlugin(harness.db, 'alpha');

    // Healthy: nothing changes.
    const same = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(same.outcome).toBe('unchanged');
    expect(getInstalledPlugin(harness.db, 'alpha')).toEqual(alphaBefore);

    // beta's folder goes missing: only beta is registered again.
    const betaBefore = getInstalledPlugin(harness.db, 'beta')!;
    rmSync(path.join(harness.pluginsRoot, 'beta'), { recursive: true, force: true });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const repaired = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(repaired.outcome).toBe('unchanged');
    expect(getInstalledPlugin(harness.db, 'alpha')).toEqual(alphaBefore);
    expect(readFileSync(path.join(harness.pluginsRoot, 'beta', 'assets', 'note.txt'), 'utf8')).toBe('beta 1.0.0\n');
    expect(getInstalledPlugin(harness.db, 'beta')!.updatedAt).toBeGreaterThan(betaBefore.updatedAt);
  });

  // Sol second re-verify: a row with the right tag and files but stale metadata is reconciled.
  it.each([
    ['version', `UPDATE installed_plugins SET version = '0.0.1' WHERE id = 'alpha'`],
    ['fsPath', `UPDATE installed_plugins SET fs_path = '/elsewhere/alpha' WHERE id = 'alpha'`],
    ['source', `UPDATE installed_plugins SET source = '/tmp/alpha' WHERE id = 'alpha'`],
    ['sourceKind', `UPDATE installed_plugins SET source_kind = 'github' WHERE id = 'alpha'`],
  ])('a same-version reinstall re-registers a pack row whose %s is stale; an untouched sibling keeps its grants', async (_column, sql) => {
    const harness = setup();
    await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    upsertInstalledPlugin(harness.db, { ...getInstalledPlugin(harness.db, 'beta')!, trust: 'restricted', capabilitiesGranted: ['fs:read'] });
    const betaBefore = getInstalledPlugin(harness.db, 'beta');
    harness.db.prepare(sql).run();

    const again = await harness.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack(['alpha', 'beta'])) }, () => undefined);
    expect(again.outcome).toBe('unchanged');
    const alpha = getInstalledPlugin(harness.db, 'alpha')!;
    expect([alpha.version, alpha.fsPath, alpha.source, alpha.sourceKind, alpha.resolvedSource]).toEqual([
      '1.0.0',
      path.join(harness.pluginsRoot, 'alpha'),
      `pack:${FIXTURE_PACK_ID}@1.0.0`,
      'local',
      `pack:${FIXTURE_PACK_ID}@1.0.0`,
    ]);
    expect(getInstalledPlugin(harness.db, 'beta')).toEqual(betaBefore);
  });
});
