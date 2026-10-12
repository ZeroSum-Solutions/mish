/**
 * Direction tokens (`plugins/_official/shared/agency-compiler/scripts/direction-tokens.ts`):
 * every role's text usage must clear WCAG 4.5:1 against every background it is actually painted
 * on, for all five shipped `DESIGN_DIRECTIONS` — design decision §3
 * (<private-notes>/mishh-genui-production/motionsites/sol-design.md).
 * Loaded by path (not a workspace import) for the same reason `section-overlay.ts` loads it that
 * way — see that file's module boundary note.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sharedCompilerDir = path.resolve(import.meta.dirname, '../../../plugins/_official/shared/agency-compiler/scripts');
const directionsFile = path.resolve(import.meta.dirname, '../../contracts/src/prompts/directions.ts');
const importFrom = (file: string) => import(pathToFileURL(file).href);

const { accentForRole, oklchContrast, roleTokensFor, MIN_TEXT_CONTRAST } = await importFrom(path.join(sharedCompilerDir, 'direction-tokens.ts'));
const { DESIGN_DIRECTIONS } = await importFrom(directionsFile);

type Direction = { id: string; palette: { bg: string; surface: string; fg: string; muted: string; border: string; accent: string } };

test('every direction: at least 4.5:1 for normal text, muted text and links, on both backgrounds', () => {
  for (const direction of DESIGN_DIRECTIONS as Direction[]) {
    const roles = roleTokensFor(direction);
    for (const background of [roles.background, roles.surface]) {
      const normal = oklchContrast(roles.foreground, background);
      const muted = oklchContrast(roles.muted, background);
      const link = oklchContrast(roles.accent, background);
      assert.ok(normal >= MIN_TEXT_CONTRAST, `${direction.id}: foreground vs background is ${normal.toFixed(2)}`);
      assert.ok(muted >= MIN_TEXT_CONTRAST, `${direction.id}: muted vs background is ${muted.toFixed(2)}`);
      assert.ok(link >= MIN_TEXT_CONTRAST, `${direction.id}: accent (link) vs background is ${link.toFixed(2)}`);
    }
  }
});

test('every direction: at least 4.5:1 for button text (on-accent) on the accent background', () => {
  for (const direction of DESIGN_DIRECTIONS as Direction[]) {
    const roles = roleTokensFor(direction);
    const button = oklchContrast(roles['on-accent'], roles.accent);
    assert.ok(button >= MIN_TEXT_CONTRAST, `${direction.id}: on-accent vs accent is ${button.toFixed(2)}`);
  }
});

test('on-accent is always one of pure black or pure white (grayscale, chroma 0)', () => {
  // NIT 10 (delta audit): parses the actual numbers out of the oklch() string and checks them,
  // rather than matching a hardcoded formatted string — decoupled from `formatOklch`'s exact
  // digit count/spacing, which the previous fixed-string regex was brittle against.
  const OKLCH = /^oklch\(([\d.]+)% ([\d.]+) ([\d.]+)\)$/;
  for (const direction of DESIGN_DIRECTIONS as Direction[]) {
    const roles = roleTokensFor(direction);
    const match = OKLCH.exec(roles['on-accent']);
    assert.ok(match, `${direction.id}: on-accent was not a recognizable oklch() string: ${roles['on-accent']}`);
    const lightness = Number(match![1]);
    const chroma = Number(match![2]);
    assert.ok(lightness === 0 || lightness === 100, `${direction.id}: on-accent lightness must be 0 or 100, got ${lightness}`);
    assert.equal(chroma, 0, `${direction.id}: on-accent chroma must be 0, got ${chroma}`);
  }
});

// FIX 3 (delta audit): `accentForRole`'s binary search must never return a color that fails
// 4.5:1 against either background, exercised at the boundary rather than only through the five
// shipped directions.
const OKLCH_LIGHTNESS = /^oklch\(([\d.]+)%/;
function lightnessOf(oklch: string): number {
  const match = OKLCH_LIGHTNESS.exec(oklch);
  if (!match) throw new Error(`not a recognizable oklch() string: ${oklch}`);
  return Number(match[1]);
}

/** How far above `MIN_TEXT_CONTRAST` a MINIMAL nudge may land — the 24-step bisection in
 * `accentForRole` converges far tighter than this; a value this loose only rules out a
 * wrong-direction or over-corrected jump straight to a grayscale extreme (contrast well into the
 * teens/twenties), not the search's own normal precision. */
