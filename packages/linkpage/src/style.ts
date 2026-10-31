import { contrast, ensureContrast, fromHsl, luminance, mix, parseHex, toHex, toHsl } from './color.ts';
import type { FontChoice, FontKind, Hsl, Mood, Palette, Rgb, Signal, Theme, ThemeOptions } from './types.ts';

// Turns what the connectors saw (colours and fonts a creator already uses) into one theme.
//
// signals: [{ colors: [{ hex, weight }], fonts: [{ family, weight }] }]. Weight is how often it appeared.
// theme:   { mood, palette: { bg, surface, text, muted, accent, accentText }, fonts: { heading, body }, radius }

const SERIF = ['cormorant', 'playfair', 'garamond', 'georgia', 'times', 'lora', 'merriweather', 'libre baskerville', 'dm serif', 'fraunces', 'crimson', 'eb garamond', 'baskerville', 'bodoni'];
const MONO = ['mono', 'courier', 'consolas', 'menlo', 'jetbrains', 'space mono', 'ibm plex mono'];
const DISPLAY = ['bebas', 'anton', 'archivo black', 'abril', 'lobster', 'pacifico', 'monoton', 'fredoka', 'chunk'];

// Fonts that load from Google Fonts with no licence. Anything else falls back to a system stack of its kind.
const GOOGLE = ['Cormorant Garamond', 'Cormorant', 'Playfair Display', 'EB Garamond', 'Lora', 'Merriweather', 'Libre Baskerville', 'DM Serif Display', 'Fraunces', 'Crimson Text', 'Inter', 'DM Sans', 'Manrope', 'Poppins', 'Montserrat', 'Work Sans', 'Space Grotesk', 'Tenor Sans', 'Space Mono', 'JetBrains Mono', 'Bebas Neue', 'Anton', 'Fredoka', 'Pacifico'];

const STACKS: Record<FontKind, string> = {
  serif: 'Georgia, "Times New Roman", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif',
  mono: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
  display: 'Impact, "Arial Narrow Bold", sans-serif',
};

const MOODS: Record<FontKind, { mood: Mood; radius: number }> = {
  serif: { mood: 'editorial', radius: 2 },
  sans: { mood: 'modern', radius: 12 },
  mono: { mood: 'raw', radius: 0 },
  display: { mood: 'playful', radius: 999 },
};

export function classifyFont(family: string): FontKind {
  const f = family.toLowerCase();
  if (MONO.some((k) => f.includes(k))) return 'mono';
  if (DISPLAY.some((k) => f.includes(k))) return 'display';
  if (SERIF.some((k) => f.includes(k)) && !f.includes('sans')) return 'serif';
  return 'sans';
}

/**
 * A scraped font name the contract (and a stylesheet) can carry: accents folded to ASCII, then letters, digits,
 * spaces, dots, dashes and underscores only. Anything else (a clamp() from WordPress, a size, a name in another
 * script) is not a usable name and gives null, so the page falls back to a system stack.
 */
export function usableFamily(raw: string): string | null {
  const name = raw.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
  return /^[A-Za-z][A-Za-z0-9 ._-]{0,79}$/.test(name) ? name : null;
}

function fontChoice(family: string, kind: FontKind): FontChoice {
  const google = GOOGLE.find((g) => g.toLowerCase() === family.toLowerCase());
  return { family: google || family, kind, stack: `${google ? `"${google}", ` : ''}${STACKS[kind]}`, google: Boolean(google) };
}

// Adds up weights per key across every signal.
function tally<T extends object>(signals: Signal[], field: 'colors' | 'fonts', key: (item: T) => string | null): [string, number][] {
  const totals = new Map<string, number>();
  for (const s of signals) {
    for (const item of (s[field] || []) as unknown as T[]) {
      const k = key(item);
      if (k) totals.set(k, (totals.get(k) || 0) + ((item as { weight?: number }).weight || 1));
    }
  }
  return [...totals].sort((a, b) => b[1] - a[1]);
}

