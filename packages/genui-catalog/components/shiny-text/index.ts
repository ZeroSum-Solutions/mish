/**
 * shiny-text — clean-room implementation from component-specs.md §14 only. A metallic shimmer
 * band sweeps across the text on a loop, one pass every `speed` seconds with a `pause` between
 * passes. It is css-only: the class and the `--genui-shiny-text-*` custom properties are the
 * whole effect, so it also works in a page kind that runs no script. `mount` only maps options
 * to those properties and follows the reduced-motion preference, mirroring `_template/index.ts`.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-shiny-text` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'shiny-text';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const DISABLED_CLASS = `${PREFIX}--disabled`;
const PAUSE_HOVER_CLASS = `${PREFIX}--pause-hover`;

export interface ShinyTextOptions {
  [key: string]: string | number | boolean;
  /** Seconds per sweep pass. */
  speed: number;
  /** Seconds held between passes. */
  pause: number;
  base: string;
  shine: string;
  /** Width of the bright band, as a percentage of the gradient. */
  bandWidth: number;
  angle: number;
  /** Pause the sweep while the pointer or focus is over the text. */
  pauseOnHover: boolean;
  /** Show a plain solid colour with no shimmer. */
  disabled: boolean;
}

export const defaults: ShinyTextOptions = {
  speed: 3,
  pause: 1.5,
  base: '#9aa0a6',
  shine: '#ffffff',
  bandWidth: 20,
  angle: 110,
  pauseOnHover: false,
  disabled: false,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: ShinyTextOptions): Record<string, string> {
  return {
    speed: `${Math.max(0, options.speed)}s`,
    pause: `${Math.max(0, options.pause)}s`,
    base: options.base,
    shine: options.shine,
    band: `${Math.min(100, Math.max(0, options.bandWidth))}%`,
    angle: `${options.angle}deg`,
  };
}

export function mount(el: HTMLElement, opts: Partial<ShinyTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(DISABLED_CLASS, options.disabled);
    el.classList.toggle(PAUSE_HOVER_CLASS, options.pauseOnHover);
    // The stylesheet already honours the media query; the class mirrors it for hosts that force
    // reduced motion (a demo toggle) and keeps the JS state in step with a live preference change.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
