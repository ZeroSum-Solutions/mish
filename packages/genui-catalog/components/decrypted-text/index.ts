// Clean-room behavior implementation; no upstream implementation source used.
import { autoInitComponent, mountComponent, resolveOptions, watchReducedMotion, observeReveal, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };

export const id = 'decrypted-text';
const GLYPHS = "ABCDEFGHJKLMNPQRSTUVXYZ23456789";
const PREFIX = `genui-${id}`;
export interface DecryptedTextOptions { [key: string]: number; duration: number; }
export const defaults: DecryptedTextOptions = { duration: 900 };
export function mount(el: HTMLElement, opts: Partial<DecryptedTextOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  if (el.querySelector('a, button, input, select, textarea, [tabindex], [contenteditable]')) return;
  const options = resolveOptions(el, defaults, opts);
  const duration = Math.min(4000, Math.max(0, options.duration));
  const original = Array.from(el.childNodes);
  const text = el.textContent ?? '';
  const readable = document.createElement('span'); readable.className = `${PREFIX}__readable`; readable.append(...original);
  const visual = document.createElement('span'); visual.className = `${PREFIX}__visual`; visual.setAttribute('aria-hidden', 'true');
  const chars = typeof Intl.Segmenter === 'function' ? Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text), part => part.segment) : Array.from(text);
  let word: HTMLSpanElement | null = null;
  const pieces = chars.map(char => {
   if (/\s/u.test(char)) { visual.append(document.createTextNode(char)); word = null; return null; }
   if (!word) { word = document.createElement('span'); word.className = `${PREFIX}__word`; visual.append(word); }
   const piece = document.createElement('span'); piece.className = `${PREFIX}__char`;
   const letter = document.createElement('span'); letter.textContent = char; piece.append(letter);
   const glyph = document.createElement("span"); glyph.className = `${PREFIX}__glyph`; piece.append(glyph);
   word.append(piece); return piece;
  });
  el.replaceChildren(readable, visual);
  let raf = 0; let started = false;
  const settle = (): void => {
   if (raf) cancelAnimationFrame(raf); raf = 0;
   for (const piece of pieces) { piece?.style.removeProperty('opacity'); piece?.classList.remove(`${PREFIX}__char--pending`); }
  };
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); if (value) settle(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  onDestroy(() => { settle(); el.replaceChildren(...original); });
  onDestroy(observeReveal(el, () => {
   if (started || motion.reduced || duration === 0 || typeof requestAnimationFrame !== 'function') return;
   started = true; let start: number | undefined;
   const tick = (now: number): void => {
    raf = 0; start ??= now; const progress = Math.min(1, Math.max(0, (now - start) / duration));
    const shown = Math.floor(progress * chars.length);
    pieces.forEach((piece, index) => {
     if (!piece) return;
     piece.classList.toggle(`${PREFIX}__char--pending`, index >= shown); const glyph = piece.querySelector<HTMLElement>(`.${PREFIX}__glyph`)!; glyph.textContent = GLYPHS[(index + Math.floor((now - start!) / 65) * 7) % GLYPHS.length] ?? "X";
    });
    if (progress < 1 && !motion.reduced && !signal.aborted) raf = requestAnimationFrame(tick); else settle();
   };
   raf = requestAnimationFrame(tick);
  }));
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
