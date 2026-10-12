// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../src/i18n';
import { WorkbenchPreviewShell } from '../../src/components/workbench/WorkbenchPreviewShell';
import { ComposerPluginPreview } from '../../src/components/ComposerPluginPreview';
import { registerNavigationGuard } from '../../src/router';
import type { InstalledPluginRecord } from '@open-design/contracts';

afterEach(() => { cleanup(); vi.clearAllMocks(); window.history.replaceState(null, '', '/'); });

function setup() {
  const changed = vi.fn();
  const view = render(<I18nProvider initial="en"><div style={{ transform: 'translateX(20px)', contain: 'paint', containerType: 'inline-size' }} data-testid="ancestor"><button data-testid="background">Background</button><WorkbenchPreviewShell title="Form" onExpandedChange={changed}><iframe title="Form content" srcDoc="<input value='start'>" /></WorkbenchPreviewShell></div></I18nProvider>);
  return { ...view, changed };
}

describe('Workbench in-place enlargement', () => {
  it('offers a labelled keyboard exit, focuses it on enlarge and returns to Enlarge on close', () => {
    setup();
    const trigger = screen.getByRole('button', { name: 'Enlarge preview' });
    trigger.focus();
    fireEvent.click(trigger);
    const back = screen.getByRole('button', { name: 'Back to preview' });
    expect(back.closest('[inert]')).toBeNull();
    expect(document.activeElement).toBe(back);
    fireEvent.click(back);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Home reachable inside the enlarged view and uses app navigation', () => {
    window.history.replaceState(null, '', '/');
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    const home = screen.getByRole('button', { name: 'Home' });
    expect(screen.getByRole('dialog').contains(home)).toBe(true);
    expect(home.closest('[inert]')).toBeNull();
    home.focus();
    expect(document.activeElement).toBe(home);
    fireEvent.click(home);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(window.location.pathname).toBe('/');
  });

  it('keeps the enlarged view open when navigation away from a project is blocked', async () => {
    window.history.replaceState(null, '', '/projects/demo');
    const unregister = registerNavigationGuard(() => false);
    try {
      setup();
      fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
      fireEvent.click(screen.getByRole('button', { name: 'Home' }));
      await act(async () => { await Promise.resolve(); });
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(window.location.pathname).toBe('/projects/demo');
    } finally { unregister(); }
  });

  it("labels the enlarged exit and Home in English and preserves the keyboard loop", () => {
    render(<I18nProvider initial="en"><WorkbenchPreviewShell title="Portfolio"><iframe title="Portfolio content" /></WorkbenchPreviewShell></I18nProvider>);
    const trigger = screen.getByRole('button', { name: "Enlarge preview" });
    fireEvent.click(trigger);
    const back = screen.getByRole('button', { name: "Back to preview" });
    const home = screen.getByRole('button', { name: "Home" });
    expect(document.activeElement).toBe(back);
    fireEvent.keyDown(back, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(document.querySelector('iframe'));
    fireEvent.keyDown(document.activeElement!, { key: 'Tab' });
    expect(document.activeElement).toBe(back);
    home.focus();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps the iframe node, window, parent and srcDoc while restoring focus/inert/styles', () => {
    const { container, changed } = setup();
    const frame = container.querySelector('iframe')!;
    const parent = frame.parentNode;
    const contentWindow = frame.contentWindow;
    const trigger = screen.getByRole('button', { name: 'Enlarge preview' });
    trigger.focus();
    fireEvent.click(trigger);
    expect(screen.getByRole('dialog', { name: 'Form' }).contains(frame)).toBe(true);
    expect(frame.parentNode).toBe(parent);
    expect(frame.contentWindow).toBe(contentWindow);
    expect(frame.getAttribute('srcdoc')).toBe("<input value='start'>");
    expect(screen.getByTestId('background').hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('ancestor').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('ancestor').style.transform).toBe('none');
    expect(screen.getByTestId('ancestor').style.containerType).toBe('normal');
    expect(screen.getByTestId('ancestor').style.zIndex).toBe('2147483000');
    expect(changed).toHaveBeenLastCalledWith(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(container.querySelector('iframe')).toBe(frame);
    expect(screen.getByTestId('background').hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('ancestor').style.transform).toBe('translateX(20px)');
    expect(screen.getByTestId('ancestor').style.containerType).toBe('inline-size');
    expect(screen.getByTestId('ancestor').style.zIndex).toBe('');
    expect(document.activeElement).toBe(trigger);
    expect(changed).toHaveBeenLastCalledWith(false);
  });

  it('rejects forged frame Escape and accepts the pinned contentWindow', () => {
    const { container } = setup();
    const frame = container.querySelector('iframe')!;
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:workbench-escape' }, source: window }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:workbench-escape' }, source: frame.contentWindow }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('restores prior inert state and ancestor styles on unmount', () => {
    const { unmount } = setup();
    const sibling = document.createElement('div');
    sibling.setAttribute('inert', '');
    document.body.appendChild(sibling);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    unmount();
    expect(sibling.hasAttribute('inert')).toBe(true);
    sibling.remove();
  });
});

import { WorkbenchHtmlPreview } from '../../src/components/workbench/WorkbenchHtmlPreview';

describe('Workbench HTML adapter', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('inserts response CSP in the real head without changing authored fake tags', async () => {
    const authorAttribute = 'data-template="<head>"';
    const authorComment = '<!-- stored markup: <head> -->';
    const authorScript = '<script>window.savedMarkup = "<head>";</script>';
    const html = `<!doctype html><html ${authorAttribute}>${authorComment}<head data-note="a > b">${authorScript}</head><body><p>Authored content</p></body></html>`;
    const policy = "default-src 'none'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; frame-ancestors 'self'";
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html', 'content-security-policy': policy } })));
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Authored tags" url="/api/plugins/authored/preview" /></I18nProvider>);
    const frame = container.querySelector('iframe')!;
    await act(async () => { await Promise.resolve(); });
    const srcDoc = frame.getAttribute('srcdoc')!;
    expect(srcDoc).toContain(authorAttribute);
    expect(srcDoc).toContain(authorComment);
    expect(srcDoc).toContain(authorScript);
    const parsed = new DOMParser().parseFromString(srcDoc, 'text/html');
    const meta = parsed.head.querySelector('meta[http-equiv="Content-Security-Policy"]');
    expect(meta?.getAttribute('content')).toBe(policy.split(';').slice(0, -1).join(';'));
    expect(parsed.body.textContent).toContain('Authored content');
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
  });
  it('keeps loading and late-ready state through enlargement without reloading the document', async () => {
    let respond!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { respond = resolve; })));
    const { container } = render(<I18nProvider initial="en"><WorkbenchPreviewShell title="Late"><WorkbenchHtmlPreview title="Late" url="/api/plugins/late/preview" /></WorkbenchPreviewShell></I18nProvider>);
    const frame = container.querySelector('iframe')!;
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(screen.getByRole('status').textContent).toContain('Loading');
    await import('@testing-library/react').then(({ act }) => act(async () => { respond(new Response('<input aria-label="Name">', { headers: { 'content-type': 'text/html' } })); }));
    fireEvent.load(frame);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.getAttribute('srcdoc')).toContain('data-od-preview-redirect-guard');
    expect(frame.getAttribute('srcdoc')).toContain('od:workbench-escape');
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(container.querySelector('iframe')).toBe(frame);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('shows unavailable and supports a deliberate retry without hiding the shell', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response('{}', { status: 404 })).mockResolvedValueOnce(new Response('<p>Recovered</p>', { headers: { 'content-type': 'text/html' } })));
    render(<I18nProvider initial="en"><WorkbenchPreviewShell title="Unavailable"><WorkbenchHtmlPreview title="Unavailable" url="/api/plugins/missing/preview" /></WorkbenchPreviewShell></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Enlarge preview' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('unavailable');
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    await screen.findByRole('status');
  });
});


