import { describe, expect, it } from 'vitest';
import { parseOwnedImportRecord, parseOwnedImportRequest, type OwnedImportRecord } from '../src/api/workbench-owned-imports.js';

/** AC-R12.4: owner-provided export imports. Parsing proves shape, never ownership. */
const b64 = (text: string) => Buffer.from(text).toString('base64');
const request = {
  provider: 'magic-patterns', name: 'Landing export', entryPath: 'index.html',
  ownership: { declaration: 'owner-provided-export', exportedFrom: null },
  files: [{ path: 'index.html', contentBase64: b64('<h1>x</h1>') }],
};
const record: OwnedImportRecord = {
  schema: 'owned-import/1', id: 'import-0123456789abcdef', revision: 1, provider: 'magic-patterns', name: 'Landing export', principalId: 'local-owner',
  entryPath: 'index.html', artifactSha256: 'a'.repeat(64), files: [{ path: 'index.html', sha256: 'b'.repeat(64), bytes: 10, role: 'source' }], placeholders: [],
  provenance: { origin: 'owned', acquisition: 'owner-provided-local-file', declaration: 'owner-provided-export', exportedFrom: null, providerAccountUsed: false, providerMcpUsed: false, termsVersion: '2025-04-01', evidenceRef: 'docs/x.md' },
  createdAt: '2026-10-08T12:00:00.000Z',
};

describe('owned import contract (AC-R12.4)', () => {
  it('accepts an owner-provided export whose entry is one of its files', () => {
    expect(parseOwnedImportRequest(request).files).toHaveLength(1);
  });
  it('refuses a missing entry, traversal, duplicate paths, unknown providers and provider-generation fields', () => {
    expect(() => parseOwnedImportRequest({ ...request, entryPath: 'other.html' })).toThrow(/entry/);
    expect(() => parseOwnedImportRequest({ ...request, files: [{ path: '../x', contentBase64: b64('x') }] })).toThrow();
    expect(() => parseOwnedImportRequest({ ...request, files: [...request.files, ...request.files] })).toThrow(/Duplicate/);
    expect(() => parseOwnedImportRequest({ ...request, provider: 'figma' })).toThrow();
    expect(() => parseOwnedImportRequest({ ...request, generate: true })).toThrow();
  });
  it('a record states that no provider account or MCP was used and binds its entry', () => {
    expect(parseOwnedImportRecord(record).provenance.providerAccountUsed).toBe(false);
    expect(() => parseOwnedImportRecord({ ...record, provenance: { ...record.provenance, providerMcpUsed: true } })).toThrow();
    expect(() => parseOwnedImportRecord({ ...record, entryPath: 'missing.html' })).toThrow(/entry/);
  });
});
