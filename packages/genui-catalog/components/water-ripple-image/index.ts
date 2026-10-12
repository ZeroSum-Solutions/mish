/**
 * water-ripple-image — clean-room implementation from the effect description only ("Water ripples
 * over any image": click-driven concentric ripple rings with refraction). A click drops a stone on
 * the `.genui-water-ripple-image__media` child: `rings` concentric rings spread out from the click
 * point, `spacing` ms apart, and fade over `duration` ms. Each ring is an `aria-hidden`, `inert`
 * clone of the media masked to a thin annulus and scaled about the drop point, so the picture
 * inside the band is magnified (a crest) or shrunk (a trough, every other ring) — a refraction
 * read without WebGL. Crests brighten and troughs darken by `glint`. `autoDrip` > 0 drops one at
 * a random spot every that many ms while the host is on screen.
 *
 * No WebGL: the description's hint is WebGL, but the catalog ships no dependencies and a shader
 * would need the image as a texture, which the demo CSP (no images) cannot provide; masked clones
 * work on any media — an <img>, an inline <svg> or a gradient <div>.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-water-ripple-image` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. The rAF loop runs only while a ring is
 * alive (or `autoDrip` is on), the host is on screen and motion is allowed.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'water-ripple-image';
const PREFIX = `genui-${id}`;
const MEDIA_CLASS = `${PREFIX}__media`;
const RING_CLASS = `${PREFIX}__ring`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface WaterRippleImageOptions {
  [key: string]: string | number | boolean;
  /** Radius a ring reaches by the end of its life, in px. */
  radius: number;
  /** Lifetime of one ring, in ms. */
  duration: number;
  /** Concentric rings per drop, 1–6. */
  rings: number;
  /** Delay between the rings of one drop, in ms. */
  spacing: number;
  /** Peak refraction: how far a crest magnifies (and a trough shrinks) the image, 0–0.3. */
  strength: number;
  /** Half-width of a ring band, in px. */
  band: number;
  /** How much a crest brightens and a trough darkens, 0–1. */
  glint: number;
  /** Drops alive at once; the oldest is cleared first. */
  maxDrops: number;
  /** Drop at a random spot every this many ms while on screen; 0 turns it off. */
  autoDrip: number;
}

export const defaults: WaterRippleImageOptions = {
  radius: 240,
  duration: 1800,
  rings: 3,
  spacing: 160,
  strength: 0.05,
  band: 16,
  glint: 0.2,
  maxDrops: 4,
  autoDrip: 0,
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

/** The custom properties `mount` writes on the host for a set of options. */
export function toVars(options: WaterRippleImageOptions): Record<string, string> {
  return {
    band: `${clamp(options.band, 1, 200)}px`,
    strength: String(clamp(options.strength, 0, 0.3)),
    glint: String(clamp(options.glint, 0, 1)),
  };
}

interface Ring { node: HTMLElement; drop: number; delay: number; t: number; sign: number }

export function mount(el: HTMLElement, opts: Partial<WaterRippleImageOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    const media = el.querySelector<HTMLElement>(`.${MEDIA_CLASS}`);
    const hasRaf = typeof requestAnimationFrame === 'function';
    const duration = Math.max(1, options.duration);
    const radius = Math.max(1, options.radius);
    const count = clamp(Math.round(options.rings), 1, 6);
    const maxDrops = Math.max(1, Math.round(options.maxDrops));
    const spacing = Math.max(0, options.spacing);
    let rings: Ring[] = [];
    let reduced = false;
    let visible = true;
    let raf = 0;
    let last = 0;
    let since = options.autoDrip * 0.6;
    let drops = 0;

    const stop = (): void => {
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      last = 0;
    };
    const drop = (keep: (ring: Ring) => boolean): void => {
      rings = rings.filter((ring) => keep(ring) || (ring.node.remove(), false));
    };
    const running = (): boolean => !!media && hasRaf && visible && !reduced && (rings.length > 0 || options.autoDrip > 0);
    const sync = (): void => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) drop(() => false);
      if (running()) { if (!raf) raf = requestAnimationFrame(tick); } else stop();
    };

    /** Start one drop at (x, y), in px from the media's top-left corner. */
    const spawn = (x: number, y: number): void => {
      if (!media || reduced || !hasRaf) return;
      const live = [...new Set(rings.map((ring) => ring.drop))];
      while (live.length >= maxDrops) { const oldest = live.shift(); drop((ring) => ring.drop !== oldest); }
      drops += 1;
      for (let i = 0; i < count; i += 1) {
        const node = media.cloneNode(true) as HTMLElement;
        node.classList.add(RING_CLASS);
        node.setAttribute('aria-hidden', 'true');
        node.setAttribute('inert', '');
        node.removeAttribute('id');
        node.querySelectorAll('[id]').forEach((child) => { child.removeAttribute('id'); });
        Object.assign(node.style, {
          top: `${media.offsetTop}px`, left: `${media.offsetLeft}px`,
          width: `${media.offsetWidth}px`, height: `${media.offsetHeight}px`,
        });
        setVars(node, PREFIX, { x: `${x}px`, y: `${y}px`, r: '0px', k: 1, g: 0, o: 0 });
        (rings.at(-1)?.node ?? media).after(node);
        rings.push({ node, drop: drops, delay: i * spacing, t: 0, sign: i % 2 ? -1 : 1 });
      }
      sync();
    };

    function tick(now: number): void {
      raf = 0;
      const dt = last ? Math.min(64, now - last) : 16;
      last = now;
      if (media && options.autoDrip > 0 && (since += dt) >= options.autoDrip) {
        since = 0;
        spawn(media.offsetWidth * (0.2 + Math.random() * 0.6), media.offsetHeight * (0.25 + Math.random() * 0.5));
      }
      drop((ring) => {
        ring.t += dt;
        const p = (ring.t - ring.delay) / duration;
        if (p >= 1) return false;
        if (p < 0) return true;
        const amp = (1 - p) ** 1.6;
        setVars(ring.node, PREFIX, {
          r: `${(radius * (1 - (1 - p) ** 3)).toFixed(1)}px`,
          k: (0.6 + 1.4 * p).toFixed(3),
          g: (ring.sign * amp).toFixed(3),
          o: (Math.min(1, p * 8) * amp).toFixed(3),
        });
        return true;
      });
      if (running() && !raf) raf = requestAnimationFrame(tick);
      else if (!raf) last = 0;
    }

    const motion = watchReducedMotion(signal, (value) => { reduced = value; sync(); });
    reduced = motion.reduced;
    onDestroy(() => { stop(); drop(() => false); });

    if (media) {
      el.addEventListener('click', (event) => {
        const rect = media.getBoundingClientRect();
        spawn(event.clientX - rect.left, event.clientY - rect.top);
      }, { passive: true, signal });
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver(([entry]) => { visible = !!entry?.isIntersecting; sync(); });
        io.observe(el);
        onDestroy(() => { io.disconnect(); });
      }
    }
    sync();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
