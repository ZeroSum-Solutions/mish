// P1-1 spec 3 (install, version semantics, atomic activation) and the owner
// decision of 2026-10-07: a local .tgz needs a sha256 and fails closed.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { promises as fsp } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { parsePackManifest, type PackInstallEvent } from '@mish/contracts';

import { PackError, packManifestDigest } from '../../src/packs/manifest.js';
import { createPackRegistry, packsDirForDataDir, type PackRegistry } from '../../src/packs/registry.js';
import { createPackService, type PackService, type PackServiceOptions } from '../../src/packs/service.js';
import {
  FIXTURE_KIT_ID,
  FIXTURE_PACK_ID,
  fixtureKitFiles,
  listDir,
  sha256Hex,
  tarFixturePack,
  writeFixturePack,
  writeSidecar,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Harness {
  dataDir: string;
  packsDir: string;
  registry: PackRegistry;
  service: PackService;
  events: PackInstallEvent[];
  emit: (event: PackInstallEvent) => void;
}

function harness(options: Partial<PackServiceOptions> = {}): Harness {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry, ...options });
  const events: PackInstallEvent[] = [];
  return { dataDir, packsDir, registry, service, events, emit: (event) => events.push(event) };
}

/** A fixture pack as a .tgz with a matching .sha256 sidecar. */
async function packArchive(options: FixturePackOptions = {}, tar: { wrapper?: string } = {}) {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir, tar);
  cleanup.push(path.dirname(archivePath));
  const digest = writeSidecar(archivePath);
  return { ...pack, archivePath, digest };
}

async function installError(promise: Promise<unknown>): Promise<PackError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PackError);
  return error as PackError;
}

/** The folder digest a folder install needs: sha256 of the canonical pack.json. */
function folderDigest(pack: { manifestBytes: Buffer }): string {
  const parsed = parsePackManifest(JSON.parse(pack.manifestBytes.toString('utf8')));
  if (!parsed.ok) throw new Error('fixture manifest is invalid');
  return packManifestDigest(parsed.manifest);
}

