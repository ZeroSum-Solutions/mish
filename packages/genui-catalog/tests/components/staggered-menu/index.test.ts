// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/staggered-menu/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/staggered-menu');
const P = `genui-${id}`;

function host(): HTMLElement {
  const el = document.createElement('nav');
  el.setAttribute('aria-label', 'Main');
  el.dataset.genui = id;
  el.innerHTML = `<button type="button" class="${P}__toggle" aria-controls="p">Menu</button>`
    + `<div class="${P}__panel" id="p"><ul><li><a href="#a">Work</a></li><li><a href="#b" style="color: red;">Journal</a></li></ul></div>`;
  document.body.append(el);
  return el;
}

const parts = (el: HTMLElement) => ({
  toggle: el.querySelector<HTMLButtonElement>(`.${P}__toggle`)!,
  panel: el.querySelector<HTMLElement>(`.${P}__panel`)!,
  links: Array.from(el.querySelectorAll<HTMLAnchorElement>(`.${P}__panel a`)),
  layers: Array.from(el.querySelectorAll<HTMLElement>(`.${P}__layer`)),
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    parts(el).toggle.click();
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'site-nav  sticky';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { layers: 3 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { duration: 400, width: '320px', layers: 9, accent: 'red' });
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('400ms');
    expect(el.style.getPropertyValue(`--${P}-width`)).toBe('320px');
    expect(el.style.getPropertyValue(`--${P}-n`)).toBe('4'); // clamped
    expect(el.style.getPropertyValue(`--${P}-accent`)).toBe('red');
    expect(el.style.getPropertyValue(`--${P}-stagger`)).toBe(`${defaults.stagger}ms`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ stagger: 90, duration: 300, bogus: 1, layers: 'many', position: 'left' });
    const handle = mount(el, { duration: 200 });
    expect(el.style.getPropertyValue(`--${P}-stagger`)).toBe('90ms');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('200ms');
    expect(el.style.getPropertyValue(`--${P}-n`)).toBe(String(defaults.layers));
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    expect(el.classList.contains(`${P}--left`)).toBe(true);
    handle.destroy();
  });

  it('builds aria-hidden layers in the given colours and indexes each link', () => {
    const el = host();
    const handle = mount(el, { layers: 3, layerColors: 'red, blue' });
    const { layers, links, panel } = parts(el);
    expect(layers).toHaveLength(3);
    expect(layers.every((layer) => layer.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(layers.map((layer) => layer.style.background)).toEqual(['red', 'blue', 'red']);
    expect(layers[2]!.nextElementSibling).toBe(panel);
    expect(links.map((link) => link.style.getPropertyValue(`--${P}-i`))).toEqual(['0', '1']);
    handle.destroy();
    expect(parts(el).layers).toHaveLength(0);
  });

  it('opens and closes with the toggle, Escape, a link and an outside click', () => {
    const el = host();
    const outside = document.createElement('p');
    document.body.append(outside);
    const handle = mount(el);
    const { toggle, links } = parts(el);
    expect(el.classList.contains(`${P}--ready`)).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    toggle.click();
    expect(el.classList.contains(`${P}--open`)).toBe(true);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');

    links[0]!.focus();
    links[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(el.classList.contains(`${P}--open`)).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    toggle.click();
    links[1]!.click();
    expect(el.classList.contains(`${P}--open`)).toBe(false);

    toggle.click();
    outside.click();
    expect(el.classList.contains(`${P}--open`)).toBe(false);

    toggle.click();
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');

    handle.destroy();
    toggle.click(); // listeners are gone
    expect(el.classList.contains(`${P}--open`)).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
  });

  it('stays open on a link click when closeOnSelect is false', () => {
    const el = host();
    const handle = mount(el, { closeOnSelect: false });
    const { toggle, links } = parts(el);
    toggle.click();
    links[0]!.click();
    expect(el.classList.contains(`${P}--open`)).toBe(true);
    handle.destroy();
  });

  it('mounts without wiring or hiding anything when the toggle or panel is missing', () => {
    const el = document.createElement('nav');
    el.dataset.genui = id;
    el.innerHTML = '<a href="#">Home</a>';
    document.body.append(el);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--ready`)).toBe(false);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    media.fire(true);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    parts(el).toggle.click(); // the menu still works, just without motion
    expect(el.classList.contains(`${P}--open`)).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-staggered-menu with no url() or @import, and a reduced-motion block', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-staggered-menu/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).toMatch(/<nav[\s\S]*<button[\s\S]*aria-expanded="false"[\s\S]*<a /);
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
