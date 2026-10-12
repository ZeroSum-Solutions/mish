/**
 * halftone-reveal — clean-room implementation from the effect name and the one-line description
 * ("Halftone dissolve reveal") only; no React Bits source was read. A screen of halftone dots, in
 * the page colour, covers the host. As the host scrolls up through the viewport the dots shrink
 * and dissolve along a sweep (`direction`), so the content underneath develops through the
 * screen like a print. A `edge` colour, when set, tints the dots that are mid-dissolve, so the
 * moving front reads as a band of ink.
 *
 * One 2D canvas (`__screen`, aria-hidden, pointer-events none) sits over the content. It is only
 * drawn on scroll/resize, rAF-throttled, while the host is near the viewport (IntersectionObserver);
 * there is no idle loop. Without a 2D context (jsdom, locked-down hosts) no canvas is kept and
 * the content simply shows, so nothing is ever left covered.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-halftone-reveal` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'halftone-reveal';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface HalftoneRevealOptions {
  [key: string]: string | number | boolean;
  /** Dot colour; match the surface behind the host so the dots read as holes in the content. */
  color: string;
  /** Colour of the dots that are mid-dissolve; empty for none. */
  edge: string;
  /** Halftone cell size, in px. */
  cell: number;
  /** Sweep the dissolve travels: `up` reveals the bottom first. */
  direction: 'up' | 'down' | 'left' | 'right' | 'radial';
  /** Share of the sweep over which one dot shrinks away (0-1). */
  softness: number;
  /** Per-dot randomness of the dissolve front (0-1). */
  jitter: number;
  /** Viewport fraction (0 = top) of the host's top edge where the reveal starts. */
  start: number;
  /** Viewport fraction where the reveal is complete. */
  end: number;
  /** Stay revealed once complete instead of re-covering on scroll back. */
  once: boolean;
}

export const defaults: HalftoneRevealOptions = {
  color: '#0b0d12',
  edge: '',
  cell: 14,
  direction: 'up',
  softness: 0.35,
  jitter: 0.3,
  start: 0.95,
  end: 0.3,
  once: false,
};

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: HalftoneRevealOptions): Record<string, string> {
  return { color: options.color, cell: `${Math.max(4, options.cell)}px` };
}

/** 0 while the host's top is below `start`, 1 once it has reached `end`. */
export function revealProgress(top: number, viewportHeight: number, start: number, end: number): number {
  const span = start - end;
  if (span === 0 || viewportHeight <= 0) return 1;
  return clamp01((start - top / viewportHeight) / span);
}

/** Position of a point along the sweep, 0 (dissolves first) to 1 (dissolves last). */
function sweep(direction: string, x: number, y: number): number {
  if (direction === 'down') return y;
  if (direction === 'left') return 1 - x;
  if (direction === 'right') return x;
  if (direction === 'radial') return Math.min(1, Math.hypot(x - 0.5, y - 0.5) / 0.7071);
  return 1 - y;
}

/** Cheap deterministic 0-1 hash per cell, so the jitter is stable between frames. */
function hash(i: number, j: number): number {
  const s = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/**
 * Draw the halftone screen at `progress` into `ctx` (CSS pixel units). Returns the number of
 * dots drawn, which is 0 once the reveal is complete.
 */
export function drawScreen(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  progress: number,
  options: HalftoneRevealOptions,
): number {
  ctx.clearRect(0, 0, width, height);
  const cell = Math.max(4, options.cell);
  const soft = Math.max(0.01, clamp01(options.softness));
  const jitter = clamp01(options.jitter);
  const full = cell * 0.72; // just over half the cell diagonal: full dots overlap into solid cover
  const cols = Math.ceil(width / cell) + 1;
  const rows = Math.ceil(height / cell) + 1;
  const buckets: Array<Array<[number, number, number]>> = [[], []];
  for (let j = 0; j < rows; j += 1) {
    for (let i = 0; i < cols; i += 1) {
      const x = i * cell;
      const y = j * cell;
      const t = (sweep(options.direction, width ? x / width : 0, height ? y / height : 0) + hash(i, j) * jitter) / (1 + jitter);
      const local = clamp01((progress * (1 + soft) - t) / soft);
      if (local >= 1) continue;
      const r = full * (1 - local * local * (3 - 2 * local));
      if (r < 0.3) continue;
      buckets[local > 0 && options.edge ? 1 : 0]!.push([x, y, r]);
    }
  }
  let drawn = 0;
  buckets.forEach((dots, b) => {
    if (!dots.length) return;
    ctx.fillStyle = b ? options.edge : options.color;
    ctx.beginPath();
    for (const [x, y, r] of dots) {
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    drawn += dots.length;
  });
  return drawn;
}

export function mount(el: HTMLElement, opts: Partial<HalftoneRevealOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let stop: () => void = () => {};
    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) stop(); // snap to the revealed end state; nothing is re-armed on un-reduce
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) return; // no screen, no listeners: the content shows as authored

    const canvas = document.createElement('canvas');
    canvas.className = `${PREFIX}__screen`;
    canvas.setAttribute('aria-hidden', 'true');
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // no 2D context: leave the content uncovered
    el.append(canvas);

    let raf = 0;
    let attached = false;
    let best = 0;
    let io: IntersectionObserver | null = null;
    const draw = (): void => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      let p = revealProgress(rect.top, vh, options.start, options.end);
      if (options.once) p = best = Math.max(best, p);
      const dpr = Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) || 1;
      const w = Math.round(rect.width * dpr);
      const h = Math.round(rect.height * dpr);
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawScreen(ctx, rect.width, rect.height, p, options);
      if (options.once && p >= 1) stop();
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { draw(); return; }
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const attach = (): void => {
      if (attached) return;
      attached = true;
      addEventListener('scroll', schedule, { passive: true, signal });
      addEventListener('resize', schedule, { passive: true, signal });
      schedule();
    };
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    stop = (): void => { io?.disconnect(); detach(); canvas.remove(); };
    onDestroy(stop);

    draw(); // paint the correct state before first paint, so the content never flashes uncovered
    if (!canvas.isConnected) return;
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) (entry.isIntersecting ? attach : detach)();
      }, { rootMargin: '25% 0px' });
      io.observe(el);
    } else {
      attach();
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
