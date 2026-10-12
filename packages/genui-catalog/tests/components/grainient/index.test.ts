// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/grainient/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/grainient');
const P = `--genui-${id}`;

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Hi' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** A minimal 2D context that records putImageData calls. */
function stub2d(): { puts: Array<{ width: number; height: number }> } {
  const puts: Array<{ width: number; height: number }> = [];
  const ctx = {
    createImageData: (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }),
    putImageData: (image: { width: number; height: number }) => { puts.push({ width: image.width, height: image.height }); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === '2d' ? ctx : null)) as never);
  return { puts };
}

beforeEach(() => {
  // jsdom has no canvas backend; default to "no 2D context" so the CSS-only fallback runs.
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
    expect(el.querySelector('canvas')).not.toBeNull();
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
    mount(el, { speed: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { colorA: 'red', speed: 30, intensity: 2, grain: 0.4 });
    expect(el.style.getPropertyValue(`${P}-a`)).toBe('red');
    expect(el.style.getPropertyValue(`${P}-b`)).toBe(defaults.colorB);
    expect(el.style.getPropertyValue(`${P}-speed`)).toBe('30s');
    expect(el.style.getPropertyValue(`${P}-intensity`)).toBe('1');
    expect(el.style.getPropertyValue(`${P}-grain`)).toBe('0.4');
    expect(el.style.getPropertyValue(`${P}-base`)).toBe(defaults.base);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ speed: 12, colorC: 'blue', bogus: 1, grain: 'loud' });
    const handle = mount(el, { colorC: 'green' });
    expect(el.style.getPropertyValue(`${P}-speed`)).toBe('12s');
    expect(el.style.getPropertyValue(`${P}-c`)).toBe('green');
    expect(el.style.getPropertyValue(`${P}-grain`)).toBe(String(defaults.grain));
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('draws the grain once at 1/grainSize resolution into an aria-hidden first-child canvas', () => {
    const { puts } = stub2d();
    const el = host();
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ width: 300, height: 150 } as DOMRect);
    const handle = mount(el, { grainSize: 2 });
    const canvas = el.querySelector('canvas');
    expect(el.firstChild).toBe(canvas);
    expect(canvas?.classList.contains(`genui-${id}__grain`)).toBe(true);
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(puts).toEqual([{ width: 150, height: 75 }]);
    handle.destroy();
    expect(el.querySelector('canvas')).toBeNull();
  });

  it('falls back to the plain CSS gradient with no canvas when 2D is unavailable or grain is 0', () => {
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
    stub2d();
    const other = mount(el, { grain: 0 });
    expect(el.querySelector('canvas')).toBeNull();
    other.destroy();
  });

  it('pauses the drift off-screen and disconnects the observer on destroy', () => {
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    io.trigger(el, false);
    expect(el.classList.contains(`genui-${id}--paused`)).toBe(true);
    io.trigger(el, true);
    expect(el.classList.contains(`genui-${id}--paused`)).toBe(false);
    handle.destroy();
    expect(io.observers[0]?.disconnected).toBe(true);
  });

  it('adds the still class and no observer when animate is false', () => {
    const io = stubIO();
    const el = host();
    const handle = mount(el, { animate: false });
    expect(el.classList.contains(`genui-${id}--still`)).toBe(true);
    expect(io.observers).toHaveLength(0);
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    media.fire(true);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-grainient with no url() or @import, and a real reduce block', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{\s*\.genui-grainient/);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-grainient/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
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
