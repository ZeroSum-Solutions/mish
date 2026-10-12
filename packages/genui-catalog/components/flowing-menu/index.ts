/**
 * flowing-menu — clean-room implementation from the effect name and the one-line description
 * "Flowing menu treatment" only. No upstream source was read and no animation library is used.
 *
 * A stacked list of large menu links. When the pointer enters a link, a solid band flows in from
 * the edge it came through (top or bottom) and carries a looping marquee of the link's label; on
 * leave the band flows out through the edge the pointer left by. The band's content counter-slides,
 * so the text looks fixed while the band wipes over it. Keyboard focus plays the same flow (in from
 * the top, out through the bottom). All motion is CSS transitions and one CSS keyframe loop that
 * only runs while a band is shown, so nothing animates off-screen or at rest.
 *
 * DOM contract: the host (normally a `<nav>`) holds `<a>` links, inside a
 * `.genui-flowing-menu__list` when there is one. An optional `.genui-flowing-menu__toggle` button
 * makes the list collapsible: its `aria-expanded` tracks the state and Escape closes the list and
 * returns focus to it. Without a toggle the list is always shown.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts` (unknown
 * keys dropped), adds `.genui-flowing-menu` and `data-genui-mounted`, and returns a handle whose
 * `destroy()` restores `el.outerHTML` exactly (bands removed, link and toggle attributes restored).
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'flowing-menu';
const PREFIX = `genui-${id}`;
const OPEN_CLASS = `${PREFIX}--open`;
const READY_CLASS = `${PREFIX}--ready`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const FLOW = `${PREFIX}__flow`;
const ON = `${FLOW}--on`;
const TOP = `${FLOW}--top`;
const SNAP = `${FLOW}--snap`;

export interface FlowingMenuOptions {
  [key: string]: string | number | boolean;
  /** Seconds for one full marquee loop inside the band. */
  speed: number;
  /** Time the band takes to flow in or out, in ms. */
  duration: number;
  /** Label copies in each half of the marquee (1 to 8). */
  repeat: number;
  /** Row height (any CSS length). */
  height: string;
  /** Link text colour. */
  ink: string;
  /** Band colour. */
  band: string;
  /** Text colour inside the band. */
  bandInk: string;
  /** Divider line colour between rows. */
  rule: string;
  /** Start open when a toggle button is present. */
  open: boolean;
}

export const defaults: FlowingMenuOptions = {
  speed: 10,
  duration: 480,
  repeat: 4,
  height: '56px',
  ink: '#f5f5f7',
  band: '#f5f5f7',
  bandInk: '#0b0d12',
  rule: 'rgba(245,245,247,.16)',
  open: true,
};

const copies = (options: FlowingMenuOptions): number => Math.min(8, Math.max(1, Math.round(options.repeat)));

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: FlowingMenuOptions): Record<string, string> {
  return {
    speed: `${Math.max(0.5, options.speed)}s`,
    duration: `${Math.max(0, options.duration)}ms`,
    height: options.height,
    ink: options.ink,
    band: options.band,
    'band-ink': options.bandInk,
    rule: options.rule,
  };
}

/** True when the pointer sits in the upper half of `link` (the edge it entered or left by). */
function nearTop(link: HTMLElement, event: PointerEvent): boolean {
  const rect = link.getBoundingClientRect();
  return event.clientY - rect.top < rect.height / 2;
}

export function mount(el: HTMLElement, opts: Partial<FlowingMenuOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));
    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const list = el.querySelector<HTMLElement>(`.${PREFIX}__list`) ?? el;
    const on = { signal };
    list.querySelectorAll<HTMLAnchorElement>('a').forEach((link) => {
      onDestroy(snapshotAttributes(link, ['class']));
      link.classList.add(`${PREFIX}__link`);
      const label = (link.textContent ?? '').trim();

      // The band: decorative, hidden from assistive tech; the link keeps its own name.
      const flow = document.createElement('span');
      flow.className = FLOW;
      flow.setAttribute('aria-hidden', 'true');
      const track = document.createElement('span');
      track.className = `${PREFIX}__track`;
      for (let i = 0; i < copies(options) * 2; i += 1) {
        const word = document.createElement('span');
        word.className = `${PREFIX}__word`;
        word.textContent = label;
        track.append(word);
      }
      flow.append(track);
      link.append(flow);
      onDestroy(() => { flow.remove(); });

      const show = (fromTop: boolean): void => {
        // Park the band on the entry edge with no transition, then let it flow in.
        flow.classList.add(SNAP);
        flow.classList.remove(ON);
        flow.classList.toggle(TOP, fromTop);
        void flow.offsetWidth;
        flow.classList.remove(SNAP);
        flow.classList.add(ON);
      };
      const hide = (toTop: boolean): void => {
        flow.classList.toggle(TOP, toTop);
        flow.classList.remove(ON);
      };
      link.addEventListener('pointerenter', (event) => { show(nearTop(link, event)); }, on);
      link.addEventListener('pointerleave', (event) => { if (link !== document.activeElement) hide(nearTop(link, event)); }, on);
      link.addEventListener('focus', () => { show(true); }, on);
      link.addEventListener('blur', () => { hide(false); }, on);
    });

    const toggle = el.querySelector<HTMLElement>(`.${PREFIX}__toggle`);
    if (!toggle || list === el) return;

    onDestroy(snapshotAttributes(toggle, ['aria-expanded']));
    let open = false;
    const set = (next: boolean): void => {
      open = next;
      el.classList.toggle(OPEN_CLASS, next);
      toggle.setAttribute('aria-expanded', String(next));
    };
    set(options.open);
    el.classList.add(READY_CLASS); // the list can hide only now that the toggle can show it again

    toggle.addEventListener('click', () => { set(!open); }, on);
    el.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape' || !open) return;
      event.preventDefault();
      set(false);
      toggle.focus();
    }, on);
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
