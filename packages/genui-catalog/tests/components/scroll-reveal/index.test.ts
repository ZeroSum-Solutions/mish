// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/scroll-reveal/index.ts';
import { spyListeners, stubIO, stubMatchMedia, stubRaf } from '../../_helpers.ts';

function host(text = 'Good design is quiet architecture'): HTMLElement {
  const el = document.createElement('blockquote');
  el.textContent = text;
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('mount creates one __word per word and an __sr span whose text equals the original textContent', () => {
    const el = host('Good design is quiet architecture');
    const [handle] = autoInit(document);
    const words = el.querySelectorAll(`.genui-${id}__word`);
    expect(words).toHaveLength(5);
    expect(Array.from(words, (w) => w.textContent)).toEqual(['Good', 'design', 'is', 'quiet', 'architecture']);
    const sr = el.querySelector(`.genui-${id}__sr`);
    expect(sr?.getAttribute('class')).toContain('__sr');
    expect(sr?.textContent).toBe('Good design is quiet architecture');
    handle!.destroy();
  });

  it('setting start/end and firing a scroll after a stubbed rect writes --genui-scroll-reveal-p between 0 and 1', () => {
    const raf = stubRaf();
    const io = stubIO();
    vi.stubGlobal('innerHeight', 800);
    const el = host();
    el.getBoundingClientRect = () => ({ top: 400, height: 100 }) as DOMRect;
    const handle = mount(el, { start: 0.9, end: 0.4 });
    io.trigger(el); // enters the near-viewport gate, which attaches the scroll listener
    window.dispatchEvent(new Event('scroll'));
    raf.flush();
    const p = Number(el.style.getPropertyValue(`--genui-${id}-p`));
    expect(p).toBeGreaterThan(0);
    expect(p).toBeLessThan(1);
    handle.destroy();
  });

  it('with reduced motion, no __word spans are created and the block keeps its original text', () => {
    const media = stubMatchMedia(true);
    const el = host('No split here');
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelectorAll(`.genui-${id}__word`)).toHaveLength(0);
    expect(el.querySelectorAll(`.genui-${id}__sr`)).toHaveLength(0);
    expect(el.textContent).toBe('No split here');
    expect(media.listeners()).toBe(1); // only the matchMedia listener
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('destroy() restores outerHTML and removes the scroll listener', () => {
    stubRaf();
    const io = stubIO();
    const listeners = spyListeners(window);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    io.trigger(el); // attach the scroll listener
    const addedBeforeDestroy = listeners.added();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
    expect(listeners.removed()).toBeGreaterThan(0);
    expect(listeners.removed()).toBeLessThanOrEqual(addedBeforeDestroy);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('declares the same defaults in meta.json props as in the code', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/scroll-reveal');
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
