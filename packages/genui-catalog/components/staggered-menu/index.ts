/**
 * staggered-menu — clean-room implementation from the effect name and the one-line description
 * "Multi-layer menu entrance" only. No upstream source was read and no animation library is used.
 *
 * A toggle button opens a side panel. Before the panel arrives, `layers` coloured sheets sweep in
 * from the same edge one after another, then the panel lands on top and its links rise in with a
 * per-link stagger. Closing plays the sequence in reverse. All motion is CSS transitions driven by
 * one open class and per-element custom properties; the script only wires state and keyboard.
 *
 * DOM contract: the host (normally a `<nav>`) holds a `.genui-staggered-menu__toggle` button and a
 * `.genui-staggered-menu__panel` whose `<a>` elements are staggered. The panel is positioned against
 * the nearest positioned ancestor (or the viewport with `fixed`). Without both parts the host mounts
 * but nothing is wired and the panel is never hidden.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts` (unknown
 * keys dropped), adds `.genui-staggered-menu` and `data-genui-mounted`, and returns a handle whose
 * `destroy()` restores `el.outerHTML` exactly (layers removed, toggle and link attributes restored).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'staggered-menu';
const PREFIX = `genui-${id}`;
const OPEN_CLASS = `${PREFIX}--open`;
const READY_CLASS = `${PREFIX}--ready`;
const REDUCED_CLASS = `${PREFIX}--reduced`;

export interface StaggeredMenuOptions {
  [key: string]: string | number | boolean;
  /** Edge the layers and panel enter from. */
  position: 'right' | 'left';
  /** Coloured sheets that sweep in before the panel (0 to 4). */
  layers: number;
  /** Comma-separated layer colours, cycled when there are more layers than colours. */
  layerColors: string;
  panelColor: string;
  /** Text colour inside the panel. */
  ink: string;
  accent: string;
  /** Panel width (any CSS length); it never exceeds the container. */
  width: string;
  /** Slide time of each layer and of the panel, in ms. */
  duration: number;
  /** Delay between consecutive layers and between links, in ms. */
  stagger: number;
  /** Show a small 01, 02 index after each list link. */
  numbered: boolean;
  /** Close the menu when a link inside the panel is activated. */
  closeOnSelect: boolean;
  /** Cover the viewport (position: fixed) instead of the nearest positioned ancestor. */
  fixed: boolean;
}

export const defaults: StaggeredMenuOptions = {
  position: 'right',
  layers: 2,
  layerColors: '#5b4bff,#b7a8ff',
  panelColor: '#f5f3ee',
  ink: '#101217',
  accent: '#5b4bff',
  width: '280px',
  duration: 560,
  stagger: 60,
  numbered: true,
  closeOnSelect: true,
  fixed: false,
};

const layerCount = (options: StaggeredMenuOptions): number => Math.min(4, Math.max(0, Math.round(options.layers)));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: StaggeredMenuOptions): Record<string, string> {
  return {
    duration: `${Math.max(0, options.duration)}ms`,
    stagger: `${Math.max(0, options.stagger)}ms`,
    n: String(layerCount(options)),
    panel: options.panelColor,
    ink: options.ink,
    accent: options.accent,
    width: options.width,
  };
}

export function mount(el: HTMLElement, opts: Partial<StaggeredMenuOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    el.classList.toggle(`${PREFIX}--left`, options.position === 'left');
    el.classList.toggle(`${PREFIX}--numbered`, options.numbered);
    el.classList.toggle(`${PREFIX}--fixed`, options.fixed);
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const toggle = el.querySelector<HTMLElement>(`.${PREFIX}__toggle`);
    const panel = el.querySelector<HTMLElement>(`.${PREFIX}__panel`);
    if (!toggle || !panel) return;

    onDestroy(snapshotAttributes(toggle, ['aria-expanded']));
    panel.querySelectorAll('a').forEach((link, index) => {
      onDestroy(snapshotAttributes(link, ['style']));
      link.style.setProperty(`--${PREFIX}-i`, String(index));
    });

    // Decorative sheets, inserted just before the panel so the panel paints above them.
    const colors = options.layerColors.split(',').map((c) => c.trim()).filter(Boolean);
    const layers: HTMLElement[] = [];
    for (let i = 0; i < layerCount(options); i += 1) {
      const layer = document.createElement('div');
      layer.className = `${PREFIX}__layer`;
      layer.setAttribute('aria-hidden', 'true');
      layer.style.setProperty(`--${PREFIX}-i`, String(i));
      if (colors.length) layer.style.background = colors[i % colors.length] ?? '';
      layers.push(layer);
    }
    panel.before(...layers);
    onDestroy(() => { for (const layer of layers) layer.remove(); });

    let open = false;
    const set = (next: boolean): void => {
      open = next;
      el.classList.toggle(OPEN_CLASS, next);
      toggle.setAttribute('aria-expanded', String(next));
    };
    set(false);
    el.classList.add(READY_CLASS); // hide the panel only now that the toggle can reveal it

    toggle.addEventListener('click', () => { set(!open); }, { signal });
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      set(false);
      toggle.focus();
    }, { signal });
    panel.addEventListener('click', (event) => {
      if (options.closeOnSelect && (event.target as Element | null)?.closest?.('a')) set(false);
    }, { signal });
    document.addEventListener('click', (event) => {
      if (open && !el.contains(event.target as Node | null)) set(false);
    }, { signal });
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
