/**
 * spotlight-card — clean-room implementation from component-specs.md §15 only. A soft radial
 * light follows the cursor across the host. At idle there is no light; on pointer enter or
 * keyboard focus it fades in over `fade` ms, and on leave it fades out and stays at the last
 * position. There is no damping: the position is written directly, at most once per rAF frame.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-spotlight-card` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'spotlight-card';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const NO_BORDER_CLASS = `${PREFIX}--no-border`;

export interface SpotlightCardOptions {
  [key: string]: string | number | boolean;
  colour: string;
  /** Spotlight radius, in px. */
  radius: number;
  /** Also brighten the border ring under the pointer. */
  borderGlow: boolean;
  borderColour: string;
  /** Fade in/out duration, in ms. */
  fade: number;
  /** Track touch pointers too (off by default; touch has no hover). */
  touch: boolean;
}

export const defaults: SpotlightCardOptions = {
  colour: 'rgba(255,255,255,0.12)',
  radius: 320,
  borderGlow: true,
  borderColour: 'rgba(255,255,255,0.35)',
  fade: 200,
  touch: false,
};

/** The custom properties `mount` writes for a set of options (excluding the live -x/-y/-on). */
export function toVars(options: SpotlightCardOptions): Record<string, string> {
  return {
    colour: options.colour,
    radius: `${Math.max(0, options.radius)}px`,
    'border-colour': options.borderColour,
    fade: `${Math.max(0, options.fade)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<SpotlightCardOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(NO_BORDER_CLASS, !options.borderGlow);

    let reduced = false;
    const motion = watchReducedMotion(signal, (isReduced) => {
      reduced = isReduced;
      el.classList.toggle(REDUCED_CLASS, isReduced);
    });
    reduced = motion.reduced;
    el.classList.toggle(REDUCED_CLASS, reduced);

    // No damping: the last computed position is written directly, at most once per animation
    // frame. Percent values keep -x/-y independent of the host's pixel size.
    let px = 50;
    let py = 50;
    let raf = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';
    el.style.setProperty(`--${PREFIX}-x`, `${px}%`);
    el.style.setProperty(`--${PREFIX}-y`, `${py}%`);
    el.style.setProperty(`--${PREFIX}-on`, '0');

    const write = (): void => {
      raf = 0;
      el.style.setProperty(`--${PREFIX}-x`, `${px}%`);
      el.style.setProperty(`--${PREFIX}-y`, `${py}%`);
    };
    const schedule = (): void => {
      if (!hasRaf) { write(); return; }
      if (!raf) raf = requestAnimationFrame(write);
    };
    const setOn = (on: boolean): void => { el.style.setProperty(`--${PREFIX}-on`, on ? '1' : '0'); };

    const listenerOpts = { passive: true, signal } as const;
    const allowsPointer = (event: PointerEvent): boolean => event.pointerType !== 'touch' || options.touch;
    const onMove = (event: PointerEvent): void => {
      if (reduced || !allowsPointer(event)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      px = ((event.clientX - rect.left) / rect.width) * 100;
      py = ((event.clientY - rect.top) / rect.height) * 100;
      schedule();
    };
    el.addEventListener('pointermove', onMove, listenerOpts);
    el.addEventListener('pointerenter', (event) => {
      if (!allowsPointer(event)) return;
      setOn(true);
      onMove(event);
    }, listenerOpts);
    el.addEventListener('pointerleave', (event) => { if (allowsPointer(event)) setOn(false); }, listenerOpts);
    // Keyboard parity: focus centres the light (px/py already default to 50/50).
    el.addEventListener('focusin', () => { setOn(true); }, listenerOpts);
    el.addEventListener('focusout', () => { setOn(false); }, listenerOpts);

    onDestroy(() => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
