// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/reflective-card/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/reflective-card');

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'M. Okafor' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
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
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  // component-specs.md §4 test 1: the class is added, and metalness:0.5 sets the custom property.
  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { metalness: 0.5 });
    expect(el.classList.contains('genui-reflective-card')).toBe(true);
    expect(el.style.getPropertyValue('--genui-reflective-card-metalness')).toBe('0.5');
    expect(el.style.getPropertyValue('--genui-reflective-card-tone')).toBe(defaults.tone);
    handle.destroy();
  });

  // component-specs.md §4 test 2: out-of-range values are clamped (roughness:4 becomes 1).
  it('clamps out-of-range values', () => {
    const el = host();
    const handle = mount(el, { roughness: 4, specular: -3, shift: 500 });
    expect(el.style.getPropertyValue('--genui-reflective-card-roughness')).toBe('1');
    expect(el.style.getPropertyValue('--genui-reflective-card-specular')).toBe('0');
    expect(el.style.getPropertyValue('--genui-reflective-card-shift')).toBe('100%');
    handle.destroy();
  });

  // component-specs.md §4 test 3: mount injects no child nodes.
  it('mount injects no child nodes', () => {
    const el = host();
    const before = el.childNodes.length;
    const handle = mount(el);
    expect(el.childNodes.length).toBe(before);
    handle.destroy();
  });

  // component-specs.md §4 test 4 (+ shared invariant): destroy() restores the original style
  // attribute exactly, including on a host that already had one.
  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { lightAngle: 90 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ metalness: 0.2, shift: 60, bogus: 1, roughness: 'loud' });
    const handle = mount(el, { shift: 45 });
    expect(el.style.getPropertyValue('--genui-reflective-card-metalness')).toBe('0.2');
    expect(el.style.getPropertyValue('--genui-reflective-card-shift')).toBe('45%');
    expect(el.style.getPropertyValue('--genui-reflective-card-roughness')).toBe(String(defaults.roughness));
    expect(el.style.getPropertyValue('--genui-reflective-card-bogus')).toBe('');
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-reflective-card--reduced')).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-reflective-card--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-reflective-card with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-reflective-card/);
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
