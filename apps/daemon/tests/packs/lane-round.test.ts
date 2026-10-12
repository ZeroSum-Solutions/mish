// P1-1 lane round (Opus review, 2026-10-07): folder digest owner decision,
// W1, W2 and N1, N4, N6, N7. Fixtures are synthetic (tests/fixtures/licensed-pack).

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parsePackManifest } from '@open-design/contracts';

import type { PackContentHandler } from '../../src/packs/handlers.js';
import { PackError, packManifestDigest } from '../../src/packs/manifest.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { createPackService, type PackServiceOptions } from '../../src/packs/service.js';
import {
  FIXTURE_PACK_ID,
  fixtureKitFiles,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixturePack,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Call {
  op: 'activate' | 'retract';
  packId: string;
  version: string;
  entries: number;
  previousVersion: string | null;
}

function recording(behaviour: { failActivate?: boolean } = {}) {
  const calls: Call[] = [];
  const handler: PackContentHandler<'plugins'> = {
    kind: 'plugins',
    async activate(ctx) {
      calls.push({ op: 'activate', packId: ctx.packId, version: ctx.version, entries: ctx.entries.length, previousVersion: ctx.previousVersion });
      if (behaviour.failActivate) throw Object.assign(new Error('nope'), { code: 'NOPE' });
    },
    async retract(ctx) {
      calls.push({ op: 'retract', packId: ctx.packId, version: ctx.version, entries: ctx.entries.length, previousVersion: ctx.previousVersion });
    },
  };
  return { handler, calls };
}

function pluginPack(options: FixturePackOptions = {}): FixturePackOptions {
  return {
    ...options,
    files: [...fixtureKitFiles(), { path: 'plugins/alpha/open-design.json', content: '{"id":"alpha"}\n' }],
    contents: [
      { kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo' },
      { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'plugins', ids: ['alpha'] },
    ],
  };
}

async function archiveOf(options: FixturePackOptions = {}): Promise<string> {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir);
  cleanup.push(path.dirname(archivePath));
  writeSidecar(archivePath);
  return archivePath;
}

function folderDigest(pack: FixturePack): string {
  const parsed = parsePackManifest(JSON.parse(pack.manifestBytes.toString('utf8')));
  if (!parsed.ok) throw new Error('fixture manifest is invalid');
  return packManifestDigest(parsed.manifest);
}

function setup(options: Partial<PackServiceOptions> = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry, ...options });
  return { packsDir, registry, service };
}

function receiptOf(packsDir: string): Record<string, unknown> & { handlers: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8'));
}

async function failure(promise: Promise<unknown>): Promise<PackError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PackError);
  return error as PackError;
}

describe('folder digest (owner decision 2026-10-07, item 0)', () => {
  it('a folder install without the canonical pack.json sha256 fails DIGEST_REQUIRED; a wrong one fails INTEGRITY_MISMATCH even with force; the right one installs', async () => {
    const { registry, service } = setup();
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    expect((await failure(service.install({ kind: 'folder', path: pack.dir, force: true }))).code).toBe('DIGEST_REQUIRED');
    // A .sha256 sidecar is not a folder digest source.
    writeFileSync(`${pack.dir}.sha256`, `${folderDigest(pack)}\n`);
    cleanup.push(`${pack.dir}.sha256`);
    expect((await failure(service.install({ kind: 'folder', path: pack.dir }))).code).toBe('DIGEST_REQUIRED');
    expect(
      (await failure(service.install({ kind: 'folder', path: pack.dir, sha256: 'a'.repeat(64), force: true }))).code,
    ).toBe('INTEGRITY_MISMATCH');
    expect(registry.list()).toEqual([]);

    const result = await service.install({ kind: 'folder', path: pack.dir, sha256: folderDigest(pack).toUpperCase() });
    expect(result.outcome).toBe('installed');
    expect(result.pack.digest).toBe(folderDigest(pack));
  });
});

