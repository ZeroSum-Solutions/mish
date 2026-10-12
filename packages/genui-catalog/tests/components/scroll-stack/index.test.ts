// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount, stackDepth } from '../../../components/scroll-stack/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/scroll-stack');
const PREFIX = `genui-${id}`;

function host(count = 3): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  for (let i = 0; i < count; i += 1) {
    const card = document.createElement('article');
    card.className = `${PREFIX}__card`;
    if (i === 1) card.setAttribute('style', 'background: red;');
    card.textContent = `Card ${i + 1}`;
    el.append(card);
  }
  document.body.append(el);
  return el;
}

function cards(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll<HTMLElement>(`.${PREFIX}__card`));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(PREFIX)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(cards(el).map((card) => card.style.getPropertyValue(`--${PREFIX}-i`))).toEqual(['0', '1', '2']);
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
    mount(el, { top: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { top: 30, offset: 8, scaleStep: 0.9 });
    expect(el.style.getPropertyValue(`--${PREFIX}-top`)).toBe('30px');
    expect(el.style.getPropertyValue(`--${PREFIX}-offset`)).toBe('8px');
    expect(el.style.getPropertyValue(`--${PREFIX}-gap`)).toBe(`${defaults.gap}px`);
    expect(el.style.getPropertyValue(`--${PREFIX}-scale`)).toBe('0.3'); // capped
    expect(el.style.getPropertyValue(`--${PREFIX}-dim`)).toBe(String(defaults.dim));
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ top: 12, offset: 20, bogus: 1, dim: 'loud' });
    const handle = mount(el, { offset: 6 });
    expect(el.style.getPropertyValue(`--${PREFIX}-top`)).toBe('12px');
    expect(el.style.getPropertyValue(`--${PREFIX}-offset`)).toBe('6px');
    expect(el.style.getPropertyValue(`--${PREFIX}-dim`)).toBe(String(defaults.dim));
    expect(el.style.getPropertyValue(`--${PREFIX}-bogus`)).toBe('');
    handle.destroy();
  });

  it('stackDepth counts later cards settled on top, fractionally and capped', () => {
    // Card 0 pinned at 24; card 1 resting on its ledge (36); card 2 half a height away from 48.
    expect(stackDepth([24, 36, 98], [100, 100, 100], 0, 12, 3)).toBeCloseTo(1.5);
    expect(stackDepth([24, 36, 98], [100, 100, 100], 2, 12, 3)).toBe(0);
    expect(stackDepth([24, 36, 48], [100, 100, 100], 0, 12, 1)).toBe(1);
  });

  it('writes a depth var per card on scroll while in view, and removes the listener on destroy', () => {
    const raf = stubRaf();
    const io = stubIO();
    const doc = trackActiveListeners(document, ['scroll']);
    const el = host();
    const before = el.outerHTML;
    const tops = [24, 36, 98];
    cards(el).forEach((card, i) => { card.getBoundingClientRect = () => ({ top: tops[i], height: 100 }) as DOMRect; });
    const handle = mount(el);
    expect(doc.active('scroll')).toBe(0); // gated until the host is in view
    io.trigger(el);
    expect(doc.active('scroll')).toBe(1);
    document.dispatchEvent(new Event('scroll'));
    raf.flush();
    expect(Number(cards(el)[0]!.style.getPropertyValue(`--${PREFIX}-d`))).toBeCloseTo(1.5);
    expect(cards(el)[2]!.style.getPropertyValue(`--${PREFIX}-d`)).toBe('0.000');
    io.trigger(el, false);
    expect(doc.active('scroll')).toBe(0);
    io.trigger(el);
    handle.destroy();
    expect(doc.active('scroll')).toBe(0);
    expect(raf.pending()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listeners on destroy', () => {
    const media = stubMatchMedia(true);
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${PREFIX}--reduced`)).toBe(true);
    expect(io.observers).toHaveLength(0); // no depth loop under reduced motion
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${PREFIX}--reduced`)).toBe(false);
    expect(io.observers).toHaveLength(1);
    media.fire(true);
    expect(el.classList.contains(`${PREFIX}--reduced`)).toBe(true);
    expect(io.observers[0]!.disconnected).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-scroll-stack with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-scroll-stack/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns|data:/i);
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
