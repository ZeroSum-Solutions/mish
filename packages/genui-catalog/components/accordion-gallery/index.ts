/**
 * accordion-gallery — clean-room implementation from component-specs.md §5 only. A row of narrow
 * panels, each an image with a label and a link, starts in grayscale at equal width. The hovered
 * or focused panel grows, turns to colour and shows its label and link; siblings shrink. With no
 * hover the `activeIndex` panel is expanded (or none if it is -1). It is css-only: the class and
 * the `--genui-accordion-gallery-*` custom properties are the whole effect (`:hover`,
 * `:focus-within` and `:has()` drive it), so `mount` only maps options to those properties and
 * toggles `.is-active` for `activeIndex`. Reduced motion is handled entirely in `styles.css`
 * (transition durations drop to `0s`), so no JS state follows the preference.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-accordion-gallery` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly (including any `.is-active` it added).
 *
 * `stackBelow` (component-specs.md §5): the 640px stacking breakpoint is baked into
 * `styles.css` as a `@media (max-width: 640px)` rule. `stackBelow` can only lower that
 * breakpoint, never raise it, so `toVars` clamps it to `[0, 640]`; `styles.css` consumes the
 * clamped `--genui-accordion-gallery-stack` value through a `container-type: inline-size`
 * container query on the host, letting the option stack panels earlier than 640px when the
 * host itself renders narrower than the viewport (e.g. inside a sidebar).
 */

import { autoInitComponent, mountComponent, resolveOptions, setVars, type GenuiHandle } from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'accordion-gallery';
const PREFIX = `genui-${id}`;
const PANEL_CLASS = `${PREFIX}__panel`;
const ACTIVE_CLASS = 'is-active';

export interface AccordionGalleryOptions {
  [key: string]: string | number | boolean;
  /** flex-grow ratio of the expanded panel. */
  expand: number;
  /** Grayscale amount (0-1) of a collapsed panel. */
  grayscale: number;
  /** Expand/collapse transition duration in ms. */
  duration: number;
  easing: string;
  /** Panel expanded when nothing is hovered/focused; -1 for none. */
  activeIndex: number;
  height: string;
  /**
   * Viewport width, in px, below which the layout stacks vertically. Can only lower the
   * baked-in 640px default (clamped to [0, 640]); it can never raise it.
   */
  stackBelow: number;
}

export const defaults: AccordionGalleryOptions = {
  expand: 4,
  grayscale: 1,
  duration: 500,
  easing: 'cubic-bezier(.2,.8,.2,1)',
  activeIndex: -1,
  height: '420px',
  stackBelow: 640,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: AccordionGalleryOptions): Record<string, string> {
  return {
    expand: String(Math.max(1, options.expand)),
    gray: String(Math.min(1, Math.max(0, options.grayscale))),
    duration: `${Math.max(0, options.duration)}ms`,
    easing: options.easing,
    height: options.height,
    stack: `${Math.min(640, Math.max(0, options.stackBelow))}px`,
  };
}

function setActivePanel(el: HTMLElement, index: number): void {
  const panels = el.querySelectorAll<HTMLElement>(`.${PANEL_CLASS}`);
  panels.forEach((panel, i) => panel.classList.toggle(ACTIVE_CLASS, i === index));
}

export function mount(el: HTMLElement, opts: Partial<AccordionGalleryOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    setActivePanel(el, options.activeIndex);
    onDestroy(() => setActivePanel(el, -1));
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
