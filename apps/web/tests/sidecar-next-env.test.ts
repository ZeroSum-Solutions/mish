import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  prepareNextAppPreservingNextEnv,
  stabilizeNextEnvContent,
} from '../sidecar/next-env';

// What `next build` writes with the default distDir; the tracked file.
const STABLE = [
  '/// <reference types="next" />',
  '/// <reference types="next/image-types/global" />',
  'import "./.next/types/routes.d.ts";',
  '',
  '// NOTE: This file should not be edited',
  '// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.',
  '',
].join('\n');

// What `next dev` writes when tools-dev points distDir into a namespace runtime.
function contaminated(runId: string): string {
  return STABLE.replace(
    './.next/types/routes.d.ts',
    `./../../.tmp/e2e/${runId}/tools-dev/web/next/dev/types/routes.d.ts`,
  );
}

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { force: true, recursive: true })));
});

async function webDir(initial: string | null): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'web-next-env-'));
  dirs.push(dir);
  if (initial != null) await writeFile(join(dir, 'next-env.d.ts'), initial, 'utf8');
  return dir;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

/** A Next app whose prepare writes next-env.d.ts like Next does, then waits for `gate`. */
function fakeNextApp(dir: string, runId: string, gate: Promise<void>, written: () => void) {
  return {
    async prepare() {
      await writeFile(join(dir, 'next-env.d.ts'), contaminated(runId), 'utf8');
      written();
      await gate;
    },
  };
}

describe('stabilizeNextEnvContent', () => {
  it('rewrites a tools-dev distDir import back to ./.next/types', () => {
    expect(stabilizeNextEnvContent(contaminated('run-1'))).toBe(STABLE);
  });

  it('rewrites strict route type imports and the default dev distDir', () => {
    const strict = STABLE.replace(
      'import "./.next/types/routes.d.ts";',
      [
        'import "./.next/dev/types/routes.d.ts";',
        'import "./../../.tmp/x/next/dev/types/validator.ts";',
      ].join('\n'),
    );
    expect(stabilizeNextEnvContent(strict)).toContain('import "./.next/types/routes.d.ts";\nimport "./.next/types/validator.ts";');
  });

  it('leaves the stable file byte-identical, including CRLF line endings', () => {
    expect(stabilizeNextEnvContent(STABLE)).toBe(STABLE);
    const crlf = contaminated('r').replaceAll('\n', '\r\n');
    expect(stabilizeNextEnvContent(crlf)).toBe(STABLE.replaceAll('\n', '\r\n'));
  });
});

describe('prepareNextAppPreservingNextEnv', () => {
  it('returns next-env.d.ts to its stable form after a single prepare', async () => {
    const dir = await webDir(STABLE);
    await prepareNextAppPreservingNextEnv(fakeNextApp(dir, 'a', Promise.resolve(), () => {}), dir);
    expect(await readFile(join(dir, 'next-env.d.ts'), 'utf8')).toBe(STABLE);
  });

  it('leaves the tracked file stable when two sidecars prepare concurrently', async () => {
    // Worker A starts; Next writes A's path. Worker B starts while A is still
    // preparing, so B's "before" snapshot is A's contaminated content. A then
    // finishes, B's Next writes B's path, and B finishes last.
    const dir = await webDir(STABLE);
    const gateA = deferred();
    const gateB = deferred();
    const aWrote = deferred();
    const bWrote = deferred();

    const a = prepareNextAppPreservingNextEnv(fakeNextApp(dir, 'a', gateA.promise, aWrote.resolve), dir);
    await aWrote.promise;

    const appB = {
      async prepare() {
        await gateA.promise; // B's Next only writes after A has finished restoring
        await a;
        await fakeNextApp(dir, 'b', gateB.promise, bWrote.resolve).prepare();
      },
    };
    const b = prepareNextAppPreservingNextEnv(appB, dir);
    gateA.resolve();
    await a;
    await bWrote.promise;
    gateB.resolve();
    await b;

    expect(await readFile(join(dir, 'next-env.d.ts'), 'utf8')).toBe(STABLE);
  });

  it('repairs the file even when prepare throws', async () => {
    const dir = await webDir(STABLE);
    const failing = {
      async prepare() {
        await writeFile(join(dir, 'next-env.d.ts'), contaminated('boom'), 'utf8');
        throw new Error('prepare failed');
      },
    };
    await expect(prepareNextAppPreservingNextEnv(failing, dir)).rejects.toThrow('prepare failed');
    expect(await readFile(join(dir, 'next-env.d.ts'), 'utf8')).toBe(STABLE);
  });

  it('does not leave a generated file behind when none existed', async () => {
    const dir = await webDir(null);
    await prepareNextAppPreservingNextEnv(fakeNextApp(dir, 'a', Promise.resolve(), () => {}), dir);
    await expect(readFile(join(dir, 'next-env.d.ts'), 'utf8')).rejects.toThrow();
  });
});
