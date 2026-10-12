// In-page scripts evaluated by the CDP worker. They are plain JavaScript
// strings (never Function#toString of compiled TypeScript) so the code that
// runs in the page is exactly what is reviewed here. They only read the DOM,
// except the click probe, which fills forms with inert test values.
import { REVIEW_TAG_NAMES } from '@open-design/contracts';
import type { TargetRequest } from './types.js';

/** Raw result of PAGE_PROBE before the worker resolves link destinations. */
export interface PageProbeResult {
  lang: string | null; title: string; scrollWidth: number; clientWidth: number; viewportWidth: number;
  headings: { level: number; text: string }[];
  /** Size of the control's pointer target: the wrapping label for an input inside one (React95 checkboxes and radios). */
  controls: { selector: string; role: string; name: string; width: number; height: number }[];
  texts: { selector: string; text: string; color: [number, number, number, number]; background: [number, number, number, number] | null; fontSizePx: number; fontWeight: number; targetKeys: string[] }[];
  /** True when the probe stopped at MAX_TEXT_SAMPLES with text nodes left unvisited. */
  textsTruncated: boolean;
  clipped: { selector: string; scrollWidth: number; clientWidth: number; axis: 'x'; targetKeys: string[] }[];
  outsideViewport: { selector: string; left: number; right: number; targetKeys: string[] }[];
  actions: {
    selector: string; kind: 'link' | 'button' | 'form'; name: string; visible: boolean; disabled: boolean; width: number; height: number; inline: boolean;
    href: string | null; link: { kind: 'same-origin'; path: string } | { kind: 'fragment'; found: boolean } | { kind: 'external' | 'mailto' | 'tel' | 'script' | 'empty' } | null;
    targetKeys: string[];
    /** Private, in-memory only: how the click probe finds this action again after reloading (see CLICK_PROBE). */
    fingerprint: ActionFingerprint;
  }[];
  fonts: { family: string; status: 'loaded' | 'error' | 'unloaded' | 'loading' }[];
  focusableCount: number;
  /** B5-1 (AC-R06.5): behavior counts with sample selectors; null for a behavior the page cannot report. */
  behaviors?: Record<'dialog' | 'tabs' | 'text-input' | 'form' | 'button' | 'image' | 'animation', { count: number; samples: string[] } | null>;
}

/**
 * An action's identity across a reload: tag, role, accessible name, href or
 * action, form owner (as its own action, method and name), plus its ordinal
 * within the group of same-kind elements sharing that key and the group's size
 * at capture. A repeated CTA (header and hero) is one group; each member is
 * probed by its ordinal. It holds page text, so it never leaves the daemon's
 * memory: it only goes back into the page.
 */
export interface ActionFingerprint { key: string; ordinal: number; size: number }

/** Text elements PAGE_PROBE measures per viewport; reaching it with text left is recorded as truncation. */
export const MAX_TEXT_SAMPLES = 1000;

