// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/glass-surface/index.ts';

const here = path.resolve(import.meta.dirname, '../../../components/glass-surface');

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

  // spec test 1: the class and custom properties come from the options.
  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { blur: 8, tint: '#112233', borderAlpha: 0.5 });
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.style.getPropertyValue('--genui-glass-surface-blur')).toBe('8px');
    expect(el.style.getPropertyValue('--genui-glass-surface-tint')).toBe('#112233');
    expect(el.style.getPropertyValue('--genui-glass-surface-border-alpha')).toBe('0.5');
    expect(el.style.getPropertyValue('--genui-glass-surface-brightness')).toBe(String(defaults.brightness));
    handle.destroy();
  });

  // spec test 3 (unknown keys): data-genui-opts merges under opts and drops unknown/wrong-typed keys.
  it('merges data-genui-opts under opts and drops unknown keys', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ blur: 6, bogus: 1, opacity: 'loud' });
    const handle = mount(el, { radius: 12 });
    expect(el.style.getPropertyValue('--genui-glass-surface-blur')).toBe('6px');
    expect(el.style.getPropertyValue('--genui-glass-surface-radius')).toBe('12px');
    expect(el.style.getPropertyValue('--genui-glass-surface-opacity')).toBe(String(defaults.opacity));
    expect(el.style.getPropertyValue('--genui-glass-surface-bogus')).toBe('');
    handle.destroy();
  });

  // spec test 2: displace:0 injects no <svg>, and displace:10 injects exactly one filter with a
  // unique id. spec test 4 (outerHTML restore for this path): destroy() removes the injected SVG.
  it('injects one uniquely-id\'d displacement filter only when displace is set, and destroy removes it', () => {
    const plain = host();
    const beforePlain = plain.outerHTML;
    const plainHandle = mount(plain, { displace: 0 });
    expect(plain.querySelector('svg')).toBeNull();
    plainHandle.destroy();
    expect(plain.outerHTML).toBe(beforePlain);

    const warped = host();
    const beforeWarped = warped.outerHTML;
    const warpedHandle = mount(warped, { displace: 10 });
    const filters = warped.querySelectorAll('filter');
    expect(filters).toHaveLength(1);
    const filterId = filters[0]!.getAttribute('id');
    expect(filterId).toBeTruthy();
    expect(warped.classList.contains('genui-glass-surface--displaced')).toBe(true);
    expect(warped.style.getPropertyValue('--genui-glass-surface-filter-url')).toBe(`url(#${filterId})`);

    const warped2 = host();
    const warpedHandle2 = mount(warped2, { displace: 10 });
    const filterId2 = warped2.querySelector('filter')!.getAttribute('id');
    expect(filterId2).not.toBe(filterId);

    warpedHandle.destroy();
    expect(warped.querySelector('svg')).toBeNull();
    expect(warped.outerHTML).toBe(beforeWarped);
    warpedHandle2.destroy();
  });

  it('ships css scoped under .genui-glass-surface with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/@import|https?:\/\//);
    const selectors = css.replace(/@[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-glass-surface/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; status: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    expect(meta.status).toBe('ported');
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
