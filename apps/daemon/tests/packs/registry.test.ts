// P1-1 specs 4 and 4b: the pack registry (live lookup, path containment,
// crash reconciliation) and the `.credentials` boundary P1-3 relies on.

import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createPackRegistry, packsDirForDataDir, type PackRegistry } from '../../src/packs/registry.js';
import { createPackService, type PackService } from '../../src/packs/service.js';
import {
  FIXTURE_KIT_ID,
  FIXTURE_PACK_ID,
  listDir,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function setup(): { dataDir: string; packsDir: string; registry: PackRegistry; service: PackService } {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  return { dataDir, packsDir, registry, service: createPackService({ packsDir, registry }) };
}

async function install(service: PackService, options: FixturePackOptions = {}) {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir);
  cleanup.push(path.dirname(archivePath));
  writeSidecar(archivePath);
  return service.install({ kind: 'archive-file', path: archivePath }, () => undefined);
}

describe('pack registry (P1-1 spec 4)', () => {
  it("the registry has no data-root default, answers provider('component-kit','demo-kit') from disk at call time, bumps generation on install and remove, refuses path escapes, and reconciles crash residue", async () => {
    expect(() => createPackRegistry({} as never)).toThrow();
    expect(() => createPackRegistry({ packsDir: 'relative/packs' })).toThrow();
    expect(packsDirForDataDir('/data/root')).toBe(path.join('/data/root', 'packs'));

    const { packsDir, registry, service } = setup();
    expect(registry.list()).toEqual([]);
    expect(registry.provider('component-kit', FIXTURE_KIT_ID)).toBeNull();
    expect(existsSync(packsDir)).toBe(false);

    const changes: number[] = [];
    const stop = registry.onChange((generation) => changes.push(generation));
    const before = registry.generation();
    await install(service);
    expect(registry.generation()).toBeGreaterThan(before);
    expect(changes.length).toBeGreaterThan(0);

    // Same registry object, no reconstruction: the pack is visible.
    const kit = registry.provider('component-kit', FIXTURE_KIT_ID);
    expect(kit).not.toBeNull();
    expect(kit?.packId).toBe(FIXTURE_PACK_ID);
    expect(kit?.packVersion).toBe('1.0.0');
    expect(kit?.schema).toBe('od-cult-kit/1');
    expect(kit?.absPath).toBe(path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'demo'));
    expect(kit?.files.every((file) => file.path.startsWith('kits/demo/'))).toBe(true);
    expect(registry.provider('component-kit')).not.toBeNull();
    expect(registry.provider('component-kit', 'other-kit')).toBeNull();
    expect(registry.provider('genui-overlay')).toBeNull();
    expect(registry.contents('component-kit')).toHaveLength(1);

    // Path containment.
    const manifestPath = registry.resolvePath(FIXTURE_PACK_ID, 'kits/demo/manifest.json');
    expect(manifestPath).not.toBeNull();
    expect(readFileSync(manifestPath!, 'utf8')).toContain('synthetic');
    expect(registry.resolvePath(FIXTURE_PACK_ID, '../x')).toBeNull();
    expect(registry.resolvePath(FIXTURE_PACK_ID, 'kits/../../x')).toBeNull();
    expect(registry.resolvePath(FIXTURE_PACK_ID, '/etc/hosts')).toBeNull();
    expect(registry.resolvePath('../escape', 'pack.json')).toBeNull();
    expect(registry.resolvePath('not-installed', 'pack.json')).toBeNull();
    expect(registry.resolvePath(FIXTURE_PACK_ID, 'kits/demo/absent.json')).toBeNull();
    const outside = mkdtempSync(path.join(tmpdir(), 'od-pack-outside-'));
    cleanup.push(outside);
    writeFileSync(path.join(outside, 'secret.txt'), 'outside');
    symlinkSync(path.join(outside, 'secret.txt'), path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'demo', 'escape.txt'));
    symlinkSync(outside, path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'escape-dir'));
    expect(registry.resolvePath(FIXTURE_PACK_ID, 'kits/demo/escape.txt')).toBeNull();
    expect(registry.resolvePath(FIXTURE_PACK_ID, 'kits/escape-dir/secret.txt')).toBeNull();
    rmSync(path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'demo', 'escape.txt'));
    rmSync(path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'escape-dir'));

    // Removal bumps the generation and the provider disappears.
    const beforeRemove = registry.generation();
    const removed = await service.remove(FIXTURE_PACK_ID);
    expect(removed.removedVersion).toBe('1.0.0');
    expect(registry.generation()).toBeGreaterThan(beforeRemove);
    expect(registry.provider('component-kit', FIXTURE_KIT_ID)).toBeNull();
    stop();

    // Crash residue: a leftover staging tree, and a pack found only in .trash/
    // (crash between "move live to trash" and "move staged to live").
    await install(service);
    mkdirSync(path.join(packsDir, '.staging', 'leftover', 'deep'), { recursive: true });
    writeFileSync(path.join(packsDir, '.staging', 'leftover', 'deep', 'x.bin'), 'x');
    writeFileSync(path.join(packsDir, '.staging', 'upload-123.tgz'), 'x');
    mkdirSync(path.join(packsDir, '.trash'), { recursive: true });
    renameSync(path.join(packsDir, FIXTURE_PACK_ID), path.join(packsDir, '.trash', `${FIXTURE_PACK_ID}@1700000000000-abcd1234`));
    expect(registry.get(FIXTURE_PACK_ID)).toBeNull();
    const report = await registry.reconcile();
    expect(report.stagingRemoved).toBe(2);
    expect(report.restored).toEqual([FIXTURE_PACK_ID]);
    expect(listDir(path.join(packsDir, '.staging'))).toEqual([]);
    expect(listDir(path.join(packsDir, '.trash'))).toEqual([]);
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
    expect(registry.provider('component-kit', FIXTURE_KIT_ID)).not.toBeNull();
  });

  it('reconcile rolls back a swap that crashed before the new receipt was written, and drops orphan trash', async () => {
    const { packsDir, registry, service } = setup();
    await install(service);
    const saved = mkdtempSync(path.join(tmpdir(), 'od-pack-saved-'));
    cleanup.push(saved);
    cpSync(path.join(packsDir, FIXTURE_PACK_ID), path.join(saved, 'v1'), { recursive: true });
    const receiptPath = path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`);
    const v1Receipt = readFileSync(receiptPath);
    await install(service, { version: '2.0.0' });
    expect(registry.get(FIXTURE_PACK_ID)?.version).toBe('2.0.0');

    // State after the second rename but before the receipt write.
    cpSync(path.join(saved, 'v1'), path.join(packsDir, '.trash', `${FIXTURE_PACK_ID}@1700000000000-feedbeef`), { recursive: true });
    writeFileSync(receiptPath, v1Receipt);
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('damaged');
    // Orphan trash for a pack that is not installed and has no receipt.
    cpSync(path.join(saved, 'v1'), path.join(packsDir, '.trash', 'gone-pack@1700000000000-00000000'), { recursive: true });
    writeFileSync(path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json.tmp-1234`), '{');

    const report = await registry.reconcile();
    expect(report.rolledBack).toEqual([FIXTURE_PACK_ID]);
    expect(report.restored).toEqual([]);
    expect(registry.get(FIXTURE_PACK_ID)?.version).toBe('1.0.0');
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
    expect(registry.get('gone-pack')).toBeNull();
    expect(listDir(path.join(packsDir, '.trash'))).toEqual([]);
    expect(listDir(path.join(packsDir, '.staging'))).toEqual([]);
    expect(listDir(path.join(packsDir, '.receipts'))).toEqual([`${FIXTURE_PACK_ID}.json`]);
  });

  it('marks a pack damaged when pack.json is missing or unreadable, its id differs from its folder, or it has no receipt', async () => {
    const { packsDir, registry, service } = setup();
    await install(service);
    const packJson = path.join(packsDir, FIXTURE_PACK_ID, 'pack.json');
    const original = readFileSync(packJson);

    writeFileSync(packJson, '{ not json');
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('damaged');
    expect(registry.provider('component-kit', FIXTURE_KIT_ID)).toBeNull();
    expect(registry.resolvePath(FIXTURE_PACK_ID, 'pack.json')).toBeNull();

    rmSync(packJson);
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('damaged');
    writeFileSync(packJson, original);
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');

    cpSync(path.join(packsDir, FIXTURE_PACK_ID), path.join(packsDir, 'renamed-pack'), { recursive: true });
    expect(registry.get('renamed-pack')?.status).toBe('damaged');
    expect(registry.get('renamed-pack')?.problem).toBeTruthy();
    rmSync(path.join(packsDir, 'renamed-pack'), { recursive: true });

    rmSync(path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`));
    const damaged = registry.get(FIXTURE_PACK_ID);
    expect(damaged?.status).toBe('damaged');
    expect(damaged?.problem).not.toContain(packsDir);
  });
});

describe('the .credentials boundary (P1-1 spec 4b)', () => {
  it('list(), reconcile() and remove() leave .credentials/github.json byte-identical and never report it as a pack', async () => {
    const { packsDir, registry, service } = setup();
    await install(service);
    const credentialsDir = path.join(packsDir, '.credentials');
    mkdirSync(credentialsDir, { recursive: true, mode: 0o700 });
    const credentialPath = path.join(credentialsDir, 'github.json');
    const bytes = Buffer.from(JSON.stringify({ schemaVersion: 1, token: 'synthetic-not-a-token' }));
    writeFileSync(credentialPath, bytes, { mode: 0o600 });
    writeFileSync(path.join(packsDir, '.DS_Store'), 'finder');
    mkdirSync(path.join(packsDir, '.other-tool'));

    expect(registry.list().map((pack) => pack.id)).toEqual([FIXTURE_PACK_ID]);
    await registry.reconcile();
    expect(registry.list().map((pack) => pack.id)).toEqual([FIXTURE_PACK_ID]);
    expect((await service.remove(FIXTURE_PACK_ID)).id).toBe(FIXTURE_PACK_ID);
    await registry.reconcile();
    expect(registry.list()).toEqual([]);
    expect(service.list()).toEqual([]);

    // A working folder replaced by a link to .credentials is never traversed or written through.
    rmSync(path.join(packsDir, '.staging'), { recursive: true, force: true });
    symlinkSync(credentialsDir, path.join(packsDir, '.staging'));
    await registry.reconcile();
    await expect(install(service)).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(() => service.stagingDir()).toThrow();
    expect(readFileSync(credentialPath)).toEqual(bytes);
    expect(listDir(credentialsDir)).toEqual(['github.json']);
    expect(existsSync(path.join(packsDir, '.other-tool'))).toBe(true);
    await expect(service.remove('.credentials')).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(readFileSync(credentialPath)).toEqual(bytes);
  });
});