const HELPERS = String.raw`
const R = window.__odReview || (window.__odReview = { sig: new WeakMap() });
const canvas = document.createElement('canvas'); canvas.width = 1; canvas.height = 1;
const ctx = canvas.getContext('2d', { willReadFrequently: true });
const rgba = (value) => {
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/i.exec(value || '');
  if (m) { const a = m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]); return [+m[1], +m[2], +m[3], a]; }
  if (!value || value === 'transparent') return [0, 0, 0, 0];
  ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = '#000'; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1);
  const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255];
};
const over = (top, bottom) => { const a = top[3]; return [top[0] * a + bottom[0] * (1 - a), top[1] * a + bottom[1] * (1 - a), top[2] * a + bottom[2] * (1 - a), 1]; };
// Structural only (Sol rounds 7 and 8): a path from <body> of known-tag
// tag:nth-of-type parts; an element outside the tag vocabulary (a custom
// element) is a positional *:nth-child(n) wildcard. Ids, classes and custom tag
// names are page-chosen and never part of a selector; the daemon re-checks the
// grammar (evidenceSelector) because the page can tamper with this code.
const KNOWN_TAGS = new Set(${JSON.stringify(REVIEW_TAG_NAMES)});
const selectorOf = (el) => {
  const parts = []; let node = el;
  while (node && node.nodeType === 1 && node !== document.documentElement && parts.length < 40) {
    const tag = node.tagName.toLowerCase();
    const parent = node.parentElement;
    let part = tag;
    if (!KNOWN_TAGS.has(tag)) part = '*:nth-child(' + (parent ? Array.from(parent.children).indexOf(node) + 1 : 1) + ')';
    else if (parent) { const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName); if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'; }
    parts.unshift(part); node = parent;
  }
  return parts.join(' > ').slice(0, 1000);
};
const hiddenTree = (el) => !!el.closest('[aria-hidden="true"],[inert],template,script,style,noscript');
const effectiveOpacity = (el) => { let o = 1; for (let n = el; n && n.nodeType === 1; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity || '1'); return o; };
const isVisible = (el) => {
  if (!el.isConnected || hiddenTree(el)) return false;
  const s = getComputedStyle(el);
  if (s.display === 'none' || s.visibility === 'hidden' || s.visibility === 'collapse') return false;
  if (effectiveOpacity(el) === 0) return false;
  const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0;
};
const textOf = (el) => (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
const nameOf = (el) => {
  const by = el.getAttribute('aria-labelledby');
  if (by) { const t = by.split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(' ').trim(); if (t) return t; }
  const aria = (el.getAttribute('aria-label') || '').trim(); if (aria) return aria;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (tag === 'INPUT' && ['submit', 'button', 'reset'].includes(type)) return (el.value || (type === 'submit' ? 'Submit' : type === 'reset' ? 'Reset' : '')).trim();
    if (tag === 'INPUT' && type === 'image') return (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
    const labels = el.labels ? Array.from(el.labels).map(textOf).join(' ').trim() : ''; if (labels) return labels;
    return (el.getAttribute('title') || el.getAttribute('placeholder') || '').trim();
  }
  if (tag === 'IMG') return (el.getAttribute('alt') || el.getAttribute('title') || '').trim();
  if (tag === 'FORM') { const legend = el.querySelector('legend, h1, h2, h3, h4'); return legend ? textOf(legend) : (el.getAttribute('title') || el.id || '').trim(); }
  const text = textOf(el); if (text) return text;
  const img = el.querySelector('img[alt]:not([alt=""]), svg title'); if (img) return (img.getAttribute('alt') || img.textContent || '').trim();
  return (el.getAttribute('title') || '').trim();
};
const sig = (el) => { const s = getComputedStyle(el); return [s.outlineStyle, s.outlineWidth, s.outlineColor, s.boxShadow, s.backgroundColor, s.borderTopColor, s.borderBottomColor, s.color, s.textDecorationLine].join('|'); };
const TABBABLE = 'a[href],area[href],button,input:not([type="hidden"]),select,textarea,summary,iframe,audio[controls],video[controls],[contenteditable=""],[contenteditable="true"],[tabindex]';
/** A visually hidden native input inside a visible label is still a real tab stop and pointer target (its label). */
const labelledHiddenInput = (el) => el.tagName === 'INPUT' && !isVisible(el) && !!el.closest('label') && isVisible(el.closest('label'));
const operable = (el) => isVisible(el) || labelledHiddenInput(el);
/** An input inside a label is activated through the whole label, so the label is its pointer target. */
const pointerTargetOf = (el) => el.tagName === 'INPUT' && el.closest('label') ? el.closest('label') : el;
const tabbables = () => Array.from(document.querySelectorAll(TABBABLE)).filter((el) => el.tabIndex >= 0 && !el.disabled && operable(el));
const ACTION_QUERY = { link: 'a[href],area[href]', button: 'button,input[type="button"],input[type="submit"],input[type="image"],[role="button"]:not(a):not(button)', form: 'form' };
const formKey = (form) => [form.getAttribute('action') || '', (form.getAttribute('method') || '').toLowerCase(), form.getAttribute('name') || '', nameOf(form).slice(0, 200)].join('|');
const actionKey = (el, kind) => JSON.stringify([kind, el.tagName.toLowerCase(), el.getAttribute('role') || '', nameOf(el).slice(0, 200), el.getAttribute('href') || '',
  kind === 'form' ? formKey(el) : (el.getAttribute('formaction') || '') + '|' + (el.getAttribute('formmethod') || ''), kind !== 'form' && el.form ? formKey(el.form) : '']);
const fingerprintOf = (el, kind) => {
  const key = actionKey(el, kind);
  const same = Array.from(document.querySelectorAll(ACTION_QUERY[kind])).filter((other) => actionKey(other, kind) === key);
  return { key, ordinal: same.indexOf(el), size: same.length };
};
`;

