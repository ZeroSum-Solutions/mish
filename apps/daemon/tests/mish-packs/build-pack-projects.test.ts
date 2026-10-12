// scripts/build-pack.mjs: saved projects read from an invented checkout's app database (opened only
// as a read-only copy), --split into modular packs with SHA256SUMS and inventory.json, and large
// files streamed through the zip writer and the daemon's streaming extractor. The fixture holds no
// licensed content.

import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, promises as fsp, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { closeDatabase, getProject, openDatabase } from '../../src/db.js';
import { DEFAULT_MISH_PACK_LIMITS, extractMishPackZip } from '../../src/mish-packs/extract.js';
import { resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore } from '../../src/mish-packs/store.js';
import { cleanupDirs, tempDir, writeFile } from './pack-fixture.js';

const repoRoot = path.resolve(import.meta.dirname, '../../../..');
const script = path.join(repoRoot, 'scripts', 'build-pack.mjs');

function build(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 120_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function sha256(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

const PROJECTS_TABLE = `CREATE TABLE projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, skill_id TEXT, design_system_id TEXT, pending_prompt TEXT,
  metadata_json TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, custom_instructions TEXT, applied_plugin_snapshot_id TEXT)`;

/**
 * An invented checkout with saved projects. The database is left open in WAL mode with its last
 * row only in the write-ahead log, as a running app leaves it; the caller closes it.
 */
function writeCheckout(root: string, projectBytes = 32): Database.Database {
  writeFile(root, '.od/design-systems/atlas-one/DESIGN.md', '# Atlas');
  writeFile(root, '.od/projects/ds-atlas-one/DESIGN.md', '# Atlas preview');
  writeFile(root, '.od/projects/ds-atlas-one/.env', 'SECRET=1');
  writeFile(root, '.od/projects/ds-atlas-one/.mcp.json', JSON.stringify({ mcpServers: { refero: { type: 'http', headers: { Authorization: 'Bearer not-a-real-token' } } } }));
  writeFile(root, '.od/projects/ds-atlas-one/.claude/settings.local.json', JSON.stringify({ env: { SOME_KEY: 'not-real' } }));
  writeFile(root, '.od/projects/ds-atlas-one/node_modules/dep/index.js', 'x');
  writeFile(root, '.od/projects/proj-big-a/blob.bin', randomBytes(projectBytes));
  writeFile(root, '.od/projects/proj-big-b/blob.bin', randomBytes(projectBytes));
  writeFile(root, '.od/projects/proj-wal/index.html', '<h1>only in the log</h1>');
  // A credential-shaped string in an ordinary file: reported, still packed. Invented, not a real token.
  writeFile(root, '.od/projects/proj-wal/notes.md', `See ${['eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9', 'eyJzdWIiOiJub2JvZHkifQ', 'c2lnbmF0dXJl'].join('.')}`);
  writeFile(root, '.od/projects/proj-outside/.file-versions/x', 'x');
  writeFile(root, '.od/projects/no-row/index.html', 'x');
  mkdirSync(path.join(root, '.od', 'projects', 'proj-empty'), { recursive: true });
  const db = new Database(path.join(root, '.od', 'app.sqlite'));
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(PROJECTS_TABLE);
  const insert = db.prepare('INSERT INTO projects (id, name, design_system_id, metadata_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('ds-atlas-one', 'Atlas preview', 'user:atlas-one', JSON.stringify({ kind: 'other', importedFrom: 'design-system', linkedDirs: ['/Users/someone/Desktop'] }), 10, 20);
  insert.run('proj-big-a', 'Big A', null, null, 10, 20);
  insert.run('proj-big-b', 'Big B', null, null, 10, 20);
  insert.run('proj-outside', 'Imported folder', null, JSON.stringify({ baseDir: '/Users/someone/site' }), 10, 20);
  insert.run('proj-empty', 'Nothing in it yet', null, null, 10, 20);
  insert.run('row-without-folder', 'Gone', null, null, 10, 20);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  insert.run('proj-wal', 'Written to the log only', null, null, 10, 30);
  return db;
}

function writeMap(file: string, extra: Record<string, unknown> = {}): void {
  writeFile(path.dirname(file), path.basename(file), JSON.stringify({
    schemaVersion: 1,
    pack: { id: 'built-pack', name: 'Built pack', version: '9.9.9' },
    modules: [
      { id: 'mod-design', name: 'Design systems' },
      { id: 'mod-projects', name: 'Projects', mcpServers: true },
    ],
    resources: [
      { provides: 'designSystems', module: 'mod-design', type: 'children', to: 'design-systems', sources: [{ from: '.od/design-systems', include: ['atlas-*'] }] },
      { provides: 'projects', module: 'mod-projects', type: 'projects', from: '.od/projects', database: '.od/app.sqlite', to: 'projects' },
      { provides: 'designIndex', module: 'mod-projects', type: 'files', to: 'design-index', files: [{ from: '.od/design-index/index.json', to: 'index.json' }] },
    ],
    mcpServers: [{ id: 'refero', transport: 'http', url: 'https://api.example.test/mcp', authMode: 'none', headers: { Authorization: 'Bearer ${REFERO_MCP_TOKEN}' } }],
    ...extra,
  }));
}

afterEach(async () => {
  closeDatabase();
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

function newStore() {
  const dataDir = tempDir('mish-data-');
  const db = openDatabase(dataDir, { dataDir });
  const store = createMishPackStore({
    dataDir,
    userRoots: { skills: path.join(dataDir, 'skills'), designSystems: path.join(dataDir, 'design-systems') },
    projectsDir: path.join(dataDir, 'projects'),
    db: () => db,
    env: {},
  });
  return { dataDir, db, store };
}

describe('build-pack: saved projects', () => {
  it('packs project folders with their rows, reads the database only through a copy, and installs them', async () => {
    const source = tempDir('mish-private-');
    const live = writeCheckout(source);
    const odDir = path.join(source, '.od');
    const before = Object.fromEntries(readdirSync(odDir).filter((name) => name.startsWith('app.sqlite')).map((name) => [name, sha256(path.join(odDir, name))]));
    const map = path.join(tempDir('mish-map-'), 'map.json');
    writeMap(map);
    const out = path.join(tempDir('mish-out-'), 'packet.zip');
    const result = build([source, out, '--map', map, '--json']);
    const after = Object.fromEntries(readdirSync(odDir).filter((name) => name.startsWith('app.sqlite')).map((name) => [name, sha256(path.join(odDir, name))]));
    live.close();
    expect(result.status, result.stderr).toBe(0);
    // The checkout's database files are untouched: the same files with the same bytes.
    expect(after).toEqual(before);

    const summary = JSON.parse(result.stdout) as { skipped: Record<string, string[]>; warnings: string[]; resources: Array<{ resource: string; status: string }> };
    expect(summary.resources.find((entry) => entry.resource === 'projects')?.status).toBe('packed');
    expect(summary.resources.find((entry) => entry.resource === 'designIndex')?.status).toBe('skipped');
    expect(summary.skipped['project whose files live outside the checkout']).toEqual(['.od/projects/proj-outside']);
    expect(summary.skipped['project folder with no row in the app database']).toEqual(['.od/projects/no-row']);
    expect(summary.skipped['looks like a credential file']).toEqual(['projects/ds-atlas-one/.claude/settings.local.json', 'projects/ds-atlas-one/.env', 'projects/ds-atlas-one/.mcp.json']);
    expect(summary.warnings.join(' ')).toMatch(/1 project row\(s\) in the database have no folder/);
    expect(summary.warnings.join(' ')).toMatch(/linked folders on this computer/);
    expect(summary.warnings.join(' ')).toMatch(/1 packed file\(s\) contain text shaped like a credential; check them before you share the pack: projects\/proj-wal\/notes\.md/);

    const staging = tempDir('mish-extract-');
    await extractMishPackZip(out, staging);
    const rows = JSON.parse(readFileSync(path.join(staging, 'projects', 'projects.json'), 'utf8')) as { schema: string; projects: Array<{ id: string; metadata: Record<string, unknown> | null }> };
    expect(rows.schema).toBe('mish-pack-projects/1');
    expect(rows.projects.map((row) => row.id)).toEqual(['ds-atlas-one', 'proj-big-a', 'proj-big-b', 'proj-empty', 'proj-wal']);
    expect(rows.projects[0]!.metadata).toEqual({ kind: 'other', importedFrom: 'design-system' });
    expect(existsSync(path.join(staging, 'projects', 'proj-wal', 'notes.md'))).toBe(true);
    for (const left of ['.env', '.mcp.json', '.claude/settings.local.json']) {
      expect(existsSync(path.join(staging, 'projects', 'ds-atlas-one', ...left.split('/'))), left).toBe(false);
    }
    expect(existsSync(path.join(staging, 'projects', 'ds-atlas-one', 'node_modules'))).toBe(false);

    const { db, dataDir, store } = newStore();
    await store.start();
    const { pack } = await store.install(out);
    expect(pack.provides).toEqual(expect.arrayContaining([{ resource: 'projects', items: 5 }, { resource: 'designSystems', items: 1 }]));
    expect(getProject(db, 'ds-atlas-one')).toMatchObject({ name: 'Atlas preview', designSystemId: 'user:atlas-one', createdAt: 10, updatedAt: 20 });
    expect(getProject(db, 'proj-wal')).toMatchObject({ name: 'Written to the log only' });
    expect(readFileSync(path.join(dataDir, 'projects', 'ds-atlas-one', 'DESIGN.md'), 'utf8')).toBe('# Atlas preview');
    expect(getProject(db, 'proj-outside')).toBeNull();
  });

  it('splits modules into packs under --max-bytes and writes SHA256SUMS and inventory.json', async () => {
    const source = tempDir('mish-private-');
    writeCheckout(source, 700 * 1024).close();
    const map = path.join(tempDir('mish-map-'), 'map.json');
    writeMap(map);
    const outDir = path.join(tempDir('mish-out-'), 'packs');
    const result = build([source, outDir, '--map', map, '--split', '--max-bytes', '1MiB', '--json']);
    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as { packs: Array<{ id: string; file: string; resources: string[] }>; resources: Array<{ resource: string; status: string }> };
    // Two 700 KiB projects cannot share a 1 MiB pack: the projects module is cut into parts.
    expect(summary.packs.map((pack) => pack.id)).toEqual(['mod-design', 'mod-projects-1', 'mod-projects-2']);

    const inventory = JSON.parse(readFileSync(path.join(outDir, 'inventory.json'), 'utf8')) as {
      schema: string; version: string; packs: Array<{ id: string; version: string; file: string; bytes: number; sha256: string; resources: string[] }>;
    };
    expect(inventory).toMatchObject({ schema: 'mish-pack-inventory/1', version: '9.9.9' });
    const sums = readFileSync(path.join(outDir, 'SHA256SUMS'), 'utf8').trim().split('\n').map((line) => line.split('  '));
    expect(sums.map(([, file]) => file).sort()).toEqual(inventory.packs.map((entry) => entry.file).sort());
    for (const entry of inventory.packs) {
      const file = path.join(outDir, entry.file);
      expect(entry.file).toBe(`${entry.id}-9.9.9.zip`);
      expect(statSync(file).size).toBe(entry.bytes);
      expect(sha256(file)).toBe(entry.sha256);
      expect(sums.find(([, name]) => name === entry.file)?.[0]).toBe(entry.sha256);
    }

    // Every part installs on its own, and together they bring every project.
    const { db, dataDir, store } = newStore();
    await store.start();
    for (const entry of inventory.packs) await store.install(path.join(outDir, entry.file));
    for (const id of ['ds-atlas-one', 'proj-big-a', 'proj-big-b', 'proj-empty', 'proj-wal']) expect(getProject(db, id), id).not.toBeNull();
    expect(existsSync(path.join(dataDir, 'design-systems', 'atlas-one', 'DESIGN.md'))).toBe(true);
    // The MCP servers go with the first part of the module that asks for them, once.
    const manifests = inventory.packs.map((entry) => JSON.parse(readFileSync(path.join(dataDir, 'mish-packs', entry.id, 'mish-pack.json'), 'utf8')) as { provides: { mcpServers?: unknown[] } });
    expect(manifests.map((manifest) => manifest.provides.mcpServers?.length ?? 0)).toEqual([0, 1, 0]);
  });

  it('refuses --split when a resource names no module, and an output folder that is not empty', async () => {
    const source = tempDir('mish-private-');
    writeCheckout(source).close();
    const map = path.join(tempDir('mish-map-'), 'map.json');
    writeMap(map, { modules: [{ id: 'mod-design', name: 'Design systems' }] });
    expect(build([source, path.join(tempDir('mish-out-'), 'packs'), '--map', map, '--split']).stderr).toMatch(/names module "mod-projects", which the map does not list/);
    const full = tempDir('mish-out-');
    await fsp.writeFile(path.join(full, 'keep.txt'), 'keep');
    writeMap(map);
    expect(build([source, full, '--map', map, '--split']).stderr).toMatch(/already exists/);
    expect(readdirSync(full)).toEqual(['keep.txt']);
  });
});

describe('large files', () => {
  it('streams a file above the in-memory threshold into the zip and back out', async () => {
    const dir = tempDir('mish-large-');
    const big = path.join(dir, 'big.bin');
    // 65 MiB: above the writer's 64 MiB threshold, so it is stored and streamed in both directions.
    const chunk = randomBytes(1024 * 1024);
    const handle = await fsp.open(big, 'w');
    for (let i = 0; i < 65; i += 1) await handle.write(chunk);
    await handle.close();
    const writerModule = await import(pathToFileURL(path.join(repoRoot, 'scripts', 'lib', 'zip-writer.mjs')).href) as {
      ZipWriter: new (file: string) => { addFile(name: string, file: string): Promise<void>; addBuffer(name: string, data: Buffer): Promise<void>; finish(): Promise<void> };
    };
    const zipFile = path.join(dir, 'big.zip');
    const zip = new writerModule.ZipWriter(zipFile);
    await zip.addBuffer('mish-pack.json', Buffer.from('{}'));
    await zip.addFile('assets/big.bin', big);
    await zip.finish();

    const staging = tempDir('mish-extract-');
    await extractMishPackZip(zipFile, staging);
    expect(sha256(path.join(staging, 'assets', 'big.bin'))).toBe(sha256(big));
    // The per-file limit holds for a streamed entry too.
    const small = tempDir('mish-extract-');
    await expect(extractMishPackZip(zipFile, small, { ...DEFAULT_MISH_PACK_LIMITS, fileMaxBytes: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });
});
