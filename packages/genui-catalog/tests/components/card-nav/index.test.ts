// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/card-nav/index.ts';
import { stubMatchMedia, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/card-nav');

function host(): HTMLElement {
  const el = document.createElement('nav');
  el.setAttribute('aria-label', 'Main');
  el.innerHTML = '<div class="genui-card-nav__bar"><button class="genui-card-nav__toggle" type="button" aria-label="Menu"></button>'
    + '<a href="#">Home</a></div><div class="genui-card-nav__panel"><div class="genui-card-nav__cards">'
    + '<div class="genui-card-nav__card"><strong>Studio</strong><a href="#" class="link">About</a></div>'
    + '<div class="genui-card-nav__card"><strong>Work</strong><a href="#">Cases</a></div></div></div>';
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

const toggleOf = (el: HTMLElement): HTMLButtonElement => el.querySelector('button')!;
const key = (target: Element, k: string): void => { target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })); };

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    toggleOf(el).click();
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
    mount(el, { open: true }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { duration: 300, radius: '8px' });
    expect(el.style.getPropertyValue('--genui-card-nav-duration')).toBe('300ms');
    expect(el.style.getPropertyValue('--genui-card-nav-radius')).toBe('8px');
    expect(el.style.getPropertyValue('--genui-card-nav-stagger')).toBe(`${defaults.stagger}ms`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ duration: 200, stagger: 90, bogus: 1, radius: 5, open: 'yes' });
    const handle = mount(el, { stagger: 30 });
    expect(el.style.getPropertyValue('--genui-card-nav-duration')).toBe('200ms');
    expect(el.style.getPropertyValue('--genui-card-nav-stagger')).toBe('30ms');
    expect(el.style.getPropertyValue('--genui-card-nav-radius')).toBe(defaults.radius);
    expect(el.style.getPropertyValue('--genui-card-nav-bogus')).toBe('');
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('false');
    handle.destroy();
  });

  it('wires aria-expanded and aria-controls, and toggles on click', () => {
    const el = host();
    const handle = mount(el);
    const toggle = toggleOf(el);
    const panel = el.querySelector<HTMLElement>('.genui-card-nav__panel')!;
    expect(el.classList.contains('genui-card-nav--ready')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.id).not.toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(el.classList.contains('genui-card-nav--open')).toBe(true);
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    handle.destroy();
    expect(panel.hasAttribute('id')).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
  });

  it('closes on Esc and returns focus to the toggle', () => {
    const el = host();
    const handle = mount(el, { open: true });
    const link = el.querySelector<HTMLAnchorElement>('.link')!;
    link.focus();
    key(link, 'Escape');
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggleOf(el));
    handle.destroy();
  });

  it('closes on an outside pointer down and after a panel link is chosen', () => {
    const el = host();
    const outside = document.createElement('button');
    document.body.append(outside);
    const handle = mount(el, { open: true });
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('true');
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('false');
    toggleOf(el).click();
    el.querySelector<HTMLAnchorElement>('.link')!.click();
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('false');
    handle.destroy();
  });

  it('respects closeOnOutside and closeOnLink set to false', () => {
    const el = host();
    const handle = mount(el, { open: true, closeOnOutside: false, closeOnLink: false });
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    el.querySelector<HTMLAnchorElement>('.link')!.click();
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('true');
    handle.destroy();
  });

  it('removes the document listener on destroy', () => {
    const tracked = trackActiveListeners(document, ['pointerdown']);
    const el = host();
    const handle = mount(el);
    expect(tracked.active('pointerdown')).toBe(1);
    handle.destroy();
    expect(tracked.active('pointerdown')).toBe(0);
  });

  it('mounts without a toggle or panel and leaves the host readable', () => {
    const el = document.createElement('nav');
    el.innerHTML = '<a href="#">Home</a>';
    document.body.append(el);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-card-nav--ready')).toBe(false);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-card-nav--reduced')).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-card-nav--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-card-nav with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-card-nav/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
    expect(demo).toMatch(/<nav[^>]*data-genui="card-nav"/);
    expect(demo).toMatch(/<button[^>]*genui-card-nav__toggle/);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([k, value]) => [k, value.default]));
    expect(declared).toEqual(defaults);
  });
});
