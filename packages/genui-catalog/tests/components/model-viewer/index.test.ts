// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/model-viewer/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/model-viewer');
const P = `--genui-${id}`;

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Hi' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

const ry = (el: HTMLElement): number => parseFloat(el.style.getPropertyValue(`${P}-ry`));

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
    expect(el.querySelectorAll(`.genui-${id}__face`)).toHaveLength(defaults.sides);
    expect(el.querySelector(`.genui-${id}__model`)!.getAttribute('aria-hidden')).toBe('true');
    expect(el.getAttribute('tabindex')).toBe('0');
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class, style and tabindex byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    el.setAttribute('tabindex', '-1');
    const before = el.outerHTML;
    const handle = mount(el, { tilt: 10 });
    expect(el.getAttribute('tabindex')).toBe('-1');
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { size: 100, height: 120, colour: 'red', tilt: -20, sides: 6 });
    expect(el.style.getPropertyValue(`${P}-r`)).toBe('50px');
    expect(el.style.getPropertyValue(`${P}-h`)).toBe('120px');
    expect(el.style.getPropertyValue(`${P}-colour`)).toBe('red');
    expect(el.style.getPropertyValue(`${P}-accent`)).toBe(defaults.accent);
    expect(el.style.getPropertyValue(`${P}-rx`)).toBe('-20.00deg');
    expect(el.style.getPropertyValue(`${P}-w`)).toBe(`${(100 * Math.tan(Math.PI / 6) + 1).toFixed(2)}px`);
    expect(el.querySelectorAll(`.genui-${id}__face`)).toHaveLength(6);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ height: 90, size: 60, bogus: 1, colour: 7 });
    const handle = mount(el, { size: 40 });
    expect(el.style.getPropertyValue(`${P}-h`)).toBe('90px');
    expect(el.style.getPropertyValue(`${P}-r`)).toBe('20px');
    expect(el.style.getPropertyValue(`${P}-colour`)).toBe(defaults.colour);
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('rotates a user-supplied model instead of building one', () => {
    const el = host();
    el.innerHTML = '<svg class="genui-model-viewer__model" role="img" aria-label="Cube"></svg>';
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelectorAll(`.genui-${id}__model`)).toHaveLength(1);
    expect(el.querySelector(`.genui-${id}__face`)).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('auto-rotates with rAF, pauses off screen and stops on destroy', () => {
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const handle = mount(el, { speed: 30 });
    const start = ry(el);
    expect(raf.pending()).toBe(1);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(io.observers[0]!.disconnected).toBe(true);
    expect(start).toBe(-30);
  });

  it('turns with the arrow keys and resets on Home', () => {
    const el = host();
    const handle = mount(el, { autoRotate: false });
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }));
    expect(ry(el)).toBe(-15);
    const left = new KeyboardEvent('keydown', { key: 'ArrowLeft', cancelable: true });
    el.dispatchEvent(left);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(ry(el)).toBe(-45);
    expect(left.defaultPrevented).toBe(true);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    expect(ry(el)).toBe(-30);
    handle.destroy();
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(el.style.getPropertyValue(`${P}-ry`)).toBe('');
  });

  it('with interactive off, adds no tabindex and ignores keys', () => {
    const el = host();
    const handle = mount(el, { interactive: false });
    expect(el.hasAttribute('tabindex')).toBe(false);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(ry(el)).toBe(-30);
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const raf = stubRaf();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(raf.pending()).toBe(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(false);
    expect(raf.pending()).toBe(1);
    media.fire(true);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-model-viewer with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const stripped = css
      .replace(/@keyframes[^{]+\{[^{}]*\{[^{}]*\}\s*\}/g, '')
      .replace(/@(media|supports)[^{]+\{/g, '');
    const selectors = stripped.match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-model-viewer/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\/|xmlns/i);
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
