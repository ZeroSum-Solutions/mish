import { describe, expect, it } from 'vitest';
import { parseFontCheckRequest, parseFontCheckResponse, type ResourceResult } from '@mish/contracts';
import { checkFont } from '../../src/fonts/check.js';
import { parseUnicodeRanges, rangesContain } from '../../src/fonts/catalogue.js';
import { renderFontSpecimen } from '../../src/fonts/specimen.js';
import { resourceRefKey } from '../../src/workbench/context-ranking.js';
import { createFontsResourceSource } from '../fixtures/daemon-b/fonts.js';
import { REPO_BUNDLED_PLUGINS_ROOT, authority, catalogueCopy } from '../fixtures/daemon-b/fonts.js';

async function font(id: string) {
  const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT });
  const item = (await source.list(authority)).items.find(entry => entry.ref.itemId === id)!;
  const resource: ResourceResult = { ...item, refKey: resourceRefKey(item.ref) };
  return { resource, family: source.family(id)! };
}
const check = async (id: string, input: Record<string, unknown>) => {
  const { resource, family } = await font(id);
  return parseFontCheckResponse(checkFont(resource, family, parseFontCheckRequest({ refKey: resource.refKey, ...input })));
};

describe('AC-R11.2 glyph, weight, style, subset, fallback and licence checks', () => {
  it('flags a missing glyph against declared subsets and against the admitted local files', async () => {
    const result = await check('fraunces', { text: 'Hello Жар', weights: [400, 900], styles: ['italic'], subsets: ['latin', 'cyrillic'] });
    expect(result.glyphs.checked).toBe(7);
    expect(result.glyphs.declared.missing.map(glyph => glyph.codepoint)).toEqual(['U+0416', 'U+0430', 'U+0440']);
    // No admitted 400 italic face exists, so strictly none of the 7 glyphs is local at 400 italic;
    // the browser still draws the Latin ones with the nearest (900 italic) face, so only 3 fall back.
    expect(result.glyphs.local).toMatchObject({ state: 'checked', missingCount: 7 });
    expect(result.weights).toEqual([{ weight: 400, declared: true, local: 'missing' }, { weight: 900, declared: true, local: 'available' }]);
    expect(result.styles).toEqual([{ style: 'italic', declared: true, local: 'available' }]);
    expect(result.subsets).toEqual([{ subset: 'latin', declared: true, local: 'available' }, { subset: 'cyrillic', declared: false, local: 'missing' }]);
    expect(result.fallback).toMatchObject({ glyphsRenderedByFallback: 3 });
    expect(result.fallback.stack).toMatch(/^'Fraunces', .*serif$/);
    expect(result.passed).toBe(false);
    expect(result.specimenUrl).toMatch(/^\/api\/workbench\/fonts\/specimen\?ref=/);
  });

  it('passes when the needed glyphs and weight are in the admitted variable file', async () => {
    const result = await check('archivo', { text: 'Café déjà vu', weights: [700], styles: ['normal'] });
    expect(result.glyphs.declared.missingCount).toBe(0);
    expect(result.glyphs.local).toMatchObject({ state: 'checked', missingCount: 0 });
    expect(result.weights).toEqual([{ weight: 700, declared: true, local: 'available' }]);
    expect(result.licence).toMatchObject({ type: 'OFL-1.1', recognised: true, commercialUse: 'permitted', webEmbedding: 'permitted', redistribution: 'permitted' });
    expect(result.passed).toBe(true);
  });

  it('passes Bodoni Moda ASCII despite overlapping declared subset ranges', async () => {
    const result = await check('bodoni-moda', { text: 'Owned Commerce 123', weights: [400], styles: ['normal'] });
    expect(result.glyphs.checked).toBe(13);
    expect(result.glyphs.declared.missing).toEqual([]);
    expect(result.glyphs.local).toMatchObject({ state: 'checked', missingCount: 0 });
    expect(result.weights).toEqual([{ weight: 400, declared: true, local: 'available' }]);
    expect(result.styles).toEqual([{ style: 'normal', declared: true, local: 'available' }]);
    expect(result.licence).toMatchObject({ type: 'OFL-1.1', recognised: true, webEmbedding: 'permitted' });
    expect(result.passed).toBe(true);
  });

  it('still rejects Cyrillic outside Bodoni Moda declared and local coverage', async () => {
    const result = await check('bodoni-moda', { text: 'Ж', weights: [400], styles: ['normal'] });
    expect(result.glyphs.declared.missing).toEqual([{ char: 'Ж', codepoint: 'U+0416' }]);
    expect(result.glyphs.local.missing).toEqual([{ char: 'Ж', codepoint: 'U+0416' }]);
    expect(result.fallback.glyphsRenderedByFallback).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('counts a glyph as local only when the serving face covers it: cmap within the file\'s unicode-range', async () => {
    // Archivo's latin file has U+0301 in its cmap, but the latin face's unicode-range leaves it out,
    // so the browser draws the accent with the fallback. The check must not pass.
    const result = await check('archivo', { text: 'Cafe\u0301', weights: [700], styles: ['normal'] });
    expect(result.glyphs.declared.missingCount).toBe(0);
    expect(result.glyphs.local.missing).toEqual([{ char: '\u0301', codepoint: 'U+0301' }]);
    expect(result.fallback.glyphsRenderedByFallback).toBe(1);
    expect(result.passed).toBe(false);
  });

  it('checks glyphs against the requested weight and style only, never pooling roman and italic', async () => {
    const italic = await check('ibm-plex-mono', { text: 'abc', styles: ['italic'] });
    expect(italic.styles).toEqual([{ style: 'italic', declared: true, local: 'missing' }]);
    expect(italic.glyphs.local).toMatchObject({ state: 'checked', missingCount: 3 });
    const bold = await check('ibm-plex-mono', { text: 'abc', weights: [700] });
    expect(bold.glyphs.local.missingCount).toBe(3);
    const regular = await check('ibm-plex-mono', { text: 'abc', weights: [500], styles: ['normal'] });
    expect(regular.glyphs.local.missingCount).toBe(0);
    expect(regular.passed).toBe(true);
  });

  it('reports a metadata-only family truthfully: declared coverage, no local file, no specimen', async () => {
    const result = await check('inter', { text: 'Привет', weights: [450] });
    expect(result.glyphs.declared.missingCount).toBe(0);
    expect(result.glyphs.local).toEqual({ state: 'no-local-file', missing: [], missingCount: 0 });
    // 450 is inside Inter's variable wght axis, so it is declared even though it is not a static instance.
    expect(result.weights).toEqual([{ weight: 450, declared: true, local: 'no-local-file' }]);
    expect(result.specimenUrl).toBeNull();
    expect(result.fallback.glyphsRenderedByFallback).toBe(6);
    expect(result.passed).toBe(false);
    expect(result.notes.join(' ')).toMatch(/no local file admitted/i);
  });

  it('names the Reserved Font Name rule instead of offering local subsetting', async () => {
    const result = await check('ibm-plex-mono', { text: 'x' });
    expect(result.licence.reservedFontNames).toContain('Plex');
    expect(result.licence.modification).toMatch(/upstream-provided subsets/i);
    expect(result.licence.modification).toMatch(/Plex/);
  });
});

describe('AC-R11.2 specimen preview is script-free with a strict CSP and no external requests', () => {
  it('escapes user text, loads only same-origin admitted files and forbids everything else', async () => {
    const { resource } = await font('fraunces');
    const specimen = renderFontSpecimen(resource, { text: '</style><script>alert(1)</script><img src=https://evil.example/x>', weight: 900, style: 'italic' });
    expect(specimen.html).not.toMatch(/<script/i);
    expect(specimen.html).not.toMatch(/<img/i);
    expect(specimen.html).toContain('&lt;/style&gt;&lt;script&gt;');
    const urls = [...specimen.html.matchAll(/url\(([^)]*)\)/g)].map(match => match[1]!.replace(/["']/g, ''));
    expect(urls.length).toBe(resource.fontProfile!.localFiles.length);
    for (const url of urls) expect(url).toMatch(/^\/api\/workbench\/fonts\/files\/[a-f0-9]{64}$/);
    // The hostile URL survives only as escaped text: no attribute or stylesheet can fetch it.
    const tags = specimen.html.match(/<[a-z][^>]*>/gi) ?? [];
    expect(tags.filter(tag => /\b(src|href|srcset|action)=/i.test(tag))).toEqual([]);
    expect(specimen.html).not.toMatch(/url\(["']?https?:/i);
    expect(specimen.contentSecurityPolicy).toContain("default-src 'none'");
    expect(specimen.contentSecurityPolicy).toContain("font-src 'self'");
    expect(specimen.contentSecurityPolicy).not.toMatch(/script-src/);
    expect(specimen.html).toContain('unicode-range');
  });

  it('a restricted family names the rights block instead of claiming no local file exists', async () => {
    const catalogue = catalogueCopy();
    catalogue.families.find(entry => entry.id === 'fraunces')!.licence.type = 'ITF-FFL';
    const source = createFontsResourceSource({ root: REPO_BUNDLED_PLUGINS_ROOT, catalogue });
    const item = (await source.list(authority)).items.find(entry => entry.ref.itemId === 'fraunces')!;
    const specimen = renderFontSpecimen({ ...item, refKey: resourceRefKey(item.ref) }, { text: 'Hello' });
    expect(specimen.html).not.toContain('@font-face');
    expect(specimen.html).toMatch(/ITF-FFL licence restricts/);
    expect(specimen.html).not.toMatch(/No local file admitted/);
  });

  it('a family without local files renders a truthful unavailable specimen', async () => {
    const { resource } = await font('inter');
    const specimen = renderFontSpecimen(resource, { text: 'Hello' });
    expect(specimen.html).not.toContain('@font-face');
    expect(specimen.html).toMatch(/no local file admitted/i);
  });
});

describe('Unicode range union membership', () => {
  it.each([
    { name: 'overlap', input: 'U+0028-0040,U+0010-0030,U+0020-0025', points: [0x0f, 0x10, 0x26, 0x40, 0x41], want: [false, true, true, true, false] },
    { name: 'nested ranges', input: 'U+0000-00FF,U+0001-000C,U+000E-001F', points: [0, 0x0d, 0x41, 0xff, 0x100], want: [true, true, true, true, false] },
    { name: 'equal starts and duplicate ranges', input: 'U+0010-0030,U+0010-0015,U+0010-0015', points: [0x0f, 0x10, 0x20, 0x30, 0x31], want: [false, true, true, true, false] },
    { name: 'adjacent inclusive ranges', input: 'U+0020-002F,U+0010-001F', points: [0x0f, 0x10, 0x1f, 0x20, 0x2f, 0x30], want: [false, true, true, true, true, false] },
    { name: 'disjoint ranges preserve gaps', input: 'U+0030-003F,U+0010-001F', points: [0x0f, 0x10, 0x1f, 0x20, 0x2f, 0x30, 0x3f, 0x40], want: [false, true, true, false, false, true, true, false] },
    { name: 'wildcards at the Unicode boundary', input: 'U+10FFF?,U+00??', points: [-1, 0, 0xff, 0x100, 0x10ffef, 0x10fff0, 0x10ffff, 0x110000], want: [false, true, true, false, false, true, true, false] },
    { name: 'empty input', input: '', points: [0, 0x41, 0x10ffff], want: [false, false, false] },
  ])('checks $name without losing covered codepoints or filling gaps', ({ input, points, want }) => {
    const ranges = parseUnicodeRanges(input);
    expect(points.map(codepoint => rangesContain(ranges, codepoint))).toEqual(want);
  });

  it.each(['U+0020-0010', 'U+110000', 'U+11000?', 'not-a-range'])('rejects invalid range %s', input => {
    expect(() => parseUnicodeRanges(input)).toThrow(/Invalid font catalogue/);
  });
});
