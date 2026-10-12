// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/spotlight-card/index.ts';
import { stubMatchMedia, stubRaf } from '../../_helpers.ts';

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Realtime sync' });
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

  it('adds the class and maps colour/radius to custom properties', () => {
    const el = host();
    const handle = mount(el, { colour: 'rgba(1,2,3,0.5)', radius: 200 });
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.style.getPropertyValue('--genui-spotlight-card-colour')).toBe('rgba(1,2,3,0.5)');
    expect(el.style.getPropertyValue('--genui-spotlight-card-radius')).toBe('200px');
    expect(el.style.getPropertyValue('--genui-spotlight-card-fade')).toBe(`${defaults.fade}ms`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ radius: 150, borderGlow: 'nope', bogus: 1 });
    const handle = mount(el, { fade: 100 });
    expect(el.style.getPropertyValue('--genui-spotlight-card-radius')).toBe('150px');
    expect(el.style.getPropertyValue('--genui-spotlight-card-fade')).toBe('100ms');
    expect(el.classList.contains('genui-spotlight-card--no-border')).toBe(false); // wrong type keeps the default (true)
    expect(el.style.getPropertyValue('--genui-spotlight-card-bogus')).toBe('');
    handle.destroy();
  });

  it('tracks the pointer and toggles the on/off state, with no damping (one rAF frame)', () => {
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const handle = mount(el);
    expect(el.style.getPropertyValue('--genui-spotlight-card-x')).toBe('50%');

    el.dispatchEvent(new PointerEvent('pointerenter', { clientX: 0, clientY: 0, pointerType: 'mouse' }));
    expect(el.style.getPropertyValue('--genui-spotlight-card-on')).toBe('1');

    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 40, pointerType: 'mouse' }));
    expect(raf.pending()).toBe(1); // at most one rAF pending at a time
    raf.flush();
    expect(el.style.getPropertyValue('--genui-spotlight-card-x')).toBe('30%');
    expect(el.style.getPropertyValue('--genui-spotlight-card-y')).toBe('40%');

    el.dispatchEvent(new PointerEvent('pointerleave', { pointerType: 'mouse' }));
    expect(el.style.getPropertyValue('--genui-spotlight-card-on')).toBe('0');
    handle.destroy();
  });

  it('with reduced motion, pointermove does not move the light off centre, and hover/focus still toggle it on', () => {
    const media = stubMatchMedia(true);
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-spotlight-card--reduced')).toBe(true);

    el.dispatchEvent(new PointerEvent('pointerenter', { clientX: 30, clientY: 40, pointerType: 'mouse' }));
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 30, clientY: 40, pointerType: 'mouse' }));
    raf.flush();
    expect(el.style.getPropertyValue('--genui-spotlight-card-x')).toBe('50%');
    expect(el.style.getPropertyValue('--genui-spotlight-card-y')).toBe('50%');
    expect(el.style.getPropertyValue('--genui-spotlight-card-on')).toBe('1'); // still fixed, centred glow on hover

    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('destroy() removes listeners, cancels a pending frame and restores outerHTML', () => {
    const el = host();
    stubRect(el, { left: 0, top: 0, width: 100, height: 100 });
    const raf = stubRaf();
    const before = el.outerHTML;
    const removeSpy = vi.spyOn(el, 'removeEventListener');
    const handle = mount(el);
    el.dispatchEvent(new PointerEvent('pointermove', { clientX: 10, clientY: 10, pointerType: 'mouse' }));
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(el.outerHTML).toBe(before);
    expect(removeSpy).not.toHaveBeenCalled(); // AbortController-based listeners are removed via abort(), not removeEventListener
  });

  it('ships css scoped under .genui-spotlight-card with no url() or @import', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/spotlight-card');
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-spotlight-card/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/spotlight-card');
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/spotlight-card');
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
