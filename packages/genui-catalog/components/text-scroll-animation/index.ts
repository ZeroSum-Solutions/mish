/**
 * text-scroll-animation — clean-room implementation from the one-line effect description only
 * ("type animates on scroll"); no upstream source was read. The upstream leans on a smooth-scroll
 * library that hijacks native scrolling; this port never touches the scroll itself. It listens to
 * native `scroll`/`resize` (passive, IO-gated, rAF-throttled) and writes one progress value.
 *
 * The text is split into characters (kept whole per word, so lines never break mid-word). Each
 * character reads its index (`--i`) against the host's progress `--genui-text-scroll-animation-p`
 * (0-1) and char count `-n`, and derives its own local progress over a window of `spread`
 * characters: it rises from `rise` below, tilts up from `tilt` degrees and goes from
 * `baseOpacity` to full ink. Scrolling back reverses it, character by character.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-text-scroll-animation` and `data-genui-mounted`, and
 * returns a handle whose `destroy()` restores `el.outerHTML` exactly: the original child nodes
 * are detached into a fragment at mount and put back on destroy.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'text-scroll-animation';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface TextScrollAnimationOptions {
  [key: string]: string | number | boolean;
  /** Opacity of a character before it animates in. */
  baseOpacity: number;
  /** Starting vertical offset of a character, any CSS length. */
  rise: string;
  /** Starting tilt of a character around its baseline, in degrees. */
  tilt: number;
  /** How many characters animate at once (the width of the moving window). */
  spread: number;
  /** Viewport fraction (0 = top, 1 = bottom) of the host's top where progress is 0. */
  start: number;
  /** Viewport fraction of the host's top where progress is 1. */
  end: number;
}

export const defaults: TextScrollAnimationOptions = {
  baseOpacity: 0.14,
  rise: '0.45em',
  tilt: 55,
  spread: 8,
  start: 0.95,
  end: 0.35,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: TextScrollAnimationOptions): Record<string, string> {
  return {
    'base-opacity': String(Math.min(1, Math.max(0, options.baseOpacity))),
    rise: options.rise,
    tilt: `${options.tilt}deg`,
    w: String(Math.max(1, options.spread)),
  };
}

/** 0 while the host's top is below `start`, 1 once it is at or above `end`. */
export function progress(top: number, viewportHeight: number, start: number, end: number): number {
  const span = start - end;
  if (span === 0 || viewportHeight <= 0) return 1;
  return Math.min(1, Math.max(0, (start - top / viewportHeight) / span));
}

/** Rebuild `source` into `target`, each word a nowrap span of per-character spans. */
function split(source: Node, target: Node, count: { n: number }): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === 3) {
      for (const part of (child.textContent ?? '').split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s/.test(part)) { target.appendChild(document.createTextNode(part)); continue; }
        const word = document.createElement('span');
        word.className = `${PREFIX}__word`;
        for (const char of Array.from(part)) {
          const span = document.createElement('span');
          span.className = `${PREFIX}__char`;
          span.style.setProperty('--i', String(count.n));
          span.textContent = char;
          count.n += 1;
          word.appendChild(span);
        }
        target.appendChild(word);
      }
    } else if (child.nodeType === 1) {
      const clone = (child as Element).cloneNode(false) as Element;
      clone.removeAttribute('id');
      target.appendChild(clone);
      split(child, clone, count);
    }
  });
}

export function mount(el: HTMLElement, opts: Partial<TextScrollAnimationOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    let onReduced: () => void = () => {};
    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) onReduced();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) return; // no split, no listener: the text stays exactly as authored.

    const text = el.textContent ?? '';
    const original = document.createDocumentFragment();
    while (el.firstChild) original.appendChild(el.firstChild);
    const visual = document.createElement('span');
    visual.className = `${PREFIX}__visual`;
    visual.setAttribute('aria-hidden', 'true');
    const count = { n: 0 };
    split(original, visual, count);
    const sr = document.createElement('span');
    sr.className = `${PREFIX}__sr`;
    sr.textContent = text;
    el.append(sr, visual);
    setVars(el, PREFIX, { n: count.n, p: 0 });
    onDestroy(() => { el.replaceChildren(original); });

    let raf = 0;
    let attached = false;
    const update = (): void => {
      raf = 0;
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      const p = progress(el.getBoundingClientRect().top, vh, options.start, options.end);
      el.style.setProperty(`--${PREFIX}-p`, p.toFixed(4));
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { update(); return; }
      if (!raf) raf = requestAnimationFrame(update);
    };
    const attach = (): void => {
      if (attached || motion.reduced) return;
      attached = true;
      addEventListener('scroll', schedule, { passive: true, signal });
      addEventListener('resize', schedule, { passive: true, signal });
      schedule();
    };
    const detach = (): void => {
      if (!attached) return;
      attached = false;
      removeEventListener('scroll', schedule);
      removeEventListener('resize', schedule);
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
    };

    let io: IntersectionObserver | null = null;
    if (typeof IntersectionObserver === 'function') {
      // Only follow scroll while the host is near the viewport; off-screen it costs nothing.
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) (entry.isIntersecting ? attach : detach)();
      }, { rootMargin: '20% 0px' });
      io.observe(el);
    } else {
      attach();
    }
    onReduced = () => { io?.disconnect(); detach(); el.style.setProperty(`--${PREFIX}-p`, '1'); };
    onDestroy(() => { io?.disconnect(); detach(); });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
