/**
 * flying-posters — clean-room implementation from the effect description ("vertical poster
 * gallery, 3D distortion on scroll") only. The host is a native vertical scroll container whose
 * `.genui-flying-posters__poster` children fly through a perspective: each poster tilts back and
 * sinks in depth by its distance from the viewport centre, flattening as it crosses the middle,
 * and scroll velocity adds an extra bend and stretch. No WebGL (the upstream hint is `ogl`, a
 * dependency this catalog cannot ship): JS writes a few numbers per frame as custom properties and
 * the stylesheet turns them into 3D transforms. Optional autoplay drifts the list upward and, with
 * `loop`, wraps it seamlessly through one aria-hidden, inert copy of the posters.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-flying-posters` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (clones removed, poster styles and the
 * scroll position put back).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'flying-posters';
const PREFIX = `genui-${id}`;
const POSTER = `${PREFIX}__poster`;
const CLONE = `${PREFIX}__clone`;
const LIVE = `${PREFIX}--live`;
const REDUCED = `${PREFIX}--reduced`;

export interface FlyingPostersOptions {
  [key: string]: string | number | boolean;
  /** Autoplay drift, in px per second; 0 turns autoplay off. */
  speed: number;
  /** Peak tilt of a poster at the viewport edge, in degrees. */
  tilt: number;
  /** How far a poster at the edge sinks back, in px. */
  depth: number;
  /** Extra bend from scroll velocity, in degrees. */
  bend: number;
  /** Perspective distance, in px. */
  perspective: number;
  /** Wrap the list seamlessly through one hidden copy of the posters. */
  loop: boolean;
  /** Pause autoplay while the pointer or focus is inside the gallery. */
  pauseOnHover: boolean;
}

export const defaults: FlyingPostersOptions = {
  speed: 28,
  tilt: 40,
  depth: 140,
  bend: 14,
  perspective: 700,
  loop: true,
  pauseOnHover: true,
};

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: FlyingPostersOptions): Record<string, string> {
  return {
    tilt: `${options.tilt}deg`,
    depth: `${Math.max(0, options.depth)}px`,
    bend: `${options.bend}deg`,
    perspective: `${Math.max(1, options.perspective)}px`,
  };
}

const clamp = (value: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, value));
const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function mount(el: HTMLElement, opts: Partial<FlyingPostersOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const posters = Array.from(el.querySelectorAll<HTMLElement>(`:scope > .${POSTER}`));
    const startTop = el.scrollTop;
    onDestroy(() => { el.scrollTop = startTop; });

    let stopRun: (() => void) | null = null;

    const start = (): void => {
      if (stopRun || posters.length === 0) return;
      const run = new AbortController();
      const listen = { passive: true, signal: run.signal } as const;
      const restores = posters.map((poster) => snapshotAttributes(poster, ['style']));
      const clones: HTMLElement[] = [];
      if (options.loop) {
        for (const poster of posters) {
          const copy = poster.cloneNode(true) as HTMLElement;
          copy.classList.add(CLONE);
          copy.setAttribute('aria-hidden', 'true');
          copy.setAttribute('inert', '');
          copy.removeAttribute('id');
          for (const child of Array.from(copy.querySelectorAll('[id]'))) child.removeAttribute('id');
          el.append(copy);
          clones.push(copy);
        }
      }
      const all = [...posters, ...clones];
      el.classList.add(LIVE);

      const hasRaf = typeof requestAnimationFrame === 'function';
      let raf = 0;
      let visible = true;
      let hovered = false;
      let holdUntil = 0;
      let pos = el.scrollTop;
      let last = el.scrollTop;
      let lastTime = 0;
      let vel = 0;

      const paint = (): void => {
        const h = el.clientHeight;
        const top = el.scrollTop;
        for (const poster of all) {
          const half = poster.offsetHeight / 2;
          const d = h ? clamp((poster.offsetTop + half - top - h / 2) / (h / 2 + half), -1, 1) : 0;
          poster.style.setProperty(`--${PREFIX}-d`, d.toFixed(3));
          poster.style.setProperty(`--${PREFIX}-a`, Math.abs(d).toFixed(3));
        }
        const v = clamp(vel * 0.6, -1, 1);
        setVars(el, PREFIX, { v: v.toFixed(3), va: Math.abs(v).toFixed(3) });
      };

      const autoplay = (): boolean => options.speed > 0 && !(options.pauseOnHover && hovered) && now() >= holdUntil
        && (options.loop || el.scrollTop + el.clientHeight < el.scrollHeight - 1);

      const tick = (time: number): void => {
        raf = 0;
        const dt = lastTime ? Math.min(64, time - lastTime) : 16;
        lastTime = time;
        if (Math.abs(el.scrollTop - Math.round(pos)) > 1) pos = el.scrollTop; // the reader scrolled
        if (autoplay()) {
          pos += (options.speed * dt) / 1000;
          el.scrollTop = pos;
        }
        const span = clones[0] && posters[0] ? clones[0].offsetTop - posters[0].offsetTop : 0;
        let shift = 0;
        if (span > 0 && el.scrollTop >= span) {
          shift = span;
          pos -= span;
          el.scrollTop = pos;
        }
        const raw = (el.scrollTop + shift - last) / dt;
        last = el.scrollTop;
        vel += (raw - vel) * 0.12;
        paint();
        if (autoplay() || Math.abs(vel) > 0.002) wake();
        else { vel = 0; lastTime = 0; paint(); }
      };

      function wake(): void {
        if (raf || !visible || run.signal.aborted) return;
        if (hasRaf) raf = requestAnimationFrame(tick);
      }

      const halt = (): void => {
        if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
        raf = 0;
        lastTime = 0;
      };

      el.addEventListener('scroll', wake, listen);
      el.addEventListener('pointerenter', (event) => { if (event.pointerType === 'mouse') hovered = true; }, listen);
      el.addEventListener('pointerleave', () => { hovered = false; wake(); }, listen);
      el.addEventListener('focusin', () => { hovered = true; }, listen);
      el.addEventListener('focusout', () => { hovered = false; wake(); }, listen);
      el.addEventListener('pointerdown', () => { holdUntil = now() + 2500; }, listen);
      el.addEventListener('touchend', () => { holdUntil = now() + 2500; setTimeout(wake, 2600); }, listen);
      el.addEventListener('wheel', () => { holdUntil = now() + 1500; setTimeout(wake, 1600); }, listen);

      let io: IntersectionObserver | null = null;
      if (typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver(([entry]) => {
          visible = !!entry?.isIntersecting;
          if (visible) wake();
          else halt();
        });
        io.observe(el);
      }

      paint();
      wake();

      stopRun = (): void => {
        stopRun = null;
        run.abort();
        io?.disconnect();
        halt();
        for (const copy of clones) copy.remove();
        for (const restore of restores) restore();
        el.classList.remove(LIVE);
        el.style.removeProperty(`--${PREFIX}-v`);
        el.style.removeProperty(`--${PREFIX}-va`);
      };
    };

    const stop = (): void => { stopRun?.(); };
    const apply = (reduced: boolean): void => {
      el.classList.toggle(REDUCED, reduced);
      if (reduced) stop();
      else start();
    };
    const motion = watchReducedMotion(signal, apply);
    onDestroy(stop);
    apply(motion.reduced);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