describe('W1: an upgrade that fails after the dropped-kind retract', () => {
  for (const fault of ['EBUSY on the move to .trash', 'a failed receipt write'] as const) {
    it(`re-activates the dropped kinds on the previous version and writes their status back (${fault})`, async () => {
      const { handler, calls } = recording();
      let armed = false;
      let receiptWrites = 0;
      const { packsDir, registry, service } = setup({
        handlers: [handler],
        fsOps: {
          rename: async (from, to) => {
            if (armed && fault === 'EBUSY on the move to .trash' && to.includes(`${path.sep}.trash${path.sep}`)) {
              throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (armed && fault === 'a failed receipt write' && to.endsWith(`${FIXTURE_PACK_ID}.json`)) {
              receiptWrites += 1;
              // 1: the pending intent before the retract, 2: the new version's receipt.
              if (receiptWrites === 2) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
            }
            await fsp.rename(from, to);
          },
        },
      });
      await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
      calls.length = 0;
      armed = true;
      const error = await failure(service.install({ kind: 'archive-file', path: await archiveOf({ version: '2.0.0' }) }));
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(calls.map((call) => `${call.op}@${call.version}`)).toEqual(['retract@1.0.0', 'activate@1.0.0']);
      const pack = registry.get(FIXTURE_PACK_ID);
      expect(pack?.version).toBe('1.0.0');
      expect(pack?.status).toBe('ready');
      expect(receiptOf(packsDir).handlers).toEqual({ plugins: 'active' });
    });
  }
});

describe('W2: retract by receipt when the manifest is unreadable', () => {
  it('remove() retracts a registered kind with packId and version from the receipt and empty entries', async () => {
    const { handler, calls } = recording();
    const { packsDir, registry, service } = setup({ handlers: [handler] });
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
    calls.length = 0;
    writeFileSync(path.join(packsDir, FIXTURE_PACK_ID, 'pack.json'), '{not json');
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('damaged');
    await service.remove(FIXTURE_PACK_ID);
    expect(calls).toEqual([{ op: 'retract', packId: FIXTURE_PACK_ID, version: '1.0.0', entries: 0, previousVersion: null }]);
    expect(registry.get(FIXTURE_PACK_ID)).toBeNull();
  });

  it('installing over a damaged pack retracts the old registration by receipt first', async () => {
    const { handler, calls } = recording();
    const { packsDir, service } = setup({ handlers: [handler] });
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
    calls.length = 0;
    writeFileSync(path.join(packsDir, FIXTURE_PACK_ID, 'pack.json'), '{not json');
    const result = await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack({ version: '1.0.0' })) });
    expect(result.pack.status).toBe('ready');
    expect(calls.map((call) => `${call.op}@${call.version}:${call.entries}`)).toEqual(['retract@1.0.0:0', 'activate@1.0.0:1']);
  });

  it('a kind the receipt marks unhandled is not retracted', async () => {
    const { packsDir, registry } = setup();
    const bare = createPackService({ registry });
    await bare.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
    writeFileSync(path.join(packsDir, FIXTURE_PACK_ID, 'pack.json'), '{not json');
    const { handler, calls } = recording();
    const later = createPackService({ registry, handlers: [handler] });
    await later.remove(FIXTURE_PACK_ID);
    expect(calls).toEqual([]);
  });
});

describe('N1: force re-copies and re-verifies the same version', () => {
  it('a forced same-version install replaces a tampered installed file', async () => {
    const { packsDir, service } = setup();
    const archive = await archiveOf();
    await service.install({ kind: 'archive-file', path: archive });
    const target = path.join(packsDir, FIXTURE_PACK_ID, 'kits', 'demo', 'manifest.json');
    const original = readFileSync(target);
    writeFileSync(target, 'tampered');
    expect((await service.install({ kind: 'archive-file', path: archive })).outcome).toBe('unchanged');
    expect(readFileSync(target, 'utf8')).toBe('tampered');
    const forced = await service.install({ kind: 'archive-file', path: archive, force: true });
    expect(forced.outcome).toBe('installed');
    expect(readFileSync(target)).toEqual(original);
  });
});

describe('N4: .receipts must be a real folder for reads and deletes', () => {
  it('a .receipts link to .credentials makes the pack damaged and remove() refuses without touching .credentials', async () => {
    const { packsDir, registry, service } = setup();
    await service.install({ kind: 'archive-file', path: await archiveOf({ id: 'github' }) });
    const credentials = path.join(packsDir, '.credentials');
    mkdirSync(credentials);
    // A token store whose file name matches the pack id.
    writeFileSync(path.join(credentials, 'github.json'), readFileSync(path.join(packsDir, '.receipts', 'github.json')));
    renameSync(path.join(packsDir, '.receipts'), path.join(packsDir, '.receipts-old'));
    symlinkSync(credentials, path.join(packsDir, '.receipts'));
    expect(registry.get('github')?.status).toBe('damaged');
    const error = await failure(service.remove('github'));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(existsSync(path.join(credentials, 'github.json'))).toBe(true);
    await registry.reconcile();
    expect(existsSync(path.join(credentials, 'github.json'))).toBe(true);
  });
});

