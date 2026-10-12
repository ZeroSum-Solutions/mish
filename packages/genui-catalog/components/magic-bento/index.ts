/**
 * magic-bento — clean-room implementation from the effect description ("Bento grid layout with
 * spotlight/glow cards") only. The host is a CSS grid of `.genui-magic-bento__card` children
 * (span modifiers `--wide`, `--tall`, `--large`), so the layout works with no script. `mount`
 * adds the light: one pointer listener on the grid writes, per card, the pointer position in
 * card-local px and a 0..1 proximity `glow`, so a card's rim and wash light up as the pointer
 * nears it, not only when it is over it. A soft spotlight also follows the pointer across the
 * grid gaps. Writes are batched to at most one rAF per pointer event; nothing loops at idle, so
 * there is no loop to pause off-screen. Keyboard focus lights the focused card from its centre.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-magic-bento` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (card style attributes included).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'magic-bento';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const NO_BORDER_CLASS = `${PREFIX}--no-border`;
const NO_SPOTLIGHT_CLASS = `${PREFIX}--no-spotlight`;
const CARD_SELECTOR = `.${PREFIX}__card`;

export interface MagicBentoOptions {
  [key: string]: string | number | boolean;
  /** Grid column count. */
  columns: number;
  gap: string;
  /** Minimum row height. */
  rowHeight: string;
  glowColour: string;
  /** Radius of each card's light, in px. */
  radius: number;
  /** Distance outside a card, in px, at which its glow starts. */
  proximity: number;
  /** Light up the card rims. */
  borderGlow: boolean;
  /** A soft light that follows the pointer across the whole grid. */
  spotlight: boolean;
  /** Track touch pointers too. */
  touch: boolean;
}

export const defaults: MagicBentoOptions = {
  columns: 4,
  gap: '12px',
  rowHeight: '96px',
  glowColour: '#8b7cf6',
  radius: 220,
  proximity: 120,
  borderGlow: true,
  spotlight: true,
  touch: false,
};

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: MagicBentoOptions): Record<string, string> {
  return {
    cols: String(Math.max(1, Math.round(options.columns))),
    gap: options.gap,
    row: options.rowHeight,
    colour: options.glowColour,
    radius: `${Math.max(0, options.radius)}px`,
  };
}

export function mount(el: HTMLElement, opts: Partial<MagicBentoOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(NO_BORDER_CLASS, !options.borderGlow);
    el.classList.toggle(NO_SPOTLIGHT_CLASS, !options.spotlight);

    const cards = Array.from(el.querySelectorAll<HTMLElement>(CARD_SELECTOR));
    for (const card of cards) onDestroy(snapshotAttributes(card, ['style']));

    const proximity = Math.max(1, options.proximity);
    const hasRaf = typeof requestAnimationFrame === 'function';
    let raf = 0;
    let px = 0;
    let py = 0;
    let active = false;

    const setCard = (card: HTMLElement, x: number, y: number, glow: number): void => {
      setVars(card, PREFIX, { x: `${x}px`, y: `${y}px`, glow: glow.toFixed(3) });
    };
    const clear = (): void => {
      el.style.setProperty(`--${PREFIX}-on`, '0');
      for (const card of cards) card.style.setProperty(`--${PREFIX}-glow`, '0');
    };
    const write = (): void => {
      raf = 0;
      if (!active) { clear(); return; }
      const box = el.getBoundingClientRect();
      setVars(el, PREFIX, { hx: `${px - box.left}px`, hy: `${py - box.top}px`, on: '1' });
      for (const card of cards) {
        const r = card.getBoundingClientRect();
        const dx = Math.max(r.left - px, 0, px - r.right);
        const dy = Math.max(r.top - py, 0, py - r.bottom);
        const glow = Math.max(0, 1 - Math.hypot(dx, dy) / proximity);
        setCard(card, px - r.left, py - r.top, glow);
      }
    };
    const schedule = (): void => {
      if (!hasRaf) { write(); return; }
      if (!raf) raf = requestAnimationFrame(write);
    };

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) { active = false; schedule(); }
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    clear();

    const listenerOpts = { passive: true, signal } as const;
    const onMove = (event: PointerEvent): void => {
      if (motion.reduced || (event.pointerType === 'touch' && !options.touch)) return;
      px = event.clientX;
      py = event.clientY;
      active = true;
      schedule();
    };
    el.addEventListener('pointermove', onMove, listenerOpts);
    el.addEventListener('pointerenter', onMove, listenerOpts);
    el.addEventListener('pointerleave', () => { active = false; schedule(); }, listenerOpts);
    // Keyboard parity: a focused card lights from its centre, with no pointer needed.
    el.addEventListener('focusin', (event) => {
      if (motion.reduced) return;
      const card = (event.target as Element).closest?.(CARD_SELECTOR) as HTMLElement | null;
      if (!card || !cards.includes(card)) return;
      const r = card.getBoundingClientRect();
      setCard(card, r.width / 2, r.height / 2, 1);
    }, listenerOpts);
    el.addEventListener('focusout', () => { if (!active) clear(); }, listenerOpts);

    onDestroy(() => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
