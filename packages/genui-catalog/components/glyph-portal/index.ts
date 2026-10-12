/**
 * glyph-portal — clean-room implementation from component-specs.md §20 only. No upstream
 * (21st.dev) source was fetched, read or recalled; only the spec's prose description was used.
 *
 * A section shows one giant letter cut from a solid cover; the "next" content sits behind it,
 * visible only through the letter's shape. While the pinned track scrolls, the letter scales up
 * around `origin` until the opening covers the viewport, then the cover is hidden so it never
 * blocks clicks. Scrolling back shrinks the letter again. Idle holds the current frame.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`, adds
 * `.genui-glyph-portal` and `data-genui-mounted`, and returns a handle whose `destroy()` restores
 * `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'glyph-portal';
const PREFIX = `genui-${id}`;
const STAGE_CLASS = `${PREFIX}__stage`;
const CONTENT_CLASS = `${PREFIX}__content`;
const COVER_CLASS = `${PREFIX}__cover`;
const GLYPH_CLASS = `${PREFIX}__glyph`;
const OPEN_CLASS = `${PREFIX}__cover--open`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const P_VAR = `--${PREFIX}-p`;
const S_VAR = `--${PREFIX}-s`;
const SVG_NS = 'http://www.w3.org/2000/svg';
/** The cover is hidden once progress reaches this, so it never blocks clicks near the end. */
const HIDE_AT = 0.98;

let uid = 0;

export interface GlyphPortalOptions {
  [key: string]: string | number | readonly [number, number];
  glyph: string;
  font: string;
  weight: number;
  trackHeight: string;
  maxScale: number;
  /** Fraction of the glyph box the scale grows from: [x, y], each 0-1. */
  origin: readonly [number, number];
  cover: string;
}

export const defaults: GlyphPortalOptions = {
  glyph: 'O',
  font: 'system-ui, sans-serif',
  weight: 900,
  trackHeight: '250vh',
  maxScale: 60,
  origin: [0.5, 0.5],
  cover: '#0b0d12',
};

/** `s(p) = 1 + (maxScale-1) * p^3`: the opening only accelerates late in the track. */
export function scaleFor(p: number, maxScale: number): number {
  return 1 + (Math.max(1, maxScale) - 1) * p ** 3;
}

function buildCover(options: GlyphPortalOptions): SVGSVGElement {
  uid += 1;
  const maskId = `${PREFIX}-mask-${uid}`;
  const [ox, oy] = options.origin;
  const svg = document.createElementNS(SVG_NS, 'svg') as unknown as SVGSVGElement;
  svg.setAttribute('class', COVER_CLASS);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('preserveAspectRatio', 'none');

  const mask = document.createElementNS(SVG_NS, 'mask');
  mask.setAttribute('id', maskId);
  mask.setAttribute('maskUnits', 'userSpaceOnUse');
  mask.setAttribute('x', '0');
  mask.setAttribute('y', '0');
  mask.setAttribute('width', '100');
  mask.setAttribute('height', '100');

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('width', '100');
  bg.setAttribute('height', '100');
  bg.setAttribute('fill', '#fff');

  const glyphGroup = document.createElementNS(SVG_NS, 'g');
  glyphGroup.setAttribute('class', GLYPH_CLASS);
  (glyphGroup as unknown as SVGElement).style.transformOrigin = `${ox * 100}% ${oy * 100}%`;

  const text = document.createElementNS(SVG_NS, 'text');
  text.setAttribute('x', '50');
  text.setAttribute('y', '50');
  text.setAttribute('text-anchor', 'middle');
  text.setAttribute('dominant-baseline', 'central');
  text.setAttribute('font-family', options.font);
  text.setAttribute('font-weight', String(options.weight));
  text.setAttribute('font-size', '80');
  text.setAttribute('fill', '#000');
  text.textContent = options.glyph;
  glyphGroup.append(text);
  mask.append(bg, glyphGroup);

  const fill = document.createElementNS(SVG_NS, 'rect');
  fill.setAttribute('width', '100');
  fill.setAttribute('height', '100');
  (fill as unknown as SVGElement).style.setProperty('fill', `var(--${PREFIX}-cover)`);
  fill.setAttribute('mask', `url(#${maskId})`);

  svg.append(mask, fill);
  return svg;
}

export function mount(el: HTMLElement, opts: Partial<GlyphPortalOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, { cover: options.cover });

    // Wrap the original ("next") content in a sticky stage so the cover can sit on top of it.
    // Unpinned (reduced motion, or no JS at all) this is a plain block: sticky has no visible
    // effect when the section is no taller than the stage, so the content just shows directly.
    const originalChildren = Array.from(el.childNodes);
    const stage = document.createElement('div');
    stage.className = STAGE_CLASS;
    const content = document.createElement('div');
    content.className = CONTENT_CLASS;
    content.append(...originalChildren);
    stage.append(content);
    el.append(stage);
    onDestroy(() => {
      el.append(...Array.from(content.childNodes));
      stage.remove();
    });

    let cover: SVGSVGElement | null = null;
    let raf = 0;
    let intersecting = true;
    let stopIO: (() => void) | null = null;

    const applyP = (p: number): void => {
      el.style.setProperty(P_VAR, p.toFixed(4));
      el.style.setProperty(S_VAR, scaleFor(p, options.maxScale).toFixed(4));
      cover?.classList.toggle(OPEN_CLASS, p >= HIDE_AT);
    };
    const computeP = (): number => {
      const rect = el.getBoundingClientRect();
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      const total = rect.height - vh;
      return total <= 0 ? 0 : Math.min(1, Math.max(0, -rect.top / total));
    };
    const schedule = (): void => {
      if (!intersecting || raf) return;
      if (typeof requestAnimationFrame !== 'function') { applyP(computeP()); return; }
      raf = requestAnimationFrame(() => { raf = 0; applyP(computeP()); });
    };

    const enablePin = (): void => {
      if (!cover) { cover = buildCover(options); stage.append(cover); }
      el.style.height = options.trackHeight;
      window.addEventListener('scroll', schedule, { passive: true, signal });
      window.addEventListener('resize', schedule, { passive: true, signal });
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) intersecting = entry.isIntersecting;
          if (intersecting) schedule();
        });
        io.observe(el);
        stopIO = () => io.disconnect();
      }
      schedule();
    };
    const disablePin = (): void => {
      el.style.height = '';
      stopIO?.();
      stopIO = null;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      cover?.remove();
      cover = null;
    };
    onDestroy(() => {
      stopIO?.();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    });

    // Focus landing inside the content while it is still covered means a keyboard user tabbed
    // past the cutout: carry the track to its end so the content they landed on is visible.
    content.addEventListener('focusin', () => {
      if (!cover || cover.classList.contains(OPEN_CLASS)) return;
      const rect = el.getBoundingClientRect();
      window.scrollTo({ top: window.scrollY + rect.top + rect.height, behavior: 'auto' });
    }, { signal });

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) disablePin(); else enablePin();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) disablePin(); else enablePin();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