describe('Workbench preview refusal and readiness guards', () => {
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
  it('keeps a baked hover preview as media without fetching its live HTML', () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    const record: InstalledPluginRecord = {
      id: 'baked', title: 'Baked', version: '1.0.0', sourceKind: 'bundled', source: 'fixture',
      trust: 'bundled', capabilitiesGranted: [], fsPath: '/fixture', installedAt: 1, updatedAt: 1,
      manifest: { name: 'baked', version: '1.0.0', od: { kind: 'scenario', mode: 'prototype', preview: { type: 'html', entry: 'assets/preview.html' }, bakedPreview: { poster: '/fixture.png', video: '/fixture.mp4', holdMs: 1000 } } },
    };
    const { container } = render(<I18nProvider initial="en"><ComposerPluginPreview record={record} locale="en" /></I18nProvider>);
    expect(container.querySelector('[data-preview-kind="media"]')).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('refuses an external preview before a byte request', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="External" url="https://example.com/preview" /></I18nProvider>);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not load');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('retains a late ready document after timeout and rejects forged error reports', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<p>Late document</p>', { headers: { 'content-type': 'text/html' } })));
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Late ready" url="/api/plugins/late-ready/preview" /></I18nProvider>);
    await act(async () => { await Promise.resolve(); });
    const frame = container.querySelector('iframe')!;
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:preview-observability', version: 1, event: 'runtime_error' }, source: window }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:preview-observability', version: 1, event: 'runtime_error' }, source: frame.contentWindow }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('reported an issue');
    fireEvent.load(frame);
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent(window, new MessageEvent('message', { data: { type: 'od:preview-observability', version: 1, event: 'white_screen' }, source: frame.contentWindow }));
    expect(screen.getByRole('alert')).toBeTruthy();
    fireEvent.load(frame);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
  it('keeps a 404 unavailable after the load deadline', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{}', { status: 404 })));
    render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Missing" url="/api/plugins/missing/preview" /></I18nProvider>);
    await act(async () => { await Promise.resolve(); });
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
    act(() => vi.advanceTimersByTime(8000));
    expect(screen.getByRole('alert')).toHaveTextContent('unavailable');
  });
});
