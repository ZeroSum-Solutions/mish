/**
 * split-flap-text — clean-room implementation from the effect name and its one-line description
 * ("Airport departure-board flip") only. Each character becomes a split-flap tile: two static
 * halves plus two hinged flaps. To change a tile, the upper flap (old character) folds down to
 * 90deg, then the lower flap (new character) folds down from 90deg to flat, which is the classic
 * departure-board mechanism. On reveal every tile runs through a few random characters from
 * `charset` before it settles on its target, staggered left to right.
 *
 * One setTimeout ticker (one step every `flipDuration` ms) drives every tile. It starts when the
 * host first enters the viewport, pauses while the host is off-screen (IntersectionObserver) and
 * stops on destroy. Hover or focus replays the flip (`replayOnHover`); `loop` replays on a timer.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-split-flap-text` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. The original text is kept once in a
 * visually hidden span; the tile board is aria-hidden.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'split-flap-text';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const FLIP_CLASS = `${PREFIX}__cell--flip`;
const PARTS = ['t', 'b', 'ft', 'fb'] as const;

export interface SplitFlapTextOptions {
  [key: string]: string | number | boolean;
  /** Random characters each tile shows before it settles. */
  flips: number;
  /** Duration of one flap turn, in ms. */
  flipDuration: number;
  /** Delay between neighbouring tiles starting, in ms. */
  stagger: number;
  /** Characters the tiles cycle through on the way to their target. */
  charset: string;
  /** Show the board in capitals, like a real departure board (the spoken text keeps its case). */
  uppercase: boolean;
  /** Replay the flip when the pointer enters or the host receives focus. */
  replayOnHover: boolean;
  /** Replay the flip every `loop` ms after it settles; 0 plays once. */
  loop: number;
  /** Tile colour. */
  tile: string;
  /** Character colour. */
  ink: string;
}

export const defaults: SplitFlapTextOptions = {
  flips: 6,
  flipDuration: 80,
  stagger: 40,
  charset: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789',
  uppercase: true,
  replayOnHover: true,
  loop: 0,
  tile: '#1a1d24',
  ink: '#f4efe2',
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: SplitFlapTextOptions): Record<string, string> {
  return {
    duration: `${Math.max(16, options.flipDuration)}ms`,
    tile: options.tile,
    ink: options.ink,
  };
}

interface Cell {
  el: HTMLElement;
  parts: HTMLElement[];
  cur: string;
  target: string;
  queue: string[];
  wait: number;
}

function span(className: string): HTMLElement {
  const node = document.createElement('span');
  node.className = `${PREFIX}__${className}`;
  return node;
}

export function mount(el: HTMLElement, opts: Partial<SplitFlapTextOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const duration = Math.max(16, options.flipDuration);
    const charset = Array.from(options.charset);
    const originalNodes = Array.from(el.childNodes);
    const text = (el.textContent ?? '').replace(/\s/g, ' ').trim();
    const shown = options.uppercase ? text.toUpperCase() : text;

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) finish();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    const hasIO = typeof IntersectionObserver === 'function';
    // Tiles start blank only when JS is sure to fill them: motion allowed and a viewport signal.
    const startBlank = !motion.reduced && hasIO;

    el.textContent = '';
    const sr = span('sr');
    sr.textContent = text;
    const board = span('board');
    board.setAttribute('aria-hidden', 'true');
    el.append(sr, board);
    onDestroy(() => {
      el.textContent = '';
      for (const node of originalNodes) el.append(node);
    });

    const cells: Cell[] = [];
    let word: HTMLElement | null = null;
    for (const ch of Array.from(shown)) {
      if (!word) { word = span('word'); board.append(word); }
      const cellEl = span('cell');
      const start = startBlank ? ' ' : ch;
      const parts = PARTS.map((name) => {
        const part = span(name);
        part.textContent = start;
        cellEl.append(part);
        return part;
      });
      word.append(cellEl);
      cells.push({ el: cellEl, parts, cur: start, target: ch, queue: [], wait: 0 });
      if (ch === ' ') word = null; // a space tile ends a word group, so lines wrap between words
    }

    const setChar = (cell: Cell, next: string): void => {
      const [top, bottom, flapTop, flapBottom] = cell.parts as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
      bottom.textContent = cell.cur;
      flapTop.textContent = cell.cur;
      top.textContent = next;
      flapBottom.textContent = next;
      cell.cur = next;
      cell.el.classList.remove(FLIP_CLASS);
      void cell.el.offsetWidth; // restart the CSS flap animation
      cell.el.classList.add(FLIP_CLASS);
    };

    let timer = 0;
    let replayTimer = 0;
    let visible = !hasIO;
    let started = false;
    let running = false;

    const clearTimers = (): void => {
      clearTimeout(timer);
      clearTimeout(replayTimer);
      timer = 0;
      replayTimer = 0;
    };

    function finish(): void {
      clearTimers();
      running = false;
      for (const cell of cells) {
        cell.queue = [];
        cell.cur = cell.target;
        for (const part of cell.parts) part.textContent = cell.target;
        cell.el.classList.remove(FLIP_CLASS);
      }
    }

    const schedule = (): void => {
      if (running && visible && !timer) timer = setTimeout(tick, duration) as unknown as number;
    };

    function tick(): void {
      timer = 0;
      let busy = false;
      for (const cell of cells) {
        if (cell.wait > 0) { cell.wait -= 1; busy = true; continue; }
        const next = cell.queue.shift();
        if (next !== undefined) { setChar(cell, next); busy = true; } else if (cell.el.classList.contains(FLIP_CLASS)) {
          // The last turn has finished: settle onto the static halves so the rest state never
          // depends on an animation's fill mode.
          for (const part of cell.parts) part.textContent = cell.cur;
          cell.el.classList.remove(FLIP_CLASS);
        }
      }
      if (busy) { schedule(); return; }
      running = false;
      if (options.loop > 0) replayTimer = setTimeout(play, options.loop) as unknown as number;
    }

    function play(): void {
      replayTimer = 0;
      if (motion.reduced || running || cells.length === 0) return;
      const flips = Math.max(0, Math.round(options.flips));
      cells.forEach((cell, i) => {
        const count = charset.length ? Math.round(flips * (0.5 + Math.random() * 0.5)) : 0;
        cell.queue = [];
        for (let n = 0; n < count; n += 1) cell.queue.push(charset[Math.floor(Math.random() * charset.length)] ?? ' ');
        cell.queue.push(cell.target);
        cell.wait = Math.round((i * Math.max(0, options.stagger)) / duration);
      });
      running = true;
      schedule();
    }

    onDestroy(() => {
      clearTimers();
      running = false;
    });
    if (motion.reduced) return; // static board, final characters, no timers or observers.

    const replay = (): void => { if (options.replayOnHover) play(); };
    el.addEventListener('pointerenter', replay, { signal });
    el.addEventListener('focusin', replay, { signal });

    if (!hasIO) { started = true; play(); return; }
    const io = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      visible = Boolean(entry?.isIntersecting);
      if (!visible) { clearTimeout(timer); timer = 0; return; }
      if (!started) { started = true; play(); } else schedule();
    }, { threshold: 0.1 });
    io.observe(el);
    onDestroy(() => { io.disconnect(); });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
