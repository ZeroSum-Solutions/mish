// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '../../../components/masked-heading/index.ts';
import { stubAnimate, stubIO, stubMatchMedia, unstubAnimate } from '../../_helpers.ts';

function host(html: string): HTMLElement {
  const el = document.createElement('h2');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  unstubAnimate();
});

describe('masked-heading', () => {
  it('groups a <br>-delimited heading into two lines in "br" mode', () => {
    stubIO();
    const el = host('Quiet work,<br>loud results');
    const handle = mount(el, { lines: 'br' });
    const lines = el.querySelectorAll('.genui-masked-heading__line');
    expect(lines).toHaveLength(2);
    expect(lines[0]?.textContent).toBe('Quiet work,');
    expect(lines[1]?.textContent).toBe('loud results');
    handle.destroy();
  });

  it('animates each __inner from a translateY start keyframe (rise) or an inset clip-path (wipe)', () => {
    const rise = host('Quiet work,<br>loud results');
    let io = stubIO();
    let calls = stubAnimate();
    const riseHandle = mount(rise, { lines: 'br', style: 'rise' });
    io.trigger(rise);
    expect(calls).toHaveLength(2);
    expect((calls[0]!.keyframes as Array<Record<string, string>>)[0]).toMatchObject({ transform: 'translateY(110%)' });
    riseHandle.destroy();

    const wipe = host('Quiet work,<br>loud results');
    io = stubIO();
    calls = stubAnimate();
    const wipeHandle = mount(wipe, { lines: 'br', style: 'wipe' });
    io.trigger(wipe);
    expect((calls[0]!.keyframes as Array<Record<string, string>>)[0]).toMatchObject({ clipPath: 'inset(0 100% 0 0)' });
    wipeHandle.destroy();
  });

  it('creates no line wrappers under reduced motion', () => {
    stubMatchMedia(true);
    const el = host('Quiet work,<br>loud results');
    const handle = mount(el);
    expect(el.querySelectorAll('.genui-masked-heading__line')).toHaveLength(0);
    expect(el.classList.contains('genui-masked-heading--pending')).toBe(false);
    handle.destroy();
  });

  it('destroy disconnects the ResizeObserver and IntersectionObserver, and restores outerHTML exactly', () => {
    const io = stubIO();
    const disconnect = vi.fn();
    class FakeResizeObserver {
      observe(): void {}
      disconnect(): void { disconnect(); }
    }
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);

    const el = host('Quiet work,<br>loud results');
    const before = el.outerHTML;
    const handle = mount(el); // default lines: "auto" -> ResizeObserver is attached
    expect(el.querySelectorAll('.genui-masked-heading__line').length).toBeGreaterThan(0);

    handle.destroy();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(io.observers[0]?.disconnected).toBe(true);
    expect(el.outerHTML).toBe(before);

    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });
});
