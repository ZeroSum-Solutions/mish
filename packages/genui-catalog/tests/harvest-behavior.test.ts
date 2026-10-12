// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { contrastRatio, stubIO, stubMatchMedia, stubRaf } from './_helpers.ts';
import { mount as countUp } from '../components/count-up/index.ts';
import { mount as rotating } from '../components/rotating-text/index.ts';
import { mount as pixel } from '../components/pixel-transition/index.ts';
import { mount as logos } from '../components/logo-loop/index.ts';
import { mount as magnet } from '../components/magnet/index.ts';
import type { GenuiHandle } from '../src/runtime/shared.ts';

interface Effect { id: string; defaults: Record<string, unknown>; mount(el: HTMLElement, opts?: Record<string, unknown>): GenuiHandle; autoInit(root?: ParentNode): GenuiHandle[] }
const root = path.resolve(import.meta.dirname, '..');
const seed = JSON.parse(readFileSync(path.join(root, 'data/harvest-seed.json'), 'utf8')) as { components: Array<{ id: string }> };
const effects: Effect[] = await Promise.all(seed.components.map(async ({ id }) => await import(`../components/${id}/index.ts`) as Effect));
const handles: GenuiHandle[] = [];
const save = (handle: GenuiHandle): GenuiHandle => { handles.push(handle); return handle; };
function demo(id: string): HTMLElement {
 document.body.innerHTML = readFileSync(path.join(root, 'components', id, 'demo.html'), 'utf8');
 return document.querySelector<HTMLElement>(`[data-genui="${id}"]`)!;
}
beforeEach(() => { vi.spyOn(document, 'hidden', 'get').mockReturnValue(false); });
afterEach(() => { handles.splice(0).forEach(handle => handle.destroy()); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); document.body.replaceChildren(); });

