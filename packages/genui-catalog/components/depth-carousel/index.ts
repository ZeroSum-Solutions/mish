/**
 * depth-carousel — clean-room implementation from the effect description ("Carousel with depth")
 * only. The `.genui-depth-carousel__item` children sit on one stage: the active item faces the
 * viewer, and each neighbour steps out sideways by `spacing`, back by `depth` and turns by
 * `rotate`, fading after `visible` steps. The JS only writes each item's signed distance from
 * the active one (`--genui-depth-carousel-o`, and its absolute value `-a`) and CSS draws and
 * transitions every state, so reduced motion is a CSS `transition: none` and nothing else.
 *
 * Controls: Previous/Next buttons, ArrowLeft/ArrowRight/Home/End on the host, clicking a side
 * item, focusing an item (Tab brings it to the front), and a horizontal pointer swipe. An
 * optional `autoplay` interval pauses on hover, focus, a hidden tab or while off-screen, and is
 * off under reduced motion. A polite live region announces "Slide n of N".
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-depth-carousel` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (items' class/style/aria-current too).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'depth-carousel';
const PREFIX = `genui-${id}`;
const ITEM = `${PREFIX}__item`;
const ACTIVE = `${ITEM}--active`;
const FAR = `${ITEM}--far`;
const REDUCED = `${PREFIX}--reduced`;
const SWIPE = 40;

export interface DepthCarouselOptions {
  [key: string]: string | number | boolean;
  /** Horizontal step between neighbouring items, in px. */
  spacing: number;
  /** How far back each step sits, in px. */
  depth: number;
  /** Turn of the items beside the active one, in deg. */
  rotate: number;
  /** Steps shown on each side of the active item; further items fade out. */
  visible: number;
  /** Index of the item shown first. */
  start: number;
  /** Wrap from the last item to the first. */
  loop: boolean;
  /** Advance every n ms; 0 turns autoplay off. */
  autoplay: number;
  /** Transition duration, in ms. */
  duration: number;
  /** Add Previous/Next buttons. */
  controls: boolean;
}

export const defaults: DepthCarouselOptions = {
  spacing: 120,
  depth: 160,
  rotate: 35,
  visible: 2,
  start: 0,
  loop: true,
  autoplay: 0,
  duration: 600,
  controls: true,
};

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: DepthCarouselOptions): Record<string, string> {
  return {
    spacing: `${options.spacing}px`,
    depth: `${Math.max(0, options.depth)}px`,
    rotate: `${options.rotate}deg`,
    visible: String(Math.max(0, options.visible)),
    duration: `${Math.max(0, options.duration)}ms`,
  };
}

/** Signed distance of item `i` from `active` among `n` items (shortest way round when looping). */
export function offsetOf(i: number, active: number, n: number, loop: boolean): number {
  let o = i - active;
  if (loop && n > 2) {
    if (o > n / 2) o -= n;
    else if (o < -n / 2) o += n;
  }
  return o;
}

function button(label: string, glyph: string, mod: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `${PREFIX}__btn ${PREFIX}__btn--${mod}`;
  b.setAttribute('aria-label', label);
  b.textContent = glyph;
  return b;
}

