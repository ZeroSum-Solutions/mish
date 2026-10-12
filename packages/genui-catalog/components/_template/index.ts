/**
 * glare-hover — the reference component porters copy (`cp -r components/_template components/<id>`,
 * and `tests/components/_template/` to `tests/components/<id>/`).
 *
 * Clean-room implementation from component-specs.md §1 only. A band of light sweeps across the
 * host once on hover or keyboard focus, and slides back out (or snaps back with `playOnce`) when
 * the pointer leaves. It is css-only: the class and the `--genui-glare-hover-*` custom properties
 * are the whole effect, so it also works in a page kind that runs no script. `mount` only maps
 * options to those properties and follows the reduced-motion preference.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-glare-hover` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'glare-hover';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
/** Opacity is capped so body text keeps its contrast while the band passes over it. */
const MAX_OPACITY = 0.6;

export interface GlareHoverOptions {
  [key: string]: string | number | boolean;
  /** Direction of the band, in degrees. */
  angle: number;
  /** Size of the gradient band, as a percentage of the host. */
  size: number;
  colour: string;
  opacity: number;
  /** Sweep duration in ms. */
  duration: number;
  easing: string;
  /** Snap back instantly on leave instead of sliding out. */
  playOnce: boolean;
}

export const defaults: GlareHoverOptions = {
  angle: -45,
  size: 250,
  colour: '#ffffff',
  opacity: 0.5,
  duration: 650,
  easing: 'ease',
  playOnce: false,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: GlareHoverOptions): Record<string, string> {
  return {
    angle: `${options.angle}deg`,
    size: `${Math.max(100, options.size)}%`,
    colour: options.colour,
    opacity: String(Math.min(MAX_OPACITY, Math.max(0, options.opacity))),
    duration: `${Math.max(0, options.duration)}ms`,
    easing: options.easing,
    'return-duration': options.playOnce ? '0ms' : `${Math.max(0, options.duration)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<GlareHoverOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    // The stylesheet already honours the media query; the class mirrors it for hosts that force
    // reduced motion (a demo toggle) and keeps the JS state in step with a live preference change.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