describe('harvest behavior', () => {
 it.each(['count-up', 'rotating-text', 'text-type', 'decrypted-text'])('%s preserves interactive descendants as a static fallback', id => {
  stubMatchMedia(false); const el = document.createElement('h2'); el.innerHTML = '<a href="#work">View work</a>'; document.body.append(el);
  const link = el.firstChild; const handle = save(effects.find(effect => effect.id === id)!.mount(el));
  expect(el.firstChild).toBe(link); expect(el.querySelector('a')!.textContent).toBe('View work'); handle.destroy(); expect(el.firstChild).toBe(link);
 });
 it('count-up preserves the final accessible value throughout animation, finishes exactly, and cancels rAF', () => {
  stubMatchMedia(false); const io = stubIO(); let next = 1; const queue = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { queue.set(next, cb); return next++; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => { queue.delete(id); });
  const frame = (time: number): void => { const current = [...queue.values()]; queue.clear(); current.forEach(cb => cb(time)); };
  const el = demo('count-up'); const handle = save(countUp(el, { from: 10, to: -2.5, decimals: 1, prefix: '$', suffix: 'm', duration: 1000 }));
  expect(el.querySelector('.genui-count-up__readable')!.textContent).toBe('$-2.5m');
  io.trigger(el); frame(0); expect(el.querySelector('[aria-hidden]')!.textContent).toBe('$10.0m');
  frame(1000); expect(el.querySelector('[aria-hidden]')!.textContent).toBe('$-2.5m'); expect(queue.size).toBe(0);
  handle.destroy(); expect(queue.size).toBe(0); expect(io.observers[0]!.disconnected).toBe(true);
 });
 it('count-up follows option precedence and rejects non-finite and unknown values', () => {
  stubMatchMedia(true); const el = demo('count-up'); el.dataset.genuiOpts = '{"to":42,"prefix":"€","bogus":3}';
  save(countUp(el, { to: 64, duration: Infinity })); expect(el.querySelector('.genui-count-up__readable')!.textContent).toBe('€64'); expect(el.style.getPropertyValue('--genui-count-up-bogus')).toBe('');
 });
 it.each(['text-type', 'decrypted-text'])('%s keeps original emphasis nodes and whole accessible text while visual glyphs animate', id => {
  stubMatchMedia(false); const io = stubIO(); const raf = stubRaf(); const effect = effects.find(candidate => candidate.id === id)!;
  const el = document.createElement('h2'); el.innerHTML = 'Design <em>👩🏽‍🚀</em>'; document.body.append(el); const emphasis = el.querySelector('em');
  const handle = save(effect.mount(el)); io.trigger(el); raf.flush();
  expect(el.querySelector(`.genui-${id}__readable`)!.textContent).toBe('Design 👩🏽‍🚀');
  expect(el.querySelector(`[aria-hidden="true"]`)!.querySelectorAll(`.genui-${id}__char`)).toHaveLength(7);
  handle.destroy(); expect(el.querySelector('em')).toBe(emphasis); expect(raf.pending()).toBe(0);
 });
 it.each(['animated-content', 'animated-list'])('%s reveals only in view, never hides focused controls, and disconnects its observer', id => {
  stubMatchMedia(false); const io = stubIO(); const el = demo(id); const handle = save(effects.find(e => e.id === id)!.mount(el));
  expect(el.classList.contains(`genui-${id}--play`)).toBe(false);
  io.trigger(el); expect(el.classList.contains(`genui-${id}--play`)).toBe(true);
  handle.destroy(); expect(io.observers[0]!.disconnected).toBe(true);
  expect(readFileSync(path.join(root, 'components', id, 'styles.css'), 'utf8')).toContain(':focus-within');
 });
 it('rotating text cycles whole words, pauses from its button, preserves a stable accessible list, and removes timers', () => {
  vi.useFakeTimers(); stubMatchMedia(false); const el = demo('rotating-text'); const handle = save(rotating(el, { words: ['Aster', 'Northline'], interval: 1500 }));
  const current = (): string => el.querySelector('.genui-rotating-text__word--current')!.textContent!;
  expect(current()).toBe('Aster'); vi.advanceTimersByTime(1500); expect(current()).toBe('Northline');
  const button = el.querySelector('button')!; button.click(); expect(button.getAttribute('aria-pressed')).toBe('true');
  vi.advanceTimersByTime(5000); expect(current()).toBe('Northline');
  button.click(); vi.advanceTimersByTime(1500); expect(current()).toBe('Aster');
  expect(el.querySelector('.genui-rotating-text__readable')!.textContent).toBe('Aster, Northline');
  handle.destroy(); expect(vi.getTimerCount()).toBe(0);
 });
 it('rotating text stops offscreen and on reduced motion while its focused Resume control works', () => {
  vi.useFakeTimers(); const media = stubMatchMedia(false); const io = stubIO(); const el = demo('rotating-text'); save(rotating(el));
  io.trigger(el, false); expect(vi.getTimerCount()).toBe(0);
  io.trigger(el); expect(vi.getTimerCount()).toBe(1);
  const button = el.querySelector('button')!; button.focus(); vi.advanceTimersByTime(0);
  button.click(); expect(vi.getTimerCount()).toBe(0);
  button.click(); expect(vi.getTimerCount()).toBe(1);
  media.fire(true); expect(vi.getTimerCount()).toBe(0);
  expect(document.activeElement).toBe(el.querySelector('button'));
  expect(el.querySelector('button')!.getAttribute('aria-disabled')).toBe('true');
 });
 it('magnet ignores touch and reduced motion, clamps travel, and resets on keyboard focus', () => {
  const media = stubMatchMedia(false); const raf = stubRaf(); const el = demo('magnet'); save(magnet(el, { strength: 999 }));
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 100, width: 200, height: 100, toJSON() {} });
  const move = (pointerType: string): void => { const event = new Event('pointermove'); Object.assign(event, { pointerType, clientX: 2000, clientY: 1000 }); el.dispatchEvent(event); raf.flush(); };
  move('touch'); expect(el.style.getPropertyValue('--genui-magnet-x')).toBe('0px');
  move('mouse'); expect(el.style.getPropertyValue('--genui-magnet-x')).toBe('24.00px');
  el.focus(); expect(el.style.getPropertyValue('--genui-magnet-x')).toBe('0.00px');
  media.fire(true); move('mouse'); expect(raf.pending()).toBe(0);
 });
 it('logo copies have no duplicate IDs or focusable controls and the original listeners survive destroy', () => {
  stubMatchMedia(false); const el = document.createElement('div'); el.innerHTML = '<a id="client-aster" href="#aster">Aster</a><button id="client-two">Two</button>'; document.body.append(el);
  const link = el.querySelector('a')!; const clicked = vi.fn(); link.addEventListener('click', clicked); const before = el.outerHTML;
  const handle = save(logos(el)); const copy = el.querySelector<HTMLElement>('.genui-logo-loop__copy')!;
  expect(copy.getAttribute('aria-hidden')).toBe('true'); expect(copy.inert).toBe(true); expect(copy.querySelector('[id]')).toBeNull(); expect(copy.querySelector('a')!.tabIndex).toBe(-1);
  el.querySelector<HTMLButtonElement>('.genui-logo-loop__pause')!.click(); expect(el.classList.contains('genui-logo-loop--paused')).toBe(true);
  handle.destroy(); expect(el.outerHTML).toBe(before); link.click(); expect(clicked).toHaveBeenCalledOnce();
 });
 it('pixel transition waits for full tile coverage and handles fast clicks and motion changes', () => {
  vi.useFakeTimers(); const media = stubMatchMedia(false); const el = demo('pixel-transition'); const before = el.outerHTML; const handle = save(pixel(el));
  const faces = Array.from(el.querySelectorAll<HTMLElement>('[data-pixel-face]')); const button = el.querySelector('button')!;
  const states = (): boolean[] => faces.map(face => face.getAttribute('aria-hidden') === 'true');
  expect(states()).toEqual([false, true]); button.click();
  vi.advanceTimersByTime(240); expect(states()).toEqual([false, true]);
  vi.advanceTimersByTime(28); expect(states()).toEqual([true, false]); expect(faces[0]!.inert).toBe(true);
  button.click(); media.fire(true); expect(states()).toEqual([false, true]); expect(vi.getTimerCount()).toBe(0);
  button.click(); expect(states()).toEqual([true, false]);
  handle.destroy(); expect(vi.getTimerCount()).toBe(0); expect(el.outerHTML).toBe(before);
 });
 it('pixel transition snaps very short durations and keeps both faces in a fixed layout', () => {
  vi.useFakeTimers(); stubMatchMedia(false); const el = demo('pixel-transition'); save(pixel(el, { duration: 48, columns: 16 }));
  el.querySelector('button')!.click(); expect(vi.getTimerCount()).toBe(0);
  const faces = Array.from(el.querySelectorAll<HTMLElement>('[data-pixel-face]'));
  expect(faces.map(face => face.getAttribute('aria-hidden'))).toEqual(['true', 'false']); expect(faces.every(face => !face.hidden)).toBe(true);
 });
 it('logo motion can resume with focus still on its pause control', () => {
  stubMatchMedia(false); stubIO(); const el = demo('logo-loop'); save(logos(el));
  const button = el.querySelector('button')!; button.focus(); button.click(); expect(el.classList.contains('genui-logo-loop--paused')).toBe(true);
  button.click(); expect(el.classList.contains('genui-logo-loop--paused')).toBe(false);
 });
 it('logo-loop pauses outside the viewport when IntersectionObserver is unavailable', () => {
  stubMatchMedia(false); vi.stubGlobal('IntersectionObserver', undefined); const el = demo('logo-loop'); save(logos(el));
  expect(el.classList.contains('genui-logo-loop--paused')).toBe(true);
 });
 it('demo copy and controls meet contrast on the darkest and lightest shipped surfaces', () => {
  for (const fg of [[240,231,255],[184,194,216],[165,180,204]] as const) for (const bg of [[12,16,27],[48,50,75],[43,56,88]] as const) expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
  expect(contrastRatio([165,216,255], [32,36,54])).toBeGreaterThanOrEqual(3);
 });
});
