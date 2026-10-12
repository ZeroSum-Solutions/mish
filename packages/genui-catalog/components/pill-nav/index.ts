/**
 * pill-nav — clean-room implementation from the effect description ("Pill-shaped navigation
 * treatment") only. Links sit inside a rounded pill track; one solid pill indicator slides and
 * resizes (a springy CSS transition) to the current link and follows the hovered or focused one,
 * returning to the current link when the pointer or focus leaves. On a narrow host the track
 * collapses behind a round menu button and opens as a dropdown card of stacked pills. No GSAP:
 * every motion is a CSS transition on inline geometry written here.
 *
 * DOM contract: the host (normally a `<nav>`) holds a `<ul class="genui-pill-nav__list">` of
 * `<li><a class="genui-pill-nav__link">` items, an optional `.genui-pill-nav__logo` and an optional
 * `<button class="genui-pill-nav__toggle">`. The current link carries `aria-current="page"`.
 * With a toggle, `mount` wires `aria-expanded`/`aria-controls`, closes on Esc (focus returns to
 * the toggle), on a pointer down outside the host and after a link is chosen.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-pill-nav` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'pill-nav';
const PREFIX = `genui-${id}`;
const REDUCED_CLASS = `${PREFIX}--reduced`;
const COMPACT_CLASS = `${PREFIX}--compact`;
const OPEN_CLASS = `${PREFIX}--open`;
const ON_CLASS = `${PREFIX}__link--on`;

export interface PillNavOptions {
  [key: string]: string | number | boolean;
  /** Indicator slide length, in ms. */
  duration: number;
  /** Corner radius of the track, pills and indicator. */
  radius: string;
  /** Indicator fill colour. */
  accent: string;
  /** Link text colour while the indicator sits under it. */
  accentText: string;
  /** Collapse behind the menu button when the host is narrower than this, in px (0 never collapses). */
  collapseBelow: number;
  /** Move the indicator to the hovered or focused link. */
  followHover: boolean;
  /** Make a clicked link the current one (aria-current="page"). */
  trackActive: boolean;
  /** Close the collapsed menu when the pointer goes down outside the navigation. */
  closeOnOutside: boolean;
}

export const defaults: PillNavOptions = {
  duration: 380,
  radius: '999px',
  accent: '#f5f5f7',
  accentText: '#0b0d12',
  collapseBelow: 480,
  followHover: true,
  trackActive: true,
  closeOnOutside: true,
};

/** The custom properties `mount` writes for a set of options. */
export function toVars(options: PillNavOptions): Record<string, string> {
  return {
    duration: `${Math.max(0, options.duration)}ms`,
    radius: options.radius,
    accent: options.accent,
    'accent-text': options.accentText,
  };
}

let uid = 0;

export function mount(el: HTMLElement, opts: Partial<PillNavOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    setVars(el, PREFIX, toVars(options));

    const motion = watchReducedMotion(signal, (reduced) => { el.classList.toggle(REDUCED_CLASS, reduced); });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);

    const list = el.querySelector<HTMLElement>(`.${PREFIX}__list`);
    if (!list) return; // nothing to drive: the links stay as authored.
    const links = Array.from(list.querySelectorAll<HTMLAnchorElement>('a[href]'));
    for (const link of links) onDestroy(snapshotAttributes(link, ['class', 'aria-current']));

    const indicator = document.createElement('span');
    indicator.className = `${PREFIX}__indicator`;
    indicator.setAttribute('aria-hidden', 'true');
    list.append(indicator);
    onDestroy(() => { indicator.remove(); });

    const current = (): HTMLAnchorElement | null => links.find((link) => {
      const value = link.getAttribute('aria-current');
      return value !== null && value !== 'false';
    }) ?? null;

    let target: HTMLAnchorElement | null = null;
    let placed = false;
    const place = (link: HTMLAnchorElement | null): void => {
      target = link;
      for (const each of links) each.classList.toggle(ON_CLASS, each === link);
      const s = indicator.style;
      if (!link) { s.opacity = '0'; return; }
      if (!placed) s.transition = 'none'; // first placement jumps; later ones slide.
      s.opacity = '1';
      s.width = `${link.offsetWidth}px`;
      s.height = `${link.offsetHeight}px`;
      s.transform = `translate(${link.offsetLeft}px,${link.offsetTop}px)`;
      if (!placed) { void indicator.offsetWidth; s.transition = ''; placed = true; }
    };
    const linkOf = (node: EventTarget | null): HTMLAnchorElement | null => {
      const link = (node as Element | null)?.closest?.('a[href]') as HTMLAnchorElement | null | undefined;
      return link && links.includes(link) ? link : null;
    };
    const rest = (): void => { place(current()); };

    if (options.followHover) {
      list.addEventListener('pointerover', (event) => { const link = linkOf(event.target); if (link) place(link); }, { signal });
      list.addEventListener('pointerleave', () => { if (!list.contains(el.ownerDocument.activeElement)) rest(); }, { signal });
      list.addEventListener('focusin', (event) => { const link = linkOf(event.target); if (link) place(link); }, { signal });
      list.addEventListener('focusout', (event) => { if (!list.contains(event.relatedTarget as Node | null)) rest(); }, { signal });
    }

    const toggle = el.querySelector<HTMLButtonElement>(`.${PREFIX}__toggle`);
    const isOpen = (): boolean => el.classList.contains(OPEN_CLASS);
    const setOpen = (open: boolean): void => {
      el.classList.toggle(OPEN_CLASS, open);
      toggle?.setAttribute('aria-expanded', String(open));
    };

    list.addEventListener('click', (event) => {
      const link = linkOf(event.target);
      if (!link) return;
      if (options.trackActive) {
        for (const each of links) each.removeAttribute('aria-current');
        link.setAttribute('aria-current', 'page');
        place(link);
      }
      if (isOpen()) setOpen(false);
    }, { signal });

    if (toggle) {
      onDestroy(snapshotAttributes(toggle, ['aria-expanded', 'aria-controls']));
      onDestroy(snapshotAttributes(list, ['id']));
      if (!list.id) list.id = `${PREFIX}-list-${(uid += 1)}`;
      toggle.setAttribute('aria-controls', list.id);
      setOpen(false);
      toggle.addEventListener('click', () => { setOpen(!isOpen()); }, { signal });
      el.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape' || !isOpen()) return;
        event.preventDefault();
        setOpen(false);
        toggle.focus();
      }, { signal });
      if (options.closeOnOutside) {
        el.ownerDocument.addEventListener('pointerdown', (event) => {
          if (isOpen() && !el.contains(event.target as Node | null)) setOpen(false);
        }, { signal, passive: true });
      }
    }

    // Collapse only when a toggle exists to reopen the list and the host has a measurable width.
    const measure = (): void => {
      const width = el.clientWidth;
      const compact = !!toggle && options.collapseBelow > 0 && width > 0 && width < options.collapseBelow;
      el.classList.toggle(COMPACT_CLASS, compact);
      if (!compact && isOpen()) setOpen(false);
      placed = false;
      place(target);
    };
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => { measure(); });
      ro.observe(el);
      onDestroy(() => { ro.disconnect(); });
    } else {
      el.ownerDocument.defaultView?.addEventListener('resize', measure, { signal });
    }
    target = current();
    measure();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default { id, mount, autoInit };
