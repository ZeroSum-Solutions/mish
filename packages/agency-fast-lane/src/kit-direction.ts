/**
 * A design kit as a composed page's direction.
 *
 * A composed page (`block-compose.ts`) takes every colour and font from one `DesignDirection`: six
 * palette roles in OKLCH and three font stacks. A built-in direction is chosen by the block
 * planner; when a person picks an installed design kit for the build, this module derives the
 * direction from that kit's own `tokens.css` instead, so the page wears the kit.
 *
 * Input is the kit's approved `tokens.css` text, read by the daemon from one revision snapshot.
 * It is untrusted CSS: only `--name: value` declarations inside a top-level `:root` (or `html`)
 * rule are read, `var()` references are resolved with a depth and cycle bound, colours are parsed
 * from a closed set of notations, and a font stack is accepted only when it cannot break out of
 * the `<style>` element it is written into. Anything else makes the kit unusable for this lane
 * rather than half-applied: `kitDirection` throws `KitDirectionError` with a fixed code.
 *
 * Pure: no I/O, no globals, deterministic.
 */

import type { DesignDirection } from './section-overlay.ts';

/** Why a kit's tokens cannot style a composed page. Fixed codes; the daemon maps each to text. */
export type KitDirectionErrorCode = 'missing-token' | 'unsupported-color' | 'unsafe-font';

export class KitDirectionError extends Error {
  readonly code: KitDirectionErrorCode;
  readonly token: string;
  constructor(code: KitDirectionErrorCode, token: string) {
    super(`kit tokens unusable (${code}): ${token}`);
    this.name = 'KitDirectionError';
    this.code = code;
    this.token = token;
  }
}

/** What a build carries when a person picked a kit: the kit's identity and its derived direction. */
export type BuildDesignKit = {
  id: string;
  title: string;
  /** The approved revision the tokens were read from. */
  revision: string;
  direction: DesignDirection;
};

/** The first name in each list that the kit declares wins. */
const COLOR_TOKENS = {
  bg: ['--bg', '--background', '--color-bg', '--color-background'],
  surface: ['--surface', '--bg-surface', '--color-surface', '--card'],
  fg: ['--fg', '--foreground', '--text', '--color-fg', '--color-text'],
  muted: ['--muted', '--fg-muted', '--fg-2', '--text-muted', '--muted-foreground', '--color-muted'],
  border: ['--border', '--line', '--color-border'],
  accent: ['--accent', '--primary', '--brand', '--color-accent', '--color-primary'],
} as const;

const FONT_TOKENS = {
  display: ['--font-display', '--font-heading', '--font-headline', '--font-serif'],
  body: ['--font-body', '--font-sans', '--font-text', '--font-base'],
  mono: ['--font-mono', '--font-code'],
} as const;

const SYSTEM_BODY = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
const MAX_VAR_DEPTH = 16;
const MAX_FONT_CHARS = 300;
/** A comma-separated list of complete family names: each a double- or single-quoted string
 * (which may hold a comma or the other quote, never its own), or bare identifiers. Nothing that can end a rule, open a block, load a
 * URL, leave a string open or escape the style element. */
const FONT_NAME = String.raw`(?:"[A-Za-z0-9 _\-.,']*"|'[A-Za-z0-9 _\-.,"]*'|[A-Za-z0-9_\-.]+(?: [A-Za-z0-9_\-.]+)*)`;
const SAFE_FONT_STACK = new RegExp(`^${FONT_NAME}(?: ?, ?${FONT_NAME})*$`, 'u');

/**
 * Custom properties declared in top-level `:root`/`html` rules. An `!important` declaration
 * beats a normal one whatever their order; within the same priority the later one wins, as in
 * the cascade. Block at-rules (`@media`, `@supports`, `@font-face`, …) and every other selector
 * are skipped whole; statement at-rules (`@charset`, `@import`, `@layer a, b;`) are skipped up to
 * their `;` and never loaded. Strings are scanned as strings, so a `;`, `{` or `}` inside quotes
 * never ends a declaration or a rule.
 */
export function readRootCustomProperties(css: string): Map<string, string> {
  const text = stripComments(css);
  const found = new Map<string, { value: string; important: boolean }>();
  let index = 0;
  while (index < text.length) {
    const stop = nextTopLevel(text, index, '{;');
    if (stop < 0) break;
    if (text[stop] === ';') {
      index = stop + 1;
      continue;
    }
    const prelude = text.slice(index, stop).trim();
    const close = nextTopLevel(text, stop + 1, '}');
    if (close < 0) break;
    if (!prelude.startsWith('@') && isRootSelector(prelude)) {
      for (const declaration of splitTopLevel(text.slice(stop + 1, close), ';')) {
        const colon = declaration.indexOf(':');
        if (colon < 0) continue;
        const name = declaration.slice(0, colon).trim();
        const raw = declaration.slice(colon + 1).trim();
        const priority = /\s*!\s*important\s*$/iu.exec(raw);
        const value = priority ? raw.slice(0, priority.index).trim() : raw;
        const important = priority !== null;
        const previous = found.get(name);
        if (/^--[A-Za-z0-9_-]+$/u.test(name) && value.length > 0 && (!previous || important || !previous.important)) {
          found.set(name, { value, important });
        }
      }
    }
    index = close + 1;
  }
  return new Map([...found].map(([name, { value }]) => [name, value]));
}

