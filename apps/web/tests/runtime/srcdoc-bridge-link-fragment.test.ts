// @vitest-environment node

import { JSDOM } from 'jsdom';
import { describe, expect, it, vi } from 'vitest';
import { buildSrcdoc } from '../../src/runtime/srcdoc';

// Loam Room finding (a): a preview opened from `index.html#work` must land on
// #work. The host answers the frame's load-time scroll request (or pushes a
// live request) with the link fragment; the srcDoc selection bridge must
// navigate to it like a real fragment navigation and acknowledge it.

function extractBridgeScript(srcdoc: string): string {
  const match = srcdoc.match(/<script data-od-selection-bridge>([\s\S]*?)<\/script>/);
  if (!match?.[1]) throw new Error('selection bridge script not found in srcdoc');
  return match[1];
}

function setupBridge() {
  const bodyHtml = '<main><section id="intro">Intro</section><section id="work">Work</section>'
    + '<section id="billing details">Billing</section><section id="R\u00e9sum\u00e9">Resume</section></main>';
  const srcdoc = buildSrcdoc(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    selectionBridge: true,
  });
  const dom = new JSDOM(`<!doctype html><html><body>${bodyHtml}</body></html>`, {
    url: 'https://preview.test/index.html',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  const parentPostMessage = vi.fn();
  const parent = { postMessage: parentPostMessage };
  Object.defineProperty(win, 'parent', {
    configurable: true,
    value: parent,
  });
  const scrollIntoView = vi.fn();
  win.HTMLElement.prototype.scrollIntoView = scrollIntoView;
  const hashChanges: string[] = [];
  win.addEventListener('hashchange', () => hashChanges.push(win.location.hash));
  new win.Function(extractBridgeScript(srcdoc)).call(win);
  // Host commands come from window.parent; anything else is a foreign frame.
  const send = (data: unknown, source: unknown = parent) => {
    const event = new win.MessageEvent('message', { data });
    Object.defineProperty(event, 'source', { value: source });
    win.dispatchEvent(event);
  };
  const settle = () => new Promise<void>((resolve) => win.setTimeout(resolve, 20));
  const acks = () => parentPostMessage.mock.calls
    .map((call) => call[0] as { type?: string; fragmentNonce?: unknown })
    .filter((message) => message?.type === 'od:preview-fragment-applied');
  return { win, send, settle, acks, hashChanges, scrollIntoView };
}

describe('srcDoc selection bridge — link fragment', () => {
  it('navigates to the fragment carried by a scroll restore instead of the coordinates', async () => {
    const { win, send, settle, acks, hashChanges } = setupBridge();
    const scrollTo = vi.fn();
    win.document.documentElement.scrollTo = scrollTo;

    send({ type: 'od:preview-scroll-restore', frameLeft: 0, frameTop: 0, canvasLeft: 0, canvasTop: 0, hash: '#work', fragmentNonce: 4 });
    await settle();

    expect(win.location.hash).toBe('#work');
    expect(hashChanges).toEqual(['#work']);
    expect(acks()).toEqual([{ type: 'od:preview-fragment-applied', fragmentNonce: 4 }]);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it('re-scrolls a live document already at the requested fragment', async () => {
    const { win, send, settle, acks, scrollIntoView } = setupBridge();
    win.location.hash = '#work';
    await settle();

    send({ type: 'od:preview-navigate-fragment', hash: '#work', fragmentNonce: 5 });
    await settle();

    expect(scrollIntoView).toHaveBeenCalled();
    expect(acks()).toEqual([{ type: 'od:preview-fragment-applied', fragmentNonce: 5 }]);
  });

  it('ignores an invalid fragment and restores the coordinates as before', async () => {
    const { win, send, settle, acks } = setupBridge();
    const scrollTo = vi.fn();
    win.document.documentElement.scrollTo = scrollTo;

    send({ type: 'od:preview-scroll-restore', frameLeft: 3, frameTop: 40, canvasLeft: 0, canvasTop: 0, hash: '#"><b>', fragmentNonce: 6 });
    send({ type: 'od:preview-navigate-fragment', hash: 'work', fragmentNonce: 7 });
    await settle();

    expect(win.location.hash).toBe('');
    expect(acks()).toEqual([]);
    expect(scrollTo).toHaveBeenCalledWith(3, 40);
  });

  it('ignores fragment commands that do not come from the host window', async () => {
    const { win, send, settle, acks } = setupBridge();
    const foreignFrame = { postMessage: vi.fn() };

    send({ type: 'od:preview-navigate-fragment', hash: '#work', fragmentNonce: 8 }, foreignFrame);
    send({ type: 'od:preview-scroll-restore', frameLeft: 0, frameTop: 0, canvasLeft: 0, canvasTop: 0, hash: '#work', fragmentNonce: 9 }, foreignFrame);
    await settle();

    expect(win.location.hash).toBe('');
    expect(acks()).toEqual([]);
  });

  it.each([
    ['#billing%20details', 'billing details'],
    ['#R%C3%A9sum%C3%A9', 'R\u00e9sum\u00e9'],
  ])('lands on the element a percent-encoded fragment %s names', async (hash, id) => {
    const { win, send, settle, acks, scrollIntoView } = setupBridge();
    win.location.hash = hash;
    await settle();

    send({ type: 'od:preview-navigate-fragment', hash, fragmentNonce: 10 });
    await settle();

    expect(scrollIntoView.mock.contexts).toContain(win.document.getElementById(id));
    expect(acks()).toEqual([{ type: 'od:preview-fragment-applied', fragmentNonce: 10 }]);
  });

  it('an empty fragment with a nonce navigates a plain link to the top like a real navigation', async () => {
    const { win, send, settle, acks, hashChanges } = setupBridge();
    win.location.hash = '#work';
    await settle();
    const scrollTo = vi.fn();
    win.document.documentElement.scrollTo = scrollTo;
    const historyLength = win.history.length;
    const hashEvents: Array<{ oldURL: string; newURL: string }> = [];
    win.addEventListener('hashchange', (event) => hashEvents.push({ oldURL: event.oldURL, newURL: event.newURL }));

    send({ type: 'od:preview-navigate-fragment', hash: '', fragmentNonce: 11 });
    await settle();

    expect(scrollTo).toHaveBeenCalledWith(0, 0);
    expect(win.location.hash).toBe('');
    // A hash-driven page hears the change, and Back returns to #work.
    expect(hashChanges).toEqual(['#work', '']);
    expect(hashEvents).toEqual([{
      oldURL: 'https://preview.test/index.html#work',
      newURL: 'https://preview.test/index.html',
    }]);
    expect(win.history.length).toBe(historyLength + 1);
    expect(acks()).toEqual([{ type: 'od:preview-fragment-applied', fragmentNonce: 11 }]);

    win.history.back();
    await settle();
    expect(win.location.hash).toBe('#work');
  });

  it('a plain link on a page without a hash only scrolls to the top', async () => {
    const { win, send, settle, hashChanges } = setupBridge();
    const historyLength = win.history.length;

    send({ type: 'od:preview-navigate-fragment', hash: '', fragmentNonce: 12 });
    await settle();

    expect(hashChanges).toEqual([]);
    expect(win.history.length).toBe(historyLength);
  });

  it('delivers back-to-back fragment then plain commands to the page in command order', async () => {
    const { win, send, settle } = setupBridge();
    const newURLs: string[] = [];
    win.addEventListener('hashchange', (event) => newURLs.push(event.newURL));

    send({ type: 'od:preview-navigate-fragment', hash: '#work', fragmentNonce: 13 });
    send({ type: 'od:preview-navigate-fragment', hash: '', fragmentNonce: 14 });
    await settle();
    await settle();

    expect(newURLs).toEqual([
      'https://preview.test/index.html#work',
      'https://preview.test/index.html',
    ]);
    expect(win.location.hash).toBe('');
  });
});
