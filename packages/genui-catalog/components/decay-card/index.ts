/**
 * decay-card — clean-room implementation from component-specs.md §11.
 *
 * An image card sits in grayscale. Pointer movement over it warps the media through an SVG
 * turbulence displacement filter, with the warp strength rising with pointer travel distance and
 * decaying back to zero (a fixed per-frame multiplier) once movement stops. While hovered or
 * focused the media eases into colour, and a small parallax offset follows the pointer. Nothing
 * loops at idle, and leaving the card returns it to a sharp grayscale state.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-decay-card` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'decay-card';
const PREFIX = `genui-${id}`;
const MEDIA_CLASS = `${PREFIX}__media`;
const DEFS_CLASS = `${PREFIX}__defs`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Below this, the warp (and the parallax offset) is treated as settled and the rAF loop stops. */
const SETTLE_SCALE = 0.05;
const SETTLE_PX = 0.05;
/** Lerp factor per frame the parallax offset eases toward its target. */
const PARALLAX_EASE = 0.3;

let seq = 0;

export interface DecayCardOptions {
  [key: string]: string | number | boolean;
  /** Peak displacement of the feDisplacementMap. */
  maxScale: number;
  /** Per-frame multiplier the warp decays by once movement stops. */
  decay: number;
  /** Multiplies pointer travel distance into displacement. */
  sensitivity: number;
  frequency: number;
  octaves: number;
  /** 0 (colour) to 1 (full grayscale) at rest. */
  grayscale: number;
  /** Max parallax offset, in px. */
  parallax: number;
  colourOnHover: boolean;
}

export const defaults: DecayCardOptions = {
  maxScale: 60,
  decay: 0.9,
  sensitivity: 1.2,
  frequency: 0.015,
  octaves: 2,
  grayscale: 1,
  parallax: 8,
  colourOnHover: true,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function mount(el: HTMLElement, opts: Partial<DecayCardOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    const grayscale = clamp01(options.grayscale);
    const parallax = Math.max(0, options.parallax);
    setVars(el, PREFIX, {
      g: grayscale,
      'hover-g': options.colourOnHover ? 0 : grayscale,
    });

    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const media = el.querySelector<HTMLElement>(`.${MEDIA_CLASS}`);
    // Reduced motion (or no media to warp): the class/property toggle above already drives the
    // static grayscale<->colour hover state through CSS. No displacement, no parallax, no nodes.
    if (!media || motion.reduced) return;

    seq += 1;
    const filterId = `${PREFIX}-filter-${seq}`;
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', DEFS_CLASS);
    svg.setAttribute('aria-hidden', 'true');
    const filter = document.createElementNS(SVG_NS, 'filter');
    filter.setAttribute('id', filterId);
    filter.setAttribute('x', '-20%');
    filter.setAttribute('y', '-20%');
    filter.setAttribute('width', '140%');
    filter.setAttribute('height', '140%');
    const turbulence = document.createElementNS(SVG_NS, 'feTurbulence');
    turbulence.setAttribute('type', 'fractalNoise');
    turbulence.setAttribute('baseFrequency', String(Math.max(0.001, options.frequency)));
    turbulence.setAttribute('numOctaves', String(Math.max(1, Math.round(options.octaves))));
    turbulence.setAttribute('result', 'noise');
    const displace = document.createElementNS(SVG_NS, 'feDisplacementMap');
    displace.setAttribute('in', 'SourceGraphic');
    displace.setAttribute('in2', 'noise');
    displace.setAttribute('scale', '0');
    displace.setAttribute('xChannelSelector', 'R');
    displace.setAttribute('yChannelSelector', 'G');
    filter.append(turbulence, displace);
    svg.append(filter);
    el.append(svg);
    onDestroy(() => svg.remove());

    const restoreMediaStyle = snapshotAttributes(media, ['style']);
    onDestroy(restoreMediaStyle);
    media.style.filter = `url(#${filterId}) grayscale(var(--${PREFIX}-g))`;

    let scale = 0;
    let tx = 0;
    let ty = 0;
    let targetX = 0;
    let targetY = 0;
    let lastX = 0;
    let lastY = 0;
    let hasLast = false;
    let raf = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';

    const clampPx = (value: number): number => Math.min(parallax, Math.max(-parallax, value));

    const write = (): void => {
      displace.setAttribute('scale', scale.toFixed(2));
      el.style.setProperty(`--${PREFIX}-tx`, `${tx.toFixed(2)}px`);
      el.style.setProperty(`--${PREFIX}-ty`, `${ty.toFixed(2)}px`);
    };

    const stopRaf = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };

    const schedule = (): void => {
      if (!hasRaf) { scale = 0; tx = targetX; ty = targetY; write(); return; }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    function tick(): void {
      raf = 0;
      scale *= Math.min(1, Math.max(0, options.decay));
      if (scale < SETTLE_SCALE) scale = 0;
      tx += (targetX - tx) * PARALLAX_EASE;
      ty += (targetY - ty) * PARALLAX_EASE;
      if (Math.abs(targetX - tx) < SETTLE_PX) tx = targetX;
      if (Math.abs(targetY - ty) < SETTLE_PX) ty = targetY;
      write();
      if (scale > 0 || tx !== targetX || ty !== targetY) schedule();
    }

    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      targetX = clampPx(((event.clientX - rect.left) / rect.width - 0.5) * 2 * parallax);
      targetY = clampPx(((event.clientY - rect.top) / rect.height - 0.5) * 2 * parallax);
      if (hasLast) {
        const distance = Math.hypot(event.clientX - lastX, event.clientY - lastY);
        const boost = Math.min(options.maxScale, distance * options.sensitivity);
        scale = Math.min(options.maxScale, Math.max(scale, boost));
      }
      lastX = event.clientX;
      lastY = event.clientY;
      hasLast = true;
      schedule();
    };

    const onLeave = (): void => {
      hasLast = false;
      targetX = 0;
      targetY = 0;
      schedule();
    };
    const onFocusIn = (): void => { targetX = 0; targetY = 0; schedule(); };

    const listenerOpts = { passive: true, signal } as const;
    el.addEventListener('pointermove', onMove, listenerOpts);
    el.addEventListener('pointerleave', onLeave, listenerOpts);
    el.addEventListener('focusin', onFocusIn, listenerOpts);
    el.addEventListener('focusout', onLeave, listenerOpts);
    signal.addEventListener('abort', stopRaf, { once: true });
    onDestroy(stopRaf);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
