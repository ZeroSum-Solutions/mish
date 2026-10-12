/**
 * card-swap — clean-room implementation from component-specs.md §18 only. A 3D stack of cards is
 * fanned back and up (each deeper card offset by `cardDistance`/`verticalDistance` and skewed by
 * `skewAmount`). Every `delay` ms the front card drops out of the stack and returns as the
 * rearmost card, and the others move forward one slot with an elastic (or smooth) ease. Hovering
 * or focusing inside the stack pauses the cycle (WCAG 2.2.2); it resumes on leave. Clicking a
 * card fires a `genui:card-click` CustomEvent with its index. The cards stay in DOM order — only
 * their `--genui-card-swap-slot` custom property changes — so the CSS alone renders any state the
 * JS reaches, and a build with no WAAPI support (or reduced motion) still looks correct.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-card-swap` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly (including each card's `style` attribute,
 * which `mount` also touches).
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, resolveOptions, setVars, snapshotAttributes,
  springEasing, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'card-swap';
const PREFIX = `genui-${id}`;
const CARD_CLASS = `${PREFIX}__card`;
const NEXT_CLASS = `${PREFIX}__next`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
/** translate3d z-step per depth slot, in px (not an option: it only sharpens the 3D read). */
const DEPTH_STEP = 40;
/** How far the front card drops before it re-enters as the rearmost card, in px. */
const DROP_DISTANCE = 140;

export interface CardSwapOptions {
  [key: string]: string | number | boolean;
  /** Horizontal offset per depth slot, in px. */
  cardDistance: number;
  /** Vertical offset per depth slot, in px. */
  verticalDistance: number;
  /** Skew per depth slot, in deg. */
  skewAmount: number;
  /** Time between swaps, in ms. */
  delay: number;
  easing: 'elastic' | 'smooth';
  /** Swap duration, in ms. */
  duration: number;
  /** Pause the cycle while the pointer is over the stack (keyboard focus always pauses it). */
  pauseOnHover: boolean;
  width: string;
  height: string;
}

export const defaults: CardSwapOptions = {
  cardDistance: 60,
  verticalDistance: 70,
  skewAmount: 6,
  delay: 5000,
  easing: 'elastic',
  duration: 1200,
  pauseOnHover: true,
  width: '420px',
  height: '300px',
};

/** The custom properties `mount` writes on the host for a set of options, plus the card count. */
export function toVars(options: CardSwapOptions, total: number): Record<string, string> {
  return {
    width: options.width,
    height: options.height,
    'card-distance': `${Math.max(0, options.cardDistance)}px`,
    'vertical-distance': `${Math.max(0, options.verticalDistance)}px`,
    skew: `${options.skewAmount}deg`,
    duration: `${Math.max(0, options.duration)}ms`,
    total: String(total),
  };
}

/** The static resting transform for a card at `slot` (0 = front); mirrors styles.css exactly. */
function cardTransform(slot: number, options: CardSwapOptions): string {
  const x = slot * Math.max(0, options.cardDistance);
  const y = -slot * Math.max(0, options.verticalDistance);
  const z = -slot * DEPTH_STEP;
  return `translate3d(${x}px, ${y}px, ${z}px) skewY(${slot * options.skewAmount}deg)`;
}

function dropTransform(): string {
  return `translate3d(0px, ${DROP_DISTANCE}px, -20px) skewY(0deg)`;
}

function swapEasing(options: CardSwapOptions): string {
  return options.easing === 'elastic' ? springEasing(320, 16, 1) : 'cubic-bezier(.22,.61,.36,1)';
}

