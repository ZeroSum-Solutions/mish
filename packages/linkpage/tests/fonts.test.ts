import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fontsFromCss } from '../src/connectors.ts';
import { checkPage, deriveTheme } from '../src/index.ts';

// The contract's own patterns (packages/contracts/src/api/linkpage.ts): the builder must never emit anything they reject.
const FONT_FAMILY = /^[A-Za-z0-9 ._-]{1,80}$/;
const FONT_STACK = /^[A-Za-z0-9 ,"'._-]{1,240}$/;

const WORDPRESS = `:root{--wp--preset--font-size--large: clamp(1.4rem, 2vw, 2rem);--wp--preset--font-size--small: 13px;
--wp--preset--font-family--body: "Söhne", Helvetica, sans-serif;--font-weight-bold: 700;--line-height-base: 1.5;--font-heading: 18px}
body{font-family: Söhne, Arial}`;

test('font scraping skips size, weight and line-height variables and values that are not names', () => {
  const families = fontsFromCss(WORDPRESS).map((f) => f.family);
  assert.ok(!families.some((f) => /clamp|13px|700|1\.5|18px/.test(f)), families.join('|'));
});

test('a non-ASCII or junk font name never reaches the theme in a form the contract rejects', () => {
  for (const family of ['Söhne', 'clamp(1.4rem', '13px', '日本語フォント', 'Mulish"; } body{', 'x'.repeat(200)]) {
    const theme = deriveTheme([{ fonts: [{ family, weight: 9 }] }]);
    for (const f of [theme.fonts.heading, theme.fonts.body]) {
      assert.match(f.family, FONT_FAMILY, family);
      assert.match(f.stack, FONT_STACK, family);
      assert.equal((f.stack.match(/"/g) || []).length % 2, 0, family);
    }
    assert.doesNotThrow(() => checkPage({ slug: 'a', theme, profile: { name: 'x' }, blocks: [] }));
  }
});

test('an accented name is folded to ASCII, not dropped', () => {
  assert.equal(deriveTheme([{ fonts: [{ family: 'Söhne', weight: 3 }] }]).fonts.body.family, 'Sohne');
});
