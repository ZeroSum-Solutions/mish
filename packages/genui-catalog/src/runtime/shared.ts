/**
 * Browser helpers every catalog component shares (component-specs.md "Implementation notes").
 * Each component bundles only what it imports, so an unused helper costs nothing.
 *
 * Rules the helpers encode:
 * - Every listener takes the component's AbortSignal, so `destroy()` is one `abort()`.
 * - Reduced motion is read at mount and on change; with no `matchMedia` (jsdom), motion is allowed.
 * - With no IntersectionObserver or `Element.animate` (old browsers, jsdom), jump to the final state.
 * - The host is restored exactly: attributes are snapshotted at mount and put back on destroy.
 */

export interface GenuiHandle {
  destroy(): void;
}

export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const MOUNTED_ATTR = 'data-genui-mounted';

// ---------------------------------------------------------------------------------------------
// Options

type OptionValue = string | number | boolean | null | readonly unknown[] | { readonly [key: string]: unknown };

function sameShape(fallback: unknown, value: unknown): boolean {
  if (fallback === null) return value === null || typeof value === 'number' || typeof value === 'string';
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (typeof fallback === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof fallback === 'object') return typeof value === 'object' && value !== null && !Array.isArray(value);
  return typeof value === typeof fallback;
}

function mergeKnown<T extends Record<string, OptionValue>>(base: T, patch: unknown): T {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return base;
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.prototype.hasOwnProperty.call(base, key)) continue; // unknown keys are dropped
    const fallback = base[key];
    if (!sameShape(fallback, value)) continue; // wrong type keeps the default
    out[key] = typeof fallback === 'object' && fallback !== null && !Array.isArray(fallback)
      ? mergeKnown(fallback as Record<string, OptionValue>, value)
      : value;
  }
  return out as T;
}

/**
 * Defaults, then `el.dataset.genuiOpts` (JSON), then `opts`. Unknown keys and values of the wrong
 * type are dropped, so markup can never smuggle an arbitrary option in.
 */
export function resolveOptions<T extends Record<string, OptionValue>>(
  el: HTMLElement,
  defaults: T,
  opts: Partial<T> = {},
): T {
  let fromData: unknown;
  const raw = el.dataset.genuiOpts;
  if (raw) {
    try { fromData = JSON.parse(raw); } catch { fromData = undefined; }
  }
  return mergeKnown(mergeKnown(defaults, fromData), opts);
}

// ---------------------------------------------------------------------------------------------
// Host snapshot

/**
 * Record `attrs` on `el` now; the returned function puts each back exactly (value or absence).
 * Snapshot `class` and `style` as whole attributes, so an element that had none gets none back
 * rather than an empty `class=""`.
 */
export function snapshotAttributes(el: Element, attrs: readonly string[]): () => void {
  const saved = attrs.map((name) => [name, el.getAttribute(name)] as const);
  return () => {
    for (const [name, value] of saved) {
      if (value === null) el.removeAttribute(name);
      else el.setAttribute(name, value);
    }
  };
}

/** Set `--<prefix>-<key>` custom properties on `el`. */
export function setVars(el: HTMLElement, prefix: string, vars: Record<string, string | number>): void {
  for (const [key, value] of Object.entries(vars)) el.style.setProperty(`--${prefix}-${key}`, String(value));
}

// ---------------------------------------------------------------------------------------------
// Mount scaffolding

export interface MountContext {
  el: HTMLElement;
  /** Aborted by destroy(); pass it to every addEventListener. */
  signal: AbortSignal;
  /** Register a cleanup that destroy() runs (last registered runs first). */
  onDestroy(fn: () => void): void;
}

/**
 * The common mount lifecycle: skip an already-mounted host, snapshot `class`, `style`,
 * `data-genui-mounted` and any `extraAttrs`, add `.genui-<id>` and the mounted marker, run
 * `setup`, and return an idempotent handle that aborts listeners, runs cleanups in reverse and
 * restores the snapshot.
 */
export function mountComponent(
  id: string,
  el: HTMLElement,
  setup: (ctx: MountContext) => void,
  extraAttrs: readonly string[] = [],
): GenuiHandle {
  if (el.hasAttribute(MOUNTED_ATTR)) return { destroy() {} };
  const restore = snapshotAttributes(el, ['class', 'style', MOUNTED_ATTR, ...extraAttrs]);
  const controller = new AbortController();
  const cleanups: Array<() => void> = [];
  el.classList.add(`genui-${id}`);
  el.setAttribute(MOUNTED_ATTR, '');
  let destroyed = false;
  const handle: GenuiHandle = {
    destroy() {
      if (destroyed) return;
      destroyed = true;
      controller.abort();
      for (const fn of cleanups.reverse()) fn();
      restore();
    },
  };
  try {
    setup({ el, signal: controller.signal, onDestroy: (fn) => { cleanups.push(fn); } });
  } catch (error) {
    handle.destroy();
    throw error;
  }
  return handle;
}

