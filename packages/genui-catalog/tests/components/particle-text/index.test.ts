// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/particle-text/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/particle-text');
const CANVAS = '.genui-particle-text__canvas';
const ACTIVE = 'genui-particle-text--active';

/** A fake 2D context whose sampled pixels are all opaque, so every sample point becomes a particle. */
function stub2d(): { rects: () => number } {
  let rects = 0;
  const ctx = {
    font: '', fillStyle: '', textBaseline: '', globalAlpha: 1,
    fillText() {}, clearRect() {}, setTransform() {},
    fillRect() { rects += 1; },
    measureText: () => ({ fontBoundingBoxAscent: 10 }),
    createLinearGradient: () => ({ addColorStop() {} }),
    getImageData: (_x: number, _y: number, w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === '2d' ? ctx : null)) as never);
  return { rects: () => rects };
}

function host(): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: 'Ideas take shape' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

beforeEach(() => {
  // jsdom has no canvas backend; default to "no 2D context" so the plain-text fallback runs.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    stub2d();
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.querySelector(CANVAS)).not.toBeNull();
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    stub2d();
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { spread: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('keeps the text once for screen readers and hides only the decorative canvas', () => {
    stub2d();
    const el = host();
    const handle = mount(el);
    const canvas = el.querySelector(CANVAS);
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(el.textContent).toBe('Ideas take shape');
    expect(el.classList.contains(ACTIVE)).toBe(true);
    handle.destroy();
  });

  it('leaves the plain text alone when there is no 2D context', () => {
    const el = host();
    const before = el.innerHTML;
    const handle = mount(el);
    expect(el.querySelector(CANVAS)).toBeNull();
    expect(el.classList.contains(ACTIVE)).toBe(false);
    expect(el.innerHTML).toBe(before);
    handle.destroy();
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { spread: 30, duration: 900 });
    expect(el.style.getPropertyValue('--genui-particle-text-spread')).toBe('30px');
    expect(el.style.getPropertyValue('--genui-particle-text-duration')).toBe('900ms');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ spread: 12, duration: 500, bogus: 1, hold: 'long' });
    const handle = mount(el, { duration: 700 });
    expect(el.style.getPropertyValue('--genui-particle-text-spread')).toBe('12px');
    expect(el.style.getPropertyValue('--genui-particle-text-duration')).toBe('700ms');
    expect(el.style.getPropertyValue('--genui-particle-text-bogus')).toBe('');
    expect(el.style.getPropertyValue('--genui-particle-text-hold')).toBe('');
    handle.destroy();
  });

  it('draws particles in a rAF loop that pauses off-screen and stops on destroy', () => {
    const ctx = stub2d();
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    expect(ctx.rects()).toBeGreaterThan(0); // first frame drawn at mount
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers.every((o) => o.disconnected)).toBe(true);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    stub2d();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelector(CANVAS)).toBeNull();
    expect(el.classList.contains(ACTIVE)).toBe(false);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.querySelector(CANVAS)).not.toBeNull();
    expect(el.classList.contains(ACTIVE)).toBe(true);
    media.fire(true);
    expect(el.querySelector(CANVAS)).toBeNull();
    expect(el.classList.contains(ACTIVE)).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-particle-text with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-particle-text/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
