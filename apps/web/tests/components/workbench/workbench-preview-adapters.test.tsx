// @vitest-environment jsdom
// AC-R07.3 "Test a slow, failed, unavailable and ready item of each adapter family" for the
// families AC-R07's preamble adds (compiled HTML section, styled-components kit, selected WebGL)
// and the native video preview of AC-R07.1. Each family runs the shared HTML readiness rules
// plus its own fail-closed check: a styled-components document is ready only once its runtime
// has injected styles, and a WebGL document that cannot get (or loses) its context is replaced
// by a labelled fallback, never reported as a working preview.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { JSDOM } from 'jsdom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewAdapterFamily } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { WorkbenchVideoPreview } from '../../../src/components/workbench/WorkbenchVideoPreview';
import { adapterGuardScript, withAdapterGuard } from '../../../src/components/workbench/preview-adapters';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
const html = (body = '<p>Ready</p>') => new Response(`<!doctype html><html><head></head><body>${body}</body></html>`, { headers: { 'content-type': 'text/html' } });

function renderHtml(adapter: PreviewAdapterFamily, url = '/api/sections/x/preview') {
  const view = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Item" url={url} adapter={adapter} /></I18nProvider>);
  return { ...view, frame: () => view.container.querySelector('iframe')!, root: () => view.container.querySelector('[data-preview-state]')! };
}
function report(frame: HTMLIFrameElement, adapter: PreviewAdapterFamily, state: string) {
  fireEvent(window, new MessageEvent('message', { data: { type: 'od:workbench-adapter', adapter, state }, source: frame.contentWindow }));
}

const HTML_FAMILIES: PreviewAdapterFamily[] = ['compiled-html-section', 'styled-components', 'webgl'];

describe.each(HTML_FAMILIES)('%s adapter: slow, failed, unavailable and ready', (adapter) => {
  // What "the document is genuinely ready" means for each family.
  function becomeReady(frame: HTMLIFrameElement) {
    fireEvent.load(frame);
    if (adapter === 'styled-components') report(frame, adapter, 'ready');
  }

  it('ready: renders the sandboxed document and names its adapter family', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html()));
    const { frame, root } = renderHtml(adapter);
    await flush();
    expect(frame().getAttribute('sandbox')).toBe('allow-scripts');
    expect(root().getAttribute('data-preview-adapter')).toBe(adapter);
    becomeReady(frame());
    expect(root().getAttribute('data-preview-state')).toBe('ready');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('slow: times out to a retryable error after 8 seconds, and a late legitimate ready recovers it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html()));
    const { frame, root } = renderHtml(adapter);
    await flush();
    expect(root().getAttribute('data-preview-state')).toBe('loading');
    act(() => vi.advanceTimersByTime(8000));
    expect(root().getAttribute('data-preview-state')).toBe('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    becomeReady(frame());
    expect(root().getAttribute('data-preview-state')).toBe('ready');
  });

  it('failed: a refused document is an error with Retry, never ready', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 422 })).mockResolvedValueOnce(html()));
    const { root } = renderHtml(adapter);
    await flush();
    expect(root().getAttribute('data-preview-state')).toBe('error');
    expect(screen.getByRole('alert')).toHaveTextContent('could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(root().getAttribute('data-preview-state')).toBe('loading');
  });

  it('unavailable: a missing document stays unavailable past the deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    const { root } = renderHtml(adapter);
    await flush();
    act(() => vi.advanceTimersByTime(8000));
    expect(root().getAttribute('data-preview-state')).toBe('unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
  });
});

describe('styled-components readiness', () => {
  it('a loaded document is not ready until the runtime reports injected styles, and a styles-missing report fails closed', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html()));
    const { frame, root } = renderHtml('styled-components');
    await flush();
    fireEvent.load(frame());
    expect(root().getAttribute('data-preview-state')).toBe('loading');
    // A forged report from another window is ignored.
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:workbench-adapter', adapter: 'styled-components', state: 'ready' }, source: window }));
    expect(root().getAttribute('data-preview-state')).toBe('loading');
    report(frame(), 'styled-components', 'failed');
    expect(root().getAttribute('data-preview-state')).toBe('error');
    expect(screen.getByRole('alert')).toHaveTextContent('injected no styles');
  });
  it('injects its guard before any author script', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(html('<script>window.author = 1</script>')));
    const { frame } = renderHtml('styled-components');
    await flush();
    const srcDoc = frame().getAttribute('srcdoc')!;
    expect(srcDoc.indexOf('data-od-workbench-adapter="styled-components"')).toBeGreaterThan(-1);
    expect(srcDoc.indexOf('data-od-workbench-adapter="styled-components"')).toBeLessThan(srcDoc.indexOf('window.author'));
  });
});

