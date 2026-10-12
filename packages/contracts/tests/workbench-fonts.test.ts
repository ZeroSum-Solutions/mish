import { describe, expect, it } from 'vitest';
import { describeFontSource, fontKitDeclarationSchema, fontPrimarySourceSchema, fontSourceRecordSchema, type FontKitDeclaration } from '../src/api/workbench-fonts.js';

const sha = (digit: string) => digit.repeat(64);
const COMMIT = '2eb0b48d5f760f62e286216f0859a8c540dbc1bd';

describe('AC-R11 preamble font source contracts', () => {
  it('accepts each pinned primary source and describes it in one line', () => {
    const google = fontPrimarySourceSchema.parse({ metadata: 'google/fonts', commit: COMMIT, path: 'ofl/roboto', metadataSha256: sha('a') });
    expect(describeFontSource(google)).toBe('ofl/roboto · google/fonts@2eb0b48');
    const fontshare = fontPrimarySourceSchema.parse({ metadata: 'fontshare', retrievedAt: '2026-10-08', slug: 'roundo', version: '1.0', listingSha256: sha('b'), listingRecordSha256: sha('c') });
    expect(describeFontSource(fontshare)).toContain('fontshare/roundo@1.0');
    expect(() => fontPrimarySourceSchema.parse({ metadata: 'google/fonts', commit: COMMIT, path: 'ofl/roboto', metadataSha256: sha('a'), packageName: 'x' })).toThrow();
  });

  it('requires a reason whenever a licence or notice digest is missing', () => {
    const record = { source: 'fontshare', identity: 'satoshi', revision: '2026-10-08', url: 'https://www.fontshare.com/fonts/satoshi', licenceType: 'ITF-FFL', licenceSha256: null, noticeSha256: null, localFile: 'none' } as const;
    expect(() => fontSourceRecordSchema.parse({ ...record, reason: null })).toThrow(/reason/);
    expect(fontSourceRecordSchema.parse({ ...record, reason: 'Restricted family: no licence file was fetched' }).localFile).toBe('none');
    expect(() => fontSourceRecordSchema.parse({ ...record, reason: 'x', url: 'http://insecure.example/font' })).toThrow();
  });

  it('keeps a mapped kit family tied to admitted files and an undeclared one to a named reason', () => {
    const base: FontKitDeclaration = { root: 'bundled-plugins', kit: 'examples/a', family: 'Brand', files: ['examples/a/x.css'], fileCount: 1, loading: ['local-font-face'], remoteHosts: [], state: 'mapped', reason: null, message: 'm', catalogueItemId: 'archivo', admittedFiles: [sha('d')], kitBytesAdmitted: true };
    expect(fontKitDeclarationSchema.parse(base).state).toBe('mapped');
    expect(() => fontKitDeclarationSchema.parse({ ...base, admittedFiles: [] })).toThrow();
    expect(() => fontKitDeclarationSchema.parse({ ...base, state: 'undeclared', reason: null, admittedFiles: [] })).toThrow();
    expect(() => fontKitDeclarationSchema.parse({ ...base, state: 'undeclared', reason: 'system-font' })).toThrow();
    expect(fontKitDeclarationSchema.parse({ ...base, state: 'undeclared', reason: 'system-font', admittedFiles: [], catalogueItemId: null }).reason).toBe('system-font');
  });
});
