/**
 * masonry — clean-room implementation from component-specs.md §13 only.
 *
 * A staggered editorial grid built with CSS multi-column layout (`columns: <count> <min-width>`),
 * so it lays out correctly with no script running (kind: css-only). `mount` maps options to
 * `--genui-masonry-*` custom properties and creates no nodes for the grid itself.
 *
 * As a progressive enhancement, when `reveal` is set and motion is allowed, `mount` also runs one
 * IntersectionObserver over the existing `.genui-masonry__item` children and reveals each with a
 * one-time WAAPI fade-and-rise, staggered by the order items enter the viewport (not DOM index).
 * Without IntersectionObserver or `Element.animate` (old browsers, jsdom), no item is ever hidden,
 * so nothing is lost — the pending class (and the hidden start state it sets in CSS) is only added
 * once JS confirms it can also finish the job.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-masonry` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, resolveOptions, setVars, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'masonry';
const PREFIX = `genui-${id}`;
const PENDING_CLASS = `${PREFIX}--pending`;
const NO_LIFT_CLASS = `${PREFIX}--no-lift`;
const ITEM_SELECTOR = `.${PREFIX}__item`;

export interface MasonryOptions {
  [key: string]: string | number | boolean;
  /** Column count at the widest breakpoint. */
  columns: number;
  /** Minimum column width; the browser narrows the column count to fit it. */
  minColumn: string;
  gap: string;
  /** Fade-and-rise each item once as it scrolls into view. */
  reveal: boolean;
  /** Delay between each revealed item, in ms — by intersection order, not DOM index. */
  stagger: number;
  duration: number;
  /** Lift the hovered or focused item slightly. */
  hoverLift: boolean;
}

export const defaults: MasonryOptions = {
  columns: 3,
  minColumn: '240px',
  gap: '16px',
  reveal: true,
  stagger: 60,
  duration: 500,
  hoverLift: true,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: MasonryOptions): Record<string, string> {
  return {
    cols: String(Math.max(1, Math.round(options.columns))),
    min: options.minColumn,
    gap: options.gap,
    stagger: `${Math.max(0, options.stagger)}ms`,
    duration: `${Math.max(0, options.duration)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<MasonryOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(NO_LIFT_CLASS, !options.hoverLift);

    // One-shot gate: this component reveals once, so it only needs the preference at mount time,
    // not a live `change` listener (there is nothing left to redo once every item has revealed).
    const motion = watchReducedMotion(signal);
    const items = Array.from(el.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    if (!options.reveal || motion.reduced || items.length === 0 || typeof IntersectionObserver !== 'function') return;

    el.classList.add(PENDING_CLASS);
    const animations = createAnimationSet();
    let order = 0;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const target = entry.target as HTMLElement;
        io.unobserve(target);
        animations.play(
          target,
          [
            { opacity: 0, transform: 'translateY(12px)' },
            { opacity: 1, transform: 'translateY(0)' },
          ],
          { duration: options.duration, delay: order * options.stagger, easing: 'ease-out' },
        );
        order += 1;
      }
    }, { threshold: 0.1 });
    for (const item of items) io.observe(item);

    onDestroy(() => {
      io.disconnect();
      animations.cancelAll();
      el.classList.remove(PENDING_CLASS);
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
