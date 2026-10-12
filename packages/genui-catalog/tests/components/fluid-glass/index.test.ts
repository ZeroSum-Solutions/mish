// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, hexToRgb, id, modeIndex, mount } from '../../../components/fluid-glass/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/fluid-glass');

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Hi' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** A WebGL stand-in: every method is a no-op spy, constants are numbers, link succeeds. */
function fakeGl(): { gl: WebGLRenderingContext; draws(): number; lost(): number } {
  let draws = 0; let lost = 0;
  const gl = new Proxy({}, {
    get(_target, key) {
      if (key === 'drawArrays') return () => { draws += 1; };
      if (key === 'getExtension') return () => ({ loseContext: () => { lost += 1; } });
      if (key === 'getProgramParameter') return () => true;
      if (typeof key === 'string' && /^[A-Z_]+$/.test(key)) return 1;
      return () => ({});
    },
  }) as WebGLRenderingContext;
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(gl as never);
  return { gl, draws: () => draws, lost: () => lost };
}

beforeEach(() => {
  // jsdom has no canvas: getContext returns null (the static-fallback path) unless a test fakes it.
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
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
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
    mount(el, { mode: 'bar' }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties and mode classes', () => {
    const el = host();
    const handle = mount(el, { size: 80, colorA: '#112233', mode: 'cube' });
    expect(el.style.getPropertyValue('--genui-fluid-glass-size')).toBe('80px');
    expect(el.style.getPropertyValue('--genui-fluid-glass-a')).toBe('#112233');
    expect(el.style.getPropertyValue('--genui-fluid-glass-b')).toBe(defaults.colorB);
    expect(el.classList.contains('genui-fluid-glass--cube')).toBe(true);
    handle.destroy();
    expect(modeIndex('lens')).toBe(0);
    expect(modeIndex('bar')).toBe(1);
    expect(modeIndex('nonsense')).toBe(0);
    expect(hexToRgb('#f00')).toEqual([1, 0, 0]);
    expect(hexToRgb('oops')).toEqual([0, 0, 0]);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ size: 40, mode: 'bar', bogus: 1, colorB: 7 });
    const handle = mount(el, { colorA: '#abcdef' });
    expect(el.style.getPropertyValue('--genui-fluid-glass-size')).toBe('40px');
    expect(el.style.getPropertyValue('--genui-fluid-glass-a')).toBe('#abcdef');
    expect(el.style.getPropertyValue('--genui-fluid-glass-b')).toBe(defaults.colorB);
    expect(el.style.getPropertyValue('--genui-fluid-glass-bogus')).toBe('');
    expect(el.classList.contains('genui-fluid-glass--bar')).toBe(true);
    handle.destroy();
  });

  it('falls back to the static CSS glass when getContext returns null', () => {
    const el = host();
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    expect(el.classList.contains('genui-fluid-glass--gl')).toBe(false);
    handle.destroy();
  });

  it('with WebGL, adds an aria-hidden canvas, runs only while on screen, and cleans up on destroy', () => {
    const fake = fakeGl();
    const io = stubIO();
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    const canvas = el.querySelector('canvas');
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(el.firstElementChild).toBe(canvas);
    expect(el.classList.contains('genui-fluid-glass--gl')).toBe(true);
    expect(fake.draws()).toBe(1); // first frame drawn at once
    expect(raf.pending()).toBe(0); // no loop until the host is on screen
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
    expect(fake.lost()).toBe(1);
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const fake = fakeGl();
    const io = stubIO();
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    io.trigger(el, true);
    expect(el.classList.contains('genui-fluid-glass--reduced')).toBe(true);
    expect(raf.pending()).toBe(0); // one still frame, no loop
    expect(fake.draws()).toBeGreaterThan(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-fluid-glass--reduced')).toBe(false);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-fluid-glass with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .replace(/@media[^{]+\{/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-fluid-glass/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; status: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    expect(meta.status).toBe('ported');
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
