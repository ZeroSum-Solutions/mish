/**
 * model-viewer — clean-room implementation from the effect description ("3D model viewer, 360
 * product rotation") only. No three.js and no external assets: the model is CSS 3D. When the
 * host holds no `.genui-model-viewer__model` child, `mount` builds a procedural product (an
 * N-sided faceted cylinder with a lid, label band and caps, shaded per facet with CSS `cos()`
 * against a fixed light). An author may instead supply their own inline SVG or CSS 3D markup as
 * a `.genui-model-viewer__model` child; it is rotated as-is and never duplicated.
 *
 * Motion: a slow auto-rotation driven by one rAF loop that writes `--genui-model-viewer-ry`. The
 * loop runs only while the host is on screen (IntersectionObserver), pauses while the viewer
 * drags, resumes after `resumeDelay` ms, and stops on destroy. Drag (pointer) spins the model
 * with a little inertia; with `interactive`, the host is focusable and the arrow keys rotate it
 * in 15deg steps (Home resets). Reduced motion: no auto-rotation, no inertia and no float; the
 * model rests at a three-quarter view and moves only when the user drags or presses a key.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-model-viewer` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` removes every generated node and restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'model-viewer';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const DRAG_CLASS = `${PREFIX}--dragging`;
const MODEL_CLASS = `${PREFIX}__model`;
/** Resting yaw under reduced motion and after Home: a three-quarter product view. */
const REST_YAW = -30;
const KEY_STEP = 15;
const MAX_TILT = 40;

export interface ModelViewerOptions {
  [key: string]: string | number | boolean;
  /** Auto-rotation speed, in degrees per second. */
  speed: number;
  autoRotate: boolean;
  /** Camera tilt (rotateX), in degrees; negative looks down on the model. */
  tilt: number;
  /** Facets of the procedural model (6 to 48). */
  sides: number;
  /** Diameter of the procedural model, in px. */
  size: number;
  /** Height of the procedural model, in px. */
  height: number;
  colour: string;
  accent: string;
  /** Drag to spin, and arrow keys when focused. */
  interactive: boolean;
  /** Idle time after a drag or key press before auto-rotation resumes, in ms. */
  resumeDelay: number;
}

export const defaults: ModelViewerOptions = {
  speed: 24,
  autoRotate: true,
  tilt: -14,
  sides: 24,
  size: 96,
  height: 150,
  colour: '#3b4a6b',
  accent: '#d9dfef',
  interactive: true,
  resumeDelay: 1600,
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** The static custom properties `mount` writes for a set of options. */
export function toVars(options: ModelViewerOptions): Record<string, string> {
  const sides = clamp(Math.round(options.sides), 6, 48);
  const size = Math.max(8, options.size);
  const r = size / 2;
  return {
    r: `${r}px`,
    w: `${(2 * r * Math.tan(Math.PI / sides) + 1).toFixed(2)}px`,
    h: `${Math.max(8, options.height)}px`,
    size: `${size}px`,
    colour: options.colour,
    accent: options.accent,
    rx: `${clamp(options.tilt, -MAX_TILT, MAX_TILT)}deg`,
  };
}

function node(cls: string, parent: Element): HTMLDivElement {
  const div = document.createElement('div');
  div.className = cls.split(' ').map((c) => `${PREFIX}__${c}`).join(' ');
  parent.append(div);
  return div;
}

/** Build the procedural faceted product. */
function buildModel(sides: number): HTMLDivElement {
  const model = document.createElement('div');
  model.className = MODEL_CLASS;
  model.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < sides; i += 1) {
    node('face', model).style.setProperty(`--${PREFIX}-a`, `${((360 / sides) * i).toFixed(3)}deg`);
  }
  node('cap', model);
  node('cap cap--bottom', model);
  return model;
}

export function mount(el: HTMLElement, opts: Partial<ModelViewerOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    if (!el.querySelector(`:scope > .${MODEL_CLASS}`)) {
      const model = buildModel(clamp(Math.round(options.sides), 6, 48));
      el.append(model);
      onDestroy(() => { model.remove(); });
    }
    const shadow = node('shadow', el);
    shadow.setAttribute('aria-hidden', 'true');
    onDestroy(() => { shadow.remove(); });

    let yaw = REST_YAW;
    let pitch = clamp(options.tilt, -MAX_TILT, MAX_TILT);
    let vel = 0;
    let dragging = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let idleUntil = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

    const write = (): void => {
      setVars(el, PREFIX, { ry: `${(yaw % 360).toFixed(2)}deg`, rx: `${pitch.toFixed(2)}deg` });
    };
    const spinning = (): boolean => options.autoRotate && !motion.reduced && options.speed !== 0;
    const tick = (t: number): void => {
      raf = 0;
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      last = t;
      if (!dragging) {
        if (Math.abs(vel) > 2) {
          yaw += vel * dt;
          vel *= Math.pow(0.04, dt);
        } else {
          vel = 0;
          if (spinning() && t >= idleUntil) yaw += options.speed * dt;
        }
        write();
      }
      schedule();
    };
    const schedule = (): void => {
      if (raf || !hasRaf || !visible || dragging || (!spinning() && vel === 0)) { if (!raf) last = 0; return; }
      raf = requestAnimationFrame(tick);
    };
    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    onDestroy(stop);

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) { vel = 0; stop(); } else schedule();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    write();

    if (typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver(([entry]) => {
        visible = entry?.isIntersecting ?? true;
        if (visible) schedule(); else stop();
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }

    if (options.interactive) {
      if (!el.hasAttribute('tabindex')) el.tabIndex = 0;
      let px = 0; let py = 0; let pt = 0;
      const end = (): void => {
        if (!dragging) return;
        dragging = false;
        el.classList.remove(DRAG_CLASS);
        if (motion.reduced) vel = 0;
        idleUntil = now() + Math.max(0, options.resumeDelay);
        schedule();
      };
      el.addEventListener('pointerdown', (event) => {
        if (event.button !== 0) return;
        dragging = true;
        vel = 0;
        px = event.clientX; py = event.clientY; pt = now();
        el.classList.add(DRAG_CLASS);
        stop();
        try { el.setPointerCapture(event.pointerId); } catch { /* synthetic events have no capture */ }
      }, { signal });
      el.addEventListener('pointermove', (event) => {
        if (!dragging) return;
        const t = now();
        const dx = (event.clientX - px) * 0.6;
        yaw += dx;
        pitch = clamp(pitch - (event.clientY - py) * 0.3, -MAX_TILT, MAX_TILT);
        if (t > pt) vel = vel * 0.5 + (dx / (t - pt)) * 500;
        px = event.clientX; py = event.clientY; pt = t;
        write();
      }, { signal });
      el.addEventListener('pointerup', end, { signal });
      el.addEventListener('pointercancel', end, { signal });
      el.addEventListener('lostpointercapture', end, { signal });
      el.addEventListener('keydown', (event) => {
        const k = event.key;
        if (k === 'ArrowLeft') yaw -= KEY_STEP;
        else if (k === 'ArrowRight') yaw += KEY_STEP;
        else if (k === 'ArrowUp') pitch = clamp(pitch - 5, -MAX_TILT, MAX_TILT);
        else if (k === 'ArrowDown') pitch = clamp(pitch + 5, -MAX_TILT, MAX_TILT);
        else if (k === 'Home') { yaw = REST_YAW; pitch = clamp(options.tilt, -MAX_TILT, MAX_TILT); }
        else return;
        event.preventDefault();
        vel = 0;
        idleUntil = now() + Math.max(0, options.resumeDelay);
        write();
      }, { signal });
    }

    schedule();
  }, ['tabindex']);
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
