// A bounded pointer attraction authored from a behavior brief; no upstream source.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'magnet';
const PREFIX = `genui-${id}`;
export interface MagnetOptions { [key: string]: number; strength: number; duration: number; }
export const defaults: MagnetOptions = { strength: 10, duration: 240 };
export function mount(el: HTMLElement, opts: Partial<MagnetOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  const strength = Math.min(24, Math.max(0, options.strength));
  setVars(el, PREFIX, { duration: `${Math.min(600, Math.max(0, options.duration))}ms`, x: '0px', y: '0px' });
  let raf = 0; let x = 0; let y = 0;
  const write = (): void => { raf = 0; setVars(el, PREFIX, { x: `${x.toFixed(2)}px`, y: `${y.toFixed(2)}px` }); };
  const reset = (): void => { if (raf) cancelAnimationFrame(raf); raf = 0; x = 0; y = 0; write(); };
  const motion = watchReducedMotion(signal, reduced => { el.classList.toggle(`${PREFIX}--reduced`, reduced); reset(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  const move = (event: PointerEvent): void => {
   if (motion.reduced || event.pointerType === 'touch' || el.matches(':focus-within')) return;
   const rect = el.getBoundingClientRect(); if (!rect.width || !rect.height) return;
   x = Math.max(-1, Math.min(1, (event.clientX - rect.left) / rect.width * 2 - 1)) * strength;
   y = Math.max(-1, Math.min(1, (event.clientY - rect.top) / rect.height * 2 - 1)) * strength;
   if (typeof requestAnimationFrame !== 'function') write(); else if (!raf) raf = requestAnimationFrame(write);
  };
  el.addEventListener('pointermove', move, { passive: true, signal });
  el.addEventListener('pointerleave', reset, { signal });
  el.addEventListener('focusin', reset, { signal });
  onDestroy(reset);
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
