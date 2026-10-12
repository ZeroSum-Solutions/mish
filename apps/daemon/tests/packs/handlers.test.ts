// P1-1 spec 5: the content-handler hook P1-5's `plugins` handler plugs into.

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { PackContentHandler, PackContentHandlerContext } from '../../src/packs/handlers.js';
import { PackError } from '../../src/packs/manifest.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { createPackService } from '../../src/packs/service.js';
import {
  FIXTURE_PACK_ID,
  fixtureKitFiles,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Call {
  op: 'activate' | 'retract';
  version: string;
  ids: string[];
  packJsonVersion: string | null;
  previousVersion: string | null;
}

function recordingHandler(behaviour: { failActivate?: boolean; failRetract?: boolean } = {}) {
  const calls: Call[] = [];
  const record = (op: Call['op'], ctx: PackContentHandlerContext<'plugins'>): void => {
    const packJson = path.join(ctx.packDir, 'pack.json');
    calls.push({
      op,
      version: ctx.version,
      ids: ctx.entries.flatMap((entry) => entry.ids),
      packJsonVersion: existsSync(packJson) ? (JSON.parse(readFileSync(packJson, 'utf8')) as { version: string }).version : null,
      previousVersion: ctx.previousVersion,
    });
  };
  const handler: PackContentHandler<'plugins'> = {
    kind: 'plugins',
    async activate(ctx) {
      record('activate', ctx);
      for (const entry of ctx.entries) {
        for (const id of entry.ids) {
          if (!existsSync(path.join(entry.absPath, id, 'open-design.json'))) throw new Error('fixture plugin missing');
        }
      }
      if (behaviour.failActivate) throw Object.assign(new Error('activate failed'), { code: 'PLUGIN_REFUSED' });
    },
    async retract(ctx) {
      record('retract', ctx);
      if (behaviour.failRetract) throw new Error('retract failed');
    },
  };
  return { handler, calls };
}

function pluginPack(options: FixturePackOptions = {}): FixturePackOptions {
  return {
    ...options,
    files: [
      ...fixtureKitFiles(),
      { path: 'plugins/alpha/open-design.json', content: '{"id":"alpha"}\n' },
      { path: 'plugins/alpha/SKILL.md', content: '# alpha\n' },
      { path: 'more-plugins/beta/open-design.json', content: '{"id":"beta"}\n' },
    ],
    contents: [
      { kind: 'component-kit', schema: 'od-cult-kit/1', id: 'demo-kit', path: 'kits/demo' },
      { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'plugins', ids: ['alpha'] },
      { kind: 'plugins', schema: 'od-plugin-dir/1', path: 'more-plugins', ids: ['beta'] },
    ],
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

function setup(handlers: PackContentHandler<'plugins'>[]) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry, handlers });
  return { packsDir, registry, service };
}