/** `/* … *\/` comments removed, leaving quoted strings intact. */
function stripComments(css: string): string {
  let out = '';
  for (let i = 0; i < css.length; i += 1) {
    const char = css[i]!;
    if (char === '\\') {
      out += css.slice(i, i + 2);
      i += 1;
    } else if (char === '"' || char === "'") {
      const end = stringEnd(css, i);
      out += css.slice(i, end);
      i = end - 1;
    } else if (char === '/' && css[i + 1] === '*') {
      const end = css.indexOf('*/', i + 2);
      i = end < 0 ? css.length : end + 1;
    } else {
      out += char;
    }
  }
  return out;
}

/** The index just past the string that opens at `start` (an unterminated string runs to the end). */
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i += 1) {
    if (text[i] === '\\') i += 1;
    else if (text[i] === quote) return i + 1;
  }
  return text.length;
}

/** The first of `stops` at nesting depth 0 from `from`, outside strings; -1 when there is none.
 * A `{` that is not a stop opens a nested block, and its `}` closes it. */
function nextTopLevel(text: string, from: number, stops: string): number {
  let depth = 0;
  for (let i = from; i < text.length; i += 1) {
    const char = text[i]!;
    // An escaped character (`\'`, `\{`) is never a delimiter.
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      i = stringEnd(text, i) - 1;
      continue;
    }
    if (depth === 0 && stops.includes(char)) return i;
    if (char === '{') depth += 1;
    else if (char === '}') depth -= 1;
  }
  return -1;
}

function isRootSelector(prelude: string): boolean {
  return prelude.split(',').some((selector) => /^(?::root|html|:where\(:root\))$/u.test(selector.trim()));
}

/** `var(--name)` / `var(--name, fallback)` resolved against `props`, recursively and bounded. */
export function resolveVars(value: string, props: ReadonlyMap<string, string>, seen: ReadonlySet<string> = new Set(), depth = 0): string | undefined {
  if (depth > MAX_VAR_DEPTH) return undefined;
  const match = /var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/u.exec(value);
  if (!match) return value.trim();
  const [whole, name, fallback] = match;
  let replacement: string | undefined;
  const declared = props.get(name!);
  if (declared !== undefined && !seen.has(name!)) replacement = resolveVars(declared, props, new Set([...seen, name!]), depth + 1);
  if (replacement === undefined && fallback !== undefined) replacement = resolveVars(fallback, props, seen, depth + 1);
  if (replacement === undefined) return undefined;
  return resolveVars(value.replace(whole, replacement), props, seen, depth + 1);
}

type Rgba = { r: number; g: number; b: number; a: number };

const NAMED: Record<string, Rgba> = {
  white: { r: 1, g: 1, b: 1, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

/** Parses one colour in hex, `rgb()`/`rgba()`, `hsl()`/`hsla()`, `oklch()`,
 * `color-mix(in srgb, …)` or a few names. */
export function parseColor(raw: string): Rgba | undefined {
  const color = parseColorUnchecked(raw);
  // Every channel must be a real number in range: a NaN palette would only fail later, after the
  // build has started, instead of refusing the kit up front.
  return color && [color.r, color.g, color.b, color.a].every((channel) => Number.isFinite(channel) && channel >= -1e-9 && channel <= 1 + 1e-9)
    ? { r: clamp01(color.r), g: clamp01(color.g), b: clamp01(color.b), a: clamp01(color.a) }
    : undefined;
}

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseColorUnchecked(raw: string): Rgba | undefined {
  const value = raw.trim().replace(/\s+/gu, ' ').toLowerCase();
  if (Object.hasOwn(NAMED, value)) return NAMED[value];
  if (value.startsWith('color-mix(')) return parseSrgbMix(value);
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(value);
  if (hex) {
    const digits = hex[1]!.length <= 4 ? [...hex[1]!].map((d) => d + d).join('') : hex[1]!;
    const channel = (i: number) => parseInt(digits.slice(i * 2, i * 2 + 2), 16) / 255;
    return { r: channel(0), g: channel(1), b: channel(2), a: digits.length === 8 ? channel(3) : 1 };
  }
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^()]*)\)$/u.exec(value);
  if (!fn) return undefined;
  const parts = fn[2]!.split(/[\s,/]+/u).filter(Boolean);
  if (parts.length < 3 || parts.length > 4) return undefined;
  const alpha = parts[3] === undefined ? 1 : fraction(parts[3]);
  if (alpha === undefined) return undefined;
  if (fn[1]!.startsWith('rgb')) {
    const channel = (part: string) => {
      if (part.endsWith('%')) return fraction(part);
      const n = number(part, 0, 255);
      return n === undefined ? undefined : n / 255;
    };
    const [r, g, b] = parts.slice(0, 3).map(channel);
    if (r === undefined || g === undefined || b === undefined) return undefined;
    return { r, g, b, a: alpha };
  }
  if (fn[1]!.startsWith('hsl')) {
    const h = hue(parts[0]!);
    const s = fraction(parts[1]!);
    const l = fraction(parts[2]!);
    if (h === undefined || s === undefined || l === undefined) return undefined;
    return { ...hslToRgb(h, s, l), a: alpha };
  }
  const l = parts[0]!.endsWith('%') ? fraction(parts[0]!) : number(parts[0]!, 0, 1);
  const c = number(parts[1]!, 0, 0.5);
  const h = hue(parts[2]!);
  if (l === undefined || c === undefined || h === undefined) return undefined;
  return { ...linearToSrgb(oklabToLinear(l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180))), a: alpha };
}

