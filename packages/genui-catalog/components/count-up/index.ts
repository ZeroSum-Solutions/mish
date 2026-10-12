// Independent implementation from the public index name and an authored behavior brief.
import { autoInitComponent, mountComponent, resolveOptions, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };

import { observeReveal } from '../../src/runtime/shared.ts';
export const id = 'count-up';
const PREFIX = `genui-${id}`;
export interface CountUpOptions { [key: string]: string | number; from: number; to: number; duration: number; decimals: number; prefix: string; suffix: string; }
export const defaults: CountUpOptions = { from: 0, to: 128, duration: 1200, decimals: 0, prefix: '', suffix: '' };
export function mount(el: HTMLElement, opts: Partial<CountUpOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  if (el.querySelector('a, button, input, select, textarea, [tabindex], [contenteditable]')) return;
  const options = resolveOptions(el, defaults, opts);
  const duration = Math.min(4000, Math.max(0, options.duration));
  const digits = Math.min(4, Math.max(0, Math.round(options.decimals)));
  const format = (value: number): string => `${options.prefix}${value.toFixed(digits)}${options.suffix}`;
  const original = Array.from(el.childNodes);
  const visual = document.createElement('span'); visual.className = `${PREFIX}__value`; visual.setAttribute('aria-hidden', 'true');
  const readable = document.createElement('span'); readable.className = `${PREFIX}__readable`; readable.textContent = format(options.to);
  visual.textContent = format(options.to); el.replaceChildren(visual, readable);
  let raf = 0; let started = false; let reduced = false;
  const settle = (): void => { if (raf) cancelAnimationFrame(raf); raf = 0; visual.textContent = format(options.to); };
  const motion = watchReducedMotion(signal, value => { reduced = value; el.classList.toggle(`${PREFIX}--reduced`, value); if (value) settle(); });
  reduced = motion.reduced; el.classList.toggle(`${PREFIX}--reduced`, reduced);
  onDestroy(() => { settle(); el.replaceChildren(...original); });
  onDestroy(observeReveal(el, () => {
   if (started || reduced || duration === 0 || typeof requestAnimationFrame !== 'function') return;
   started = true; let start: number | undefined;
   const tick = (now: number): void => {
    raf = 0; start ??= now; const progress = Math.min(1, Math.max(0, (now - start) / duration));
    visual.textContent = format(options.from + (options.to - options.from) * (1 - (1 - progress) ** 3));
    if (progress < 1 && !signal.aborted && !reduced) raf = requestAnimationFrame(tick);
   };
   visual.textContent = format(options.from); raf = requestAnimationFrame(tick);
  }));
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
