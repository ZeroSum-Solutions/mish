/**
 * scroll-expand — clean-room implementation from the effect name and its one-line description
 * ("Element expands on scroll") only; no upstream source was read. A card or media panel starts
 * inset and rounded, then opens out to its full box as it scrolls up through the viewport, and
 * closes again when scrolled back (it follows scroll both ways).
 *
 * `mount` writes one number, `--genui-scroll-expand-p` (0 = collapsed, 1 = fully open), from an
 * IntersectionObserver-gated, rAF-throttled scroll/resize listener; the stylesheet turns it into a
 * `clip-path: inset(...)` window (`mode:"clip"`, content never rescales) or a `transform: scale()`
 * (`mode:"scale"`), plus a corner radius that eases from `radius` to `endRadius`. With no script
 * the CSS falls back to p = 1, so the element is simply shown in full.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-scroll-expand` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. It appends no nodes.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'scroll-expand';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface ScrollExpandOptions {
  [key: string]: string | number | boolean;
  /** `clip` opens a window over the content; `scale` grows the whole element. */
  mode: 'clip' | 'scale';
  /** Collapsed size as a fraction of the full box (0.3-1). */
  from: number;
  /** Corner radius (px) while collapsed. */
  radius: number;
  /** Corner radius (px) once fully open. */
  endRadius: number;
  /** Viewport fraction (0 = top) of the element's top edge where expansion starts. */
  start: number;
  /** Viewport fraction of the element's top edge where it is fully open. */
  end: number;
}

export const defaults: ScrollExpandOptions = {
  mode: 'clip',
  from: 0.78,
  radius: 28,
  endRadius: 12,
  start: 0.95,
  end: 0.3,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The custom properties `mount` writes for a set of options (progress `p` excluded). */
export function toVars(options: ScrollExpandOptions): Record<string, string> {
  return {
    from: String(clamp(options.from, 0.3, 1)),
    radius: `${Math.max(0, options.radius)}px`,
    'end-radius': `${Math.max(0, options.endRadius)}px`,
  };
}

/** 0 while the top edge is below `start`, 1 once it is at or above `end`. */
export function expandProgress(top: number, viewportHeight: number, start: number, end: number): number {
  const span = start - end;
  if (span === 0 || viewportHeight <= 0) return 1;
  return clamp((start - top / viewportHeight) / span, 0, 1);
}

export function mount(el: HTMLElement, opts: Partial<ScrollExpandOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.add(`${PREFIX}--${options.mode === 'scale' ? 'scale' : 'clip'}`);

    let raf = 0;
    let attached = false;
    let io: IntersectionObserver | null = null;
    const update = (): void => {
      raf = 0;
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      const p = expandProgress(el.getBoundingClientRect().top, vh, options.start, options.end);
      el.style.setProperty(`--${PREFIX}-p`, p.toFixed(4));
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { update(); return; }
      if (!raf) raf = requestAnimationFrame(update);
    };
    const attach = (): void => {
      if (attached) return;
      attached = true;
      addEventListener('scroll', schedule, { passive: true, signal });
      addEventListener('resize', schedule, { passive: true, signal });
      schedule();
    };
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    const start = (): void => {
      el.classList.remove(REDUCED_CLASS);
      if (typeof IntersectionObserver !== 'function') { attach(); return; }
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) (entry.isIntersecting ? attach : detach)();
      }, { rootMargin: '25% 0px' });
      io.observe(el);
    };
    const stop = (): void => {
      io?.disconnect();
      io = null;
      detach();
      el.classList.add(REDUCED_CLASS);
      el.style.setProperty(`--${PREFIX}-p`, '1');
    };

    const motion = watchReducedMotion(signal, (reduced) => { (reduced ? stop : start)(); });
    (motion.reduced ? stop : start)();
    onDestroy(() => { io?.disconnect(); detach(); });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
