// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/glare-hover/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

// Copied from tests/components/_template (glare-hover is the reference component).
const here = path.resolve(import.meta.dirname, '../../../components/glare-hover');

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Hi' });
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

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { angle: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { angle: 30, colour: 'red' });
    expect(el.style.getPropertyValue('--genui-glare-hover-angle')).toBe('30deg');
    expect(el.style.getPropertyValue('--genui-glare-hover-colour')).toBe('red');
    expect(el.style.getPropertyValue('--genui-glare-hover-duration')).toBe(`${defaults.duration}ms`);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ angle: 12, size: 300, bogus: 1, opacity: 'loud' });
    const handle = mount(el, { size: 200 });
    expect(el.style.getPropertyValue('--genui-glare-hover-angle')).toBe('12deg');
    expect(el.style.getPropertyValue('--genui-glare-hover-size')).toBe('200%');
    expect(el.style.getPropertyValue('--genui-glare-hover-opacity')).toBe(String(defaults.opacity));
    expect(el.style.getPropertyValue('--genui-glare-hover-bogus')).toBe('');
    handle.destroy();
  });

  it('caps opacity and snaps back when playOnce is set', () => {
    const el = host();
    const handle = mount(el, { opacity: 0.9, playOnce: true });
    expect(el.style.getPropertyValue('--genui-glare-hover-opacity')).toBe('0.6');
    expect(el.style.getPropertyValue('--genui-glare-hover-return-duration')).toBe('0ms');
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-glare-hover--reduced')).toBe(true);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-glare-hover--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-glare-hover with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-glare-hover/);
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
