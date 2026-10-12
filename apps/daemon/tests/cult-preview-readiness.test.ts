import { describe, expect, it } from 'vitest';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM } from 'jsdom';
import { withCultPreviewReadiness } from '../src/cult-preview-readiness.js';

type PreviewElement = {
  hasAttribute(name: string): boolean;
  getAttribute(name: string): string | null;
  style: { top: string; height: string };
  previewTop?: number;
};

function frame(body: string) {
  const html = withCultPreviewReadiness(`<html><body><div id="root">${body}</div></body></html>`);
  const dom = new JSDOM(html, { runScripts: 'outside-only' });
  const w = dom.window;
  const messages: { source: string; type: string; reason?: string; width?: number; height?: number }[] = [];
  let now = 0;
  const timers: { due: number; callback: () => void }[] = [];
  w.parent.postMessage = (message: (typeof messages)[number]) => messages.push(message);
  w.requestAnimationFrame = () => 1; // An inactive iframe never gets a callback.
  w.setTimeout = (callback: () => void, delay: number) => { timers.push({ due: now + delay, callback }); return timers.length; };
  Object.defineProperty(w.performance, 'now', { value: () => now });
  w.Element.prototype.getBoundingClientRect = function (this: PreviewElement) {
    const offscreen = this.hasAttribute('data-offscreen');
    const empty = this.hasAttribute('data-empty');
    if (this.hasAttribute('data-preview-wrapper')) {
      const height = Number(this.getAttribute('data-preview-wrapper'));
      return { top: 0, bottom: height, left: 0, right: 390, width: 390, height };
    }
    if (this.hasAttribute('data-preview-deep')) {
      const top = this.previewTop ?? Number(this.style.top.replace('px', ''));
      const height = Number(this.style.height.replace('px', ''));
      return { top, bottom: top + height, left: 0, right: 390, width: 390, height };
    }
    return { top: offscreen ? 2000 : 10, bottom: offscreen ? 2020 : 30, left: 10, right: empty ? 10 : 110, width: empty ? 0 : 100, height: 20 };
  };
  w.eval(w.document.querySelector('script[data-cult-readiness]')!.textContent);
  const tick = (ms: number) => {
    const end = now + ms;
    while (true) {
      timers.sort((a, b) => a.due - b.due);
      if (!timers[0] || timers[0].due > end) break;
      const timer = timers.shift()!; now = timer.due; timer.callback();
    }
    now = end;
  };
  return { w, messages, tick, close: () => w.close() };
}

