import type { Rgba } from './types.js';

/** Composite `top` over an opaque `bottom` (source-over). */
export function composite(top: Rgba, bottom: Rgba): Rgba {
  const alpha = Math.min(1, Math.max(0, top[3]));
  const mix = (index: 0 | 1 | 2) => top[index] * alpha + bottom[index] * (1 - alpha);
  return [mix(0), mix(1), mix(2), 1];
}

function channel(value: number): number {
  const c = Math.min(255, Math.max(0, value)) / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of an opaque sRGB color. */
export function relativeLuminance(color: Rgba): number {
  return 0.2126 * channel(color[0]) + 0.7152 * channel(color[1]) + 0.0722 * channel(color[2]);
}

/** WCAG 2.x contrast ratio of foreground text over an opaque background, 1–21. */
export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const fg = relativeLuminance(composite(foreground, background));
  const bg = relativeLuminance(background);
  const [light, dark] = fg > bg ? [fg, bg] : [bg, fg];
  return (light + 0.05) / (dark + 0.05);
}

/** WCAG "large scale" text: at least 18pt (24px), or 14pt (≈18.66px) bold. */
export function isLargeText(fontSizePx: number, fontWeight: number): boolean {
  return fontSizePx >= 24 || (fontSizePx >= 18.66 && fontWeight >= 700);
}
