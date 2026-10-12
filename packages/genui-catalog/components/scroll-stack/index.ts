/**
 * scroll-stack — clean-room implementation from the effect description ("Cards stack as you
 * scroll") only; no upstream source was read, and the upstream smooth-scroll dependency is not used.
 *
 * Each `.genui-scroll-stack__card` child is `position: sticky`, pinned a little lower than the
 * card before it (`top + index * offset`), so as the page scrolls each card slides up and settles
 * on top of the pile, leaving a thin ledge of every earlier card visible. The stacking itself is
 * plain CSS and needs no script. `mount` adds the depth cue: an IntersectionObserver-gated,
 * rAF-throttled scroll listener measures how far each later card has slid over each earlier one
 * and writes that as `--genui-scroll-stack-d` on the card, which the stylesheet turns into a
 * small scale-down and dim. Native scrolling is never hijacked or smoothed.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-scroll-stack` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (each card's `style` attribute is
 * snapshotted and put back too).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'scroll-stack';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const CARD_SELECTOR = `:scope > .${PREFIX}__card`;

export interface ScrollStackOptions {
  [key: string]: string | number | boolean;
  /** Distance from the top of the scroll container where the first card pins, in px. */
  top: number;
  /** Extra pin offset per card, in px, so a ledge of each earlier card stays visible. */
  offset: number;
  /** Scroll distance between cards before they stack, in px. */
  gap: number;
  /** Scale lost per card stacked on top (0.05 = 5%). */
  scaleStep: number;
  /** Brightness lost per card stacked on top (0.15 = 15%). */
  dim: number;
  /** Maximum number of stacked cards that keep adding depth. */
  maxDepth: number;
}

export const defaults: ScrollStackOptions = {
  top: 24,
  offset: 12,
  gap: 48,
  scaleStep: 0.05,
  dim: 0.15,
  maxDepth: 3,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: ScrollStackOptions): Record<string, string> {
  return {
    top: `${options.top}px`,
    offset: `${Math.max(0, options.offset)}px`,
    gap: `${Math.max(0, options.gap)}px`,
    scale: String(clamp(options.scaleStep, 0, 0.3)),
    dim: String(clamp(options.dim, 0, 0.8)),
  };
}

/**
 * How many later cards (fractionally) sit on top of card `index`: for each later card, 0 while it
 * is a full card-height away from its resting ledge and 1 once it has settled there.
 */
export function stackDepth(tops: readonly number[], heights: readonly number[], index: number, offset: number, maxDepth: number): number {
  const top = tops[index] ?? 0;
  const height = heights[index] ?? 0;
  if (height <= 0) return 0;
  let depth = 0;
  for (let j = index + 1; j < tops.length; j += 1) {
    const rest = top + (j - index) * offset;
    depth += clamp(1 - ((tops[j] ?? 0) - rest) / height, 0, 1);
  }
  return Math.min(Math.max(0, maxDepth), depth);
}

export function mount(el: HTMLElement, opts: Partial<ScrollStackOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    const cards = Array.from(el.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    cards.forEach((card, index) => {
      onDestroy(snapshotAttributes(card, ['style']));
      card.style.setProperty(`--${PREFIX}-i`, String(index));
    });

    let raf = 0;
    let attached = false;
    const update = (): void => {
      raf = 0;
      const rects = cards.map((card) => card.getBoundingClientRect());
      const tops = rects.map((rect) => rect.top);
      const heights = rects.map((rect) => rect.height);
      cards.forEach((card, index) => {
        card.style.setProperty(`--${PREFIX}-d`, stackDepth(tops, heights, index, Math.max(0, options.offset), options.maxDepth).toFixed(3));
      });
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { update(); return; }
      if (!raf) raf = requestAnimationFrame(update);
    };
    const attach = (): void => {
      if (attached) return;
      attached = true;
      // Capture on document sees window scrolls and scrolls of any inner scroll container.
      document.addEventListener('scroll', schedule, { capture: true, passive: true, signal });
      addEventListener('resize', schedule, { passive: true, signal });
      schedule();
    };
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      document.removeEventListener('scroll', schedule, { capture: true });
      removeEventListener('resize', schedule);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };

    let io: IntersectionObserver | null = null;
    const start = (): void => {
      if (cards.length < 2 || io) return;
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver((entries) => {
          for (const entry of entries) (entry.isIntersecting ? attach : detach)();
        }, { rootMargin: '10% 0px' });
        io.observe(el);
      } else {
        attach();
      }
    };
    const stop = (): void => {
      io?.disconnect();
      io = null;
      detach();
      for (const card of cards) card.style.removeProperty(`--${PREFIX}-d`);
    };

    const apply = (reduced: boolean): void => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) stop(); else start();
    };
    const motion = watchReducedMotion(signal, apply);
    apply(motion.reduced);
    onDestroy(stop);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
