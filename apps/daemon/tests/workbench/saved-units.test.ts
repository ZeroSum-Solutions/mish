import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CatalogueSavedUnitStore, SAVED_UNITS_PER_PRINCIPAL, type SavedUnitRecord } from '../../src/workbench/adoption/saved-units.js';

/**
 * W4 saved units, round 3 (W1, W3): a record is trusted only when its content
 * digest, recomputed exactly as save derives it, equals its ID; paths and roles
 * follow the wire contract; each principal has a capped count; listing reads
 * only that principal's metadata index, never record bytes or other records.
 */
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const store = (options?: { maxPerPrincipal?: number }) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'saved-units-'))); roots.push(root);
  return { root, store: new CatalogueSavedUnitStore(root, options) };
};
const ref = { sourceType: 'library' as const, sourceId: 'gsap' as const, itemId: 'section-entrance-react', revisionOrDigest: `sha256:${'a'.repeat(64)}` };
const unit = (principalId: string, text = 'original'): Omit<SavedUnitRecord, 'id'> => ({
  principalId, ref, title: 'Section entrance (React)', target: 'react-source/v1', sourceProjectId: 'p1', sourceOperationId: 'apply-1',
  files: [{ path: 'GsapSectionEntrance.tsx', role: 'source', bytes: Buffer.from(text) }],
});
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

