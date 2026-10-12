// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/true-focus/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/true-focus');
const P = `genui-${id}`;

function host(html = 'Keep the <em>signal</em> clear'): HTMLElement {
  const el = document.createElement('h2');
  el.innerHTML = html;
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

const activeText = (el: HTMLElement): string | undefined =>
  el.querySelector(`.${P}__word--active`)?.textContent ?? undefined;

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'hero  title';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { blur: 8 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('keeps the original text once for screen readers and hides the split copy', () => {
    const el = host();
    const handle = mount(el);
    const sr = el.querySelector(`.${P}__sr`);
    expect(sr?.innerHTML).toBe('Keep the <em>signal</em> clear');
    expect(el.querySelector(`.${P}__visual`)?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelector(`.${P}__frame`)?.getAttribute('aria-hidden')).toBe('true');
    const words = Array.from(el.querySelectorAll(`.${P}__word`), (w) => w.textContent);
    expect(words).toEqual(['Keep', 'the', 'signal', 'clear']);
    handle.destroy();
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { blur: 8, dim: 2, duration: 300, frameColor: 'red', glowColor: 'blue' });
    expect(el.style.getPropertyValue(`--${P}-blur`)).toBe('8px');
    expect(el.style.getPropertyValue(`--${P}-dim`)).toBe('1');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('300ms');
    expect(el.style.getPropertyValue(`--${P}-color`)).toBe('red');
    expect(el.style.getPropertyValue(`--${P}-glow`)).toBe('blue');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ blur: 3, duration: 900, bogus: 1, dim: 'loud' });
    const handle = mount(el, { duration: 200 });
    expect(el.style.getPropertyValue(`--${P}-blur`)).toBe('3px');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('200ms');
    expect(el.style.getPropertyValue(`--${P}-dim`)).toBe(String(defaults.dim));
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('pulls focus word by word on a timer, only while on screen, and stops on destroy', () => {
    vi.useFakeTimers();
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el, { duration: 100, pause: 200 });
    expect(activeText(el)).toBe('Keep');
    vi.advanceTimersByTime(1000);
    expect(activeText(el)).toBe('Keep'); // not observed as visible yet
    io.trigger(el);
    vi.advanceTimersByTime(300);
    expect(activeText(el)).toBe('the');
    vi.advanceTimersByTime(900);
    expect(activeText(el)).toBe('Keep'); // wraps around
    io.trigger(el, false);
    vi.advanceTimersByTime(900);
    expect(activeText(el)).toBe('Keep');
    io.trigger(el);
    handle.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(io.observers.every((o) => o.disconnected)).toBe(true);
    expect(el.outerHTML).toBe(before);
  });

  it('manual mode rests fully sharp and pulls focus on hover', () => {
    vi.useFakeTimers();
    const el = host();
    const handle = mount(el, { manual: true });
    expect(el.classList.contains(`${P}--idle`)).toBe(true);
    expect(activeText(el)).toBeUndefined();
    const words = el.querySelectorAll(`.${P}__word`);
    words[2]!.dispatchEvent(new Event('pointerenter'));
    expect(activeText(el)).toBe('signal');
    expect(el.classList.contains(`${P}--idle`)).toBe(false);
    el.querySelector(`.${P}__visual`)!.dispatchEvent(new Event('pointerleave'));
    expect(el.classList.contains(`${P}--idle`)).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(activeText(el)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
    handle.destroy();
  });

  it('adds the no-frame modifier when frame is off', () => {
    const el = host();
    const handle = mount(el, { frame: false });
    expect(el.classList.contains(`${P}--no-frame`)).toBe(true);
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el, { duration: 100, pause: 100 });
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    vi.advanceTimersByTime(200);
    expect(activeText(el)).toBe('the');
    media.fire(true);
    expect(vi.getTimerCount()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it(`ships css scoped under .${P} with no url() or @import`, () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{};]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(new RegExp(P));
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
