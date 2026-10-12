/* ─────────────────────────────────────────────────────────────────────────
 * scripts/lib/design-system-promotion/tokens.ts
 *
 * Token-mode parsing and WCAG contrast math for the promotion gate.
 * Pure functions: callers pass file text in and get data back.
 *
 * Mode contract (documented in docs/design-systems/QUALITY-STANDARD.md):
 *   light = the first unscoped `:root { ... }` block
 *   dark  = `:root[data-theme="dark"] { ... }` AND, inside
 *           `@media (prefers-color-scheme: dark)`,
 *           `:root:not([data-theme="light"]) { ... }`.
 *   Both dark blocks must declare the same tokens with the same values.
 * ─────────────────────────────────────────────────────────────────── */

export type TokenMap = ReadonlyMap<string, string>;

export type TokenModes = {
  readonly light: TokenMap | null;
  readonly darkExplicit: TokenMap | null;
  readonly darkMedia: TokenMap | null;
  readonly reducedMotion: TokenMap | null;
};

export type Rgba = { readonly r: number; readonly g: number; readonly b: number; readonly a: number };

export function stripCssComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, "");
}

/** Parse `--name: value;` declarations from a block body. Non-token declarations are ignored. */
export function parseDeclarations(body: string): Map<string, string> {
  const declarations = new Map<string, string>();
  for (const raw of body.split(";")) {
    const declaration = raw.trim();
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim();
    if (!name.startsWith("--")) continue;
    declarations.set(name, declaration.slice(colon + 1).trim().replace(/\s+/g, " "));
  }
  return declarations;
}

type CssBlock = { readonly selector: string; readonly body: string };

/**
 * Parse the depth-0 rule blocks of a css string: for each, the raw text
 * between the previous top-level `}` (or the start of the string) and its
 * own `{` (the "selector", which for an at-rule is its prelude, e.g.
 * `@media (prefers-color-scheme: dark)`), and the body between its matching
 * braces. Nested rules (inside `@media`, etc.) are not descended into; call
 * this again on a block's `body` to read one level deeper.
 */
function topLevelBlocks(css: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  let depth = 0;
  let selector = "";
  let selectorStart = 0;
  let bodyStart = -1;
  for (let index = 0; index < css.length; index += 1) {
    const char = css[index];
    if (char === "{") {
      if (depth === 0) {
        selector = css.slice(selectorStart, index).trim();
        bodyStart = index + 1;
      }
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0 && bodyStart !== -1) {
        blocks.push({ selector, body: css.slice(bodyStart, index) });
        selectorStart = index + 1;
        bodyStart = -1;
      }
    } else if (char === ";" && depth === 0) {
      // A depth-0 `;` ends a statement at-rule with no block, e.g.
      // `@charset "UTF-8";` or `@import url(...);`. Without this, its text
      // glues onto the next rule's selector (`@charset "UTF-8";\n:root` is
      // not `:root`) and breaks exact selector matching below.
      selectorStart = index + 1;
    }
  }
  return blocks;
}

/** Split a selector list on commas that are not inside `[...]` or `(...)`. */
function splitSelectorList(selector: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < selector.length; index += 1) {
    const char = selector[index];
    if (char === "[" || char === "(") depth += 1;
    if (char === "]" || char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      items.push(selector.slice(start, index).trim());
      start = index + 1;
    }
  }
  items.push(selector.slice(start).trim());
  return items.filter((item) => item.length > 0);
}

/**
 * Bodies of every depth-0 block whose selector list contains `target` as a
 * complete item (whitespace-trimmed). A selector list that merely mentions
 * `target` as part of a longer compound or descendant selector does not
 * count — the root selector must be one full item of the list.
 */
function matchingBodies(blocks: readonly CssBlock[], target: RegExp): string[] {
  return blocks.filter((block) => splitSelectorList(block.selector).some((item) => target.test(item))).map((block) => block.body);
}

/** Merge declaration blocks in cascade order: a later block's tokens win. */
function mergeDeclarations(bodies: readonly string[]): Map<string, string> {
  const merged = new Map<string, string>();
  for (const body of bodies) {
    for (const [name, value] of parseDeclarations(body)) merged.set(name, value);
  }
  return merged;
}

