/**
 * circular-gallery — clean-room implementation from the effect name and the one-line description
 * ("curved scrolling gallery with image bending") only. No WebGL: the items stay real DOM in a
 * flex row, and each frame `mount` moves every `.genui-circular-gallery__item` onto an arc of a
 * circle (translate + rotate) around the host's centre, wrapping them into an endless loop. The
 * "bend" is a per-item `--genui-circular-gallery-t` (-1 left edge … 1 right edge) that the CSS
 * turns into a perspective `rotateY` and a slight dim on `__media`, so pictures foreshorten as
 * they curve away. The strip drifts on its own (`speed`), and follows drag, horizontal wheel,
 * arrow keys and focus (a focused item is brought to the centre).
 *
 * Without script (or under reduced motion) the host is a plain horizontal scroll-snap strip, so
 * every item stays reachable. The rAF loop runs only while the host is on screen, something is
 * moving, and motion is allowed; it stops on destroy.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-circular-gallery` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (item styles included).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'circular-gallery';
const PREFIX = `genui-${id}`;
const LIVE_CLASS = `${PREFIX}--live`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const DRAG_CLASS = `${PREFIX}--dragging`;
const ITEM_SELECTOR = `.${PREFIX}__item`;

export interface CircularGalleryOptions {
  [key: string]: string | number | boolean;
  /** Tilt, in degrees, of an item at the host's edge; 0 is flat, negative curves upward. */
  bend: number;
  /** Auto-scroll speed in px per second; 0 disables the drift. */
  speed: number;
  /** Smoothing factor per frame (0.01 heavy lag … 1 instant). */
  ease: number;
  /** Space between items, in px. */
  gap: number;
  /** Let the pointer drag the strip. */
  draggable: boolean;
  /** Pause the drift while the pointer or focus is inside. */
  pauseOnHover: boolean;
}

