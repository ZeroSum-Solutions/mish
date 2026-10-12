// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/masonry/index.ts';
import { stubAnimate, stubIO, stubMatchMedia, unstubAnimate } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/masonry');

function host(itemCount = 3): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  for (let i = 0; i < itemCount; i += 1) {
    const item = document.createElement('div');
    item.className = 'genui-masonry__item';
    item.textContent = `Item ${i}`;
    el.append(item);
  }
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  unstubAnimate();
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

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'gallery  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { columns: 4 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps columns and gap to custom properties', () => {
    const el = host(0);
    const handle = mount(el, { columns: 4, gap: '24px' });
    expect(el.style.getPropertyValue('--genui-masonry-cols')).toBe('4');
    expect(el.style.getPropertyValue('--genui-masonry-gap')).toBe('24px');
    expect(el.style.getPropertyValue('--genui-masonry-min')).toBe(defaults.minColumn);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host(0);
    el.dataset.genuiOpts = JSON.stringify({ columns: 5, gap: '20px', bogus: 1, duration: 'slow' });
    const handle = mount(el, { gap: '30px' });
    expect(el.style.getPropertyValue('--genui-masonry-cols')).toBe('5');
    expect(el.style.getPropertyValue('--genui-masonry-gap')).toBe('30px');
    expect(el.style.getPropertyValue('--genui-masonry-duration')).toBe(`${defaults.duration}ms`);
    expect(el.style.getPropertyValue('--genui-masonry-bogus')).toBe('');
    handle.destroy();
  });

  it('reveals each item once via IO, staggered by intersection order (not DOM index)', () => {
    const io = stubIO();
    const animations = stubAnimate();
    const el = host(3);
    const handle = mount(el, { stagger: 60, duration: 400 });
    expect(el.classList.contains('genui-masonry--pending')).toBe(true);
    const items = Array.from(el.querySelectorAll<HTMLElement>('.genui-masonry__item'));

    // Enter the last item first: its entry order (0) drives its delay, not its DOM index (2).
    io.trigger(items[2]!);
    io.trigger(items[0]!);
    expect(animations).toHaveLength(2);
    expect(animations[0]!.options).toMatchObject({ duration: 400, delay: 0 });
    expect(animations[1]!.options).toMatchObject({ duration: 400, delay: 60 });

    // Already-revealed items are unobserved, so a repeat trigger animates nothing new.
    io.trigger(items[2]!);
    expect(animations).toHaveLength(2);

    handle.destroy();
  });

  it('creates no IO and no pending class when reveal is false', () => {
    const io = stubIO();
    const el = host(2);
    const handle = mount(el, { reveal: false });
    expect(el.classList.contains('genui-masonry--pending')).toBe(false);
    expect(io.observers.every((observer) => observer.targets.size === 0)).toBe(true);
    handle.destroy();
  });

  it('skips the pending class under reduced motion, and destroy restores outerHTML', () => {
    stubMatchMedia(true);
    const el = host(2);
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-masonry--pending')).toBe(false);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('sets the no-lift modifier class when hoverLift is false', () => {
    const el = host(0);
    const handle = mount(el, { hoverLift: false });
    expect(el.classList.contains('genui-masonry--no-lift')).toBe(true);
    handle.destroy();
    expect(el.classList.contains('genui-masonry--no-lift')).toBe(false);
  });

  it('ships css scoped under .genui-masonry with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-masonry/);
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
