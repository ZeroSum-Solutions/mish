import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const state = vi.hoisted(() => ({ imported: 0, options: [] as unknown[], fail: false }));
vi.mock('../src/server.js', () => {
  state.imported += 1;
  return { startServer: vi.fn(async (options: unknown) => { state.options.push(options); if (state.fail) throw new Error('server start failed'); return { url: 'http://127.0.0.1:0', server: { listening: false } }; }) };
});
import { startDaemonRuntime } from '../src/daemon-startup.js';
import { PLACEMENT_OWNER_ENV } from '../src/workbench/placement/owner-bootstrap.js';
import { migratePlacementJournal, PlacementJournal } from '../src/workbench/placement/journal.js';
import { acquireExclusiveRootLock, PLACEMENT_ROOT_LOCK } from '../src/workbench/placement/root-seal.js';
import { writeFileSync } from 'node:fs';

const saved = { ...process.env };
afterEach(() => { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); });

describe('daemon startup placement boundary (server module is the eager-mutation boundary)', () => {
  it('a supplied invalid binding refuses before the server module is imported', async () => {
    process.env.OD_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'startup-refusal-')), 'data');
    process.env[PLACEMENT_OWNER_ENV.binding] = '/missing/owner.node';
    await expect(startDaemonRuntime({ port: 0 })).rejects.toMatchObject({ name: 'PlacementBootstrapError', reason: 'binding-input-malformed' });
    expect(state.imported).toBe(0);
    expect(process.env[PLACEMENT_OWNER_ENV.binding]).toBeUndefined();
  });
  it('no input reaches the server as constructor-sourced not-activated ordinary mode', async () => {
    process.env.OD_DATA_DIR = join(mkdtempSync(join(tmpdir(), 'startup-ordinary-')), 'data');
    await startDaemonRuntime({ port: 0 });
    expect(state.imported).toBe(1);
    expect(state.options.at(-1)).toMatchObject({ returnServer: true, placementBootstrap: { mode: 'ordinary-uncoordinated', reason: 'not-activated', transition: { kind: 'no-database' } } });
  });
  it('a globally closed ordinary transition refuses before the server import, preserving durable bytes', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'startup-transition-')), 'data'); mkdirSync(dataDir);
    const file = join(dataDir, 'app.sqlite');
    const db = new Database(file); db.pragma('journal_mode=WAL'); db.pragma('synchronous=FULL'); db.pragma('foreign_keys=ON');
    migratePlacementJournal(db);
    new PlacementJournal({ db, incarnationId: 'coordinated-before-loss' }).recordLaunchIntent({ launchId: 'unknown-spawn', kind: 'child', projectRoots: [], intentDigest: 'a'.repeat(64) });
    db.close();
    const digest = (name: string) => existsSync(join(dataDir, name)) ? createHash('sha256').update(readFileSync(join(dataDir, name))).digest('hex') : null;
    const before = { db: digest('app.sqlite'), wal: digest('app.sqlite-wal') };
    process.env.OD_DATA_DIR = dataDir;
    const imported = state.imported;
    await expect(startDaemonRuntime({ port: 0 })).rejects.toMatchObject({ name: 'PlacementBootstrapError', reason: 'transition-closed:launch-unresolved', status: 503 });
    expect(state.imported).toBe(imported);
    // Database bytes are unchanged. The read-only WAL reader may create an empty -wal/-shm (captured reader effect).
    expect(digest('app.sqlite')).toBe(before.db);
    expect([before.wal, createHash('sha256').update('').digest('hex')]).toContain(digest('app.sqlite-wal'));
    expect(readdirSync(dataDir).filter(name => !name.startsWith('app.sqlite')).sort()).toEqual([]);
    const readonly = new Database(file, { readonly: true });
    expect(readonly.prepare('SELECT id FROM placement_journal_incarnations').all()).toEqual([{ id: 'coordinated-before-loss' }]);
    expect(readonly.prepare("SELECT name FROM sqlite_master WHERE name='workbench_owned_migrations'").all()).toEqual([]);
    readonly.close();
  });
  it.skipIf(process.platform !== 'darwin')('[Sol r2 WARN 1] a failed ordinary startup releases the shared root lock', async () => {
    const dataDir = join(mkdtempSync(join(tmpdir(), 'startup-lock-')), 'data'); mkdirSync(dataDir);
    writeFileSync(join(dataDir, PLACEMENT_ROOT_LOCK), '', { mode: 0o600 }); // A root a coordinated daemon used before.
    process.env.OD_DATA_DIR = dataDir;
    state.fail = true;
    try { await expect(startDaemonRuntime({ port: 0 })).rejects.toThrow('server start failed'); }
    finally { state.fail = false; }
    const exclusive = acquireExclusiveRootLock(dataDir, { create: false });
    expect(exclusive.kind).toBe('held');
    if (exclusive.kind === 'held') exclusive.lock.release();
  });
});
