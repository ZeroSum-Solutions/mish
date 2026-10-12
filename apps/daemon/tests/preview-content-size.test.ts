import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM } from 'jsdom';
import { PREVIEW_CONTENT_SIZE_REPORTER } from '../src/preview-content-size.js';
import { withCultPreviewReadiness } from '../src/cult-preview-readiness.js';
import { effectPreviewDocument } from '../src/routes/effect-preview-document.js';
import { withPrivatePreviewSizeBridge } from '../src/routes/twenty1st.js';

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');
const source = (relative: string) => readFileSync(new URL(relative, import.meta.url), 'utf8');

// Digests of each consumer's output, recorded just before the reporter left
// cult-preview-readiness.ts in P1-4a (those modules are unchanged since 124ad6b6b6). Moving the reporter must not change a served byte.
const BEFORE_MOVE = {
  reporter: '849550d57e1abc59f4787f695930247de3c23029b94a954eb3b768ab7771f5af',
  cultReadiness: '0cdfa84abf4b93b90903166edc58fc51b5ed35d561b590ae7103a8f3c90069c5',
  effectDocument: '0ebc9813ad51221a065c86a1700099bbf4220f022ab5feafc60e9d853d29d945',
  twenty1stBridgeHtml: '80ab5708a73aac706ce018bc5c14f4491a863de309620e4d8ac58ac568c3d834',
  twenty1stBridgeCsp: 'dcea41783f9117c1b377515e0273492e9b0845e93e4ead41fb1e49b968704695',
};

describe('PREVIEW_CONTENT_SIZE_REPORTER home (P1-4a spec 4)', () => {
  it('is exported from preview-content-size with the same text it had in the Cult module', () => {
    expect(sha256(PREVIEW_CONTENT_SIZE_REPORTER)).toBe(BEFORE_MOVE.reporter);
  });

  it('the effect preview document and the 21st route import it from preview-content-size, not from a Cult module', () => {
    for (const file of ['../src/routes/effect-preview-document.ts', '../src/routes/twenty1st.ts']) {
      const text = source(file);
      expect(text, file).toContain("from '../preview-content-size.js'");
      expect(text, file).not.toContain('cult-preview-readiness');
    }
  });

  it('effect-preview-document and the 21st private preview bridge inject the reporter, byte for byte as before', () => {
    const effect = effectPreviewDocument('<html><head></head><body><div>x</div></body></html>');
    expect(effect).toContain(`(${PREVIEW_CONTENT_SIZE_REPORTER})`);
    expect(sha256(effect)).toBe(BEFORE_MOVE.effectDocument);
    const bridged = withPrivatePreviewSizeBridge({ html: '<html><body><div id="root"></div></body></html>', csp: "default-src 'none'; script-src 'self'" }, '21st:example');
    expect(bridged.html).toContain(`(${PREVIEW_CONTENT_SIZE_REPORTER})`);
    expect(sha256(bridged.html)).toBe(BEFORE_MOVE.twenty1stBridgeHtml);
    expect(sha256(bridged.csp)).toBe(BEFORE_MOVE.twenty1stBridgeCsp);
  });

  it('Cult readiness still injects the identical script', () => {
    const served = withCultPreviewReadiness('<html><body></body></html>');
    expect(served).toContain(`(${PREVIEW_CONTENT_SIZE_REPORTER})`);
    expect(sha256(served)).toBe(BEFORE_MOVE.cultReadiness);
  });
});

type PreviewElement = {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  style: { top: string; height: string };
  previewTop?: number;
};

/** A served preview document with the reporter installed, as the effect and 21st bridges do. */
function frame(body: string) {
  const dom = new JSDOM(`<html><body><div id="root">${body}</div></body></html>`, { runScripts: 'outside-only' });
  const w = dom.window;
  const messages: { type: string; width: number; height: number }[] = [];
  w.parent.postMessage = (message: (typeof messages)[number]) => messages.push(message);
  w.Element.prototype.getBoundingClientRect = function (this: PreviewElement) {
    const offscreen = this.hasAttribute('data-offscreen');
    if (this.hasAttribute('data-preview-wrapper')) {
      const height = Number(this.getAttribute('data-preview-wrapper'));
      return { top: 0, bottom: height, left: 0, right: 390, width: 390, height };
    }
    if (this.hasAttribute('data-preview-deep')) {
      const top = this.previewTop ?? Number(this.style.top.replace('px', ''));
      const height = Number(this.style.height.replace('px', ''));
      return { top, bottom: top + height, left: 0, right: 390, width: 390, height };
    }
    return { top: offscreen ? 2000 : 10, bottom: offscreen ? 2020 : 30, left: 10, right: 110, width: 100, height: 20 };
  };
  const start = () => w.eval(`(${PREVIEW_CONTENT_SIZE_REPORTER})(function(width,height){parent.postMessage({type:"size",width:width,height:height},"*")},"root")()`);
  const sizes = () => messages.map(message => message.height);
  return { w, messages, sizes, start, close: () => w.close() };
}

