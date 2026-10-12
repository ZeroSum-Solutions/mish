// FU-15 W1: computePackDigest must never read a file reached through a
// symlinked parent folder (the installer refuses that folder outright).

import { mkdtempSync, renameSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const opened = vi.hoisted(() => [] as string[]);

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const createReadStream = ((target: Parameters<typeof actual.createReadStream>[0], options?: Parameters<typeof actual.createReadStream>[1]) => {
    opened.push(String(target));
    return actual.createReadStream(target, options);
  }) as typeof actual.createReadStream;
  return { ...actual, default: { ...actual, createReadStream }, createReadStream };
});

const { computePackDigest } = await import('../../src/packs/pack-digest.js');
const { writeFixturePack } = await import('../fixtures/licensed-pack/pack-fixture.js');

const cleanup: string[] = [];

afterEach(async () => {
  opened.length = 0;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('FU-15 W1: computePackDigest and a symlinked parent folder', () => {
  it('fails INVALID_ARCHIVE and never opens a file outside the pack root', async () => {
    const pack = writeFixturePack();
    cleanup.push(pack.dir);
    const outside = mkdtempSync(path.join(tmpdir(), 'od-pack-outside-'));
    cleanup.push(outside);
    renameSync(path.join(pack.dir, 'kits/demo/registry'), path.join(outside, 'registry'));
    symlinkSync(path.join(outside, 'registry'), path.join(pack.dir, 'kits/demo/registry'), 'dir');

    const result = await computePackDigest(pack.dir);
    expect(result).toMatchObject({ ok: false, kind: 'folder', code: 'INVALID_ARCHIVE' });
    expect(opened.filter((target) => target.includes('kits/demo/registry'))).toEqual([]);
  });
});
