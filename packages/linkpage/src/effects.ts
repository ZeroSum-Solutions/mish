// Mish catalog effects on a link page: one background component and one hover component, picked by id.
// The CSS and script of each come from catalog-assets.ts (generated), so this package stays headless.
import { BACKGROUND_IDS, CATALOG_ASSETS, HOVER_IDS } from './catalog-assets.ts';
import type { Effects, Palette } from './types.ts';

const isBackground = (id: unknown): id is string => typeof id === 'string' && (BACKGROUND_IDS as readonly string[]).includes(id);
const isHover = (id: unknown): id is string => typeof id === 'string' && (HOVER_IDS as readonly string[]).includes(id);

/** Keeps only allowlisted ids in their own slot. Unknown ids are dropped; nothing here throws. */
export function cleanEffects(raw: unknown): Effects | undefined {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: Effects = { ...(isBackground(r.background) ? { background: r.background } : {}), ...(isHover(r.hover) ? { hover: r.hover } : {}) };
  return out.background || out.hover ? out : undefined;
}

/** Options that tie each component to the page's own colours (read at mount from data-genui-opts). */
function optionsFor(id: string, p: Palette): Record<string, string | number | boolean> {
  const ink = (pct: number): string => `color-mix(in srgb, ${p.text} ${pct}%, transparent)`;
  switch (id) {
    case 'grainient': return { base: p.bg, colorA: p.accent, colorB: p.muted, colorC: p.surface, intensity: 0.35, grain: 0.18 };
    case 'soft-aurora': return { colorA: p.accent, colorB: p.muted, intensity: 0.35 };
    case 'dot-grid': return { colour: p.text, accent: p.accent };
    case 'waves': return { colour: p.accent };
    case 'light-rays': return { colour: p.accent, intensity: 0.12 };
    case 'glare-hover': return { colour: p.accent, opacity: 0.3 };
    case 'spotlight-card': return { colour: ink(10), borderColour: ink(30) };
    case 'star-border': return { colour: p.accent };
    default: return {};
  }
}

const attr = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const hostAttrs = (id: string, p: Palette): string => `data-genui="${id}" data-genui-opts="${attr(JSON.stringify(optionsFor(id, p)))}"`;

export const effectsCss = '#fx-bg{position:fixed;inset:0;z-index:-1;pointer-events:none}';

export interface EffectsMarkup {
  /** The fixed background host, first in the body; empty without a background effect. */
  host: string;
  /** Puts the hover component's host attributes on the card elements (.link, .post, .email). */
  cards: (html: string) => string;
  /** Each used component's styles.css, once. */
  css: string;
  /** Each used component's auto.js, once, as one script element's text; empty when none is needed. */
  js: string;
}

export function effectsMarkup(effects: Effects, palette: Palette): EffectsMarkup {
  const { background, hover } = cleanEffects(effects) ?? {};
  const ids = [...new Set([background, hover].filter((id): id is string => Boolean(id)))];
  // A magnet would drag a whole sign-up form around, so the email card keeps still.
  // A magnet would drag a whole sign-up form around, so the email card keeps still.
  const cards = hover === 'magnet' ? /<(a|section) class="(link|post)\b/g : /<(a|section) class="(link|post|email)\b/g;
  return {
    host: background ? `<div id="fx-bg" class="genui-${background}" ${hostAttrs(background, palette)} aria-hidden="true"></div>` : '',
    cards: (html) => (hover ? html.replace(cards, (_m, tag: string, kind: string) => `<${tag} ${hostAttrs(hover, palette)} class="genui-${hover} ${kind}`) : html),
    css: ids.map((id) => CATALOG_ASSETS[id]?.css ?? '').join(''),
    js: ids.map((id) => CATALOG_ASSETS[id]?.js ?? '').filter(Boolean).join(';'),
  };
}
