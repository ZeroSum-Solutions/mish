/**
 * animated-testimonials — clean-room implementation from the one-line effect description
 * ("3D rotating images, word-by-word text") only; no upstream source was read. A testimonial
 * carousel: every slide's portrait sits in one stacked, tilted 3D pile beside the quote. On each
 * change the new portrait swings up out of the pile to the front (a CSS keyframe keyed off the
 * active class) while the others settle back at their own tilt, and the active quote reveals word
 * by word (CSS animation per word, staggered by `wordStagger`). Autoplay steps every `interval` ms
 * and pauses on hover, focus, a hidden tab or when the host is off-screen (WCAG 2.2.2).
 *
 * DOM contract: `.genui-animated-testimonials__slide` children, each holding a `__media` (the
 * portrait, e.g. an inline SVG) and a `__body` with a `__quote`. The slides use `display:contents`
 * so every portrait shares one grid cell and every body another, which keeps the height stable.
 *
 * Accessibility: the quote's original nodes are moved into a visually-hidden `__sr` span and the
 * word spans are `aria-hidden`, so screen readers read each quote once. Inactive bodies are
 * `visibility:hidden`. Prev/Next are real buttons; ArrowLeft/ArrowRight work while focus is inside;
 * manual steps are announced through a polite live region (autoplay steps are not).
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-animated-testimonials` and `data-genui-mounted`, and returns
 * a handle whose `destroy()` restores `el.outerHTML` exactly (each slide's class and style too).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'animated-testimonials';
const PREFIX = `genui-${id}`;
const SLIDE_CLASS = `${PREFIX}__slide`;
const ACTIVE_CLASS = `${SLIDE_CLASS}--active`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
/** Resting tilt of each portrait in the pile, in deg, cycled by slide index. */
const TILTS = [-7, 5, -3, 8, -5, 3];

export interface AnimatedTestimonialsOptions {
  [key: string]: string | number | boolean;
  /** Step to the next testimonial on a timer. */
  autoplay: boolean;
  /** Time between autoplay steps, in ms. */
  interval: number;
  /** Portrait swing duration, in ms. */
  duration: number;
  /** Delay between each revealed word, in ms. */
  wordStagger: number;
  /** Portrait column width (any CSS length). */
  mediaSize: string;
  /** Pause autoplay while the pointer is over the component (focus always pauses it). */
  pauseOnHover: boolean;
  /** Render Prev/Next buttons. */
  controls: boolean;
}

export const defaults: AnimatedTestimonialsOptions = {
  autoplay: true,
  interval: 5000,
  duration: 600,
  wordStagger: 40,
  mediaSize: '140px',
  pauseOnHover: true,
  controls: true,
};

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: AnimatedTestimonialsOptions): Record<string, string> {
  return {
    duration: `${Math.max(0, options.duration)}ms`,
    stagger: `${Math.max(0, options.wordStagger)}ms`,
    media: options.mediaSize,
  };
}

function button(label: string, glyph: string, onClick: () => void, signal: AbortSignal): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${PREFIX}__btn`;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  b.addEventListener('click', onClick, { signal });
  return b;
}

/** Move `quote`'s nodes into a visually-hidden span and add an aria-hidden word-by-word copy. */
function splitWords(quote: HTMLElement): () => void {
  const original = Array.from(quote.childNodes);
  const sr = document.createElement('span');
  sr.className = `${PREFIX}__sr`;
  sr.append(...original);
  const visual = document.createElement('span');
  visual.setAttribute('aria-hidden', 'true');
  (sr.textContent ?? '').trim().split(/\s+/).forEach((word, i) => {
    const w = document.createElement('span');
    w.className = `${PREFIX}__word`;
    w.style.setProperty(`--${PREFIX}-i`, String(i));
    w.textContent = word;
    visual.append(w, ' ');
  });
  quote.append(sr, visual);
  return () => { quote.replaceChildren(...original); };
}

export function mount(el: HTMLElement, opts: Partial<AnimatedTestimonialsOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const slides = Array.from(el.querySelectorAll<HTMLElement>(`.${SLIDE_CLASS}`));
    const n = slides.length;
    if (n === 0) return;

    const restores = slides.map((slide) => snapshotAttributes(slide, ['class', 'style']));
    onDestroy(() => { for (const restore of restores) restore(); });

    let reduced = watchReducedMotion(signal, (isReduced) => {
      reduced = isReduced;
      el.classList.toggle(REDUCED_CLASS, isReduced);
      schedule();
    }).reduced;
    el.classList.toggle(REDUCED_CLASS, reduced);

    // Word split only when motion is allowed at mount; the original text stays untouched otherwise.
    if (!reduced) {
      for (const quote of el.querySelectorAll<HTMLElement>(`.${PREFIX}__quote`)) onDestroy(splitWords(quote));
    }

    const status = document.createElement('span');
    status.className = `${PREFIX}__sr`;
    status.setAttribute('aria-live', 'polite');

    let active = 0;
    const show = (index: number, announce: boolean): void => {
      active = ((index % n) + n) % n;
      slides.forEach((slide, i) => {
        const d = (i - active + n) % n;
        slide.classList.toggle(ACTIVE_CLASS, d === 0);
        setVars(slide, PREFIX, { d, z: n - d, tilt: `${TILTS[i % TILTS.length]}deg` });
      });
      if (announce) status.textContent = `Testimonial ${active + 1} of ${n}`;
    };

    let hover = false;
    let focus = false;
    let hidden = document.hidden;
    let onScreen = true;
    let timer = 0;
    const schedule = (): void => {
      clearTimeout(timer);
      timer = 0;
      if (options.autoplay && n > 1 && !reduced && !hover && !focus && !hidden && onScreen) {
        timer = window.setTimeout(() => { show(active + 1, false); schedule(); }, Math.max(500, options.interval));
      }
    };
    onDestroy(() => { clearTimeout(timer); });
    const step = (delta: number): void => { show(active + delta, true); schedule(); };

    const passive = { passive: true, signal } as const;
    document.addEventListener('visibilitychange', () => { hidden = document.hidden; schedule(); }, { signal });
    if (options.pauseOnHover) {
      el.addEventListener('pointerenter', () => { hover = true; schedule(); }, passive);
      el.addEventListener('pointerleave', () => { hover = false; schedule(); }, passive);
    }
    el.addEventListener('focusin', () => { focus = true; schedule(); }, passive);
    el.addEventListener('focusout', (event) => {
      if (!el.contains(event.relatedTarget as Node | null)) { focus = false; schedule(); }
    }, passive);
    el.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        step(event.key === 'ArrowRight' ? 1 : -1);
      }
    }, { signal });
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => { onScreen = entry ? entry.isIntersecting : true; schedule(); });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }

    const added: HTMLElement[] = [status];
    if (options.controls && n > 1) {
      const nav = document.createElement('div');
      nav.className = `${PREFIX}__nav`;
      nav.append(
        button('Previous testimonial', '←', () => { step(-1); }, signal),
        button('Next testimonial', '→', () => { step(1); }, signal),
      );
      added.push(nav);
    }
    el.append(...added);
    onDestroy(() => { for (const node of added) node.remove(); });

    show(0, false);
    schedule();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
