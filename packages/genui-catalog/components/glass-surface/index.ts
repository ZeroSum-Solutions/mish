/**
 * glass-surface — clean-room implementation from component-specs.md §2 only. A static frosted-glass
 * panel: `backdrop-filter` blurs and brightens whatever sits behind the host, a `color-mix` tint
 * sets the glass colour, and an inset rim marks the edge. Nothing moves at idle; hovering (or
 * focusing inside the host) brightens the rim through a 200ms transition. It is `kind: css-only`:
 * the class plus the `--genui-glass-surface-*` custom properties are the whole effect, so it also
 * works in a page that runs no script.
 *
 * The optional `displace` option adds a subtle edge warp through an SVG `feTurbulence` +
 * `feDisplacementMap` filter. That part needs JS, so `mount` injects the filter only when
 * `displace > 0`; with `displace: 0` (the default) the css-only path stays a clean blur and no
 * node is created.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-glass-surface` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'glass-surface';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const DISPLACED_CLASS = `${PREFIX}--displaced`;
const DEFS_CLASS = `${PREFIX}__defs`;
const SVG_NS = 'http://www.w3.org/2000/svg';

/** The `feDisplacementMap` scale is capped here (component-specs.md: "0–30"). */
const MAX_DISPLACE = 30;

let uid = 0;

export interface GlassSurfaceOptions {
  [key: string]: string | number | boolean;
  /** Backdrop blur radius, in px. */
  blur: number;
  brightness: number;
  saturate: number;
  /** Tint alpha (0–1). */
  opacity: number;
  tint: string;
  /** Corner radius, in px. */
  radius: number;
  /** Alpha of the edge rim (0–1). */
  borderAlpha: number;
  /** 0 turns the edge warp off; otherwise the `feDisplacementMap` scale, 0–30. */
  displace: number;
}

export const defaults: GlassSurfaceOptions = {
  blur: 12,
  brightness: 1.1,
  saturate: 1.4,
  opacity: 0.18,
  tint: '#ffffff',
  radius: 20,
  borderAlpha: 0.35,
  displace: 0,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: GlassSurfaceOptions): Record<string, string> {
  return {
    blur: `${Math.max(0, options.blur)}px`,
    brightness: String(options.brightness),
    saturate: String(options.saturate),
    opacity: String(Math.min(1, Math.max(0, options.opacity))),
    tint: options.tint,
    radius: `${Math.max(0, options.radius)}px`,
    'border-alpha': String(Math.min(1, Math.max(0, options.borderAlpha))),
  };
}

/** A hidden `<svg>` holding one `feTurbulence` + `feDisplacementMap` filter, id'd uniquely. */
function buildDefs(filterId: string, scale: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', DEFS_CLASS);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const filter = document.createElementNS(SVG_NS, 'filter');
  filter.setAttribute('id', filterId);
  filter.setAttribute('x', '-20%');
  filter.setAttribute('y', '-20%');
  filter.setAttribute('width', '140%');
  filter.setAttribute('height', '140%');
  const turbulence = document.createElementNS(SVG_NS, 'feTurbulence');
  turbulence.setAttribute('type', 'fractalNoise');
  turbulence.setAttribute('baseFrequency', '0.012');
  turbulence.setAttribute('numOctaves', '2');
  turbulence.setAttribute('seed', '4');
  turbulence.setAttribute('result', 'genui-glass-surface-noise');
  const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap');
  displacement.setAttribute('in', 'SourceGraphic');
  displacement.setAttribute('in2', 'genui-glass-surface-noise');
  displacement.setAttribute('scale', String(scale));
  displacement.setAttribute('xChannelSelector', 'R');
  displacement.setAttribute('yChannelSelector', 'G');
  filter.append(turbulence, displacement);
  svg.append(filter);
  return svg;
}

export function mount(el: HTMLElement, opts: Partial<GlassSurfaceOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    // The stylesheet already honours the media query; the class mirrors it for hosts that force
    // reduced motion (a demo toggle) and keeps the JS state in step with a live preference change.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const scale = Math.min(MAX_DISPLACE, Math.max(0, options.displace));
    if (scale > 0) {
      uid += 1;
      const filterId = `${PREFIX}-filter-${uid}`;
      const defs = buildDefs(filterId, scale);
      el.style.setProperty(`--${PREFIX}-filter-url`, `url(#${filterId})`);
      el.classList.add(DISPLACED_CLASS);
      el.append(defs);
      onDestroy(() => { defs.remove(); });
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
