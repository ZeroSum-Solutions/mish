// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/water-ripple-image/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/water-ripple-image');
const P = `--genui-${id}`;
const RING = `.genui-${id}__ring`;

function host(withMedia = true): HTMLElement {
  const el = document.createElement('figure');
  el.dataset.genui = id;
  el.innerHTML = withMedia
    ? `<div class="genui-${id}__media" id="lake" role="img" aria-label="A still lake"><span id="sun"></span></div><figcaption>Still water</figcaption>`
    : '<p>No media</p>';
  document.body.append(el);
  return el;
}

/** A rAF stand-in the test drives frame by frame with explicit timestamps. */
function manualRaf(): { step(now: number): void; pending(): number } {
  let queue = new Map<number, FrameRequestCallback>();
  let next = 1;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { const n = next++; queue.set(n, cb); return n; });
  vi.stubGlobal('cancelAnimationFrame', (n: number) => { queue.delete(n); });
  return {
    step(now) { const current = queue; queue = new Map(); for (const cb of current.values()) cb(now); },
    pending: () => queue.size,
  };
}

function click(el: HTMLElement, clientX = 40, clientY = 30): void {
  el.dispatchEvent(new MouseEvent('click', { clientX, clientY, bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    stubRaf();
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    click(el);
    expect(el.querySelectorAll(RING).length).toBe(defaults.rings);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    stubRaf();
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    const handle = mount(el, { band: 10 });
    click(el);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties, clamped', () => {
    const el = host();
    const handle = mount(el, { band: 24, strength: 0.08 });
    expect(el.style.getPropertyValue(`${P}-band`)).toBe('24px');
    expect(el.style.getPropertyValue(`${P}-strength`)).toBe('0.08');
    expect(el.style.getPropertyValue(`${P}-glint`)).toBe(String(defaults.glint));
    handle.destroy();
    const wild = mount(el, { strength: 5, glint: -1, band: 0 });
    expect(el.style.getPropertyValue(`${P}-strength`)).toBe('0.3');
    expect(el.style.getPropertyValue(`${P}-glint`)).toBe('0');
    expect(el.style.getPropertyValue(`${P}-band`)).toBe('1px');
    wild.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ band: 30, glint: 0.5, bogus: 1, strength: 'lots' });
    const handle = mount(el, { glint: 0.4 });
    expect(el.style.getPropertyValue(`${P}-band`)).toBe('30px');
    expect(el.style.getPropertyValue(`${P}-glint`)).toBe('0.4');
    expect(el.style.getPropertyValue(`${P}-strength`)).toBe(String(defaults.strength));
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('a click drops concentric, aria-hidden, inert rings that alternate crest and trough, then clear', () => {
    const frames = manualRaf();
    const el = host();
    const media = el.querySelector<HTMLElement>(`.genui-${id}__media`)!;
    vi.spyOn(media, 'getBoundingClientRect').mockReturnValue({ left: 10, top: 10, width: 200, height: 100 } as DOMRect);
    const handle = mount(el, { rings: 2, spacing: 0, duration: 400 });
    click(el, 60, 40);
    const rings = [...el.querySelectorAll<HTMLElement>(RING)];
    expect(rings).toHaveLength(2);
    for (const ring of rings) {
      expect(ring.getAttribute('aria-hidden')).toBe('true');
      expect(ring.hasAttribute('inert')).toBe(true);
      expect(ring.hasAttribute('id')).toBe(false);
      expect(ring.querySelector('[id]')).toBeNull();
      expect(ring.style.getPropertyValue(`${P}-x`)).toBe('50px');
      expect(ring.style.getPropertyValue(`${P}-y`)).toBe('30px');
    }
    expect(media.nextElementSibling).toBe(rings[0]);
    expect(frames.pending()).toBe(1);
    frames.step(1000); // first frame: 16 ms in
    frames.step(1100);
    const [crest, trough] = rings.map((ring) => Number(ring.style.getPropertyValue(`${P}-g`)));
    expect(crest).toBeGreaterThan(0);
    expect(trough).toBeLessThan(0);
    expect(parseFloat(rings[0]!.style.getPropertyValue(`${P}-r`))).toBeGreaterThan(0);
    for (let now = 1150; frames.pending() > 0 && now < 3000; now += 50) frames.step(now); // dt is capped at 64 ms
    expect(el.querySelectorAll(RING)).toHaveLength(0); // lifetime ran out
    expect(frames.pending()).toBe(0); // loop stops once idle
    handle.destroy();
  });

  it('caps live drops at maxDrops, clearing the oldest first', () => {
    stubRaf();
    const el = host();
    const handle = mount(el, { rings: 1, maxDrops: 2 });
    click(el, 1, 1);
    click(el, 2, 2);
    click(el, 3, 3);
    const xs = [...el.querySelectorAll<HTMLElement>(RING)].map((r) => r.style.getPropertyValue(`${P}-x`));
    expect(xs).toEqual(['2px', '3px']);
    handle.destroy();
  });

  it('without a media child it mounts but never drops a ring', () => {
    stubRaf();
    const el = host(false);
    const before = el.outerHTML;
    const handle = mount(el);
    click(el);
    expect(el.querySelector(RING)).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('pauses the loop off-screen, resumes on screen, and disconnects on destroy', () => {
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    click(el);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    expect(el.querySelectorAll(RING).length).toBe(defaults.rings); // frozen, not dropped
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('autoDrip drops on its own while visible and idles without it', () => {
    const frames = manualRaf();
    const el = host();
    const idle = mount(el);
    expect(frames.pending()).toBe(0);
    idle.destroy();
    const handle = mount(el, { autoDrip: 100 });
    expect(frames.pending()).toBe(1);
    frames.step(1000); // starts at 60% of the interval, plus a 16 ms first frame
    expect(el.querySelector(RING)).toBeNull();
    frames.step(1050);
    expect(el.querySelectorAll(RING).length).toBe(defaults.rings);
    handle.destroy();
    expect(frames.pending()).toBe(0);
    expect(el.querySelector(RING)).toBeNull();
  });

  it('follows reduced motion at mount and on change, and removes its listeners on destroy', () => {
    const raf = stubRaf();
    const media = stubMatchMedia(true);
    const el = host();
    const clicks = trackActiveListeners(el, ['click']);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    click(el);
    expect(el.querySelector(RING)).toBeNull();
    expect(raf.pending()).toBe(0);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    click(el);
    expect(el.querySelectorAll(RING).length).toBe(defaults.rings);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    expect(el.querySelector(RING)).toBeNull();
    expect(raf.pending()).toBe(0);
    expect(clicks.active('click')).toBe(1);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(clicks.active('click')).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-water-ripple-image with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-water-ripple-image/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).toContain(`genui-${id}__media`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns/);
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
