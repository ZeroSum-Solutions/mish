// Independent implementation from the public index name and an authored behavior brief.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };

export const id = 'star-border';
const PREFIX = `genui-${id}`;
export interface StarBorderOptions { [key: string]: string | number | boolean; duration: number; colour: string; animate: boolean; }
export const defaults: StarBorderOptions = { duration: 1800, colour: '#c4b5fd', animate: true };
export function mount(el: HTMLElement, opts: Partial<StarBorderOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { duration: `${Math.min(4000, Math.max(0, options.duration))}ms`, colour: options.colour });
  el.classList.toggle(`${PREFIX}--static`, !options.animate);
  const motion = watchReducedMotion(signal, reduced => el.classList.toggle(`${PREFIX}--reduced`, reduced));
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
