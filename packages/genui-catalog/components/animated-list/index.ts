// Clean-room behavior implementation; no upstream implementation source used.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, observeReveal, snapshotAttributes, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };

export const id = 'animated-list';
const PREFIX = `genui-${id}`;
export interface AnimatedListOptions { [key: string]: number; duration: number; distance: number; stagger: number; }
export const defaults: AnimatedListOptions = { duration: 500, distance: 14, stagger: 90 };
export function mount(el: HTMLElement, opts: Partial<AnimatedListOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { duration: `${Math.min(2000, Math.max(0, options.duration))}ms`, distance: `${Math.min(48, Math.max(0, options.distance))}px` });
  const children = Array.from(el.children).filter((child): child is HTMLElement => child instanceof HTMLElement);
  for (const [index, child] of children.entries()) {
   const restore = snapshotAttributes(child, ['class', 'style']); onDestroy(restore);
   child.classList.add(`${PREFIX}__item`);
   setVars(child, PREFIX, { delay: `${Math.min(1000, index * Math.min(200, Math.max(0, options.stagger)))}ms` });
  }
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); if (value) el.classList.remove(`${PREFIX}--play`); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  // Content is never held invisible while waiting for an observer or for script support.
  if (!motion.reduced && typeof IntersectionObserver === 'function') {
   onDestroy(observeReveal(el, () => { if (!motion.reduced) el.classList.add(`${PREFIX}--play`); }));
  }
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
