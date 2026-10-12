// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/stroke-text/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/stroke-text');

function host(): HTMLElement {
  const el = document.createElement('h2');
  el.innerHTML = 'Slow <span class="genui-stroke-text__solid">cities,</span> long light';
  el.dataset.genui = id;
  document.body.append(el);
  return el;
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
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps the text once, unsplit and with no aria-hidden clones', () => {
    const el = host();
    const handle = mount(el);
    expect(el.textContent).toBe('Slow cities, long light');
    expect(el.childNodes).toHaveLength(3);
    expect(el.querySelector('[aria-hidden]')).toBeNull();
    handle.destroy();
  });

  it('maps every option to its custom property', () => {
    const el = host();
    const handle = mount(el, { strokeWidth: 2, strokeColor: 'red', fillColor: 'blue', duration: 400 });
    expect(el.style.getPropertyValue('--genui-stroke-text-width')).toBe('2px');
    expect(el.style.getPropertyValue('--genui-stroke-text-stroke')).toBe('red');
    expect(el.style.getPropertyValue('--genui-stroke-text-fill')).toBe('blue');
    expect(el.style.getPropertyValue('--genui-stroke-text-duration')).toBe('400ms');
    handle.destroy();
  });

  it('clamps negative width and duration to zero', () => {
    const el = host();
    const handle = mount(el, { strokeWidth: -3, duration: -10 });
    expect(el.style.getPropertyValue('--genui-stroke-text-width')).toBe('0px');
    expect(el.style.getPropertyValue('--genui-stroke-text-duration')).toBe('0ms');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ strokeWidth: 3, duration: 900, bogus: 1, strokeColor: 5 });
    const handle = mount(el, { duration: 200 });
    expect(el.style.getPropertyValue('--genui-stroke-text-width')).toBe('3px');
    expect(el.style.getPropertyValue('--genui-stroke-text-duration')).toBe('200ms');
    expect(el.style.getPropertyValue('--genui-stroke-text-stroke')).toBe(defaults.strokeColor);
    expect(el.style.getPropertyValue('--genui-stroke-text-bogus')).toBe('');
    handle.destroy();
  });

  it('adds the fill-hover modifier only when fillOnHover is set', () => {
    const el = host();
    const handle = mount(el);
    expect(el.classList.contains('genui-stroke-text--fill-hover')).toBe(true);
    handle.destroy();
    const other = host();
    const otherHandle = mount(other, { fillOnHover: false });
    expect(other.classList.contains('genui-stroke-text--fill-hover')).toBe(false);
    otherHandle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-stroke-text--reduced')).toBe(true);
    expect(el.style.transition).toBe('');
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-stroke-text--reduced')).toBe(false);
    media.fire(true);
    expect(el.classList.contains('genui-stroke-text--reduced')).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'headline  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { strokeWidth: 4 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-stroke-text with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@supports[^{]+\{/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-stroke-text/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
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
