/**
 * Shared DOM test harness for component tests (component-specs.md "Shared test harness").
 * Import from a test that runs under `// @vitest-environment jsdom`.
 */

import { readFileSync } from 'node:fs';
import { expect, vi } from 'vitest';

export interface StubbedMediaQuery {
  mql: MediaQueryList;
  /** Flip the preference and fire `change`. */
  fire(matches: boolean): void;
  listeners(): number;
}

/** Install a controllable `matchMedia` whose reduced-motion query matches `reduce`. */
export function stubMatchMedia(reduce: boolean): StubbedMediaQuery {
  const target = new EventTarget();
  let active = 0;
  const mql = {
    matches: reduce,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions) {
      active += 1;
      options?.signal?.addEventListener('abort', () => { active -= 1; }, { once: true });
      target.addEventListener(type, listener, options);
    },
    removeEventListener(type: string, listener: EventListener) {
      active -= 1;
      target.removeEventListener(type, listener);
    },
    addListener() {},
    removeListener() {},
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
  } as unknown as MediaQueryList;
  vi.stubGlobal('matchMedia', vi.fn(() => mql));
  return {
    mql,
    fire(matches) {
      (mql as { matches: boolean }).matches = matches;
      target.dispatchEvent(new Event('change'));
    },
    listeners: () => active,
  };
}

export interface StubbedIO {
  observers: Array<{ callback: IntersectionObserverCallback; targets: Set<Element>; disconnected: boolean }>;
  /** Report `target` as intersecting to every observer watching it. */
  trigger(target: Element, isIntersecting?: boolean): void;
}

/** Install a recording IntersectionObserver. */
export function stubIO(): StubbedIO {
  const observers: StubbedIO['observers'] = [];
  class FakeIO {
    private record: StubbedIO['observers'][number];
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, targets: new Set(), disconnected: false };
      observers.push(this.record);
    }
    observe(el: Element) { this.record.targets.add(el); }
    unobserve(el: Element) { this.record.targets.delete(el); }
    disconnect() { this.record.targets.clear(); this.record.disconnected = true; }
    takeRecords() { return []; }
  }
  vi.stubGlobal('IntersectionObserver', FakeIO);
  return {
    observers,
    trigger(target, isIntersecting = true) {
      for (const record of observers) {
        if (!record.targets.has(target)) continue;
        record.callback([{ target, isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
      }
    },
  };
}

export interface StubbedAnimation { keyframes: unknown; options: unknown; cancelled: boolean; cancel(): void; commitStyles(): void; finished: Promise<void> }

/** Install a recording `Element.prototype.animate`; returns the calls. */
export function stubAnimate(): StubbedAnimation[] {
  const calls: StubbedAnimation[] = [];
  const proto = Element.prototype as unknown as { animate?: unknown };
  proto.animate = function animate(keyframes: unknown, options: unknown) {
    const record: StubbedAnimation = {
      keyframes, options, cancelled: false,
      cancel() { record.cancelled = true; },
      commitStyles() {},
      finished: new Promise(() => {}),
    };
    calls.push(record);
    return record;
  };
  return calls;
}

/** Remove the animate stub. */
export function unstubAnimate(): void {
  delete (Element.prototype as unknown as { animate?: unknown }).animate;
}

/** Run queued rAF callbacks synchronously (install before mount). */
export function stubRaf(): { flush(): void; pending(): number } {
  let queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const id = next++; queue.set(id, cb); return id; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
  return {
    flush() {
      for (let i = 0; i < 100 && queue.size > 0; i += 1) {
        const current = queue; queue = new Map();
        for (const cb of current.values()) cb(performance.now());
      }
    },
    pending: () => queue.size,
  };
}

/** Count add/removeEventListener calls on `target` so a test can assert they pair up. */
export function spyListeners(target: EventTarget): { added(): number; removed(): number } {
  const add = vi.spyOn(target, 'addEventListener');
  const remove = vi.spyOn(target, 'removeEventListener');
  return { added: () => add.mock.calls.length, removed: () => remove.mock.calls.length };
}

/**
 * Track which listeners of each of `types` are attached to `target` right now, with DOM
 * semantics: the same function is registered once, and `removeEventListener` or an aborted
 * `signal` detaches it. Install once per target, before mount.
 */
export function trackActiveListeners(target: EventTarget, types: readonly string[]): { active(type: string): number } {
  const attached = new Map<string, Set<unknown>>(types.map((type) => [type, new Set()]));
  const add = target.addEventListener.bind(target);
  const remove = target.removeEventListener.bind(target);
  vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
    add(type, listener, options);
    const set = attached.get(type);
    if (!set || listener === null) return;
    const signal = typeof options === 'object' ? options.signal : undefined;
    if (signal?.aborted) return;
    set.add(listener);
    signal?.addEventListener('abort', () => { set.delete(listener); }, { once: true });
  });
  vi.spyOn(target, 'removeEventListener').mockImplementation((type, listener, options) => {
    remove(type, listener, options);
    attached.get(type)?.delete(listener);
  });
  return { active: (type) => attached.get(type)?.size ?? 0 };
}