export function mount(el: HTMLElement, opts: Partial<CardSwapOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    const cards = Array.from(el.querySelectorAll<HTMLElement>(`.${CARD_CLASS}`));
    setVars(el, PREFIX, toVars(options, cards.length));
    if (cards.length === 0) return; // nothing to fan or swap

    const easing = swapEasing(options);
    const animations = createAnimationSet();
    onDestroy(() => animations.cancelAll());

    // Each card's own `style` is ours to restore: `mount` writes --genui-card-swap-slot on it.
    const restoreCards = cards.map((card) => snapshotAttributes(card, ['style']));
    onDestroy(() => { for (const restore of restoreCards) restore(); });

    let slotOf = cards.map((_card, i) => i);
    cards.forEach((card, i) => { card.style.setProperty(`--${PREFIX}-slot`, String(slotOf[i])); });

    const rotate = (): void => {
      const n = cards.length;
      const nextSlots = slotOf.map((s) => (s - 1 + n) % n);
      cards.forEach((card, i) => {
        const from = slotOf[i]!;
        const to = nextSlots[i]!;
        if (!reduced && typeof card.animate === 'function') {
          const toTransform = cardTransform(to, options);
          const keyframes: Keyframe[] = from === 0
            ? [
                { transform: cardTransform(from, options), offset: 0 },
                { transform: dropTransform(), opacity: 0.85, offset: 0.35, easing: 'cubic-bezier(.4,0,1,1)' },
                { transform: toTransform, opacity: 1, offset: 1, easing },
              ]
            : [
                { transform: cardTransform(from, options), offset: 0 },
                { transform: toTransform, offset: 1, easing },
              ];
          const anim = animations.play(card, keyframes, { duration: Math.max(0, options.duration) });
          anim?.finished.then(() => anim.cancel(), () => {});
        }
        card.style.setProperty(`--${PREFIX}-slot`, String(to));
      });
      slotOf = nextSlots;
    };

    // Auto-cycle: a setTimeout chain, off while reduced motion applies, the document is hidden,
    // the stack is off-screen, or the pointer/keyboard focus is inside it.
    let reduced = false;
    let hoverPaused = false;
    let focusPaused = false;
    let docHidden = typeof document !== 'undefined' && document.hidden;
    let onScreen = true;
    let timer = 0;
    const canRun = (): boolean => !reduced && !hoverPaused && !focusPaused && !docHidden && onScreen && cards.length > 1;
    const scheduleNext = (): void => {
      if (timer) { clearTimeout(timer); timer = 0; }
      if (!canRun()) return;
      timer = window.setTimeout(() => { rotate(); scheduleNext(); }, Math.max(0, options.delay));
    };
    onDestroy(() => { if (timer) clearTimeout(timer); timer = 0; });

    const motion = watchReducedMotion(signal, (isReduced) => {
      reduced = isReduced;
      el.classList.toggle(REDUCED_CLASS, isReduced);
      if (isReduced) animations.cancelAll();
      scheduleNext();
    });
    reduced = motion.reduced;
    el.classList.toggle(REDUCED_CLASS, reduced);

    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { docHidden = document.hidden; scheduleNext(); }, { signal });
    }
    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => { onScreen = entry ? entry.isIntersecting : true; scheduleNext(); }, { threshold: 0 });
      io.observe(el);
      onDestroy(() => io.disconnect());
    }

    const listenerOpts = { passive: true, signal } as const;
    if (options.pauseOnHover) {
      el.addEventListener('pointerenter', () => { hoverPaused = true; scheduleNext(); }, listenerOpts);
      el.addEventListener('pointerleave', () => { hoverPaused = false; scheduleNext(); }, listenerOpts);
    }
    el.addEventListener('focusin', () => { focusPaused = true; scheduleNext(); }, listenerOpts);
    el.addEventListener('focusout', () => { focusPaused = false; scheduleNext(); }, listenerOpts);

    cards.forEach((card, i) => {
      card.addEventListener('click', () => {
        card.dispatchEvent(new CustomEvent('genui:card-click', { bubbles: true, detail: { index: i } }));
      }, listenerOpts);
    });

    const next = document.createElement('button');
    next.type = 'button';
    next.className = NEXT_CLASS;
    next.textContent = 'Next card';
    next.addEventListener('click', () => { rotate(); scheduleNext(); }, listenerOpts);
    el.append(next);
    onDestroy(() => next.remove());

    scheduleNext();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
