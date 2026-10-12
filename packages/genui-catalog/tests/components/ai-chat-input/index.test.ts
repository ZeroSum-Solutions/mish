// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults, mount, id } from '../../../components/ai-chat-input/index.ts';
import { springEasing } from '../../../src/runtime/shared.ts';
import { stubMatchMedia } from '../../_helpers.ts';

function host(): { form: HTMLFormElement; field: HTMLTextAreaElement; send: HTMLButtonElement } {
  const form = document.createElement('form');
  form.dataset.genui = id;
  const label = document.createElement('label');
  label.setAttribute('for', 'field');
  label.textContent = 'Message';
  const field = document.createElement('textarea');
  field.id = 'field';
  field.className = 'genui-ai-chat-input__field';
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'genui-ai-chat-input__send';
  form.append(label, field, send);
  document.body.append(form);
  return { form, field, send };
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe(id, () => {
  it('disables the send button while empty, and typing sets .is-ready and enables it', () => {
    const { form, field, send } = host();
    const handle = mount(form);
    expect(send.disabled).toBe(true);
    expect(form.classList.contains('is-ready')).toBe(false);

    field.value = 'hello';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    expect(form.classList.contains('is-ready')).toBe(true);
    expect(send.disabled).toBe(false);
    handle.destroy();
  });

  it('Enter dispatches genui:submit with the trimmed text and clears the field; Shift+Enter does not submit', () => {
    const { form, field } = host();
    const handle = mount(form);
    const submits: Array<{ text: string }> = [];
    form.addEventListener('genui:submit', (event) => { submits.push((event as CustomEvent<{ text: string }>).detail); });

    field.value = '  hello world  ';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(submits).toEqual([{ text: 'hello world' }]);
    expect(field.value).toBe('');

    field.value = 'draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    expect(submits).toHaveLength(1);
    expect(field.value).toBe('draft');
    handle.destroy();
  });

  it('setBusy(true) sets aria-label="Stop" and .is-busy; with reduced motion the placeholder timer is never created', () => {
    const { form, send } = host();
    const handle = mount(form);
    handle.setBusy(true);
    expect(send.getAttribute('aria-label')).toBe('Stop');
    expect(form.classList.contains('is-busy')).toBe(true);
    handle.destroy();

    stubMatchMedia(true);
    vi.useFakeTimers();
    const { form: reducedForm } = host();
    mount(reducedForm, { placeholders: ['One', 'Two'] });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a live switch to reduced motion stops the placeholder rotation, and switching back restarts it', () => {
    const media = stubMatchMedia(false);
    vi.useFakeTimers();
    const { form, field } = host();
    const handle = mount(form, { placeholders: ['One', 'Two', 'Three'], placeholderInterval: 1000 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(field.placeholder).toBe('Two');

    media.fire(true);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(5000);
    expect(field.placeholder).toBe('Two');

    media.fire(false);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    expect(field.placeholder).toBe('Three');

    // Switching back does not restart it while the field has text.
    media.fire(true);
    field.value = 'draft';
    field.dispatchEvent(new Event('input', { bubbles: true }));
    media.fire(false);
    expect(vi.getTimerCount()).toBe(0);
    handle.destroy();
  });

  it("destroy() clears the timers, removes the chips and status, and restores outerHTML", () => {
    vi.useFakeTimers();
    const { form } = host();
    const before = form.outerHTML;
    const handle = mount(form, { suggestions: ['Summarise this page', 'Draft a reply'], placeholders: ['One', 'Two'] });
    expect(form.querySelectorAll('.genui-ai-chat-input__chips')).toHaveLength(1);
    expect(form.querySelectorAll('.genui-ai-chat-input__status')).toHaveLength(1);
    expect(vi.getTimerCount()).toBeGreaterThan(0);

    handle.destroy();
    expect(vi.getTimerCount()).toBe(0);
    expect(form.querySelectorAll('.genui-ai-chat-input__chips')).toHaveLength(0);
    expect(form.querySelectorAll('.genui-ai-chat-input__status')).toHaveLength(0);
    expect(form.outerHTML).toBe(before);
    handle.destroy(); // idempotent
    expect(form.outerHTML).toBe(before);
  });

  it('merges data-genui-opts under opts and drops unknown keys and wrong types', () => {
    const { form, field } = host();
    form.dataset.genuiOpts = JSON.stringify({
      spring: 'not-an-object', // wrong type: falls back to the default spring
      bogus: 'ignored', // unknown key: dropped entirely, never reaches the DOM
      suggestions: ['From data attr'], // valid: applies, but opts passed to mount() below wins
    });
    const handle = mount(form, { suggestions: ['From opts'] });

    expect(form.style.getPropertyValue(`--genui-${id}-ease`))
      .toBe(springEasing(defaults.spring.stiffness, defaults.spring.damping));
    expect(form.style.getPropertyValue(`--genui-${id}-bogus`)).toBe('');
    const chips = form.querySelectorAll(`.genui-${id}__chip`);
    expect(chips).toHaveLength(1);
    expect(chips[0]?.textContent).toBe('From opts');
    expect(field.placeholder).toBe(defaults.placeholders[0]);

    handle.destroy();
  });
});
