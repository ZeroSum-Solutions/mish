/**
 * reflective-card — clean-room implementation from component-specs.md §4 only.
 *
 * The card reads as brushed/polished metal: a base metal tone, fine brushed streaks and a bright
 * specular band, all built from stacked gradients. At idle the band sits at `lightAngle`. On
 * hover or `:focus-visible`/`:focus-within` it shifts across the surface through a CSS
 * transition, as if the card had moved under a light. There is no loop. It is css-only: `mount`
 * only maps options to the `--genui-reflective-card-*` custom properties the stylesheet reads,
 * and follows the reduced-motion preference. It creates no nodes.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-reflective-card` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'reflective-card';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface ReflectiveCardOptions {
  [key: string]: string | number | boolean;
  /** 0–1. Raises the contrast between the dark and bright gradient stops. */
  metalness: number;
  /** 0–1. Widens the specular band and softens the brushed streaks. */
  roughness: number;
  /** 0–1. Brightness of the specular band. */
  specular: number;
  tone: string;
  /** Resting direction of the specular band, in degrees. */
  lightAngle: number;
  /** Band travel on hover, as a percent of the surface. */
  shift: number;
  /** Hover transition duration in ms. */
  duration: number;
}

export const defaults: ReflectiveCardOptions = {
  metalness: 0.8,
  roughness: 0.3,
  specular: 0.9,
  tone: '#b8bcc4',
  lightAngle: 115,
  shift: 30,
  duration: 700,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: ReflectiveCardOptions): Record<string, string> {
  return {
    metalness: String(clamp01(options.metalness)),
    roughness: String(clamp01(options.roughness)),
    specular: String(clamp01(options.specular)),
    tone: options.tone,
    angle: `${options.lightAngle}deg`,
    shift: `${clampPercent(options.shift)}%`,
    duration: `${Math.max(0, options.duration)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<ReflectiveCardOptions> = {}): GenuiHandle {
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
