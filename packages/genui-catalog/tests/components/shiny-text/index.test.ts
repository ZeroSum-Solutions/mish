// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/shiny-text/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/shiny-text');

function host(): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: 'Premium, by default' });
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

  it('sets the class and --genui-shiny-text-speed from the options', () => {
    const el = host();
    const handle = mount(el, { speed: 3 });
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.style.getPropertyValue('--genui-shiny-text-speed')).toBe('3s');
    handle.destroy();
  });

  it('maps every option to its custom property', () => {
    const el = host();
    const handle = mount(el, { angle: 30, base: 'red', shine: 'blue', bandWidth: 40, pause: 2 });
    expect(el.style.getPropertyValue('--genui-shiny-text-angle')).toBe('30deg');
    expect(el.style.getPropertyValue('--genui-shiny-text-base')).toBe('red');
    expect(el.style.getPropertyValue('--genui-shiny-text-shine')).toBe('blue');
    expect(el.style.getPropertyValue('--genui-shiny-text-band')).toBe('40%');
    expect(el.style.getPropertyValue('--genui-shiny-text-pause')).toBe('2s');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ speed: 5, bandWidth: 30, bogus: 1, angle: 'loud' });
    const handle = mount(el, { bandWidth: 10 });
    expect(el.style.getPropertyValue('--genui-shiny-text-speed')).toBe('5s');
    expect(el.style.getPropertyValue('--genui-shiny-text-band')).toBe('10%');
    expect(el.style.getPropertyValue('--genui-shiny-text-angle')).toBe(`${defaults.angle}deg`);
    expect(el.style.getPropertyValue('--genui-shiny-text-bogus')).toBe('');
    handle.destroy();
  });

  it('adds the disabled modifier class when disabled is set', () => {
    const el = host();
    const handle = mount(el, { disabled: true });
    expect(el.classList.contains('genui-shiny-text--disabled')).toBe(true);
    handle.destroy();
    const other = host();
    const otherHandle = mount(other);
    expect(other.classList.contains('genui-shiny-text--disabled')).toBe(false);
    otherHandle.destroy();
  });

  it('adds the pause-hover modifier class when pauseOnHover is set', () => {
    const el = host();
    const handle = mount(el, { pauseOnHover: true });
    expect(el.classList.contains('genui-shiny-text--pause-hover')).toBe(true);
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, setting only the class and properties (no inline animation style)', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-shiny-text--reduced')).toBe(true);
    expect(el.style.animation).toBe('');
    expect(el.style.getPropertyValue('--genui-shiny-text-speed')).toBe(`${defaults.speed}s`);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-shiny-text--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const el = host();
    el.className = 'headline  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { angle: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-shiny-text with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css
      .replace(/@media[^{]+\{/g, '')
      .replace(/@supports[^{]+\{/g, '')
      .replace(/@keyframes[^{]+\{[\s\S]*?\n\}/g, '')
      .match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-shiny-text/);
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
