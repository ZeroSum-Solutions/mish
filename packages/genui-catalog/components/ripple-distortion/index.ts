/**
 * ripple-distortion — clean-room implementation from component-specs.md §12 only. A water-ripple
 * displacement spreads over an image from the pointer. No WebGL (the upstream uses `ogl`, which
 * `catalog-design.md` §0 flags as a browser dependency this catalog cannot ship): this version
 * drives an animated SVG filter instead. A pointer move (or click, with `trigger:"click"`) starts
 * a ripple — `feTurbulence` `baseFrequency` and the `feDisplacementMap` `scale` swell and then
 * damp over `duration` — masked to a circle centred on the pointer so the ripple reads as local.
 * Idle state is the still original image; nothing loops unless `ambient` is set, and then only
 * while the host is in view.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-ripple-distortion` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. `mount` requires a
 * `.genui-ripple-distortion__media` child (the DOM contract in the spec); without one it mounts
 * but drives nothing, since there is nothing to duplicate or filter.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'ripple-distortion';
const PREFIX = `genui-${id}`;
const MEDIA_CLASS = `${PREFIX}__media`;
const WARP_CLASS = `${PREFIX}__warp`;

export interface RippleDistortionOptions {
  [key: string]: string | number | boolean;
  strength: number;
  /** Ripple lifetime, in ms. */
  duration: number;
  frequency: number;
  /** Mask radius, in px. */
  radius: number;
  trigger: 'move' | 'click';
  /** Minimum time between ripples, in ms. */
  throttle: number;
  /** A very slow, low-amplitude shimmer while the host is in view. */
  ambient: boolean;
}

export const defaults: RippleDistortionOptions = {
  strength: 24,
  duration: 1400,
  frequency: 0.02,
  radius: 220,
  trigger: 'move',
  throttle: 120,
  ambient: false,
};

let uid = 0;

export function mount(el: HTMLElement, opts: Partial<RippleDistortionOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, { r: `${Math.max(0, options.radius)}px`, x: '50%', y: '50%' });

    const media = el.querySelector<HTMLElement>(`.${MEDIA_CLASS}`);
    const motion = watchReducedMotion(signal);
    if (!media || motion.reduced) return; // reduced motion (or no media to warp): static image only.

    const filterId = `${PREFIX}-filter-${(uid += 1)}`;
    const warp = media.cloneNode(true) as HTMLElement;
    warp.classList.add(WARP_CLASS);
    warp.setAttribute('aria-hidden', 'true');
    warp.removeAttribute('id');
    warp.style.filter = `url(#${filterId})`;
    el.append(warp);
    onDestroy(() => { warp.remove(); });

    const svgNs = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNs, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden';
    const filter = document.createElementNS(svgNs, 'filter');
    filter.setAttribute('id', filterId);
    const turbulence = document.createElementNS(svgNs, 'feTurbulence');
    turbulence.setAttribute('type', 'fractalNoise');
    turbulence.setAttribute('baseFrequency', String(options.frequency));
    turbulence.setAttribute('numOctaves', '2');
    turbulence.setAttribute('seed', '2');
    turbulence.setAttribute('result', 'genui-noise');
    const displace = document.createElementNS(svgNs, 'feDisplacementMap');
    displace.setAttribute('in', 'SourceGraphic');
    displace.setAttribute('in2', 'genui-noise');
    displace.setAttribute('scale', '0');
    displace.setAttribute('xChannelSelector', 'R');
    displace.setAttribute('yChannelSelector', 'G');
    filter.append(turbulence, displace);
    svg.append(filter);
    el.append(svg);
    onDestroy(() => { svg.remove(); });

    const hasRaf = typeof requestAnimationFrame === 'function';
    let rippleRaf = 0;
    let rippleStart = 0;
    let lastRippleAt = -Infinity;

    const rippleTick = (now: number): void => {
      const elapsed = now - rippleStart;
      const progress = Math.min(1, options.duration <= 0 ? 1 : elapsed / options.duration);
      const amplitude = Math.sin(progress * Math.PI); // swell then damp, 0 -> 1 -> 0
      turbulence.setAttribute('baseFrequency', String(Math.max(0, options.frequency) * (0.6 + amplitude * 0.8)));
      displace.setAttribute('scale', String(Math.max(0, options.strength) * amplitude));
      if (progress < 1 && hasRaf) {
        rippleRaf = requestAnimationFrame(rippleTick);
      } else {
        displace.setAttribute('scale', '0');
        rippleRaf = 0;
      }
    };

    const startRipple = (clientX: number, clientY: number): void => {
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      if (now - lastRippleAt < Math.max(0, options.throttle)) return;
      lastRippleAt = now;
      const rect = el.getBoundingClientRect();
      const px = rect.width ? ((clientX - rect.left) / rect.width) * 100 : 50;
      const py = rect.height ? ((clientY - rect.top) / rect.height) * 100 : 50;
      setVars(el, PREFIX, { x: `${px}%`, y: `${py}%` });
      if (rippleRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rippleRaf);
      rippleStart = now;
      if (hasRaf) rippleRaf = requestAnimationFrame(rippleTick);
      else rippleTick(now + options.duration); // no rAF: jump straight to the settled end state.
    };

    const listenerOpts = { passive: true, signal } as const;
    if (options.trigger === 'click') {
      el.addEventListener('click', (event) => { startRipple(event.clientX, event.clientY); }, listenerOpts);
    } else {
      el.addEventListener('pointermove', (event) => { startRipple(event.clientX, event.clientY); }, listenerOpts);
    }

    onDestroy(() => {
      if (rippleRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rippleRaf);
      rippleRaf = 0;
    });

    // Ambient shimmer: a slow, low-amplitude loop gated by IntersectionObserver, and only while
    // no pointer-driven ripple is currently running (rippleRaf is 0 between ripples).
    if (options.ambient && typeof IntersectionObserver === 'function') {
      let ambientRaf = 0;
      const ambientTick = (now: number): void => {
        if (!rippleRaf) {
          const amplitude = (Math.sin(now / 3000) + 1) / 2 * 0.15;
          turbulence.setAttribute('baseFrequency', String(Math.max(0, options.frequency)));
          displace.setAttribute('scale', String(Math.max(0, options.strength) * amplitude));
        }
        ambientRaf = requestAnimationFrame(ambientTick);
      };
      const io = new IntersectionObserver(([entry]) => {
        if (entry?.isIntersecting) {
          if (!ambientRaf && hasRaf) ambientRaf = requestAnimationFrame(ambientTick);
        } else if (ambientRaf) {
          if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(ambientRaf);
          ambientRaf = 0;
        }
      }, { threshold: 0.1 });
      io.observe(el);
      onDestroy(() => {
        io.disconnect();
        if (ambientRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(ambientRaf);
        ambientRaf = 0;
      });
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