function pickFonts(signals: Signal[]): { heading: FontChoice; body: FontChoice } {
  const ranked = tally<{ family?: string }>(signals, 'fonts', (f) => usableFamily(f.family?.replace(/["']/g, '') || ''));
  // A font we can load, or can stand in for, beats one named only in a licence we cannot use.
  const choices = ranked.map(([family, weight]) => ({ ...fontChoice(family, classifyFont(family)), weight }));
  const heading = choices.find((c) => c.kind === 'serif' || c.kind === 'display') || choices[0] || fontChoice('Inter', 'sans');
  const body = choices.find((c) => c.kind === 'sans' && c.google) || choices.find((c) => c.kind === 'sans') || fontChoice('Inter', 'sans');
  return { heading, body: heading.kind === 'mono' ? heading : body };
}

const chromaOf = ({ r, g, b }: Rgb): number => (Math.max(r, g, b) - Math.min(r, g, b)) / 255;

function pickPalette(signals: Signal[], fixed: NonNullable<ThemeOptions['palette']> = {}): Palette {
  const colors = tally<{ hex: string }>(signals, 'colors', (c) => {
    const rgb = parseHex(c.hex);
    return rgb ? toHex(rgb) : null;
  }).map(([hex, weight]) => {
    const rgb = parseHex(hex) as Rgb;
    return { hex, weight, rgb, hsl: toHsl(rgb), chroma: chromaOf(rgb) };
  });

  // Chroma, not HSL saturation: saturation reads a cream like #fcfbf9 as vivid because it is so close to white.
  const neutrals = colors.filter((c) => c.chroma < 0.08);
  const vivid = colors.filter((c) => c.chroma >= 0.15 && c.hsl.l > 0.12 && c.hsl.l < 0.9);

  // Background: the most used near-white or near-black neutral. Pure black and white count for less, because
  // stylesheets use them everywhere without choosing them.
  const plain = (c: { hex: string }): boolean => c.hex === '#000000' || c.hex === '#ffffff';
  const bgPool = neutrals.filter((c) => c.hsl.l > 0.88 || c.hsl.l < 0.16);
  const bgPick = [...bgPool].sort((a, b) => b.weight * (plain(b) ? 0.2 : 1) - a.weight * (plain(a) ? 0.2 : 1))[0];
  const bg = (fixed.bg ? parseHex(fixed.bg) : null) || bgPick?.rgb || { r: 252, g: 251, b: 249 };

  const dark = luminance(bg) < 0.4;
  const warm = toHsl(bg);
  const ink = fromHsl({ h: warm.h, s: Math.min(warm.s, 0.25), l: dark ? 0.94 : 0.1 });
  const text = (fixed.text ? parseHex(fixed.text) : null) || ensureContrast(ink, bg, 7);

  // A creator who holds to two colours gets two: with no accent given, the ink is the accent.
  const accentRaw = (fixed.accent ? parseHex(fixed.accent) : null) || (fixed.bg || fixed.text ? text : vivid[0]?.rgb || mix(bg, text, 0.55));
  const accent = ensureContrast(accentRaw, bg, 3);
  const surface = mix(bg, text, dark ? 0.08 : 0.05);
  const muted = ensureContrast(mix(bg, text, 0.62), bg, 4.5);
  // The label on an accent button: whichever of the page's own ink or background reads better.
  const accentText = contrast(bg, accent) >= contrast(text, accent) ? bg : text;

  return {
    bg: toHex(bg), surface: toHex(surface), text: toHex(text), muted: toHex(muted), accent: toHex(accent), accentText: toHex(accentText),
    dark,
  };
}

// options.palette fixes colours the creator has chosen ({ bg, text, accent }); the rest is derived.
// options.background names the interactive background; it defaults to one that suits the mood.
export function deriveTheme(signals: Signal[], options: ThemeOptions = {}): Theme {
  const fonts = pickFonts(signals);
  const { mood, radius } = MOODS[fonts.heading.kind];
  const background = options.background || BACKGROUNDS[mood];
  return { mood, radius, background, palette: pickPalette(signals, options.palette || {}), fonts: { heading: fonts.heading, body: fonts.body } };
}

const BACKGROUNDS: Record<Mood, string> = { editorial: 'glaze', modern: 'mesh', raw: 'grid', playful: 'bubbles' };