function readReceipt(packsDir: string): { handlers: Record<string, string> } {
  return JSON.parse(readFileSync(path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8'));
}

describe('content handlers (P1-1 spec 5)', () => {
  it('activate runs once per content kind after the swap, retract runs before removal, a failing retract keeps the pack installed, and a kind with no handler yields a warning', async () => {
    // Activate: once for the plugins kind (both entries), seeing the new bytes.
    const ok = recordingHandler();
    const { packsDir, registry, service } = setup([ok.handler]);
    const v1 = await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    expect(v1.warnings).toEqual([]);
    expect(ok.calls).toEqual([
      { op: 'activate', version: '1.0.0', ids: ['alpha', 'beta'], packJsonVersion: '1.0.0', previousVersion: null },
    ]);
    expect(readReceipt(packsDir).handlers).toEqual({ plugins: 'active' });

    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack({ version: '1.1.0' })) }, () => undefined);
    expect(ok.calls.at(-1)).toEqual({
      op: 'activate',
      version: '1.1.0',
      ids: ['alpha', 'beta'],
      packJsonVersion: '1.1.0',
      previousVersion: '1.0.0',
    });

    // Retract: before the bytes go away.
    await service.remove(FIXTURE_PACK_ID);
    expect(ok.calls.at(-1)).toMatchObject({ op: 'retract', version: '1.1.0', packJsonVersion: '1.1.0' });
    expect(registry.get(FIXTURE_PACK_ID)).toBeNull();

    // A failing retract aborts the removal.
    const stuck = recordingHandler({ failRetract: true });
    const second = setup([stuck.handler]);
    await second.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    const error = await second.service.remove(FIXTURE_PACK_ID).then(
      () => null,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(PackError);
    expect((error as PackError).code).toBe('RETRACT_FAILED');
    expect(second.registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
    expect(existsSync(path.join(second.packsDir, FIXTURE_PACK_ID, 'plugins', 'alpha', 'open-design.json'))).toBe(true);
    expect(existsSync(path.join(second.packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`))).toBe(true);
    // The content was registered again after the failed retract, and the receipt says so.
    expect(stuck.calls.map((call) => call.op)).toEqual(['activate', 'retract', 'activate']);
    expect(readReceipt(second.packsDir).handlers).toEqual({ plugins: 'active' });

    // No handler for a kind that needs one: installed, with a warning.
    const bare = setup([]);
    const result = await bare.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    expect(result.warnings).toEqual(['plugins content is not registered by this build']);
    expect(result.pack.status).toBe('ready');
    expect(readReceipt(bare.packsDir).handlers).toEqual({ plugins: 'unhandled' });
    // The pull kinds (component-kit, cult-catalog, genui-overlay) need no handler and warn nothing.
    const kitOnly = await bare.service.install(
      { kind: 'archive-file', path: await archiveOf({ id: 'kit-only', contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'other-kit', path: 'kits/demo' }] }) },
      () => undefined,
    );
    expect(kitOnly.warnings).toEqual([]);
  });

  it('a failing activate leaves the bytes installed, marks the pack degraded, and a re-install repairs it', async () => {
    const behaviour = { failActivate: true };
    const flaky = recordingHandler(behaviour);
    const { packsDir, registry, service } = setup([flaky.handler]);
    const archive = await archiveOf(pluginPack());
    const result = await service.install({ kind: 'archive-file', path: archive }, () => undefined);
    expect(result.pack.status).toBe('degraded');
    expect(result.warnings).toEqual(['plugins content could not be registered (PLUGIN_REFUSED)']);
    expect(readReceipt(packsDir).handlers).toEqual({ plugins: 'failed:PLUGIN_REFUSED' });
    expect(registry.provider('component-kit', 'demo-kit')).not.toBeNull();

    behaviour.failActivate = false;
    const repaired = await service.install({ kind: 'archive-file', path: archive }, () => undefined);
    expect(repaired.outcome).toBe('unchanged');
    expect(repaired.pack.status).toBe('ready');
    expect(readReceipt(packsDir).handlers).toEqual({ plugins: 'active' });
  });

  it('activatePending registers a kind whose handler arrived after the pack was installed', async () => {
    const first = setup([]);
    await first.service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    const late = recordingHandler();
    const service = createPackService({ packsDir: first.packsDir, registry: first.registry, handlers: [late.handler] });
    const report = await service.activatePending();
    expect(report).toEqual([{ id: FIXTURE_PACK_ID, warnings: [] }]);
    expect(late.calls.map((call) => call.op)).toEqual(['activate']);
    expect(readReceipt(first.packsDir).handlers).toEqual({ plugins: 'active' });
    expect(await service.activatePending()).toEqual([]);
  });

  it('an upgrade that drops a kind whose retract fails is refused with RETRACT_FAILED and leaves the old version installed and registered', async () => {
    const stuck = recordingHandler({ failRetract: true });
    const { packsDir, registry, service } = setup([stuck.handler]);
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    const error = await service
      .install({ kind: 'archive-file', path: await archiveOf({ version: '2.0.0' }) }, () => undefined)
      .then(
        () => null,
        (caught: unknown) => caught,
      );
    expect((error as PackError).code).toBe('RETRACT_FAILED');
    expect(registry.get(FIXTURE_PACK_ID)?.version).toBe('1.0.0');
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
    expect(readReceipt(packsDir).handlers).toEqual({ plugins: 'active' });
  });

  it('a crash between the removal intent and the retract leaves the pack degraded, and activatePending re-registers it', async () => {
    const ok = recordingHandler();
    const { packsDir, registry, service } = setup([ok.handler]);
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    // Simulate the durable intent written just before a crash.
    const receiptPath = path.join(packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`);
    const receipt = readReceipt(packsDir);
    writeFileSync(receiptPath, JSON.stringify({ ...receipt, handlers: { plugins: 'pending' } }));
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('degraded');
    expect(await service.activatePending()).toEqual([{ id: FIXTURE_PACK_ID, warnings: [] }]);
    expect(registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
  });

  it('an upgrade that drops a kind retracts it, and two handlers for one kind are refused', async () => {
    const ok = recordingHandler();
    const { service } = setup([ok.handler]);
    await service.install({ kind: 'archive-file', path: await archiveOf(pluginPack()) }, () => undefined);
    await service.install({ kind: 'archive-file', path: await archiveOf({ version: '2.0.0' }) }, () => undefined);
    expect(ok.calls.map((call) => `${call.op}@${call.version}`)).toEqual(['activate@1.0.0', 'retract@1.0.0']);

    const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
    cleanup.push(dataDir);
    const registry = createPackRegistry({ packsDir: packsDirForDataDir(dataDir) });
    expect(() => createPackService({ registry, handlers: [ok.handler, recordingHandler().handler] })).toThrow();
  });
});
