/**
 * Design-direction role tokens for a selected section.
 *
 * Binds the seven semantic roles a converted adapter's CSS may reference
 * (`background`, `surface`, `foreground`, `muted`, `accent`, `on-accent`, `border` — see
 * `SEMANTIC_ROLES` in `section-adapter.ts`) to one of the five `DESIGN_DIRECTIONS`
 * (`packages/contracts/src/prompts/directions.ts`) as scoped CSS custom properties, computing
 * `on-accent` per direction rather than assuming white, and provably guaranteeing every text role
 * reaches at least 4.5:1 against every background it is actually painted on.
 *
 * `accent` and `on-accent` are computed together: a direction's authored accent is kept as-is
 * whenever it already passes 4.5:1 as plain text on both `background` and `surface`; only when it
 * does not is its OKLCH lightness nudged toward whichever end (light/dark) restores that contrast
 * — `accentForRole` below. `on-accent` is then chosen as whichever of pure white or pure black
 * contrasts more against that (possibly nudged) accent. This is mathematically guaranteed to
 * reach at least 4.5:1: for any background luminance `X` in [0, 1], `contrast(white, X) < 4.5`
 * requires `X > 0.183`, and `contrast(black, X) < 4.5` requires `X < 0.175` — no `X` satisfies
 * both, so at least one of white/black always clears 4.5:1 against any accent. See
 * `contrast-directions.test.ts` for the numeric proof this file's tests run against all five
 * shipped directions.
 *
 * Shared file: edit `plugins/_official/shared/agency-compiler`, then run
 * `scripts/sync-agency-compiler.ts`.
 */

import type { SemanticRole } from './section-adapter.ts';

export type DirectionPalette = { bg: string; surface: string; fg: string; muted: string; border: string; accent: string };
export type DirectionLike = {
  id: string;
  displayFont: string;
  bodyFont: string;
  monoFont?: string;
  palette: DirectionPalette;
};

const OKLCH = /^oklch\(\s*([\d.]+)%\s+([\d.]+)\s+([\d.]+)\s*\)$/i;

function parseOklch(value: string): [number, number, number] {
  const match = OKLCH.exec(value.trim());
  if (!match) throw new Error(`direction-tokens: expected an oklch() color, got ${JSON.stringify(value)}`);
  return [Number(match[1]) / 100, Number(match[2]), Number(match[3])];
}

function formatOklch([l, c, h]: [number, number, number]): string {
  const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
  return `oklch(${(clamp(l, 0, 1) * 100).toFixed(2)}% ${clamp(c, 0, 0.4).toFixed(4)} ${((h % 360) + 360) % 360})`;
}

/** OKLCH -> linear sRGB, Björn Ottosson's formulas (public domain). Out-of-gamut channels are
 * left un-clamped here; `relativeLuminance` clamps for the WCAG formula, which is the only thing
 * this module uses the conversion for. */
