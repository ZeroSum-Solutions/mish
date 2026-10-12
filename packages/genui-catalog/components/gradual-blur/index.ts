/**
 * gradual-blur — clean-room implementation from the one-line description "Progressive blur
 * reveal" only (no React Bits source or docs were read). A band at the edge of a scrolling panel
 * blurs the content under it progressively: weakest where the band starts, strongest at the edge.
 * Content therefore comes into focus as it scrolls out of the band, and the band fades away once
 * the panel reaches that end, so the last (or first) item is always readable at rest.
 *
 * Technique: a stack of `layers` absolutely positioned `__layer` nodes inside one sticky, aria-hidden
 * `__edge`. Each layer carries a `backdrop-filter: blur()` that doubles (or rises linearly) from
 * layer to layer, masked to an overlapping slice of the band, so the blur ramps without a hard step.
 * The edge is `position: sticky` with a negative margin equal to its height, so it overlays the
 * scrollport edge without adding scroll height. No rAF loop runs; one rAF-throttled, passive
 * scroll listener on the host toggles the end-of-scroll fade.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-gradual-blur` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` removes every node it added and restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'gradual-blur';
const PREFIX = `genui-${id}`;
const EDGE = `${PREFIX}__edge`;
const OFF = `${EDGE}--off`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface GradualBlurOptions {
  [key: string]: string | number | boolean;
  /** Which edge(s) of the host get the blur band. */
  position: 'bottom' | 'top' | 'both';
  /** Depth of the band, any CSS length. */
  height: string;
  /** Blur at the very edge, in px. */
  strength: number;
  /** Number of stacked blur layers (1-12); more is smoother and costs more paint. */
  layers: number;
  /** How the blur rises across the band. */
  curve: 'exponential' | 'linear';
  /** Colour the band deepens towards at the edge. */
  tint: string;
  /** Fade a band out when the host is scrolled all the way to its end. */
  fadeAtEnds: boolean;
  /** Fade duration, in ms. */
  duration: number;
}

export const defaults: GradualBlurOptions = {
  position: 'bottom',
  height: '6rem',
  strength: 8,
  layers: 6,
  curve: 'exponential',
  tint: 'transparent',
  fadeAtEnds: true,
  duration: 300,
};

/** The host custom properties `mount` writes for a set of options. */
export function toVars(options: GradualBlurOptions): Record<string, string> {
  return {
    height: options.height,
    tint: options.tint,
    duration: `${Math.max(0, options.duration)}ms`,
  };
}

/** Blur (px) and mask stops (%) of layer `i` of `n`, weakest first. */
export function layerVars(i: number, n: number, strength: number, curve: string): Record<string, string> {
  const max = Math.max(0, strength);
  const blur = curve === 'linear' ? (max * (i + 1)) / n : max * 2 ** (i + 1 - n);
  const seg = 100 / n;
  const stop = (k: number): string => `${+Math.min(100, (i + k) * seg).toFixed(2)}%`;
  return { b: `${+blur.toFixed(2)}px`, s0: stop(0), s1: stop(1), s2: stop(2), s3: stop(3) };
}

export function mount(el: HTMLElement, opts: Partial<GradualBlurOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const n = Math.min(12, Math.max(1, Math.round(options.layers)));
    // Inside a list the band is an <li>, so the host's content model stays valid.
    const tag = /^(UL|OL)$/.test(el.tagName) ? 'li' : 'div';
    const makeEdge = (side: 'top' | 'bottom'): HTMLElement => {
      const edge = document.createElement(tag);
      edge.className = `${EDGE} ${EDGE}--${side}`;
      edge.setAttribute('aria-hidden', 'true');
      for (let i = 0; i < n; i += 1) {
        const layer = document.createElement('div');
        layer.className = `${PREFIX}__layer`;
        setVars(layer, PREFIX, layerVars(i, n, options.strength, options.curve));
        edge.append(layer);
      }
      onDestroy(() => { edge.remove(); });
      return edge;
    };
    const top = options.position !== 'bottom' ? makeEdge('top') : null;
    const bottom = options.position !== 'top' ? makeEdge('bottom') : null;
    if (top) el.prepend(top);
    if (bottom) el.append(bottom);
    if (!options.fadeAtEnds) return;

    let raf = 0;
    const update = (): void => {
      raf = 0;
      const room = el.scrollHeight - el.clientHeight;
      const scrollable = room > 1;
      top?.classList.toggle(OFF, scrollable && el.scrollTop <= 1);
      bottom?.classList.toggle(OFF, scrollable && el.scrollTop >= room - 1);
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { update(); return; }
      if (!raf) raf = requestAnimationFrame(update);
    };
    el.addEventListener('scroll', schedule, { passive: true, signal });
    addEventListener('resize', schedule, { passive: true, signal });
    update();
    onDestroy(() => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
