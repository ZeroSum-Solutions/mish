// @vitest-environment jsdom
// AC-R12.4: an owned Magic Patterns import advertises its HTML entry under
// /api/workbench/imports/:id/files/<path>. Enlarge loads that document through
// the same sandboxed srcDoc adapter, keeping the route's no-connect policy;
// other import routes never load as a preview document.
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

const ENTRY = '/api/workbench/imports/import-0123456789abcdef/files/pages/index.html';
const POLICY = "sandbox allow-scripts; default-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'none'; form-action 'none'";

describe('owned import preview', () => {
  it('renders the import entry in the sandboxed frame with its no-connect policy', async () => {
    const body = '<!doctype html><html><head><link rel="stylesheet" href="../styles/site.css"></head><body><main data-owned-import="hero">Imported hero</main></body></html>';
    const fetcher = vi.fn().mockResolvedValue(new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': POLICY } }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Imported hero" url={ENTRY} /></I18nProvider>);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(fetcher).toHaveBeenCalledWith(ENTRY, expect.objectContaining({ redirect: 'error' }));
    const frame = container.querySelector('iframe')!;
    expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
    const srcDoc = frame.getAttribute('srcdoc')!;
    expect(srcDoc).toContain('data-owned-import="hero"');
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).not.toMatch(/content="[^"]*\bsandbox\b/u);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('refuses import routes that are not a stored file of an import', async () => {
    for (const url of ['/api/workbench/imports', '/api/workbench/imports/import-0123456789abcdef', '/api/workbench/imports/not-an-id/files/index.html']) {
      const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
      render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Other" url={url} /></I18nProvider>);
      expect(await screen.findByRole('alert'), url).toHaveTextContent('could not load');
      expect(fetcher, url).not.toHaveBeenCalled();
      cleanup();
    }
  });
});
