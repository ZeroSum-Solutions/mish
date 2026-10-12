/**
 * card-nav — clean-room implementation from the effect description ("Card-based navigation
 * treatment") only. A compact top bar holds a menu toggle; opening it grows the bar downward
 * (a `grid-template-rows` 0fr -> 1fr transition) and reveals a row of tinted link cards that
 * fade and rise in with a stagger. No GSAP: every motion is a CSS transition driven by one class.
 *
 * DOM contract: the host (normally a `<nav>`) holds a `<button class="genui-card-nav__toggle">`
 * and a `.genui-card-nav__panel` whose single child wraps the `.genui-card-nav__card`s. Without
 * script the panel is simply shown, so no link is ever unreachable. With script, `mount` wires
 * `aria-expanded`/`aria-controls`, closes on Esc (focus returns to the toggle), on a pointer down
 * outside the host and, with `closeOnLink`, after a link inside the panel is chosen.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-card-nav` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'card-nav';
const PREFIX = `genui-${id}`;
const READY_CLASS = `${PREFIX}--ready`;
const OPEN_CLASS = `${PREFIX}--open`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface CardNavOptions {
  [key: string]: string | number | boolean;
  /** Open/close transition length, in ms. */
  duration: number;
  /** Delay between each card's entrance, in ms. */
  stagger: number;
  /** Corner radius of the bar and cards. */
  radius: string;
  /** Start with the cards shown. */
  open: boolean;
  /** Close when the pointer goes down outside the navigation. */
  closeOnOutside: boolean;
  /** Close after a link inside the panel is chosen. */
  closeOnLink: boolean;
}

export const defaults: CardNavOptions = {
  duration: 420,
  stagger: 60,
  radius: '14px',
  open: false,
  closeOnOutside: true,
  closeOnLink: true,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: CardNavOptions): Record<string, string> {
  return {
    duration: `${Math.max(0, options.duration)}ms`,
    stagger: `${Math.max(0, options.stagger)}ms`,
    radius: options.radius,
  };
}

let uid = 0;

export function mount(el: HTMLElement, opts: Partial<CardNavOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const toggle = el.querySelector<HTMLButtonElement>(`.${PREFIX}__toggle`);
    const panel = el.querySelector<HTMLElement>(`.${PREFIX}__panel`);
    if (!toggle || !panel) return; // nothing to drive: the panel stays in its always-shown state.

    onDestroy(snapshotAttributes(toggle, ['aria-expanded', 'aria-controls']));
    onDestroy(snapshotAttributes(panel, ['id']));
    if (!panel.id) panel.id = `${PREFIX}-panel-${(uid += 1)}`;
    toggle.setAttribute('aria-controls', panel.id);

    const setOpen = (open: boolean): void => {
      el.classList.toggle(OPEN_CLASS, open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    const isOpen = (): boolean => el.classList.contains(OPEN_CLASS);
    setOpen(options.open);
    el.classList.add(READY_CLASS);

    toggle.addEventListener('click', () => { setOpen(!isOpen()); }, { signal });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !isOpen()) return;
      event.preventDefault();
      setOpen(false);
      toggle.focus();
    }, { signal });
    if (options.closeOnLink) {
      panel.addEventListener('click', (event) => {
        if ((event.target as Element | null)?.closest?.('a[href]')) setOpen(false);
      }, { signal });
    }
    if (options.closeOnOutside) {
      el.ownerDocument.addEventListener('pointerdown', (event) => {
        if (isOpen() && !el.contains(event.target as Node | null)) setOpen(false);
      }, { signal, passive: true });
    }
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
