/**
 * dome-gallery — clean-room implementation from the one-line effect description only
 * ("Drag-to-explore 3D dome"). No WebGL and no gesture library: every `.genui-dome-gallery__item`
 * child is placed on the inside of a sphere with CSS 3D transforms, and the viewer sits at the
 * sphere's centre. Dragging (or the arrow keys) turns the view; only two custom properties on the
 * host (`yaw`, `pitch`) change per frame, so the browser composites the tiles.
 *
 * - Mobile: the host uses `touch-action: pan-y`, so a vertical swipe still scrolls the page; touch
 *   drags turn the dome sideways only. Mouse and pen drags also tilt it.
 * - An optional slow drift (`autoRotate`) pauses on hover, focus and drag, and its rAF loop stops
 *   while the host is off-screen (IntersectionObserver) and on destroy.
 * - Tiles facing away from the viewer get `__item--away` (faded, hidden from pointer), so nothing
 *   ever renders behind the camera.
 * - Focus moving onto a link or button inside a tile turns the dome to face that tile.
 * - Reduced motion: the dome is not built; the items stay in the flat, scrollable strip that is
 *   also the no-JS layout. A live preference change switches between the two.
 *
 * Contract: `mount(el, opts)` merges `data-genui-opts` under `opts` (unknown keys dropped), adds
 * `.genui-dome-gallery` and `data-genui-mounted`, and `destroy()` restores `el.outerHTML` exactly
 * (host and item attributes are snapshotted).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'dome-gallery';
const PREFIX = `genui-${id}`;
const DOME_CLASS = `${PREFIX}--3d`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const DRAG_CLASS = `${PREFIX}--dragging`;
const AWAY_CLASS = `${PREFIX}__item--away`;

export interface DomeGalleryOptions {
  [key: string]: string | number | boolean;
  /** Sphere radius, in px; also the perspective, so a facing tile shows at its natural size. */
  radius: number;
  /** Tile width, in px. */
  tile: number;
  /** Rows of tiles stacked up the dome. */
  rows: number;
  /** Angle between neighbouring tiles, in degrees. */
  step: number;
  /** Degrees turned per px dragged. */
  sensitivity: number;
  /** Idle drift, in degrees per second; 0 turns it off. */
  autoRotate: number;
  /** Largest up/down tilt, in degrees. */
  maxTilt: number;
  /** Keep turning briefly after a fast drag is released. */
  inertia: boolean;
  /** Accessible name for the host when it has none. */
  label: string;
}

export const defaults: DomeGalleryOptions = {
  radius: 420,
  tile: 140,
  rows: 3,
  step: 22,
  sensitivity: 0.25,
  autoRotate: 3,
  maxTilt: 18,
  inertia: true,
  label: 'Gallery. Drag or use the arrow keys to look around.',
};

const rad = Math.PI / 180;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: DomeGalleryOptions): Record<string, string> {
  return {
    radius: `${Math.max(50, options.radius)}px`,
    tile: `${Math.max(20, options.tile)}px`,
    yaw: '0deg',
    pitch: '0deg',
  };
}

interface Tile { el: HTMLElement; lon: number; lat: number; away: boolean }

