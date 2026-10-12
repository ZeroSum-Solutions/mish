// Original tiled face switch. Only an explicit button changes the semantic view.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, snapshotAttributes, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'pixel-transition';
const PREFIX = `genui-${id}`;
export interface PixelTransitionOptions { [key: string]: number | string; duration: number; columns: number; label: string; }
export const defaults: PixelTransitionOptions = { duration: 480, columns: 8, label: 'Show alternate view' };
export function mount(el: HTMLElement, opts: Partial<PixelTransitionOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  const original = Array.from(el.childNodes);
  const faces = Array.from(el.querySelectorAll<HTMLElement>(':scope > [data-pixel-face]')).slice(0, 2);
  if (faces.length !== 2) return;
  const duration = Math.min(1200, Math.max(0, options.duration));
  const columns = Math.min(16, Math.max(2, Math.round(options.columns)));
  const rows = Math.ceil(columns / 2);
  const step = Math.min(8, duration / (columns * 6));
  const lastDelay = (columns - 1) * step;
  setVars(el, PREFIX, { duration: `${duration}ms`, columns, rows });
  const stage = document.createElement('div'); stage.className = `${PREFIX}__stage`;
  for (const face of faces) {
   const restore = snapshotAttributes(face, ['class', 'hidden', 'inert', 'aria-hidden']); onDestroy(restore);
   face.classList.add(`${PREFIX}__face`); stage.append(face);
  }
  const tiles = document.createElement('div'); tiles.className = `${PREFIX}__tiles`; tiles.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < columns * rows; i++) { const tile = document.createElement('span'); tile.style.setProperty(`--${PREFIX}-delay`, `${i % columns * step}ms`); tiles.append(tile); }
  stage.append(tiles);
  const button = document.createElement('button'); button.type = 'button'; button.className = `${PREFIX}__toggle`;
  el.replaceChildren(stage, button);
  let alternate = false; let swap: ReturnType<typeof setTimeout> | undefined; let end: ReturnType<typeof setTimeout> | undefined;
  const show = (): void => {
   faces.forEach((face, index) => { const inactive = (index === 1) !== alternate; face.removeAttribute('hidden'); face.classList.toggle(`${PREFIX}__face--inactive`, inactive); face.setAttribute('aria-hidden', String(inactive)); face.inert = inactive; });
   button.textContent = alternate ? 'Show original view' : options.label; button.setAttribute('aria-pressed', String(alternate));
  };
  const settle = (): void => { if (swap !== undefined) clearTimeout(swap); if (end !== undefined) clearTimeout(end); swap = end = undefined; el.classList.remove(`${PREFIX}--play`); show(); };
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); if (value) settle(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  button.addEventListener('click', () => {
   settle(); alternate = !alternate;
   if (motion.reduced || duration < 160) { show(); return; }
   // Flush the previous finished animation so consecutive clicks replay the cover.
   void tiles.offsetWidth; el.classList.add(`${PREFIX}--play`);
   // All tiles share a fully opaque plateau; switch at the center of their overlap.
   // The leading tile must still be opaque when the last delayed tile has covered.
   swap = setTimeout(() => { swap = undefined; show(); }, duration / 2 + lastDelay / 2);
   end = setTimeout(settle, duration + lastDelay);
  }, { signal });
  onDestroy(() => { settle(); el.replaceChildren(...original); }); show();
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
