import type { Hsl, Rgb } from './types.ts';

// Small colour maths for deriving a page's look. Colours are '#rrggbb' strings.

export function parseHex(input: string): Rgb | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(input).trim());
  if (!m) return null;
  const digits = m[1] as string;
  const h = digits.length === 3 ? [...digits].map((c) => c + c).join('') : digits;
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

export const toHex = ({ r, g, b }: Rgb): string =>
  '#' + [r, g, b].map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');

export function toHsl({ r, g, b }: Rgb): Hsl {
  const [R, G, B] = [r, g, b].map((v) => v / 255) as [number, number, number];
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return { h: (h * 60 + 360) % 360, s, l };
}

export function fromHsl({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b]: [number, number, number] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function luminance({ r, g, b }: Rgb): number {
  const [R, G, B] = ([r, g, b].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  })) as [number, number, number];
  return 0.2126 * R + 0.7152 * G + 0.0722 * B;
}

// WCAG contrast ratio, 1 to 21.
export function contrast(a: Rgb, b: Rgb): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export const mix = (a: Rgb, b: Rgb, t: number): Rgb => ({ r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t });

// Moves a colour lighter or darker, keeping its hue, until it reads against `against` at `ratio` or better.
export function ensureContrast(color: Rgb, against: Rgb, ratio: number): Rgb {
  if (contrast(color, against) >= ratio) return color;
  const hsl = toHsl(color);
  const lighten = luminance(against) < 0.5;
  for (let step = 1; step <= 40; step++) {
    const l = Math.min(1, Math.max(0, hsl.l + (lighten ? 1 : -1) * step * 0.025));
    const next = fromHsl({ ...hsl, l });
    if (contrast(next, against) >= ratio) return next;
  }
  return lighten ? { r: 255, g: 255, b: 255 } : { r: 0, g: 0, b: 0 };
}
