/**
 * grainient — clean-room implementation from the effect description ("Grainy gradient - safe base
 * layer") only. A calm background: three soft radial blobs on a base colour drift slowly in CSS
 * (`::before`, one `@keyframes`), and a film-grain texture sits over them. The grain is a 2D canvas
 * filled with monochrome noise once per size (no rAF loop), drawn at 1/`grainSize` resolution and
 * upscaled pixelated, blended with `overlay`. When no 2D context exists the canvas is skipped and
 * the plain CSS gradient remains. The drift pauses while the host is off-screen and stops under
 * reduced motion.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-grainient` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'grainient';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const STILL_CLASS = `${PREFIX}--still`;
const PAUSED_CLASS = `${PREFIX}--paused`;
/** Longest canvas side, in canvas pixels, so a huge host never allocates a huge buffer. */
const MAX_SIDE = 1024;

export interface GrainientOptions {
  [key: string]: string | number | boolean;
  colorA: string;
  colorB: string;
  colorC: string;
  base: string;
  /** Opacity of the gradient layer over the base. */
  intensity: number;
  /** Seconds per drift pass (the drift alternates). */
  speed: number;
  /** Opacity of the grain layer; 0 skips the canvas. */
  grain: number;
  /** Size of one grain speck, in CSS px. */
  grainSize: number;
  /** Let the gradient drift slowly; false keeps it still. */
  animate: boolean;
}

export const defaults: GrainientOptions = {
  colorA: '#6d5dfc',
  colorB: '#ff7a59',
  colorC: '#22c1c3',
  base: '#0b0d12',
  intensity: 0.85,
  speed: 18,
  grain: 0.22,
  grainSize: 1.5,
  animate: true,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: GrainientOptions): Record<string, string> {
  return {
    a: options.colorA,
    b: options.colorB,
    c: options.colorC,
    base: options.base,
    intensity: String(clamp(options.intensity, 0, 1)),
    speed: `${Math.max(1, options.speed)}s`,
    grain: String(clamp(options.grain, 0, 1)),
  };
}

/** Fill `ctx` with monochrome noise at its canvas size. */
function paintNoise(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const image = ctx.createImageData(w, h);
  const data = image.data;
  for (let i = 0; i < data.length; i += 4) {
    const v = (Math.random() * 256) | 0;
    data[i] = v;
    data[i + 1] = v;
    data[i + 2] = v;
    data[i + 3] = 255;
  }
  ctx.putImageData(image, 0, 0);
}

export function mount(el: HTMLElement, opts: Partial<GrainientOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(STILL_CLASS, !options.animate);

    // CSS drives the drift; the class mirrors the preference for hosts that force reduced motion
    // (the demo toggle) and follows live changes.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    // Pause the CSS drift while the host is off-screen.
    if (options.animate && typeof IntersectionObserver === 'function') {
      const io = new IntersectionObserver((entries) => {
        const entry = entries[entries.length - 1];
        if (entry) el.classList.toggle(PAUSED_CLASS, !entry.isIntersecting);
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }

    const grain = clamp(options.grain, 0, 1);
    if (grain <= 0) return;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return; // no 2D canvas: the CSS gradient alone is the fallback.
    canvas.className = `${PREFIX}__grain`;
    canvas.setAttribute('aria-hidden', 'true');
    el.prepend(canvas);
    onDestroy(() => { canvas.remove(); });

    const size = clamp(options.grainSize, 1, 6);
    const draw = (): void => {
      const rect = el.getBoundingClientRect();
      const w = clamp(Math.ceil((rect.width || 320) / size), 1, MAX_SIDE);
      const h = clamp(Math.ceil((rect.height || 200) / size), 1, MAX_SIDE);
      if (canvas.width === w && canvas.height === h) return;
      canvas.width = w;
      canvas.height = h;
      paintNoise(ctx, w, h);
    };
    draw();

    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { draw(); });
      ro.observe(el);
      onDestroy(() => { ro.disconnect(); });
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
