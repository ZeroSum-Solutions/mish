// Independently authored layered sine curves. SVG geometry is generated locally.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'waves';
const PREFIX = `genui-${id}`;
export interface WavesOptions { [key: string]: number | string; duration: number; colour: string; amplitude: number; }
export const defaults: WavesOptions = { duration: 2400, colour: '#a5b4fc', amplitude: 12 };
export function mount(el: HTMLElement, opts: Partial<WavesOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { duration: `${Math.min(4000, Math.max(0, options.duration))}ms`, colour: options.colour });
  const amplitude = Math.min(48, Math.max(0, options.amplitude));
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', '0 0 1200 400'); svg.setAttribute('preserveAspectRatio', 'none'); svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false'); svg.classList.add(`${PREFIX}__field`);
  for (let row = 0; row < 14; row++) {
   const path = document.createElementNS(ns, 'path'); const points: string[] = [];
   for (let x = -100; x <= 1300; x += 20) points.push(`${x},${(210 + row * 11 + Math.sin(x / 140 + row / 8) * amplitude * 3).toFixed(2)}`);
   path.setAttribute('d', `M${points.join(' L')}`); path.style.opacity = String(.1 + row * .025); svg.append(path);
  }
  el.prepend(svg); onDestroy(() => svg.remove());
  const motion = watchReducedMotion(signal, value => el.classList.toggle(`${PREFIX}--reduced`, value));
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
