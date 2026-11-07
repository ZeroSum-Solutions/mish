import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { checkPage, deriveTheme, renderPage } from '../src/index.ts';
import { BACKGROUND_IDS, CATALOG_ASSETS, HOVER_IDS } from '../src/catalog-assets.ts';
import { MOOD_EFFECTS } from '../src/style.ts';
import { syncLinkpageCatalog } from '../../../scripts/sync-linkpage-catalog.ts';

const SERIF = [{ colors: [{ hex: '#bf9b5d', weight: 9 }, { hex: '#fcfbf9', weight: 3 }], fonts: [{ family: 'Cormorant Garamond', weight: 4 }] }];
const SANS = [{ fonts: [{ family: 'Poppins', weight: 1 }] }];
const MONO = [{ fonts: [{ family: 'Space Mono', weight: 1 }] }];
const DISPLAY = [{ fonts: [{ family: 'Fredoka', weight: 1 }] }];

const page = (theme: ReturnType<typeof deriveTheme>) =>
  checkPage({
    slug: 'a', theme, profile: { name: 'Sam', bio: 'Makes things.' },
    blocks: [
      { type: 'link', label: 'Shop', url: 'https://example.com/shop' },
      { type: 'posts', heading: 'Latest', items: [{ title: 'A post', url: 'https://example.com/p' }] },
      { type: 'email', heading: 'Join', button: 'Join', note: '', endpoint: 'https://example.com/s' },
    ],
  } as never);

test('each mood picks its Mish background and hover', () => {
  assert.deepEqual(MOOD_EFFECTS, {
    editorial: { background: 'grainient', hover: 'glare-hover' },
    modern: { background: 'soft-aurora', hover: 'spotlight-card' },
    raw: { background: 'dot-grid', hover: 'magnet' },
    playful: { background: 'waves', hover: 'star-border' },
  });
  assert.deepEqual(deriveTheme(SERIF).effects, MOOD_EFFECTS.editorial);
  assert.deepEqual(deriveTheme(SANS).effects, MOOD_EFFECTS.modern);
  assert.deepEqual(deriveTheme(MONO).effects, MOOD_EFFECTS.raw);
  assert.deepEqual(deriveTheme(DISPLAY).effects, MOOD_EFFECTS.playful);
});

for (const [name, signals] of [['editorial', SERIF], ['modern', SANS], ['raw', MONO], ['playful', DISPLAY]] as const) {
  test(`the ${name} page inlines its effects once, with the page's own colours, and no canvas`, () => {
    const theme = deriveTheme(signals);
    const { background, hover } = theme.effects!;
    const html = renderPage(page(theme));
    assert.ok(!html.includes('<canvas'));
    assert.match(html, new RegExp(`<div id="fx-bg" class="genui-${background}" data-genui="${background}"`));
    assert.ok(html.includes(CATALOG_ASSETS[background!]!.css));
    assert.equal(html.split(CATALOG_ASSETS[background!]!.css).length, 2);
    assert.ok(html.includes(CATALOG_ASSETS[hover!]!.css));
    for (const id of [background!, hover!]) {
      const js = CATALOG_ASSETS[id]!.js;
      if (js) { assert.equal(html.split(js).length, 2); assert.ok(html.indexOf(js) < html.indexOf('</body>')); }
    }
    assert.ok(html.includes('data-genui-opts'));
    assert.ok(html.includes(theme.palette.bg));
    assert.match(html, new RegExp(`<a data-genui="${hover}"[^>]*class="genui-${hover} link`));
    assert.match(html, new RegExp(`<a data-genui="${hover}"[^>]*class="genui-${hover} post`));
    assert.match(html, hover === 'magnet' ? /<section class="email">/ : new RegExp(`<section data-genui="${hover}"[^>]*class="genui-${hover} email`));
  });
}

test('the page reads fully with scripts off: the content is plain HTML, the effect only decorates', () => {
  const html = renderPage(page(deriveTheme(SANS)));
  const main = html.slice(html.indexOf('<main>'), html.indexOf('</main>'));
  assert.match(main, /<h1>Sam<\/h1>/);
  assert.match(main, /Shop/);
  assert.match(main, /A post/);
  assert.match(html, /<div id="fx-bg"[^>]*aria-hidden="true"/);
  assert.match(html, /#fx-bg\{position:fixed;inset:0;z-index:-1;pointer-events:none\}/);
});

test('a forced background keeps today\'s canvas exactly and gets no mood effects', () => {
  const theme = deriveTheme(SERIF, { background: 'grid' });
  assert.equal(theme.background, 'grid');
  assert.equal(theme.effects, undefined);
  const html = renderPage(page(theme));
  assert.match(html, /<canvas id="bg"[^>]*data-effect="grid"/);
  assert.ok(!html.includes('fx-bg') && !html.includes('data-genui'));
});

test('option effects override the mood, "none" turns a slot off, and a forced background can still take effects', () => {
  assert.deepEqual(deriveTheme(SERIF, { effects: { hover: 'magnet' } }).effects, { background: 'grainient', hover: 'magnet' });
  assert.deepEqual(deriveTheme(SERIF, { effects: { background: 'none' } }).effects, { hover: 'glare-hover' });
  assert.equal(deriveTheme(SERIF, { effects: { background: 'none', hover: 'none' } }).effects, undefined);
  assert.deepEqual(deriveTheme(SERIF, { background: 'mesh', effects: { hover: 'star-border' } }).effects, { hover: 'star-border' });
  // With effects.background off, the canvas is the fallback again.
  const html = renderPage(page(deriveTheme(SERIF, { effects: { background: 'none' } })));
  assert.match(html, /<canvas id="bg"/);
});

test('an unknown effect id is dropped, never an error', () => {
  const theme = deriveTheme(SERIF, { effects: { background: 'rm-rf', hover: 'soft-aurora' } });
  assert.deepEqual(theme.effects, { background: 'grainient', hover: 'glare-hover' });
  const spec = checkPage({ slug: 'a', profile: { name: 'x' }, blocks: [], theme: { ...deriveTheme(SERIF), effects: { background: 'nope', hover: 'glare-hover', extra: 'x' } as never } });
  assert.deepEqual(spec.theme.effects, { hover: 'glare-hover' });
  const bare = checkPage({ slug: 'a', profile: { name: 'x' }, blocks: [], theme: { ...deriveTheme(SERIF), effects: { background: 'nope' } as never } });
  assert.equal(bare.theme.effects, undefined);
  assert.ok(!renderPage(bare).includes('data-genui'));
});

test('every allowlisted pair stays under the inlined size budget', () => {
  const bytes = (id: string) => Buffer.byteLength(CATALOG_ASSETS[id]!.css) + Buffer.byteLength(CATALOG_ASSETS[id]!.js);
  const worst = Math.max(...BACKGROUND_IDS.map(bytes)) + Math.max(...HOVER_IDS.map(bytes));
  assert.ok(worst < 12 * 1024, `worst pair is ${worst} bytes`);
  assert.deepEqual([...BACKGROUND_IDS].sort(), ['dot-grid', 'grainient', 'light-rays', 'soft-aurora', 'waves']);
  assert.deepEqual([...HOVER_IDS].sort(), ['glare-hover', 'magnet', 'spotlight-card', 'star-border']);
});

test('the committed catalog assets match the built catalog (sync --check)', { skip: !existsSync(new URL('../../genui-catalog/dist/components', import.meta.url)) }, () => {
  const report = syncLinkpageCatalog({ check: true });
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.drift, []);
});