const MINIMALITY_EPSILON = 0.15;

test('accentForRole: never returns a color that fails 4.5:1 against either background, and darkens minimally (near-white boundary)', () => {
  const bg = 'oklch(98.00% 0.0000 0)';
  const surface = 'oklch(96.00% 0.0000 0)';
  const accent = 'oklch(70.00% 0.1500 250)';
  assert.ok(oklchContrast(accent, bg) < MIN_TEXT_CONTRAST, 'fixture assumption: the raw accent must fail as plain text on the near-white background');
  const nudged = accentForRole(accent, bg, surface);
  assert.ok(oklchContrast(nudged, bg) >= MIN_TEXT_CONTRAST, `nudged accent vs bg was ${oklchContrast(nudged, bg).toFixed(2)}`);
  assert.ok(oklchContrast(nudged, surface) >= MIN_TEXT_CONTRAST, `nudged accent vs surface was ${oklchContrast(nudged, surface).toFixed(2)}`);
  // Delta re-audit (tests packet #6): minimality, not just "some change happened" — darkening
  // means lightness decreased, and the binding contrast should sit just above the bar, not be
  // over-corrected all the way to black.
  assert.ok(lightnessOf(nudged) < lightnessOf(accent), `expected lightness to decrease (darken), was ${lightnessOf(accent)} -> ${lightnessOf(nudged)}`);
  const minContrast = Math.min(oklchContrast(nudged, bg), oklchContrast(nudged, surface));
  assert.ok(minContrast < MIN_TEXT_CONTRAST + MINIMALITY_EPSILON, `expected a near-minimal nudge (binding contrast ${minContrast.toFixed(3)}), not an over-correction`);
});

test('accentForRole: never returns a color that fails 4.5:1 against either background, and lightens minimally (near-black boundary)', () => {
  const bg = 'oklch(12.00% 0.0000 0)';
  const surface = 'oklch(16.00% 0.0000 0)';
  const accent = 'oklch(30.00% 0.1500 250)';
  assert.ok(oklchContrast(accent, bg) < MIN_TEXT_CONTRAST, 'fixture assumption: the raw accent must fail as plain text on the near-black background');
  const nudged = accentForRole(accent, bg, surface);
  assert.ok(oklchContrast(nudged, bg) >= MIN_TEXT_CONTRAST, `nudged accent vs bg was ${oklchContrast(nudged, bg).toFixed(2)}`);
  assert.ok(oklchContrast(nudged, surface) >= MIN_TEXT_CONTRAST, `nudged accent vs surface was ${oklchContrast(nudged, surface).toFixed(2)}`);
  // Delta re-audit (tests packet #6): `notEqual` alone is satisfied by ANY change, including a
  // wrong-direction one that happens to still clear the bar. Assert the actual direction
  // (lightness increased — the search must take the lightening branch, since darkening a dark
  // accent on a dark background cannot help) AND minimality (binding contrast near the bar).
  assert.ok(lightnessOf(nudged) > lightnessOf(accent), `expected lightness to increase (lighten), was ${lightnessOf(accent)} -> ${lightnessOf(nudged)}`);
  const minContrast = Math.min(oklchContrast(nudged, bg), oklchContrast(nudged, surface));
  assert.ok(minContrast < MIN_TEXT_CONTRAST + MINIMALITY_EPSILON, `expected a near-minimal nudge (binding contrast ${minContrast.toFixed(3)}), not an over-correction`);
});

