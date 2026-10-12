// Atlas Digest G4 review (W3, W6). The output witness reads a project file
// that anyone can replace, so it must never block or follow a link: a FIFO at
// the output path used to hang the wait request forever (readFile on a pipe
// waits for a writer), and a symlink to a copy of the bytes passed as the
// task's own output. And auto-named outputs must not collide when two
// generations start in the same millisecond.

import { execFileSync } from 'node:child_process';
import { closeSync, constants, openSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { autoOutputName } from '../../src/media/index.js';
import { mediaOutputDigest, supersededMediaOutputError } from '../../src/media/output-witness.js';

const BYTES = Buffer.from('png-bytes-this-task-wrote');
const RECORD = { name: 'hero.png', size: BYTES.length, sha256: mediaOutputDigest(BYTES) };

let dir = '';
const fifos: string[] = [];

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'od-output-witness-'));
});

afterEach(async () => {
  // Release any reader a broken implementation left blocked on a FIFO, so a
  // red run fails its assertion instead of wedging the worker.
  for (const fifo of fifos.splice(0)) {
    try {
      closeSync(openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK));
    } catch {
      // No reader is waiting: nothing to release.
    }
  }
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timed-out'> {
  return Promise.race([promise, new Promise<'timed-out'>((resolve) => setTimeout(() => resolve('timed-out'), ms))]);
}

describe('media output witness', () => {
  it('accepts the bytes the task wrote', async () => {
    await writeFile(path.join(dir, 'hero.png'), BYTES);
    await expect(supersededMediaOutputError(dir, RECORD)).resolves.toBeNull();
  });

  it('reports a deleted output as superseded', async () => {
    const error = await supersededMediaOutputError(dir, RECORD);
    expect(error).toMatchObject({ code: 'MEDIA_OUTPUT_SUPERSEDED', nextStep: 'output-superseded' });
  });

  it('reports different bytes of the same size as superseded', async () => {
    await writeFile(path.join(dir, 'hero.png'), Buffer.from('png-bytes-another-tas-wrote'.slice(0, BYTES.length)));
    await expect(supersededMediaOutputError(dir, RECORD)).resolves.toMatchObject({ code: 'MEDIA_OUTPUT_SUPERSEDED' });
  });

  it('never blocks on a FIFO at the output path', async () => {
    const fifo = path.join(dir, 'hero.png');
    execFileSync('mkfifo', [fifo]);
    fifos.push(fifo);
    const verdict = await within(supersededMediaOutputError(dir, RECORD), 2_000);
    expect(verdict).not.toBe('timed-out');
    expect(verdict).toMatchObject({ code: 'MEDIA_OUTPUT_SUPERSEDED' });
  });

  it('does not follow a symlink, even to a copy of the same bytes', async () => {
    await writeFile(path.join(dir, 'elsewhere.png'), BYTES);
    await symlink(path.join(dir, 'elsewhere.png'), path.join(dir, 'hero.png'));
    await expect(supersededMediaOutputError(dir, RECORD)).resolves.toMatchObject({ code: 'MEDIA_OUTPUT_SUPERSEDED' });
  });
});

describe('auto-named media outputs', () => {
  it('differ for two generations started in the same millisecond', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_791_000_000_000);
    const first = autoOutputName('image', 'custom-image');
    const second = autoOutputName('image', 'custom-image');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^image-custom-image-[a-z0-9]+-[a-f0-9]{8}\.png$/);
  });
});