function walk(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(path.join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

function residue(h: Harness): { staging: string[]; trash: string[] } {
  return { staging: listDir(path.join(h.packsDir, '.staging')), trash: listDir(path.join(h.packsDir, '.trash')) };
}

describe('pack install (P1-1 spec 3)', () => {
  it('(a) installs a fixture pack (component-kit from writeFixtureKit) into <packsDir>/<id>/ and copies only files listed in files[]', async () => {
    const h = harness();
    const fixture = await packArchive({
      unlisted: [
        { path: 'README.md', content: '# not part of the pack\n' },
        { path: 'scripts/build.ts', content: 'export {};\n' },
      ],
    });
    const result = await h.service.install({ kind: 'archive-file', path: fixture.archivePath }, h.emit);
    expect(result.outcome).toBe('installed');
    expect(result.pack.id).toBe(FIXTURE_PACK_ID);
    expect(result.pack.status).toBe('ready');

    const installed = path.join(h.packsDir, FIXTURE_PACK_ID);
    expect(walk(installed)).toEqual(['pack.json', ...fixture.manifest.files.map((file) => file.path)].sort());
    expect(existsSync(path.join(installed, 'README.md'))).toBe(false);
    expect(existsSync(path.join(installed, 'scripts'))).toBe(false);
    expect(readFileSync(path.join(installed, 'pack.json'))).toEqual(fixture.manifestBytes);

    const receiptText = readFileSync(path.join(h.packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8');
    const receipt = JSON.parse(receiptText);
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      id: FIXTURE_PACK_ID,
      version: '1.0.0',
      digest: result.pack.digest,
      source: 'local:pack.tgz',
      archiveIntegrity: `sha256:${fixture.digest}`,
    });
    // Receipts hold no absolute paths.
    expect(receiptText).not.toContain(tmpdir());
    expect(receiptText).not.toContain(h.dataDir);

    const phases = h.events.filter((event) => event.event === 'progress').map((event) => event.data.phase);
    expect(phases).toEqual(expect.arrayContaining(['extracting', 'verifying', 'activating']));
    expect(residue(h)).toEqual({ staging: [], trash: [] });
    expect(h.registry.provider('component-kit', FIXTURE_KIT_ID)?.absPath).toBe(path.join(installed, 'kits', 'demo'));
  });

  it('(b) accepts the GitHub tarball shape with pack.json inside one wrapper directory', async () => {
    const h = harness();
    const fixture = await packArchive({}, { wrapper: 'zerosum-mishh-licensed-0123456' });
    const result = await h.service.install({ kind: 'archive-file', path: fixture.archivePath }, h.emit);
    expect(result.outcome).toBe('installed');
    expect(existsSync(path.join(h.packsDir, FIXTURE_PACK_ID, 'kits', 'demo', 'manifest.json'))).toBe(true);
    expect(existsSync(path.join(h.packsDir, FIXTURE_PACK_ID, 'zerosum-mishh-licensed-0123456'))).toBe(false);
  });

  it('(c) a file whose sha256 differs from files[] fails INTEGRITY_MISMATCH and leaves the active version untouched', async () => {
    const h = harness();
    const v1 = await packArchive();
    await h.service.install({ kind: 'archive-file', path: v1.archivePath }, h.emit);

    const tampered = await packArchive({
      version: '1.1.0',
      mutate: (manifest) => {
        const files = manifest.files as { sha256: string }[];
        files[files.length - 1]!.sha256 = '0'.repeat(64);
        return manifest;
      },
    });
    const error = await installError(h.service.install({ kind: 'archive-file', path: tampered.archivePath }, h.emit));
    expect(error.code).toBe('INTEGRITY_MISMATCH');
    const active = h.registry.get(FIXTURE_PACK_ID);
    expect(active?.version).toBe('1.0.0');
    expect(active?.status).toBe('ready');
    expect(readFileSync(path.join(h.packsDir, FIXTURE_PACK_ID, 'pack.json'))).toEqual(v1.manifestBytes);
    expect(residue(h)).toEqual({ staging: [], trash: [] });

    // A listed file that the archive does not carry.
    const missing = await packArchive({ version: '1.2.0' });
    const listed = missing.manifest.files[0]!.path;
    rmSync(path.join(missing.dir, ...listed.split('/')));
    const archive = await tarFixturePack(missing.dir);
    cleanup.push(path.dirname(archive));
    writeSidecar(archive);
    const gone = await installError(h.service.install({ kind: 'archive-file', path: archive }, h.emit));
    expect(gone.code).toBe('INTEGRITY_MISMATCH');
    expect(h.registry.get(FIXTURE_PACK_ID)?.version).toBe('1.0.0');
  });

  it('(d) same id and version with a different digest fails VERSION_CONFLICT; a lower version fails VERSION_CONFLICT; both succeed with force', async () => {
    const h = harness();
    const v2 = await packArchive({ version: '2.0.0' });
    expect((await h.service.install({ kind: 'archive-file', path: v2.archivePath }, h.emit)).outcome).toBe('installed');

    const same = await packArchive({ version: '2.0.0' });
    expect((await h.service.install({ kind: 'archive-file', path: same.archivePath }, h.emit)).outcome).toBe('unchanged');

    const other = await packArchive({ version: '2.0.0', title: 'Other bytes, same version' });
    expect((await installError(h.service.install({ kind: 'archive-file', path: other.archivePath }, h.emit))).code).toBe(
      'VERSION_CONFLICT',
    );
    const lower = await packArchive({ version: '1.9.9' });
    expect((await installError(h.service.install({ kind: 'archive-file', path: lower.archivePath }, h.emit))).code).toBe(
      'VERSION_CONFLICT',
    );
    expect(h.registry.get(FIXTURE_PACK_ID)?.version).toBe('2.0.0');

    const forcedSame = await h.service.install({ kind: 'archive-file', path: other.archivePath, force: true }, h.emit);
    expect(forcedSame.outcome).toBe('installed');
    expect(h.registry.get(FIXTURE_PACK_ID)?.title).toBe('Other bytes, same version');
    const forcedLower = await h.service.install({ kind: 'archive-file', path: lower.archivePath, force: true }, h.emit);
    expect(forcedLower.outcome).toBe('installed');
    expect(h.registry.get(FIXTURE_PACK_ID)?.version).toBe('1.9.9');

    const higher = await packArchive({ version: '10.0.0' });
    expect((await h.service.install({ kind: 'archive-file', path: higher.archivePath }, h.emit)).outcome).toBe('upgraded');
    expect(h.registry.get(FIXTURE_PACK_ID)?.version).toBe('10.0.0');
    expect(residue(h)).toEqual({ staging: [], trash: [] });
  });

  it('a same-version, same-manifest install still verifies every listed file before it answers unchanged', async () => {
    const h = harness();
    const v1 = await packArchive();
    await h.service.install({ kind: 'archive-file', path: v1.archivePath }, h.emit);
    // Same pack.json, but one listed file carries other bytes.
    const listed = v1.manifest.files[0]!.path;
    writeFileSync(path.join(v1.dir, ...listed.split('/')), 'tampered bytes');
    const archive = await tarFixturePack(v1.dir);
    cleanup.push(path.dirname(archive));
    writeSidecar(archive);
    const error = await installError(h.service.install({ kind: 'archive-file', path: archive }, h.emit));
    expect(error.code).toBe('INTEGRITY_MISMATCH');
    expect(h.registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
    expect(residue(h)).toEqual({ staging: [], trash: [] });
  });

  it('(e) an activation failure after staging (injected rename fault) leaves the previous version active and no staging residue', async () => {
    let failNext = false;
    const h = harness({
      fsOps: {
        rename: async (from, to) => {
          // Fail the move of the staged tree onto the live pack folder.
          if (failNext && path.basename(to) === FIXTURE_PACK_ID && from.includes(`${path.sep}.staging${path.sep}`)) {
            failNext = false;
            throw Object.assign(new Error('injected rename fault'), { code: 'EIO' });
          }
          await fsp.rename(from, to);
        },
      },
    });
    const v1 = await packArchive();
    await h.service.install({ kind: 'archive-file', path: v1.archivePath }, h.emit);
    const generation = h.registry.generation();

    failNext = true;
    const v2 = await packArchive({ version: '2.0.0' });
    const error = await installError(h.service.install({ kind: 'archive-file', path: v2.archivePath }, h.emit));
    expect(error.code).toBe('INTERNAL_ERROR');
    expect(error.message).not.toContain(h.packsDir);
    const active = h.registry.get(FIXTURE_PACK_ID);
    expect(active?.version).toBe('1.0.0');
    expect(active?.status).toBe('ready');
    expect(readFileSync(path.join(h.packsDir, FIXTURE_PACK_ID, 'pack.json'))).toEqual(v1.manifestBytes);
    expect(residue(h)).toEqual({ staging: [], trash: [] });
    expect(h.registry.generation()).toBe(generation);

    // The fault was one-shot: the same upgrade now succeeds.
    expect((await h.service.install({ kind: 'archive-file', path: v2.archivePath }, h.emit)).outcome).toBe('upgraded');
  });

  it('refuses a second pack that provides the same content (CONTENT_CONFLICT) and a concurrent install (INSTALL_IN_PROGRESS)', async () => {
    const h = harness();
    const first = await packArchive();
    await h.service.install({ kind: 'archive-file', path: first.archivePath }, h.emit);
    const second = await packArchive({ id: 'second-pack' });
    const conflict = await installError(h.service.install({ kind: 'archive-file', path: second.archivePath }, h.emit));
    expect(conflict.code).toBe('CONTENT_CONFLICT');
    expect(conflict.message).toContain(FIXTURE_PACK_ID);
    expect(h.registry.get('second-pack')).toBeNull();

    const third = await packArchive({
      id: 'third-pack',
      contents: [{ kind: 'component-kit', schema: 'od-cult-kit/1', id: 'other-kit', path: 'kits/demo' }],
    });
    const running = h.service.install({ kind: 'archive-file', path: third.archivePath }, h.emit);
    const busy = await installError(h.service.install({ kind: 'archive-file', path: third.archivePath }, h.emit));
    expect(busy.code).toBe('INSTALL_IN_PROGRESS');
    expect((await running).outcome).toBe('installed');
    expect(h.registry.list().map((pack) => pack.id)).toEqual([FIXTURE_PACK_ID, 'third-pack']);
  });

  it('installs a pack folder, and refuses a folder whose listed file is a symlink without installing anything', async () => {
    const h = harness();
    const folder = writeFixturePack();
    cleanup.push(folder.dir);
    const result = await h.service.install({ kind: 'folder', path: folder.dir, sha256: folderDigest(folder) }, h.emit);
    expect(result.outcome).toBe('installed');
    expect(result.pack.source).toBe(`folder:${path.basename(folder.dir)}`);

    const h2 = harness();
    const linked = writeFixturePack();
    cleanup.push(linked.dir);
    const victim = linked.manifest.files[0]!.path;
    const outside = mkdtempSync(path.join(tmpdir(), 'od-pack-outside-'));
    cleanup.push(outside);
    const target = path.join(outside, 'payload');
    writeFileSync(target, readFileSync(path.join(linked.dir, ...victim.split('/'))));
    rmSync(path.join(linked.dir, ...victim.split('/')));
    symlinkSync(target, path.join(linked.dir, ...victim.split('/')));
    const error = await installError(h2.service.install({ kind: 'folder', path: linked.dir, sha256: folderDigest(linked) }, h2.emit));
    expect(error.code).toBe('INVALID_ARCHIVE');
    expect(h2.registry.list()).toEqual([]);
    expect(listDir(path.join(h2.packsDir, '.staging'))).toEqual([]);
  });

  it('rejects malformed input with BAD_REQUEST and a github source without a fetcher with SOURCE_UNSUPPORTED', async () => {
    const h = harness();
    expect((await installError(h.service.install({ kind: 'archive-file', path: 'relative.tgz' }, h.emit))).code).toBe('BAD_REQUEST');
    expect((await installError(h.service.install({ kind: 'folder', path: '' }, h.emit))).code).toBe('BAD_REQUEST');
    expect((await installError(h.service.install({ kind: 'nope' } as never, h.emit))).code).toBe('BAD_REQUEST');
    expect(
      (await installError(h.service.install({ kind: 'github', source: 'github:acme/pack' }, h.emit))).code,
    ).toBe('SOURCE_UNSUPPORTED');
    expect(existsSync(h.packsDir)).toBe(false);
  });
});

describe('local archive digest (owner decision 2026-10-07)', () => {
  it('a local .tgz with neither a .sha256 sidecar nor a digest option fails DIGEST_REQUIRED and installs nothing', async () => {
    const h = harness();
    const fixture = await packArchive();
    rmSync(`${fixture.archivePath}.sha256`);
    const error = await installError(h.service.install({ kind: 'archive-file', path: fixture.archivePath, force: true }, h.emit));
    expect(error.code).toBe('DIGEST_REQUIRED');
    expect(h.registry.list()).toEqual([]);
    expect(h.events.filter((event) => event.event === 'progress' && event.data.phase === 'extracting')).toEqual([]);
  });

  it('a mismatched sidecar or digest option fails INTEGRITY_MISMATCH even with force, and nothing is activated', async () => {
    const h = harness();
    const fixture = await packArchive();
    writeSidecar(fixture.archivePath, 'f'.repeat(64));
    const sidecar = await installError(h.service.install({ kind: 'archive-file', path: fixture.archivePath, force: true }, h.emit));
    expect(sidecar.code).toBe('INTEGRITY_MISMATCH');

    rmSync(`${fixture.archivePath}.sha256`);
    const option = await installError(
      h.service.install({ kind: 'archive-file', path: fixture.archivePath, sha256: 'e'.repeat(64), force: true }, h.emit),
    );
    expect(option.code).toBe('INTEGRITY_MISMATCH');

    // Sidecar and option must agree when both are given.
    writeSidecar(fixture.archivePath);
    const disagree = await installError(
      h.service.install({ kind: 'archive-file', path: fixture.archivePath, sha256: 'e'.repeat(64) }, h.emit),
    );
    expect(disagree.code).toBe('INTEGRITY_MISMATCH');

    writeFileSync(`${fixture.archivePath}.sha256`, 'not a digest\n');
    const malformed = await installError(h.service.install({ kind: 'archive-file', path: fixture.archivePath }, h.emit));
    expect(malformed.code).toBe('BAD_REQUEST');

    expect(h.registry.list()).toEqual([]);
    expect(residue(h)).toEqual({ staging: [], trash: [] });
  });

  it('a matching digest option installs without a sidecar and becomes the receipt', async () => {
    const h = harness();
    const fixture = await packArchive();
    rmSync(`${fixture.archivePath}.sha256`);
    const result = await h.service.install(
      { kind: 'archive-file', path: fixture.archivePath, sha256: fixture.digest.toUpperCase(), label: 'upload.tgz' },
      h.emit,
    );
    expect(result.pack.source).toBe('local:upload.tgz');
    const receipt = JSON.parse(readFileSync(path.join(h.packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8'));
    expect(receipt.archiveIntegrity).toBe(`sha256:${fixture.digest}`);
    expect(sha256Hex(readFileSync(fixture.archivePath))).toBe(fixture.digest);
    expect(statSync(path.join(h.packsDir, FIXTURE_PACK_ID)).isDirectory()).toBe(true);
    expect(fixtureKitFiles().length).toBeGreaterThan(0);
  });
});

// S10 (QA sweep 2, J2 Licensed packs, P1): "Install from file" with an
// ordinary macOS `tar czf` archive. The fixture is a real /usr/bin/tar
// archive with a `./` root and `._*` AppleDouble entries; see the provenance
// note in archive.test.ts.
describe('macOS BSD tar archive install (S10)', () => {
  it('installs a real macOS `tar czf` pack archive and places only the listed files', async () => {
    const h = harness();
    const archivePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'licensed-pack', 'bsd-tar-pack.tgz');
    const digest = sha256Hex(readFileSync(archivePath));
    const result = await h.service.install({ kind: 'archive-file', path: archivePath, sha256: digest, label: 'bsd-tar-pack.tgz' }, h.emit);
    expect(result.outcome).toBe('installed');
    expect(result.pack).toMatchObject({ id: 'bsd-tar-pack', version: '1.0.0', status: 'ready', source: 'local:bsd-tar-pack.tgz' });
    const placed = walk(path.join(h.packsDir, 'bsd-tar-pack'));
    expect(placed).toContain('pack.json');
    expect(placed.filter((rel) => rel.split('/').some((segment) => segment.startsWith('._')))).toEqual([]);
    expect(residue(h)).toEqual({ staging: [], trash: [] });
  });
});

describe('S10 review round (Sol on PR #207): listed ._* content', () => {
  it('installs a pack whose pack.json lists a plain ._* file, from an archive as from a folder', async () => {
    const files = [...fixtureKitFiles(), { path: 'kits/demo/._config', content: 'plain text config\n' }];
    const h = harness();
    const fixture = await packArchive({ files });
    const result = await h.service.install({ kind: 'archive-file', path: fixture.archivePath }, h.emit);
    expect(result.outcome).toBe('installed');
    expect(readFileSync(path.join(h.packsDir, FIXTURE_PACK_ID, 'kits', 'demo', '._config'), 'utf8')).toBe('plain text config\n');
  });
});