/**
 * Assert every selector in the component's `styles.css` is scoped under `.genui-<id>` and the
 * sheet has no CSP-unsafe `@import`, `url()` or external URL (component-specs.md "Shared test
 * harness" — CSS-scoping assertion shared across component tests).
 */
export function expectScopedCss(cssPath: string, id: string): void {
  const css = readFileSync(cssPath, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  expect(css).not.toMatch(/@import|url\(|https?:\/\//);
  const selectors = css
    .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
    .replace(/@[^{]+\{/g, '')
    .match(/[^{}]+(?=\{)/g) ?? [];
  expect(selectors.length).toBeGreaterThan(0);
  const scope = new RegExp(`genui-${id}`);
  for (const selector of selectors.flatMap((s) => s.split(','))) {
    expect(selector.trim()).toMatch(scope);
  }
}

/**
 * Assert the component's `demo.html` mounts `id` via `data-genui` and ships no script, style
 * block, image or external URL (component-specs.md "Shared test harness" — demo-fragment
 * assertion shared across component tests).
 */
export function expectCleanDemoFragment(demoPath: string, id: string): void {
  const demo = readFileSync(demoPath, 'utf8');
  expect(demo).toContain(`data-genui="${id}"`);
  expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
}

// -------------------------------------------------------------------------------------------
// WCAG contrast (component-specs.md "Shared test harness" — colour-contrast assertions shared
// across component tests, e.g. texture-button's variant fills and shadow-card's mesh scrim).

export type RGB = readonly [number, number, number];
export type RGBA = readonly [number, number, number, number];

function srgbToLinear(channel: number): number {
  const v = channel / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance([r, g, b]: RGB): number {
  return 0.2126 * srgbToLinear(r) + 0.7152 * srgbToLinear(g) + 0.0722 * srgbToLinear(b);
}

/** WCAG 2 contrast ratio (1:1 to 21:1) between two opaque sRGB colours. */
export function contrastRatio(a: RGB, b: RGB): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Alpha-composite `fg` (its own alpha included) over the opaque `bg`. */
export function blendOver(fg: RGBA, bg: RGB): RGB {
  const [r, g, b, a] = fg;
  return [r * a + bg[0] * (1 - a), g * a + bg[1] * (1 - a), b * a + bg[2] * (1 - a)];
}

/** Parse `#rgb`/`#rrggbb` or `rgb()`/`rgba()` (as produced by `linear-gradient()` stops or `el.style`) into RGBA; alpha defaults to 1. */
export function parseColor(input: string): RGBA {
  const trimmed = input.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(trimmed);
  if (hex) {
    const digits = hex[1]!.length === 3 ? hex[1]!.split('').map((c) => c + c).join('') : hex[1]!;
    const n = Number.parseInt(digits, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/i.exec(trimmed);
  if (rgb) {
    return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
  }
  throw new Error(`unparseable colour: ${input}`);
}

/** Split a CSS value list on top-level commas only, so `rgba(a, b, c, d)` stays one item. */
export function splitTopLevel(value: string, separator = ','): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    else if (ch === ')') depth -= 1;
    if (ch === separator && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export interface CssRule { selectors: string[]; declarations: Record<string, string> }

/** Parse a stylesheet's top-level rules (no `@media`/`@keyframes` bodies) into selector + declaration-map pairs, in source order. */
export function parseCssRules(css: string): CssRule[] {
  const noComments = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const rules: CssRule[] = [];
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  for (const match of noComments.matchAll(ruleRe)) {
    const selectorText = match[1]!.trim();
    if (selectorText.startsWith('@')) continue;
    const declarations: Record<string, string> = {};
    for (const decl of splitTopLevel(match[2]!, ';')) {
      const idx = decl.indexOf(':');
      if (idx < 0) continue;
      declarations[decl.slice(0, idx).trim()] = decl.slice(idx + 1).trim();
    }
    if (Object.keys(declarations).length === 0) continue;
    rules.push({ selectors: selectorText.split(',').map((s) => s.trim()), declarations });
  }
  return rules;
}

/**
 * Cascade `rules` (in source order, later wins) for an element carrying every class in
 * `classes`: a selector matches when every `.class` token it names (found anywhere in the
 * selector, combinators and pseudo-classes included) is present in `classes`. Good enough for
 * this catalog's `.genui-x > .genui-x__part` and `.genui-x.genui-x--variant` selectors; it does
 * not model specificity beyond source order, so it is not a general CSS cascade.
 */
export function cascadeDeclarations(rules: readonly CssRule[], classes: readonly string[]): Record<string, string> {
  const active = new Set(classes);
  const out: Record<string, string> = {};
  for (const rule of rules) {
    const applies = rule.selectors.some((selector) => {
      const required = [...selector.matchAll(/\.([A-Za-z0-9_-]+)/g)].map((m) => m[1]!);
      return required.length > 0 && required.every((cls) => active.has(cls));
    });
    if (applies) Object.assign(out, rule.declarations);
  }
  return out;
}