export function mount(el: HTMLElement, opts: Partial<DepthCarouselOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const items = Array.from(el.querySelectorAll<HTMLElement>(`.${ITEM}`));
    const n = items.length;
    let hover = false; let focus = false; let onScreen = true; let timer = 0;

    const motion = watchReducedMotion(signal, (r) => { el.classList.toggle(REDUCED, r); schedule(); });
    el.classList.toggle(REDUCED, motion.reduced);
    if (!n) return;

    const restores = items.map((item) => snapshotAttributes(item, ['class', 'style', 'aria-current']));
    onDestroy(() => { for (const r of restores) r(); });

    const status = document.createElement('span');
    status.className = `${PREFIX}__status`;
    status.setAttribute('aria-live', 'polite');
    el.append(status);
    onDestroy(() => status.remove());

    const clamp = (i: number): number => (options.loop ? ((i % n) + n) % n : Math.min(n - 1, Math.max(0, i)));
    let active = clamp(Math.round(options.start));
    let prev: HTMLButtonElement | null = null;
    let next: HTMLButtonElement | null = null;

    const render = (announce: boolean): void => {
      items.forEach((item, i) => {
        const o = offsetOf(i, active, n, options.loop);
        const a = Math.abs(o);
        item.style.setProperty(`--${PREFIX}-o`, String(o));
        item.style.setProperty(`--${PREFIX}-a`, String(a));
        item.classList.toggle(ACTIVE, o === 0);
        item.classList.toggle(FAR, a > options.visible);
        if (o === 0) item.setAttribute('aria-current', 'true');
        else item.removeAttribute('aria-current');
      });
      if (prev && next && !options.loop) {
        prev.disabled = active === 0;
        next.disabled = active === n - 1;
      }
      if (announce) status.textContent = `Slide ${active + 1} of ${n}`;
    };
    const go = (i: number): void => {
      const target = clamp(i);
      if (target !== active) { active = target; render(true); }
    };

    const listen = { signal } as const;
    if (options.controls && n > 1) {
      prev = button('Previous slide', '‹', 'prev');
      next = button('Next slide', '›', 'next');
      prev.addEventListener('click', () => { go(active - 1); schedule(); }, listen);
      next.addEventListener('click', () => { go(active + 1); schedule(); }, listen);
      el.append(prev, next);
      const p = prev; const q = next;
      onDestroy(() => { p.remove(); q.remove(); });
    }

    el.addEventListener('keydown', (e) => {
      const k = e.key;
      const to = k === 'ArrowLeft' ? active - 1 : k === 'ArrowRight' ? active + 1
        : k === 'Home' ? 0 : k === 'End' ? n - 1 : null;
      if (to === null) return;
      e.preventDefault();
      go(to);
      if (items.some((item) => item === document.activeElement)) items[active]?.focus({ preventScroll: true });
    }, listen);

    let startX: number | null = null;
    let swiped = false;
    el.addEventListener('pointerdown', (e) => { startX = e.clientX; swiped = false; }, { passive: true, signal });
    el.addEventListener('pointerup', (e) => {
      if (startX === null) return;
      const dx = e.clientX - startX;
      startX = null;
      if (Math.abs(dx) > SWIPE) { swiped = true; go(active + (dx < 0 ? 1 : -1)); schedule(); }
    }, { passive: true, signal });

    items.forEach((item, i) => {
      item.addEventListener('click', (e) => {
        if (swiped) { swiped = false; return; }
        if (i !== active) { e.preventDefault(); go(i); schedule(); }
      }, listen);
      item.addEventListener('focus', () => { go(i); }, listen);
    });

    // Autoplay: a timer chain, off while reduced, hovered, focused, hidden or off-screen.
    const canRun = (): boolean => options.autoplay > 0 && n > 1 && !motion.reduced && !hover && !focus && onScreen && !document.hidden;
    function schedule(): void {
      clearTimeout(timer);
      timer = canRun() ? window.setTimeout(() => { go(active + 1); schedule(); }, options.autoplay) : 0;
    }
    onDestroy(() => clearTimeout(timer));

    if (options.autoplay > 0) {
      el.addEventListener('pointerenter', () => { hover = true; schedule(); }, listen);
      el.addEventListener('pointerleave', () => { hover = false; schedule(); }, listen);
      el.addEventListener('focusin', () => { focus = true; schedule(); }, listen);
      el.addEventListener('focusout', () => { focus = false; schedule(); }, listen);
      document.addEventListener('visibilitychange', schedule, listen);
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver(([entry]) => { onScreen = entry ? entry.isIntersecting : true; schedule(); });
        io.observe(el);
        onDestroy(() => io.disconnect());
      }
    }

    render(false);
    schedule();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
