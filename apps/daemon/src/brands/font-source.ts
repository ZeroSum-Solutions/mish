import type { BrandFontSpec } from '@mish/contracts';
import googleFonts from '../fonts/google-fonts-snapshot.json' with { type: 'json' };
import googleFontsPart2 from '../fonts/google-fonts-snapshot-2.json' with { type: 'json' };
import { safeFontStylesheetUrl } from './font-url.js';

const googleFamilies = new Map([...googleFonts.families, ...googleFontsPart2.families]
  .map(font => [font.family.toLowerCase(), font]));

/** Specimens and generation share one load source. Infer only a family in the
 * pinned Google listing; unknown or proprietary families retain their fallback. */
export function brandFontStylesheet(spec: BrandFontSpec | undefined): string | null {
  if (!spec) return null;
  const explicit = safeFontStylesheetUrl(spec.googleFontsUrl);
  if (explicit) return explicit;
  const font = googleFamilies.get(spec.family.trim().toLowerCase());
  if (!font || !font.styles.includes('normal')) return null;
  const family = encodeURIComponent(font.family).replace(/%20/g, '+');
  const weights = [...font.weights].sort((a, b) => a - b).join(';');
  return `https://fonts.googleapis.com/css2?family=${family}:wght@${weights}&display=swap`;
}