/** Mount every `[data-genui="<id>"]` under `root` that is not mounted yet. */
export function autoInitComponent(
  id: string,
  mount: (el: HTMLElement) => GenuiHandle,
  root: ParentNode = document,
): GenuiHandle[] {
  const hosts = root.querySelectorAll<HTMLElement>(`[data-genui="${id}"]:not([${MOUNTED_ATTR}])`);
  return Array.from(hosts, (el) => mount(el));
}

// ---------------------------------------------------------------------------------------------
// 1. Reduced motion

export interface ReducedMotionWatch {
  readonly reduced: boolean;
}

/**
 * Read `prefers-reduced-motion` now and follow changes until `signal` aborts. `onChange` runs on
 * every change (not at start). Without `matchMedia`, motion is allowed.
 */
export function watchReducedMotion(signal: AbortSignal, onChange?: (reduced: boolean) => void): ReducedMotionWatch {
  const mq = typeof matchMedia === 'function' ? matchMedia(REDUCED_MOTION_QUERY) : null;
  const state = { reduced: mq?.matches ?? false };
  mq?.addEventListener('change', () => {
    state.reduced = mq.matches;
    onChange?.(state.reduced);
  }, { signal });
  return state;
}

// ---------------------------------------------------------------------------------------------
// 2. IntersectionObserver reveal

export interface RevealOptions {
  threshold?: number;
  rootMargin?: string;
  /** Stop observing after the first reveal (default true). */
  once?: boolean;
}

/**
 * Call `onEnter` when `el` intersects. Returns a disconnect function. Without
 * IntersectionObserver, `onEnter` runs at once so content is never left hidden.
 */
export function observeReveal(el: Element, onEnter: (target: Element) => void, options: RevealOptions = {}): () => void {
  const { threshold = 0.15, rootMargin = '0px', once = true } = options;
  if (typeof IntersectionObserver !== 'function') {
    onEnter(el);
    return () => {};
  }
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      onEnter(entry.target);
      if (once) io.unobserve(entry.target);
    }
  }, { threshold, rootMargin });
  io.observe(el);
  return () => io.disconnect();
}

/** Scroll progress of `el` through the viewport, 0 (below) to 1 (above). */
export function viewProgress(el: Element): number {
  const rect = el.getBoundingClientRect();
  const vh = typeof innerHeight === 'number' ? innerHeight : 0;
  const total = vh + rect.height;
  return total <= 0 ? 0 : Math.min(1, Math.max(0, (vh - rect.top) / total));
}

// ---------------------------------------------------------------------------------------------
// 3. Pointer-driven custom properties

export interface PointerVarsOptions {
  /** Custom-property prefix, e.g. `genui-spotlight-card` writes `--genui-spotlight-card-x`. */
  prefix: string;
  /** 0 = follow instantly, 0.9 = heavy lag. */
  damping?: number;
  allowTouch?: boolean;
  signal: AbortSignal;
  /** Called after each frame with the damped 0..1 position. */
  onFrame?: (x: number, y: number) => void;
}

/**
 * Track the pointer over `el` and write `--<prefix>-x`/`-y` (percent) and `--<prefix>-active`
 * (0/1) through one rAF loop that stops when the value settles. Focus centres the point for
 * keyboard parity. Returns a stop function (also run when `signal` aborts).
 */
