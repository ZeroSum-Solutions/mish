import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WORKBENCH_ADOPTION_HELPER_LAYOUT, WORKBENCH_ADOPTION_ROOT_RECORD } from '@mish/contracts';
import { consumeRootCreationRecord, proveRecordedFreshRoot } from '../../../src/workbench/placement/root-freshness.js';

/**
 * B4-1 BLOCK 1: a data root that tools-dev created (and recorded) before the
 * coordinated bootstrap counts as created by this boot only while it still
 * holds nothing but the creation record and the helper tree. Anything else
 * (a database, projects, the native owner's lock from an earlier boot) is an
 * existing root whose predecessors are unproven.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function freshRoot(options: { record?: Record<string, unknown> | null } = {}) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'root-freshness-'))); roots.push(parent);
  const root = join(parent, 'data'); mkdirSync(root, { mode: 0o700 });
  const toolDir = join(root, ...WORKBENCH_ADOPTION_HELPER_LAYOUT.toolDir); mkdirSync(toolDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(toolDir, WORKBENCH_ADOPTION_HELPER_LAYOUT.binary), 'bin', { mode: 0o500 });
  writeFileSync(join(toolDir, WORKBENCH_ADOPTION_HELPER_LAYOUT.record), '{}', { mode: 0o400 });
  const stat = lstatSync(root, { bigint: true });
  const identity = { device: String(stat.dev), inode: String(stat.ino) };
  if (options.record !== null) {
    writeFileSync(join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name), JSON.stringify(options.record ?? { schema: WORKBENCH_ADOPTION_ROOT_RECORD.schema, creator: 'tools-dev', ...identity }), { mode: 0o600 });
  }
  return { root, identity, toolDir };
}

describe('recorded fresh data root', () => {
  it('accepts a root holding only the creation record and the helper tree, bound to its identity', () => {
    const { root, identity } = freshRoot();
    expect(proveRecordedFreshRoot(root)).toEqual(identity);
  });
  it('accepts the tree before the helper is built (empty tool directory)', () => {
    const { root, identity, toolDir } = freshRoot();
    rmSync(join(toolDir, WORKBENCH_ADOPTION_HELPER_LAYOUT.binary)); rmSync(join(toolDir, WORKBENCH_ADOPTION_HELPER_LAYOUT.record));
    expect(proveRecordedFreshRoot(root)).toEqual(identity);
  });
  it('refuses without a record: an existing root proves nothing', () => {
    expect(proveRecordedFreshRoot(freshRoot({ record: null }).root)).toBeNull();
  });
  it.each([
    ['a database', ['app.sqlite']],
    ['managed projects', ['projects/']],
    ["an earlier boot's owner lock", ['.daemon-placement-owner.lock']],
    ['an unexpected tool file', ['placement/adoption-helper/extra']],
    ['an unexpected placement entry', ['placement/adoption-work/']],
  ])('refuses a root that also holds %s', (_label, entries) => {
    const { root } = freshRoot();
    for (const entry of entries) {
      if (entry.endsWith('/')) mkdirSync(join(root, entry), { recursive: true }); else writeFileSync(join(root, entry), 'x');
    }
    expect(proveRecordedFreshRoot(root)).toBeNull();
  });
  it('refuses a record bound to another directory identity (root replaced after recording)', () => {
    const { root, identity } = freshRoot({ record: { schema: WORKBENCH_ADOPTION_ROOT_RECORD.schema, creator: 'tools-dev', device: '1', inode: '2' } });
    expect(identity.inode).not.toBe('2');
    expect(proveRecordedFreshRoot(root)).toBeNull();
  });
  it('refuses a malformed record, a symlinked record or a symlinked placement directory', () => {
    let { root } = freshRoot({ record: { schema: 'other/v1', creator: 'tools-dev', device: '1', inode: '2' } });
    expect(proveRecordedFreshRoot(root)).toBeNull();
    ({ root } = freshRoot());
    const elsewhere = join(root, '..', 'elsewhere.json'); writeFileSync(elsewhere, '{}');
    rmSync(join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name)); symlinkSync(elsewhere, join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name));
    expect(proveRecordedFreshRoot(root)).toBeNull();
    const fresh = freshRoot();
    rmSync(join(fresh.root, 'placement'), { recursive: true });
    mkdirSync(join(fresh.root, '..', 'placement-elsewhere', 'adoption-helper'), { recursive: true });
    symlinkSync(join(fresh.root, '..', 'placement-elsewhere'), join(fresh.root, 'placement'), 'dir');
    expect(proveRecordedFreshRoot(fresh.root)).toBeNull();
  });
  it('refuses a group- or other-writable record', () => {
    const { root } = freshRoot();
    chmodSync(join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name), 0o620);
    expect(proveRecordedFreshRoot(root)).toBeNull();
  });
  it('consumes the record exactly once so it cannot vouch for a later boot', () => {
    const { root } = freshRoot();
    expect(consumeRootCreationRecord(root)).toBe(true);
    expect(existsSync(join(root, WORKBENCH_ADOPTION_ROOT_RECORD.name))).toBe(false);
    expect(proveRecordedFreshRoot(root)).toBeNull();
    expect(consumeRootCreationRecord(root)).toBe(false);
  });
});
