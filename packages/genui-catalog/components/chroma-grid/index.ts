/**
 * chroma-grid — clean-room implementation from component-specs.md §10 only.
 *
 * A grid of cards sits in grayscale. A circular spotlight of `radius` px follows the pointer
 * across the grid with damped lag; colour shows through inside the circle while the rest of the
 * grid stays desaturated. Keyboard focus moves the same spotlight to the focused card's centre,
 * so keyboard users get colour too. A hovered or focused card also gets a thin border in its own
 * `--card-accent` colour. Leaving the grid (or losing focus) fades the spotlight back out.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-chroma-grid` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'chroma-grid';
const PREFIX = `genui-${id}`;
const ITEM_CLASS = `${PREFIX}__item`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface ChromaGridOptions {
  [key: string]: string | number | boolean | null;
  /** Spotlight radius, in px. */
  radius: number;
  /** 0–0.98: how much lag the spotlight keeps per frame while tracking the pointer. */
  damping: number;
  columns: number;
  /** Row count; null lets the grid size rows automatically. */
  rows: number | null;
  gap: string;
  /** 0–1: how desaturated the grid is outside the spotlight. */
  grayscale: number;
  /** Spotlight fade-out (and fade-in) duration on pointer/focus leave, in ms. */
  fadeOut: number;
}

export const defaults: ChromaGridOptions = {
  radius: 280,
  damping: 0.85,
  columns: 3,
  rows: null,
  gap: '16px',
  grayscale: 1,
  fadeOut: 500,
};

/** The static custom properties `mount` writes; `-x`, `-y` and `-active` are pointer/focus-driven. */
export function toVars(options: ChromaGridOptions): Record<string, string> {
  return {
    cols: String(Math.max(1, Math.round(options.columns))),
    rows: options.rows === null ? 'auto' : `repeat(${Math.max(1, Math.round(options.rows))}, 1fr)`,
    gap: options.gap,
    grayscale: String(Math.min(1, Math.max(0, options.grayscale))),
    radius: `${Math.max(0, options.radius)}px`,
    fadeout: `${Math.max(0, options.fadeOut)}ms`,
  };
}

/**
 * Track the pointer and keyboard focus over `host` and write `--genui-chroma-grid-x`/`-y`
 * (percent, damped) and `--genui-chroma-grid-active` (0/1, instant — the CSS `fadeOut`
 * transition owns the smoothing). Returns a stop function, also run when `signal` aborts.
 */
function trackSpotlight(host: HTMLElement, damping: number, signal: AbortSignal): () => void {
  const ratio = Math.min(0.98, Math.max(0, damping));
  let x = 50; let y = 50; let tx = 50; let ty = 50; let raf = 0;
  const hasRaf = typeof requestAnimationFrame === 'function';

  const writePosition = (): void => {
    host.style.setProperty(`--${PREFIX}-x`, `${x.toFixed(2)}%`);
    host.style.setProperty(`--${PREFIX}-y`, `${y.toFixed(2)}%`);
  };
  const tick = (): void => {
    raf = 0;
    x += (tx - x) * (1 - ratio);
    y += (ty - y) * (1 - ratio);
    if (Math.abs(tx - x) + Math.abs(ty - y) <= 0.05) { x = tx; y = ty; writePosition(); return; }
    writePosition();
    schedule();
  };
  const schedule = (): void => {
    if (!hasRaf) { x = tx; y = ty; writePosition(); return; }
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const setActive = (on: boolean): void => { host.style.setProperty(`--${PREFIX}-active`, on ? '1' : '0'); };
  const pointFromEvent = (event: PointerEvent): void => {
    const rect = host.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    tx = ((event.clientX - rect.left) / rect.width) * 100;
    ty = ((event.clientY - rect.top) / rect.height) * 100;
  };
  const pointFromItem = (item: Element): void => {
    const hostRect = host.getBoundingClientRect();
    const itemRect = item.getBoundingClientRect();
    if (hostRect.width === 0 || hostRect.height === 0) return;
    tx = ((itemRect.left + itemRect.width / 2 - hostRect.left) / hostRect.width) * 100;
    ty = ((itemRect.top + itemRect.height / 2 - hostRect.top) / hostRect.height) * 100;
  };

  const opts = { passive: true, signal } as const;
  host.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'touch') return;
    pointFromEvent(event);
    setActive(true);
    schedule();
  }, opts);
  host.addEventListener('pointerleave', () => { setActive(false); }, opts);
  host.addEventListener('focusin', (event) => {
    const target = event.target;
    const item = target instanceof Element ? target.closest(`.${ITEM_CLASS}`) : null;
    if (item) pointFromItem(item);
    setActive(true);
    schedule();
  }, opts);
  host.addEventListener('focusout', () => { setActive(false); }, opts);

  const stop = (): void => {
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = 0;
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

export function mount(el: HTMLElement, opts: Partial<ChromaGridOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    // component-specs.md §10 picks the simple reduced-motion alternative: drop the pointer
    // spotlight entirely. The grid shows in colour and only the CSS hover/focus border remains,
    // so no overlay nodes or pointer/focus listeners are created.
    if (motion.reduced) return;

    const desat = document.createElement('div');
    desat.className = `${PREFIX}__desat`;
    desat.setAttribute('aria-hidden', 'true');
    const fade = document.createElement('div');
    fade.className = `${PREFIX}__fade`;
    fade.setAttribute('aria-hidden', 'true');
    el.append(desat, fade);
    onDestroy(() => { desat.remove(); fade.remove(); });

    trackSpotlight(el, options.damping, signal);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
