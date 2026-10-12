// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/decay-card/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

/** A single-callback rAF stub with a manual `step()`, so a test controls exactly one frame at a time. */
function stubFrameRaf(): { step(): void; pending(): number } {
  let queue: FrameRequestCallback[] = [];
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { queue.push(fn); return queue.length; });
  vi.stubGlobal('cancelAnimationFrame', () => { queue = []; });
  return {
    step() { const fns = queue; queue = []; for (const fn of fns) fn(0); },
    pending: () => queue.length,
  };
}

function host(): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  const media = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  media.setAttribute('class', `genui-${id}__media`);
  media.setAttribute('viewBox', '0 0 360 460');
  el.append(media);
  const caption = document.createElement('figcaption');
  caption.className = `genui-${id}__caption`;
  caption.textContent = 'No. 07 — Erosion';
  el.append(caption);
  document.body.append(el);
  return el;
}

function stubRect(el: HTMLElement): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left: 0, top: 0, width: 360, height: 460, right: 360, bottom: 460, x: 0, y: 0, toJSON() {} }),
  });
}

function fireMove(el: HTMLElement, x: number, y: number): void {
  const event = new Event('pointermove', { bubbles: true }) as unknown as PointerEvent;
  Object.defineProperty(event, 'clientX', { value: x });
  Object.defineProperty(event, 'clientY', { value: y });
  Object.defineProperty(event, 'pointerType', { value: 'mouse' });
  el.dispatchEvent(event);
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe(id, () => {
  it('injects one filter with a unique id, and points __media style.filter at it', () => {
    const el = host();
    const handle = mount(el);
    expect(el.querySelectorAll('filter')).toHaveLength(1);
    const filterId = el.querySelector('filter')!.id;
    expect(filterId.length).toBeGreaterThan(0);
    const media = el.querySelector<HTMLElement>(`.genui-${id}__media`)!;
    expect(media.style.filter).toContain(`url(#${filterId})`);
    expect(el.querySelector(`.genui-${id}__defs`)).not.toBeNull();
    handle.destroy();
  });

  it('scale rises above 0 (and stays within maxScale) after pointer movement, then decays back to 0 and the loop stops', () => {
    const raf = stubFrameRaf();
    const el = host();
    stubRect(el);
    const handle = mount(el, { maxScale: 60 });
    fireMove(el, 10, 10);
    fireMove(el, 120, 40);
    raf.step();
    const displace = el.querySelector('feDisplacementMap')!;
    const afterMove = Number(displace.getAttribute('scale'));
    expect(afterMove).toBeGreaterThan(0);
    expect(afterMove).toBeLessThanOrEqual(defaults.maxScale);

    for (let i = 0; i < 200 && raf.pending() > 0; i += 1) raf.step();
    expect(Number(displace.getAttribute('scale'))).toBe(0);
    expect(raf.pending()).toBe(0);
    handle.destroy();
  });

  it('creates no defs under reduced motion, and destroy() restores outerHTML exactly', () => {
    stubMatchMedia(true);
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}--reduced`)).toBe(true);
    expect(el.querySelector(`.genui-${id}__defs`)).toBeNull();
    expect(el.querySelector('filter')).toBeNull();
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts, drops unknown keys and wrong types, and autoInit is idempotent', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ grayscale: 0.5, bogus: 'nope', parallax: 'loud' });
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.style.getPropertyValue(`--genui-${id}-g`)).toBe('0.5');
    expect(el.style.getPropertyValue(`--genui-${id}-parallax`)).toBe('');
    expect(el.style.getPropertyValue(`--genui-${id}-bogus`)).toBe('');
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
  });
});
