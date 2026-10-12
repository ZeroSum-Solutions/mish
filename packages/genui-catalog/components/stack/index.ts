/**
 * stack — clean-room implementation from component-specs.md §17 only. Cards form a physical
 * pile; each lower card sits at a small seeded offset and rotation, so the pile looks the same
 * on every load. The top card can be dragged: past `dragThreshold` it flies to the back with a
 * spring, short of it it springs back. `sendToBackOnClick` also sends the top card to the back
 * on click, Enter or Space. Reordering moves DOM nodes, so reading order tracks the pile order.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-stack` and `data-genui-mounted`, and returns a handle
 * whose `destroy()` restores `el.outerHTML` exactly.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, resolveOptions, setVars,
  snapshotAttributes, springEasing, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'stack';
const PREFIX = `genui-${id}`;
const CARD = `${PREFIX}__card`;
const HIDDEN_CLASS = `${CARD}--hidden`;
const DRAGGING_CLASS = `${CARD}--dragging`;
const ORDINAL_ATTR = 'data-genui-stack-index';
const DEFAULT_LABEL = 'Send card to back';

export interface StackOptions {
  [key: string]: string | number | boolean | { readonly [key: string]: unknown };
  sendToBackOnClick: boolean;
  dragThreshold: number;
  rotateRange: number;
  offset: number;
  spring: { stiffness: number; damping: number };
  seed: number;
  visible: number;
}

export const defaults: StackOptions = {
  sendToBackOnClick: true,
  dragThreshold: 120,
  rotateRange: 6,
  offset: 6,
  spring: { stiffness: 260, damping: 20 },
  seed: 1,
  visible: 4,
};

/** Deterministic pseudo-random value in [-1, 1] for (seed, depth) — same on every load. */
function seededUnit(seed: number, i: number): number {
  let h = Math.imul(seed ^ i, 0x27d4_eb2d);
  h = (h ^ (h >>> 15)) >>> 0;
  h = Math.imul(h, 0x85eb_ca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  return (h % 2000) / 1000 - 1;
}

function cardLabel(card: HTMLElement): string {
  return card.dataset.genuiStackLabel ?? DEFAULT_LABEL;
}

export function mount(el: HTMLElement, opts: Partial<StackOptions> = {}): GenuiHandle {
  return mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    el.style.position = 'relative';
    el.setAttribute('role', 'list');

    const status = document.createElement('div');
    status.className = `${CARD.replace('__card', '__status')}`;
    status.setAttribute('aria-live', 'polite');
    status.style.cssText =
      'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    el.append(status);

    const originalOrder = Array.from(el.querySelectorAll<HTMLElement>(`:scope > .${CARD}`));
    const cardRestores = originalOrder.map((card) =>
      snapshotAttributes(card, ['class', 'style', 'role', 'tabindex', 'aria-label', ORDINAL_ATTR]));
    originalOrder.forEach((card, i) => {
      if (!card.hasAttribute(ORDINAL_ATTR)) card.setAttribute(ORDINAL_ATTR, String(i + 1));
      card.style.position = 'absolute';
      card.style.inset = '0';
    });

    const motion = watchReducedMotion(signal);
    const anims = createAnimationSet();

    const currentCards = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>(`:scope > .${CARD}`));

    const applyLayout = (): HTMLElement[] => {
      const cards = currentCards();
      const total = cards.length;
      cards.forEach((card, i) => {
        card.style.zIndex = String(total - i);
        card.classList.toggle(HIDDEN_CLASS, i >= options.visible);
        const y = i === 0 ? 0 : i * options.offset;
        const r = i === 0 ? 0 : seededUnit(options.seed, i) * options.rotateRange;
        setVars(card, PREFIX, { r: `${r.toFixed(2)}deg`, y: `${y}px` });
        if (i === 0) {
          card.setAttribute('tabindex', '0');
          card.setAttribute('role', 'button');
          card.setAttribute('aria-label', cardLabel(card));
        } else {
          card.removeAttribute('tabindex');
          card.setAttribute('role', 'listitem');
          card.removeAttribute('aria-label');
        }
      });
      return cards;
    };

    const focusNewTop = (cards: HTMLElement[]): void => {
      const top = cards[0];
      if (!top) return;
      top.focus();
      status.textContent = `Card ${top.getAttribute(ORDINAL_ATTR)} of ${cards.length}`;
    };

    const sendToBack = (card: HTMLElement): void => {
      const total = currentCards().length;
      const settle = (): void => {
        card.style.transform = '';
        el.append(card);
        focusNewTop(applyLayout());
      };
      const canAnimate = !motion.reduced && typeof card.animate === 'function';
      if (!canAnimate) { settle(); return; }
      const easing = springEasing(options.spring.stiffness, options.spring.damping);
      const anim = anims.play(card, [
        { transform: `translateY(${total * options.offset}px) rotate(4deg)`, opacity: 1 },
        { transform: `translateY(${(total + 5) * options.offset}px) rotate(-6deg)`, opacity: 0.7 },
      ], { duration: 240, easing });
      if (!anim) { settle(); return; }
      anim.finished.then(settle, settle);
    };

    applyLayout();

    const onClick = (event: MouseEvent): void => {
      if (!options.sendToBackOnClick) return;
      const top = currentCards()[0];
      if (!top || !(event.target instanceof Node) || !top.contains(event.target)) return;
      sendToBack(top);
    };
    const onKeydown = (event: KeyboardEvent): void => {
      if (!options.sendToBackOnClick || (event.key !== 'Enter' && event.key !== ' ')) return;
      const top = currentCards()[0];
      if (event.target !== top) return;
      event.preventDefault();
      sendToBack(top);
    };
    el.addEventListener('click', onClick, { signal });
    el.addEventListener('keydown', onKeydown, { signal });

    let dragging: HTMLElement | null = null;
    let startX = 0;
    let startY = 0;
    const onPointerDown = (event: PointerEvent): void => {
      if (motion.reduced) return;
      const top = currentCards()[0];
      if (!top || !(event.target instanceof Node) || !top.contains(event.target)) return;
      dragging = top;
      startX = event.clientX;
      startY = event.clientY;
      top.setPointerCapture?.(event.pointerId);
      top.classList.add(DRAGGING_CLASS);
    };
    const onPointerMove = (event: PointerEvent): void => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      dragging.style.transform = `translate(${dx}px, ${dy}px) rotate(${(dx / 24).toFixed(2)}deg)`;
    };
    const endDrag = (event: PointerEvent): void => {
      if (!dragging) return;
      const card = dragging;
      dragging = null;
      card.classList.remove(DRAGGING_CLASS);
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.hypot(dx, dy) > options.dragThreshold) {
        sendToBack(card);
        return;
      }
      const easing = springEasing(options.spring.stiffness, options.spring.damping);
      const from = card.style.transform || 'translate(0, 0) rotate(0deg)';
      const anim = anims.play(card, [{ transform: from }, { transform: 'translate(0, 0) rotate(0deg)' }], {
        duration: 280,
        easing,
      });
      const reset = (): void => { card.style.transform = ''; };
      if (anim) anim.finished.then(reset, reset); else reset();
    };
    el.addEventListener('pointerdown', onPointerDown, { signal });
    el.addEventListener('pointermove', onPointerMove, { signal });
    el.addEventListener('pointerup', endDrag, { signal });
    el.addEventListener('pointercancel', endDrag, { signal });

    onDestroy(() => {
      anims.cancelAll();
      for (const restore of cardRestores) restore();
      for (const card of originalOrder) el.append(card);
      status.remove();
    });
  }, ['role']);
}

export function autoInit(root: ParentNode = document): GenuiHandle[] {
  return autoInitComponent(id, (el) => mount(el), root);
}