describe('N6 and N7: replaced version while pending, and change notices', () => {
  it('keeps the replaced version in the receipt while a kind is not active, passes it as previousVersion, and bumps the generation after status writes', async () => {
    const behaviour = { failActivate: false };
    const flaky = recording(behaviour);
    const { packsDir, registry, service } = setup({ handlers: [flaky.handler] });
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
    behaviour.failActivate = true;
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack({ version: '2.0.0' })) });
    expect(receiptOf(packsDir)).toMatchObject({ version: '2.0.0', replacedVersion: '1.0.0', handlers: { plugins: 'failed:NOPE' } });

    behaviour.failActivate = false;
    flaky.calls.length = 0;
    const before = registry.generation();
    await service.activatePending();
    expect(flaky.calls).toEqual([{ op: 'activate', packId: FIXTURE_PACK_ID, version: '2.0.0', entries: 1, previousVersion: '1.0.0' }]);
    expect(registry.generation()).toBeGreaterThan(before);
    const receipt = receiptOf(packsDir);
    expect(receipt.handlers).toEqual({ plugins: 'active' });
    expect(receipt.replacedVersion).toBeUndefined();
  });

  it('a same-version repair bumps the generation after its receipt write', async () => {
    const behaviour = { failActivate: true };
    const flaky = recording(behaviour);
    const { registry, service } = setup({ handlers: [flaky.handler] });
    const archive = await archiveOf(pluginPack());
    await service.install({ kind: 'archive-file', path: archive });
    behaviour.failActivate = false;
    const before = registry.generation();
    expect((await service.install({ kind: 'archive-file', path: archive })).outcome).toBe('unchanged');
    expect(registry.generation()).toBeGreaterThan(before);
  });
});

describe('Sol review (PR #191): remove() when the move to .trash fails', () => {
  it('restores the receipt and the retracted registrations, so the pack stays ready and active', async () => {
    const { handler, calls } = recording();
    let armed = false;
    const { packsDir, registry, service } = setup({
      handlers: [handler],
      fsOps: {
        rename: async (from, to) => {
          if (armed && to.includes(`${path.sep}.trash${path.sep}`)) {
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
          }
          await fsp.rename(from, to);
        },
      },
    });
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
    const before = receiptOf(packsDir);
    calls.length = 0;
    armed = true;
    const error = await failure(service.remove(FIXTURE_PACK_ID));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(calls.map((call) => `${call.op}@${call.version}`)).toEqual(['retract@1.0.0', 'activate@1.0.0']);
    const pack = registry.get(FIXTURE_PACK_ID);
    expect(pack?.status).toBe('ready');
    expect(pack?.version).toBe('1.0.0');
    expect(existsSync(path.join(packsDir, FIXTURE_PACK_ID, 'pack.json'))).toBe(true);
    const after = receiptOf(packsDir);
    expect(after.handlers).toEqual({ plugins: 'active' });
    expect(after.digest).toBe(before.digest);
    expect(after.installedAt).toBe(before.installedAt);
  });
});

describe('Sol hold (PR #191, BLOCK 2): remove() validates .trash before it retracts or deletes the receipt', () => {
  for (const shape of ['a symlink to another folder', 'a regular file'] as const) {
    it(`.trash is ${shape}: remove() fails and the pack is byte-for-byte as before, with no retract`, async () => {
      const { handler, calls } = recording();
      const { packsDir, registry, service } = setup({ handlers: [handler] });
      await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) });
      const receiptPath = path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`);
      const receiptBytes = readFileSync(receiptPath);
      const trash = path.join(packsDir, '.trash');
      await rm(trash, { recursive: true, force: true });
      if (shape === 'a regular file') {
        writeFileSync(trash, 'not a folder');
      } else {
        const elsewhere = mkdtempSync(path.join(tmpdir(), 'od-pack-trash-target-'));
        cleanup.push(elsewhere);
        symlinkSync(elsewhere, trash, 'dir');
      }
      calls.length = 0;
      const error = await failure(service.remove(FIXTURE_PACK_ID));
      expect(error.code).toBe('INTERNAL_ERROR');
      expect(calls).toEqual([]);
      expect(readFileSync(receiptPath).equals(receiptBytes)).toBe(true);
      registry.invalidate();
      const pack = registry.get(FIXTURE_PACK_ID);
      expect(pack?.status).toBe('ready');
      expect(pack?.version).toBe('1.0.0');
      expect(existsSync(path.join(packsDir, FIXTURE_PACK_ID, 'pack.json'))).toBe(true);
    });
  }
});
