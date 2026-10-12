// Original complete-word rotation with stable accessible text and explicit pause.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'rotating-text';
const PREFIX = `genui-${id}`;
export interface RotatingTextOptions { [key: string]: number | readonly unknown[]; words: readonly string[]; interval: number; duration: number; }
export const defaults: RotatingTextOptions = { words: ['strategy', 'identity', 'digital'], interval: 2600, duration: 420 };
export function mount(el: HTMLElement, opts: Partial<RotatingTextOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  if (el.querySelector('a, button, input, select, textarea, [tabindex], [contenteditable]')) return;
  const options = resolveOptions(el, defaults, opts);
  const words = options.words.filter((word): word is string => typeof word === 'string' && word.trim().length > 0).slice(0, 12);
  if (!words.length) words.push(...defaults.words);
  const interval = Math.min(30000, Math.max(1500, options.interval));
  setVars(el, PREFIX, { duration: `${Math.min(800, Math.max(0, options.duration))}ms` });
  const original = Array.from(el.childNodes);
  const readable = document.createElement('span'); readable.className = `${PREFIX}__readable`; readable.textContent = words.join(', ');
  const stage = document.createElement('span'); stage.className = `${PREFIX}__stage`; stage.setAttribute('aria-hidden', 'true');
  const pieces = words.map((word, index) => { const piece = document.createElement('span'); piece.textContent = word; piece.className = `${PREFIX}__word`; piece.classList.toggle(`${PREFIX}__word--current`, index === 0); stage.append(piece); return piece; });
  const button = document.createElement('button'); button.type = 'button'; button.className = `${PREFIX}__pause`;
  el.replaceChildren(readable, stage, button);
  let timer: ReturnType<typeof setTimeout> | undefined; let index = 0; let paused = false; let hovered = false; let inView = true;
  const stop = (): void => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const sync = (): void => {
   stop(); button.textContent = motion.reduced ? 'Motion off' : paused ? 'Resume' : 'Pause'; button.setAttribute('aria-label', motion.reduced ? 'Rotating text motion off' : `${paused ? 'Resume' : 'Pause'} rotating text`); button.setAttribute('aria-pressed', String(paused || motion.reduced)); button.setAttribute('aria-disabled', String(motion.reduced)); button.hidden = words.length < 2;
   if (paused || hovered || !inView || document.hidden || motion.reduced || signal.aborted || words.length < 2) return;
   timer = setTimeout(() => { pieces[index]!.classList.remove(`${PREFIX}__word--current`); index = (index + 1) % pieces.length; pieces[index]!.classList.add(`${PREFIX}__word--current`); sync(); }, interval);
  };
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); sync(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  button.addEventListener('click', () => { if (motion.reduced) return; paused = !paused; sync(); }, { signal });
  stage.addEventListener('pointerenter', () => { hovered = true; sync(); }, { signal });
  stage.addEventListener('pointerleave', () => { hovered = false; sync(); }, { signal });
  document.addEventListener('visibilitychange', sync, { signal });
  if (typeof IntersectionObserver === 'function') {
   const io = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); sync(); }); io.observe(el); onDestroy(() => io.disconnect());
  }
  onDestroy(() => { stop(); el.replaceChildren(...original); }); sync();
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