describe('served harness readiness', () => {
  function positionedFrame() {
    const f = frame('<div data-preview-wrapper="80"><p>Ready</p><div data-preview-deep style="position:absolute;top:300px;height:80px">Deep child</div></div>');
    Object.defineProperty(f.w, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 600 });
    return f;
  }

  const sizes = (f: ReturnType<typeof frame>) => f.messages.filter(message => message.type === 'size').map(message => message.height);

  it('measures an absolutely positioned grandchild within the physical iframe viewport', () => {
    const f = positionedFrame();
    f.tick(200);
    expect(sizes(f)).toEqual([380]);
    f.close();
  });

  it('does not enlarge the preview for a child intentionally clipped by its wrapper', () => {
    const f = frame('<div data-preview-wrapper="80" style="overflow:hidden"><p>Ready</p><div data-preview-deep style="position:absolute;top:300px;height:80px">Clipped child</div></div>');
    f.tick(200);
    expect(sizes(f)).toEqual([80]);
    f.close();
  });

  it('does not count a hidden ancestor and its descendants', () => {
    const f = frame('<p>Ready</p><div data-preview-wrapper="80" style="display:none"><div data-preview-deep style="position:absolute;top:300px;height:80px">Hidden child</div></div>');
    f.tick(200);
    expect(sizes(f)).toEqual([30]);
    f.close();
  });

  it('remeasures a descendant moved by a style change without resizing its wrapper', async () => {
    const f = positionedFrame();
    f.tick(200);
    const deep = f.w.document.querySelector('[data-preview-deep]') as PreviewElement;
    deep.style.top = '420px';
    await Promise.resolve();
    f.tick(0);
    expect(sizes(f).at(-1)).toBe(500);
    f.close();
  });

  it('remeasures a late nested positioned child', async () => {
    const f = frame('<div data-preview-wrapper="80"><p>Ready</p></div>');
    Object.defineProperty(f.w, 'innerHeight', { configurable: true, value: 600 });
    Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 600 });
    f.tick(200);
    f.w.document.querySelector('[data-preview-wrapper]')!.insertAdjacentHTML('beforeend', '<div data-preview-deep style="position:absolute;top:300px;height:80px">Late child</div>');
    await Promise.resolve();
    f.tick(0);
    expect(sizes(f).at(-1)).toBe(380);
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
    f.tick(200);
    const deep = f.w.document.querySelector('[data-preview-deep]') as PreviewElement;
    deep.previewTop = 420;
    for (const observer of observers) if (observer.observed.has(deep)) observer.callback();
    expect(sizes(f).at(-1)).toBe(500);
    f.close();
  });

  it('finds real painted text through timers when animation frames never fire', () => {
    const f = frame('<button>Continue</button>');
    f.tick(200);
    expect(f.messages[0]).toEqual({ source: 'cult-live-preview', type: 'ready' });
    // The content box ends 30px below the document top, measured at the frame's own width.
    expect(f.messages.filter(message => message.type === 'size')).toEqual([{ source: 'cult-live-preview', type: 'size', width: 1024, height: 30 }]);
    f.tick(8000);
    expect(f.messages.filter(message => message.type === 'ready')).toHaveLength(1);
    f.close();
  });

  it('reports the bounded scroll height when content overflows the frame viewport, and only after ready', () => {
    const f = frame('<button>Continue</button>');
    Object.defineProperty(f.w.document.documentElement, 'scrollHeight', { configurable: true, value: 2400 });
    expect(f.messages).toEqual([]);
    f.tick(200);
    expect(f.messages.filter(message => message.type === 'size')).toEqual([{ source: 'cult-live-preview', type: 'size', width: 1024, height: 2400 }]);
    f.close();
    const tall = frame('<button>Continue</button>');
    Object.defineProperty(tall.w.document.documentElement, 'scrollHeight', { configurable: true, value: 90_000 });
    tall.tick(200);
    expect(tall.messages.find(message => message.type === 'size')?.height).toBe(4096);
    tall.close();
  });

  it('sends a size again only when it changes, on frame resize', () => {
    const f = frame('<button>Continue</button>');
    f.tick(200);
    f.w.dispatchEvent(new f.w.Event('resize'));
    expect(f.messages.filter(message => message.type === 'size')).toHaveLength(1);
    Object.defineProperty(f.w, 'innerWidth', { configurable: true, value: 390 });
    f.w.dispatchEvent(new f.w.Event('resize'));
    expect(f.messages.filter(message => message.type === 'size').map(message => message.width)).toEqual([1024, 390]);
    f.close();
  });

  it.each(['', '<p style="opacity:0">Hidden</p>', '<div style="display:none"><button>Hidden</button></div>', '<p data-offscreen>Outside</p>', '<p data-empty>Zero width</p>', '<svg></svg>', '<img src="data:image/png;base64,invalid">'])('never calls an unpainted root ready: %s', (body) => {
    const f = frame(body); f.tick(7200);
    expect(f.messages).toEqual([{ source: 'cult-live-preview', type: 'error', reason: 'rendered no visible content' }]);
    f.close();
  });

  it('waits for content to appear and supports graphic-only content', () => {
    const f = frame(''); f.tick(200);
    expect(f.messages).toEqual([]);
    f.w.document.getElementById('root').innerHTML = '<svg><path d="M0 0L10 10" /></svg>';
    f.tick(200);
    expect(f.messages[0]?.type).toBe('ready'); f.close();
  });

  it('forwards runtime and rejection errors even after ready', () => {
    const f = frame('<p>Ready</p>'); f.tick(200);
    f.w.dispatchEvent(new f.w.ErrorEvent('error', { message: 'late render failure' }));
    const rejection = new f.w.Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('failed task') });
    f.w.dispatchEvent(rejection);
    expect(f.messages.map(m => m.type)).toEqual(['ready', 'size', 'error', 'error']);
    expect(f.messages[2]?.reason).toContain('late render failure');
    expect(f.messages[3]?.reason).toContain('failed task'); f.close();
  });

  it('never reports ready after a render error, or from a transient visible flash', () => {
    const f = frame('<p>Content</p>'); f.tick(0);
    f.w.document.getElementById('root').style.opacity = '0'; f.tick(100);
    expect(f.messages).toEqual([]);
    f.w.dispatchEvent(new f.w.ErrorEvent('error', { message: 'render failed' }));
    f.w.document.getElementById('root').style.opacity = '1'; f.tick(8000);
    expect(f.messages).toEqual([{ source: 'cult-live-preview', type: 'error', reason: 'threw: render failed' }]); f.close();
  });

  it('inserts at the real body close, outside scripts, comments and attributes', () => {
    const original = '<html><body data-copy="</body>"><!-- </body> --><script>const copy="</body>";</script><div id="root"></div></body></html>';
    const html = withCultPreviewReadiness(original);
    expect(html.startsWith(original.slice(0, original.lastIndexOf('</body>')))).toBe(true);
    const dom = new JSDOM(html);
    expect(dom.window.document.querySelectorAll('script')).toHaveLength(2);
    expect(dom.window.document.querySelector('script[data-cult-readiness]')?.parentElement?.tagName).toBe('BODY');
    dom.window.close();
    expect(withCultPreviewReadiness('<script>"</body>"</script>')).toBe('<script>"</body>"</script>');
  });
});
