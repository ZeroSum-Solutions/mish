// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/scroll-choreography/index.ts';
import { stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/scroll-choreography');

function buildHost(itemCount = 4): HTMLElement {
  const el = document.createElement('section');
  el.dataset.genui = id;
  for (let i = 0; i < itemCount; i += 1) {
    const item = document.createElement('div');
    item.className = 'genui-scroll-choreography__item';
    item.textContent = `Photo ${i}`;
    el.append(item);
  }
  const caption = document.createElement('div');
  caption.className = 'genui-scroll-choreography__caption';
  caption.textContent = 'One frame, full attention';
  el.append(caption);
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = buildHost();
    const before = el.outerHTML;
    const raf = stubRaf();
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    raf.flush();
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('creates the stage, marks the hero item and gives every item a direction', () => {
    const el = buildHost();
    const raf = stubRaf();
    const handle = mount(el, { heroIndex: 1 });
    const stage = el.querySelector(':scope > .genui-scroll-choreography__stage');
    expect(stage).not.toBeNull();
    const items = Array.from(stage!.querySelectorAll<HTMLElement>('.genui-scroll-choreography__item'));
    expect(items).toHaveLength(4);
    expect(items.filter((item) => item.classList.contains('is-hero'))).toEqual([items[1]]);
    for (const item of items) {
      expect(item.style.getPropertyValue('--genui-scroll-choreography-dir-x')).toMatch(/^-?1$/);
      expect(item.style.getPropertyValue('--genui-scroll-choreography-dir-y')).toMatch(/^-?1$/);
    }
    raf.flush();
    handle.destroy();
  });

  it('writes a smoothed scroll progress between 0.3 and 0.7 at mid-track', () => {
    const el = buildHost();
    // total = height(2000) - jsdom's default innerHeight(768) = 1232; -top/total ~= 0.487
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
      top: -600, height: 2000, left: 0, width: 800, bottom: 1400, right: 800, x: 0, y: -600, toJSON() { return this; },
    } as DOMRect);
    const raf = stubRaf();
    const handle = mount(el);
    raf.flush();
    const p = Number(el.style.getPropertyValue('--genui-scroll-choreography-p'));
    expect(p).toBeGreaterThanOrEqual(0.3);
    expect(p).toBeLessThanOrEqual(0.7);
    handle.destroy();
  });

  it('with reduced motion, sets no track height and adds no scroll listener', () => {
    const media = stubMatchMedia(true);
    const el = buildHost();
    const addSpy = vi.spyOn(window, 'addEventListener');
    const raf = stubRaf();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-scroll-choreography--reduced')).toBe(true);
    expect(el.style.height).toBe('');
    expect(addSpy.mock.calls.some(([type]) => type === 'scroll')).toBe(false);
    raf.flush();
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('repeated reduced-motion switches keep exactly one scroll/resize pair while enabled and none while reduced', () => {
    const media = stubMatchMedia(false);
    const listeners = trackActiveListeners(window, ['scroll', 'resize']);
    const pair = (): number[] => [listeners.active('scroll'), listeners.active('resize')];
    const el = buildHost();
    const raf = stubRaf();
    const handle = mount(el);
    expect(pair()).toEqual([1, 1]);
    for (let round = 0; round < 3; round += 1) {
      media.fire(true);
      expect(pair()).toEqual([0, 0]);
      expect(el.style.height).toBe('');
      media.fire(false);
      expect(pair()).toEqual([1, 1]);
      expect(el.style.height).toBe(defaults.trackHeight);
    }
    // While reduced, a scroll moves nothing.
    media.fire(true);
    const rectSpy = vi.spyOn(el, 'getBoundingClientRect');
    window.dispatchEvent(new Event('scroll'));
    raf.flush();
    expect(rectSpy).not.toHaveBeenCalled();
    expect(el.style.getPropertyValue('--genui-scroll-choreography-p')).toBe('0.0000');
    handle.destroy();
    expect(pair()).toEqual([0, 0]);
  });

  it('startRadius and captionAt land on the custom properties styles.css reads', () => {
    const el = buildHost();
    const raf = stubRaf();
    const handle = mount(el, { startRadius: 28, captionAt: 0.5 });
    expect(el.style.getPropertyValue('--genui-scroll-choreography-radius')).toBe('28px');
    expect(el.style.getPropertyValue('--genui-scroll-choreography-cap-at')).toBe('0.5');
    // Every host-level property the code writes is one the stylesheet reads.
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8');
    const read = new Set(css.match(/--genui-scroll-choreography-[a-z-]+(?=[,)])/g) ?? []);
    const written = Array.from(el.style).filter((name) => name.startsWith('--genui-scroll-choreography-'));
    expect(written.length).toBeGreaterThan(0);
    for (const name of written) expect(read.has(name), name).toBe(true);
    raf.flush();
    handle.destroy();
  });

  it('a host without exactly 4 items logs a warning and mounts a no-op handle', () => {
    const el = buildHost(3);
    const before = el.outerHTML;
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handle = mount(el);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(el.querySelector('.genui-scroll-choreography__stage')).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-scroll-choreography with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-scroll-choreography/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).toContain('genui-scroll-choreography__caption');
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
