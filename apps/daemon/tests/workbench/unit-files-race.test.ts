import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readUnitSourceFiles, UnitError } from '../../src/workbench/units/unit-files.js';

// AC-R14.3: unit source reads stay bound to the authorized project root even
// when another writer swaps a checked path, or one of its ancestors, for a
// symbolic link between the check and the open.

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'od-unit-race-root-')); dirs.push(root);
  const outside = await mkdtemp(path.join(tmpdir(), 'od-unit-race-outside-')); dirs.push(outside);
  await mkdir(path.join(root, 'styles'), { recursive: true });
  await writeFile(path.join(root, 'styles', 'site.css'), 'body { color: red; }\n');
  await writeFile(path.join(outside, 'site.css'), 'OUTSIDE BYTES\n');
  return { root, outside };
}

async function refusal(promise: Promise<unknown>): Promise<UnitError> {
  try { await promise; } catch (error) { if (error instanceof UnitError) return error; throw error; }
  throw new Error('expected the read to be refused');
}

describe('unit source reads under a symlink swap', () => {
  it('refuses an ancestor directory swapped for a symlink after the check', async () => {
    const { root, outside } = await fixture();
    const error = await refusal(readUnitSourceFiles(root, ['styles/site.css'], {
      beforeOpen: async () => {
        await rename(path.join(root, 'styles'), path.join(root, 'styles-real'));
        await symlink(outside, path.join(root, 'styles'));
      },
    }));
    expect(error.code).toBe('unsafe-path');
    expect(error.paths).toEqual(['styles/site.css']);
  });

  it('refuses the file itself swapped for a symlink after the check', async () => {
    const { root, outside } = await fixture();
    const error = await refusal(readUnitSourceFiles(root, ['styles/site.css'], {
      beforeOpen: async () => {
        await unlink(path.join(root, 'styles', 'site.css'));
        await symlink(path.join(outside, 'site.css'), path.join(root, 'styles', 'site.css'));
      },
    }));
    expect(error.code).toBe('unsafe-path');
  });

  it('refuses a swap that is undone after the open', async () => {
    const { root, outside } = await fixture();
    const error = await refusal(readUnitSourceFiles(root, ['styles/site.css'], {
      beforeOpen: async () => {
        await rename(path.join(root, 'styles'), path.join(root, 'styles-real'));
        await symlink(outside, path.join(root, 'styles'));
      },
      afterOpen: async () => {
        await unlink(path.join(root, 'styles'));
        await rename(path.join(root, 'styles-real'), path.join(root, 'styles'));
      },
    }));
    expect(error.code).toBe('unsafe-path');
  });

  it('still reads an unswapped file', async () => {
    const { root } = await fixture();
    const [file] = await readUnitSourceFiles(root, ['styles/site.css']);
    expect(file!.bytes.toString('utf8')).toBe('body { color: red; }\n');
  });
});
