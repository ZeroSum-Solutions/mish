// Independent implementation from the public index name and an authored behavior brief.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };

export const id = 'light-rays';
const PREFIX = `genui-${id}`;
export interface LightRaysOptions { [key: string]: string | number | boolean; duration: number; colour: string; intensity: number; }
export const defaults: LightRaysOptions = { duration: 2400, colour: '#b7c9ff', intensity: 0.18 };
export function mount(el: HTMLElement, opts: Partial<LightRaysOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { duration: `${Math.min(4000, Math.max(0, options.duration))}ms`, colour: options.colour, intensity: Math.min(.3, Math.max(0, options.intensity)) });
  
  const motion = watchReducedMotion(signal, reduced => el.classList.toggle(`${PREFIX}--reduced`, reduced));
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
