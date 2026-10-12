// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount, parseColor } from '../../../components/warp-text/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/warp-text');
const P = `--genui-${id}`;
const TEXT = 'Northern lights over the fjord';

function host(): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: TEXT });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

/** A recording stand-in for a context: every method is a spy returning a truthy handle. */
function fakeContext(options: { compiles?: boolean } = {}) {
  const loseContext = vi.fn();
  const calls: Record<string, ReturnType<typeof vi.fn>> = {};
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key === 'then') return undefined;
      if (key in target) return target[key];
      if (/^[A-Z_]+$/.test(key)) return key;
      calls[key] ??= vi.fn((...args: unknown[]) => {
        if (key === 'getExtension') return args[0] === 'WEBGL_lose_context' ? { loseContext } : null;
        if (key === 'getShaderParameter' || key === 'getProgramParameter') return options.compiles ?? true;
        if (key === 'getAttribLocation') return 0;
        return {};
      });
      return calls[key];
    },
    set(target, key: string, value) { target[key] = value; return true; },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === 'webgl' || type === '2d' ? ctx : null)) as never);
  return { calls, loseContext, draws: () => calls.drawArrays?.mock.calls.length ?? 0 };
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
    mount(el, { from: '#ffcc88', amplitude: 9 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { from: '#ff8800', to: '#00ffaa', amplitude: 10, chroma: 2, interactive: false });
    expect(el.style.getPropertyValue(`${P}-from`)).toBe('#ff8800');
    expect(el.style.getPropertyValue(`${P}-to`)).toBe('#00ffaa');
    expect(el.style.getPropertyValue(`${P}-pad`)).toBe('16px');
    handle.destroy();
    const big = mount(el, { amplitude: 500, chroma: 100 }); // clamped: 40 * 2 + 6 + 4
    expect(el.style.getPropertyValue(`${P}-pad`)).toBe('90px');
    big.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ from: '#aabbcc', to: '#112233', bogus: 1, amplitude: 'wild', interactive: 'yes' });
    const handle = mount(el, { to: '#445566' });
    expect(el.style.getPropertyValue(`${P}-from`)).toBe('#aabbcc');
    expect(el.style.getPropertyValue(`${P}-to`)).toBe('#445566');
    // defaults: amplitude 5 * 2 (interactive stays true) + chroma 0.8 + 4 -> ceil 15
    expect(el.style.getPropertyValue(`${P}-pad`)).toBe('15px');
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('parses #rgb and #rrggbb colours and falls back for anything else', () => {
    expect(parseColor('#fff')).toEqual([1, 1, 1]);
    expect(parseColor('#ff0000')).toEqual([1, 0, 0]);
    expect(parseColor('red')).toEqual(parseColor(defaults.from));
  });

  it('falls back to static gradient text with no canvas when WebGL is unavailable', () => {
    const el = host();
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(false);
    expect(el.textContent).toBe(TEXT);
    handle.destroy();
  });

  it('falls back when a shader fails to compile', () => {
    fakeContext({ compiles: false });
    const el = host();
    const handle = mount(el);
    expect(el.querySelector('canvas')).toBeNull();
    handle.destroy();
  });

  it('with WebGL, keeps the text readable once, pauses off-screen and cleans up on destroy', () => {
    const gl = fakeContext();
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    const canvas = el.querySelector('canvas');
    expect(canvas?.classList.contains(`genui-${id}__canvas`)).toBe(true);
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelectorAll('canvas')).toHaveLength(1);
    expect(el.textContent).toBe(TEXT);
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(true);
    expect(gl.calls.texImage2D).toHaveBeenCalled();
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

  it('attaches pointer listeners only when interactive, all tied to the signal', () => {
    fakeContext();
    const el = host();
    const add = vi.spyOn(el, 'addEventListener');
    const handle = mount(el, { interactive: false });
    expect(add.mock.calls.map((c) => c[0])).not.toContain('pointermove');
    handle.destroy();
    add.mockClear();
    const live = mount(el);
    const types = add.mock.calls.map((c) => c[0]);
    expect(types).toContain('pointermove');
    for (const call of add.mock.calls) expect((call[2] as AddEventListenerOptions).signal).toBeInstanceOf(AbortSignal);
    live.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    const gl = fakeContext();
    const raf = stubRaf();
    const media = stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(raf.pending()).toBe(0); // no loop
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

  it('ships css scoped under .genui-warp-text with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const scoped = css.replace(/@(media|supports)[^{]+\{/g, '');
    const selectors = scoped.match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-warp-text/);
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
