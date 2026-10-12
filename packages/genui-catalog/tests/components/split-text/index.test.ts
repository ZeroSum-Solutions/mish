// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults, id, mount } from '../../../components/split-text/index.ts';
import { stubAnimate, stubIO, stubMatchMedia, unstubAnimate } from '../../_helpers.ts';

function host(text = 'Hi there'): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: text });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  unstubAnimate();
});

describe(id, () => {
  it('splits into one piece per non-space character and keeps the original text for screen readers', () => {
    stubIO();
    const el = host('Hi there');
    const handle = mount(el, { split: 'chars' });
    const nonSpaceChars = 'Hi there'.replace(/\s+/g, '').length;
    expect(el.querySelectorAll('.genui-split-text__piece')).toHaveLength(nonSpaceChars);
    expect(el.querySelector('.genui-split-text__sr')?.textContent).toBe('Hi there');
    handle.destroy();
  });

  it('animates each piece once the IO fires, staggered by index', () => {
    const io = stubIO();
    const calls = stubAnimate();
    const el = host('Hi'); // two non-space characters
    const handle = mount(el, { split: 'chars', stagger: 25 });
    expect(calls).toHaveLength(0); // nothing runs before the host is observed as visible
    io.trigger(el);
    expect(calls).toHaveLength(2);
    calls.forEach((call, i) => {
      expect((call.options as { delay: number }).delay).toBe(i * 25);
    });
    handle.destroy();
  });

  it('skips the split under reduced motion: no pieces, no pending class, no IO', () => {
    stubMatchMedia(true);
    const io = stubIO();
    const el = host('Hi there');
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.querySelectorAll('.genui-split-text__piece')).toHaveLength(0);
    expect(el.classList.contains('genui-split-text--pending')).toBe(false);
    expect(io.observers).toHaveLength(0);
    handle.destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('cancels an in-flight reveal and settles to the final state when reduced motion turns on', () => {
    const media = stubMatchMedia(false);
    const io = stubIO();
    const calls = stubAnimate();
    const el = host('Hi');
    const handle = mount(el, { split: 'chars', replayOnReenter: true });
    io.trigger(el);
    expect(calls.length).toBeGreaterThan(0);
    expect(el.classList.contains('genui-split-text--pending')).toBe(true);
    media.fire(true);
    expect(calls.every((call) => call.cancelled)).toBe(true); // no animation left running
    expect(el.classList.contains('genui-split-text--pending')).toBe(false); // every piece visible
    expect(el.querySelector('.genui-split-text__sr')?.textContent).toBe('Hi'); // text kept
    const played = calls.length;
    io.trigger(el); // the reveal no longer replays
    expect(calls).toHaveLength(played);
    handle.destroy();
  });

  it('destroy cancels every running animation and restores outerHTML exactly', () => {
    const io = stubIO();
    const calls = stubAnimate();
    const el = host('Hi');
    const before = el.outerHTML;
    const handle = mount(el, { split: 'chars' });
    io.trigger(el);
    expect(calls.length).toBeGreaterThan(0);
    handle.destroy();
    expect(calls.every((call) => call.cancelled)).toBe(true);
    expect(el.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('drops unknown data-genui-opts keys and values of the wrong type', () => {
    stubIO();
    const el = host('Hi');
    el.dataset.genuiOpts = JSON.stringify({ split: 'words', bogus: 1, duration: 'nope' });
    const handle = mount(el);
    expect(el.querySelectorAll('.genui-split-text__word')).toHaveLength(1);
    expect(el.querySelectorAll('.genui-split-text__piece')).toHaveLength(1); // words mode: one piece
    expect(el.style.getPropertyValue('--genui-split-text-from-opacity')).toBe(String(defaults.from.opacity));
    handle.destroy();
  });
});
