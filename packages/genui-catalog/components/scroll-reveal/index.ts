/**
 * scroll-reveal — clean-room implementation from component-specs.md §6 only (name + one-line
 * description; no React Bits source was read). A quiet, editorial reveal: a paragraph or pull
 * quote goes from dim and blurred to full ink, word by word.
 *
 * `mode: "scrub"` (default) ties per-word reveal progress to scroll position both ways: an
 * IO-gated, rAF-throttled scroll/resize listener writes `--genui-scroll-reveal-p` (0-1) and
 * `--genui-scroll-reveal-n` (word count) on the host; each word's CSS reads its own index
 * (`--i`) out of those two and derives its own local progress. `mode: "once"` instead plays a
 * WAAPI stagger on first entry and stays revealed.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-scroll-reveal` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly — including the original child nodes,
 * which are detached into a DocumentFragment at mount and reattached on destroy.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, observeReveal, resolveOptions, setVars,
  watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'scroll-reveal';
const PREFIX = `genui-${id}`;

export interface ScrollRevealOptions {
  [key: string]: string | number | boolean;
  /** `scrub` follows scroll both ways; `once` reveals on entry with a word stagger. */
  mode: 'scrub' | 'once';
  /** Opacity of an unrevealed word. */
  baseOpacity: number;
  /** Blur (px) of an unrevealed word. */
  blur: number;
  /** Rotation (deg) of an unrevealed word. */
  rotate: number;
  /** Viewport fraction (0 = top) where scrub progress is 0. */
  start: number;
  /** Viewport fraction where scrub progress is 1. */
  end: number;
  /** Per-word delay in ms, `once` mode. */
  stagger: number;
  /** Reveal duration in ms, `once` mode. */
  duration: number;
  /** IO threshold, `once` mode. */
  threshold: number;
}

export const defaults: ScrollRevealOptions = {
  mode: 'scrub',
  baseOpacity: 0.15,
  blur: 4,
  rotate: 0,
  start: 0.9,
  end: 0.4,
  stagger: 25,
  duration: 500,
  threshold: 0.2,
};

function toHostVars(options: ScrollRevealOptions): Record<string, string> {
  return {
    'base-opacity': String(Math.min(1, Math.max(0, options.baseOpacity))),
    blur: `${Math.max(0, options.blur)}px`,
    rotate: `${options.rotate}deg`,
  };
}

/** 0 (below `start`) to 1 (at or past `end`), the fraction of the host's own scroll through the track. */
function scrubProgress(rect: { top: number }, viewportHeight: number, start: number, end: number): number {
  const span = start - end;
  if (span === 0) return 0;
  const frac = viewportHeight > 0 ? rect.top / viewportHeight : 0;
  return Math.min(1, Math.max(0, (start - frac) / span));
}

/**
 * Wrap every word of `source` in `.genui-scroll-reveal__word` (with `--i`), keeping whitespace
 * and inline elements (e.g. `<em>`, `<a>`) as shallow clones. Appends the wrapped words to it.
 */
function buildVisual(source: DocumentFragment, words: HTMLSpanElement[]): HTMLSpanElement {
  const visual = document.createElement('span');
  visual.className = `${PREFIX}__visual`;
  visual.setAttribute('aria-hidden', 'true');
  wrapWords(source, visual, words);
  return visual;
}

function wrapWords(source: Node, target: Node, words: HTMLSpanElement[]): void {
  source.childNodes.forEach((child) => {
    if (child.nodeType === 3 /* Text */) {
      for (const part of (child.textContent ?? '').split(/(\s+)/)) {
        if (part === '') continue;
        if (/^\s/.test(part)) { target.appendChild(document.createTextNode(part)); continue; }
        const word = document.createElement('span');
        word.className = `${PREFIX}__word`;
        word.style.setProperty('--i', String(words.length));
        word.textContent = part;
        words.push(word);
        target.appendChild(word);
      }
    } else if (child.nodeType === 1 /* Element */) {
      const clone = (child as Element).cloneNode(false);
      target.appendChild(clone);
      wrapWords(child, clone, words);
    }
  });
}

export function mount(el: HTMLElement, opts: Partial<ScrollRevealOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toHostVars(options));
    el.classList.add(`${PREFIX}--${options.mode === 'once' ? 'once' : 'scrub'}`);

    // toFinal(): once reduced motion is on, stop driving progress and snap to the revealed end
    // state without rebuilding the DOM. Set by whichever branch below runs.
    let toFinal: () => void = () => {};
    const motion = watchReducedMotion(signal, (reduced) => { if (reduced) toFinal(); });
    if (motion.reduced) return; // no split: the original content stays exactly as authored

    const originalText = el.textContent ?? '';
    const original = document.createDocumentFragment();
    while (el.firstChild) original.appendChild(el.firstChild);
    const words: HTMLSpanElement[] = [];
    const visual = buildVisual(original.cloneNode(true) as DocumentFragment, words);
    const sr = document.createElement('span');
    sr.className = `${PREFIX}__sr`;
    sr.textContent = originalText;
    el.append(visual, sr);
    el.style.setProperty(`--${PREFIX}-n`, String(words.length));
    onDestroy(() => { el.replaceChildren(); el.append(original); });

    if (options.mode === 'once') {
      const anims = createAnimationSet();
      const stopReveal = observeReveal(el, () => {
        words.forEach((word, index) => {
          anims.play(word, [
            { opacity: String(options.baseOpacity), filter: `blur(${options.blur}px)`, transform: `rotate(${options.rotate}deg)` },
            { opacity: '1', filter: 'blur(0px)', transform: 'rotate(0deg)' },
          ], { duration: options.duration, delay: index * options.stagger, easing: 'ease-out' });
        });
      }, { threshold: options.threshold, once: true });
      onDestroy(stopReveal);
      onDestroy(() => anims.cancelAll());
      toFinal = () => {
        stopReveal();
        anims.cancelAll();
        for (const word of words) { word.style.opacity = '1'; word.style.filter = 'none'; word.style.transform = 'none'; }
      };
      return;
    }

    // scrub mode
    let raf = 0;
    let attached = false;
    const update = (): void => {
      raf = 0;
      const rect = el.getBoundingClientRect();
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      el.style.setProperty(`--${PREFIX}-p`, scrubProgress(rect, vh, options.start, options.end).toFixed(4));
    };
    const schedule = (): void => {
      if (typeof requestAnimationFrame !== 'function') { update(); return; }
      if (!raf) raf = requestAnimationFrame(update);
    };
    const attach = (): void => {
      if (attached) return;
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
      io = new IntersectionObserver((entries) => {
        for (const entry of entries) (entry.isIntersecting ? attach : detach)();
      }, { rootMargin: '25% 0px' });
      io.observe(el);
    } else {
      attach();
    }
    onDestroy(() => { io?.disconnect(); detach(); });
    toFinal = () => { io?.disconnect(); detach(); el.style.setProperty(`--${PREFIX}-p`, '1'); };
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