/** Collects DOM evidence for one viewport. Argument: TargetRequest[]. */
export const PAGE_PROBE = String.raw`(targets) => {
${HELPERS}
  const W = window.innerWidth;
  const keysFor = (el, actionLike) => targets.filter((t) => {
    try { if (t.selector && el.closest(t.selector)) return true; } catch (e) { /* invalid selector never matches */ }
    if (actionLike && t.href && el.tagName === 'A') { try { if (new URL(t.href, location.href).href === el.href) return true; } catch (e) {} }
    if (actionLike && t.label && nameOf(el).toLowerCase() === t.label.trim().toLowerCase()) return true;
    return false;
  }).map((t) => t.key);

  const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"]')).filter((el) => !hiddenTree(el) && getComputedStyle(el).display !== 'none')
    .map((el) => ({ level: /^H[1-6]$/.test(el.tagName) ? Number(el.tagName[1]) : Number(el.getAttribute('aria-level') || 2), text: textOf(el).slice(0, 200) }));

  const CONTROL = 'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role="button"],[role="link"],[role="checkbox"],[role="radio"],[role="switch"],[role="tab"],[role="menuitem"],[role="combobox"],[role="textbox"],[role="slider"]';
  const controls = Array.from(document.querySelectorAll(CONTROL)).filter(operable).slice(0, 400)
    .map((el) => { const box = pointerTargetOf(el).getBoundingClientRect(); return { selector: selectorOf(el), role: el.getAttribute('role') || el.tagName.toLowerCase(), name: nameOf(el).slice(0, 200), width: box.width, height: box.height }; });

  const backgroundOf = (el, rect) => {
    const layers = []; const seen = new Set();
    const push = (node) => {
      if (seen.has(node)) return 'continue'; seen.add(node);
      const s = getComputedStyle(node);
      if ((s.filter && s.filter !== 'none') || (s.mixBlendMode && s.mixBlendMode !== 'normal') || (s.backdropFilter && s.backdropFilter !== 'none')) return 'unknown';
      if (/^(IMG|VIDEO|CANVAS|PICTURE|svg|IFRAME|OBJECT|EMBED)$/.test(node.tagName) && node !== el) return 'unknown';
      if (s.backgroundImage && s.backgroundImage !== 'none') return 'unknown';
      const c = rgba(s.backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) return 'opaque'; }
      return 'continue';
    };
    const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
    let stack = null;
    if (cx >= 0 && cy >= 0 && cx < window.innerWidth && cy < window.innerHeight && document.elementsFromPoint) {
      stack = document.elementsFromPoint(cx, cy).filter((node) => node === el || !el.contains(node));
      const at = stack.indexOf(el); stack = at >= 0 ? stack.slice(at) : null;
    }
    const chain = stack || (() => { const list = []; for (let n = el; n && n.nodeType === 1; n = n.parentElement) list.push(n); return list; })();
    for (const node of chain) { const r = push(node); if (r === 'unknown') return null; if (r === 'opaque') break; }
    let color = [255, 255, 255, 1];
    for (let i = layers.length - 1; i >= 0; i--) color = over(layers[i], color);
    return color;
  };

  const texts = []; const outsideViewport = []; const sampled = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  for (; node && texts.length < ${MAX_TEXT_SAMPLES}; node = walker.nextNode()) {
    const el = node.parentElement; if (!el || sampled.has(el) || !node.textContent.trim()) continue;
    if (el.closest('script,style,noscript,template,[disabled]') || !isVisible(el)) continue;
    sampled.add(el);
    const range = document.createRange(); range.selectNodeContents(node);
    const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 && r.height > 0);
    if (!rects.length) continue;
    const box = { left: Math.min(...rects.map((r) => r.left)), right: Math.max(...rects.map((r) => r.right)), top: rects[0].top, width: rects[0].width, height: rects[0].height };
    const s = getComputedStyle(el); const fg = rgba(s.color); fg[3] *= effectiveOpacity(el);
    const keys = keysFor(el, false);
    texts.push({ selector: selectorOf(el), text: node.textContent.replace(/\s+/g, ' ').trim().slice(0, 80), color: fg, background: backgroundOf(el, rects[0]), fontSizePx: parseFloat(s.fontSize) || 16, fontWeight: parseInt(s.fontWeight, 10) || 400, targetKeys: keys });
    if (box.right > W + 0.5 || box.left < -0.5) outsideViewport.push({ selector: selectorOf(el), left: Math.round(box.left), right: Math.round(box.right), targetKeys: keys });
  }

  // Stopping at the cap with non-blank text left means some text was never measured.
  while (node && !node.textContent.trim()) node = walker.nextNode();
  const textsTruncated = !!node;

  const clipped = [];
  for (const el of Array.from(document.querySelectorAll('body *'))) {
    if (clipped.length >= 100) break;
    const s = getComputedStyle(el);
    if (!(s.overflowX === 'hidden' || s.overflowX === 'clip') || hiddenTree(el)) continue;
    if (el.scrollWidth > el.clientWidth + 1 && textOf(el) && isVisible(el)) clipped.push({ selector: selectorOf(el), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, axis: 'x', targetKeys: keysFor(el, false) });
  }

  const linkOf = (a) => {
    const raw = a.getAttribute('href'); if (raw === null) return null;
    const trimmed = raw.trim(); if (!trimmed || trimmed === '#') return { kind: 'empty' };
    if (/^javascript:/i.test(trimmed)) return { kind: 'script' };
    let url; try { url = new URL(trimmed, location.href); } catch (e) { return { kind: 'empty' }; }
    if (url.protocol === 'mailto:') return { kind: 'mailto' };
    if (url.protocol === 'tel:') return { kind: 'tel' };
    if (url.origin !== location.origin) return { kind: 'external' };
    if (url.pathname === location.pathname && url.search === location.search && url.hash) {
      const id = decodeURIComponent(url.hash.slice(1));
      return { kind: 'fragment', found: id === 'top' || !!document.getElementById(id) || document.getElementsByName(id).length > 0 };
    }
    return { kind: 'same-origin', path: url.pathname };
  };
  const describe = (el, kind) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return { selector: selectorOf(el), kind, name: nameOf(el).slice(0, 200), visible: isVisible(el), disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
      width: r.width, height: r.height, inline: kind === 'link' && s.display === 'inline', href: kind === 'link' ? el.getAttribute('href') : null,
      link: kind === 'link' ? linkOf(el) : null, targetKeys: keysFor(el, true), fingerprint: fingerprintOf(el, kind) };
  };
  const actions = [];
  for (const el of Array.from(document.querySelectorAll('a[href],area[href]'))) actions.push(describe(el, 'link'));
  for (const el of Array.from(document.querySelectorAll('button,input[type="button"],input[type="submit"],input[type="image"],[role="button"]:not(a):not(button)'))) {
    if (el.form || el.closest('form')) { if (!keysFor(el, true).length) continue; }
    actions.push(describe(el, 'button'));
  }
  for (const el of Array.from(document.querySelectorAll('form'))) actions.push(describe(el, 'form'));

  const fonts = document.fonts ? Array.from(document.fonts).map((f) => ({ family: f.family.replace(/^["']|["']$/g, ''), status: f.status })) : [];
  const focusables = tabbables();
  for (const el of focusables) R.sig.set(el, sig(el));
  // B5-1: which behaviors the page has (dialogs count even while closed: the page supports them).
  const counted = (selector, keep) => { try {
    const found = Array.from(document.querySelectorAll(selector)).filter((el) => !el.closest('template,script,style,noscript') && (!keep || keep(el)));
    return { count: found.length, samples: found.slice(0, 5).map(selectorOf) };
  } catch (e) { return null; } };
  const animations = (() => { try {
    if (typeof document.getAnimations !== 'function') return null;
    const running = document.getAnimations().filter((a) => a.playState === 'running' || a.playState === 'pending');
    return { count: running.length, samples: running.slice(0, 5).map((a) => (a.effect && a.effect.target ? selectorOf(a.effect.target) : (a.animationName || a.transitionProperty || 'animation'))) };
  } catch (e) { return null; } })();
  const behaviors = {
    dialog: counted('dialog,[role="dialog"],[role="alertdialog"],[aria-modal="true"]'),
    tabs: counted('[role="tab"]', isVisible),
    'text-input': counted('input:not([type]),input[type="text"],input[type="email"],input[type="search"],input[type="tel"],input[type="url"],input[type="password"],input[type="number"],textarea,select,[role="textbox"],[role="combobox"],[role="searchbox"],[contenteditable="true"]', isVisible),
    form: counted('form'),
    button: counted('button,input[type="button"],input[type="submit"],input[type="reset"],[role="button"]', isVisible),
    image: counted('img,[role="img"],svg[aria-label],input[type="image"]', isVisible),
    animation: animations,
  };
  const root = document.documentElement;
  return { lang: root.getAttribute('lang'), title: document.title || '', scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, viewportWidth: W,
    headings, controls, texts, textsTruncated, clipped, outsideViewport, actions: actions.slice(0, 200), fonts, focusableCount: focusables.length, behaviors };
}`;

