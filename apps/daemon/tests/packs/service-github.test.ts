// P1-1 specs 6, 6b and 7: the `github:` install path through P1-3's fetcher
// seam, and the receipt digest check.
//
// The fetcher is a fake: it copies a fixture tarball to `destPath`. No
// network, no token.

import { createHash } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { PACK_ARCHIVE_MAX_BYTES, type PackInstallEvent } from '@mish/contracts';

import {
  PackFetchError,
  type GithubPackFetcher,
  type GithubPackFetchOptions,
  type PackFetchErrorCode,
} from '../../src/packs/github-fetcher.js';
import { PackError } from '../../src/packs/manifest.js';
import { createPackRegistry, packsDirForDataDir } from '../../src/packs/registry.js';
import { createPackService, type GithubPackFetcher as ServiceFetcher } from '../../src/packs/service.js';
import {
  FIXTURE_KIT_ID,
  FIXTURE_PACK_ID,
  listDir,
  tarFixturePack,
  writeFixturePack,
  type FixturePackOptions,
} from '../fixtures/licensed-pack/pack-fixture.js';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const SIGNED_URL = 'https://codeload.github.com/acme/pack/legacy.tar.gz/abc?token=signedQueryCredential';
const cleanup: string[] = [];

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface FakeFetch {
  fetcher: GithubPackFetcher;
  calls: { source: string; opts: GithubPackFetchOptions }[];
}

async function fixtureArchive(options: FixturePackOptions = {}) {
  const pack = writeFixturePack(options);
  cleanup.push(pack.dir);
  const archivePath = await tarFixturePack(pack.dir, { wrapper: `acme-pack-${COMMIT.slice(0, 7)}` });
  cleanup.push(path.dirname(archivePath));
  const bytes = readFileSync(archivePath);
  return { ...pack, archivePath, archiveSha256: createHash('sha256').update(bytes).digest('hex'), bytes };
}

function fakeFetcher(
  archive: Awaited<ReturnType<typeof fixtureArchive>>,
  overrides: Partial<{ expectedManifestSha256: string; archiveIntegrity: string; resolvedRef: string; throws: unknown }> = {},
): FakeFetch {
  const calls: FakeFetch['calls'] = [];
  const fetcher: GithubPackFetcher = async (source, opts) => {
    calls.push({ source, opts });
    if (overrides.throws) throw overrides.throws;
    copyFileSync(archive.archivePath, opts.destPath);
    opts.onProgress?.(Math.floor(archive.bytes.length / 2), archive.bytes.length);
    opts.onProgress?.(archive.bytes.length, archive.bytes.length);
    return {
      archivePath: opts.destPath,
      resolvedRef: overrides.resolvedRef ?? `pack@${archive.manifest.version} ${COMMIT}`,
      archiveIntegrity: overrides.archiveIntegrity ?? `sha256:${archive.archiveSha256}`,
      expectedManifestSha256: overrides.expectedManifestSha256 ?? archive.manifestSha256,
      bytes: archive.bytes.length,
    };
  };
  return { fetcher, calls };
}

function setup(githubFetcher: GithubPackFetcher) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'od-pack-data-'));
  cleanup.push(dataDir);
  const packsDir = packsDirForDataDir(dataDir);
  const registry = createPackRegistry({ packsDir });
  const service = createPackService({ packsDir, registry, githubFetcher });
  const events: PackInstallEvent[] = [];
  return { packsDir, registry, service, events, emit: (event: PackInstallEvent) => events.push(event) };
}

async function failure(promise: Promise<unknown>): Promise<PackError> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PackError);
  return error as PackError;
}

