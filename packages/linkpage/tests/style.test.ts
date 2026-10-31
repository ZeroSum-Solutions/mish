import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EFFECTS, backgroundHtml } from '../src/background.ts';
import { checkPage, deriveTheme, renderPage } from '../src/index.ts';

const GOLDEN = [{ colors: [{ hex: '#bf9b5d', weight: 9 }, { hex: '#fcfbf9', weight: 3 }], fonts: [{ family: 'Cormorant Garamond', weight: 4 }] }];

test('a creator who fixes two colours gets exactly those two, and the site\'s gold is not used', () => {
  const t = deriveTheme(GOLDEN, { palette: { bg: '#f3ece0', text: '#2b170d' } });
  assert.equal(t.palette.bg, '#f3ece0');
  assert.equal(t.palette.text, '#2b170d');
  assert.equal(t.palette.accent, '#2b170d');
  assert.equal(deriveTheme(GOLDEN).palette.accent.toLowerCase() === '#2b170d', false);
});

test('the background follows the mood unless the creator names one', () => {
  assert.equal(deriveTheme(GOLDEN).background, 'glaze');
  assert.equal(deriveTheme([{ fonts: [{ family: 'Poppins', weight: 1 }] }]).background, 'mesh');
  assert.equal(deriveTheme(GOLDEN, { background: 'grid' }).background, 'grid');
});

test('the page draws its background from the theme, ships its own picture, and shows who the person is', () => {
  const spec = checkPage({
    slug: 'a', theme: deriveTheme(GOLDEN, { palette: { bg: '#f3ece0', text: '#2b170d' } }),
    profile: { name: 'Sam', headline: 'Potter and writer', bio: 'Makes things.', avatar_url: 'assets/avatar.png', themes: ['clay', 'writing'] }, blocks: [],
  });
  const html = renderPage(spec, { machine: true });
  assert.match(html, /<canvas id="bg"[^>]*data-effect="glaze"/);
  assert.match(html, /prefers-reduced-motion/);
  assert.match(html, /<img src="assets\/avatar\.png"/);
  assert.match(html, /class="headline">Potter and writer/);
  assert.match(html, /rel="alternate" type="application\/json" href="links\.json"/);
  assert.match(html, /"knowsAbout":\["clay","writing"\]/);
  assert.ok(!html.includes('#bf9b5d'));
  assert.equal(backgroundHtml('nope'), '');
  assert.deepEqual(EFFECTS, ['glaze', 'mesh', 'grid', 'bubbles']);
  assert.throws(() => checkPage({ slug: 'a', theme: spec.theme, profile: { name: 'x', avatar_url: 'assets/../x.png' }, blocks: [] }), /web address/);
});
