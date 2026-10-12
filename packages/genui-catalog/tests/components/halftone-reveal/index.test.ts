// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  autoInit, defaults, drawScreen, id, mount, revealProgress,
} from '../../../components/halftone-reveal/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/halftone-reveal');
const P = `--genui-${id}`;

interface FakeCtx { arcs: number; fills: string[] }

/** Give every canvas a recording 2D context (jsdom has none). */
function stubCanvas(): FakeCtx {
  const record: FakeCtx = { arcs: 0, fills: [] };
  const ctx = {
    fillStyle: '',
    clearRect() { record.arcs = 0; record.fills = []; },
    setTransform() {},
    beginPath() {},
    moveTo() {},
    arc() { record.arcs += 1; },
    fill() { record.fills.push(ctx.fillStyle); },
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    (() => ctx) as unknown as HTMLCanvasElement['getContext'],
  );
  return record;
}

function host(top = 2000): HTMLElement {
  const el = document.createElement('article');
  el.innerHTML = '<h3>The slow return of film photography</h3>';
  el.dataset.genui = id;
  el.getBoundingClientRect = () => ({ top, left: 0, width: 280, height: 140 }) as DOMRect;
  document.body.append(el);
  return el;
}

const screen = (el: HTMLElement): HTMLCanvasElement | null => el.querySelector(`.genui-${id}__screen`);

beforeEach(() => { vi.stubGlobal('innerHeight', 800); });

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    stubCanvas();
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(screen(el)?.getAttribute('aria-hidden')).toBe('true');
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    stubCanvas();
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { cell: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    stubCanvas();
    const el = host();
    const handle = mount(el, { color: '#123456', cell: 20 });
    expect(el.style.getPropertyValue(`${P}-color`)).toBe('#123456');
    expect(el.style.getPropertyValue(`${P}-cell`)).toBe('20px');
    handle.destroy();
    const clamped = mount(host(), { cell: 1 });
    expect(document.querySelectorAll('article')[1]!.style.getPropertyValue(`${P}-cell`)).toBe('4px');
    clamped.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    stubCanvas();
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ color: '#222222', cell: 30, bogus: 1, once: 'yes', jitter: 'lots' });
    const handle = mount(el, { cell: 18 });
    expect(el.style.getPropertyValue(`${P}-color`)).toBe('#222222');
    expect(el.style.getPropertyValue(`${P}-cell`)).toBe('18px');
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('covers the host fully below start and clears the screen at end', () => {
    const ctx = stubCanvas();
    const covered = mount(host(2000)); // top far below the viewport: progress 0
    expect(ctx.arcs).toBeGreaterThan(200);
    covered.destroy();
    const revealed = mount(host(0)); // top at the viewport top: past end, progress 1
    expect(ctx.arcs).toBe(0);
    revealed.destroy();
    expect(revealProgress(0.6 * 800, 800, 0.95, 0.3)).toBeCloseTo(0.35 / 0.65);
  });

  it('tints only mid-dissolve dots with the edge colour', () => {
    const ctx = stubCanvas();
    const el = host(0.6 * 800);
    const handle = mount(el, { edge: '#f5b84a', color: '#0b0d12' });
    expect(ctx.fills).toContain('#f5b84a');
    expect(ctx.fills).toContain('#0b0d12');
    handle.destroy();
  });

  it('with no 2D context leaves the content uncovered', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    const el = host();
    const handle = mount(el);
    expect(screen(el)).toBeNull();
    expect(el.textContent).toBe('The slow return of film photography');
    handle.destroy();
  });

  it('listens to scroll only while near the viewport, and stops on destroy', () => {
    stubCanvas();
    const raf = stubRaf();
    const io = stubIO();
    const listeners = trackActiveListeners(window, ['scroll', 'resize']);
    const el = host(700);
    const handle = mount(el);
    expect(listeners.active('scroll')).toBe(0);
    io.trigger(el, true);
    expect(listeners.active('scroll')).toBe(1);
    expect(listeners.active('resize')).toBe(1);
    raf.flush();
    io.trigger(el, false);
    expect(listeners.active('scroll')).toBe(0);
    io.trigger(el, true);
    window.dispatchEvent(new Event('scroll'));
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(listeners.active('scroll')).toBe(0);
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('once mode removes the screen when the reveal completes', () => {
    stubCanvas();
    const raf = stubRaf();
    let top = 700;
    const el = host();
    el.getBoundingClientRect = () => ({ top, left: 0, width: 280, height: 140 }) as DOMRect;
    const handle = mount(el, { once: true });
    expect(screen(el)).not.toBeNull();
    top = 0;
    window.dispatchEvent(new Event('scroll')); // no IO in jsdom: attached at mount
    raf.flush();
    expect(screen(el)).toBeNull();
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const ctx = stubCanvas();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(screen(el)).toBeNull();
    expect(ctx.arcs).toBe(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('switching to reduced motion after mount removes the screen and its listeners', () => {
    const media = stubMatchMedia(false);
    stubCanvas();
    const listeners = trackActiveListeners(window, ['scroll']);
    const el = host(700);
    const before = el.outerHTML;
    const handle = mount(el); // no IO in jsdom: attached at once
    expect(screen(el)).not.toBeNull();
    expect(listeners.active('scroll')).toBe(1);
    media.fire(true);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(screen(el)).toBeNull();
    expect(listeners.active('scroll')).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('drawScreen draws nothing at progress 1 and a full screen at 0', () => {
    const ctx = stubCanvas();
    const c = document.createElement('canvas').getContext('2d')!;
    expect(drawScreen(c, 100, 100, 1, defaults)).toBe(0);
    expect(drawScreen(c, 100, 100, 0, defaults)).toBe(ctx.arcs);
    expect(ctx.arcs).toBeGreaterThan(0);
  });

  it(`ships css scoped under .genui-${id} with no url() or @import`, () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(new RegExp(`genui-${id}`));
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
