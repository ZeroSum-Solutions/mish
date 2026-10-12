// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/tilted-card/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/tilted-card');

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Side A' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

function stubRect(el: HTMLElement, rect: { left: number; top: number; width: number; height: number }): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height, x: rect.left, y: rect.top, toJSON() { return this; },
  } as DOMRect);
}

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
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  // component-specs.md §16 test 1: mount wraps the children and (glare defaults to true) adds __glare.
  it('wraps the original children in __inner, plus __glare', () => {
    const el = host();
    const originalText = el.textContent;
    const handle = mount(el);
    const inner = el.querySelector(':scope > .genui-tilted-card__inner');
    expect(inner).not.toBeNull();
    expect(inner!.textContent).toBe(originalText);
    expect(inner!.querySelector(':scope > .genui-tilted-card__glare')).not.toBeNull();
    handle.destroy();
  });

  // component-specs.md §16 test 2: a pointermove at the right edge, plus a rAF flush, gives ry > 0 and <= maxTilt.
  it('tilts toward the pointer with damping, bounded by maxTilt', () => {
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const handle = mount(el, { maxTilt: 12 });
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 50, pointerType: 'mouse' }));
    raf.flush();
    const ry = parseFloat(el.style.getPropertyValue('--genui-tilted-card-ry'));
    expect(ry).toBeGreaterThan(0);
    expect(ry).toBeLessThanOrEqual(defaults.maxTilt);
    handle.destroy();
  });

  // component-specs.md §16 test 3: with reduced motion, pointermove leaves -rx/-ry at 0.
  it('with reduced motion, pointermove leaves rx/ry at 0', () => {
    stubMatchMedia(true);
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const handle = mount(el);
    expect(el.classList.contains('genui-tilted-card--reduced')).toBe(true);
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 100, clientY: 0, pointerType: 'mouse' }));
    raf.flush();
    expect(el.style.getPropertyValue('--genui-tilted-card-rx')).toBe('0.00deg');
    expect(el.style.getPropertyValue('--genui-tilted-card-ry')).toBe('0.00deg');
    handle.destroy();
  });

  // component-specs.md §16 test 4: destroy() unwraps, removes caption/glare and aria-describedby, restores outerHTML.
  it('destroy() unwraps, removes the caption/glare and aria-describedby, and restores outerHTML', () => {
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el, { caption: 'Side A — 2026' });
    expect(el.getAttribute('aria-describedby')).toBeTruthy();
    expect(el.querySelector('.genui-tilted-card__caption')).not.toBeNull();
    expect(el.querySelector('.genui-tilted-card__glare')).not.toBeNull();
    handle.destroy();
    expect(el.querySelector('.genui-tilted-card__inner')).toBeNull();
    expect(el.querySelector('.genui-tilted-card__caption')).toBeNull();
    expect(el.querySelector('.genui-tilted-card__glare')).toBeNull();
    expect(el.hasAttribute('aria-describedby')).toBe(false);
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ maxTilt: 20, glare: 'nope', bogus: 1 });
    const handle = mount(el, { scale: 1.1 });
    expect(el.classList.contains('genui-tilted-card')).toBe(true);
    // glare:'nope' (wrong type) keeps the default (true), so __glare is still appended
    expect(el.querySelector('.genui-tilted-card__glare')).not.toBeNull();
    expect(el.style.getPropertyValue('--genui-tilted-card-bogus')).toBe('');
    handle.destroy();
  });

  it('pointerleave eases back to flat and destroy() cancels a pending frame', () => {
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const handle = mount(el);
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 90, clientY: 90, pointerType: 'mouse' }));
    expect(raf.pending()).toBe(1);
    el.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    expect(el.classList.contains('genui-tilted-card--active')).toBe(false);
    expect(el.style.getPropertyValue('--genui-tilted-card-rx')).toBe('0.00deg');
    expect(el.style.getPropertyValue('--genui-tilted-card-ry')).toBe('0.00deg');
    expect(raf.pending()).toBe(0);
    handle.destroy();
  });

  it('ships css scoped under .genui-tilted-card with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-tilted-card/);
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
