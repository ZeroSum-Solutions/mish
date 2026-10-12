// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { autoInit, defaults, id, mount } from '../../../components/animated-testimonials/index.ts';
import { stubIO, stubMatchMedia } from '../../_helpers.ts';

const here = path.resolve(import.meta.dirname, '../../../components/animated-testimonials');
const P = `genui-${id}`;

function host(count = 3): { el: HTMLElement; slides: HTMLElement[] } {
  const el = document.createElement('section');
  el.dataset.genui = id;
  const slides: HTMLElement[] = [];
  for (let i = 0; i < count; i += 1) {
    const slide = document.createElement('div');
    slide.className = `${P}__slide`;
    slide.innerHTML = `<div class="${P}__media"><svg viewBox="0 0 10 10"></svg></div>`
      + `<div class="${P}__body"><strong>Person ${i}</strong><p class="${P}__quote">Quote <em>number</em> ${i} here</p></div>`;
    el.append(slide);
    slides.push(slide);
  }
  document.body.append(el);
  return { el, slides };
}

const activeIndex = (slides: HTMLElement[]): number => slides.findIndex((s) => s.classList.contains(`${P}__slide--active`));

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
    expect(el.classList.contains(P)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(autoInit(document)).toHaveLength(0);
    handle!.destroy();
    expect(el.outerHTML).toBe(before);
    handle!.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('keeps an existing class and style attribute byte-for-byte', () => {
    const { el, slides } = host();
    el.className = 'card  featured';
    el.setAttribute('style', 'color: red;');
    slides[1]!.setAttribute('style', 'margin: 0;');
    const before = el.outerHTML;
    mount(el, { duration: 10 }).destroy();
    expect(el.outerHTML).toBe(before);
  });

  it('maps options to custom properties and sets per-slide depth, stack order and tilt', () => {
    const { el, slides } = host();
    const handle = mount(el, { duration: 800, mediaSize: '96px' });
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('800ms');
    expect(el.style.getPropertyValue(`--${P}-media`)).toBe('96px');
    expect(el.style.getPropertyValue(`--${P}-stagger`)).toBe(`${defaults.wordStagger}ms`);
    expect(slides.map((s) => s.style.getPropertyValue(`--${P}-d`))).toEqual(['0', '1', '2']);
    expect(slides.map((s) => s.style.getPropertyValue(`--${P}-z`))).toEqual(['3', '2', '1']);
    expect(slides[0]!.style.getPropertyValue(`--${P}-tilt`)).toMatch(/deg$/);
    expect(activeIndex(slides)).toBe(0);
    handle.destroy();
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const { el } = host();
    el.dataset.genuiOpts = JSON.stringify({ duration: 900, wordStagger: 70, bogus: 1, mediaSize: 12 });
    const handle = mount(el, { wordStagger: 20 });
    expect(el.style.getPropertyValue(`--${P}-duration`)).toBe('900ms');
    expect(el.style.getPropertyValue(`--${P}-stagger`)).toBe('20ms');
    expect(el.style.getPropertyValue(`--${P}-media`)).toBe(defaults.mediaSize);
    expect(el.style.getPropertyValue(`--${P}-bogus`)).toBe('');
    handle.destroy();
  });

  it('splits each quote into aria-hidden words and keeps the original text once for screen readers', () => {
    const { el } = host(1);
    const handle = mount(el);
    const quote = el.querySelector<HTMLElement>(`.${P}__quote`)!;
    const sr = quote.querySelector(`.${P}__sr`)!;
    expect(sr.innerHTML).toBe('Quote <em>number</em> 0 here');
    const visual = quote.querySelector('[aria-hidden="true"]')!;
    const words = Array.from(visual.querySelectorAll<HTMLElement>(`.${P}__word`));
    expect(words.map((w) => w.textContent)).toEqual(['Quote', 'number', '0', 'here']);
    expect(words[3]!.style.getPropertyValue(`--${P}-i`)).toBe('3');
    handle.destroy();
  });

  it('steps with the buttons and arrow keys, wraps around, and announces manual steps', () => {
    const { el, slides } = host();
    const handle = mount(el, { autoplay: false });
    const [prev, next] = Array.from(el.querySelectorAll<HTMLButtonElement>(`.${P}__btn`));
    expect(next!.getAttribute('aria-label')).toBe('Next testimonial');
    next!.click();
    expect(activeIndex(slides)).toBe(1);
    expect(slides.map((s) => s.style.getPropertyValue(`--${P}-d`))).toEqual(['2', '0', '1']);
    expect(el.querySelector('[aria-live="polite"]')!.textContent).toBe('Testimonial 2 of 3');
    prev!.click();
    prev!.click();
    expect(activeIndex(slides)).toBe(2);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
    expect(activeIndex(slides)).toBe(0);
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    expect(activeIndex(slides)).toBe(2);
    handle.destroy();
  });

  it('autoplays every interval, pauses on hover and off-screen, and stops on destroy', () => {
    vi.useFakeTimers();
    const io = stubIO();
    const { el, slides } = host();
    const handle = mount(el, { interval: 1000 });
    vi.advanceTimersByTime(1000);
    expect(activeIndex(slides)).toBe(1);
    el.dispatchEvent(new Event('pointerenter'));
    vi.advanceTimersByTime(5000);
    expect(activeIndex(slides)).toBe(1);
    el.dispatchEvent(new Event('pointerleave'));
    io.trigger(el, false);
    vi.advanceTimersByTime(5000);
    expect(activeIndex(slides)).toBe(1);
    io.trigger(el, true);
    vi.advanceTimersByTime(1000);
    expect(activeIndex(slides)).toBe(2);
    handle.destroy();
    expect(io.observers[0]!.disconnected).toBe(true);
    vi.advanceTimersByTime(5000);
    expect(activeIndex(slides)).toBe(-1);
  });

  it('follows reduced motion at mount and on change, and removes its listener on destroy', () => {
    vi.useFakeTimers();
    const media = stubMatchMedia(true);
    const { el, slides } = host();
    const before = el.outerHTML;
    const handle = mount(el, { interval: 1000 });
    expect(el.classList.contains(`${P}--reduced`)).toBe(true);
    expect(el.querySelector(`.${P}__word`)).toBeNull(); // no word split under reduce
    expect(media.listeners()).toBe(1);
    vi.advanceTimersByTime(5000);
    expect(activeIndex(slides)).toBe(0); // no autoplay
    media.fire(false);
    expect(el.classList.contains(`${P}--reduced`)).toBe(false);
    vi.advanceTimersByTime(1000);
    expect(activeIndex(slides)).toBe(1); // autoplay resumes
    media.fire(true);
    vi.advanceTimersByTime(5000);
    expect(activeIndex(slides)).toBe(1);
    handle.destroy();
    expect(media.listeners()).toBe(0);
    expect(el.outerHTML).toBe(before);
  });

  it('ships css scoped under .genui-animated-testimonials with no url() or @import', () => {
    const css = readFileSync(path.join(here, 'styles.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(css).not.toMatch(/url\(|@import|https?:\/\//);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)/);
    const withoutKeyframes = css.replace(/@keyframes[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '');
    const selectors = withoutKeyframes.replace(/@media[^{]+\{/g, '').match(/[^{}]+(?=\{)/g) ?? [];
    expect(selectors.length).toBeGreaterThan(5);
    for (const selector of selectors.flatMap((s) => s.split(','))) {
      expect(selector.trim()).toMatch(/genui-animated-testimonials/);
    }
  });

  it('has a demo fragment with no script, style block, image or external URL', () => {
    const demo = readFileSync(path.join(here, 'demo.html'), 'utf8');
    expect(demo).toContain(`data-genui="${id}"`);
    expect(demo).not.toMatch(/<script|<style|<img|url\(|https?:\/\//i);
    expect(demo).not.toMatch(/xmlns/);
  });

  it('declares the same defaults in meta.json props as in the code', () => {
    const meta = JSON.parse(readFileSync(path.join(here, 'meta.json'), 'utf8')) as {
      id: string; props: { properties: Record<string, { default: unknown }> };
    };
    expect(meta.id).toBe(id);
    const declared = Object.fromEntries(Object.entries(meta.props.properties).map(([key, value]) => [key, value.default]));
    expect(declared).toEqual(defaults);
  });
});