describe('WebGL fails closed to a labelled fallback', () => {
  it.each([['unavailable', 'WebGL is not available'], ['lost', 'WebGL context was lost']])('%s: replaces the live canvas with a labelled fallback and Retry', async (state, label) => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(html('<canvas></canvas>'))));
    const { frame, root } = renderHtml('webgl');
    await flush();
    fireEvent.load(frame());
    expect(root().getAttribute('data-preview-state')).toBe('ready');
    report(frame(), 'webgl', state);
    expect(root().getAttribute('data-preview-state')).toBe('unavailable');
    expect(root().getAttribute('data-preview-reason')).toBe(state === 'lost' ? 'webgl-context-lost' : 'webgl-unavailable');
    expect(screen.getByRole('alert')).toHaveTextContent(label);
    // A later load event cannot paint over the fallback.
    fireEvent.load(frame());
    expect(root().getAttribute('data-preview-state')).toBe('unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(root().getAttribute('data-preview-state')).toBe('loading');
  });
  it('a restored context recovers, and a second live canvas is announced instead of silently failing', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(html('<canvas></canvas>'))));
    const { frame, root } = renderHtml('webgl');
    await flush();
    fireEvent.load(frame());
    report(frame(), 'webgl', 'lost');
    report(frame(), 'webgl', 'ready');
    expect(root().getAttribute('data-preview-state')).toBe('ready');
    report(frame(), 'webgl', 'limited');
    expect(screen.getByRole('status')).toHaveTextContent('one live WebGL canvas');
  });
});

