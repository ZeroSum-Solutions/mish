// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installMockMishHost } from '@mish/host/testing';
import { parseCaptureImportMetadata } from '@mish/contracts';

import { DesignBrowserPanel } from '../../src/components/DesignBrowserPanel';
import { I18nProvider } from '../../src/i18n';

// AC-R14.1 desktop browser canvas: the compositor capture of the live page is
// saved as a workbench capture with the page URL, viewport and frame before
// any generation, through the same endpoint as `od workbench capture import`.

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>('../../src/providers/registry');
  return { ...actual, openExternalUrl: vi.fn(async () => true), writeProjectTextFile: vi.fn(async () => null), writeProjectBase64File: vi.fn(async () => null) };
});
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function decodeHeader(value: string): unknown {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(base64 + '='.repeat((4 - base64.length % 4) % 4)), c => c.charCodeAt(0))));
}

let restoreHost: (() => void) | null = null;
const calls: { url: string; init: RequestInit }[] = [];
beforeEach(() => {
  calls.length = 0;
  restoreHost = installMockMishHost({ host: { capture: { page: vi.fn(async () => ({ ok: true as const, dataUrl: 'data:image/png;base64,iVBORw0KGgo=', w: 80, h: 60 })) } } });
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    if (String(input).startsWith('/api/workbench/captures') && init.method === 'POST') {
      return new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'test stops here' } }), { status: 400 });
    }
    return new Response('{}', { status: 200 });
  }));
});
afterEach(() => { cleanup(); restoreHost?.(); restoreHost = null; vi.unstubAllGlobals(); });

describe('DesignBrowserPanel workbench capture', () => {
  it('saves the live page as a native capture with source URL, viewport and frame', async () => {
    render(<I18nProvider initial="en"><DesignBrowserPanel projectId="p1" initialTitle="Example" initialUrl="https://example.com/pricing" onOpenFile={() => {}} onRefreshFiles={() => {}} /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Browser menu' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save capture for reuse' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save capture' }));
    await waitFor(() => expect(calls.some(call => call.init.method === 'POST')).toBe(true));
    const post = calls.find(call => call.init.method === 'POST')!;
    expect(post.url).toBe('/api/workbench/captures?projectId=p1');
    const metadata = parseCaptureImportMetadata(decodeHeader((post.init.headers as Record<string, string>)['x-od-capture-metadata']!));
    expect(metadata).toMatchObject({
      projectId: 'p1', captureMode: 'native-page', sourceUrl: 'https://example.com/pricing', sourceTitle: 'Example',
      viewport: { width: 80, height: 60, deviceScaleFactor: 1 }, frame: { width: 80, height: 60 }, region: null,
    });
    // A refused save keeps the dialog and says why.
    expect((await screen.findByRole('alert')).textContent).toContain('test stops here');
  });
});
