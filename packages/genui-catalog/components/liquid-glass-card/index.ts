/**
 * liquid-glass-card — clean-room implementation from component-specs.md §3 only. A card that
 * reads as thick glass: whatever sits behind the host is refracted through an SVG
 * `feTurbulence` → `feGaussianBlur` → `feDisplacementMap` filter chain applied to a backdrop
 * layer, and a specular highlight follows the pointer on top. At idle the refraction drifts very
 * slowly (the `feTurbulence` `baseFrequency` breathes over `idlePeriod`); on hover or focus the
 * displacement scale eases up to `hoverScale`, then back to `scale` on leave/blur. The idle drift
 * runs only while the card intersects the viewport.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-liquid-glass-card` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` unwraps the injected lens/shine/defs and restores `el.outerHTML`
 * exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'liquid-glass-card';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const NO_SPECULAR_CLASS = `${PREFIX}--no-specular`;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** Fixed smoothing applied to the turbulence noise before it drives the displacement. */
const NOISE_SMOOTHING = 3;

let uid = 0;

export interface LiquidGlassCardOptions {
  [key: string]: string | number | boolean;
  /** Backdrop blur radius, in px. */
  blur: number;
  /** Resting `feDisplacementMap` scale. */
  scale: number;
  /** `feDisplacementMap` scale while hovered or focused. */
  hoverScale: number;
  /** `feTurbulence` `baseFrequency`. */
  frequency: number;
  octaves: number;
  /** Idle drift period, in ms; 0 turns the drift off. */
  idlePeriod: number;
  tint: string;
  /** Corner radius, in px. */
  radius: number;
  /** Show the pointer-following specular highlight. */
  specular: boolean;
}

export const defaults: LiquidGlassCardOptions = {
  blur: 6,
  scale: 18,
  hoverScale: 32,
  frequency: 0.012,
  octaves: 2,
  idlePeriod: 8000,
  tint: 'rgba(255,255,255,.12)',
  radius: 24,
  specular: true,
};

/** The custom properties `mount` writes for a set of options (excluding the live -x/-y). */
export function toVars(options: LiquidGlassCardOptions): Record<string, string> {
  return {
    blur: `${Math.max(0, options.blur)}px`,
    tint: options.tint,
    radius: `${Math.max(0, options.radius)}px`,
  };
}

