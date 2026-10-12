// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/iridescence/index.ts';
import { stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/iridescence');
const P = `--genui-${id}`;

function host(): HTMLElement {
  const el = Object.assign(document.createElement('section'), { textContent: 'Light, caught in stone' });
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
        if (key === 'getUniformLocation') return { name: args[1] };
        return {};
      });
      return calls[key];
    },
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(((type: string) => (type === 'webgl' ? gl : null)) as never);
  const uniform = (fn: string, name: string) =>
    calls[fn]?.mock.calls.filter((c) => (c[0] as { name?: string })?.name === name).map((c) => c.slice(1));
  return { calls, loseContext, uniform, draws: () => calls.drawArrays?.mock.calls.length ?? 0 };
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
    el.className = 'hero  featured';
    el.setAttribute('style', 'color: red;');
    const before = el.outerHTML;
    mount(el, { hue: 40 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { hue: 120 });
    expect(el.style.getPropertyValue(`${P}-hue`)).toBe('120deg');
    handle.destroy();
    const plain = mount(el);
    expect(el.style.getPropertyValue(`${P}-hue`)).toBe(`${defaults.hue}deg`);
    plain.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ hue: 200, bogus: 1, sheen: 'bright' });
    const handle = mount(el, { hue: 60 });
    expect(el.style.getPropertyValue(`${P}-hue`)).toBe('60deg');
    handle.destroy();
    el.dataset.genuiOpts = JSON.stringify({ hue: 200, bogus: 1 });
    const fromData = mount(el);
    expect(el.style.getPropertyValue(`${P}-hue`)).toBe('200deg');
    fromData.destroy();
    el.dataset.genuiOpts = JSON.stringify({ hue: '200' });
    const wrong = mount(el);
    expect(el.style.getPropertyValue(`${P}-hue`)).toBe(`${defaults.hue}deg`);
    expect(el.style.getPropertyValue(`${P}-bogus`)).toBe('');
    wrong.destroy();
  });

  it('drops a wrong-typed data-genui-opts value in favour of the default before it reaches the shader', () => {
    const gl = fakeGl();
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ sheen: 'bright', thickness: 99, depth: 0.2 });
    const handle = mount(el, { depth: 3 });
    expect(gl.uniform('uniform1f', 'g')).toEqual([[defaults.sheen]]);
    expect(gl.uniform('uniform1f', 'k')).toEqual([[8]]); // clamped
    expect(gl.uniform('uniform1f', 'd')).toEqual([[1]]); // opts win over data, then clamp
    handle.destroy();
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
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(false);
    handle.destroy();
  });

  it('with WebGL, renders behind the content, pauses off-screen and cleans up on destroy', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const io = stubIO();
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    const canvas = el.querySelector('canvas');
    expect(canvas?.classList.contains(`genui-${id}__canvas`)).toBe(true);
    expect(canvas?.getAttribute('aria-hidden')).toBe('true');
    expect(el.firstChild).toBe(canvas);
    expect(el.textContent).toBe('Light, caught in stone');
    expect(el.classList.contains(`genui-${id}--gl`)).toBe(true);
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

  it('holds a single still frame when speed is 0', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const el = host();
    const handle = mount(el, { speed: 0 });
    expect(raf.pending()).toBe(0);
    expect(gl.draws()).toBe(1);
    handle.destroy();
  });

  it('eases the glint toward the pointer only while interactive, and detaches on destroy', () => {
    const gl = fakeGl();
    const raf = stubRaf();
    const el = host();
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    const handle = mount(el);
    el.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 100, clientY: 0 }));
    raf.flush();
    const last = gl.uniform('uniform2f', 'm')!.at(-1)!;
    expect(last[0]).toBeGreaterThan(0.3);
    handle.destroy();

    const still = fakeGl();
    const el2 = host();
    vi.spyOn(el2, 'getBoundingClientRect').mockReturnValue({ left: 0, top: 0, width: 100, height: 100 } as DOMRect);
    const handle2 = mount(el2, { interactive: false });
    el2.dispatchEvent(Object.assign(new Event('pointermove'), { clientX: 100, clientY: 0 }));
    raf.flush();
    expect(still.uniform('uniform2f', 'm')!.every(([x]) => Math.abs((x as number) - 0.3) < 1e-9)).toBe(true);
    handle2.destroy();
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
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(raf.pending()).toBe(0);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('marks reduced motion on the CSS fallback too', () => {
    const media = stubMatchMedia(true);
    const el = host();
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    handle.destroy();
    expect(media.listeners()).toBe(0);
  });

  it('ships css scoped under .genui-iridescence with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const scoped = css
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
      .replace(/@media[^{]+\{/g, '');
    const selectors = scoped.match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-iridescence/);
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
