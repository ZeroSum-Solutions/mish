// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/3d-testimonails/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/3d-testimonails');
const P = `genui-${id}`;

function host(): HTMLElement {
  const el = document.createElement('section');
  el.dataset.genui = id;
  el.setAttribute('aria-label', 'Reviews');
  el.innerHTML = [
    `<ul class="${P}__row"><li class="${P}__item" id="q1">One</li><li class="${P}__item">Two</li></ul>`,
    `<ul class="${P}__row extra"><li class="${P}__item">Three</li></ul>`,
  ].join('');
  document.body.append(el);
  return el;
}

const clones = (el: HTMLElement) => el.querySelectorAll(`.${P}__clone`);

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
    mount(el, { tiltX: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('appends one aria-hidden, inert, id-free copy of every item and runs the loop', () => {
    const el = host();
    const handle = mount(el);
    const copies = clones(el);
    expect(copies).toHaveLength(3);
    for (const copy of Array.from(copies)) {
      expect(copy.getAttribute('aria-hidden')).toBe('true');
      expect(copy.hasAttribute('inert')).toBe(true);
      expect(copy.hasAttribute('id')).toBe(false);
    }
    expect(el.querySelectorAll('#q1')).toHaveLength(1);
    expect(el.classList.contains(`${P}--running`)).toBe(true);
    const rows = el.querySelectorAll(`.${P}__row`);
    expect(rows[0]!.classList.contains(`${P}__row--reverse`)).toBe(false);
    expect(rows[1]!.classList.contains(`${P}__row--reverse`)).toBe(true);
    handle.destroy();
    expect(clones(el)).toHaveLength(0);
  });

  it('maps options to custom properties and modifier classes', () => {
    const el = host();
    const handle = mount(el, { tiltX: 30, gap: '20px', direction: 'vertical', fade: false, reverse: true, alternate: false });
    expect(el.style.getPropertyValue(`--${P}-tilt-x`)).toBe('30deg');
    expect(el.style.getPropertyValue(`--${P}-tilt-y`)).toBe(`${defaults.tiltY}deg`);
    expect(el.style.getPropertyValue(`--${P}-gap`)).toBe('20px');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe(`${defaults.duration}s`);
    expect(el.style.getPropertyValue(`--${P}-perspective`)).toBe(`${defaults.perspective}px`);
    expect(el.classList.contains(`${P}--vertical`)).toBe(true);
    expect(el.classList.contains(`${P}--fade`)).toBe(false);
    for (const row of Array.from(el.querySelectorAll(`.${P}__row`))) {
      expect(row.classList.contains(`${P}__row--reverse`)).toBe(true);
    }
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ tiltZ: 12, duration: 40, bogus: 1, perspective: 'far', fade: 'yes' });
    const handle = mount(el, { duration: 10 });
    expect(el.style.getPropertyValue(`--${P}-tilt-z`)).toBe('12deg');
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('10s');
    expect(el.style.getPropertyValue(`--${P}-perspective`)).toBe(`${defaults.perspective}px`);
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    expect(el.classList.contains(`${P}--fade`)).toBe(true);
    handle.destroy();
  });

  it('pauses while off screen and disconnects its observer on destroy', () => {
    const io = stubIO();
    const el = host();
    const handle = mount(el);
    io.trigger(el, false);
    expect(el.classList.contains(`${P}--paused`)).toBe(true);
    io.trigger(el, true);
    expect(el.classList.contains(`${P}--paused`)).toBe(false);
    handle.destroy();
    expect(io.observers.every((o) => o.disconnected)).toBe(true);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(el.classList.contains(`${P}--running`)).toBe(false);
    expect(clones(el)).toHaveLength(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    expect(clones(el)).toHaveLength(3);
    media.fire(true);
    expect(clones(el)).toHaveLength(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it(`ships css scoped under .${P} with no url() or @import`, () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(new RegExp(P));
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
