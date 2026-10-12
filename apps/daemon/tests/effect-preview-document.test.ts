// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectPreviewDocument } from '../src/routes/effect-preview-document.js';

// jsdom supplies these globals. Keep the daemon test program on Node types: adding the
// DOM lib globally changes fetch/RequestInit in unrelated transport tests.
type TestKeyEvent = { defaultPrevented: boolean };
type TestElement = { focus(): void; dispatchEvent(event: TestKeyEvent): boolean };
type TestMutationObserver = { disconnect(): void };
type TestMutationObserverConstructor = new (callback: (...args: unknown[]) => void) => TestMutationObserver;
declare const document: {
  body: { innerHTML: string };
  getElementById(id: string): TestElement | null;
  activeElement: TestElement | null;
};
declare const window: {
  eval(source: string): unknown;
  postMessage(message: unknown, origin: string): void;
  innerWidth: number;
  MutationObserver: TestMutationObserverConstructor;
};
declare const KeyboardEvent: new (type: string, options: { key: string; shiftKey?: boolean; bubbles: boolean; cancelable: boolean }) => TestKeyEvent;

const activeObservers = new Set<TestMutationObserver>();
let restoreMutationObserver: (() => void) | null = null;
beforeEach(() => {
  const RealMutationObserver = window.MutationObserver;
  window.MutationObserver = class extends RealMutationObserver {
    constructor(callback: (...args: unknown[]) => void) {
      super(callback);
      activeObservers.add(this);
    }
  };
  restoreMutationObserver = () => { window.MutationObserver = RealMutationObserver; };
});
afterEach(() => {
  for (const observer of activeObservers) observer.disconnect();
  activeObservers.clear();
  restoreMutationObserver?.();
  restoreMutationObserver = null;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('effect preview keyboard bridge', () => {
  it('inserts at a real body boundary without changing author script text', () => {
    const author = '<script>const template="</body>";</script>';
    const output = effectPreviewDocument('<html><body>' + author + '<button>Try it</button></body></html>');
    expect(output).toContain(author);
    expect(output.indexOf('mishh-effect-preview-escape')).toBeGreaterThan(output.indexOf('</button>'));
  });

  it('exits the iframe at either keyboard boundary but preserves internal navigation', () => {
    document.body.innerHTML = '<button id="first">First</button><button disabled>Disabled</button><button id="last">Last</button>';
    const output = effectPreviewDocument('<html><body></body></html>');
    const script = output.match(/<script>([\s\S]*)<\/script>/)?.[1];
    expect(script).toBeTruthy();
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    window.eval(script!);
    document.getElementById('first')!.focus();
    const backward = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(backward);
    expect(backward.defaultPrevented).toBe(true);
    expect(post).toHaveBeenLastCalledWith({ type: 'mishh-effect-preview-tab', backward: true }, '*');
    const internal = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(internal);
    expect(internal.defaultPrevented).toBe(false);
    document.getElementById('last')!.focus();
    const forward = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    document.activeElement!.dispatchEvent(forward);
    expect(forward.defaultPrevented).toBe(true);
    expect(post).toHaveBeenLastCalledWith({ type: 'mishh-effect-preview-tab', backward: false }, '*');
    post.mockRestore();
  });

  it('reports the demo content height through the same single bridge script', () => {
    const output = effectPreviewDocument('<html><body><div class="demo">Glare</div></body></html>');
    expect(output.match(/<script>/g)).toHaveLength(1);
    document.body.innerHTML = '<div id="demo">Glare</div><div id="hidden"></div>';
    const visible = document.getElementById('demo') as unknown as { getBoundingClientRect: () => unknown };
    visible.getBoundingClientRect = () => ({ top: 24, bottom: 284, left: 0, right: 300, width: 300, height: 260 });
    const post = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    window.eval(output.match(/<script>([\s\S]*)<\/script>/)![1]!);
    expect(post).toHaveBeenCalledWith({ type: 'mishh-effect-preview-size', width: window.innerWidth, height: 284 }, '*');
    post.mockRestore();
  });
});
