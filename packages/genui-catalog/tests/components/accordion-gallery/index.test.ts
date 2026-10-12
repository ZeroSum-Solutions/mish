// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { autoInit, defaults, id, mount } from '../../../components/accordion-gallery/index.ts';

function host(panelCount = 5): HTMLElement {
  const el = document.createElement('ul');
  el.dataset.genui = id;
  for (let i = 0; i < panelCount; i += 1) {
    const panel = document.createElement('li');
    panel.className = 'genui-accordion-gallery__panel';
    panel.innerHTML = `
      <div class="genui-accordion-gallery__media"></div>
      <div class="genui-accordion-gallery__label">Panel ${i}<a class="genui-accordion-gallery__link" href="#">View</a></div>
    `;
    el.append(panel);
  }
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe(id, () => {
  it('adds the class and maps options to custom properties', () => {
    const el = host();
    const handle = mount(el);
    expect(el.classList.contains(`genui-${id}`)).toBe(true);
    expect(el.hasAttribute('data-genui-mounted')).toBe(true);
    expect(el.style.getPropertyValue('--genui-accordion-gallery-expand')).toBe(String(defaults.expand));
    handle.destroy();
  });

  it('activeIndex adds .is-active to that panel only', () => {
    const el = host();
    const handle = mount(el, { activeIndex: 2 });
    const panels = el.querySelectorAll('.genui-accordion-gallery__panel');
    panels.forEach((panel, i) => {
      expect(panel.classList.contains('is-active')).toBe(i === 2);
    });
    handle.destroy();
  });

  it('destroy() removes .is-active and restores outerHTML exactly', () => {
    const el = host();
    const before = el.outerHTML;
    const handle = mount(el, { activeIndex: 1 });
    expect(el.querySelectorAll('.is-active')).toHaveLength(1);
    handle.destroy();
    expect(el.querySelectorAll('.is-active')).toHaveLength(0);
    expect(el.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(el.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const el = host();
    el.dataset.genuiOpts = JSON.stringify({ expand: 6, bogus: 'nope', grayscale: 'loud' });
    const handle = mount(el, { duration: 250 });
    expect(el.style.getPropertyValue('--genui-accordion-gallery-expand')).toBe('6');
    expect(el.style.getPropertyValue('--genui-accordion-gallery-duration')).toBe('250ms');
    expect(el.style.getPropertyValue('--genui-accordion-gallery-gray')).toBe(String(defaults.grayscale));
    expect(el.style.getPropertyValue('--genui-accordion-gallery-bogus')).toBe('');
    handle.destroy();
  });

  it('maps stackBelow to --genui-accordion-gallery-stack, clamped to [0, 640]', () => {
    const el = host();
    const defaultHandle = mount(el);
    expect(el.style.getPropertyValue('--genui-accordion-gallery-stack')).toBe(`${defaults.stackBelow}px`);
    defaultHandle.destroy();

    const lowered = mount(el, { stackBelow: 300 });
    expect(el.style.getPropertyValue('--genui-accordion-gallery-stack')).toBe('300px');
    lowered.destroy();

    // Can only lower the 640px default, never raise it.
    const raised = mount(el, { stackBelow: 1200 });
    expect(el.style.getPropertyValue('--genui-accordion-gallery-stack')).toBe('640px');
    raised.destroy();

    const negative = mount(el, { stackBelow: -50 });
    expect(el.style.getPropertyValue('--genui-accordion-gallery-stack')).toBe('0px');
    negative.destroy();
  });

  it('autoInit mounts every host once', () => {
    const el = host();
    const handles = autoInit(document);
    expect(handles).toHaveLength(1);
    expect(autoInit(document)).toHaveLength(0);
    handles[0]!.destroy();
  });
});
