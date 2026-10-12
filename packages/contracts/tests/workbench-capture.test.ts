import { describe, expect, it } from 'vitest';
import { captureImportMetadataSchema, encodeCaptureMetadataHeader, rightsDeclarationSchema, unitSaveRequestSchema } from '../src/index.js';

describe('workbench capture contracts (AC-R14.1, AC-R14.3)', () => {
  const page = { projectId: 'p', captureMode: 'native-page', viewport: { width: 10, height: 10, deviceScaleFactor: 1 }, frame: { width: 10, height: 10 } } as const;

  it('requires a viewport for desktop captures and keeps a region inside the frame', () => {
    expect(captureImportMetadataSchema.safeParse(page).success).toBe(true);
    expect(captureImportMetadataSchema.safeParse({ ...page, viewport: null }).success).toBe(false);
    expect(captureImportMetadataSchema.safeParse({ ...page, captureMode: 'native-region', region: { x: 5, y: 0, width: 6, height: 2 } }).success).toBe(false);
    expect(captureImportMetadataSchema.safeParse({ ...page, captureMode: 'native-region', region: { x: 4, y: 0, width: 6, height: 2 } }).success).toBe(true);
    expect(captureImportMetadataSchema.safeParse({ ...page, region: { x: 0, y: 0, width: 1, height: 1 } }).success).toBe(false);
  });

  it('has no URL-to-fetch field and lets no client set capture authority, ids or hashes', () => {
    for (const extra of [{ url: 'http://x' }, { capturePermission: 'desktop-host-user-action' }, { contentHash: 'a'.repeat(64) }, { id: 'cap_x' }]) {
      expect(captureImportMetadataSchema.safeParse({ ...page, ...extra }).success).toBe(false);
    }
  });

  it('requires evidence for a licensed declaration and keeps declarations status-free', () => {
    expect(rightsDeclarationSchema.safeParse({ basis: 'licensed', evidenceRefs: [], notices: [] }).success).toBe(false);
    expect(rightsDeclarationSchema.safeParse({ basis: 'licensed', evidenceRefs: ['MIT LICENSE'], notices: [] }).success).toBe(true);
    expect(rightsDeclarationSchema.safeParse({ basis: 'user-owned', evidenceRefs: [], notices: [], status: 'redistributable' }).success).toBe(false);
  });

  it('rejects path escapes and hashes for unlisted paths in a unit save', () => {
    const base = { source: { kind: 'project', projectId: 'p', paths: ['index.html'], rootSelector: 'body', expectedHashes: { 'index.html': 'a'.repeat(64) } }, kind: 'page', name: 'Page' };
    expect(unitSaveRequestSchema.safeParse(base).success).toBe(true);
    expect(unitSaveRequestSchema.safeParse({ ...base, source: { ...base.source, paths: ['../index.html'] } }).success).toBe(false);
    expect(unitSaveRequestSchema.safeParse({ ...base, source: { ...base.source, expectedHashes: { 'index.html': 'a'.repeat(64), 'x.css': 'b'.repeat(64) } } }).success).toBe(false);
    expect(unitSaveRequestSchema.safeParse({ ...base, excludePaths: ['other.png'] }).success).toBe(false);
  });

  it('encodes metadata as base64url UTF-8 JSON', () => {
    const encoded = encodeCaptureMetadataHeader({ ...page, sourceTitle: 'Préçis ✓' });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toMatchObject({ sourceTitle: 'Préçis ✓' });
  });
});
