/**
 * ai-chat-input — clean-room implementation from component-specs.md §22 only. A chat composer for
 * agentic UIs. The textarea grows with its content up to `maxRows` on a spring; the send button is
 * disabled while the field is empty, scales in with a spring once it is not, and plays a short
 * press animation on submit. Optional suggestion chips fill the field when clicked. While `busy`
 * is true the send button becomes a stop button with a gentle CSS pulse. The placeholder cycles
 * through `placeholders` every `placeholderInterval` ms while the field is empty and unfocused. It
 * makes no network calls: the host app handles `genui:submit`.
 *
 * Contract (catalog-design.md §C): `mount(el, opts)` merges `data-genui-opts` under `opts`
 * (unknown keys dropped), adds `.genui-ai-chat-input` and `data-genui-mounted`, and returns a
 * handle whose `destroy()` restores `el.outerHTML` exactly. `el` is the host `<form>`. A
 * `.genui-ai-chat-input__field` textarea and `.genui-ai-chat-input__send` submit button are reused
 * if present, else created; a real `<label>` for the field is the host's responsibility either way.
 */

import {
  autoInitComponent, createAnimationSet, mountComponent, resolveOptions, setVars, snapshotAttributes,
  springEasing, watchReducedMotion, type GenuiHandle,
} from '../../src/runtime/shared.ts';

export type { GenuiHandle };

export const id = 'ai-chat-input';
const PREFIX = `genui-${id}`;
const FIELD_CLASS = `${PREFIX}__field`;
const SEND_CLASS = `${PREFIX}__send`;
const CHIPS_CLASS = `${PREFIX}__chips`;
const CHIP_CLASS = `${PREFIX}__chip`;
const STATUS_CLASS = `${PREFIX}__status`;
const READY_CLASS = 'is-ready';
const BUSY_CLASS = 'is-busy';

export interface AiChatInputSpring {
  [key: string]: number;
  stiffness: number;
  damping: number;
}

export interface AiChatInputOptions {
  [key: string]: string | number | boolean | readonly string[] | AiChatInputSpring | null;
  placeholders: readonly string[];
  /** Placeholder rotation interval, in ms, while the field is empty and unfocused. */
  placeholderInterval: number;
  maxRows: number;
  spring: AiChatInputSpring;
  suggestions: readonly string[];
  /** Enter submits (Shift+Enter always inserts a newline instead). */
  submitOnEnter: boolean;
  busy: boolean;
  maxLength: number | null;
}

export const defaults: AiChatInputOptions = {
  placeholders: ['Ask anything…'],
  placeholderInterval: 3500,
  maxRows: 8,
  spring: { stiffness: 320, damping: 26 },
  suggestions: [],
  submitOnEnter: true,
  busy: false,
  maxLength: null,
};

export interface AiChatInputHandle extends GenuiHandle {
  /** Toggle the send button into (or out of) its busy "stop" state. */
  setBusy(busy: boolean): void;
}

const NOOP_SET_BUSY = (): void => {};

