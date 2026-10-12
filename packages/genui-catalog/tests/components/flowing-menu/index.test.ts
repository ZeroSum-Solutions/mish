// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/flowing-menu/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/flowing-menu');
const P = `genui-${id}`;

function host(withToggle = true): HTMLElement {
  const el = document.createElement('nav');
  el.setAttribute('aria-label', 'Site');
  el.dataset.genui = id;
  el.innerHTML = (withToggle ? `<a href="#home">Home</a><button type="button" class="${P}__toggle" aria-controls="l">Menu</button>` : '')
    + `<ul class="${P}__list" id="l"><li><a href="#a">Journeys</a></li><li><a href="#b" class="x">Stories</a></li></ul>`;
  document.body.append(el);
  return el;
}

const parts = (el: HTMLElement) => ({
  toggle: el.querySelector<HTMLButtonElement>(`.${P}__toggle`)!,
  links: Array.from(el.querySelectorAll<HTMLAnchorElement>(`.${P}__list a`)),
  flows: Array.from(el.querySelectorAll<HTMLElement>(`.${P}__flow`)),
});

function pointer(target: Element, type: string, clientY: number): void {
  const event = new MouseEvent(type, { clientY });
  target.dispatchEvent(event);
}

function stubRect(link: Element): void {
  link.getBoundingClientRect = () => ({ top: 100, height: 40, bottom: 140, left: 0, right: 200, width: 200, x: 0, y: 100, toJSON() {} }) as DOMRect;
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
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    parts(el).toggle.click();
    parts(el).links[0]!.focus();
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
    mount(el, { repeat: 2 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { speed: 0.1, duration: 300, height: '44px', bandInk: 'navy' });
    expect(el.style.getPropertyValue(`--${P}-speed`)).toBe('0.5s'); // clamped
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('300ms');
    expect(el.style.getPropertyValue(`--${P}-height`)).toBe('44px');
    expect(el.style.getPropertyValue(`--${P}-band-ink`)).toBe('navy');
    expect(el.style.getPropertyValue(`--${P}-band`)).toBe(defaults.band);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ speed: 7, duration: 900, bogus: 1, repeat: 'lots', open: 'no' });
    const handle = mount(el, { duration: 200 });
    expect(el.style.getPropertyValue(`--${P}-speed`)).toBe('7s');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('200ms');
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    expect(parts(el).flows[0]!.querySelectorAll(`.${P}__word`)).toHaveLength(defaults.repeat * 2);
    expect(el.classList.contains(`${P}--open`)).toBe(defaults.open);
    handle.destroy();
  });

  it('adds one aria-hidden band per list link, carrying the label, and leaves other links alone', () => {
    const el = host();
    const handle = mount(el, { repeat: 3 });
    const { flows, links } = parts(el);
    expect(flows).toHaveLength(2);
    expect(flows.every((flow) => flow.getAttribute('aria-hidden') === 'true')).toBe(true);
    expect(links.every((link) => link.classList.contains(`${P}__link`))).toBe(true);
    const words = Array.from(flows[1]!.querySelectorAll(`.${P}__word`), (w) => w.textContent);
    expect(words).toEqual(Array(6).fill('Stories'));
    expect(el.querySelector('a[href="#home"]')!.classList.contains(`${P}__link`)).toBe(false);
    handle.destroy();
    expect(parts(el).flows).toHaveLength(0);
  });

  it('flows the band in from the entry edge and out through the exit edge', () => {
    const el = host();
    const handle = mount(el);
    const link = parts(el).links[0]!;
    const flow = parts(el).flows[0]!;
    stubRect(link);
    pointer(link, 'pointerenter', 105); // upper half
    expect(flow.classList.contains(`${P}__flow--on`)).toBe(true);
    expect(flow.classList.contains(`${P}__flow--top`)).toBe(true);
    expect(flow.classList.contains(`${P}__flow--snap`)).toBe(false);
    pointer(link, 'pointerleave', 138); // lower half
    expect(flow.classList.contains(`${P}__flow--on`)).toBe(false);
    expect(flow.classList.contains(`${P}__flow--top`)).toBe(false);
    pointer(link, 'pointerenter', 139);
    expect(flow.classList.contains(`${P}__flow--top`)).toBe(false);
    expect(flow.classList.contains(`${P}__flow--on`)).toBe(true);
    handle.destroy();
  });

  it('gives keyboard focus the same flow as hover', () => {
    const el = host();
    const handle = mount(el);
    const link = parts(el).links[1]!;
    const flow = parts(el).flows[1]!;
    link.focus();
    expect(flow.classList.contains(`${P}__flow--on`)).toBe(true);
    link.blur();
    expect(flow.classList.contains(`${P}__flow--on`)).toBe(false);
    handle.destroy();
  });

  it('toggles the list with the button and closes it on Escape, returning focus', () => {
    const el = host();
    const handle = mount(el, { open: false });
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
    handle.destroy();
    toggle.click(); // listeners are gone
    expect(el.classList.contains(`${P}--open`)).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
  });

  it('never hides the list when there is no toggle', () => {
    const el = host(false);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--ready`)).toBe(false);
    expect(parts(el).flows).toHaveLength(2);
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
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-flowing-menu with no url() or @import, and a reduced-motion block', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@keyframes[^{]+\{[^{}]*\{[^{}]*\}\s*\}/g, '')
      .replace(/@media[^{]+\{/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-flowing-menu/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
    expect(demo).toMatch(/<nav[\s\S]*<button[\s\S]*aria-expanded="true"[\s\S]*<a /);
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
