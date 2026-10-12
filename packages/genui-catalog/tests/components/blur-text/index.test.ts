// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/blur-text/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/blur-text');

function host(text = 'Sharp focus'): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: text });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

const pieces = (el: HTMLElement) => el.querySelectorAll<HTMLElement>('.genui-blur-text__piece');

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    stubIO();
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
    stubIO();
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { blur: 4 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('keeps the text once for screen readers and hides the split copy', () => {
    stubIO();
    const el = host();
    el.innerHTML = 'Sharp <em>focus</em> now';
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelector('.genui-blur-text__sr')?.textContent).toBe('Sharp focus now');
    expect(el.querySelector('.genui-blur-text__visual')?.getAttribute('aria-hidden')).toBe('true');
    expect(pieces(el)).toHaveLength(3); // words, with the inline element kept whole
    expect(Array.from(pieces(el), (p) => p.style.getPropertyValue('--genui-blur-text-i'))).toEqual(['0', '1', '2']);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('splits into one piece per non-space character in chars mode', () => {
    stubIO();
    const el = host('Hi there');
    const handle = mount(el, { split: 'chars' });
    expect(pieces(el)).toHaveLength(7);
    expect(el.querySelectorAll('.genui-blur-text__word')).toHaveLength(2);
    handle.destroy();
  });

  it('stays pending until in view, plays, then settles after the last piece ends', () => {
    const io = stubIO();
    const el = host('Hi there');
    const handle = mount(el);
    expect(el.classList.contains('genui-blur-text--pending')).toBe(true);
    io.trigger(el, false);
    expect(el.classList.contains('genui-blur-text--play')).toBe(false);
    io.trigger(el);
    expect(el.classList.contains('genui-blur-text--pending')).toBe(false);
    expect(el.classList.contains('genui-blur-text--play')).toBe(true);
    expect(io.observers[0]!.disconnected).toBe(true); // plays once by default
    for (const p of pieces(el)) p.dispatchEvent(new Event('animationend', { bubbles: true }));
    expect(el.classList.contains('genui-blur-text--play')).toBe(false);
    handle.destroy();
  });

  it('replays on re-entry when replay is set', () => {
    const io = stubIO();
    const el = host();
    const handle = mount(el, { replay: true });
    io.trigger(el);
    expect(el.classList.contains('genui-blur-text--play')).toBe(true);
    io.trigger(el, false);
    expect(el.classList.contains('genui-blur-text--pending')).toBe(true);
    io.trigger(el);
    expect(el.classList.contains('genui-blur-text--play')).toBe(true);
    handle.destroy();
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('never hides text without IntersectionObserver', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const el = host();
    const handle = mount(el);
    expect(el.classList.contains('genui-blur-text--pending')).toBe(false);
    expect(pieces(el).length).toBeGreaterThan(0);
    handle.destroy();
  });

  it('maps options to custom properties', () => {
    stubIO();
    const el = host();
    const handle = mount(el, { blur: 20, rise: -0.5, stagger: 40, easing: 'linear' });
    expect(el.style.getPropertyValue('--genui-blur-text-blur')).toBe('20px');
    expect(el.style.getPropertyValue('--genui-blur-text-rise')).toBe('-0.5em');
    expect(el.style.getPropertyValue('--genui-blur-text-stagger')).toBe('40ms');
    expect(el.style.getPropertyValue('--genui-blur-text-easing')).toBe('linear');
    expect(el.style.getPropertyValue('--genui-blur-text-duration')).toBe(`${defaults.duration}ms`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    stubIO();
    const el = host('Hi');
    el.dataset.genuiOpts = JSON.stringify({ split: 'chars', blur: 6, delay: 300, bogus: 1, duration: 'slow' });
    const handle = mount(el, { delay: 100 });
    expect(pieces(el)).toHaveLength(2);
    expect(el.style.getPropertyValue('--genui-blur-text-blur')).toBe('6px');
    expect(el.style.getPropertyValue('--genui-blur-text-delay')).toBe('100ms');
    expect(el.style.getPropertyValue('--genui-blur-text-duration')).toBe(`${defaults.duration}ms`);
    expect(el.style.getPropertyValue('--genui-blur-text-bogus')).toBe('');
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-blur-text--reduced')).toBe(true);
    expect(pieces(el)).toHaveLength(0);
    expect(io.observers).toHaveLength(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-blur-text--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('settles a running reveal when reduced motion switches on mid-way', () => {
    const media = stubMatchMedia(false);
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    io.trigger(el);
    media.fire(true);
    expect(el.classList.contains('genui-blur-text--reduced')).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-blur-text with no url() or @import, and a reduced-motion block', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-blur-text/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/<!doctype|<\/?(html|head|body|script|style|iframe|object|embed|link|meta|base)\b/i);
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
