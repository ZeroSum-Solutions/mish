// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/handwriting-svg/index.ts';
import { stubAnimate, stubIO, stubMatchMedia, unstubAnimate } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/handwriting-svg');
const SVG_NS = 'http://www.w3.org/2000/svg';

/** A paths-mode host: an inline <svg> with a few single-stroke <path> children. */
function pathsHost(pathCount = 3): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg') as unknown as SVGSVGElement;
  svg.setAttribute('viewBox', '0 0 100 40');
  svg.setAttribute('aria-label', 'hi');
  svg.dataset.genui = id;
  for (let i = 0; i < pathCount; i += 1) {
    const p = document.createElementNS(SVG_NS, 'path');
    p.setAttribute('d', `M${i * 10},0 L${i * 10},40`);
    svg.append(p);
  }
  document.body.append(svg as unknown as Element);
  return svg;
}

/** A text-mode host: a plain heading with real text content. */
function textHost(text = 'Signed, sealed'): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: text });
  el.dataset.genui = id;
  el.dataset.genuiOpts = JSON.stringify({ mode: 'text' });
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unstubAnimate();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const el = pathsHost();
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

  it('paths mode: each path gets a stroke-dasharray equal to its (mocked) length, in document order', () => {
    const el = pathsHost(3);
    const paths = Array.from(el.querySelectorAll('path'));
    const lengths = [40, 65, 90];
    // jsdom does not implement SVGPathElement.getTotalLength at all, so it must be assigned
    // directly rather than spied on.
    paths.forEach((p, i) => { (p as unknown as { getTotalLength(): number }).getTotalLength = () => lengths[i]!; });
    const handle = mount(el as unknown as HTMLElement);
    paths.forEach((p, i) => {
      expect(p.style.strokeDasharray).toBe(`${lengths[i]}`);
    });
    handle.destroy();
  });

  it('paths mode: the IO trigger calls animate on each path in document order with increasing delays', () => {
    const io = stubIO();
    const animations = stubAnimate();
    const el = pathsHost(3);
    const handle = mount(el as unknown as HTMLElement, { stagger: 50 });
    expect(el.classList.contains(`genui-${id}--pending`)).toBe(true);
    io.trigger(el as unknown as Element);
    expect(animations).toHaveLength(3);
    expect(animations[0]!.options).toMatchObject({ delay: 0 });
    expect(animations[1]!.options).toMatchObject({ delay: 50 });
    expect(animations[2]!.options).toMatchObject({ delay: 100 });
    expect(el.classList.contains(`genui-${id}--pending`)).toBe(false);
    handle.destroy();
  });

  it('text mode: creates an aria-hidden SVG copy and keeps the original phrase as real, readable text', () => {
    const el = textHost('Signed, sealed');
    const handle = mount(el);
    const svg = el.querySelector(`.genui-${id}__svg`);
    expect(svg).not.toBeNull();
    expect(svg!.getAttribute('aria-hidden')).toBe('true');
    const sr = el.querySelector(`.genui-${id}__sr`);
    expect(sr).not.toBeNull();
    expect(sr!.textContent).toBe('Signed, sealed');
    handle.destroy();
  });

  it('with reduced motion, strokes are complete (dashoffset 0) at mount, and destroy restores outerHTML', () => {
    const media = stubMatchMedia(true);
    const el = pathsHost(2);
    const before = el.outerHTML;
    const paths = Array.from(el.querySelectorAll('path'));
    const handle = mount(el as unknown as HTMLElement);
    for (const p of paths) expect(p.style.strokeDashoffset).toBe('0');
    expect(el.classList.contains(`genui-${id}--pending`)).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = pathsHost(0);
    el.dataset.genuiOpts = JSON.stringify({ stagger: 40, colour: 'red', bogus: 1, duration: 'slow' });
    const handle = mount(el as unknown as HTMLElement, { strokeWidth: 3 });
    expect(el.style.getPropertyValue('--genui-handwriting-svg-colour')).toBe('red');
    expect(el.style.getPropertyValue('--genui-handwriting-svg-stroke-width')).toBe('3');
    expect(el.style.getPropertyValue('--genui-handwriting-svg-bogus')).toBe('');
    handle.destroy();
  });

  it('ships css scoped under .genui-handwriting-svg with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-handwriting-svg/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; kind: string; status: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    expect(meta.status).toBe('ported');
    expect(meta.kind).toBe('js');
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