/** Grid the visual probe samples painted surfaces on (columns × rows over the first viewport). */
export const VISUAL_GRID = { columns: 24, rows: 20 } as const;
/** Elements the visual probe inspects for borders, shadows and boxes; more are not read. */
export const MAX_VISUAL_ELEMENTS = 3000;

/** Raw result of VISUAL_PROBE (page-influenced; the worker validates every field). */
export interface VisualProbeResult {
  surfaces: { color: [number, number, number, number]; count: number }[];
  media: number; samples: number;
  fonts: { family: string; count: number }[];
  borders: { bevel: number; other: number; rounded: number; maxRadiusPx: number };
  effects: { shadows: number; hardShadows: number; insetShadows: number; gradients: number; backgroundImages: number };
  boxes: { selector: string; x: number; y: number; width: number; height: number; background: [number, number, number, number] | null }[];
  documentHeight: number;
}

/**
 * R03 visual facts for one viewport: what the first viewport paints, measured
 * from computed styles. Painted surfaces are sampled on a grid with
 * elementsFromPoint (the first opaque background in the stack, composited over
 * the canvas colour, which follows CSS background propagation; an image,
 * gradient or media element counts as media). Fonts are the
 * declared font-family of sampled text elements. Read-only.
 */
export const VISUAL_PROBE = String.raw`() => {
${HELPERS}
  const W = window.innerWidth, H = window.innerHeight;
  const MEDIA = /^(IMG|VIDEO|CANVAS|PICTURE|IFRAME|OBJECT|EMBED|svg)$/;
  const surfaces = new Map(); let media = 0; let samples = 0;
  // The canvas paints the root background, or the body's when the root has none (CSS background propagation).
  const rootStyle = getComputedStyle(document.documentElement); const bodyStyle = document.body ? getComputedStyle(document.body) : null;
  const rootBg = rgba(rootStyle.backgroundColor);
  const canvasStyle = rootBg[3] > 0 || (rootStyle.backgroundImage && rootStyle.backgroundImage !== 'none') || !bodyStyle ? rootStyle : bodyStyle;
  const canvasUnknown = !!canvasStyle.backgroundImage && canvasStyle.backgroundImage !== 'none';
  const canvasColor = over(rgba(canvasStyle.backgroundColor), [255, 255, 255, 1]);
  for (let row = 0; row < ${VISUAL_GRID.rows}; row++) for (let col = 0; col < ${VISUAL_GRID.columns}; col++) {
    const x = (col + 0.5) * W / ${VISUAL_GRID.columns}, y = (row + 0.5) * H / ${VISUAL_GRID.rows};
    const stack = document.elementsFromPoint ? document.elementsFromPoint(x, y) : [];
    samples++;
    const layers = []; let unknown = false;
    for (const node of stack) {
      if (MEDIA.test(node.tagName)) { unknown = true; break; }
      const st = getComputedStyle(node);
      if (st.backgroundImage && st.backgroundImage !== 'none') { unknown = true; break; }
      const c = rgba(st.backgroundColor); if (c[3] > 0) { layers.push(c); if (c[3] >= 1) break; }
    }
    if (unknown || (!layers.length && canvasUnknown)) { media++; continue; }
    let color = canvasColor;
    for (let i = layers.length - 1; i >= 0; i--) color = over(layers[i], color);
    const key = color.slice(0, 3).map((v) => Math.round(v)).join(',');
    const seen = surfaces.get(key); if (seen) seen.count++; else surfaces.set(key, { color: [Math.round(color[0]), Math.round(color[1]), Math.round(color[2]), 1], count: 1 });
  }

  const fonts = new Map(); const sampled = new Set();
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node && sampled.size < 400; node = walker.nextNode()) {
    const el = node.parentElement; if (!el || sampled.has(el) || !node.textContent.trim()) continue;
    if (el.closest('script,style,noscript,template') || !isVisible(el)) continue;
    sampled.add(el);
    const family = getComputedStyle(el).fontFamily.slice(0, 200);
    fonts.set(family, (fonts.get(family) || 0) + 1);
  }

  const borders = { bevel: 0, other: 0, rounded: 0, maxRadiusPx: 0 };
  const effects = { shadows: 0, hardShadows: 0, insetShadows: 0, gradients: 0, backgroundImages: 0 };
  const boxes = []; let inspected = 0;
  for (const el of Array.from(document.querySelectorAll('body, body *'))) {
    if (inspected >= ${MAX_VISUAL_ELEMENTS}) break;
    if (!isVisible(el)) continue;
    inspected++;
    const st = getComputedStyle(el);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].filter((side) => st['border' + side + 'Style'] !== 'none' && st['border' + side + 'Style'] !== 'hidden' && parseFloat(st['border' + side + 'Width']) > 0);
    if (sides.length) { if (sides.some((side) => /^(outset|inset|ridge|groove)$/.test(st['border' + side + 'Style']))) borders.bevel++; else borders.other++; }
    const radius = Math.max(...['TopLeft', 'TopRight', 'BottomLeft', 'BottomRight'].map((corner) => parseFloat(st['border' + corner + 'Radius']) || 0));
    if (radius > 0) { borders.rounded++; borders.maxRadiusPx = Math.max(borders.maxRadiusPx, radius); }
    if (st.boxShadow && st.boxShadow !== 'none') {
      effects.shadows++;
      const shadows = st.boxShadow.split(/,(?![^(]*\))/);
      if (shadows.every((shadow) => { const lengths = (shadow.replace(/rgba?\([^)]*\)/g, '').match(/-?[\d.]+px/g) || []).map(parseFloat); return (lengths[2] || 0) === 0; })) effects.hardShadows++;
      if (shadows.some((shadow) => /\binset\b/.test(shadow))) effects.insetShadows++;
    }
    if (st.backgroundImage && st.backgroundImage !== 'none') { if (/gradient\(/.test(st.backgroundImage)) effects.gradients++; if (/url\(/.test(st.backgroundImage)) effects.backgroundImages++; }
    const r = el.getBoundingClientRect();
    const w = Math.min(r.right, W) - Math.max(r.left, 0), h = Math.min(r.bottom, H) - Math.max(r.top, 0);
    if (w > 0 && h > 0 && w * h >= 0.04 * W * H && el !== document.body) {
      const bg = rgba(st.backgroundColor);
      boxes.push({ selector: selectorOf(el), x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), background: bg[3] > 0 ? bg : null, area: w * h });
    }
  }
  boxes.sort((a, b) => b.area - a.area);
  // Nested wrappers often share one box; keep the outermost of identical boxes.
  const distinct = []; const seenBox = new Set();
  for (const box of boxes) { const key = [box.x, box.y, box.width, box.height].join(','); if (seenBox.has(key)) continue; seenBox.add(key); distinct.push(box); if (distinct.length >= 6) break; }
  return {
    surfaces: Array.from(surfaces.values()).sort((a, b) => b.count - a.count).slice(0, 12), media, samples,
    fonts: Array.from(fonts, ([family, count]) => ({ family, count })).sort((a, b) => b.count - a.count).slice(0, 12),
    borders, effects,
    boxes: distinct.map((box) => ({ selector: box.selector, x: box.x, y: box.y, width: box.width, height: box.height, background: box.background })),
    documentHeight: document.documentElement.scrollHeight,
  };
}`;

