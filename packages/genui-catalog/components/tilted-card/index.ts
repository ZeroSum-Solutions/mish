/**
 * tilted-card — clean-room implementation from component-specs.md §16 only. The card tilts in 3D
 * toward the pointer, up to `maxTilt` degrees on each axis, and scales up slightly while
 * hovered or focused. The rotation follows the pointer with spring-like damping (note 3). An
 * optional glare layer brightens the edge closest to the viewer, and an optional caption tooltip
 * trails the cursor. On leave, the card eases back to flat over `resetDuration`. At idle it is
 * flat with no motion.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), wraps the host's children in `.genui-tilted-card__inner`, and returns a
 * handle whose `destroy()` unwraps them and restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'tilted-card';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const ACTIVE_CLASS = `${PREFIX}--active`;
const INNER_CLASS = `${PREFIX}__inner`;
const GLARE_CLASS = `${PREFIX}__glare`;
const CAPTION_CLASS = `${PREFIX}__caption`;
const DESC_CLASS = `${PREFIX}__desc`;
/** Settle threshold for the combined rx/ry/s/gx/gy spring distance (deg+deg+scale+pct+pct). */
const SETTLE_EPSILON = 0.05;

export interface TiltedCardOptions {
  [key: string]: string | number | boolean | null;
  /** Maximum tilt on each axis, in degrees. */
  maxTilt: number;
  /** Scale applied while hovered or focused. */
  scale: number;
  perspective: number;
  /** 0 = follow instantly, close to 1 = heavy lag. */
  damping: number;
  glare: boolean;
  glareOpacity: number;
  /** Tooltip text that trails the cursor; no tooltip when null. */
  caption: string | null;
  /** Ease-back-to-flat duration on leave, in ms. */
  resetDuration: number;
}

export const defaults: TiltedCardOptions = {
  maxTilt: 12,
  scale: 1.04,
  perspective: 800,
  damping: 0.82,
  glare: true,
  glareOpacity: 0.25,
  caption: null,
  resetDuration: 500,
};

let descCounter = 0;

/** The static custom properties `mount` writes once for a set of options. */
export function toVars(options: TiltedCardOptions): Record<string, string> {
  return {
    'glare-opacity': String(Math.min(1, Math.max(0, options.glareOpacity))),
    reset: `${Math.max(0, options.resetDuration)}ms`,
  };
}

