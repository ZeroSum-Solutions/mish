/**
 * scroll-choreography — clean-room implementation from component-specs.md §19 only. No upstream
 * (21st.dev) source was fetched, read or recalled; only the spec's prose description was used.
 *
 * Four images sit in a composed 2x2 arrangement inside a pinned stage. As the user scrolls
 * through the track, the three supporting images drift outward, scale down and fade while the
 * hero image (`heroIndex`) grows until it fills the viewport, its corner radius easing to 0. An
 * optional caption fades in near the end of the track. Scrolling back reverses the sequence.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`, adds
 * `.genui-scroll-choreography` and `data-genui-mounted`, and returns a handle whose `destroy()`
 * restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, mountComponent, resolveOptions, setVars, snapshotAttributes, watchReducedMotion,
  type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'scroll-choreography';
const PREFIX = `genui-${id}`;
const ITEM_CLASS = `${PREFIX}__item`;
const STAGE_CLASS = `${PREFIX}__stage`;
const HERO_CLASS = 'is-hero';
const REDUCED_CLASS = `${PREFIX}--reduced`;
/** Direction of each of the 4 quadrant slots, by item index (top-left, top-right, bottom-left, bottom-right). */
const DIRS: ReadonlyArray<readonly [number, number]> = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
/** Snap the eased progress to the target once the gap is this small. */
const SETTLE_EPSILON = 0.0005;

export interface ScrollChoreographyOptions {
  [key: string]: string | number | boolean;
  trackHeight: string;
  /** Which of the 4 items (0-3) grows to fill the viewport. */
  heroIndex: number;
  /** Outward drift of the supporting images, in vw. */
  spread: number;
  /** Corner radius of the hero at the start of the track, in px; eases to 0. */
  startRadius: number;
  /** Track progress (0-1) at which the caption starts fading in. */
  captionAt: number;
  /** rAF lerp factor applied to the scroll progress each frame. */
  smoothing: number;
}

export const defaults: ScrollChoreographyOptions = {
  trackHeight: '300vh',
  heroIndex: 0,
  spread: 40,
  startRadius: 16,
  captionAt: 0.8,
  smoothing: 0.2,
};

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

export function mount(el: HTMLElement, opts: Partial<ScrollChoreographyOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    const heroIndex = Math.min(3, Math.max(0, Math.round(options.heroIndex)));
    setVars(el, PREFIX, {
      spread: options.spread,
      // Names match what styles.css reads: --…-radius and --…-cap-at.
      radius: `${Math.max(0, options.startRadius)}px`,
      'cap-at': clamp01(options.captionAt),
    });

    const items = Array.from(el.querySelectorAll<HTMLElement>(`:scope > .${ITEM_CLASS}`));
    if (items.length !== 4) {
      // eslint-disable-next-line no-console -- authoring feedback; mount stays a no-op otherwise.
      console.warn(`[genui:${id}] expected exactly 4 ".${ITEM_CLASS}" children, found ${items.length}; mount is a no-op.`);
      return;
    }

    // Snapshot each item's own class/style before touching it, so destroy() can restore every
    // item exactly (mountComponent only snapshots the host el).
    const restoreItems = items.map((item) => snapshotAttributes(item, ['class', 'style']));
    onDestroy(() => { for (const restore of restoreItems) restore(); });
    items.forEach((item, index) => {
      const [dx, dy] = DIRS[index]!;
      item.style.setProperty(`--${PREFIX}-dir-x`, String(dx));
      item.style.setProperty(`--${PREFIX}-dir-y`, String(dy));
      item.classList.toggle(HERO_CLASS, index === heroIndex);
    });
    const hero = items[heroIndex]!;

    // Wrap the original children (items + optional caption) in a sticky stage so the track
    // height lives on the host while the visible frame is pinned at 100vh.
    const originalChildren = Array.from(el.childNodes);
    const stage = document.createElement('div');
    stage.className = STAGE_CLASS;
    for (const node of originalChildren) stage.append(node);
    el.append(stage);
    onDestroy(() => {
      for (const node of originalChildren) el.append(node);
      stage.remove();
    });

    // The hero starts at its quadrant tile size and grows to the stage size; --hero-sx/-sy are
    // the scale factors that make it exactly cover the stage at progress 1.
    const measureHero = (): void => {
      const stageRect = stage.getBoundingClientRect();
      const heroW = hero.offsetWidth;
      const heroH = hero.offsetHeight;
      const sx = heroW > 0 && stageRect.width > 0 ? stageRect.width / heroW : 1;
      const sy = heroH > 0 && stageRect.height > 0 ? stageRect.height / heroH : 1;
      setVars(el, PREFIX, { 'hero-sx': sx.toFixed(3), 'hero-sy': sy.toFixed(3) });
    };
    measureHero();
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measureHero());
      ro.observe(stage);
      onDestroy(() => ro.disconnect());
    }

    // --- progress: scroll position -> target -> eased current, one rAF loop -----------------
    let current = 0;
    let target = 0;
    let raf = 0;
    let intersecting = true;
    const hasRaf = typeof requestAnimationFrame === 'function';
    const applyFrame = (p: number): void => { el.style.setProperty(`--${PREFIX}-p`, p.toFixed(4)); };
    const tick = (): void => {
      raf = 0;
      current += (target - current) * options.smoothing;
      if (Math.abs(target - current) < SETTLE_EPSILON) current = target;
      applyFrame(current);
      if (current !== target) schedule();
    };
    const schedule = (): void => {
      if (!intersecting || raf) return;
      if (!hasRaf) { current = target; applyFrame(current); return; }
      raf = requestAnimationFrame(tick);
    };
    const computeTarget = (): number => {
      const rect = el.getBoundingClientRect();
      const vh = typeof innerHeight === 'number' ? innerHeight : 0;
      const total = rect.height - vh;
      return total <= 0 ? 0 : clamp01(-rect.top / total);
    };
    const onScroll = (): void => { target = computeTarget(); schedule(); };

    let stopIO: (() => void) | null = null;
    // A disable (reduced motion switched on) detaches the scroll/resize pair, so a later enable
    // attaches exactly one pair again. `signal` still detaches them on destroy.
    let pinned = false;
    const enablePinned = (): void => {
      if (pinned) return;
      pinned = true;
      el.style.height = options.trackHeight;
      window.addEventListener('scroll', onScroll, { passive: true, signal });
      window.addEventListener('resize', onScroll, { passive: true, signal });
      if (typeof IntersectionObserver === 'function') {
        const io = new IntersectionObserver((entries) => {
          for (const entry of entries) intersecting = entry.isIntersecting;
          if (intersecting) schedule();
        });
        io.observe(el);
        stopIO = () => io.disconnect();
      }
      onScroll();
    };
    const disablePinned = (): void => {
      pinned = false;
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      el.style.height = '';
      stopIO?.();
      stopIO = null;
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
      raf = 0;
      current = 0;
      target = 0;
      applyFrame(current);
    };

    onDestroy(() => {
      stopIO?.();
      if (raf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(raf);
    });

    const motion = watchReducedMotion(signal, (reduced) => {
      el.classList.toggle(REDUCED_CLASS, reduced);
      if (reduced) disablePinned(); else enablePinned();
    });
    el.classList.toggle(REDUCED_CLASS, motion.reduced);
    if (motion.reduced) disablePinned(); else enablePinned();
  });
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}

export default autoInit;
