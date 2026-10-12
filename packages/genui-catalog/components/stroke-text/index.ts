/**
 * stroke-text — clean-room implementation from the one-line description "Outlined editorial
 * headline" only. The headline is drawn as an outline (`-webkit-text-stroke` over a transparent
 * fill); children marked `.genui-stroke-text__solid` stay solid, for the editorial mix of hollow
 * and filled words. With `fillOnHover`, a solid fill rises through the letters on hover or focus
 * (a `background-clip: text` gradient whose position transitions). It is css-only: the class and
 * the `--genui-stroke-text-*` custom properties are the whole effect, so it also works with no
 * script. `mount` only maps options to those properties and follows the reduced-motion preference.
 *
 * The text is never split or cloned, so screen readers read it once, as written.
 *
 * Contract: `mount(el, opts)` merges `data-genui-opts` under `opts` (unknown keys dropped), adds
 * `.genui-stroke-text` and `data-genui-mounted`, and returns a handle whose `destroy()` restores
 * `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'stroke-text';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const HOVER_CLASS = `${PREFIX}--fill-hover`;

export interface StrokeTextOptions {
  [key: string]: string | number | boolean;
  /** Outline width, in px. */
  strokeWidth: number;
  strokeColor: string;
  /** Colour of solid words and of the hover fill. */
  fillColor: string;
  /** Fill the outline from the bottom up on hover or focus. */
  fillOnHover: boolean;
  /** Hover fill duration, in ms. */
  duration: number;
}

export const defaults: StrokeTextOptions = {
  strokeWidth: 1.5,
  strokeColor: '#f5f5f7',
  fillColor: '#f5f5f7',
  fillOnHover: true,
  duration: 700,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: StrokeTextOptions): Record<string, string> {
  return {
    width: `${Math.max(0, options.strokeWidth)}px`,
    stroke: options.strokeColor,
    fill: options.fillColor,
    duration: `${Math.max(0, options.duration)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<StrokeTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(HOVER_CLASS, options.fillOnHover);
    // The stylesheet honours the media query itself; the class mirrors it for hosts that force
    // reduced motion (the demo toggle) and follows a live preference change.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
