/**
 * true-focus — clean-room implementation from the effect description ("focus-pull across words")
 * only. The text is split into words; one word at a time is sharp while the rest sit blurred and
 * dimmed, and a corner-bracket frame glides to the sharp word, like a camera pulling focus. By
 * default the focus steps through the words on a timer (`duration` ms of transition, then `pause`
 * ms of hold); with `manual`, the resting state is fully sharp and hovering a word pulls focus to it.
 *
 * Accessibility: the original child nodes move, untouched, into a visually hidden span, so screen
 * readers read the text once with its inline markup; the split copy is `aria-hidden`. The timer
 * runs only while the host is on screen (IntersectionObserver) and never under reduced motion,
 * where every word is sharp and the frame is hidden.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-true-focus` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'true-focus';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const IDLE_CLASS = `${PREFIX}--idle`;
const NO_FRAME_CLASS = `${PREFIX}--no-frame`;
const WORD_CLASS = `${PREFIX}__word`;
const ACTIVE_CLASS = `${WORD_CLASS}--active`;

export interface TrueFocusOptions {
  [key: string]: string | number | boolean;
  /** Blur on the words out of focus, in px. */
  blur: number;
  /** Opacity of the words out of focus, 0–1. */
  dim: number;
  /** Focus-pull transition time, in ms. */
  duration: number;
  /** Time each word holds focus before the next pull, in ms. */
  pause: number;
  /** Colour of the corner-bracket frame. */
  frameColor: string;
  /** Colour of the glow around the frame. */
  glowColor: string;
  /** Draw the corner-bracket frame around the focused word. */
  frame: boolean;
  /** Hover drives the focus instead of the timer; the resting state is fully sharp. */
  manual: boolean;
}

export const defaults: TrueFocusOptions = {
  blur: 5,
  dim: 0.55,
  duration: 500,
  pause: 1000,
  frameColor: '#8ab4ff',
  glowColor: 'rgba(138,180,255,.55)',
  frame: true,
  manual: false,
};

const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: TrueFocusOptions): Record<string, string> {
  return {
    blur: `${Math.max(0, options.blur)}px`,
    dim: String(clamp(options.dim, 0, 1)),
    duration: `${Math.max(0, options.duration)}ms`,
    color: options.frameColor,
    glow: options.glowColor,
  };
}

export function mount(el: HTMLElement, opts: Partial<TrueFocusOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(NO_FRAME_CLASS, !options.frame);

    const originalNodes = Array.from(el.childNodes);
    const text = el.textContent ?? '';
    const sr = document.createElement('span');
    sr.className = `${PREFIX}__sr`;
    sr.append(...originalNodes);

    const visual = document.createElement('span');
    visual.className = `${PREFIX}__visual`;
    visual.setAttribute('aria-hidden', 'true');
    const words: HTMLElement[] = [];
    for (const token of text.trim().split(/(\s+)/)) {
      if (!token) continue;
      if (/^\s+$/.test(token)) { visual.append(' '); continue; }
      const word = document.createElement('span');
      word.className = WORD_CLASS;
      word.textContent = token;
      words.push(word);
      visual.append(word);
    }
    const frame = document.createElement('span');
    frame.className = `${PREFIX}__frame`;
    frame.setAttribute('aria-hidden', 'true');
    el.append(sr, visual, frame);

    onDestroy(() => {
      if (timer) clearTimeout(timer);
      timer = 0;
      el.textContent = '';
      el.append(...originalNodes);
    });

    let active = -1;
    let timer: ReturnType<typeof setTimeout> | 0 = 0;
    let visible = typeof IntersectionObserver !== 'function';

    const place = (): void => {
      const word = words[active];
      if (!word) return;
      setVars(el, PREFIX, {
        x: `${word.offsetLeft}px`, y: `${word.offsetTop}px`, w: `${word.offsetWidth}px`, h: `${word.offsetHeight}px`,
      });
    };
    const focusWord = (index: number): void => {
      active = index;
      words.forEach((word, i) => { word.classList.toggle(ACTIVE_CLASS, i === index); });
      el.classList.toggle(IDLE_CLASS, index < 0);
      place();
    };

    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); sync(); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const step = Math.max(50, options.duration + options.pause);
    const tick = (): void => {
      timer = 0;
      focusWord((active + 1) % words.length);
      sync();
    };
    // Start or stop the timer: it runs only in auto mode, with motion allowed, on screen.
    function sync(): void {
      const run = !options.manual && !motion.reduced && visible && words.length > 1;
      if (run && !timer) timer = setTimeout(tick, step);
      else if (!run && timer) { clearTimeout(timer); timer = 0; }
    }

    if (options.manual) {
      focusWord(-1);
      const listen = { passive: true, signal } as const;
      words.forEach((word, i) => { word.addEventListener('pointerenter', () => { focusWord(i); }, listen); });
      visual.addEventListener('pointerleave', () => { focusWord(-1); }, listen);
    } else {
      focusWord(0);
    }

    addEventListener('resize', place, { passive: true, signal });

    if (!visible) {
      const io = new IntersectionObserver(([entry]) => {
        visible = !!entry?.isIntersecting;
        if (visible) place();
        sync();
      });
      io.observe(el);
      onDestroy(() => { io.disconnect(); });
    }
    sync();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