describe('saved-unit record integrity (W1)', () => {
  it('refuses a record whose bytes were swapped with a matching per-file hash', () => {
    const { root, store: units } = store();
    const saved = units.save(unit('member:alice'));
    const file = join(root, `${saved.id}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    const evil = Buffer.from('tampered payload');
    json.files[0].contentBase64 = evil.toString('base64'); json.files[0].sha256 = sha(evil);
    writeFileSync(file, JSON.stringify(json));
    expect(() => units.read('member:alice', saved.id)).toThrow(expect.objectContaining({ reason: 'saved-unit-corrupt' }));
  });

  it("refuses alice's record relabelled to mallory, for both principals", () => {
    const { root, store: units } = store();
    const saved = units.save(unit('member:alice'));
    const file = join(root, `${saved.id}.json`);
    const json = JSON.parse(readFileSync(file, 'utf8'));
    json.principalId = 'member:mallory';
    writeFileSync(file, JSON.stringify(json));
    expect(() => units.read('member:mallory', saved.id)).toThrow(expect.objectContaining({ reason: 'saved-unit-corrupt' }));
    expect(() => units.read('member:alice', saved.id)).toThrow(expect.objectContaining({ reason: 'saved-unit-corrupt' }));
  });

  it('refuses a record whose path or role breaks the wire contract, even with a recomputed digest', () => {
    const { store: units } = store();
    expect(() => units.save({ ...unit('member:alice'), files: [{ path: '../escape.tsx', role: 'source', bytes: Buffer.from('x') }] })).toThrow(expect.objectContaining({ reason: 'saved-unit-invalid' }));
    expect(() => units.save({ ...unit('member:alice'), files: [{ path: 'App.tsx', role: 'entry' as never, bytes: Buffer.from('x') }] })).toThrow(expect.objectContaining({ reason: 'saved-unit-invalid' }));
  });
});

describe('saved-unit cap and metadata index (W3)', () => {
  it('caps each principal below the 500-item wire limit with a typed refusal; a repeat save at the cap is idempotent', () => {
    expect(SAVED_UNITS_PER_PRINCIPAL).toBeLessThan(500);
    const { store: units } = store({ maxPerPrincipal: 2 });
    const first = units.save(unit('member:alice', 'one'));
    units.save(unit('member:alice', 'two'));
    expect(() => units.save(unit('member:alice', 'three'))).toThrow(expect.objectContaining({ reason: 'saved-unit-limit' }));
    expect(units.save(unit('member:alice', 'one')).id).toBe(first.id);
    expect(units.save(unit('member:bob', 'three')).principalId).toBe('member:bob');
  });

  it("lists from the principal's own index: other principals' records and record bytes are never read", () => {
    const { root, store: units } = store();
    const alice = units.save(unit('member:alice'));
    const bob = units.save(unit('member:bob', 'bob'));
    // A broken record of another principal and broken bytes of alice's own record do not affect listing.
    writeFileSync(join(root, `${bob.id}.json`), '{not json');
    writeFileSync(join(root, `${alice.id}.json`), '{not json');
    expect(units.list('member:alice').map(entry => entry.id)).toEqual([alice.id]);
    expect(units.list('member:alice')[0]).toMatchObject({ id: alice.id, title: 'Section entrance (React)', files: [{ path: 'GsapSectionEntrance.tsx', role: 'source', sha256: sha('original'), bytes: 8 }] });
    expect(units.list('member:carol')).toEqual([]);
    expect(() => units.read('member:alice', alice.id)).toThrow(expect.objectContaining({ reason: 'saved-unit-corrupt' }));
  });

  it('a leftover temporary from an interrupted save never surfaces as a record', () => {
    const { root, store: units } = store();
    writeFileSync(join(root, `.incoming-${'x'.repeat(8)}`), '{"partial":');
    const saved = units.save(unit('member:alice'));
    expect(units.list('member:alice').map(entry => entry.id)).toEqual([saved.id]);
    expect(units.read('member:alice', saved.id)?.files[0]!.bytes.toString()).toBe('original');
  });
});

describe('saved-unit record size (Sol B5/6 WARN)', () => {
  const MiB = 1024 * 1024;
  const sized = (bytes: number): Omit<SavedUnitRecord, 'id'> => ({ ...unit('member:alice'), files: [{ path: 'asset.bin', role: 'asset', bytes: Buffer.alloc(bytes, 7) }] });
  const records = (root: string) => readdirSync(root).filter(name => name.endsWith('.json'));

  it('a unit whose encoded record fits the reader limit saves and reads back', () => {
    const { root, store: units } = store();
    const saved = units.save(sized(23 * MiB));
    expect(units.read('member:alice', saved.id)?.files[0]!.bytes.length).toBe(23 * MiB);
    expect(records(root)).toEqual([`${saved.id}.json`]);
  });

  it('a unit under 32 MiB of bytes whose base64 record exceeds the reader limit is refused up front and leaves no record', () => {
    const { root, store: units } = store();
    expect(() => units.save(sized(25 * MiB))).toThrow(expect.objectContaining({ reason: 'saved-unit-budget' }));
    expect(records(root)).toEqual([]);
    expect(units.list('member:alice')).toEqual([]);
  });
});

describe('saved-unit removal (Sol B5/6 WARN)', () => {
  it('the owner removes a saved unit: the index drops it, the record is gone, and a capped principal can save again', () => {
    const { root, store: units } = store({ maxPerPrincipal: 1 });
    const first = units.save(unit('member:alice', 'one'));
    let refusal: unknown;
    try { units.save(unit('member:alice', 'two')); } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ reason: 'saved-unit-limit' });
    // The limit message names the way out.
    expect((refusal as Error).message).toContain('od workbench adoption catalogue-saved delete');
    expect(units.remove('member:alice', first.id)).toBe(true);
    expect(units.list('member:alice')).toEqual([]);
    expect(readdirSync(root).filter(name => name.endsWith('.json'))).toEqual([]);
    expect(units.read('member:alice', first.id)).toBeNull();
    expect(units.save(unit('member:alice', 'two')).principalId).toBe('member:alice');
  });

  it("only the owner can remove: another principal's remove changes nothing", () => {
    const { store: units } = store();
    const alice = units.save(unit('member:alice'));
    expect(units.remove('member:bob', alice.id)).toBe(false);
    expect(units.list('member:alice').map(entry => entry.id)).toEqual([alice.id]);
    expect(units.read('member:alice', alice.id)?.id).toBe(alice.id);
    expect(units.remove('member:alice', 'f'.repeat(64))).toBe(false);
  });
});

