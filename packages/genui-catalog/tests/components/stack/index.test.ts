// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { id, mount } from '../../../components/stack/index.ts';
import { stubAnimate, stubMatchMedia, unstubAnimate } from '../../_helpers.ts';

function host(cardCount = 5): HTMLElement {
  const el = document.createElement('div');
  el.dataset.genui = id;
  for (let i = 0; i < cardCount; i += 1) {
    const card = document.createElement('div');
    card.className = 'genui-stack__card';
    card.textContent = `Card ${i + 1}`;
    el.append(card);
  }
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
  unstubAnimate();
});

describe(id, () => {
  it('mount sets tabindex="0" on the top card only and assigns distinct z-indexes', () => {
    const el = host();
    const handle = mount(el);
    const cards = Array.from(el.querySelectorAll<HTMLElement>('.genui-stack__card'));
    expect(cards.filter((card) => card.getAttribute('tabindex') === '0')).toHaveLength(1);
    expect(cards[0]?.getAttribute('tabindex')).toBe('0');
    const zIndexes = cards.map((card) => card.style.zIndex);
    expect(new Set(zIndexes).size).toBe(cards.length);
    handle.destroy();
  });

  it('Enter on the top card moves it to the DOM end and moves focus to the new top card', () => {
    const el = host();
    const handle = mount(el);
    const originalTop = el.querySelectorAll<HTMLElement>('.genui-stack__card')[0]!;
    const newTop = el.querySelectorAll<HTMLElement>('.genui-stack__card')[1]!;
    originalTop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const cardsAfter = Array.from(el.querySelectorAll<HTMLElement>('.genui-stack__card'));
    expect(cardsAfter[cardsAfter.length - 1]).toBe(originalTop);
    expect(cardsAfter[0]).toBe(newTop);
    expect(document.activeElement).toBe(newTop);
    handle.destroy();
  });

  it('with reduced motion the reorder happens with no animate calls', () => {
    stubMatchMedia(true);
    const calls = stubAnimate();
    const el = host();
    const handle = mount(el);
    const originalTop = el.querySelectorAll<HTMLElement>('.genui-stack__card')[0]!;
    originalTop.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(calls).toHaveLength(0);
    expect(el.querySelectorAll<HTMLElement>('.genui-stack__card')[0]).not.toBe(originalTop);
    handle.destroy();
  });

  it('destroy() restores the original child order and outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el);
    const top = el.querySelectorAll<HTMLElement>('.genui-stack__card')[0]!;
    top.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    handle.destroy();
    expect(el.getAttribute('role')).toBeNull();
    expect(el.querySelector('[role="button"]')).toBeNull();
    expect(el.querySelector('[tabindex]')).toBeNull();
    expect(el.querySelector('.genui-stack__status')).toBeNull();
    expect(el.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });
});