export const defaults: CircularGalleryOptions = {
  bend: 22,
  speed: 28,
  ease: 0.08,
  gap: 16,
  draggable: true,
  pauseOnHover: true,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: CircularGalleryOptions): Record<string, string> {
  return {
    gap: `${Math.max(0, options.gap)}px`,
    bend: `${Math.min(80, Math.max(-80, options.bend))}deg`,
  };
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

export function mount(el: HTMLElement, opts: Partial<CircularGalleryOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const items = Array.from(el.querySelectorAll<HTMLElement>(ITEM_SELECTOR));
    const bend = (Math.min(80, Math.max(-80, options.bend)) * Math.PI) / 180;
    const ease = Math.min(1, Math.max(0.01, options.ease));
    const gap = Math.max(0, options.gap);
    const hasRaf = typeof requestAnimationFrame === 'function';

    let live = false;
    let visible = typeof IntersectionObserver !== 'function';
    let offset = 0; let target = 0; let raf = 0; let last = 0;
    let paused = false; let dragX: number | null = null; let moved = 0;
    let centres: number[] = []; let loop = 0; let width = 0;
    let restoreItems: Array<() => void> = [];

    const measure = (): void => {
      width = el.clientWidth;
      centres = items.map((item) => item.offsetLeft + item.offsetWidth / 2);
      loop = items.reduce((sum, item) => sum + item.offsetWidth + gap, 0);
    };

    /** Signed distance of item `i` from the host centre after scrolling by `offset`, wrapped. */
    const distance = (i: number): number => {
      const c = centres[i] ?? 0;
      return loop > 0 ? mod(c - offset - width / 2 + loop / 2, loop) - loop / 2 : c - width / 2;
    };

    const render = (): void => {
      const half = Math.max(1, width / 2);
      const radius = bend === 0 ? Infinity : half / Math.abs(bend);
      items.forEach((item, i) => {
        const s = distance(i);
        const theta = Number.isFinite(radius) ? s / radius : 0;
        const x = Number.isFinite(radius) ? radius * Math.sin(theta) : s;
        const y = Number.isFinite(radius) ? radius * (1 - Math.cos(theta)) * Math.sign(bend) : 0;
        const t = Math.max(-1, Math.min(1, s / half));
        item.style.transform = `translate3d(${(half + x - (centres[i] ?? 0)).toFixed(2)}px,${y.toFixed(2)}px,0) rotate(${(theta * Math.sign(bend)).toFixed(4)}rad)`;
        item.style.setProperty(`--${PREFIX}-t`, t.toFixed(3));
        item.style.setProperty(`--${PREFIX}-a`, Math.abs(t).toFixed(3));
      });
      // Room for the arc: the drop (or rise) of an item sitting at the host's edge.
      const edge = Number.isFinite(radius) ? Math.round(radius * (1 - Math.cos(bend))) : 0;
      el.style.setProperty(`--${PREFIX}-pt`, `${bend < 0 ? edge : 0}px`);
      el.style.setProperty(`--${PREFIX}-pb`, `${bend > 0 ? edge : 0}px`);
    };

    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };

    const drifting = (): boolean => options.speed !== 0 && !paused && dragX === null;

    const tick = (now: number): void => {
      raf = 0;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : 1 / 60;
      last = now;
      if (drifting()) target += options.speed * dt;
      offset += (target - offset) * (1 - Math.pow(1 - ease, dt * 60));
      if (Math.abs(target - offset) < 0.05) offset = target;
      render();
      schedule();
    };

    function schedule(): void {
      if (!live || !visible || !hasRaf || raf) return;
      if (!drifting() && offset === target && dragX === null) { last = 0; return; }
      raf = requestAnimationFrame(tick);
    }

    const nudge = (delta: number): void => { target += delta; if (!hasRaf) offset = target; if (live) { render(); schedule(); } };

    const activate = (): void => {
      if (live || items.length === 0) return;
      live = true;
      restoreItems = items.map((item) => snapshotAttributes(item, ['style']));
      el.classList.add(LIVE_CLASS);
      el.scrollLeft = 0;
      measure();
      render();
      schedule();
    };

    const deactivate = (): void => {
      if (!live) return;
      live = false;
      stop();
      last = 0;
      for (const restore of restoreItems) restore();
      restoreItems = [];
      el.classList.remove(LIVE_CLASS, DRAG_CLASS);
      el.style.removeProperty(`--${PREFIX}-pt`);
      el.style.removeProperty(`--${PREFIX}-pb`);
    };

    const opt = { signal } as const;
    const passive = { signal, passive: true } as const;

    if (options.pauseOnHover) {
      const pause = (on: boolean) => (): void => { paused = on; last = 0; schedule(); };
      el.addEventListener('pointerenter', pause(true), passive);
      el.addEventListener('pointerleave', pause(false), passive);
      el.addEventListener('focusin', pause(true), opt);
      el.addEventListener('focusout', pause(false), opt);
    }

    el.addEventListener('focusin', (event) => {
      const i = items.findIndex((item) => item.contains(event.target as Node));
      if (live && i >= 0) nudge(distance(i));
    }, opt);

    el.addEventListener('keydown', (event) => {
      if (!live || (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight')) return;
      event.preventDefault();
      const step = items.length ? loop / items.length : 0;
      nudge(event.key === 'ArrowRight' ? step : -step);
    }, opt);

    el.addEventListener('wheel', (event) => {
      const dx = event.deltaX || (event.shiftKey ? event.deltaY : 0);
      if (!live || !dx) return;
      event.preventDefault();
      nudge(dx);
    }, { signal, passive: false });

    if (options.draggable) {
      el.addEventListener('pointerdown', (event) => {
        if (!live || event.button !== 0) return;
        dragX = event.clientX; moved = 0;
        el.classList.add(DRAG_CLASS);
        schedule();
      }, passive);
      el.addEventListener('pointermove', (event) => {
        if (dragX === null) return;
        const dx = event.clientX - dragX;
        dragX = event.clientX; moved += Math.abs(dx);
        nudge(-dx);
      }, passive);
      const end = (): void => { if (dragX === null) return; dragX = null; el.classList.remove(DRAG_CLASS); schedule(); };
      el.addEventListener('pointerup', end, passive);
      el.addEventListener('pointercancel', end, passive);
      el.addEventListener('pointerleave', end, passive);
      // A drag is not a click: swallow the click that ends a real drag so links do not fire.
      el.addEventListener('click', (event) => {
        if (moved > 6) { event.preventDefault(); event.stopPropagation(); }
        moved = 0;
      }, { signal, capture: true });
    }

    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        if (visible) schedule(); else { stop(); last = 0; }
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { if (live) { measure(); render(); } });
      ro.observe(el);
      onDestroy(() => { ro.disconnect(); });
    }

    onDestroy(deactivate);

    const sync = (reduced: boolean): void => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) deactivate(); else activate();
    };
    const motion = watchReducedMotion(signal, sync);
    sync(motion.reduced);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
