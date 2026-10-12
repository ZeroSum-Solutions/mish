/**
 * blur-text — clean-room implementation from the effect description ("Type blurs into focus")
 * only. The text splits into words (or characters) and each piece resolves from a soft blur,
 * transparent and slightly offset, into sharp focus once the host enters the viewport, staggered
 * in reading order. The motion is a CSS keyframe animation driven by custom properties; the script
 * only splits the text, sets each piece's index and toggles state classes. No dependency.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-blur-text` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly. `kind: js`: with JS off, the author's plain
 * text shows. The pending (blurred, hidden) state is only applied once an IntersectionObserver
 * exists to lift it, so content is never left hidden.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'blur-text';
const PREFIX = `genui-${id}`;
const PENDING_CLASS = `${PREFIX}--pending`;
const PLAY_CLASS = `${PREFIX}--play`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const SR_CLASS = `${PREFIX}__sr`;
const VISUAL_CLASS = `${PREFIX}__visual`;
const WORD_CLASS = `${PREFIX}__word`;
const PIECE_CLASS = `${PREFIX}__piece`;

export interface BlurTextOptions {
  [key: string]: string | number | boolean;
  /** The unit that blurs in: whole words or single characters. */
  split: 'words' | 'chars';
  /** Starting blur radius, in px. */
  blur: number;
  /** Starting vertical offset, in em; positive rises from below, negative drops from above. */
  rise: number;
  /** Per-piece animation duration, in ms. */
  duration: number;
  /** Delay between pieces, in ms. */
  stagger: number;
  /** Delay before the first piece, in ms. */
  delay: number;
  easing: string;
  /** Share of the host that must be visible before the reveal starts. */
  threshold: number;
  /** Blur the text out again when it leaves the viewport and replay on re-entry. */
  replay: boolean;
}

export const defaults: BlurTextOptions = {
  split: 'words',
  blur: 12,
  rise: 0.35,
  duration: 800,
  stagger: 90,
  delay: 0,
  easing: 'cubic-bezier(.2,.65,.25,1)',
  threshold: 0.25,
  replay: false,
};

const clamp0 = (n: number): number => Math.max(0, n);

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: BlurTextOptions): Record<string, string> {
  return {
    blur: `${clamp0(options.blur)}px`,
    rise: `${options.rise}em`,
    duration: `${clamp0(options.duration)}ms`,
    stagger: `${clamp0(options.stagger)}ms`,
    delay: `${clamp0(options.delay)}ms`,
    easing: options.easing,
  };
}

function piece(text: string | Node, index: number): HTMLElement {
  const span = document.createElement('span');
  span.className = PIECE_CLASS;
  span.style.setProperty(`--${PREFIX}-i`, String(index));
  span.append(text);
  return span;
}

/** An aria-hidden copy split into pieces; inline elements stay whole as one piece. */
function buildVisual(source: readonly ChildNode[], split: BlurTextOptions['split']): [HTMLElement, number] {
  const visual = document.createElement('span');
  visual.className = VISUAL_CLASS;
  visual.setAttribute('aria-hidden', 'true');
  let count = 0;
  for (const node of source) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const token of (node.textContent ?? '').split(/(\s+)/)) {
        if (!token) continue;
        if (/^\s+$/.test(token)) { visual.append(token); continue; }
        if (split === 'chars') {
          const word = document.createElement('span');
          word.className = WORD_CLASS;
          for (const char of Array.from(token)) word.append(piece(char, count++));
          visual.append(word);
        } else {
          visual.append(piece(token, count++));
        }
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      visual.append(piece(node.cloneNode(true), count++));
    }
  }
  return [visual, count];
}

export function mount(el: HTMLElement, opts: Partial<BlurTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    // Mirrors the media query for hosts that force reduced motion, and settles any running reveal
    // at once if the preference switches on mid-animation.
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) return; // No split, no observer: the text shows exactly as authored.

    const originalNodes = Array.from(el.childNodes);
    const text = el.textContent ?? '';
    const [visual, count] = buildVisual(originalNodes, options.split);
    const sr = document.createElement('span');
    sr.className = SR_CLASS;
    sr.textContent = text;
    el.textContent = '';
    el.append(sr, visual);
    onDestroy(() => {
      el.textContent = '';
      el.append(...originalNodes);
    });

    if (count === 0 || typeof IntersectionObserver !== 'function') return; // final state, no motion

    let remaining = 0;
    const settle = (): void => { el.classList.remove(PENDING_CLASS, PLAY_CLASS); };
    const play = (): void => {
      remaining = count;
      el.classList.remove(PENDING_CLASS);
      el.classList.add(PLAY_CLASS);
    };
    // Each piece fires one animationend; when the last settles, drop the play class so no
    // filter or will-change lingers on the finished text.
    el.addEventListener('animationend', (event) => {
      if (!(event.target as Element).classList.contains(PIECE_CLASS)) return;
      remaining -= 1;
      if (remaining <= 0) settle();
    }, { signal });

    el.classList.add(PENDING_CLASS);
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          if (el.classList.contains(PENDING_CLASS)) play();
          if (!options.replay) io.disconnect();
        } else if (options.replay) {
          el.classList.remove(PLAY_CLASS);
          el.classList.add(PENDING_CLASS);
        }
      }
    }, { threshold: Math.min(1, clamp0(options.threshold)) });
    io.observe(el);
    onDestroy(() => {
      io.disconnect();
      settle();
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