/** Describes document.activeElement after a Tab press. */
export const FOCUS_STEP = String.raw`() => {
${HELPERS}
  const el = document.activeElement;
  if (!el || el === document.body || el === document.documentElement) return { selector: null, focusVisible: false, documentIndex: -1 };
  const s = getComputedStyle(el);
  const before = R.sig.get(el);
  const outline = s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) > 0;
  const changed = before !== undefined && before !== sig(el);
  const ring = before === undefined && s.boxShadow && s.boxShadow !== 'none';
  return { selector: selectorOf(el), focusVisible: !!(outline || changed || ring), documentIndex: Array.prototype.indexOf.call(document.getElementsByTagName('*'), el) };
}`;

/**
 * Clicks one button or submits one form with inert test values, then reports
 * what changed. Arguments: selector, kind, fingerprint. The reloaded page may
 * differ from the one the selector came from (a sibling inserted on reload
 * shifts every positional selector; a decoy can copy every visible property),
 * so the click happens only when the action's fingerprint group has the same
 * size as at capture and the selector resolves to the group member at the
 * action's ordinal. Every member of a group is its own action, probed after
 * its own reload, so a repeated CTA is verified only when each member shows an
 * effect with the group stable throughout. Otherwise nothing is clicked:
 * `missing` (no element carries it), `ambiguous` (the group size changed, as
 * when a decoy is inserted) or `relocated` (the selector lands elsewhere).
 * Known limitation (Sol round 10): members of a group are indistinguishable
 * by design, so a page that reorders them on reload without changing the
 * group size (for example, swapping an inert copy and a working copy whose
 * structural positions also swap) is not detected.
 */
