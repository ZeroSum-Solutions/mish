// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, hexToRgb, id, mount } from '../../../components/shader-svg/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/shader-svg');
const P = `genui-${id}`;

function host(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  el.innerHTML = '<svg viewBox="0 0 200 80" role="img" aria-label="Mark">'
    + '<path fill-rule="evenodd" d="M0 0h80v80H0z"/><circle cx="140" cy="40" r="30"/></svg>';
  document.body.append(el);
  return el;
}

/** A WebGL context stand-in: every method is a recording no-op, and the program links. */
function fakeGl() {
  const calls: string[] = [];
  const lose = vi.fn();
  const gl = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'getProgramParameter') return () => true;
      if (prop === 'getExtension') return () => ({ loseContext: lose });
      if (typeof prop === 'string' && /^[A-Z_]+$/.test(prop)) return 1;
      return () => { calls.push(String(prop)); return {}; };
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as unknown as WebGLRenderingContext);
  return { draws: () => calls.filter((c) => c === 'drawArrays').length, lose };
}

beforeEach(() => {
  // jsdom has no WebGL: getContext returns null, which is the fallback path.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.querySelector(`foreignObject.${P}__fx`)).not.toBeNull();
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { angle: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { angle: 30, colorA: 'red' });
    expect(el.style.getPropertyValue(`--${P}-angle`)).toBe('30deg');
    expect(el.style.getPropertyValue(`--${P}-a`)).toBe('red');
    expect(el.style.getPropertyValue(`--${P}-b`)).toBe(defaults.colorB);
    expect(el.style.getPropertyValue(`--${P}-c`)).toBe(defaults.colorC);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ angle: 12, colorB: '#000000', bogus: 1, colorA: 5 });
    const handle = mount(el, { colorB: '#ffffff' });
    expect(el.style.getPropertyValue(`--${P}-angle`)).toBe('12deg');
    expect(el.style.getPropertyValue(`--${P}-b`)).toBe('#ffffff');
    expect(el.style.getPropertyValue(`--${P}-a`)).toBe(defaults.colorA);
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('falls back to a static CSS gradient clipped to the logo shapes when WebGL is missing', () => {
    const el = host();
    const handle = mount(el);
    const fx = el.querySelector(`.${P}__fx`)!;
    expect(fx.getAttribute('aria-hidden')).toBe('true');
    expect(fx.querySelector(`.${P}__fallback`)).not.toBeNull();
    expect(fx.querySelector('canvas')).toBeNull();
    const clipId = /url\(#(.+)\)/.exec(fx.getAttribute('clip-path') ?? '')?.[1];
    const clip = el.querySelector(`clipPath[id="${clipId}"]`)!;
    expect(clip.children).toHaveLength(2);
    expect(clip.querySelector('path')!.getAttribute('clip-rule')).toBe('evenodd');
    expect(fx.getAttribute('width')).toBe('200');
    expect(el.classList.contains(`${P}--ready`)).toBe(true);
    handle.destroy();
  });

  it('runs the WebGL loop only while on screen, and stops it and loses the context on destroy', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelector(`.${P}__fx canvas`)).not.toBeNull();
    expect(gl.draws()).toBe(1); // a still frame before the first intersection
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
    expect(gl.lose).toHaveBeenCalledTimes(1);
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const gl = fakeGl();
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(raf.pending()).toBe(0);
    expect(gl.draws()).toBe(1);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('parses hex colours for the shader', () => {
    expect(hexToRgb('#fff')).toEqual([1, 1, 1]);
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('red')).toBeNull();
  });

  it('ships css scoped under .genui-shader-svg with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-shader-svg/);
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