export function mount(el: HTMLElement, opts: Partial<LiquidGlassCardOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(NO_SPECULAR_CLASS, !options.specular);

    // Wrap the existing children in __content, then prepend the defs, lens and shine layers.
    // __content stays last in DOM order so it paints above the decorative layers.
    const originalChildren = Array.from(el.childNodes);
    const contentEl = document.createElement('div');
    contentEl.className = `${PREFIX}__content`;
    for (const node of originalChildren) contentEl.append(node);

    uid += 1;
    const filterId = `${PREFIX}-filter-${uid}`;
    const defsEl = document.createElementNS(SVG_NS, 'svg');
    defsEl.setAttribute('class', `${PREFIX}__defs`);
    defsEl.setAttribute('aria-hidden', 'true');
    defsEl.setAttribute('focusable', 'false');
    defsEl.innerHTML = `<filter id="${filterId}" x="-20%" y="-20%" width="140%" height="140%" color-interpolation-filters="sRGB">`
      + `<feTurbulence type="fractalNoise" baseFrequency="${Math.max(0.001, options.frequency)}" numOctaves="${Math.max(1, Math.round(options.octaves))}" seed="11" result="n"/>`
      + `<feGaussianBlur in="n" stdDeviation="${NOISE_SMOOTHING}" result="s"/>`
      + `<feDisplacementMap in="SourceGraphic" in2="s" scale="${options.scale}" xChannelSelector="R" yChannelSelector="G"/>`
      + '</filter>';
    const turbulence = defsEl.querySelector('feTurbulence')!;
    const displacement = defsEl.querySelector('feDisplacementMap')!;

    const lensEl = document.createElement('div');
    lensEl.className = `${PREFIX}__lens`;
    lensEl.setAttribute('aria-hidden', 'true');
    const backdrop = `url(#${filterId}) blur(var(--${PREFIX}-blur))`;
    lensEl.style.setProperty('backdrop-filter', backdrop);
    lensEl.style.setProperty('-webkit-backdrop-filter', backdrop);

    const shineEl = document.createElement('div');
    shineEl.className = `${PREFIX}__shine`;
    shineEl.setAttribute('aria-hidden', 'true');

    el.append(defsEl, lensEl, shineEl, contentEl);
    onDestroy(() => {
      const kids = Array.from(contentEl.childNodes);
      contentEl.remove();
      shineEl.remove();
      lensEl.remove();
      defsEl.remove();
      el.append(...kids);
    });

    const setScale = (value: number): void => { displacement.setAttribute('scale', String(value)); };
    setScale(options.scale);

    let reduced = false;
    let intersecting = true;
    let raf = 0;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const stopDrift = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };
    function driftTick(time: number): void {
      raf = 0;
      if (reduced || !intersecting || options.idlePeriod <= 0) return;
      const phase = (time % options.idlePeriod) / options.idlePeriod;
      const wave = Math.sin(phase * Math.PI * 2);
      const base = Math.max(0.001, options.frequency + wave * options.frequency * 0.3);
      turbulence.setAttribute('baseFrequency', base.toFixed(4));
      scheduleDrift();
    }
    function scheduleDrift(): void {
      if (!hasRaf || reduced || !intersecting || options.idlePeriod <= 0) return;
      if (!raf) raf = requestAnimationFrame(driftTick);
    }

    /** No idle loop, no scale change: fixed scale and a centred, static shine. */
    const applyReducedState = (): void => {
      stopDrift();
      setScale(options.scale);
      turbulence.setAttribute('baseFrequency', String(Math.max(0.001, options.frequency)));
      el.style.setProperty(`--${PREFIX}-x`, '50%');
      el.style.setProperty(`--${PREFIX}-y`, '50%');
    };

    const motion = watchReducedMotion(signal, (isReduced) => {
      reduced = isReduced;
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) applyReducedState();
      else { setScale(options.scale); scheduleDrift(); }
    });
    reduced = motion.reduced;
    el.classList.toggle(REDUCED_CLASS, reduced);

    if (reduced) {
      applyReducedState();
    } else {
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) {
            if (entry.target !== el) continue;
            intersecting = entry.isIntersecting;
            if (intersecting) scheduleDrift(); else stopDrift();
          }
        });
        io.observe(el);
        signal.addEventListener('abort', () => io.disconnect(), { once: true });
      }
      scheduleDrift();

      // A light, undamped pointer follow (component-specs.md note 3, without the lerp: the spec
      // only asks that the handler write -x/-y). Coalesced to one write per animation frame.
      let px = 50;
      let py = 50;
      let pointerRaf = 0;
      const writePointer = (): void => {
        pointerRaf = 0;
        el.style.setProperty(`--${PREFIX}-x`, `${px}%`);
        el.style.setProperty(`--${PREFIX}-y`, `${py}%`);
      };
      const schedulePointer = (): void => {
        if (!hasRaf) { writePointer(); return; }
        if (!pointerRaf) pointerRaf = requestAnimationFrame(writePointer);
      };
      const listenerOpts = { passive: true, signal } as const;
      el.addEventListener('pointermove', (event) => {
        if (reduced || event.pointerType === 'touch') return;
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        px = ((event.clientX - rect.left) / rect.width) * 100;
        py = ((event.clientY - rect.top) / rect.height) * 100;
        schedulePointer();
      }, listenerOpts);
      el.addEventListener('pointerenter', () => { if (!reduced) setScale(options.hoverScale); }, listenerOpts);
      el.addEventListener('pointerleave', () => { if (!reduced) setScale(options.scale); }, listenerOpts);
      // Keyboard parity: focus centres the shine and swells the displacement like a hover.
      el.addEventListener('focusin', () => {
        if (reduced) return;
        px = 50; py = 50;
        schedulePointer();
        setScale(options.hoverScale);
      }, listenerOpts);
      el.addEventListener('focusout', () => { if (!reduced) setScale(options.scale); }, listenerOpts);

      onDestroy(() => {
        if (pointerRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(pointerRaf);
      });
    }

    signal.addEventListener('abort', stopDrift, { once: true });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