export function mount(el: HTMLElement, opts: Partial<DomeGalleryOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const o = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(o));
    if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
    if (!el.hasAttribute('role')) el.setAttribute('role', 'group');
    if (!el.hasAttribute('aria-label') && !el.hasAttribute('aria-labelledby')) el.setAttribute('aria-label', o.label);

    const nodes = Array.from(el.querySelectorAll<HTMLElement>(`.${PREFIX}__item`));
    const rows = clamp(Math.round(o.rows), 1, Math.max(1, nodes.length));
    const cols = Math.max(1, Math.ceil(nodes.length / rows));
    const step = clamp(o.step, 2, 90);
    const tiles: Tile[] = nodes.map((node, i) => {
      const restore = snapshotAttributes(node, ['class', 'style']);
      onDestroy(restore);
      const row = Math.floor(i / cols);
      // CSS rotateY(+a) moves a tile left and rotateX(+a) moves it down, so both offsets are negated.
      const lon = -((i % cols - (cols - 1) / 2) * step + (row % 2 ? step / 2 : 0) - (rows > 1 ? step / 4 : 0));
      const lat = (row - (rows - 1) / 2) * step * 0.85;
      setVars(node, PREFIX, { lon: `${lon}deg`, lat: `${lat}deg` });
      return { el: node, lon, lat, away: false };
    });

    const span = (cols - 1) * step + (rows > 1 ? step / 2 : 0);
    const maxYaw = span + step >= 360 ? Infinity : span / 2;
    const maxTilt = clamp(o.maxTilt, 0, 80);
    const hasRaf = typeof requestAnimationFrame === 'function';

    let yaw = 0; let pitch = 0; let tYaw = 0; let tPitch = 0;
    let vel = 0; let dir = 1; let raf = 0; let last = 0;
    let dragging = false; let held = false; let moved = 0; let lastX = 0; let lastY = 0; let lastT = 0;
    let visible = typeof IntersectionObserver !== 'function';
    let reduced = false;

    const apply = (): void => {
      setVars(el, PREFIX, { yaw: `${yaw.toFixed(3)}deg`, pitch: `${pitch.toFixed(3)}deg` });
      const sp = Math.sin(pitch * rad); const cp = Math.cos(pitch * rad);
      for (const t of tiles) {
        // Facing = -z of the tile normal after rotateX(pitch) rotateY(yaw + lon) rotateX(lat).
        const facing = Math.cos(t.lat * rad) * Math.cos((yaw + t.lon) * rad) * cp - Math.sin(t.lat * rad) * sp;
        const away = facing < 0.35;
        if (away !== t.away) { t.away = away; t.el.classList.toggle(AWAY_CLASS, away); }
      }
    };

    const clampTargets = (): void => {
      if (tYaw > maxYaw || tYaw < -maxYaw) { tYaw = clamp(tYaw, -maxYaw, maxYaw); vel = 0; dir = tYaw > 0 ? -1 : 1; }
      tPitch = clamp(tPitch, -maxTilt, maxTilt);
    };

    const tick = (now: number): void => {
      raf = 0;
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      if (!dragging) {
        if (Math.abs(vel) > 0.5) { tYaw += vel * dt; vel *= 0.04 ** dt; } else vel = 0;
        if (!vel && o.autoRotate > 0 && !held) tYaw += dir * o.autoRotate * dt;
        clampTargets();
      }
      const k = Math.min(1, dt * 12);
      yaw += (tYaw - yaw) * k; pitch += (tPitch - pitch) * k;
      apply();
      const settling = Math.abs(tYaw - yaw) + Math.abs(tPitch - pitch) > 0.01;
      if (dragging || vel || settling || (o.autoRotate > 0 && !held)) kick();
      else last = 0;
    };

    function kick(): void {
      if (reduced || raf) return;
      if (!hasRaf) { clampTargets(); yaw = tYaw; pitch = tPitch; apply(); return; }
      if (visible) raf = requestAnimationFrame(tick);
    }
    const stop = (): void => {
      if (raf) cancelAnimationFrame(raf);
      raf = 0; last = 0;
    };
    onDestroy(stop);

    const setReduced = (value: boolean): void => {
      reduced = value;
      el.classList.toggle(REDUCED_CLASS, value);
      el.classList.toggle(DOME_CLASS, !value);
      if (value) { stop(); dragging = false; el.classList.remove(DRAG_CLASS); } else { apply(); kick(); }
    };
    const motion = watchReducedMotion(signal, setReduced);
    setReduced(motion.reduced);

    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        if (visible) kick(); else stop();
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }

    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, capture = false): void => {
      el.addEventListener(type, fn, { signal, capture });
    };

    on('pointerdown', (e) => {
      if (reduced || e.button > 0) return;
      dragging = true; moved = 0; vel = 0;
      lastX = e.clientX; lastY = e.clientY; lastT = e.timeStamp;
      el.setPointerCapture?.(e.pointerId);
      kick();
    });
    on('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastX; const dy = e.clientY - lastY;
      const dts = Math.max(1, e.timeStamp - lastT) / 1000;
      lastX = e.clientX; lastY = e.clientY; lastT = e.timeStamp;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) el.classList.add(DRAG_CLASS);
      const d = dx * o.sensitivity;
      tYaw -= d; yaw -= d;
      vel = o.inertia ? -d / dts : 0;
      if (e.pointerType !== 'touch') tPitch += dy * o.sensitivity;
      clampTargets();
      yaw = clamp(yaw, -maxYaw, maxYaw);
      kick();
    });
    const release = (): void => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove(DRAG_CLASS);
      if (!o.inertia) vel = 0;
      setTimeout(() => { moved = 0; });
      kick();
    };
    on('pointerup', release);
    on('pointercancel', release);
    // A drag must not end in a click on a tile link.
    on('click', (e) => {
      if (moved > 4) { e.preventDefault(); e.stopPropagation(); moved = 0; }
    }, true);

    on('pointerenter', () => { held = true; });
    on('pointerleave', () => { held = false; kick(); });
    on('focusin', (e) => {
      held = true;
      const tile = tiles.find((t) => t.el.contains(e.target as Node));
      if (tile && !reduced) { tYaw = -tile.lon; tPitch = -tile.lat; vel = 0; clampTargets(); kick(); }
    });
    on('focusout', () => { held = false; kick(); });
    on('keydown', (e) => {
      if (reduced || e.target !== el) return;
      const key = e.key;
      const turn = key === 'ArrowRight' ? step : key === 'ArrowLeft' ? -step : 0;
      const tilt = key === 'ArrowUp' ? step / 2 : key === 'ArrowDown' ? -step / 2 : 0;
      if (!turn && !tilt && key !== 'Home') return;
      e.preventDefault();
      vel = 0;
      if (key === 'Home') { tYaw = 0; tPitch = 0; } else { tYaw += turn; tPitch += tilt; }
      clampTargets();
      kick();
    });
  }, ['tabindex', 'role', 'aria-label']);
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