function positionedFrame() {
  const f = frame('<div data-preview-wrapper="80"><p>Ready</p><div data-preview-deep style="position:absolute;top:300px;height:80px">Deep child</div></div>');
  Object.defineProperty(f.w, 'innerHeight', { configurable: true, value: 600 });
  Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 600 });
  return f;
}

describe('preview content size reporter', () => {
  it('measures the content box at the frame width', () => {
    const f = frame('<button>Continue</button>');
    f.start();
    expect(f.messages).toEqual([{ type: 'size', width: 1024, height: 30 }]);
    f.close();
  });

  it('measures an absolutely positioned grandchild within the physical iframe viewport', () => {
    const f = positionedFrame();
    f.start();
    expect(f.sizes()).toEqual([380]);
    f.close();
  });

  it('does not enlarge the preview for a child intentionally clipped by its wrapper', () => {
    const f = frame('<div data-preview-wrapper="80" style="overflow:hidden"><p>Ready</p><div data-preview-deep style="position:absolute;top:300px;height:80px">Clipped child</div></div>');
    f.start();
    expect(f.sizes()).toEqual([80]);
    f.close();
  });

  it('does not count a hidden ancestor and its descendants', () => {
    const f = frame('<p>Ready</p><div data-preview-wrapper="80" style="display:none"><div data-preview-deep style="position:absolute;top:300px;height:80px">Hidden child</div></div>');
    f.start();
    expect(f.sizes()).toEqual([30]);
    f.close();
  });

  it('remeasures a descendant moved by a style change without resizing its wrapper', async () => {
    const f = positionedFrame();
    f.start();
    const deep = f.w.document.querySelector('[data-preview-deep]') as PreviewElement;
    deep.style.top = '420px';
    await Promise.resolve();
    expect(f.sizes().at(-1)).toBe(500);
    f.close();
  });

  it('remeasures a late nested positioned child', async () => {
    const f = frame('<div data-preview-wrapper="80"><p>Ready</p></div>');
    Object.defineProperty(f.w, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 600 });
    f.start();
    f.w.document.querySelector('[data-preview-wrapper]')!.insertAdjacentHTML('beforeend', '<div data-preview-deep style="position:absolute;top:300px;height:80px">Late child</div>');
    await Promise.resolve();
    expect(f.sizes().at(-1)).toBe(380);
    f.close();
  });

  it('observes descendant size changes without relying on wrapper resize or DOM mutation', () => {
    const f = positionedFrame();
    const observers: Array<{ observed: Set<object>; callback: () => void }> = [];
    f.w.ResizeObserver = class {
      observed = new Set<object>();
      callback: () => void;
      constructor(callback: () => void) { this.callback = callback; observers.push(this); }
      observe(node: object) { this.observed.add(node); }
      unobserve(node: object) { this.observed.delete(node); }
      disconnect() { this.observed.clear(); }
    };
    f.start();
    const deep = f.w.document.querySelector('[data-preview-deep]') as PreviewElement;
    deep.previewTop = 420;
    for (const observer of observers) if (observer.observed.has(deep)) observer.callback();
    expect(f.sizes().at(-1)).toBe(500);
    f.close();
  });

  it('reports the bounded scroll height when content overflows the frame viewport', () => {
    const f = frame('<button>Continue</button>');
    Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 2400 });
    f.start();
    expect(f.messages).toEqual([{ type: 'size', width: 1024, height: 2400 }]);
    f.close();
    const tall = frame('<button>Continue</button>');
    Object.defineProperty(tall.w.document.documentElement, 'scrollHeight', { configurable: true, value: 90_000 });
    tall.start();
    expect(tall.sizes()).toEqual([4096]);
    tall.close();
  });

  it('sends a size again only when it changes, on frame resize', () => {
    const f = frame('<button>Continue</button>');
    f.start();
    f.w.dispatchEvent(new f.w.Event('resize'));
    expect(f.messages).toHaveLength(1);
    Object.defineProperty(f.w, 'innerWidth', { configurable: true, value: 390 });
    f.w.dispatchEvent(new f.w.Event('resize'));
    expect(f.messages.map(message => message.width)).toEqual([1024, 390]);
    f.close();
  });

  it('reports nothing for an empty or fully hidden root', () => {
    for (const body of ['', '<div style="display:none"><button>Hidden</button></div>']) {
      const f = frame(body);
      f.start();
      expect(f.messages).toEqual([]);
      f.close();
    }
  });
});
