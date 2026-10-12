/**
 * masked-heading — clean-room implementation from component-specs.md §8 only. No React Bits,
 * 21st.dev or Kokonut source was read; the behaviour, options and DOM contract below come only
 * from the spec text.
 *
 * A headline is revealed through a mask. Each line sits in a clipping box (`__line`, its own
 * `__inner`); on entry the lines rise from below (`rise`) or wipe open left-to-right (`wipe`),
 * staggered top to bottom. The reveal plays once and nothing happens on hover or at idle. Lines
 * are grouped either by `<br>` (`lines: "br"`) or by measured `offsetTop` (`lines: "auto"`,
 * collapsing to one line where there is no real layout, as in jsdom).
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-masked-heading` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, observeReveal, resolveOptions,
  watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'masked-heading';
const PREFIX = `genui-${id}`;
const PENDING = `${PREFIX}--pending`;
const WIPE = `${PREFIX}--wipe`;
const LINE = `${PREFIX}__line`;
const INNER = `${PREFIX}__inner`;
const VISUAL = `${PREFIX}__visual`;
const SR = `${PREFIX}__sr`;

export interface MaskedHeadingOptions {
  [key: string]: string | number | boolean;
  /** Slide up from below the mask, or wipe open left-to-right. */
  style: 'rise' | 'wipe';
  /** Reveal duration per line, in ms. */
  duration: number;
  /** Delay between each line's reveal, in ms. */
  stagger: number;
  easing: string;
  /** Fraction of the heading that must be visible before the reveal fires. */
  threshold: number;
  /** Group lines by measured layout, or split only on `<br>`. */
  lines: 'auto' | 'br';
}

export const defaults: MaskedHeadingOptions = {
  style: 'rise',
  duration: 900,
  stagger: 120,
  easing: 'cubic-bezier(.19,1,.22,1)',
  threshold: 0.4,
  lines: 'auto',
};

/** Split `visual`'s current children into per-line node groups at each `<br>`. */
function linesFromBr(visual: HTMLElement): Node[][] {
  const groups: Node[][] = [[]];
  for (const node of Array.from(visual.childNodes)) {
    if (node instanceof Element && node.tagName === 'BR') { groups.push([]); continue; }
    groups[groups.length - 1]!.push(node);
  }
  return groups;
}

/**
 * Group `visual`'s words into per-line node groups by measured `offsetTop`. Without real layout
 * (jsdom, or a heading that fits on one line), every word shares the same `offsetTop`, so this
 * collapses to a single line.
 */
function linesFromAuto(visual: HTMLElement): Node[][] {
  const words = (visual.textContent ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [[]];
  const probe = document.createDocumentFragment();
  const spans = words.map((word) => {
    const span = document.createElement('span');
    span.textContent = word;
    probe.append(span, document.createTextNode(' '));
    return span;
  });
  visual.replaceChildren(probe);
  const groups: string[][] = [];
  let top: number | null = null;
  for (let i = 0; i < spans.length; i += 1) {
    const rowTop = spans[i]!.offsetTop;
    if (top === null || rowTop !== top) { groups.push([]); top = rowTop; }
    groups[groups.length - 1]!.push(words[i]!);
  }
  return groups.map((line) => [document.createTextNode(line.join(' '))]);
}

export function mount(el: HTMLElement, opts: Partial<MaskedHeadingOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);

    // Save the original children (not clones) so destroy() can put the exact nodes back,
    // wherever the reveal has since moved them.
    const original = Array.from(el.childNodes);
    const sr = document.createElement('span');
    sr.className = SR;
    sr.textContent = el.textContent ?? '';

    const visual = document.createElement('span');
    visual.className = VISUAL;
    visual.setAttribute('aria-hidden', 'true');
    visual.append(...original);

    el.replaceChildren(sr, visual);
    onDestroy(() => { el.replaceChildren(...original); });

    const animations = createAnimationSet();
    onDestroy(() => animations.cancelAll());

    let inners: HTMLElement[] = [];
    let ro: ResizeObserver | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | 0 = 0;
    let stopReveal = (): void => {};

    const cleanupObservers = (): void => {
      if (resizeTimer) { clearTimeout(resizeTimer); resizeTimer = 0; }
      ro?.disconnect();
      stopReveal();
    };
    onDestroy(cleanupObservers);

    const settle = (): void => {
      for (const inner of inners) {
        inner.style.transform = 'none';
        inner.style.clipPath = 'none';
      }
    };

    const finalize = (): void => {
      cleanupObservers();
      animations.cancelAll();
      el.classList.remove(PENDING);
      settle();
    };

    const motion = watchReducedMotion(signal, (reduced) => { if (reduced) finalize(); });
    if (motion.reduced) return; // no pending state, no line wrappers, no observers

    el.classList.add(PENDING);
    el.classList.toggle(WIPE, options.style === 'wipe');

    const regroup = (): HTMLElement[] => {
      const groups = options.lines === 'br' ? linesFromBr(visual) : linesFromAuto(visual);
      const nextInners: HTMLElement[] = [];
      const lineEls = groups.map((nodes) => {
        const line = document.createElement('span');
        line.className = LINE;
        const inner = document.createElement('span');
        inner.className = INNER;
        inner.append(...nodes);
        line.append(inner);
        nextInners.push(inner);
        return line;
      });
      visual.replaceChildren(...lineEls);
      return nextInners;
    };

    inners = regroup();

    // <br>-delimited lines do not depend on the viewport width, so only "auto" mode re-measures.
    if (options.lines === 'auto' && typeof ResizeObserver === 'function') {
      ro = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => { inners = regroup(); }, 120);
      });
      ro.observe(el);
    }

    stopReveal = observeReveal(el, () => {
      cleanupObservers();
      el.classList.remove(PENDING);
      inners.forEach((inner, i) => {
        const keyframes: Keyframe[] = options.style === 'wipe'
          ? [{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0% 0 0)' }]
          : [{ transform: 'translateY(110%)' }, { transform: 'translateY(0)' }];
        const anim = animations.play(inner, keyframes, {
          duration: options.duration, delay: i * options.stagger, easing: options.easing,
        });
        if (!anim) { inner.style.transform = 'none'; inner.style.clipPath = 'none'; }
      });
    }, { threshold: options.threshold });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
