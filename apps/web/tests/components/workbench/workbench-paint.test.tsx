// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PreviewAdapterFamily } from '@open-design/contracts';
import { I18nProvider } from '../../../src/i18n';
import { withFirstPaintReport, WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';
import { WorkbenchPreviewShell } from '../../../src/components/workbench/WorkbenchPreviewShell';
import { en } from '../../../src/i18n/locales/en';


const URL = '/api/plugins/paint/preview';
const html = '<!doctype html><html><head></head><body><h1>Visible document</h1><img src="slow.jpg"></body></html>';
function generation(frame: HTMLIFrameElement) {
  return Number(new DOMParser().parseFromString(frame.srcdoc, 'text/html').querySelector('[data-od-workbench-paint-report]')?.getAttribute('data-generation'));
}
function painted(frame: HTMLIFrameElement, source: MessageEventSource | null = frame.contentWindow, url = URL, attempt = 0, documentGeneration = generation(frame)) {
  fireEvent(window, new MessageEvent('message', { source, data: { type: 'od:workbench-preview-painted', url, attempt, generation: documentGeneration } }));
}
async function setup(locale: 'en' = 'en', adapter?: PreviewAdapterFamily, document = html) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(document, { headers: { 'content-type': 'text/html', 'content-security-policy': "default-src 'none'; script-src 'self' 'unsafe-inline'; connect-src 'none'" } }))));
  const view = render(<I18nProvider initial={locale}><WorkbenchPreviewShell title="Paint"><WorkbenchHtmlPreview title="Paint" url={URL} adapter={adapter} /></WorkbenchPreviewShell></I18nProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { ...view, frame: view.container.querySelector('iframe')! };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('preview first paint before slow media finishes', () => {
  for (const [locale, dict] of [['en', en], ["en", en]] as const) {
    it(`reveals painted content before load and retains it through Enlarge in ${locale}`, async () => {
      const { frame, container } = await setup(locale);
      const doc = frame.getAttribute('srcdoc');
      expect(screen.getByRole('status')).toHaveTextContent(dict['workbench.previewLoading']);
      // No iframe load event: below-fold media is still pending.
      painted(frame);
      expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
      expect(screen.queryByRole('status')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: dict['workbench.enlarge'] }));
      expect(container.querySelector('iframe')).toBe(frame);
      expect(frame.getAttribute('srcdoc')).toBe(doc);
      expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
      expect(fetch).toHaveBeenCalledTimes(1);
      fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: { type: 'od:preview-observability', version: 1, event: 'white_screen' } }));
      expect(screen.getByRole('alert')).toBeTruthy();
      painted(frame);
      expect(screen.getByRole('alert')).toBeTruthy();
    });
  }
  it('ignores other windows, old URLs, retry attempts and document generations', async () => {
    const { frame, container } = await setup();
    painted(frame, window);
    painted(frame, frame.contentWindow, '/api/plugins/old/preview');
    painted(frame, frame.contentWindow, URL, 1);
    painted(frame, frame.contentWindow, URL, 0, generation(frame) - 1);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'loading');
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  });
  it('uses native content paint, with the policies before its script and load as a fallback', async () => {
    const { frame, container } = await setup();
    const doc = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
    const script = doc.querySelector('[data-od-workbench-paint-report]')!;
    const policies = Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]'));
    expect(policies).toHaveLength(2);
    for (const policy of policies) {
      expect(policy.getAttribute('content')).toContain("connect-src 'none'");
      expect(policy.compareDocumentPosition(script) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const postMessage = vi.fn(), observe = vi.fn(), disconnect = vi.fn();
    let report!: (list: { getEntries: () => { name: string }[] }) => void;
    class Observer {
      constructor(callback: typeof report) { report = callback; }
      observe = observe;
      disconnect = disconnect;
    }
    new Function('PerformanceObserver', 'window', script.textContent!)(Observer, { parent: { postMessage } });
    expect(observe).toHaveBeenCalledWith({ type: 'paint', buffered: true });
    report({ getEntries: () => [{ name: 'first-paint' }] });
    expect(postMessage).not.toHaveBeenCalled();
    report({ getEntries: () => [{ name: 'first-contentful-paint' }] });
    expect(postMessage).toHaveBeenCalledWith({ type: 'od:workbench-preview-painted', url: URL, attempt: 0, generation: generation(frame) }, '*');
    expect(disconnect).toHaveBeenCalledOnce();
    fireEvent.load(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  });
  it('keeps styled-components gated on its adapter report after first paint', async () => {
    const { frame, container } = await setup('en', 'styled-components');
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'loading');
  });
  it('rejects the original document after an A to B to A navigation', async () => {
    const { frame, container, rerender } = await setup();
    const original = generation(frame);
    for (const url of ['/api/plugins/other/preview', URL]) {
      rerender(<I18nProvider initial="en"><WorkbenchPreviewShell title="Paint"><WorkbenchHtmlPreview title="Paint" url={url} /></WorkbenchPreviewShell></I18nProvider>);
      await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    }
    expect(container.querySelector('iframe')).toBe(frame);
    expect(generation(frame)).toBeGreaterThan(original);
    painted(frame, frame.contentWindow, URL, 0, original);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'loading');
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  });
  it('recovers on a late content paint after the loading deadline', async () => {
    vi.useFakeTimers();
    const { frame, container } = await setup();
    act(() => { vi.advanceTimersByTime(8000); });
    expect(screen.getByRole('alert')).toBeTruthy();
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  });
  it.each([false, true])('keeps an iframe runtime failure after paint (previous timeout: %s)', async (timeout) => {
    vi.useFakeTimers();
    const { frame, container } = await setup();
    if (timeout) act(() => { vi.advanceTimersByTime(8000); });
    fireEvent.error(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error');
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error');
    fireEvent.load(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error');
  });
  it.each(['loading', 'ready', 'timeout'])('keeps a white-screen failure after paint from %s', async (state) => {
    vi.useFakeTimers();
    const { frame, container } = await setup();
    if (state === 'ready') painted(frame);
    if (state === 'timeout') act(() => { vi.advanceTimersByTime(8000); });
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: { type: 'od:preview-observability', version: 1, event: 'white_screen' } }));
    painted(frame);
    fireEvent.load(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'error');
  });
  it.each([
    ['styled-components', 'failed', 'error'],
    ['webgl', 'unavailable', 'unavailable'],
    ['webgl', 'lost', 'unavailable'],
  ] as const)('keeps the %s adapter %s failure after paint', async (adapter, state, expected) => {
    vi.useFakeTimers();
    const { frame, container } = await setup('en', adapter);
    act(() => { vi.advanceTimersByTime(8000); });
    fireEvent(window, new MessageEvent('message', { source: frame.contentWindow, data: { type: 'od:workbench-adapter', adapter, state } }));
    painted(frame);
    fireEvent.load(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', expected);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('preserves a document with an html tag and no head without double wrapping it', async () => {
    const authored = '<!doctype html><HTML lang="es" data-label="a > b"><body><h1>Hola</h1></body></HTML>';
    const reported = withFirstPaintReport(authored, URL, 0, 1);
    expect(reported.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(reported.match(/<html\b/gi)).toHaveLength(1);
    expect(reported).toMatch(/^<!doctype html><HTML lang="es" data-label="a > b"><head><script data-od-workbench-paint-report/);
    const { frame } = await setup('en', undefined, authored);
    expect(frame.srcdoc.match(/<!doctype html>/gi)).toHaveLength(1);
    expect(frame.srcdoc.match(/<html\b/gi)).toHaveLength(1);
    const doc = new DOMParser().parseFromString(frame.srcdoc, 'text/html');
    expect(doc.documentElement.lang).toBe('es');
    expect(doc.documentElement.getAttribute('data-label')).toBe('a > b');
    expect(doc.head.querySelector('[data-od-workbench-paint-report]')).toBeTruthy();
    expect(doc.body.querySelector('h1')?.textContent).toBe('Hola');
  });
  it('ignores a paint report before the fetched document exists', async () => {
    let finish!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Paint" url={URL} /></I18nProvider>);
    const frame = container.querySelector('iframe')!;
    painted(frame, frame.contentWindow, URL, 0, 1);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'loading');
    await act(async () => { finish(new Response(html, { headers: { 'content-type': 'text/html' } })); });
    painted(frame);
    expect(container.querySelector('[data-preview-state]')).toHaveAttribute('data-preview-state', 'ready');
  });
});
