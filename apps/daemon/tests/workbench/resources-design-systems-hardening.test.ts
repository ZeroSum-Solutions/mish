import { createHash } from 'node:crypto';
import fs, { mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createDesignSystemsResourceSource } from '../../src/workbench/resources-design-systems.js';
import { authority, designSystemFixtureRoot } from './resources-inventory-fixture.js';

const manifest = (id: string, extra: Record<string, unknown> = {}, files: Record<string, string> = {}) => JSON.stringify({
  schemaVersion: 'od-design-system-project/v1', id, name: `System ${id}`, category: 'Testing',
  source: { type: 'bundled', origin: 'Fixture' },
  files: { design: 'DESIGN.md', tokens: 'tokens.css', designTokens: 'design-tokens.json', ...files }, ...extra,
});
const tokens = (list: Array<[string, string, string]>) => JSON.stringify({ format: 'od-design-tokens/v1', tokens: list.map(([name, type, value]) => ({ name, type, value })) });
const pkg = (id: string, extra: Record<string, unknown> = {}) => ({ 'manifest.json': manifest(id, extra), 'DESIGN.md': `# ${id}\n`, 'tokens.css': ':root{}', 'design-tokens.json': tokens([['--bg', 'color', '#fff']]) });

describe('design-systems adapter hardening', () => {
  it('refuses a top-level package symlink that resolves outside the resource root', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'od-u7-outside-'));
    for (const [file, body] of Object.entries(pkg('evil'))) writeFileSync(path.join(outside, file), body);
    const root = designSystemFixtureRoot({ good: pkg('good') });
    symlinkSync(outside, path.join(root, 'evil'));
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.items.map(item => item.ref.itemId)).toEqual(['good', 'good/color-palette']);
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'package-outside-root:1' });
    expect(JSON.stringify(snapshot)).not.toContain(outside);
  });

  it('keeps an in-root package symlink whose target stays inside the root', async () => {
    const root = designSystemFixtureRoot({ store: Object.fromEntries(Object.entries(pkg('alias')).map(([file, body]) => [`real/${file}`, body])) });
    symlinkSync(path.join(root, 'store', 'real'), path.join(root, 'alias'));
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.items.map(item => item.ref.itemId)).toEqual(['alias', 'alias/color-palette']);
    expect(snapshot.status).toMatchObject({ state: 'searched', reason: null });
  });

  it.each([
    ['missing', (_dir: string) => {}],
    ['invalid JSON', (dir: string) => writeFileSync(path.join(dir, 'design-tokens.json'), '{not json')],
    ['oversized', (dir: string) => writeFileSync(path.join(dir, 'design-tokens.json'), Buffer.alloc(2 * 1024 * 1024 + 1, 32))],
    ['a symlink', (dir: string) => { writeFileSync(path.join(dir, 'elsewhere.json'), tokens([['--bg', 'color', '#fff']])); symlinkSync(path.join(dir, 'elsewhere.json'), path.join(dir, 'design-tokens.json')); }],
  ])('degrades when declared design tokens are %s instead of silently dropping categories', async (_label, prepare) => {
    const root = designSystemFixtureRoot({ broken: { 'manifest.json': manifest('broken'), 'DESIGN.md': '# Broken\n', 'tokens.css': ':root{}' } });
    prepare(path.join(root, 'broken'));
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.items.map(item => item.category)).toEqual(['design-system']);
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'design-tokens-unreadable:1' });
  });

  // The preview pages link the declared token stylesheet; without it they render unstyled.
  it.each([
    ['missing', (dir: string) => fs.rmSync(path.join(dir, 'tokens.css'))],
    ['oversized', (dir: string) => writeFileSync(path.join(dir, 'tokens.css'), Buffer.alloc(2 * 1024 * 1024 + 1, 32))],
    ['a symlink', (dir: string) => { writeFileSync(path.join(dir, 'elsewhere.css'), ':root{}'); fs.rmSync(path.join(dir, 'tokens.css')); symlinkSync(path.join(dir, 'elsewhere.css'), path.join(dir, 'tokens.css')); }],
  ])('degrades when the declared token stylesheet is %s and offers no cohort preview that needs it', async (_label, prepare) => {
    const root = designSystemFixtureRoot({ styled: { ...pkg('styled', { preview: { dir: 'preview', pages: [{ path: 'preview/colors.html', role: 'colors' }] } }), 'preview/colors.html': '<link rel="stylesheet" href="../tokens.css"><p>colors</p>' } });
    prepare(path.join(root, 'styled'));
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'tokens-css-unreadable:1' });
    expect(snapshot.items.find(item => item.category === 'color-palette')!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'tokens-css-unreadable' });
  });

  it('names a declared but unreadable preview page distinctly from an undeclared one', async () => {
    const root = designSystemFixtureRoot({ paged: pkg('paged', { preview: { dir: 'preview', pages: [{ path: 'preview/colors.html', role: 'colors' }] } }) });
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.items.find(item => item.category === 'color-palette')!.previewCapability).toEqual({ available: false, kind: 'none', reason: 'preview-page-unreadable' });
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'preview-page-unreadable:1' });
  });

  it('gives font families that slug alike distinct item IDs', async () => {
    const fonts = [{ family: 'Inter Display', file: 'fonts/a.woff2' }, { family: 'inter_display', file: 'fonts/b.woff2' }];
    const root = designSystemFixtureRoot({ fonts: { ...pkg('fonts', { fonts }), 'fonts/a.woff2': 'wOF2', 'fonts/b.woff2': 'wOF2' } });
    const { items } = await createDesignSystemsResourceSource({ root }).list(authority);
    const ids = items.filter(item => item.category === 'font').map(item => item.ref.itemId);
    const hash = (family: string) => createHash('sha256').update(family).digest('hex').slice(0, 8);
    expect(ids).toEqual([`fonts/font/inter-display-${hash('Inter Display')}`, `fonts/font/inter-display-${hash('inter_display')}`]);
  });

  it('honours the manifest-declared design and token stylesheet file names', async () => {
    const root = designSystemFixtureRoot({ renamed: {
      'manifest.json': manifest('renamed', {}, { design: 'GUIDE.md', tokens: 'theme.css' }), 'GUIDE.md': '# Renamed\n',
      'theme.css': ':root { --motion-fast: 120ms; }\n@media (prefers-reduced-motion: reduce) { :root { --motion-fast: 0ms; } }\n',
      'design-tokens.json': tokens([['--motion-fast', 'duration', '120ms']]),
    } });
    const snapshot = await createDesignSystemsResourceSource({ root }).list(authority);
    expect(snapshot.status).toMatchObject({ state: 'searched', reason: null });
    expect(snapshot.items.map(item => item.category)).toEqual(['design-system', 'motion']);
    expect(snapshot.items[1]!.motionMetadata).toMatchObject({ state: 'reduced-compatible', basis: 'declared' });
  });

  it('caps packages, preview pages and fonts per package and reports each cap', async () => {
    const pages = [{ path: 'preview/a.html', role: 'colors' }, { path: 'preview/b.html', role: 'typography' }];
    const fonts = [{ family: 'One', file: 'fonts/one.woff2' }, { family: 'Two', file: 'fonts/two.woff2' }];
    const root = designSystemFixtureRoot({
      'a-sys': { ...pkg('a-sys', { preview: { dir: 'preview', pages }, fonts }), 'preview/a.html': '<p>a</p>', 'preview/b.html': '<p>b</p>', 'fonts/one.woff2': 'wOF2', 'fonts/two.woff2': 'wOF2' },
      'b-sys': pkg('b-sys'), 'c-sys': pkg('c-sys'),
    });
    const snapshot = await createDesignSystemsResourceSource({ root, limits: { packages: 2, previewPages: 1, fonts: 1 } }).list(authority);
    expect(snapshot.items.map(item => item.ref.itemId.split('/')[0])).not.toContain('c-sys');
    expect(snapshot.items.filter(item => item.category === 'font')).toHaveLength(1);
    expect(snapshot.status).toMatchObject({ state: 'degraded', reason: 'package-limit-exceeded:1; preview-page-limit-exceeded:1; font-limit-exceeded:1' });
  });
});