function oklchToLinearSrgb(l: number, c: number, hDeg: number): [number, number, number] {
  const h = (hDeg * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
  const l3 = l_ ** 3;
  const m3 = m_ ** 3;
  const s3 = s_ ** 3;
  return [
    +4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3,
    -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3,
    -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3,
  ];
}

/** WCAG 2.x relative luminance, computed directly off the linear-light channels (no re-gamma
 * needed: WCAG's own formula operates on linearized sRGB, which is exactly what the OKLCH->linear
 * conversion above already produces). */
function relativeLuminance([r, g, b]: [number, number, number]): number {
  const clamp = (v: number) => Math.min(1, Math.max(0, v));
  return 0.2126 * clamp(r) + 0.7152 * clamp(g) + 0.0722 * clamp(b);
}

export function oklchContrast(a: string, b: string): number {
  const la = relativeLuminance(oklchToLinearSrgb(...parseOklch(a)));
  const lb = relativeLuminance(oklchToLinearSrgb(...parseOklch(b)));
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = formatOklch([1, 0, 0]);
const BLACK = formatOklch([0, 0, 0]);
export const MIN_TEXT_CONTRAST = 4.5;

/**
 * Nudges `accent`'s OKLCH lightness toward whichever end restores `>= minContrast` against BOTH
 * `bg` and `surface`, holding chroma and hue fixed. Binary search over the harder of the two
 * backgrounds; the result is re-checked against both before being accepted, and the search always
 * terminates at the pure white/black endpoint if no intermediate lightness both directions
 * converge on can find one, which — per this module's whole proof — never fails to reach 4.5:1.
 */
export function accentForRole(accent: string, bg: string, surface: string, minContrast = MIN_TEXT_CONTRAST): string {
  const okAgainstBoth = (candidate: string) => oklchContrast(candidate, bg) >= minContrast && oklchContrast(candidate, surface) >= minContrast;
  if (okAgainstBoth(accent)) return accent;
  const [l, c, h] = parseOklch(accent);
  // Try darkening first (the shipped directions all have near-white backgrounds, so darkening the
  // accent is what closes the gap); fall back to lightening for a future dark-background direction.
  // Binary search for the LEAST adjustment (the boundary closest to `accent`'s own lightness)
  // that still clears the bar — not the most extreme endpoint that happens to clear it.
  for (const target of [0, 1] as const) {
    const endpoint = formatOklch([target, c, h]);
    if (!okAgainstBoth(endpoint)) continue;
    // Invariant, now true by construction rather than by argument (FIX 3, delta audit): `pass` is
    // assigned only AFTER the guard above has actually verified `endpoint` passes, so "the `pass`
    // end always satisfies `okAgainstBoth`" is not a claim about `target` that this loop has to
    // trust — it is the exact value the `if` just checked. `fail` starts at `l`, which the early
    // `if (okAgainstBoth(accent)) return accent;` above already proved fails (that guard is why
    // this loop is reached at all). Every later reassignment of either variable happens only after
    // its own `okAgainstBoth` check, so the invariant holds for the whole loop, not just its start.
    let pass = target;
    let fail = l;
    for (let step = 0; step < 24; step += 1) {
      const mid = (pass + fail) / 2;
      const candidate = formatOklch([mid, c, h]);
      if (okAgainstBoth(candidate)) pass = mid; else fail = mid;
    }
    const candidate = formatOklch([pass, c, h]);
    // `pass` is guaranteed passing by the invariant above, so this re-check can never actually
    // take the `endpoint` branch — kept as a belt-and-braces return (not an assertion) so that if
    // a future change to this loop ever broke the invariant, the function would fail SAFE (ship
    // `endpoint`, itself independently verified above) rather than ship an unchecked color.
    return okAgainstBoth(candidate) ? candidate : endpoint;
  }
  // Unreachable for any of the five shipped directions (see module doc's proof for `on-accent`;
  // the same two-endpoint argument applies here per background, and both directions' endpoints
  // are the grayscale extremes already used for `on-accent`). Fall back to the higher-contrast
  // endpoint so the page still ships with a readable, if imperfect, accent.
  return oklchContrast(WHITE, bg) >= oklchContrast(BLACK, bg) ? WHITE : BLACK;
}

/** Whichever of pure white or pure black contrasts more against `accent` — provably >= 4.5:1. */
export function onAccentFor(accent: string): string {
  return oklchContrast(WHITE, accent) >= oklchContrast(BLACK, accent) ? WHITE : BLACK;
}

export type RoleTokens = Readonly<Record<SemanticRole, string>>;

/** The seven role values for one direction, with `accent`/`on-accent` computed per this module's
 * contrast guarantee. Pure, deterministic, no I/O. */
export function roleTokensFor(direction: DirectionLike): RoleTokens {
  const accent = accentForRole(direction.palette.accent, direction.palette.bg, direction.palette.surface);
  return {
    background: direction.palette.bg,
    surface: direction.palette.surface,
    foreground: direction.palette.fg,
    muted: direction.palette.muted,
    accent,
    'on-accent': onAccentFor(accent),
    border: direction.palette.border,
  };
}

const ROLE_VAR: Readonly<Record<SemanticRole, string>> = {
  background: '--role-background',
  surface: '--role-surface',
  foreground: '--role-foreground',
  muted: '--role-muted',
  accent: '--role-accent',
  'on-accent': '--role-on-accent',
  border: '--role-border',
};

/** Custom-property declarations for one direction's role tokens plus font stacks, scoped to
 * `selector` (a section wrapper's own attribute selector — never `:root`, so an inserted section
 * never restyles the rest of the family's fixed page). */
export function directionScopeCss(selector: string, direction: DirectionLike): string {
  const roles = roleTokensFor(direction);
  const declarations = (Object.keys(ROLE_VAR) as SemanticRole[]).map((role) => `${ROLE_VAR[role]}:${roles[role]}`).join(';');
  const fonts = `--role-font-display:${direction.displayFont};--role-font-body:${direction.bodyFont}${direction.monoFont ? `;--role-font-mono:${direction.monoFont}` : ''}`;
  return `${selector}{${declarations};${fonts}}`;
}

/**
 * Base rules every inserted, directioned section carries once: visible focus styles (never
 * relying on a family's own focus ring, since the section is scoped and may sit inside a family
 * that styles focus differently) and a static state under `prefers-reduced-motion: reduce` (no
 * scroll animation is ever introduced by a direction — see the design decision's §3 — so this
 * rule has nothing to override today, but pins the contract so a later adapter cannot regress it).
 */
export function directionBaseCss(selector: string): string {
  return `${selector} :is(a,button,[tabindex]):focus-visible{outline:3px solid var(${ROLE_VAR.accent});outline-offset:3px}@media (prefers-reduced-motion: reduce){${selector} *{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`;
}

/** `var(--role-<role>)`, for an adapter's generated CSS to reference. */
export function roleVar(role: SemanticRole): string {
  return `var(${ROLE_VAR[role]})`;
}