/** `color-mix(in srgb, A [p%], B [q%])` with the CSS percentage normalisation; any other
 * interpolation space is not parsed. Arguments are split at top-level commas only. */
function parseSrgbMix(value: string): Rgba | undefined {
  if (!value.endsWith(')')) return undefined;
  const args = splitTopLevel(value.slice('color-mix('.length, -1), ',');
  if (args.length !== 3 || args[0]!.trim() !== 'in srgb') return undefined;
  const side = (arg: string) => {
    const match = /^([\s\S]*?)(?:\s+(\d*\.?\d+)%)?$/u.exec(arg.trim());
    if (!match) return undefined;
    const color = parseColor(match[1]!);
    const weight = match[2] === undefined ? undefined : Number(match[2]) / 100;
    if (weight !== undefined && !(weight >= 0 && weight <= 1)) return undefined;
    return color ? { color, weight } : undefined;
  };
  const a = side(args[1]!);
  const b = side(args[2]!);
  if (!a || !b) return undefined;
  // CSS Color 5 §2.1: omitted weights complete to 100%; weights summing past 100% are scaled
  // down to it; a sum below 100% is scaled up for the mix and multiplies the result's alpha.
  let p1 = a.weight ?? (b.weight === undefined ? 0.5 : 1 - b.weight);
  let p2 = b.weight ?? 1 - p1;
  const total = p1 + p2;
  if (!(total > 0)) return undefined;
  p1 /= total;
  p2 /= total;
  const alpha = (a.color.a * p1 + b.color.a * p2) * Math.min(1, total);
  if (alpha <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const premultiplied = a.color.a * p1 + b.color.a * p2;
  const mix = (key: 'r' | 'g' | 'b') => (a.color[key] * a.color.a * p1 + b.color[key] * b.color.a * p2) / premultiplied;
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: alpha };
}

