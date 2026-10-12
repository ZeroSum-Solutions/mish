import { mkdtempSync, rmSync, symlinkSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createFontsResourceSource } from '../fixtures/daemon-b/fonts.js';
import { FONT_FILE_LIMIT } from '../../src/fonts/local-files.js';
import { REPO_BUNDLED_PLUGINS_ROOT, authority, catalogueCopy, copiedFontRoot } from '../fixtures/daemon-b/fonts.js';

const plexFiles = () => catalogueCopy().families.find(family => family.id === 'ibm-plex-mono')!.localFiles;
async function plex(root: string) {
  const source = createFontsResourceSource({ root });
  const snapshot = await source.list(authority);
  return { source, snapshot, item: snapshot.items.find(item => item.ref.itemId === 'ibm-plex-mono')! };
}

describe('AC-R11.2 admitted local font bytes are untrusted binaries', () => {
  it('serves digest-pinned bytes only after size, magic and sha256 checks', async () => {
    const { source, item } = await plex(REPO_BUNDLED_PLUGINS_ROOT);
    const file = item.fontProfile!.localFiles[0]!;
    const read = await source.readFile(file.sha256);
    expect(read).toMatchObject({ state: 'available', contentType: 'font/woff2' });
    expect(read.state === 'available' && read.bytes.subarray(0, 4).toString('latin1')).toBe('wOF2');
    expect(await source.readFile('0'.repeat(64))).toEqual({ state: 'unavailable', reason: 'font-file-unknown' });
    expect(await source.readFile('../../etc/passwd')).toEqual({ state: 'unavailable', reason: 'font-file-unknown' });
    const notice = await source.readNotice(file.notice.sha256);
    expect(notice.state === 'available' && notice.text).toContain('SIL Open Font License');
  });

  it('a tampered file becomes unavailable with a named reason and changes the item revision', async () => {
    const root = copiedFontRoot('ibm-plex-mono');
    const clean = await plex(root);
    const target = plexFiles()[0]!;
    // Same size and magic, one flipped byte in the body: only the digest can catch it.
    const original = readFileSync(path.join(root, target.path));
    const middle = original.length >> 1;
    original[middle] = original[middle]! ^ 0xff;
    writeFileSync(path.join(root, target.path), original);
    const tampered = await plex(root);
    const file = tampered.item.fontProfile!.localFiles.find(entry => entry.sha256 === target.sha256)!;
    expect(file).toMatchObject({ state: 'unavailable', reason: 'font-file-digest-mismatch' });
    expect(file.url).toBeUndefined();
    expect(tampered.item.ref.revisionOrDigest).not.toBe(clean.item.ref.revisionOrDigest);
    // The copied root holds only this family, so other families report unreadable files too.
    expect(tampered.snapshot.status.state).toBe('degraded');
    expect(tampered.snapshot.status.reason).toContain('font-file-digest-mismatch:1');
    expect(clean.snapshot.status.reason).not.toContain('digest-mismatch');
    expect(await tampered.source.readFile(target.sha256)).toEqual({ state: 'unavailable', reason: 'font-file-digest-mismatch' });
  });

  it('refuses wrong magic, oversized files, missing files and symlinks that escape the root', async () => {
    const files = plexFiles();
    const root = copiedFontRoot('ibm-plex-mono');
    const [magic, oversized, missing, escaped] = files;
    const bytes = readFileSync(path.join(root, magic!.path));
    writeFileSync(path.join(root, magic!.path), Buffer.concat([Buffer.from('<svg'), bytes.subarray(4)]));
    writeFileSync(path.join(root, oversized!.path), Buffer.alloc(FONT_FILE_LIMIT + 1));
    rmSync(path.join(root, missing!.path));
    const outside = mkdtempSync(path.join(tmpdir(), 'od-b6-outside-'));
    writeFileSync(path.join(outside, 'font.woff2'), readFileSync(path.join(REPO_BUNDLED_PLUGINS_ROOT, escaped!.path)));
    rmSync(path.join(root, escaped!.path));
    symlinkSync(path.join(outside, 'font.woff2'), path.join(root, escaped!.path));
    const { item, snapshot } = await plex(root);
    const state = (sha: string) => item.fontProfile!.localFiles.find(file => file.sha256 === sha)!.reason;
    // A wrong first four bytes changes the digest too; the magic check runs first and names the real problem.
    expect(state(magic!.sha256)).toBe('font-file-magic-mismatch');
    expect(state(oversized!.sha256)).toBe('font-file-size-mismatch');
    expect(state(missing!.sha256)).toBe('font-file-unreadable');
    expect(state(escaped!.sha256)).toBe('font-file-unreadable');
    expect(item.previewCapability).toMatchObject({ available: false, kind: 'none', reason: 'no-local-font-file' });
    expect(JSON.stringify(snapshot)).not.toContain(root);
    expect(JSON.stringify(snapshot)).not.toContain(outside);
  });

  it('a metadata-only family states truthfully that no local font file is admitted', async () => {
    const { snapshot } = await plex(REPO_BUNDLED_PLUGINS_ROOT);
    const inter = snapshot.items.find(item => item.ref.itemId === 'inter')!;
    expect(inter.fontProfile!.localFiles).toEqual([]);
    expect(inter.previewCapability).toEqual({ available: false, kind: 'none', reason: 'no-local-font-file' });
    expect(inter.compatibility).toMatchObject({ nativeFormat: 'fontsource-metadata', state: 'unverified' });
  });

  it('an unreadable root degrades the source instead of failing search', async () => {
    const missingRoot = path.join(mkdtempSync(path.join(tmpdir(), 'od-b6-gone-')), 'absent');
    const { snapshot } = await plex(missingRoot);
    expect(snapshot.status.state).toBe('degraded');
    expect(snapshot.status.reason).toMatch(/^font-file-unreadable:\d+; font-notice-unreadable:\d+$/);
    expect(snapshot.items.length).toBeGreaterThan(0);
    expect(snapshot.items.every(item => !item.previewCapability.available)).toBe(true);
  });

  it('validates unicode ranges exactly as the contract does (uppercase, bounded)', () => {
    const lower = catalogueCopy();
    lower.families[0]!.unicodeRanges.latin = lower.families[0]!.unicodeRanges.latin!.toLowerCase().replace(/u\+/g, 'U+');
    expect(() => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue: lower })).toThrow(/catalogue/i);
    const long = catalogueCopy();
    long.families[0]!.unicodeRanges.latin = Array.from({ length: 700 }, (_, index) => `U+${(0x1000 + index * 2).toString(16).toUpperCase()}`).join(',');
    expect(() => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue: long })).toThrow(/catalogue/i);
  });

  it('a file shared by several families takes the most restrictive rights among them', async () => {
    const catalogue = catalogueCopy();
    const archivo = catalogue.families.find(family => family.id === 'archivo')!;
    const inter = catalogue.families.find(family => family.id === 'inter')!;
    inter.localFiles = structuredClone(archivo.localFiles);
    inter.licence.type = 'ITF-FFL';
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue });
    expect(await source.readFile(archivo.localFiles[0]!.sha256)).toEqual({ state: 'unavailable', reason: 'rights-blocked' });
    const item = (await source.list(authority)).items.find(entry => entry.ref.itemId === 'archivo')!;
    expect(item.fontProfile!.localFiles.every(file => file.state === 'unavailable' && file.reason === 'rights-blocked')).toBe(true);
    expect(item.previewCapability).toMatchObject({ available: false });
  });

  it('rejects a catalogue whose local path escapes the root', () => {
    const catalogue = catalogueCopy();
    catalogue.families[0]!.localFiles = [{ ...plexFiles()[0]!, path: '../outside.woff2' }];
    expect(() => createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue })).toThrow(/catalogue/i);
  });
});
