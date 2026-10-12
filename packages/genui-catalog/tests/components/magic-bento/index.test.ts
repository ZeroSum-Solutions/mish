// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/magic-bento/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/magic-bento');
const P = '--genui-magic-bento';

function host(): { el: HTMLElement; cards: HTMLElement[] } {
  const el = document.createElement('div');
  el.dataset.genui = id;
  const cards = ['Uptime', 'Latency'].map((label) => {
    const card = Object.assign(document.createElement('a'), { href: '#', textContent: label });
    card.className = 'genui-magic-bento__card';
    el.append(card);
    return card;
  });
  document.body.append(el);
  return { el, cards };
}

function stubRect(el: Element, left: number, top: number, width: number, height: number): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON() { return this; },
  } as DOMRect);
}

function move(el: HTMLElement, type: string, clientX: number, clientY: number, pointerType = 'mouse'): void {
  const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
  Object.defineProperty(event, 'pointerType', { value: pointerType });
  el.dispatchEvent(event);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly (cards included)', () => {
    const { el, cards } = host();
    cards[0]!.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('0');
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const { el } = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { columns: 3 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties and modifier classes', () => {
    const { el } = host();
    const handle = mount(el, { columns: 3, gap: '8px', glowColour: 'red', borderGlow: false, spotlight: false });
    expect(el.style.getPropertyValue(`${P}-cols`)).toBe('3');
    expect(el.style.getPropertyValue(`${P}-gap`)).toBe('8px');
    expect(el.style.getPropertyValue(`${P}-colour`)).toBe('red');
    expect(el.style.getPropertyValue(`${P}-row`)).toBe(defaults.rowHeight);
    expect(el.style.getPropertyValue(`${P}-radius`)).toBe(`${defaults.radius}px`);
    expect(el.classList.contains('genui-magic-bento--no-border')).toBe(true);
    expect(el.classList.contains('genui-magic-bento--no-spotlight')).toBe(true);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const { el } = host();
    el.dataset.genuiOpts = JSON.stringify({ columns: 2, radius: 300, bogus: 1, gap: 5, spotlight: 'no' });
    const handle = mount(el, { radius: 150 });
    expect(el.style.getPropertyValue(`${P}-cols`)).toBe('2');
    expect(el.style.getPropertyValue(`${P}-radius`)).toBe('150px');
    expect(el.style.getPropertyValue(`${P}-gap`)).toBe(defaults.gap);
    expect(el.classList.contains('genui-magic-bento--no-spotlight')).toBe(false);
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('lights cards by pointer proximity in one rAF frame and clears on leave', () => {
    const { el, cards } = host();
    stubRect(el, 0, 0, 400, 100);
    stubRect(cards[0]!, 0, 0, 100, 100);
    stubRect(cards[1]!, 200, 0, 100, 100);
    const raf = stubRaf();
    const handle = mount(el, { proximity: 100 });
    move(el, 'pointermove', 50, 40);
    move(el, 'pointermove', 50, 50);
    expect(raf.pending()).toBe(1);
    raf.flush();
    expect(el.style.getPropertyValue(`${P}-on`)).toBe('1');
    expect(el.style.getPropertyValue(`${P}-hx`)).toBe('50px');
    expect(cards[0]!.style.getPropertyValue(`${P}-glow`)).toBe('1.000');
    expect(cards[0]!.style.getPropertyValue(`${P}-x`)).toBe('50px');
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('0.000'); // 150px away, beyond proximity
    move(el, 'pointermove', 150, 50);
    raf.flush();
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('0.500');
    expect(cards[1]!.style.getPropertyValue(`${P}-x`)).toBe('-50px');
    move(el, 'pointerleave', 0, 0);
    raf.flush();
    expect(el.style.getPropertyValue(`${P}-on`)).toBe('0');
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('0');
    handle.destroy();
    expect(raf.pending()).toBe(0);
  });

  it('ignores touch unless touch is set, and lights a focused card from its centre', () => {
    const { el, cards } = host();
    stubRect(cards[1]!, 200, 0, 100, 80);
    const raf = stubRaf();
    const handle = mount(el);
    move(el, 'pointermove', 250, 40, 'touch');
    expect(raf.pending()).toBe(0);
    cards[1]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('1.000');
    expect(cards[1]!.style.getPropertyValue(`${P}-y`)).toBe('40px');
    cards[1]!.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    expect(cards[1]!.style.getPropertyValue(`${P}-glow`)).toBe('0');
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const raf = stubRaf();
    const { el, cards } = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-magic-bento--reduced')).toBe(true);
    expect(media.listeners()).toBe(1);
    move(el, 'pointermove', 10, 10);
    cards[0]!.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    expect(raf.pending()).toBe(0); // no tracking under reduced motion
    expect(cards[0]!.style.getPropertyValue(`${P}-glow`)).toBe('0');
    media.fire(false);
    expect(el.classList.contains('genui-magic-bento--reduced')).toBe(false);
    move(el, 'pointermove', 10, 10);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    raf.flush();
    expect(el.style.getPropertyValue(`${P}-on`)).toBe('0');
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-magic-bento with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-magic-bento/);
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