export const CLICK_PROBE = String.raw`async (selector, kind, fingerprint) => {
${HELPERS}
  if (!fingerprint || typeof fingerprint.key !== 'string' || !ACTION_QUERY[kind]) return { target: 'missing', domMutations: 0, navigated: false, error: null };
  const candidates = Array.from(document.querySelectorAll(ACTION_QUERY[kind])).filter((other) => actionKey(other, kind) === fingerprint.key);
  let resolved = null; try { resolved = document.querySelector(selector); } catch (e) { resolved = null; }
  const unclicked = (target) => ({ target, domMutations: 0, navigated: false, error: null });
  if (candidates.length === 0) return unclicked('missing');
  if (candidates.length !== fingerprint.size || !(fingerprint.ordinal >= 0 && fingerprint.ordinal < candidates.length)) return unclicked('ambiguous');
  const el = candidates[fingerprint.ordinal];
  if (resolved !== el) return unclicked('relocated');
  const target = 'same';
  const fill = (form) => {
    for (const input of Array.from(form.querySelectorAll('input,select,textarea'))) {
      if (input.disabled || input.readOnly) continue;
      const type = (input.getAttribute('type') || input.tagName).toLowerCase();
      const set = (value) => { input.value = value; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
      if (['hidden', 'submit', 'button', 'reset', 'image', 'file'].includes(type)) continue;
      if (type === 'checkbox' || type === 'radio') { if (input.required && !input.checked) { input.checked = true; input.dispatchEvent(new Event('change', { bubbles: true })); } continue; }
      if (input.tagName === 'SELECT') { const option = Array.from(input.options).find((o) => o.value && !o.disabled); if (option) set(option.value); continue; }
      if (input.value) continue;
      set(type === 'email' ? 'review-probe@example.invalid' : type === 'tel' ? '5555550100' : type === 'url' ? 'https://example.invalid/' : type === 'number' || type === 'range' ? (input.min || '1') : type === 'date' ? '2026-01-15' : type === 'time' ? '10:00' : type === 'color' ? '#336699' : 'Review probe');
    }
  };
  let mutations = 0; let error = null;
  const observer = new MutationObserver((list) => { mutations += list.length; });
  const onError = (event) => { error = String((event && (event.message || (event.reason && event.reason.message) || event.reason)) || 'error'); };
  window.addEventListener('error', onError); window.addEventListener('unhandledrejection', onError);
  const start = location.href;
  try {
    if (kind === 'form') {
      fill(el);
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      const submit = el.querySelector('button:not([type="button"]):not([type="reset"]),input[type="submit"],input[type="image"]');
      if (submit) submit.click(); else el.requestSubmit();
    } else {
      observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
      el.click();
    }
  } catch (e) { error = String((e && e.message) || e); }
  await new Promise((resolve) => setTimeout(resolve, 400));
  observer.disconnect();
  return { target, domMutations: mutations, navigated: location.href !== start, error };
}`;

/** Elements MOTION_SAMPLE compares per sample. */
export const MAX_MOTION_ELEMENTS = 3000;

/**
 * One motion sample (B4-2b). Compares every element's rendered box, opacity
 * and scroll offset with the previous sample of the same window (argument
 * `reset` starts a window) and lists running animations/transitions on
 * visible elements. Visual presence only: aria-hidden carousel slides still
 * move on screen, so they count. Read-only.
 */
export const MOTION_SAMPLE = String.raw`(reset, viewportWidth, viewportHeight) => {
${HELPERS}
  if (reset || !R.motion) R.motion = new WeakMap();
  const now = performance.now();
  const shown = (el) => { const s = getComputedStyle(el); return s.display !== 'none' && s.visibility === 'visible' && effectiveOpacity(el) > 0; };
  const fnv = (text) => { let h = 0x811c9dc5; for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36) + ':' + text.length; };
  const moved = [];
  for (const el of Array.from(document.querySelectorAll('body *')).slice(0, ${MAX_MOTION_ELEMENTS})) {
    if (/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(el.tagName)) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    // Round 4: paint changes without a box change (a background swap, a filter or clip) are movement too. The signature
    // stays in this page's WeakMap for comparison only; it is never returned or persisted.
    const sig = s.display === 'none' ? 'none' : [r.left, r.top, r.width, r.height].map((v) => Math.round(v * 2) / 2).join(',') + '|' + s.opacity + '|' + s.visibility + '|' + el.scrollLeft + ',' + el.scrollTop
      + '|' + s.backgroundImage + '|' + s.backgroundPosition + '|' + s.backgroundColor + '|' + s.filter + '|' + s.clipPath + '|' + s.transform
      // Round 5: an image or video source swap and generated content are paint changes too.
      + '|' + (typeof el.currentSrc === 'string' ? el.currentSrc : el.tagName === 'SOURCE' ? String(el.src || '') : '') + '|' + s.content + '|' + getComputedStyle(el, '::before').content + '|' + getComputedStyle(el, '::after').content;
    // Only a digest of the signature is kept (a data: URL source can be large); it never leaves the page.
    const digest = fnv(sig);
    const before = R.motion.get(el);
    if (before !== undefined && before !== digest) moved.push(el);
    R.motion.set(el, digest);
  }
  const outer = moved.filter((el) => !moved.some((other) => other !== el && other.contains(el)));
  const animations = [];
  for (const a of (document.getAnimations ? document.getAnimations() : [])) {
    if (animations.length >= 10) break;
    if (a.playState !== 'running' || !a.effect) continue;
    const target = a.effect.target;
    if (!target || target.nodeType !== 1 || !target.isConnected || !shown(target)) continue;
    const rect = target.getBoundingClientRect(); if (!(rect.width > 0 && rect.height > 0)) continue;
    if (a.effect.getKeyframes) {
      const values = new Map();
      for (const frame of a.effect.getKeyframes()) for (const [property, value] of Object.entries(frame)) {
        if (['offset', 'computedOffset', 'easing', 'composite'].includes(property)) continue;
        const entry = values.get(property) || values.set(property, { seen: 0, distinct: new Set() }).get(property);
        entry.seen++; entry.distinct.add(String(value));
      }
      // N2: skip only when every property is given in two or more keyframes with one value; a property given once
      // animates from or to the underlying value, so it may change something.
      if (values.size && ![...values.values()].some((entry) => entry.seen < 2 || entry.distinct.size > 1)) continue;
    }
    const timing = a.effect.getComputedTiming ? a.effect.getComputedTiming() : {};
    animations.push({ selector: selectorOf(target), name: String(a.animationName || a.transitionProperty || a.id || 'animation').slice(0, 80), iterations: Number.isFinite(timing.iterations) ? timing.iterations : null });
  }
  // B2: what the sampler cannot see. Pixels are compared for the viewport only, so a canvas, video, possibly
  // animated image or frame outside it is unmeasured; so are running animation-frame loops and timers (TIMER_TRACKER).
  const unmeasured = [];
  // NB3: the daemon's emulated viewport, never the page's (possibly redefined) innerWidth/innerHeight.
  const VW = viewportWidth, VH = viewportHeight;
  for (const el of Array.from(document.querySelectorAll('canvas,video,iframe,embed,object,img'))) {
    if (unmeasured.length >= 5) break;
    if (!shown(el)) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || !(r.bottom <= 0 || r.top >= VH || r.right <= 0 || r.left >= VW)) continue;
    if (el.tagName === 'IMG' && !/\.(gif|webp|apng)(?:[?#]|$)|^data:image\/(gif|webp|apng)/i.test(el.currentSrc || el.src || '')) continue;
    if (el.tagName === 'VIDEO' && el.paused && !el.autoplay) continue;
    unmeasured.push({ kind: 'offscreen', element: el.tagName, selector: selectorOf(el) });
  }
  // Realms whose timers the tracker cannot see (NB1 defence in depth): same-origin frames and Web Workers.
  for (const frame of Array.from(document.querySelectorAll('iframe,frame'))) {
    if (unmeasured.length >= 6) break;
    let sameOrigin = false; try { sameOrigin = !!(frame.contentWindow && frame.contentWindow.document); } catch (e) { sameOrigin = false; }
    if (sameOrigin) unmeasured.push({ kind: 'frame', selector: selectorOf(frame) });
  }
  const read = window.__odMotionRead;
  const T = typeof read === 'function' ? read() : null;
  let timers = [];
  if (T) {
    if (T.rafAt >= 0 && now - T.rafAt < 1000) unmeasured.push({ kind: 'raf' });
    if (T.workers > 0) unmeasured.push({ kind: 'workers', count: T.workers });
    if (T.truncated) unmeasured.push({ kind: 'timers-truncated' });
    timers = T.timers;
  } else unmeasured.push({ kind: 'tracker-missing' });
  return { now, moved: outer.slice(0, 10).map(selectorOf), animations, unmeasured, timers };
}`;