export function mount(el: HTMLElement, opts: Partial<AiChatInputOptions> = {}): AiChatInputHandle {
  let setBusyImpl: (busy: boolean) => void = NOOP_SET_BUSY;
  const handle = mountComponent(id, el, ({ signal, onDestroy }) => {
    const options = resolveOptions(el, defaults, opts);
    const easing = springEasing(options.spring.stiffness, options.spring.damping);
    setVars(el, PREFIX, { ease: easing });

    const fieldExisted = el.querySelector(`.${FIELD_CLASS}`) !== null;
    const field = (el.querySelector<HTMLTextAreaElement>(`.${FIELD_CLASS}`) ?? document.createElement('textarea'));
    if (!fieldExisted) { field.className = FIELD_CLASS; el.append(field); }
    const restoreField = fieldExisted ? snapshotAttributes(field, ['placeholder', 'maxlength', 'style']) : null;

    const sendExisted = el.querySelector(`.${SEND_CLASS}`) !== null;
    const send = (el.querySelector<HTMLButtonElement>(`.${SEND_CLASS}`) ?? document.createElement('button'));
    if (!sendExisted) { send.type = 'submit'; send.className = SEND_CLASS; el.append(send); }
    const restoreSend = sendExisted ? snapshotAttributes(send, ['aria-label', 'aria-busy', 'disabled']) : null;

    const chips = document.createElement('div');
    chips.className = CHIPS_CLASS;
    for (const suggestion of options.suggestions) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = CHIP_CLASS;
      chip.textContent = suggestion;
      chip.addEventListener('click', () => {
        field.value = suggestion;
        field.focus();
        updateField();
      }, { signal });
      chips.append(chip);
    }
    if (options.suggestions.length > 0) el.append(chips);

    const status = document.createElement('div');
    status.className = STATUS_CLASS;
    status.setAttribute('aria-live', 'polite');
    status.style.cssText = 'position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;';
    el.append(status);

    if (options.maxLength !== null) field.maxLength = options.maxLength;

    // A live switch to reduced motion stops the placeholder rotation; switching back restarts it
    // (startPlaceholderCycle itself skips a focused or non-empty field).
    const motion = watchReducedMotion(signal, (reduced) => {
      if (reduced) stopPlaceholderCycle(); else startPlaceholderCycle();
    });
    const anims = createAnimationSet();

    let busy = options.busy;
    let ready = false;
    let composing = false;
    let placeholderIndex = 0;
    let placeholderTimer: ReturnType<typeof setInterval> | null = null;

    const applyHeight = (): void => {
      field.style.height = 'auto';
      const line = parseFloat(getComputedStyle(field).lineHeight);
      const rowHeight = Number.isFinite(line) ? line : 20;
      const max = rowHeight * Math.max(1, options.maxRows);
      field.style.height = '';
      setVars(el, PREFIX, { h: `${Math.min(field.scrollHeight, max)}px` });
    };

    const updateField = (): void => {
      const nextReady = field.value.trim().length > 0;
      if (nextReady !== ready) {
        ready = nextReady;
        el.classList.toggle(READY_CLASS, ready);
        if (ready && !motion.reduced) {
          anims.play(send, [
            { transform: 'scale(0.85)', opacity: 0.6 },
            { transform: 'scale(1)', opacity: 1 },
          ], { duration: 220, easing });
        }
      }
      send.disabled = !busy && !ready;
      applyHeight();
    };

    const setBusy = (next: boolean): void => {
      busy = next;
      el.classList.toggle(BUSY_CLASS, busy);
      send.setAttribute('aria-label', busy ? 'Stop' : 'Send');
      if (busy) send.setAttribute('aria-busy', 'true'); else send.removeAttribute('aria-busy');
      status.textContent = busy ? 'Sending…' : '';
      send.disabled = !busy && !ready;
    };
    setBusyImpl = setBusy;

    const applyPlaceholder = (): void => { field.placeholder = options.placeholders[placeholderIndex] ?? ''; };

    const stopPlaceholderCycle = (): void => {
      if (placeholderTimer === null) return;
      clearInterval(placeholderTimer);
      placeholderTimer = null;
    };

    const startPlaceholderCycle = (): void => {
      stopPlaceholderCycle();
      if (motion.reduced || options.placeholders.length <= 1) return; // first entry stays
      if (document.activeElement === field || field.value !== '') return;
      placeholderTimer = setInterval(() => {
        placeholderIndex = (placeholderIndex + 1) % options.placeholders.length;
        applyPlaceholder();
      }, Math.max(200, options.placeholderInterval));
    };

    const doSubmit = (): void => {
      const text = field.value.trim();
      if (!text) return;
      el.dispatchEvent(new CustomEvent('genui:submit', { detail: { text }, bubbles: true }));
      field.value = '';
      updateField();
      startPlaceholderCycle();
      if (!motion.reduced) {
        anims.play(send, [
          { transform: 'scale(1)' }, { transform: 'scale(0.88)' }, { transform: 'scale(1)' },
        ], { duration: 200, easing });
      }
    };

    const trigger = (): void => {
      if (busy) { el.dispatchEvent(new CustomEvent('genui:stop', { bubbles: true })); return; }
      doSubmit();
    };

    if (el instanceof HTMLFormElement) {
      el.addEventListener('submit', (event) => { event.preventDefault(); trigger(); }, { signal });
    } else {
      send.addEventListener('click', (event) => { event.preventDefault(); trigger(); }, { signal });
    }

    field.addEventListener('input', () => { stopPlaceholderCycle(); updateField(); }, { signal });
    field.addEventListener('focus', () => { stopPlaceholderCycle(); }, { signal });
    field.addEventListener('blur', () => { startPlaceholderCycle(); }, { signal });
    field.addEventListener('compositionstart', () => { composing = true; }, { signal });
    field.addEventListener('compositionend', () => { composing = false; }, { signal });
    field.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.shiftKey || !options.submitOnEnter) return;
      if (composing || event.isComposing) return;
      event.preventDefault();
      trigger();
    }, { signal });

    updateField();
    setBusy(busy);
    applyPlaceholder();
    startPlaceholderCycle();

    onDestroy(() => {
      stopPlaceholderCycle();
      anims.cancelAll();
      chips.remove();
      status.remove();
      if (fieldExisted) restoreField?.(); else field.remove();
      if (sendExisted) restoreSend?.(); else send.remove();
    });
  });
  return Object.assign(handle, { setBusy: (busy: boolean) => setBusyImpl(busy) });
}

export function autoInit(root: ParentNode = document): AiChatInputHandle[] {
  return autoInitComponent(id, (el) => mount(el), root) as AiChatInputHandle[];
}

export default autoInit;