describe('adapter guard scripts run inside the preview document', () => {
  it.each(['webgl', 'styled-components'] as const)('%s preserves an html document without a head', (adapter) => {
    const guarded = withAdapterGuard('<!doctype html><HTML lang="es" data-label="a > b"><body>Hola</body></HTML>', adapter);
    expect(guarded.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(guarded.match(/<html\b/gi)).toHaveLength(1);
    expect(guarded).toContain(`<HTML lang="es" data-label="a > b"><head><script data-od-workbench-adapter="${adapter}">`);
  });
  function runGuard(adapter: PreviewAdapterFamily, body: string, webgl: 'available' | 'unavailable') {
    const dom = new JSDOM(`<!doctype html><html><head></head><body>${body}</body></html>`, { runScripts: 'outside-only' });
    const { window } = dom;
    const posted: Array<Record<string, unknown>> = [];
    window.postMessage = ((data: Record<string, unknown>) => { posted.push(data); }) as typeof window.postMessage;
    const contexts: unknown[] = [];
    window.HTMLCanvasElement.prototype.getContext = function getContext(this: HTMLCanvasElement, kind: string) {
      if (webgl === 'unavailable' && /webgl/.test(kind)) return null;
      const context = { kind, canvas: this, getExtension: () => ({ loseContext() {} }) };
      contexts.push(context);
      return context;
    } as never;
    window.eval(adapterGuardScript(adapter)!.replace(/^<script[^>]*>|<\/script>$/g, ''));
    return { window, posted, contexts };
  }
  it('WebGL guard reports an unavailable context', () => {
    const { window, posted } = runGuard('webgl', '<canvas id="c"></canvas>', 'unavailable');
    window.eval('document.getElementById("c").getContext("webgl")');
    expect(posted).toContainEqual({ type: 'od:workbench-adapter', adapter: 'webgl', state: 'unavailable' });
  });
  it('WebGL guard keeps at most one live context and reports context loss', () => {
    const { window, posted } = runGuard('webgl', '<canvas id="a"></canvas><canvas id="b"></canvas>', 'available');
    expect(window.eval('!!document.getElementById("a").getContext("webgl")')).toBe(true);
    expect(window.eval('document.getElementById("b").getContext("webgl2")')).toBeNull();
    expect(window.eval('!!document.getElementById("a").getContext("webgl")')).toBe(true);
    expect(window.eval('!!document.getElementById("b").getContext("2d")')).toBe(true);
    window.eval('document.getElementById("a").dispatchEvent(new Event("webglcontextlost"))');
    expect(posted.map((message) => message.state)).toEqual(['ready', 'limited', 'ready', 'lost']);
  });
  it('styled-components guard reports ready only when styled rules exist after load', () => {
    const ready = runGuard('styled-components', '<style data-styled="active">.a{color:red}</style>', 'available');
    ready.window.dispatchEvent(new ready.window.Event('load'));
    return new Promise<void>((resolve) => setTimeout(() => {
      expect(ready.posted).toContainEqual({ type: 'od:workbench-adapter', adapter: 'styled-components', state: 'ready' });
      const missing = runGuard('styled-components', '<p>No runtime</p>', 'available');
      missing.window.dispatchEvent(new missing.window.Event('load'));
      setTimeout(() => {
        expect(missing.posted).toContainEqual({ type: 'od:workbench-adapter', adapter: 'styled-components', state: 'failed' });
        resolve();
      }, 1200);
    }, 120));
  });
});

describe('native video preview: slow, failed, unavailable and ready', () => {
  const headOk = () => new Response(null, { headers: { 'content-type': 'video/mp4', 'x-content-type-options': 'nosniff' } });
  function renderVideo(url = '/api/library/assets/clip/raw') {
    const view = render(<I18nProvider initial="en"><WorkbenchVideoPreview title="Clip" url={url} /></I18nProvider>);
    return { ...view, root: () => view.container.querySelector('[data-preview-state]')!, video: () => view.container.querySelector('video') };
  }
  it('ready: an interactive native player with controls and no script surface', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headOk()));
    const { root, video } = renderVideo();
    await flush();
    expect(fetch).toHaveBeenCalledWith('/api/library/assets/clip/raw', expect.objectContaining({ method: 'HEAD', redirect: 'error' }));
    const player = video()!;
    expect(player.hasAttribute('controls')).toBe(true);
    expect(player.getAttribute('aria-label')).toBe('Clip');
    expect(player.getAttribute('preload')).toBe('metadata');
    fireEvent(player, new Event('loadedmetadata'));
    expect(root().getAttribute('data-preview-state')).toBe('ready');
  });
  it('slow: a stalled player times out to a retryable error, and late metadata recovers it', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headOk()));
    const { root, video } = renderVideo();
    await flush();
    act(() => vi.advanceTimersByTime(8000));
    expect(root().getAttribute('data-preview-state')).toBe('error');
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    fireEvent(video()!, new Event('loadedmetadata'));
    expect(root().getAttribute('data-preview-state')).toBe('ready');
  });
  it('failed: bytes that are not video, or a decode error, are errors with Retry', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { headers: { 'content-type': 'text/html' } })));
    const first = renderVideo();
    await flush();
    expect(first.root().getAttribute('data-preview-state')).toBe('error');
    expect(first.video()).toBeNull();
    cleanup();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(headOk()));
    const second = renderVideo();
    await flush();
    fireEvent(second.video()!, new Event('error'));
    expect(second.root().getAttribute('data-preview-state')).toBe('error');
    expect(screen.getByRole('alert')).toHaveTextContent('Video could not load');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await flush();
    expect(second.root().getAttribute('data-preview-state')).toBe('loading');
  });
  it('unavailable: a missing video is unavailable, and a cross-origin or non-API source is refused before any request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 404 })));
    const missing = renderVideo();
    await flush();
    expect(missing.root().getAttribute('data-preview-state')).toBe('unavailable');
    cleanup();
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    for (const url of ['https://cdn.example/clip.mp4', '//cdn.example/clip.mp4', '/assets/../api/x']) {
      const refused = renderVideo(url);
      await flush();
      expect(refused.root().getAttribute('data-preview-state')).toBe('error');
      expect(refused.video()).toBeNull();
      cleanup();
    }
    expect(fetcher).not.toHaveBeenCalled();
  });
});