/**
 * Main-world timer bookkeeping for the motion phases only (installed with
 * Page.addScriptToEvaluateOnNewDocument before the first motion load, never
 * for the other checks). Timer sources are keyed by their callback; each
 * keeps its recent firing times, active intervals and pending timeouts. It
 * also records the last requestAnimationFrame call and counts Web Workers.
 * The state lives in this closure; the page can only call the frozen,
 * non-configurable reader `__odMotionRead`, which returns copies. Every call
 * passes through unchanged.
 */
export const TIMER_TRACKER = String.raw`(() => {
  if (Object.prototype.hasOwnProperty.call(window, '__odMotionRead')) return;
  const sources = new Map(); const byId = new Map(); const fnKeys = new WeakMap(); const textKeys = new Map();
  let seq = 0; let rafAt = -1; let workers = 0;
  const keyFor = (fn, kind) => {
    if (typeof fn === 'function') { let key = fnKeys.get(fn); if (!key) { key = kind + ':' + (++seq); fnKeys.set(fn, key); } return key; }
    const text = String(fn).slice(0, 200); let key = textKeys.get(text); if (!key) { key = kind + ':' + (++seq); textKeys.set(text, key); } return key;
  };
  const sourceFor = (key, kind) => { let source = sources.get(key); if (!source) { source = { kind, fires: [], pending: new Map(), intervals: new Set() }; sources.set(key, source); } return source; };
  const fired = (source) => { source.fires.push(performance.now()); if (source.fires.length > 30) source.fires.shift(); };
  const st = window.setTimeout, si = window.setInterval, ct = window.clearTimeout, ci = window.clearInterval, raf = window.requestAnimationFrame;
  const wrap = (fn, source, done) => typeof fn === 'function'
    ? function () { done(); fired(source); return fn.apply(this, arguments); }
    : function () { done(); fired(source); return (0, eval)(String(fn)); };
  window.setTimeout = function (fn, ms, ...rest) {
    const source = sourceFor(keyFor(fn, 'timeout'), 'timeout'); let id = 0;
    id = st.call(window, wrap(fn, source, () => { source.pending.delete(id); byId.delete(id); }), ms, ...rest);
    source.pending.set(id, performance.now() + Math.max(0, Number(ms) || 0)); byId.set(id, source);
    return id;
  };
  window.setInterval = function (fn, ms, ...rest) {
    const source = sourceFor(keyFor(fn, 'interval'), 'interval');
    const id = si.call(window, wrap(fn, source, () => undefined), ms, ...rest);
    source.intervals.add(id); byId.set(id, source);
    return id;
  };
  const clear = (id) => { const source = byId.get(id); if (source) { source.pending.delete(id); source.intervals.delete(id); byId.delete(id); } };
  window.clearTimeout = function (id) { clear(id); return ct.call(window, id); };
  window.clearInterval = function (id) { clear(id); return ci.call(window, id); };
  if (raf) window.requestAnimationFrame = function (cb) { rafAt = performance.now(); return raf.call(window, cb); };
  const counted = (Base) => {
    if (typeof Base !== 'function') return Base;
    const Counted = function (...args) {
      const worker = new Base(...args); workers++;
      const terminate = worker.terminate;
      if (typeof terminate === 'function') worker.terminate = function () { workers = Math.max(0, workers - 1); return terminate.call(worker); };
      return worker;
    };
    Counted.prototype = Base.prototype;
    return Counted;
  };
  window.Worker = counted(window.Worker);
  window.SharedWorker = counted(window.SharedWorker);
  const read = Object.freeze(function () {
    const timers = []; let truncated = false;
    for (const [key, source] of sources) {
      if (!source.intervals.size && !source.pending.size) continue;
      if (timers.length >= 20) { truncated = true; break; }
      let next = null; for (const due of source.pending.values()) if (next === null || due < next) next = due;
      timers.push({ key, kind: source.intervals.size ? 'interval' : 'timeout', fires: source.fires.slice(), nextDueMs: source.intervals.size ? null : next });
    }
    return { rafAt, workers, timers, truncated };
  });
  Object.defineProperty(window, '__odMotionRead', { value: read, writable: false, configurable: false, enumerable: false });
})()`;

