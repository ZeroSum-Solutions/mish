import { describe, expect, it } from 'vitest';
import { digestOf, genuiComponentDigest } from '../../src/workbench/component-ledger-digest.js';

describe('GenUI core/overlay digest normalization', () => {
  it('normalizes core file records and overlay tuples to the same ordered shape', () => {
    const entry = { id: 'licensed', entry: 'index.ts', css: 'style.css' };
    const core = [{ file: 'style.css', sha256: 'b'.repeat(64) }, { file: 'index.ts', sha256: 'a'.repeat(64) }];
    const overlay = [['index.ts', 'a'.repeat(64)], ['style.css', 'b'.repeat(64)]] as const;
    // Raw hashing is shape-sensitive; both callers must go through normalization.
    expect(digestOf({ entry, files: core })).not.toBe(digestOf({ entry, files: overlay }));
    expect(genuiComponentDigest(entry, core)).toBe(genuiComponentDigest(entry, overlay));
    expect(core[0]!.file).toBe('style.css');
  });
  it('keeps missing and changed file digests distinct from complete bytes', () => {
    const entry = { id: 'licensed' };
    const complete = genuiComponentDigest(entry, [['index.ts', 'a'.repeat(64)]]);
    expect(genuiComponentDigest(entry, [['index.ts', null]])).not.toBe(complete);
    expect(genuiComponentDigest(entry, [{ file: 'index.ts', sha256: 'b'.repeat(64) }])).not.toBe(complete);
  });
});