describe('github: installs through the fetcher seam (P1-1 spec 6)', () => {
  it('a github: install calls the injected fake GithubPackFetcher with a destPath inside stagingDir() and PACK_ARCHIVE_MAX_BYTES, maps onProgress to downloading events, writes resolvedRef and archiveIntegrity into the receipt, and maps each PackFetchError code to the same install error code; no event carries a URL', async () => {
    // The service re-exports the P1-3 seam type; it is the same type.
    const sameSeam: ServiceFetcher = (async () => {
      throw new Error('unused');
    }) as GithubPackFetcher;
    expect(typeof sameSeam).toBe('function');

    const archive = await fixtureArchive();
    const fake = fakeFetcher(archive);
    const h = setup(fake.fetcher);
    const source = 'github:acme/pack@1.0.0';
    const result = await h.service.install({ kind: 'github', source }, h.emit);
    expect(result.outcome).toBe('installed');

    expect(fake.calls).toHaveLength(1);
    const [call] = fake.calls;
    expect(call!.source).toBe(source);
    expect(call!.opts.maxBytes).toBe(PACK_ARCHIVE_MAX_BYTES);
    const relative = path.relative(h.service.stagingDir(), call!.opts.destPath);
    expect(relative.startsWith('..') || path.isAbsolute(relative)).toBe(false);

    const downloading = h.events.filter((event) => event.event === 'progress' && event.data.phase === 'downloading');
    expect(downloading.map((event) => event.data)).toEqual([
      { phase: 'downloading', bytes: Math.floor(archive.bytes.length / 2), totalBytes: archive.bytes.length },
      { phase: 'downloading', bytes: archive.bytes.length, totalBytes: archive.bytes.length },
    ]);
    expect(h.events[0]).toEqual({ event: 'progress', data: { phase: 'resolving' } });

    const receipt = JSON.parse(readFileSync(path.join(h.packsDir, '.receipts', `${FIXTURE_PACK_ID}.json`), 'utf8'));
    expect(receipt).toMatchObject({
      source,
      resolvedRef: `pack@1.0.0 ${COMMIT}`,
      archiveIntegrity: `sha256:${archive.archiveSha256}`,
    });
    expect(h.registry.provider('component-kit', FIXTURE_KIT_ID)).not.toBeNull();
    expect(listDir(h.service.stagingDir())).toEqual([]);

    const codes: PackFetchErrorCode[] = ['BAD_REQUEST', 'AUTH_REQUIRED', 'FETCH_FAILED', 'TOO_LARGE'];
    for (const code of codes) {
      const failing = setup(fakeFetcher(archive, { throws: new PackFetchError(code, `failed at ${SIGNED_URL}`) }).fetcher);
      const error = await failure(failing.service.install({ kind: 'github', source }, failing.emit));
      expect(error.code).toBe(code);
      expect(error.message).not.toContain('http');
      expect(error.message).not.toContain('signedQueryCredential');
      expect(JSON.stringify(failing.events)).not.toMatch(/https?:|signedQueryCredential/);
      expect(listDir(failing.service.stagingDir())).toEqual([]);
      expect(failing.registry.list()).toEqual([]);
    }

    // Anything else the fetcher throws is FETCH_FAILED, message not echoed.
    const odd = setup(fakeFetcher(archive, { throws: new Error(`socket hang up ${SIGNED_URL}`) }).fetcher);
    const oddError = await failure(odd.service.install({ kind: 'github', source }, odd.emit));
    expect(oddError.code).toBe('FETCH_FAILED');
    expect(oddError.message).not.toContain('http');

    // The service enforces the source grammar itself: nothing URL-shaped reaches the fetcher or a receipt.
    const strict = fakeFetcher(archive);
    const guarded = setup(strict.fetcher);
    for (const bad of [`github:${SIGNED_URL}`, 'github:acme/pack@1.0', 'github:acme/pack@01.0.0', 'github:acme', 'github:acme/pack/extra']) {
      expect((await failure(guarded.service.install({ kind: 'github', source: bad }, guarded.emit))).code).toBe('BAD_REQUEST');
    }
    expect(strict.calls).toEqual([]);

    // A result that breaks the seam contract is refused.
    const bad = setup(fakeFetcher(archive, { resolvedRef: 'main' }).fetcher);
    expect((await failure(bad.service.install({ kind: 'github', source }, bad.emit))).code).toBe('FETCH_FAILED');
    expect(JSON.stringify(h.events)).not.toMatch(/https?:/);
  });

  it('when the extracted pack.json differs from expectedManifestSha256 returned by the fetcher, the install fails INTEGRITY_MISMATCH, nothing is activated and .staging is cleaned (spec 6b)', async () => {
    const archive = await fixtureArchive();
    const h = setup(fakeFetcher(archive, { expectedManifestSha256: 'c'.repeat(64) }).fetcher);
    const error = await failure(h.service.install({ kind: 'github', source: 'github:acme/pack' }, h.emit));
    expect(error.code).toBe('INTEGRITY_MISMATCH');
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.provider('component-kit', FIXTURE_KIT_ID)).toBeNull();
    expect(listDir(h.service.stagingDir())).toEqual([]);
    expect(h.events.some((event) => event.event === 'progress' && event.data.phase === 'activating')).toBe(false);

    // The bytes on disk must also be the bytes the fetcher hashed.
    const swapped = setup(fakeFetcher(archive, { archiveIntegrity: `sha256:${'d'.repeat(64)}` }).fetcher);
    expect((await failure(swapped.service.install({ kind: 'github', source: 'github:acme/pack' }, swapped.emit))).code).toBe(
      'INTEGRITY_MISMATCH',
    );
    expect(listDir(swapped.service.stagingDir())).toEqual([]);

    // The tag names the version pack.json must carry.
    const retagged = setup(fakeFetcher(archive, { resolvedRef: `pack@9.9.9 ${COMMIT}` }).fetcher);
    expect((await failure(retagged.service.install({ kind: 'github', source: 'github:acme/pack' }, retagged.emit))).code).toBe(
      'INTEGRITY_MISMATCH',
    );
    expect(retagged.registry.list()).toEqual([]);
  });
});

describe('receipt digest (P1-1 spec 7)', () => {
  it('a pack.json whose digest differs from the receipt digest makes the pack damaged', async () => {
    const archive = await fixtureArchive();
    const h = setup(fakeFetcher(archive).fetcher);
    const result = await h.service.install({ kind: 'github', source: 'github:acme/pack' }, h.emit);
    expect(result.pack.status).toBe('ready');

    const packJson = path.join(h.packsDir, FIXTURE_PACK_ID, 'pack.json');
    const manifest = JSON.parse(readFileSync(packJson, 'utf8'));
    // Still a valid manifest, but not the one that was verified and installed.
    writeFileSync(packJson, JSON.stringify({ ...manifest, title: 'Edited after install' }));
    const pack = h.registry.get(FIXTURE_PACK_ID);
    expect(pack?.status).toBe('damaged');
    expect(pack?.problem).toBe('pack.json does not match its install receipt');
    expect(h.registry.provider('component-kit', FIXTURE_KIT_ID)).toBeNull();
    expect(h.service.list()[0]).toMatchObject({ id: FIXTURE_PACK_ID, status: 'damaged' });

    // Whitespace-only edits keep the canonical digest: still ready.
    writeFileSync(packJson, `${JSON.stringify(manifest, null, 4)}\n`);
    expect(h.registry.get(FIXTURE_PACK_ID)?.status).toBe('ready');
  });
});