/**
 * The deepest focused element: through open shadow roots and same-origin
 * frames (W2). Its selector joins each host's selector with " >>> ". Only
 * button-like controls are activatable (W1): buttons that cannot submit,
 * checkbox or button inputs, summary, role button/switch/checkbox, and a
 * role=button link whose href is a fragment only. Text inputs (Enter submits
 * a form implicitly), reset and submit controls and contenteditable never are.
 */
export const FOCUSED_CONTROL = String.raw`() => {
${HELPERS}
  let el = document.activeElement; const path = [];
  for (let depth = 0; el && depth < 10; depth++) {
    if (el.shadowRoot && el.shadowRoot.activeElement) { path.push(selectorOf(el)); el = el.shadowRoot.activeElement; continue; }
    if (el.tagName === 'IFRAME') {
      let inner = null; try { inner = el.contentDocument && el.contentDocument.activeElement; } catch (e) { inner = null; }
      if (inner && inner !== el.contentDocument.body && inner !== el.contentDocument.documentElement) { path.push(selectorOf(el)); el = inner; continue; }
    }
    break;
  }
  if (!el || el === document.body || el === document.documentElement) return null;
  const role = (el.getAttribute('role') || '').toLowerCase();
  const type = (el.getAttribute('type') || '').toLowerCase();
  const tag = el.tagName;
  const href = el.getAttribute('href');
  let activatable = false;
  if (el.isContentEditable) activatable = false;
  else if (tag === 'BUTTON') activatable = type === 'button' || (type === '' && !el.form);
  else if (tag === 'INPUT') activatable = type === 'checkbox' || type === 'button';
  else if (tag === 'SUMMARY') activatable = true;
  else if (tag === 'A' || tag === 'AREA') activatable = role === 'button' && (href === null || /^#/.test(href.trim()));
  else if (tag !== 'TEXTAREA' && tag !== 'SELECT') activatable = ['button', 'switch', 'checkbox'].includes(role);
  const key = (tag === 'INPUT' && type === 'checkbox') || role === 'switch' || role === 'checkbox' ? 'Space' : 'Enter';
  const r = el.getBoundingClientRect();
  return { selector: [...path, selectorOf(el)].join(' >>> ').slice(0, 300), name: nameOf(el).slice(0, 200), activatable, key, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}`;

/** Blurs the deepest focused element (through shadow roots and same-origin frames) so a walk starts at the top. */
export const BLUR_DEEP = String.raw`(() => {
  let el = document.activeElement;
  for (let depth = 0; el && depth < 10; depth++) {
    const inner = el.shadowRoot && el.shadowRoot.activeElement || (el.tagName === 'IFRAME' ? (() => { try { return el.contentDocument && el.contentDocument.activeElement; } catch (e) { return null; } })() : null);
    if (!inner) break;
    el = inner;
  }
  if (el && el.blur) el.blur();
  window.focus();
  return true;
})()`;

/** Centres of the elements a window saw moving; ranks pause controls by distance (W4). Argument: selectors. */
export const MOVING_CENTERS = String.raw`(selectors) => selectors.map((selector) => { try { const el = document.querySelector(selector); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; } catch (e) { return null; } }).filter(Boolean)`;

/** Every control named like a pause/stop/hide control in the main document, to report one keyboard users cannot reach. */
export const PAUSE_CANDIDATES = String.raw`(pattern) => {
${HELPERS}
  const re = new RegExp(pattern, 'iu');
  const CONTROL = 'button,input[type="button"],input[type="checkbox"],[role="button"],[role="switch"],[role="checkbox"],summary';
  return Array.from(document.querySelectorAll(CONTROL)).filter((el) => re.test(nameOf(el))).slice(0, 10).map((el) => ({ selector: selectorOf(el), name: nameOf(el).slice(0, 200) }));
}`;

/** Names that identify a control for WCAG 2.2.2 pause, stop or hide (user-authored English or Spanish pages; these are input matchers, not UI copy). */
export const PAUSE_CONTROL_NAME = String.raw`\b(pause|stop|hide|pausar|pausa|detener|ocultar)\b`;
/** Names ranked first among pause controls (W4): pause and stop before hide. */
export const PAUSE_FIRST_NAME = String.raw`\b(pause|stop|pausar|pausa|detener)\b`;

/** Something MOTION_SAMPLE cannot see, as data; the daemon words it (selectors re-validated, no page text). */
export type UnmeasuredItem = { kind: 'offscreen'; element: string; selector: string } | { kind: 'frame'; selector: string } | { kind: 'raf' } | { kind: 'workers'; count: number } | { kind: 'timers-truncated' } | { kind: 'tracker-missing' };
export type MotionSampleResult = { now: number; moved: string[]; animations: { selector: string; name: string; iterations: number | null }[]; unmeasured: UnmeasuredItem[]; timers: { key: string; kind: 'interval' | 'timeout'; fires: number[]; nextDueMs: number | null }[] };
export type FocusedControlResult = { selector: string; name: string; activatable: boolean; key: 'Enter' | 'Space'; x: number; y: number } | null;
export type FocusStepResult = { selector: string | null; focusVisible: boolean };
export type ClickProbeResult = { target: 'same' | 'relocated' | 'missing' | 'ambiguous'; domMutations: number; navigated: boolean; error: string | null };
export const probeArgument = (targets: TargetRequest[]) => JSON.stringify(targets);