/** `text` split at `separator` where it is outside parentheses and strings. */
function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '\\') i += 1;
    else if (char === '"' || char === "'") i = stringEnd(text, i) - 1;
    else if (char === '(') depth += 1;
    else if (char === ')') depth -= 1;
    else if (char === separator && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

function number(part: string, min: number, max: number): number | undefined {
  if (!/^-?\d*\.?\d+$/u.test(part)) return undefined;
  const n = Number(part);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
}

function fraction(part: string): number | undefined {
  if (part.endsWith('%')) {
    const n = number(part.slice(0, -1), 0, 100);
    return n === undefined ? undefined : n / 100;
  }
  return number(part, 0, 1);
}

function hue(part: string): number | undefined {
  const n = number(part.replace(/deg$/u, ''), -1e6, 1e6);
  return n === undefined ? undefined : ((n % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): { r: number; g: number; b: number } {
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return { r: f(0), g: f(8), b: f(4) };
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const fromLinear = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

function oklabToLinear(L: number, a: number, b: number): { r: number; g: number; b: number } {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    g: -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    b: -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  };
}

function linearToSrgb(rgb: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const clamp = (n: number) => Math.min(1, Math.max(0, fromLinear(Math.min(1, Math.max(0, n)))));
  return { r: clamp(rgb.r), g: clamp(rgb.g), b: clamp(rgb.b) };
}

/** Straight-alpha `over` in sRGB, the way a browser paints a translucent colour on a solid one. */
function over(top: Rgba, under: Rgba): Rgba {
  return { r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 };
}

/** WCAG contrast ratio of two opaque sRGB colours. */
export function contrast(x: Rgba, y: Rgba): number {
  const luminance = (c: Rgba) => 0.2126 * toLinear(c.r) + 0.7152 * toLinear(c.g) + 0.0722 * toLinear(c.b);
  const [hi, lo] = [luminance(x), luminance(y)].sort((p, q) => q - p) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** The composed page sets nav and footer text in the muted role, so it must read on both grounds. */
const MIN_MUTED_CONTRAST = 4.5;

/** An opaque sRGB colour as `oklch(L% C H)`, the exact shape the direction contrast code parses. */
export function toOklch(color: Rgba): string {
  const r = toLinear(color.r);
  const g = toLinear(color.g);
  const b = toLinear(color.b);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const C = Math.sqrt(A * A + B * B);
  const H = C < 1e-4 ? 0 : (((Math.atan2(B, A) * 180) / Math.PI) + 360) % 360;
  return `oklch(${(Math.min(1, Math.max(0, L)) * 100).toFixed(2)}% ${Math.min(0.4, C).toFixed(4)} ${H.toFixed(2)})`;
}

function firstDeclared(props: ReadonlyMap<string, string>, names: readonly string[]): string | undefined {
  return names.find((name) => props.has(name));
}

function tryColorOf(props: ReadonlyMap<string, string>, name: string): Rgba | undefined {
  const resolved = resolveVars(props.get(name)!, props, new Set([name]));
  return resolved === undefined ? undefined : parseColor(resolved);
}

function colorOf(props: ReadonlyMap<string, string>, name: string): Rgba {
  const color = tryColorOf(props, name);
  if (!color) throw new KitDirectionError('unsupported-color', name);
  return color;
}

/** Every declared, parseable colour among `names`, in list order, painted onto `ground`. */
function candidates(props: ReadonlyMap<string, string>, names: readonly string[], ground: Rgba): Rgba[] {
  return names.filter((name) => props.has(name)).map((name) => tryColorOf(props, name)).filter((color): color is Rgba => color !== undefined).map((color) => over(color, ground));
}

function fontOf(props: ReadonlyMap<string, string>, names: readonly string[]): string | undefined {
  const name = firstDeclared(props, names);
  if (!name) return undefined;
  const resolved = resolveVars(props.get(name)!, props, new Set([name]));
  const stack = resolved?.replace(/\s+/gu, ' ').trim();
  if (!stack || stack.length > MAX_FONT_CHARS || !SAFE_FONT_STACK.test(stack)) throw new KitDirectionError('unsafe-font', name);
  return stack;
}

/**
 * The direction a composed page takes from a kit's `tokens.css`. Background, foreground and
 * accent are required and must parse. The others are optional, and one that is missing or does
 * not parse falls back: surface to the background, border to the foreground at 15% over the
 * background. Muted must read as text on both grounds (some kits use `--muted` for hairlines):
 * the first candidate that clears 4.5:1 wins, else the foreground at 72% over the background,
 * else the foreground. Translucent colours are painted onto the background (the background
 * itself onto white), because a direction's roles are opaque.
 */
export function kitDirection(tokensCss: string, kit: { id: string; title: string }): DesignDirection {
  const props = readRootCustomProperties(tokensCss);
  const required = (role: keyof typeof COLOR_TOKENS) => {
    const name = firstDeclared(props, COLOR_TOKENS[role]);
    if (!name) throw new KitDirectionError('missing-token', COLOR_TOKENS[role][0]);
    return name;
  };

  const bg = over(colorOf(props, required('bg')), NAMED.white!);
  const fg = over(colorOf(props, required('fg')), bg);
  const accent = over(colorOf(props, required('accent')), bg);
  const surface = candidates(props, COLOR_TOKENS.surface, bg)[0] ?? bg;
  const border = candidates(props, COLOR_TOKENS.border, bg)[0] ?? over({ ...fg, a: 0.15 }, bg);
  const readable = (color: Rgba) => contrast(color, bg) >= MIN_MUTED_CONTRAST && contrast(color, surface) >= MIN_MUTED_CONTRAST;
  const muted = [...candidates(props, COLOR_TOKENS.muted, bg), over({ ...fg, a: 0.72 }, bg)].find(readable) ?? fg;

  const body = fontOf(props, FONT_TOKENS.body) ?? SYSTEM_BODY;
  const display = fontOf(props, FONT_TOKENS.display) ?? body;
  const mono = fontOf(props, FONT_TOKENS.mono);

  return {
    id: `kit:${kit.id}`,
    label: kit.title,
    displayFont: display,
    bodyFont: body,
    ...(mono ? { monoFont: mono } : {}),
    palette: {
      bg: toOklch(bg),
      surface: toOklch(surface),
      fg: toOklch(fg),
      muted: toOklch(muted),
      border: toOklch(border),
      accent: toOklch(accent),
    },
  };
}
