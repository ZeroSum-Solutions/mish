/**
 * A design kit's `tokens.css` as a composed page's direction (`src/kit-direction.ts`): only
 * top-level `:root` declarations count, `var()` resolves with a bound, colours convert to the
 * OKLCH shape the direction contrast code parses, muted text stays readable, and a kit whose
 * tokens cannot style the page is refused with a fixed code instead of half-applied.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { contrast, kitDirection, KitDirectionError, parseColor, readRootCustomProperties, resolveVars, toOklch } from '../src/kit-direction.ts';
import { roleTokensFor } from '../src/section-overlay.ts';

const KIT = { id: 'user:atlas-test', title: 'Atlas test' };
const OKLCH_SHAPE = /^oklch\(\d+\.\d{2}% \d\.\d{4} \d+\.\d{2}\)$/u;

test('reads only top-level :root declarations; at-rules and other selectors are skipped', () => {
  const props = readRootCustomProperties(`
    /* --bg: #ff0000; in a comment */
    :root { --bg: #ffffff; --fg: #111111 !important; }
    @media (prefers-color-scheme: dark) { :root { --bg: #000000; } }
    .well { --bg: #533429; }
    html, body { --accent: #eb461f; }
  `);
  assert.equal(props.get('--bg'), '#ffffff');
  assert.equal(props.get('--fg'), '#111111');
  assert.equal(props.get('--accent'), '#eb461f');
});

test('resolves var() chains and fallbacks, and stops on a cycle', () => {
  const props = new Map([['--a', 'var(--b)'], ['--b', '#123456'], ['--loop', 'var(--loop)']]);
  assert.equal(resolveVars('var(--a)', props), '#123456');
  assert.equal(resolveVars('var(--missing, #abcdef)', props), '#abcdef');
  assert.equal(resolveVars('var(--loop)', props, new Set(['--loop'])), undefined);
});

test('parses hex, rgb(), hsl(), oklch() and color-mix(in srgb) to the same colour', () => {
  const red = parseColor('#ff0000')!;
  for (const value of ['#f00', 'rgb(255, 0, 0)', 'rgb(255 0 0 / 1)', 'hsl(0 100% 50%)', 'color-mix(in srgb, #ff0000 100%, #0000ff)']) {
    const parsed = parseColor(value)!;
    assert.ok(parsed, value);
    assert.ok(Math.abs(parsed.r - red.r) < 1e-6 && parsed.g < 1e-6 && parsed.b < 1e-6, value);
  }
  const fromOklch = parseColor(toOklch(red))!;
  assert.ok(Math.abs(fromOklch.r - 1) < 0.01 && fromOklch.g < 0.01 && fromOklch.b < 0.01);
  assert.equal(parseColor('color-mix(in oklch, red, blue)'), undefined);
  assert.equal(parseColor('url(x)'), undefined);
});

test('a schema kit becomes an OKLCH direction the composed page can use', async () => {
  const direction = kitDirection(`:root {
    --ink: #171d1d;
    --bg: #edf0ed; --surface: #f6f7f6; --fg: var(--ink); --muted: #4a5050;
    --border: rgba(23, 29, 29, .10); --accent: #eb461f;
    --font-display: "Newsreader", Georgia, serif; --font-body: "Instrument Sans", Arial, sans-serif; --font-mono: "Space Mono", monospace;
  }`, KIT);
  assert.equal(direction.id, 'kit:user:atlas-test');
  assert.equal(direction.label, 'Atlas test');
  assert.equal(direction.displayFont, '"Newsreader", Georgia, serif');
  assert.equal(direction.bodyFont, '"Instrument Sans", Arial, sans-serif');
  assert.equal(direction.monoFont, '"Space Mono", monospace');
  for (const value of Object.values(direction.palette)) assert.match(value, OKLCH_SHAPE);
  // The overlay's own contrast code accepts the kit's palette as-is.
  const roles = await roleTokensFor(direction);
  assert.match(roles.accent, OKLCH_SHAPE);
});

test('muted that is really a hairline colour is replaced by readable text', () => {
  const direction = kitDirection(':root { --bg: #edf0ed; --fg: #171d1d; --accent: #eb461f; --muted: #c9cac9; }', KIT);
  const muted = parseColor(direction.palette.muted)!;
  assert.ok(contrast(muted, parseColor(direction.palette.bg)!) >= 4.5);
});

test('optional roles fall back; a missing or unparseable required role refuses the kit', () => {
  const direction = kitDirection(':root { --bg: #ffffff; --fg: #000000; --accent: #0055ff; --surface: color-mix(in lab, red, blue); }', KIT);
  assert.equal(direction.palette.surface, direction.palette.bg);
  assert.equal(direction.bodyFont, 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif');
  assert.equal(direction.displayFont, direction.bodyFont);
  assert.throws(() => kitDirection(':root { --color-canvas-white: #fbf8f6; }', KIT), (error: unknown) => error instanceof KitDirectionError && error.code === 'missing-token' && error.token === '--bg');
  assert.throws(() => kitDirection(':root { --bg: #fff; --fg: url(x); --accent: #000; }', KIT), (error: unknown) => error instanceof KitDirectionError && error.code === 'unsupported-color' && error.token === '--fg');
});

test('a font stack that could break out of the style element is refused', () => {
  for (const font of ['"A" <b>', 'x</style><script>', 'url(evil.woff)', 'A\\9 B']) {
    assert.throws(
      () => kitDirection(`:root { --bg: #fff; --fg: #000; --accent: #00f; --font-body: ${font}; }`, KIT),
      (error: unknown) => error instanceof KitDirectionError && error.code === 'unsafe-font',
      font,
    );
  }
});

// Sol review (2026-10-10) reproductions: each must refuse up front or style the page correctly.

test('an inherited name or an overflowing color-mix is not a colour, so the kit is refused up front', () => {
  for (const bg of ['constructor', 'toString', 'color-mix(in srgb, #fff 150%, #000 20%)']) {
    assert.equal(parseColor(bg), undefined, bg);
    assert.throws(() => kitDirection(`:root { --bg: ${bg}; --fg: #000; --accent: #00f; }`, KIT), (error: unknown) => error instanceof KitDirectionError && error.code === 'unsupported-color', bg);
  }
  const direction = kitDirection(':root { --bg: #fff; --fg: #000; --accent: #00f; --surface: constructor; }', KIT);
  for (const value of Object.values(direction.palette)) assert.match(value, OKLCH_SHAPE);
});

test('a ; inside a quoted font name neither truncates the stack nor leaves a string open', () => {
  assert.throws(
    () => kitDirection(':root { --bg: #fff; --fg: #000; --accent: #00f; --font-display: serif; --font-body: "A;B", Arial, sans-serif; }', KIT),
    (error: unknown) => error instanceof KitDirectionError && error.code === 'unsafe-font' && error.token === '--font-body',
  );
  for (const font of ['"A" "B"', 'Arial,', '"A",,B']) {
    assert.throws(() => kitDirection(`:root { --bg: #fff; --fg: #000; --accent: #00f; --font-body: ${font}; }`, KIT), (error: unknown) => error instanceof KitDirectionError && error.code === 'unsafe-font', font);
  }
  // An unterminated string runs to the end of the sheet, as in a browser: the rule never closes,
  // so no colour role survives and the kit is refused rather than half-applied.
  assert.throws(() => kitDirection(':root { --bg: #fff; --fg: #000; --accent: #00f; --font-body: "A; }', KIT), KitDirectionError);
  const ok = kitDirection(':root { --bg: #fff; --fg: #000; --accent: #00f; --font-body: "Instrument Sans", -apple-system, ui-monospace, \'SF Mono\', sans-serif; }', KIT);
  assert.equal(ok.bodyFont, '"Instrument Sans", -apple-system, ui-monospace, \'SF Mono\', sans-serif');
});

test('color-mix weights below 100% multiply the alpha, as CSS does', () => {
  const mixed = parseColor('color-mix(in srgb, #fff 20%, #000 20%)')!;
  assert.ok(Math.abs(mixed.a - 0.4) < 1e-9);
  assert.ok(Math.abs(mixed.r - 0.5) < 1e-9);
  // Painted on white it is the light grey a browser shows, not 50% grey.
  const direction = kitDirection(':root { --bg: color-mix(in srgb, #fff 20%, #000 20%); --fg: #000; --accent: #00f; }', KIT);
  const bg = parseColor(direction.palette.bg)!;
  assert.ok(Math.abs(bg.r - 0.8) < 0.01, `background ${direction.palette.bg}`);
});

test('statement at-rules before :root do not hide its tokens, and nothing is imported', () => {
  for (const prefix of ['@charset "UTF-8";', '@import "fonts.css";', '@import url("https://x.test/a.css");', '@layer reset, tokens;']) {
    const props = readRootCustomProperties(`${prefix}\n:root { --bg: #fff; --fg: #000; --accent: #00f; }`);
    assert.equal(props.get('--bg'), '#fff', prefix);
  }
  assert.equal(readRootCustomProperties(':root { --font-body: "A}B"; --bg: #fff; }').get('--bg'), '#fff');
});

test('!important wins over a later normal declaration; the later one wins within a priority', () => {
  const props = readRootCustomProperties(':root { --bg: #fff !important; --fg: #000; } :root { --bg: #000; --fg: #111; } :root { --fg: #222 ! important; } :root { --fg: #333 !IMPORTANT; }');
  assert.equal(props.get('--bg'), '#fff');
  assert.equal(props.get('--fg'), '#333');
});

// Sol re-check (2026-10-10) reproductions.

test('a color-mix argument broken across lines never throws: an optional role falls back, a required one refuses', () => {
  const css = ':root { --bg: #fff; --fg: #000; --accent: #00f; --surface: color-mix(in srgb, rgb(255\n 255 255) 20%, #000 20%); }';
  assert.doesNotThrow(() => kitDirection(css, KIT));
  assert.ok(parseColor('color-mix(in srgb, rgb(255\n 255 255) 20%, #000 20%)'));
  assert.equal(parseColor('color-mix(in srgb, rgb(255\n 255 255 20%, #000 20%)'), undefined);
});

test('CSS escapes outside strings are not quotes, brackets or parentheses', () => {
  const props = readRootCustomProperties(".foo\\'bar { color: red; } :root { --unused: \\(; --bg: #fff; --fg: #000; --accent: #00f; } .x\\{ { a: b; }");
  assert.equal(props.get('--bg'), '#fff');
  assert.equal(props.get('--accent'), '#00f');
});

test('quoted family names may hold a comma or the other kind of quote', () => {
  for (const stack of ['"Acme, Inc", Arial, sans-serif', '"Rock\'n\'Roll", sans-serif', '\'Say "Hi"\', serif']) {
    assert.equal(kitDirection(`:root { --bg: #fff; --fg: #000; --accent: #00f; --font-body: ${stack}; }`, KIT).bodyFont, stack, stack);
  }
});
