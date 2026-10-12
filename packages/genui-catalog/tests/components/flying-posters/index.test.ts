// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/flying-posters/index.ts';
import { stubIO, stubMatchMedia, stubRaf, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/flying-posters');
const P = 'genui-flying-posters';

function host(): HTMLElement {
  const el = document.createElement('ul');
  el.dataset.genui = id;
  el.innerHTML = '<li class="genui-flying-posters__poster" id="first" style="height: 120px;"><strong>Night Swim</strong></li>'
    + '<li class="genui-flying-posters__poster"><strong>Low Tide</strong></li>';
  document.body.append(el);
  return el;
}

const clones = (el: HTMLElement): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(`.${P}__clone`));

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    raf.flush();
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(raf.pending()).toBe(0);
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { tilt: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { tilt: 30, depth: 90, perspective: 500 });
    expect(el.style.getPropertyValue(`--${P}-tilt`)).toBe('30deg');
    expect(el.style.getPropertyValue(`--${P}-depth`)).toBe('90px');
    expect(el.style.getPropertyValue(`--${P}-perspective`)).toBe('500px');
    expect(el.style.getPropertyValue(`--${P}-bend`)).toBe(`${defaults.bend}deg`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ tilt: 12, depth: 300, bogus: 1, bend: 'loud' });
    const handle = mount(el, { depth: 200 });
    expect(el.style.getPropertyValue(`--${P}-tilt`)).toBe('12deg');
    expect(el.style.getPropertyValue(`--${P}-depth`)).toBe('200px');
    expect(el.style.getPropertyValue(`--${P}-bend`)).toBe(`${defaults.bend}deg`);
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('adds aria-hidden, inert loop copies with no ids, and drives per-poster depth vars', () => {
    const el = host();
    const handle = mount(el);
    const copies = clones(el);
    expect(copies).toHaveLength(2);
    for (const copy of copies) {
      expect(copy.getAttribute('aria-hidden')).toBe('true');
      expect(copy.hasAttribute('inert')).toBe(true);
      expect(copy.hasAttribute('id')).toBe(false);
    }
    expect(el.classList.contains(`${P}--live`)).toBe(true);
    const first = el.querySelector<HTMLElement>('#first')!;
    expect(first.style.getPropertyValue(`--${P}-d`)).not.toBe('');
    handle.destroy();
    expect(clones(el)).toHaveLength(0);
    expect(first.getAttribute('style')).toBe('height: 120px;');
  });

  it('makes no copies when loop is off', () => {
    const el = host();
    const handle = mount(el, { loop: false });
    expect(clones(el)).toHaveLength(0);
    handle.destroy();
  });

  it('pauses the frame loop off-screen and stops it on destroy', () => {
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
  });

  it('passes a signal to every listener, so destroy detaches them all', () => {
    const el = host();
    const types = ['scroll', 'pointerenter', 'pointerleave', 'focusin', 'focusout', 'pointerdown', 'touchend', 'wheel'];
    const tracked = trackActiveListeners(el, types);
    const handle = mount(el);
    expect(tracked.active('scroll')).toBe(1);
    handle.destroy();
    for (const type of types) expect(tracked.active(type)).toBe(0);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const raf = stubRaf();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(el.classList.contains(`${P}--live`)).toBe(false);
    expect(clones(el)).toHaveLength(0);
    expect(raf.pending()).toBe(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    expect(clones(el)).toHaveLength(2);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    expect(clones(el)).toHaveLength(0);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-flying-posters with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-flying-posters/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns/);
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