const LIGHT_ROOT = /^:root$/;
const DARK_EXPLICIT_ROOT = /^:root\[data-theme=["']dark["']\]$/;
const DARK_MEDIA_ROOT = /^:root:not\(\[data-theme=["']light["']\]\)$/;
const DARK_MEDIA_QUERY = /^@media\s*\(\s*prefers-color-scheme\s*:\s*dark\s*\)$/;
const REDUCED_MOTION_QUERY = /^@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)$/;

export function parseTokenModes(tokensCss: string): TokenModes {
  const css = stripCssComments(tokensCss);
  const blocks = topLevelBlocks(css);

  const lightBodies = matchingBodies(blocks, LIGHT_ROOT);
  const darkExplicitBodies = matchingBodies(blocks, DARK_EXPLICIT_ROOT);

  // Merge every matching `@media (prefers-color-scheme: dark)` block, not
  // just the first: a later duplicate media block must be able to override
  // an earlier one, the same as a later duplicate :root block does above.
  const darkMediaBlocks = blocks.filter((block) => DARK_MEDIA_QUERY.test(block.selector));
  const darkMediaBodies = darkMediaBlocks.flatMap((block) => matchingBodies(topLevelBlocks(block.body), DARK_MEDIA_ROOT));

  const reducedMotionBlock = blocks.find((block) => REDUCED_MOTION_QUERY.test(block.selector));
  const reducedBody = reducedMotionBlock == null ? null : topLevelBlocks(reducedMotionBlock.body)[0]?.body ?? null;

  return {
    light: lightBodies.length === 0 ? null : mergeDeclarations(lightBodies),
    darkExplicit: darkExplicitBodies.length === 0 ? null : mergeDeclarations(darkExplicitBodies),
    darkMedia: darkMediaBodies.length === 0 ? null : mergeDeclarations(darkMediaBodies),
    reducedMotion: reducedBody == null ? null : parseDeclarations(reducedBody),
  };
}

/** Every custom property name declared anywhere in the stylesheet. */
export function allDeclaredTokenNames(tokensCss: string): Set<string> {
  const names = new Set<string>();
  for (const match of stripCssComments(tokensCss).matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)) names.add(match[1]!);
  return names;
}

export function overlay(base: TokenMap, top: TokenMap): Map<string, string> {
  return new Map([...base, ...top]);
}

/** Replace every `var(--x)` with the resolved value of `--x`, recursively. */
export function resolveValue(value: string, tokens: TokenMap, depth = 0): string | null {
  if (depth > 12) return null;
  let unresolved = false;
  const replaced = value.replace(/var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,[^)]*)?\)/g, (_match, name: string) => {
    const next = tokens.get(name);
    if (next === undefined) {
      unresolved = true;
      return "";
    }
    const resolved = resolveValue(next, tokens, depth + 1);
    if (resolved == null) {
      unresolved = true;
      return "";
    }
    return resolved;
  });
  return unresolved ? null : replaced;
}

const COLOR_PATTERN = /#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g;

export function findColors(value: string): string[] {
  return [...value.matchAll(COLOR_PATTERN)].map((match) => match[0]);
}

export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,8})$/.exec(value)?.[1];
  if (hex !== undefined) {
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a = "f"] = hex.split("");
      return { r: parseInt(r! + r!, 16), g: parseInt(g! + g!, 16), b: parseInt(b! + b!, 16), a: parseInt(a + a, 16) / 255 };
    }
    if (hex.length === 6 || hex.length === 8) {
      return {
        r: parseInt(hex.slice(0, 2), 16),
        g: parseInt(hex.slice(2, 4), 16),
        b: parseInt(hex.slice(4, 6), 16),
        a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1,
      };
    }
    return null;
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value)?.[1];
  if (rgb === undefined) return null;
  const parts = rgb.split(/[\s,/]+/).filter((part) => part.length > 0);
  if (parts.length < 3 || parts.length > 4) return null;
  const clamp = (num: number, min: number, max: number): number => Math.min(max, Math.max(min, num));
  const channel = (part: string): number => clamp(part.endsWith("%") ? (parseFloat(part) / 100) * 255 : parseFloat(part), 0, 255);
  const rawAlpha = parts[3] === undefined ? 1 : parts[3].endsWith("%") ? parseFloat(parts[3]) / 100 : parseFloat(parts[3]);
  const color = { r: channel(parts[0]!), g: channel(parts[1]!), b: channel(parts[2]!), a: clamp(rawAlpha, 0, 1) };
  return Object.values(color).some((part) => Number.isNaN(part)) ? null : color;
}

export function composite(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number): number => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function relativeLuminance(color: Rgba): number {
  const linear = (channel: number): number => {
    const c = channel / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(color.r) + 0.7152 * linear(color.g) + 0.0722 * linear(color.b);
}

/** WCAG 2.x contrast ratio. Translucent colors are composited over `base` (then white). */
export function contrastRatio(fg: Rgba, bg: Rgba, base: Rgba = { r: 255, g: 255, b: 255, a: 1 }): number {
  const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  const opaqueBase = base.a < 1 ? composite(base, white) : base;
  const opaqueBg = bg.a < 1 ? composite(bg, opaqueBase) : bg;
  const opaqueFg = fg.a < 1 ? composite(fg, opaqueBg) : fg;
  const [light, dark] = [relativeLuminance(opaqueFg), relativeLuminance(opaqueBg)].sort((x, y) => y - x);
  return (light! + 0.05) / (dark! + 0.05);
}

/** Resolve a token to one opaque-or-translucent color, or explain why not. */
export function resolveTokenColor(name: string, tokens: TokenMap): Rgba | string {
  const raw = tokens.get(name);
  if (raw === undefined) return `${name} is not declared`;
  const resolved = resolveValue(raw, tokens);
  if (resolved == null) return `${name} references an undeclared token`;
  const color = parseColor(resolved);
  return color ?? `${name} value "${resolved}" is not a hex or rgb() color`;
}

/** Split a value on commas that are not inside parentheses. */
export function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === "(") depth += 1;
    if (char === ")") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter((part) => part.length > 0);
}

/** The color of the last (outermost) layer of a box-shadow focus ring. */
export function focusRingOuterColor(tokens: TokenMap): Rgba | string {
  const raw = tokens.get("--focus-ring");
  if (raw === undefined) return "--focus-ring is not declared";
  const resolved = resolveValue(raw, tokens);
  if (resolved == null) return "--focus-ring references an undeclared token";
  const layers = splitTopLevel(resolved);
  const colors = findColors(layers[layers.length - 1] ?? "");
  const color = colors.length === 0 ? null : parseColor(colors[colors.length - 1]!);
  return color ?? "--focus-ring outer layer has no hex or rgb() color";
}