export function trackPointerVars(el: HTMLElement, options: PointerVarsOptions): () => void {
  const { prefix, damping = 0.8, allowTouch = false, signal, onFrame } = options;
  let x = 0.5; let y = 0.5; let tx = 0.5; let ty = 0.5; let raf = 0;
  const hasRaf = typeof requestAnimationFrame === 'function';
  const write = (): void => {
    el.style.setProperty(`--${prefix}-x`, `${(x * 100).toFixed(2)}%`);
    el.style.setProperty(`--${prefix}-y`, `${(y * 100).toFixed(2)}%`);
    onFrame?.(x, y);
  };
  const tick = (): void => {
    raf = 0;
    x += (tx - x) * (1 - damping);
    y += (ty - y) * (1 - damping);
    if (Math.abs(tx - x) + Math.abs(ty - y) <= 0.001) { x = tx; y = ty; write(); return; }
    write();
    schedule();
  };
  const schedule = (): void => {
    if (!hasRaf) { x = tx; y = ty; write(); return; }
    if (!raf) raf = requestAnimationFrame(tick);
  };
  const setActive = (on: boolean): void => { el.style.setProperty(`--${prefix}-active`, on ? '1' : '0'); };
  const opts = { passive: true, signal } as const;
  const onMove = (event: PointerEvent): void => {
    if (event.pointerType === 'touch' && !allowTouch) return;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    tx = (event.clientX - rect.left) / rect.width;
    ty = (event.clientY - rect.top) / rect.height;
    schedule();
  };
  el.addEventListener('pointermove', onMove, opts);
  el.addEventListener('pointerenter', (event) => { if (event.pointerType !== 'touch' || allowTouch) setActive(true); onMove(event); }, opts);
  el.addEventListener('pointerleave', () => { setActive(false); tx = 0.5; ty = 0.5; schedule(); }, opts);
  el.addEventListener('focusin', () => { setActive(true); tx = 0.5; ty = 0.5; schedule(); }, opts);
  el.addEventListener('focusout', () => { setActive(false); }, opts);
  const stop = (): void => {
    if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    raf = 0;
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}

// ---------------------------------------------------------------------------------------------
// 4. Web Animations API

export interface AnimationSet {
  /** Start an animation; returns null (and applies nothing) where WAAPI is missing. */
  play(el: Element, keyframes: Keyframe[] | PropertyIndexedKeyframes, options: KeyframeAnimationOptions): Animation | null;
  cancelAll(): void;
  readonly size: number;
}

/** A set of running animations that `cancelAll()` (call it from destroy) cancels together. */
export function createAnimationSet(): AnimationSet {
  const running = new Set<Animation>();
  return {
    play(el, keyframes, options) {
      if (typeof (el as { animate?: unknown }).animate !== 'function') return null;
      const animation = el.animate(keyframes, { fill: 'both', ...options });
      running.add(animation);
      animation.finished.then(() => { running.delete(animation); }, () => { running.delete(animation); });
      return animation;
    },
    cancelAll() {
      for (const animation of running) animation.cancel();
      running.clear();
    },
    get size() { return running.size; },
  };
}

const springCache = new Map<string, string>();
export const SPRING_FALLBACK = 'cubic-bezier(.34,1.56,.64,1)';

/**
 * A CSS `linear(...)` easing sampled from a damped spring (about 30 points), cached per option
 * set. Falls back to an overshooting cubic-bezier where `linear()` is unsupported.
 */
export function springEasing(stiffness = 170, damping = 26, mass = 1, samples = 30): string {
  const key = `${stiffness}|${damping}|${mass}|${samples}`;
  const hit = springCache.get(key);
  if (hit) return hit;
  const supported = typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    && CSS.supports('animation-timing-function', 'linear(0, 1)');
  if (!supported) return SPRING_FALLBACK;
  // Semi-implicit Euler over a fixed 1 s window; the result is normalised to end at 1.
  const points: string[] = [];
  let position = 0; let velocity = 0;
  const steps = 600; const dt = 1 / steps;
  for (let i = 0; i <= steps; i += 1) {
    if (i % Math.round(steps / samples) === 0) points.push(position.toFixed(4).replace(/\.?0+$/, '') || '0');
    const force = -stiffness * (position - 1) - damping * velocity;
    velocity += (force / mass) * dt;
    position += velocity * dt;
  }
  points[points.length - 1] = '1';
  const easing = `linear(${points.join(', ')})`;
  springCache.set(key, easing);
  return easing;
}

// ---------------------------------------------------------------------------------------------
// 5. autoInit for [data-genui]

export interface GenuiModule {
  id: string;
  mount(el: HTMLElement, opts?: Record<string, unknown>): GenuiHandle;
}

/** Mount every unmounted `[data-genui]` under `root` whose id has a module in `modules`. */
export function autoInitAll(modules: readonly GenuiModule[], root: ParentNode = document): GenuiHandle[] {
  const byId = new Map(modules.map((module) => [module.id, module]));
  const handles: GenuiHandle[] = [];
  for (const el of Array.from(root.querySelectorAll<HTMLElement>(`[data-genui]:not([${MOUNTED_ATTR}])`))) {
    const module = byId.get(el.dataset.genui ?? '');
    if (module) handles.push(module.mount(el));
  }
  return handles;
}
