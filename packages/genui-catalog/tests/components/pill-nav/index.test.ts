// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/pill-nav/index.ts';
import { stubMatchMedia, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/pill-nav');

function host(withToggle = true): HTMLElement {
  const el = document.createElement('nav');
  el.setAttribute('aria-label', 'Main');
  el.innerHTML = '<a class="genui-pill-nav__logo" href="#" aria-label="Home">o</a>'
    + (withToggle ? '<button class="genui-pill-nav__toggle" type="button" aria-label="Menu"></button>' : '')
    + '<ul class="genui-pill-nav__list">'
    + '<li><a class="genui-pill-nav__link one" href="#">Home</a></li>'
    + '<li><a class="genui-pill-nav__link two" href="#" aria-current="page">Work</a></li>'
    + '<li><a class="genui-pill-nav__link three" href="#">Contact</a></li></ul>';
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

const q = <T extends Element>(el: HTMLElement, sel: string): T => el.querySelector<T>(sel)!;
const toggleOf = (el: HTMLElement): HTMLButtonElement => q(el, 'button');
const indicatorOf = (el: HTMLElement): HTMLElement | null => el.querySelector('.genui-pill-nav__indicator');
const onLinks = (el: HTMLElement): string[] => Array.from(el.querySelectorAll('.genui-pill-nav__link--on'), (a) => a.textContent ?? '');
const setWidth = (el: HTMLElement, width: number): void => { Object.defineProperty(el, 'clientWidth', { configurable: true, value: width }); };

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
    q<HTMLAnchorElement>(el, '.three').click();
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
    mount(el, { duration: 200 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { duration: 250, accent: 'tomato', accentText: 'white' });
    expect(el.style.getPropertyValue('--genui-pill-nav-duration')).toBe('250ms');
    expect(el.style.getPropertyValue('--genui-pill-nav-accent')).toBe('tomato');
    expect(el.style.getPropertyValue('--genui-pill-nav-accent-text')).toBe('white');
    expect(el.style.getPropertyValue('--genui-pill-nav-radius')).toBe(defaults.radius);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ duration: 200, accent: 'gold', bogus: 1, radius: 5, followHover: 'yes' });
    const handle = mount(el, { accent: 'teal' });
    expect(el.style.getPropertyValue('--genui-pill-nav-duration')).toBe('200ms');
    expect(el.style.getPropertyValue('--genui-pill-nav-accent')).toBe('teal');
    expect(el.style.getPropertyValue('--genui-pill-nav-radius')).toBe(defaults.radius);
    expect(el.style.getPropertyValue('--genui-pill-nav-bogus')).toBe('');
    // followHover kept its default (true): hovering moves the pill.
    q(el, '.one').dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(onLinks(el)).toEqual(['Home']);
    handle.destroy();
  });

  it('adds one aria-hidden indicator on the current link and removes it on destroy', () => {
    const el = host();
    const handle = mount(el);
    const indicator = indicatorOf(el)!;
    expect(indicator.getAttribute('aria-hidden')).toBe('true');
    expect(indicator.style.opacity).toBe('1');
    expect(onLinks(el)).toEqual(['Work']);
    handle.destroy();
    expect(indicatorOf(el)).toBeNull();
  });

  it('follows hover and focus, and returns to the current link on leave', () => {
    const el = host();
    const handle = mount(el);
    const list = q(el, 'ul');
    q(el, '.three').dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(onLinks(el)).toEqual(['Contact']);
    list.dispatchEvent(new Event('pointerleave'));
    expect(onLinks(el)).toEqual(['Work']);
    q<HTMLAnchorElement>(el, '.one').focus();
    expect(onLinks(el)).toEqual(['Home']);
    q<HTMLAnchorElement>(el, '.one').blur();
    expect(onLinks(el)).toEqual(['Work']);
    handle.destroy();
  });

  it('does not follow hover when followHover is false', () => {
    const el = host();
    const handle = mount(el, { followHover: false });
    q(el, '.three').dispatchEvent(new Event('pointerover', { bubbles: true }));
    expect(onLinks(el)).toEqual(['Work']);
    handle.destroy();
  });

  it('moves aria-current to a clicked link and restores it on destroy', () => {
    const el = host();
    const handle = mount(el);
    q<HTMLAnchorElement>(el, '.three').click();
    expect(q(el, '.three').getAttribute('aria-current')).toBe('page');
    expect(q(el, '.two').hasAttribute('aria-current')).toBe(false);
    handle.destroy();
    expect(q(el, '.two').getAttribute('aria-current')).toBe('page');
    expect(q(el, '.three').hasAttribute('aria-current')).toBe(false);
  });

  it('leaves aria-current alone when trackActive is false', () => {
    const el = host();
    const handle = mount(el, { trackActive: false });
    q<HTMLAnchorElement>(el, '.three').click();
    expect(q(el, '.two').getAttribute('aria-current')).toBe('page');
    handle.destroy();
  });

  it('collapses below collapseBelow and wires aria-expanded, aria-controls, Esc and outside close', () => {
    const el = host();
    setWidth(el, 320);
    const outside = document.createElement('button');
    document.body.append(outside);
    const handle = mount(el);
    const toggle = toggleOf(el);
    const list = q<HTMLElement>(el, 'ul');
    expect(el.classList.contains('genui-pill-nav--compact')).toBe(true);
    expect(toggle.getAttribute('aria-controls')).toBe(list.id);
    expect(list.id).not.toBe('');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    q<HTMLAnchorElement>(el, '.one').focus();
    q(el, '.one').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);
    toggle.click();
    el.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    outside.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    toggle.click();
    q<HTMLAnchorElement>(el, '.one').click();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    handle.destroy();
    expect(list.hasAttribute('id')).toBe(false);
    expect(toggle.hasAttribute('aria-expanded')).toBe(false);
  });

  it('expands again when the host grows, and never collapses without a toggle', () => {
    const el = host();
    setWidth(el, 320);
    const handle = mount(el);
    toggleOf(el).click();
    setWidth(el, 900);
    window.dispatchEvent(new Event('resize'));
    expect(el.classList.contains('genui-pill-nav--compact')).toBe(false);
    expect(toggleOf(el).getAttribute('aria-expanded')).toBe('false');
    handle.destroy();

    const bare = host(false);
    setWidth(bare, 200);
    const other = mount(bare);
    expect(bare.classList.contains('genui-pill-nav--compact')).toBe(false);
    other.destroy();
  });

  it('removes document and window listeners on destroy', () => {
    const doc = trackActiveListeners(document, ['pointerdown']);
    const win = trackActiveListeners(window, ['resize']);
    const el = host();
    const handle = mount(el);
    expect(doc.active('pointerdown')).toBe(1);
    expect(win.active('resize')).toBe(1);
    handle.destroy();
    expect(doc.active('pointerdown')).toBe(0);
    expect(win.active('resize')).toBe(0);
  });

  it('mounts without a list and leaves the host readable', () => {
    const el = document.createElement('nav');
    el.innerHTML = '<a href="#">Home</a>';
    document.body.append(el);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(indicatorOf(el)).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-pill-nav--reduced')).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-pill-nav--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-pill-nav with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-pill-nav/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
    expect(demo).toMatch(/<nav[^>]*data-genui="pill-nav"/);
    expect(demo).toMatch(/<button[^>]*genui-pill-nav__toggle/);
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
