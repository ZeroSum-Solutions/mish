// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/split-flap-text/index.ts';
import { stubIO, stubMatchMedia, trackActiveListeners } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/split-flap-text');

function host(text = 'Gate 12'): HTMLElement {
  const el = Object.assign(document.createElement('h2'), { textContent: text });
  el.dataset.genui = id;
  document.body.append(el);
  return el;
}

function board(el: HTMLElement): string {
  return Array.from(el.querySelectorAll('.genui-split-flap-text__t'), (part) => part.textContent).join('');
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    mount(el, { flipDuration: 60 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('keeps the original text once for screen readers and builds an aria-hidden tile per character', () => {
    const el = host('Gate 12');
    const handle = mount(el);
    expect(el.querySelector('.genui-split-flap-text__sr')?.textContent).toBe('Gate 12');
    const tiles = el.querySelector('.genui-split-flap-text__board');
    expect(tiles?.getAttribute('aria-hidden')).toBe('true');
    expect(el.querySelectorAll('.genui-split-flap-text__cell')).toHaveLength(7);
    expect(el.querySelectorAll('.genui-split-flap-text__word')).toHaveLength(2);
    handle.destroy();
  });

  it('flips through random characters and settles on the uppercased target', () => {
    vi.useFakeTimers();
    const el = host('Gate 12');
    const handle = mount(el, { flips: 4 });
    vi.advanceTimersByTime(defaults.flipDuration);
    expect(el.querySelector('.genui-split-flap-text__cell--flip')).not.toBeNull();
    vi.runAllTimers();
    expect(board(el)).toBe('GATE 12');
    expect(vi.getTimerCount()).toBe(0); // loop: 0 plays once and stops
    handle.destroy();
  });

  it('starts blank, plays only in view, pauses off-screen and stops on destroy', () => {
    vi.useFakeTimers();
    const io = stubIO();
    const el = host('Oslo');
    const before = el.outerHTML;
    const handle = mount(el, { flips: 2 });
    expect(board(el)).toBe('    ');
    expect(vi.getTimerCount()).toBe(0);
    io.trigger(el);
    expect(vi.getTimerCount()).toBe(1);
    io.trigger(el, false);
    expect(vi.getTimerCount()).toBe(0);
    io.trigger(el);
    vi.runAllTimers();
    expect(board(el)).toBe('OSLO');
    io.trigger(el); // replay on hover while visible, then destroy mid-run
    el.dispatchEvent(new Event('pointerenter'));
    expect(vi.getTimerCount()).toBe(1);
    handle.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(io.observers[0]?.disconnected).toBe(true);
    expect(el.outerHTML).toBe(before);
  });

  it('removes every host listener on destroy', () => {
    const el = host();
    const listeners = trackActiveListeners(el, ['pointerenter', 'focusin']);
    const handle = mount(el);
    expect(listeners.active('pointerenter')).toBe(1);
    expect(listeners.active('focusin')).toBe(1);
    handle.destroy();
    expect(listeners.active('pointerenter')).toBe(0);
    expect(listeners.active('focusin')).toBe(0);
  });

  it('maps options to custom properties', () => {
    const el = host();
    const handle = mount(el, { flipDuration: 120, tile: 'navy', ink: 'gold' });
    expect(el.style.getPropertyValue('--genui-split-flap-text-duration')).toBe('120ms');
    expect(el.style.getPropertyValue('--genui-split-flap-text-tile')).toBe('navy');
    expect(el.style.getPropertyValue('--genui-split-flap-text-ink')).toBe('gold');
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host('Gate');
    el.dataset.genuiOpts = JSON.stringify({ flipDuration: 90, ink: 'teal', uppercase: false, bogus: 1, tile: 5 });
    const handle = mount(el, { ink: 'red' });
    expect(el.style.getPropertyValue('--genui-split-flap-text-duration')).toBe('90ms');
    expect(el.style.getPropertyValue('--genui-split-flap-text-ink')).toBe('red');
    expect(el.style.getPropertyValue('--genui-split-flap-text-tile')).toBe(defaults.tile);
    expect(el.style.getPropertyValue('--genui-split-flap-text-bogus')).toBe('');
    handle.destroy();
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(true);
    const io = stubIO();
    const el = host('Gate 12');
    const before = el.outerHTML;
    const handle = mount(el);
    expect(el.classList.contains('genui-split-flap-text--reduced')).toBe(true);
    expect(board(el)).toBe('GATE 12'); // final characters on still tiles
    expect(vi.getTimerCount()).toBe(0);
    expect(io.observers).toHaveLength(0);
    expect(media.listeners()).toBe(1);
    media.fire(false);
    expect(el.classList.contains('genui-split-flap-text--reduced')).toBe(false);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('snaps to the final text when reduced motion turns on mid-flip', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(false);
    const el = host('Lisbon');
    const handle = mount(el, { flips: 8 });
    vi.advanceTimersByTime(defaults.flipDuration * 2);
    media.fire(true);
    expect(el.classList.contains('genui-split-flap-text--reduced')).toBe(true);
    expect(board(el)).toBe('LISBON');
    expect(el.querySelector('.genui-split-flap-text__cell--flip')).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    handle.destroy();
  });

  it('ships css scoped under .genui-split-flap-text with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const scoped = css
      .replace(/@keyframes[^{]+\{(?:[^{}]*\{[^}]*\})*[^}]*\}/g, '')
      .replace(/@media[^{]+\{/g, '');
    const selectors = scoped.match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-split-flap-text/);
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
