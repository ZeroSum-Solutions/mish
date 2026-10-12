// Original dot field with a local pointer highlight; no upstream source.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'dot-grid';
const PREFIX = `genui-${id}`;
export interface DotGridOptions { [key: string]: string | number; spacing: number; colour: string; accent: string; }
export const defaults: DotGridOptions = { spacing: 24, colour: '#8b93a7', accent: '#c4b5fd' };
export function mount(el: HTMLElement, opts: Partial<DotGridOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { spacing: `${Math.min(160, Math.max(8, options.spacing))}px`, colour: options.colour, accent: options.accent, x: '50%', y: '50%', active: 0 });
  let raf = 0; let x = 50; let y = 50;
  const write = (): void => { raf = 0; setVars(el, PREFIX, { x: `${x}%`, y: `${y}%` }); };
  const reset = (): void => { if (raf) cancelAnimationFrame(raf); raf = 0; x = y = 50; write(); setVars(el, PREFIX, { active: 0 }); };
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); reset(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  el.addEventListener('pointermove', (event) => {
   if (motion.reduced || event.pointerType === 'touch') return;
   const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) return;
   x = Math.max(0, Math.min(100, (event.clientX - rect.left) / rect.width * 100));
   y = Math.max(0, Math.min(100, (event.clientY - rect.top) / rect.height * 100));
   setVars(el, PREFIX, { active: 1 });
   if (typeof requestAnimationFrame !== 'function') write(); else if (!raf) raf = requestAnimationFrame(write);
  }, { passive: true, signal });
  el.addEventListener('pointerleave', reset, { signal });
  el.addEventListener('focusin', () => { reset(); setVars(el, PREFIX, { active: 1 }); }, { signal });
  el.addEventListener('focusout', reset, { signal });
  onDestroy(reset);
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
