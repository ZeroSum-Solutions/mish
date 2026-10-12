import { createHash } from 'node:crypto';
import { describeFontSource, type ResourceResult } from '@mish/contracts';
import { fontFallbackStack } from './check.js';

/**
 * AC-R11.2 rendered specimen of a font's admitted local files: a script-free HTML
 * document whose only subresources are the same-origin, digest-pinned font files.
 * The style block is allowed by its exact hash, so the policy needs no
 * 'unsafe-inline' and admits no script, image, frame, form or remote font.
 */
export interface FontSpecimenOptions { text?: string; weight?: number; style?: 'normal' | 'italic' }
export const FONT_SPECIMEN_TEXT_LIMIT = 2000;
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const SAME_ORIGIN_FONT = /^\/api\/workbench\/fonts\/files\/[a-f0-9]{64}$/u;
const UNICODE_RANGE = /^[U+0-9A-Fa-f?,\s-]+$/u;

export function renderFontSpecimen(resource: ResourceResult, options: FontSpecimenOptions = {}): { html: string; contentSecurityPolicy: string } {
  const profile = resource.fontProfile;
  if (!profile) throw new Error('Not a font resource');
  const weight = Number.isInteger(options.weight) && options.weight! >= 1 && options.weight! <= 1000 ? options.weight! : 400;
  const style = options.style === 'italic' ? 'italic' : 'normal';
  const text = (options.text ?? '').slice(0, FONT_SPECIMEN_TEXT_LIMIT) || `${profile.family}: The quick brown fox jumps over the lazy dog 0123456789`;
  // Only same-origin digest URLs with validated descriptors reach the stylesheet.
  const faces = profile.localFiles.filter(file => file.state === 'available' && file.url && SAME_ORIGIN_FONT.test(file.url) && UNICODE_RANGE.test(file.unicodeRange)).map(file =>
    `@font-face{font-family:"od-specimen";src:url("${file.url}") format("${file.format}");font-weight:${file.weight.min} ${file.weight.max};font-style:${file.style};unicode-range:${file.unicodeRange};font-display:block}`);
  const fallback = fontFallbackStack(profile).replace(/^'[^']*',\s*/u, '');
  const css = `${faces.join('')}body{margin:0;padding:24px;background:#fff;color:#111;font:14px/1.4 system-ui,sans-serif}.specimen{font-family:${faces.length ? '"od-specimen",' : ''}${fallback};font-weight:${weight};font-style:${style};font-size:40px;line-height:1.25;white-space:pre-wrap;overflow-wrap:anywhere}.meta{color:#555;margin-top:16px}`;
  const styleHash = createHash('sha256').update(css).digest('base64');
  const notice = profile.licence.reservedFontNames.length ? ` · Reserved Font Name ${profile.licence.reservedFontNames.join(', ')}` : '';
  const body = faces.length
    ? `<p class="specimen">${escapeHtml(text)}</p><p class="meta">${escapeHtml(`${profile.family} · ${weight} ${style} · ${profile.licence.type}${notice} · ${describeFontSource(profile.source)}`)}</p>`
    : `<p class="meta">${escapeHtml(resource.rightsStatus === 'restricted' || profile.localFiles.some(file => file.reason === 'rights-blocked')
      ? `The ${profile.licence.type} licence restricts serving the font files for ${profile.family}, so nothing is rendered.`
      : `No local file admitted for ${profile.family}; only source metadata (${describeFontSource(profile.source)}) is available, so nothing is rendered.`)}</p>`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(profile.family)} specimen</title><style>${css}</style></head><body>${body}</body></html>`;
  const contentSecurityPolicy = `default-src 'none'; font-src 'self'; style-src 'sha256-${styleHash}'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'`;
  return { html, contentSecurityPolicy };
}
