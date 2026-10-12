/**
 * 3d-testimonails — clean-room implementation from the one-line effect description only
 * ("infinite-loop scroller for text, images or video", a testimonial marquee with 3D tilt).
 * No upstream source was read. Each `.genui-3d-testimonails__row` child of the host becomes an
 * endless marquee: `mount` appends one `aria-hidden`, `inert` copy of the row's items so a CSS
 * keyframe can slide the row by exactly half its length and loop without a seam. The host itself
 * is the tilted plane (`perspective() rotateX/Y/Z` from custom properties). Every other row runs
 * the opposite way when `alternate` is set.
 *
 * Motion is CSS only (no rAF): an IntersectionObserver pauses the rows while the host is off
 * screen, and hover or keyboard focus pauses them when `pauseOnHover` is set. Under reduced
 * motion no copies are made and the rows sit still (scrollable), following live changes.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-3d-testimonails` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` removes every copy and restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = '3d-testimonails';
const PREFIX = `genui-${id}`;
const ROW_SELECTOR = `.${PREFIX}__row`;
const CLONE_CLASS = `${PREFIX}__clone`;
const RUNNING_CLASS = `${PREFIX}--running`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const PAUSED_CLASS = `${PREFIX}--paused`;
const VERTICAL_CLASS = `${PREFIX}--vertical`;
const HOVER_CLASS = `${PREFIX}--pause-hover`;
const FADE_CLASS = `${PREFIX}--fade`;
const REVERSE_CLASS = `${PREFIX}__row--reverse`;

export interface ThreeDTestimonialsOptions {
  [key: string]: string | number | boolean;
  /** Seconds for one full loop of a row. */
  duration: number;
  gap: string;
  direction: 'horizontal' | 'vertical';
  /** Run the first row backwards (right-to-left becomes left-to-right). */
  reverse: boolean;
  /** Every second row runs the opposite way. */
  alternate: boolean;
  /** Pause while the pointer or keyboard focus is inside. */
  pauseOnHover: boolean;
  tiltX: number;
  tiltY: number;
  tiltZ: number;
  /** Perspective distance, in px. */
  perspective: number;
  /** Fade the leading and trailing edges. */
  fade: boolean;
}

export const defaults: ThreeDTestimonialsOptions = {
  duration: 28,
  gap: '14px',
  direction: 'horizontal',
  reverse: false,
  alternate: true,
  pauseOnHover: true,
  tiltX: 18,
  tiltY: -10,
  tiltZ: 4,
  perspective: 900,
  fade: true,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: ThreeDTestimonialsOptions): Record<string, string> {
  return {
    duration: `${Math.max(1, options.duration)}s`,
    gap: options.gap,
    'tilt-x': `${options.tiltX}deg`,
    'tilt-y': `${options.tiltY}deg`,
    'tilt-z': `${options.tiltZ}deg`,
    perspective: `${Math.max(100, options.perspective)}px`,
  };
}

export function mount(el: HTMLElement, opts: Partial<ThreeDTestimonialsOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(VERTICAL_CLASS, options.direction === 'vertical');
    el.classList.toggle(HOVER_CLASS, options.pauseOnHover);
    el.classList.toggle(FADE_CLASS, options.fade);

    const rows = Array.from(el.querySelectorAll<HTMLElement>(ROW_SELECTOR));
    const rowClass = rows.map((row) => row.getAttribute('class'));
    rows.forEach((row, index) => {
      row.classList.toggle(REVERSE_CLASS, options.reverse !== (options.alternate && index % 2 === 1));
    });
    onDestroy(() => {
      rows.forEach((row, index) => {
        const saved = rowClass[index];
        if (saved === null || saved === undefined) row.removeAttribute('class');
        else row.setAttribute('class', saved);
      });
    });

    let clones: Element[] = [];
    const stop = (): void => {
      for (const clone of clones) clone.remove();
      clones = [];
      el.classList.remove(RUNNING_CLASS);
    };
    const start = (): void => {
      if (clones.length || rows.length === 0) return;
      for (const row of rows) {
        for (const item of Array.from(row.children)) {
          const copy = item.cloneNode(true) as Element;
          copy.setAttribute('aria-hidden', 'true');
          copy.setAttribute('inert', '');
          copy.classList.add(CLONE_CLASS);
          copy.removeAttribute('id');
          for (const node of Array.from(copy.querySelectorAll('[id]'))) node.removeAttribute('id');
          clones.push(copy);
          row.append(copy);
        }
      }
      el.classList.add(RUNNING_CLASS);
    };
    const apply = (reduced: boolean): void => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) stop();
      else start();
    };
    onDestroy(stop);

    const motion = watchReducedMotion(signal, apply);
    apply(motion.reduced);

    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => {
        el.classList.toggle(PAUSED_CLASS, !entry?.isIntersecting);
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
