import type { ResourceCandidate } from '@mish/contracts';

/**
 * Shared, pure helpers for owned token resources (project tokens, brief-derived
 * suggestions, user design-system kits): colour parsing, WCAG contrast evidence,
 * cohort classification of CSS custom properties, and the static specimen HTML the
 * workbench preview route serves for a token cohort.
 *
 * Nothing here reads files or trusts a value as CSS: a specimen only paints a
 * colour this module parsed itself and a length it re-serialized itself, so a
 * hostile token value can never become a stylesheet or markup.
 */
export type TokenCohort = 'color-palette' | 'type-scale' | 'spacing-scale' | 'motion';
export interface DesignTokenValue { name: string; value: string }
export interface Rgb { r: number; g: number; b: number }
export interface ContrastPair { foreground: string; background: string; ratio: number; minimum: number; passed: boolean }
export interface ContrastEvidence { pairs: ContrastPair[]; passed: boolean; reason: string }

export const COHORT_LABELS: Record<TokenCohort, string> = { 'color-palette': 'colour palette', 'type-scale': 'type scale', 'spacing-scale': 'spacing scale', motion: 'motion' };
/** WCAG 2.2 SC 1.4.3 normal text, and SC 1.4.11 non-text UI components. */
export const TEXT_CONTRAST_MINIMUM = 4.5;
export const UI_CONTRAST_MINIMUM = 3;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const colourLike = /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|lab\(|lch\(|color\(|color-mix\()/iu;
const lengthValue = /^-?\d+(?:\.\d+)?(px|rem|em)$/u;
const numberValue = /^\d+(?:\.\d+)?$/u;
const durationValue = /^\d+(?:\.\d+)?m?s$/u;

function channel(raw: string, scale: number): number | null {
  const text = raw.trim();
  if (/^-?\d+(?:\.\d+)?%$/u.test(text)) return clamp(Number(text.slice(0, -1)) / 100 * scale, 0, scale);
  if (/^-?\d+(?:\.\d+)?$/u.test(text)) return clamp(Number(text), 0, scale);
  return null;
}
function alphaIsOpaque(raw: string | undefined): boolean {
  if (raw === undefined) return true;
  const text = raw.trim();
  const value = text.endsWith('%') ? Number(text.slice(0, -1)) / 100 : Number(text);
  return Number.isFinite(value) && value >= 1;
}
function hslToRgb(h: number, s: number, l: number): Rgb {
  const hue = ((h % 360) + 360) % 360 / 360;
  const sat = clamp(s, 0, 1); const light = clamp(l, 0, 1);
  if (sat === 0) { const v = Math.round(light * 255); return { r: v, g: v, b: v }; }
  const q = light < 0.5 ? light * (1 + sat) : light + sat - light * sat;
  const p = 2 * light - q;
  const convert = (t: number) => {
    let x = t; if (x < 0) x += 1; if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return { r: Math.round(convert(hue + 1 / 3) * 255), g: Math.round(convert(hue) * 255), b: Math.round(convert(hue - 1 / 3) * 255) };
}
/** Opaque sRGB colours only. Translucent, wide-gamut and computed colours return
 * null: contrast against an unknown backdrop is not evidence. */
export function parseCssColor(raw: string): Rgb | null {
  const value = raw.trim().toLowerCase();
  if (value.length > 64) return null;
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/u.exec(value)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map(char => char + char).join('') : hex;
    if (full.length === 8 && full.slice(6) !== 'ff') return null;
    return { r: parseInt(full.slice(0, 2), 16), g: parseInt(full.slice(2, 4), 16), b: parseInt(full.slice(4, 6), 16) };
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/u.exec(value);
  if (!fn) return null;
  const parts = fn[2]!.includes(',') ? fn[2]!.split(',') : fn[2]!.replace(/\s*\/\s*/u, ' / ').split(/\s+/u).filter(part => part !== '/');
  if (parts.length < 3 || parts.length > 4 || !alphaIsOpaque(parts[3])) return null;
  if (fn[1]!.startsWith('rgb')) {
    const [r, g, b] = parts.slice(0, 3).map(part => channel(part, 255));
    return r === null || g === null || b === null || r === undefined || g === undefined || b === undefined ? null : { r: Math.round(r), g: Math.round(g), b: Math.round(b) };
  }
  const hue = Number(parts[0]!.trim().replace(/deg$/u, ''));
  const s = channel(parts[1]!, 100); const l = channel(parts[2]!, 100);
  if (!Number.isFinite(hue) || s === null || l === null || !parts[1]!.trim().endsWith('%') || !parts[2]!.trim().endsWith('%')) return null;
  return hslToRgb(hue, s / 100, l / 100);
}
export function rgbToHex({ r, g, b }: Rgb): string {
  return `#${[r, g, b].map(value => value.toString(16).padStart(2, '0')).join('')}`;
}
export function hslHex(h: number, s: number, l: number): string { return rgbToHex(hslToRgb(h, s, l)); }
function luminance({ r, g, b }: Rgb): number {
  const linear = (value: number) => { const c = value / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
/** WCAG 2.x contrast ratio, floored to two decimals so evidence never rounds up past a threshold. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return Math.floor(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/** Resolves `var(--name)` / `var(--name, fallback)` within one token set, bounded. */
export function resolveTokenValue(value: string, tokens: ReadonlyMap<string, string>, depth = 0): string | null {
  const reference = /^var\(\s*(--[A-Za-z0-9_-]+)\s*(?:,\s*([^)]*))?\)$/u.exec(value.trim());
  if (!reference) return value.trim();
  if (depth >= 4) return null;
  const next = tokens.get(reference[1]!) ?? reference[2];
  return next === undefined ? null : resolveTokenValue(next, tokens, depth + 1);
}

/** Which owned-token cohort a CSS custom property belongs to, or null for any other property. */
export function classifyToken(name: string, rawValue: string, tokens: ReadonlyMap<string, string> = new Map()): TokenCohort | null {
  const lower = name.toLowerCase();
  const value = resolveTokenValue(rawValue, tokens) ?? rawValue.trim();
  if (/(duration|easing|ease|transition|motion)/u.test(lower) && (durationValue.test(value) || /^cubic-bezier\(/u.test(value) || /^(linear|ease|ease-in|ease-out|ease-in-out)$/u.test(value))) return 'motion';
  if (colourLike.test(value) && !/(shadow|gradient)/u.test(lower)) return 'color-palette';
  if (/(^--(text|font-size|fs|leading|line-height|tracking|letter-spacing)(-|$))|(font-size|line-height|type-scale)/u.test(lower) && (lengthValue.test(value) || numberValue.test(value))) return 'type-scale';
  if (/(^--(space|spacing|gap|gutter|inset|size-target)(-|$))|(spacing|gutter)/u.test(lower) && lengthValue.test(value)) return 'spacing-scale';
  return null;
}

/** CSS custom-property declarations in source order (first declaration of a name wins). */
export function extractCustomProperties(css: string, limit = 2000): DesignTokenValue[] {
  const tokens = new Map<string, string>();
  const stripped = css.replace(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of stripped.matchAll(/(--[A-Za-z0-9_-]{1,120})\s*:\s*([^;{}]{1,200})/gu)) {
    if (tokens.size >= limit) break;
    const value = match[2]!.replace(/!important\s*$/u, '').trim();
    if (value && !tokens.has(match[1]!)) tokens.set(match[1]!, value);
  }
  return [...tokens].map(([name, value]) => ({ name, value }));
}

const FOREGROUND = /(^|-)(text|fg|foreground|ink|on-[a-z0-9]+|body|heading|copy)(-|$)/u;
const BACKGROUND = /(^|-)(bg|background|surface|canvas|paper|page|base)(-|$)/u;
/** Hard cap on text x surface pairs one palette may ask us to evaluate. Over it the
 * palette is unverified as a whole; a checked subset is never reported as a pass. */
export const CONTRAST_PAIR_BUDGET = 256;
/**
 * Contrast evidence for a declared palette: EVERY identifiable text-role token
 * against EVERY surface-role token must meet 4.5:1. No identifiable pair, an
 * unparsable member, or more pairs than the budget means no evidence (never a pass).
 */
export function paletteContrastEvidence(palette: readonly DesignTokenValue[], all: ReadonlyMap<string, string>): ContrastEvidence {
  const resolved = palette.map(token => ({ name: token.name, rgb: parseCssColor(resolveTokenValue(token.value, all) ?? '') }));
  const fg = resolved.filter(token => FOREGROUND.test(token.name.toLowerCase().replace(/^--(color-)?/u, '')) && !BACKGROUND.test(token.name.toLowerCase().replace(/^--(color-)?/u, '')));
  const bg = resolved.filter(token => BACKGROUND.test(token.name.toLowerCase().replace(/^--(color-)?/u, '')) && !FOREGROUND.test(token.name.toLowerCase().replace(/^--(color-)?/u, '')));
  const total = fg.length * bg.length;
  if (total > CONTRAST_PAIR_BUDGET) return { pairs: [], passed: false, reason: `contrast unverified: ${total} pairs exceed the ${CONTRAST_PAIR_BUDGET}-pair budget` };
  const pairs: ContrastPair[] = [];
  let unparsable = false;
  for (const f of fg) for (const b of bg) {
    if (!f.rgb || !b.rgb) { unparsable = true; continue; }
    const ratio = contrastRatio(f.rgb, b.rgb);
    pairs.push({ foreground: f.name, background: b.name, ratio, minimum: TEXT_CONTRAST_MINIMUM, passed: ratio >= TEXT_CONTRAST_MINIMUM });
  }
  if (!pairs.length) return { pairs, passed: false, reason: unparsable ? 'Text/surface tokens are not opaque sRGB colours; contrast is unverified' : 'No text/surface token pair is identifiable; contrast is unverified' };
  const failed = pairs.filter(pair => !pair.passed);
  if (unparsable) return { pairs, passed: false, reason: 'Some text/surface tokens are not opaque sRGB colours; contrast is unverified' };
  return { pairs, passed: failed.length === 0, reason: failed.length ? `${failed.length} text/surface pair(s) below ${TEXT_CONTRAST_MINIMUM}:1` : `${pairs.length} text/surface pair(s) meet ${TEXT_CONTRAST_MINIMUM}:1` };
}
export function describeContrastPair(pair: ContrastPair): string {
  return `${pair.foreground} on ${pair.background}: ${pair.ratio}:1 (minimum ${pair.minimum}:1) ${pair.passed ? 'passed' : 'failed'}`;
}
/** Up to `limit` evidence lines, failing pairs first, so a summary never hides the failure. */
export function contrastEvidenceLines(evidence: ContrastEvidence, limit = 6): string[] {
  return [...evidence.pairs.filter(pair => !pair.passed), ...evidence.pairs.filter(pair => pair.passed)].slice(0, limit).map(describeContrastPair);
}

/** The workbench preview route serves this document for token cohorts. Static: no script, no
 * external request. `sandbox` covers direct navigation; the web harness drops that one
 * directive and applies its own iframe sandbox (script-src admits only its injected guards). */
export const TOKEN_SPECIMEN_CSP = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; sandbox";
const escapeHtml = (value: string) => value.replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
function safeLength(value: string): string | null {
  const match = lengthValue.exec(value.trim());
  if (!match) return null;
  const amount = Number(value.trim().slice(0, -match[1]!.length));
  const px = match[1] === 'px' ? amount : amount * 16;
  return Number.isFinite(px) && px >= 0 ? `${Math.min(px, 160)}px` : null;
}
export function renderTokenSpecimen(input: { title: string; category: TokenCohort; tokens: readonly DesignTokenValue[]; notes: readonly string[] }): string {
  const all = new Map(input.tokens.map(token => [token.name, token.value]));
  const rows = input.tokens.map(token => {
    const resolved = resolveTokenValue(token.value, all) ?? token.value;
    let sample = '';
    if (input.category === 'color-palette') {
      const rgb = parseCssColor(resolved);
      sample = rgb ? `<span class="swatch" style="background:${rgbToHex(rgb)}"></span>` : '<span class="swatch none">n/a</span>';
    } else if (input.category === 'type-scale') {
      const size = safeLength(resolved);
      sample = size ? `<span class="type" style="font-size:${size}">Aa</span>` : '';
    } else if (input.category === 'spacing-scale') {
      const size = safeLength(resolved);
      sample = size ? `<span class="bar" style="width:${size}"></span>` : '';
    }
    return `<li>${sample}<code>${escapeHtml(token.name)}</code><span class="value">${escapeHtml(token.value)}</span></li>`;
  }).join('');
  const notes = input.notes.map(note => `<li>${escapeHtml(note)}</li>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(input.title)}</title><style>
body{font:15px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#fff;color:#111}
h1{font-size:18px;margin:0 0 16px}ul{list-style:none;margin:0;padding:0}li{display:flex;align-items:center;gap:12px;padding:6px 0;border-bottom:1px solid #e5e5e5}
.swatch{display:inline-block;width:40px;height:40px;border-radius:6px;border:1px solid #ccc}.swatch.none{font-size:11px;text-align:center;line-height:40px}
.type{min-width:64px}.bar{display:inline-block;height:12px;background:#555;border-radius:2px}code{font-weight:600}.value{color:#444;margin-left:auto}
.notes{margin-top:20px;font-size:13px;color:#333}
</style></head><body><main><h1>${escapeHtml(input.title)}</h1><ul data-token-cohort="${input.category}">${rows}</ul>${notes ? `<ul class="notes">${notes}</ul>` : ''}</main></body></html>`;
}

/** A token cohort as an adapter holds it, so list and preview read the same bytes. */
export interface TokenSpecimen { itemId: string; revision: string; title: string; category: TokenCohort; tokens: DesignTokenValue[]; notes: string[] }
export type SpecimenCandidate = { candidate: ResourceCandidate; specimen: TokenSpecimen | null };
