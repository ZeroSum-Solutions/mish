// Original looping marks. Real nodes retain their identity; the visual copy is inert.
import { autoInitComponent, mountComponent, resolveOptions, setVars, watchReducedMotion, type GenuiHandle } from '../../src/runtime/shared.ts';
export type { GenuiHandle };
export const id = 'logo-loop';
const PREFIX = `genui-${id}`;
export interface LogoLoopOptions { [key: string]: number; duration: number; gap: number; }
export const defaults: LogoLoopOptions = { duration: 18000, gap: 48 };
export function mount(el: HTMLElement, opts: Partial<LogoLoopOptions> = {}): GenuiHandle {
 return mountComponent(id, el, ({ signal, onDestroy }) => {
  const options = resolveOptions(el, defaults, opts);
  setVars(el, PREFIX, { duration: `${Math.min(30000, Math.max(4000, options.duration))}ms`, gap: `${Math.min(160, Math.max(8, options.gap))}px` });
  const original = Array.from(el.childNodes);
  const viewport = document.createElement('div'); viewport.className = `${PREFIX}__viewport`;
  const rail = document.createElement('div'); rail.className = `${PREFIX}__rail`;
  const group = document.createElement('div'); group.className = `${PREFIX}__group`; group.append(...original);
  const clone = group.cloneNode(true) as HTMLElement; clone.classList.add(`${PREFIX}__copy`); clone.setAttribute('aria-hidden', 'true'); clone.inert = true;
  // IDs and controls belong only to the original, even in engines without inert support.
  clone.removeAttribute('id');
  for (const node of Array.from(clone.querySelectorAll('[id], a, button, input, select, textarea, [tabindex], [contenteditable]'))) { node.removeAttribute('id'); if (node instanceof HTMLElement) { node.tabIndex = -1; node.removeAttribute('name'); node.removeAttribute('contenteditable'); if ('disabled' in node) (node as HTMLButtonElement).disabled = true; } }
  rail.append(group, clone); viewport.append(rail);
  const button = document.createElement('button'); button.type = 'button'; button.className = `${PREFIX}__pause`;
  el.replaceChildren(viewport, button);
  let paused = false; let hovered = false; let focused = false; let inView = true;
  const sync = (): void => {
   el.classList.toggle(`${PREFIX}--paused`, paused || hovered || focused || !inView || document.hidden || motion.reduced);
   button.textContent = motion.reduced ? 'Motion off' : paused ? 'Resume motion' : 'Pause motion'; button.setAttribute('aria-label', motion.reduced ? 'Logo loop motion off' : `${paused ? 'Resume' : 'Pause'} logo loop`); button.setAttribute('aria-pressed', String(paused || motion.reduced)); button.setAttribute('aria-disabled', String(motion.reduced));
  };
  const motion = watchReducedMotion(signal, value => { el.classList.toggle(`${PREFIX}--reduced`, value); sync(); });
  el.classList.toggle(`${PREFIX}--reduced`, motion.reduced);
  const resize = (): void => setVars(el, PREFIX, { width: `${el.clientWidth}px` }); resize();
  if (typeof ResizeObserver === 'function') { const ro = new ResizeObserver(resize); ro.observe(el); onDestroy(() => ro.disconnect()); }
  else window.addEventListener('resize', resize, { passive: true, signal });
  if (typeof IntersectionObserver === 'function') { const io = new IntersectionObserver(entries => { inView = entries.some(entry => entry.isIntersecting); sync(); }); io.observe(el); onDestroy(() => io.disconnect()); }
  else {
   const checkView = (): void => { const rect = el.getBoundingClientRect(); inView = rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight; sync(); };
   window.addEventListener('scroll', checkView, { passive: true, capture: true, signal });
   window.addEventListener('resize', checkView, { passive: true, signal }); checkView();
  }
  button.addEventListener('click', () => { if (motion.reduced) return; paused = !paused; sync(); }, { signal });
  viewport.addEventListener('pointerenter', () => { hovered = true; sync(); }, { signal });
  viewport.addEventListener('pointerleave', () => { hovered = false; sync(); }, { signal });
  viewport.addEventListener('focusin', () => { focused = true; sync(); }, { signal });
  viewport.addEventListener('focusout', event => { if (!viewport.contains(event.relatedTarget as Node | null)) { focused = false; sync(); } }, { signal });
  document.addEventListener('visibilitychange', sync, { signal });
  onDestroy(() => el.replaceChildren(...original)); sync();
 });
}
export function autoInit(root: ParentNode = document): GenuiHandle[] { return autoInitComponent(id, el => mount(el), root); }