test('roleTokensFor keeps a direction\'s accent unchanged when it already clears the bar (editorial-monocle)', () => {
  const direction = (DESIGN_DIRECTIONS as Direction[]).find((d) => d.id === 'editorial-monocle')!;
  const roles = roleTokensFor(direction);
  assert.equal(roles.accent, direction.palette.accent, 'no lightness nudge was needed for this direction');
});

test('roleTokensFor nudges an accent that fails as plain text, minimally (tech-utility)', () => {
  const direction = (DESIGN_DIRECTIONS as Direction[]).find((d) => d.id === 'tech-utility')!;
  assert.ok(oklchContrast(direction.palette.accent, direction.palette.bg) < MIN_TEXT_CONTRAST, 'fixture assumption: the raw accent must fail as plain text on this direction');
  const roles = roleTokensFor(direction);
  assert.notEqual(roles.accent, direction.palette.accent);
  assert.ok(oklchContrast(roles.accent, direction.palette.bg) >= MIN_TEXT_CONTRAST);
  assert.ok(oklchContrast(roles.accent, direction.palette.surface) >= MIN_TEXT_CONTRAST);
});

test('roleTokensFor: accent (and its computed on-accent) are the only roles that may differ from the palette', () => {
  // Delta re-audit (tests packet #7): the prior version of this test named five fields by hand.
  // Passing it proved those five specific fields matched, but did not enforce the CONTRACT that
  // accent is the ONLY role allowed to move — a future change that nudged e.g. `muted` would only
  // be caught here if someone remembered to add `muted` to the hand-picked list. Iterating every
  // key `roleTokensFor` actually emits (and every key the palette actually offers) makes the
  // "accent only" rule structural rather than a list someone has to keep in sync by hand.
  const MAY_DIFFER = new Set(['accent', 'on-accent']);
  for (const direction of DESIGN_DIRECTIONS as Direction[]) {
    const roles = roleTokensFor(direction) as Record<string, string>;
    const palette: Record<string, string> = {
      background: direction.palette.bg,
      surface: direction.palette.surface,
      foreground: direction.palette.fg,
      muted: direction.palette.muted,
      border: direction.palette.border,
    };
    for (const role of Object.keys(roles)) {
      if (MAY_DIFFER.has(role)) continue;
      assert.ok(role in palette, `${direction.id}: role "${role}" has no palette mapping in this test — update it, not accentForRole`);
      assert.equal(roles[role], palette[role], `${direction.id}: role "${role}" must pass through unchanged from the palette (only accent may be nudged)`);
    }
    for (const role of Object.keys(palette)) {
      assert.ok(role in roles, `${direction.id}: expected roleTokensFor to emit a "${role}" role`);
    }
  }
});

test('directionScopeCss/directionBaseCss: visible focus styles, static under prefers-reduced-motion, scoped (never :root)', async () => {
  const { directionScopeCss, directionBaseCss } = await importFrom(path.join(sharedCompilerDir, 'direction-tokens.ts'));
  const direction = (DESIGN_DIRECTIONS as Direction[])[0]!;
  const selector = '[data-od-section="od-selected-x"]';
  const scope = directionScopeCss(selector, direction);
  const base = directionBaseCss(selector);
  assert.ok(scope.startsWith(selector), 'role tokens must be scoped to the section selector, never :root');
  assert.equal(scope.includes(':root'), false);
  assert.ok(base.includes(':focus-visible'), 'a visible focus style must be present');
  assert.ok(base.includes('outline'));
  assert.ok(base.includes('prefers-reduced-motion: reduce'));
  assert.ok(base.includes('animation:none') || base.includes('animation: none'));
  assert.ok(base.startsWith(selector), 'the reduced-motion guard must be scoped to the inserted section too');
});
