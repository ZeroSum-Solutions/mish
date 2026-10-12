// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/card-swap/index.ts';
import { stubMatchMedia } from '../../_helpers.ts';

function host(cardCount = 3): { el: HTMLElement; cards: HTMLElement[] } {
  const el = document.createElement('div');
  el.dataset.genui = id;
  const cards: HTMLElement[] = [];
  for (let i = 0; i < cardCount; i += 1) {
    const card = document.createElement('div');
    card.className = 'genui-card-swap__card';
    card.textContent = `Card ${i}`;
    el.append(card);
    cards.push(card);
  }
  document.body.append(el);
  return { el, cards };
}

function slotOf(card: HTMLElement): string {
  return card.style.getPropertyValue('--genui-card-swap-slot');
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe(id, () => {
  it('autoInit mounts once, and destroy restores outerHTML exactly', () => {
    const { el } = host();
    const before = el.outerHTML;
    const [handle] = autoInit(document);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('assigns --slot values 0..n-1 to the cards and adds the Next button', () => {
    const { el, cards } = host();
    const handle = mount(el);
    expect(cards.map(slotOf)).toEqual(['0', '1', '2']);
    const next = el.querySelector('.genui-card-swap__next');
    expect(next).not.toBeNull();
    expect(next!.textContent).toBe('Next card');
    handle.destroy();
  });

  it('maps options to custom properties and drops unknown/wrong-typed keys from data-genui-opts', () => {
    const { el } = host();
    el.dataset.genuiOpts = JSON.stringify({ cardDistance: 90, delay: 'soon', bogus: 1 });
    const handle = mount(el, { skewAmount: 10 });
    expect(el.style.getPropertyValue('--genui-card-swap-card-distance')).toBe('90px');
    expect(el.style.getPropertyValue('--genui-card-swap-skew')).toBe('10deg');
    expect(el.style.getPropertyValue('--genui-card-swap-duration')).toBe(`${defaults.duration}ms`);
    expect(el.style.getPropertyValue('--genui-card-swap-bogus')).toBe('');
    handle.destroy();
  });

  it('rotates the slots every `delay` ms, so the front card becomes n-1', () => {
    vi.useFakeTimers();
    const { el, cards } = host();
    const handle = mount(el, { delay: 1000 });
    expect(cards.map(slotOf)).toEqual(['0', '1', '2']);
    vi.advanceTimersByTime(1000);
    expect(cards.map(slotOf)).toEqual(['2', '0', '1']);
    vi.advanceTimersByTime(1000);
    expect(cards.map(slotOf)).toEqual(['1', '2', '0']);
    handle.destroy();
  });

  it('pauses the cycle on pointerenter and resumes on pointerleave', () => {
    vi.useFakeTimers();
    const { el, cards } = host();
    const handle = mount(el, { delay: 1000 });
    el.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(5000);
    expect(cards.map(slotOf)).toEqual(['0', '1', '2']); // no rotation while paused
    el.dispatchEvent(new Event('pointerleave'));
    vi.advanceTimersByTime(1000);
    expect(cards.map(slotOf)).toEqual(['2', '0', '1']); // resumed
    handle.destroy();
  });

  it('with reduced motion there is no auto-cycle, and destroy() clears the timer, removes the button and restores outerHTML', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(true);
    const { el, cards } = host();
    const before = el.outerHTML;
    const handle = mount(el, { delay: 1000 });
    expect(el.classList.contains('genui-card-swap--reduced')).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(cards.map(slotOf)).toEqual(['0', '1', '2']); // never rotated
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.querySelector('.genui-card-swap__next')).toBeNull();
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-card-swap with no url() or @import', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/card-swap');
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    const selectors = css.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-card-swap/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/card-swap');
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
  });

  it('declares the same defaults in meta.json props as in the code', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const here = path.resolve(import.meta.dirname, '../../../components/card-swap');
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
