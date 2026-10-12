/**
 * handwriting-svg — clean-room implementation from component-specs.md §21 only.
 *
 * A phrase appears as if drawn by hand, stroke by stroke, once it enters the viewport. This build
 * uses no font-parsing library.
 *
 * - `mode: "paths"` (default) — the author supplies single-stroke `<path>` children (for example
 *   exported offline from a stroke font). `mount` reads each path's `getTotalLength()` (falling
 *   back to 1000 where it is missing, as in jsdom), draws it with an animated `stroke-dasharray` /
 *   `stroke-dashoffset`, and splits the total `duration` across the paths in proportion to their
 *   length, staggering each path's start by `stagger` ms.
 * - `mode: "text"` — the host is a plain text element. `mount` moves its existing content into a
 *   visually-hidden `.genui-handwriting-svg__sr` span (so it stays real, readable text) and adds an
 *   `aria-hidden` `<svg>` holding a `<text>` copy of the same content, whose dash is driven with
 *   normalised (`pathLength="1"`) values — a close approximation, not exact glyph tracing.
 *
 * Both modes reveal once, gated by IntersectionObserver, and finish at once under reduced motion
 * (no split, no observer in text mode; `stroke-dashoffset: 0` at mount in paths mode).
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-handwriting-svg` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, observeReveal, resolveOptions, setVars,
  snapshotAttributes, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'handwriting-svg';
const PREFIX = `genui-${id}`;
const PENDING_CLASS = `${PREFIX}--pending`;
const DRAWN_CLASS = `${PREFIX}--drawn`;
const SVG_CLASS = `${PREFIX}__svg`;
const SR_CLASS = `${PREFIX}__sr`;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface HandwritingSvgOptions {
  [key: string]: string | number | boolean;
  /** `"paths"` (author-supplied `<path>` children) or `"text"` (outline copy of the host's text). */
  mode: string;
  /** Total draw duration, in ms, split across the strokes in proportion to their length. */
  duration: number;
  /** Delay between each stroke's start, in ms. */
  stagger: number;
  strokeWidth: number;
  colour: string;
  /** Fade a solid fill in once the last stroke finishes. */
  fillAfter: boolean;
  easing: string;
  threshold: number;
}

export const defaults: HandwritingSvgOptions = {
  mode: 'paths',
  duration: 1800,
  stagger: 80,
  strokeWidth: 2,
  colour: 'currentColor',
  fillAfter: false,
  easing: 'cubic-bezier(.45,.05,.35,1)',
  threshold: 0.4,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: HandwritingSvgOptions): Record<string, string> {
  return {
    'stroke-width': String(Math.max(0, options.strokeWidth)),
    colour: options.colour,
    easing: options.easing,
  };
}

function pathLength(path: SVGPathElement): number {
  return typeof path.getTotalLength === 'function' ? path.getTotalLength() : 1000;
}

function mountPaths(
  el: HTMLElement,
  options: HandwritingSvgOptions,
  reduced: boolean,
  onDestroy: (fn: () => void) => void,
): void {
  if (!el.hasAttribute('role')) el.setAttribute('role', 'img');
  if (!el.getAttribute('aria-label')) console.warn(`${PREFIX}: add an aria-label describing the phrase`);

  const paths = Array.from(el.querySelectorAll<SVGPathElement>('path'));
  if (paths.length === 0) return;
  const restorePaths = paths.map((path) => snapshotAttributes(path, ['style']));
  onDestroy(() => { for (const restore of restorePaths) restore(); });

  const lengths = paths.map(pathLength);
  const total = lengths.reduce((sum, len) => sum + len, 0) || 1;
  paths.forEach((path, i) => {
    path.style.strokeDasharray = `${lengths[i]}`;
    path.style.strokeDashoffset = reduced ? '0' : `${lengths[i]}`;
  });

  if (reduced) {
    if (options.fillAfter) el.classList.add(DRAWN_CLASS);
    return;
  }

  el.classList.add(PENDING_CLASS);
  const animations = createAnimationSet();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const disconnect = observeReveal(el, () => {
    el.classList.remove(PENDING_CLASS);
    paths.forEach((path, i) => {
      const duration = Math.max(1, (lengths[i]! / total) * options.duration);
      animations.play(
        path,
        [{ strokeDashoffset: `${lengths[i]}` }, { strokeDashoffset: '0' }],
        { duration, delay: i * options.stagger, easing: options.easing },
      );
    });
    if (options.fillAfter) {
      timer = setTimeout(
        () => { el.classList.add(DRAWN_CLASS); },
        options.duration + Math.max(0, paths.length - 1) * options.stagger,
      );
    }
  }, { threshold: options.threshold });

  onDestroy(() => {
    disconnect();
    animations.cancelAll();
    clearTimeout(timer);
    el.classList.remove(PENDING_CLASS, DRAWN_CLASS);
  });
}

function mountText(
  el: HTMLElement,
  options: HandwritingSvgOptions,
  reduced: boolean,
  onDestroy: (fn: () => void) => void,
): void {
  const kids = Array.from(el.childNodes);
  const sr = document.createElement('span');
  sr.className = SR_CLASS;
  for (const node of kids) sr.append(node);
  el.append(sr);

  const svg = document.createElementNS(SVG_NS, 'svg') as unknown as SVGSVGElement;
  svg.setAttribute('class', SVG_CLASS);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 400 100');
  svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
  const textEl = document.createElementNS(SVG_NS, 'text') as unknown as SVGTextElement;
  textEl.setAttribute('x', '0');
  textEl.setAttribute('y', '75');
  textEl.setAttribute('pathLength', '1');
  textEl.textContent = sr.textContent ?? '';
  svg.append(textEl);
  el.append(svg);

  const animations = createAnimationSet();
  let disconnect = (): void => {};
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (reduced) {
    textEl.style.strokeDashoffset = '0';
    if (options.fillAfter) el.classList.add(DRAWN_CLASS);
  } else {
    textEl.style.strokeDasharray = '1';
    textEl.style.strokeDashoffset = '1';
    el.classList.add(PENDING_CLASS);
    disconnect = observeReveal(el, () => {
      el.classList.remove(PENDING_CLASS);
      animations.play(textEl, [{ strokeDashoffset: '1' }, { strokeDashoffset: '0' }], { duration: options.duration, easing: options.easing });
      if (options.fillAfter) timer = setTimeout(() => { el.classList.add(DRAWN_CLASS); }, options.duration);
    }, { threshold: options.threshold });
  }

  onDestroy(() => {
    disconnect();
    animations.cancelAll();
    clearTimeout(timer);
    svg.remove();
    sr.replaceWith(...Array.from(sr.childNodes));
    el.classList.remove(PENDING_CLASS, DRAWN_CLASS);
  });
}

export function mount(el: HTMLElement, opts: Partial<HandwritingSvgOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    // One-shot reveal: the preference only matters at mount (there is nothing left to redo once
    // the phrase has drawn), so this reads it once rather than watching for a live change.
    const motion = watchReducedMotion(signal);
    if (options.mode === 'text') mountText(el, options, motion.reduced, onDestroy);
    else mountPaths(el, options, motion.reduced, onDestroy);
  }, ['role']);
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
