/**
 * split-text — clean-room implementation from component-specs.md §7. A heading splits into
 * characters, words or lines and each piece rises, fades and eases in once the host enters the
 * viewport, staggered in reading order. The reveal plays once; hover does nothing. With
 * `replayOnReenter`, it plays again each time the host scrolls back into view.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-split-text` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly. `kind: js` — the split only happens once this
 * script runs; with JS off, the author's plain heading shows.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, observeReveal, resolveOptions, setVars,
  watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'split-text';
const PREFIX = `genui-${id}`;
const PENDING_CLASS = `${PREFIX}--pending`;
const SR_CLASS = `${PREFIX}__sr`;
const VISUAL_CLASS = `${PREFIX}__visual`;
const WORD_CLASS = `${PREFIX}__word`;
const PIECE_CLASS = `${PREFIX}__piece`;

export type SplitUnit = 'chars' | 'words' | 'lines';

export interface SplitTextFrom {
  [key: string]: string | number;
  /** Starting vertical offset, any CSS length. */
  y: string;
  opacity: number;
  /** Starting rotation, in degrees. */
  rotate: number;
  /** Starting blur, in px. */
  blur: number;
}

export interface SplitTextOptions {
  [key: string]: string | number | boolean | SplitTextFrom;
  split: SplitUnit;
  from: SplitTextFrom;
  /** Per-piece animation duration, ms. */
  duration: number;
  /** Delay between pieces, ms. */
  stagger: number;
  easing: string;
  threshold: number;
  rootMargin: string;
  /** Replay the reveal every time the host scrolls back into view. */
  replayOnReenter: boolean;
}

export const defaults: SplitTextOptions = {
  split: 'chars',
  from: { y: '0.6em', opacity: 0, rotate: 0, blur: 0 },
  duration: 600,
  stagger: 30,
  easing: 'cubic-bezier(.2,.7,.2,1)',
  threshold: 0.3,
  rootMargin: '0px 0px -10% 0px',
  replayOnReenter: false,
};

function fromKeyframes(from: SplitTextFrom): Keyframe[] {
  return [
    { opacity: from.opacity, transform: `translateY(${from.y}) rotate(${from.rotate}deg)`, filter: `blur(${from.blur}px)` },
    { opacity: 1, transform: 'translateY(0) rotate(0deg)', filter: 'blur(0px)' },
  ];
}

/** Word spans keep characters together (no mid-word break); pieces are the animated unit. */
function buildVisual(source: readonly ChildNode[], split: SplitUnit): HTMLElement {
  const visual = document.createElement('span');
  visual.className = VISUAL_CLASS;
  visual.setAttribute('aria-hidden', 'true');
  const markPiece = split !== 'lines'; // lines mode wraps pieces later, after layout

  const appendWord = (text: string): void => {
    const word = document.createElement('span');
    word.className = WORD_CLASS;
    if (split === 'chars') {
      for (const char of Array.from(text)) {
        const piece = document.createElement('span');
        piece.className = PIECE_CLASS;
        piece.textContent = char;
        word.append(piece);
      }
    } else {
      word.textContent = text;
      if (markPiece) word.classList.add(PIECE_CLASS);
    }
    visual.append(word);
  };

  for (const node of source) {
    if (node.nodeType === Node.TEXT_NODE) {
      for (const token of (node.textContent ?? '').split(/(\s+)/)) {
        if (token === '') continue;
        if (/^\s+$/.test(token)) visual.append(document.createTextNode(token));
        else appendWord(token);
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Inline elements are kept whole, as one atomic word/piece.
      const word = document.createElement('span');
      word.className = WORD_CLASS;
      word.append((node as Element).cloneNode(true));
      if (markPiece) word.classList.add(PIECE_CLASS);
      visual.append(word);
    }
  }
  return visual;
}

/** Groups words into line pieces by `offsetTop`. Without real layout (jsdom), it is one line. */
function groupLines(visual: HTMLElement): HTMLElement[] {
  const children = Array.from(visual.childNodes);
  const pieces: HTMLElement[] = [];
  let current: HTMLElement | null = null;
  let lastTop = NaN;
  for (const child of children) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const top = (child as HTMLElement).offsetTop;
      if (!current || top !== lastTop) {
        current = document.createElement('span');
        current.className = PIECE_CLASS;
        visual.append(current);
        pieces.push(current);
        lastTop = top;
      }
    } else if (!current) {
      current = document.createElement('span');
      current.className = PIECE_CLASS;
      visual.append(current);
      pieces.push(current);
    }
    current.append(child);
  }
  return pieces;
}

function collectPieces(visual: HTMLElement, split: SplitUnit): HTMLElement[] {
  if (split === 'lines') return groupLines(visual);
  return Array.from(visual.querySelectorAll<HTMLElement>(`.${PIECE_CLASS}`));
}

export function mount(el: HTMLElement, opts: Partial<SplitTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    // toFinal(): reduced motion turned on after mount. Stops the reveal (IO and any in-flight
    // animation) and settles every piece at its final, fully visible state. Set once set up below.
    let toFinal: () => void = () => {};
    const motion = watchReducedMotion(signal, (reduced) => { if (reduced) toFinal(); });
    if (motion.reduced) return; // No split, no IO: the heading shows exactly as authored.

    const originalNodes = Array.from(el.childNodes);
    const text = el.textContent ?? '';
    el.textContent = '';
    const sr = document.createElement('span');
    sr.className = SR_CLASS;
    sr.textContent = text;
    el.append(sr);

    const visual = buildVisual(originalNodes, options.split);
    el.append(visual);
    const pieces = collectPieces(visual, options.split);

    setVars(el, PREFIX, {
      'from-y': options.from.y,
      'from-opacity': String(options.from.opacity),
      'from-rotate': `${options.from.rotate}deg`,
      'from-blur': `${options.from.blur}px`,
    });
    el.classList.add(PENDING_CLASS);

    const anims = createAnimationSet();
    const play = (): void => {
      if (pieces.length === 0) { el.classList.remove(PENDING_CLASS); return; }
      let waiting = pieces.length;
      const settle = (): void => { waiting -= 1; if (waiting <= 0) el.classList.remove(PENDING_CLASS); };
      pieces.forEach((piece, i) => {
        const animation = anims.play(piece, fromKeyframes(options.from), {
          duration: options.duration, delay: i * options.stagger, easing: options.easing,
        });
        if (!animation) { settle(); return; }
        animation.finished.then(settle, settle);
      });
    };

    const disconnectIO = observeReveal(el, play, {
      threshold: options.threshold, rootMargin: options.rootMargin, once: !options.replayOnReenter,
    });

    toFinal = () => {
      disconnectIO();
      anims.cancelAll();
      el.classList.remove(PENDING_CLASS);
    };

    onDestroy(() => {
      anims.cancelAll();
      disconnectIO();
      el.textContent = '';
      for (const node of originalNodes) el.append(node);
    });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