export function mount(el: HTMLElement, opts: Partial<TiltedCardOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    el.style.setProperty('perspective', `${Math.max(0, options.perspective)}px`);
    setVars(el, PREFIX, toVars(options));

    // DOM contract: wrap the original children in .genui-tilted-card__inner, which carries the
    // rotateX/rotateY/scale transform. destroy() unwraps back to the exact original children.
    const originalChildren = Array.from(el.childNodes);
    const inner = document.createElement('div');
    inner.className = INNER_CLASS;
    for (const child of originalChildren) inner.appendChild(child);
    el.appendChild(inner);
    onDestroy(() => {
      inner.remove();
      for (const child of originalChildren) el.appendChild(child);
    });

    if (options.glare) {
      const glareEl = document.createElement('div');
      glareEl.className = GLARE_CLASS;
      glareEl.setAttribute('aria-hidden', 'true');
      inner.appendChild(glareEl);
    }
    if (options.caption) {
      const captionEl = document.createElement('div');
      captionEl.className = CAPTION_CLASS;
      captionEl.setAttribute('aria-hidden', 'true');
      captionEl.textContent = options.caption;
      inner.appendChild(captionEl);

      // A visually hidden description carries the same text so the caption is not the only way
      // to get it; el.outerHTML restores because aria-describedby is snapshotted below.
      descCounter += 1;
      const descId = `${PREFIX}-desc-${descCounter}`;
      const descEl = document.createElement('span');
      descEl.id = descId;
      descEl.className = DESC_CLASS;
      descEl.textContent = options.caption;
      inner.appendChild(descEl);
      el.setAttribute('aria-describedby', descId);
    }

    let reduced = false;
    const motion = watchReducedMotion(signal, (isReduced) => {
      reduced = isReduced;
      el.classList.toggle(REDUCED_CLASS, isReduced);
      if (isReduced) reset();
    });
    reduced = motion.reduced;
    el.classList.toggle(REDUCED_CLASS, reduced);

    // Spring state: current rx/ry (deg), s (scale) and gx/gy (glare position, percent), eased
    // toward a target each frame (note 3, with damping).
    let rx = 0, ry = 0, s = 1, gx = 50, gy = 50;
    let tRx = 0, tRy = 0, tS = 1, tGx = 50, tGy = 50;
    let raf = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';

    const write = (): void => {
      setVars(el, PREFIX, {
        rx: `${rx.toFixed(2)}deg`,
        ry: `${ry.toFixed(2)}deg`,
        s: s.toFixed(3),
        gx: `${gx.toFixed(2)}%`,
        gy: `${gy.toFixed(2)}%`,
      });
    };
    write();

    const tick = (): void => {
      raf = 0;
      rx += (tRx - rx) * (1 - options.damping);
      ry += (tRy - ry) * (1 - options.damping);
      s += (tS - s) * (1 - options.damping);
      gx += (tGx - gx) * (1 - options.damping);
      gy += (tGy - gy) * (1 - options.damping);
      const settled = Math.abs(tRx - rx) + Math.abs(tRy - ry) + Math.abs(tS - s)
        + Math.abs(tGx - gx) + Math.abs(tGy - gy) <= SETTLE_EPSILON;
      if (settled) { rx = tRx; ry = tRy; s = tS; gx = tGx; gy = tGy; }
      write();
      if (!settled) schedule();
    };
    const schedule = (): void => {
      if (!hasRaf) { rx = tRx; ry = tRy; s = tS; gx = tGx; gy = tGy; write(); return; }
      if (!raf) raf = requestAnimationFrame(tick);
    };

    /** Stop the spring, drop the active state and snap to flat; the CSS transition on `__inner`
     * (using `--genui-tilted-card-reset`) eases the visible return once `--active` is gone. */
    const reset = (): void => {
      el.classList.remove(ACTIVE_CLASS);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      rx = 0; ry = 0; s = 1; gx = 50; gy = 50;
      tRx = 0; tRy = 0; tS = 1; tGx = 50; tGy = 50;
      write();
    };

    const onMove = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      if (reduced) {
        // Spec §16 "Reduced motion": no tilt, but hover still applies a static scale through a
        // non-animated class (--reduced forces transition:none, so this jumps instantly) and
        // reveals the glare at its fixed default position (rx/ry/gx/gy stay untouched — test 3).
        el.classList.add(ACTIVE_CLASS);
        s = options.scale;
        write();
        return;
      }
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = (event.clientX - rect.left) / rect.width;
      const py = (event.clientY - rect.top) / rect.height;
      el.classList.add(ACTIVE_CLASS);
      tRy = (px - 0.5) * 2 * options.maxTilt;
      tRx = (0.5 - py) * 2 * options.maxTilt;
      tS = options.scale;
      tGx = px * 100;
      tGy = py * 100;
      schedule();
    };
    const onLeave = (event: PointerEvent): void => {
      if (event.pointerType === 'touch') return;
      reset();
    };
    const onFocusIn = (): void => {
      el.classList.add(ACTIVE_CLASS);
      if (reduced) { s = options.scale; write(); return; }
      tRx = 0; tRy = 0; tS = options.scale; tGx = 50; tGy = 50;
      schedule();
    };
    const onFocusOut = (): void => { reset(); };

    const listenerOpts = { passive: true, signal } as const;
    el.addEventListener('pointermove', onMove, listenerOpts);
    el.addEventListener('pointerleave', onLeave, listenerOpts);
    el.addEventListener('focusin', onFocusIn, listenerOpts);
    el.addEventListener('focusout', onFocusOut, listenerOpts);

    onDestroy(() => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    });
  }, ['aria-describedby']);
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
