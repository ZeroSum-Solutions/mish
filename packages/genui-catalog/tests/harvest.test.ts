// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectCleanDemoFragment, expectScopedCss, stubIO, stubMatchMedia } from './_helpers.ts';
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

for (const effect of effects) describe(effect.id, () => {
 it('mounts its demo and restores exact markup and original node identity on repeated destroy', () => {
  stubMatchMedia(false); stubIO();
  const el = demo(effect.id); const before = el.outerHTML; const nodes = Array.from(el.childNodes);
  const handle = save(effect.mount(el));
  expect(el.classList.contains(`genui-${effect.id}`)).toBe(true);
  expect(el.hasAttribute('data-genui-mounted')).toBe(true);
  handle.destroy(); handle.destroy();
  expect(el.outerHTML).toBe(before); expect(Array.from(el.childNodes)).toEqual(nodes);
 });
 it('auto-init mounts once and leaves an existing owner intact', () => {
  stubMatchMedia(true); const el = demo(effect.id);
  const mounted = effect.autoInit(); handles.push(...mounted);
  expect(mounted).toHaveLength(1); expect(effect.autoInit()).toHaveLength(0);
  const duplicate = effect.mount(el); duplicate.destroy();
  expect(el.hasAttribute('data-genui-mounted')).toBe(true);
 });
 it('honors initial and live reduced motion and cleans up its media listener', () => {
  const media = stubMatchMedia(true); const el = demo(effect.id); const before = el.outerHTML;
  const handle = save(effect.mount(el));
  expect(el.classList.contains(`genui-${effect.id}--reduced`)).toBe(true);
  media.fire(false); expect(el.classList.contains(`genui-${effect.id}--reduced`)).toBe(false);
  media.fire(true); expect(el.classList.contains(`genui-${effect.id}--reduced`)).toBe(true);
  handle.destroy(); expect(media.listeners()).toBe(0); expect(el.outerHTML).toBe(before);
 });
 it('keeps visible content without animation or observer APIs', () => {
  stubMatchMedia(false); vi.stubGlobal('IntersectionObserver', undefined); vi.stubGlobal('requestAnimationFrame', undefined);
  const el = demo(effect.id); save(effect.mount(el));
  expect(el.textContent!.trim().length).toBeGreaterThan(0);
  expect(Array.from(el.querySelectorAll<HTMLElement>('[style]')).filter(node => node.style.opacity === '0')).toHaveLength(0);
 });
 it('has scoped CSP-safe CSS and a clean demo fragment', () => {
  expectScopedCss(path.join(root, 'components', effect.id, 'styles.css'), effect.id);
  expectCleanDemoFragment(path.join(root, 'components', effect.id, 'demo.html'), effect.id);
  expect(readFileSync(path.join(root, 'components', effect.id, 'styles.css'), 'utf8')).toContain('prefers-reduced-motion: reduce');
 });
 it('declares the runtime defaults in its option schema', () => {
  const meta = JSON.parse(readFileSync(path.join(root, 'components', effect.id, 'meta.json'), 'utf8')) as { props: { properties: Record<string, { default: unknown }> } };
  expect(Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]))).toEqual(effect.defaults);
 });
});

