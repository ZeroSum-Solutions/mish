// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount, parseColor } from '../../../components/silk/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/silk');
const P = `--genui-${id}`;

function host(): HTMLElement {
  const el = Object.assign(document.createElement('div'), { textContent: 'Evening studio' });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** A recording stand-in for a WebGL context: every method is a spy returning a truthy handle. */
function fakeGl(options: { compiles?: boolean } = {}) {
  const loseContext = vi.fn();
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  const gl = new Proxy({}, {
    get(_target, key: string) {
      if (key === 'then') return undefined;
      if (/^[A-Z_]+$/.test(key)) return key;
      calls[key] ??= vi.fn((...args: unknown[]) => {
        if (key === 'getExtension') return args[0] === 'WEBGL_lose_context' ? { loseContext } : null;
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return options.compiles ?? true;
        if (key === 'getAttribLocation') return 0;
        return {};
      });
      return calls[key];
    },
  });
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === 'webgl' ? gl : null)) as never);
  return { calls, loseContext, spy, draws: () => calls.drawArrays?.mock.calls.length ?? 0 };
}

beforeEach(() => {
  // jsdom has no canvas backend; default every test to "no WebGL" so the CSS fallback path runs.
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation((() => null) as never);
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
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
    mount(el, { color: '#ffcc88', rotation: 20 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { color: '#d4a373', speed: 2, rotation: 30 });
    expect(el.style.getPropertyValue(`${P}-color`)).toBe('#d4a373');
    expect(el.style.getPropertyValue(`${P}-angle`)).toBe('30deg');
    expect(el.style.getPropertyValue(`${P}-duration`)).toBe('9s');
    handle.destroy();
    const still = mount(el, { speed: 0 });
    expect(el.style.getPropertyValue(`${P}-duration`)).toBe('0s');
    still.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ color: '#aabbcc', speed: 4, bogus: 1, rotation: 'steep' });
    const handle = mount(el, { speed: 1 });
    expect(el.style.getPropertyValue(`${P}-color`)).toBe('#aabbcc');
    expect(el.style.getPropertyValue(`${P}-duration`)).toBe('18s');
    expect(el.style.getPropertyValue(`${P}-angle`)).toBe(`${defaults.rotation}deg`);
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('parses #rgb and #rrggbb colours and falls back to the default for anything else', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseColor('red')).toEqual(parseColor(defaults.color));
  });

  it('falls back to the CSS gradient with no canvas when WebGL is unavailable', () => {
    const el = host();
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(false);
    handle.destroy();
  });

  it('falls back when a shader fails to compile', () => {
    fakeGl({ compiles: false });
    const el = host();
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    handle.destroy();
  });

  it('with WebGL, renders behind the content, pauses off-screen and cleans up on destroy', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el, { noise: 5 });
    const canvas = el.querySelector('canvas');
    expect(canvas?.classList.contains(`genui-${id}__canvas`)).toBe(true);
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(el.firstChild).toBe(canvas);
    expect(el.textContent).toBe('Evening studio');
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(true);
    // noise is clamped to 1 before it reaches the shader.
    expect(gl.calls.uniform1f!.mock.calls.some((c) => c[1] === 1)).toBe(true);
    expect(gl.calls.uniform1f!.mock.calls.some((c) => c[1] === 5)).toBe(false);
    expect(raf.pending()).toBe(1);
    const drawsBefore = gl.draws();
    raf.flush();
    expect(gl.draws()).toBeGreaterThan(drawsBefore);
    io.trigger(el, false);
    expect(raf.pending()).toBe(0);
    io.trigger(el, true);
    expect(raf.pending()).toBe(1);
    handle.destroy();
    expect(raf.pending()).toBe(0);
    expect(gl.loseContext).toHaveBeenCalledTimes(1);
    expect(io.observers[0]!.disconnected).toBe(true);
    expect(el.outerHTML).toBe(before);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(raf.pending()).toBe(0); // one still frame, no loop
    expect(gl.draws()).toBe(1);
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

  it('ships css scoped under .genui-silk with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const scoped = css
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
      .replace(/@media[^{]+\{/g, '');
    const selectors = scoped.match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-silk/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns/);
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
