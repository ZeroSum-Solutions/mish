// @vitest-environment jsdom
// AC-R07 preamble "no CDN Tailwind" and the batch-4 preview security model: whatever a preview
// route answers, the Enlarge host runs the document with a no-network floor policy in its own
// head, so a Tailwind Play CDN tag (or any script, style, font or image from another origin) can
// never load, and the document can never open a connection back to the app or the daemon.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../../src/i18n';
import { WorkbenchHtmlPreview } from '../../../src/components/workbench/WorkbenchHtmlPreview';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function srcDocFor(html: string, headers: Record<string, string> = {}, url = '/api/plugins/doc/preview') {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(html, { headers: { 'content-type': 'text/html', ...headers } })));
  const { container } = render(<I18nProvider initial="en"><WorkbenchHtmlPreview title="Doc" url={url} /></I18nProvider>);
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  const srcDoc = container.querySelector('iframe')!.getAttribute('srcdoc')!;
  return new DOMParser().parseFromString(srcDoc, 'text/html');
}

function policies(doc: Document): string[] {
  return Array.from(doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')).map((meta) => meta.getAttribute('content') ?? '');
}

function directive(policy: string, name: string): string[] | null {
  const found = policy.split(';').map((part) => part.trim().split(/\s+/)).find(([key]) => key === name);
  return found ? found.slice(1) : null;
}

describe('Enlarge previews never load from a CDN', () => {
  it('adds a no-network floor policy before any author tag when the route sends no policy', async () => {
    const doc = await srcDocFor('<!doctype html><html><head><script src="https://cdn.tailwindcss.com"></script></head><body><p class="p-4">Hi</p></body></html>');
    const floor = policies(doc).find((policy) => directive(policy, 'connect-src'));
    expect(floor, 'a floor policy must be present').toBeTruthy();
    for (const name of ['script-src', 'style-src', 'img-src', 'font-src', 'media-src']) {
      const sources = directive(floor!, name) ?? directive(floor!, 'default-src')!;
      expect(sources.some((source) => /^https?:$|^https?:\/\/(?!localhost)|^\*$/.test(source)), `${name} admits a remote origin: ${sources.join(' ')}`).toBe(false);
    }
    expect(directive(floor!, 'connect-src')).toEqual(["'none'"]);
    expect(directive(floor!, 'default-src')).toEqual(["'none'"]);
    // The policy is in effect before the CDN tag is parsed.
    const meta = doc.head.querySelector('meta[http-equiv="Content-Security-Policy"]')!;
    const cdn = doc.querySelector('script[src="https://cdn.tailwindcss.com"]')!;
    expect(meta.compareDocumentPosition(cdn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('keeps the floor next to a route policy, so a looser route policy cannot re-admit a CDN', async () => {
    const loose = "default-src *; script-src * 'unsafe-inline'";
    const doc = await srcDocFor('<p>Fragment</p>', { 'content-security-policy': loose });
    const all = policies(doc);
    expect(all).toContain(loose);
    expect(all.some((policy) => directive(policy, 'connect-src')?.join(' ') === "'none'" && directive(policy, 'default-src')?.join(' ') === "'none'")).toBe(true);
  });
});

// Sol r07 BLOCK: `connect-src 'none'` stops fetch/XHR but not <img>/<script>/<link>. An
// origin-wide source would let a preview make GET requests to any `/api` route. The floor
// admits only the exact asset prefixes the preview's own route serves; self-contained
// previews admit no local URL at all.
describe('the floor admits only the preview\'s own asset paths', () => {
  const RESOURCE_DIRECTIVES = ['script-src', 'style-src', 'img-src', 'font-src', 'media-src'];
  function localSources(doc: Document): Record<string, string[]> {
    const floor = policies(doc).find((policy) => directive(policy, 'connect-src'))!;
    return Object.fromEntries(RESOURCE_DIRECTIVES.map((name) => [name, (directive(floor, name) ?? []).filter((source) => source.startsWith(window.location.origin) || source === "'self'")]));
  }
  it('scopes a plugin preview to its own asset directory, and its media proxy for images and media', async () => {
    const sources = localSources(await srcDocFor('<p>Plugin</p>', {}, '/api/plugins/doc/preview'));
    const asset = `${window.location.origin}/api/plugins/doc/asset/`;
    const media = `${window.location.origin}/api/asset-cache`;
    expect(sources).toEqual({ 'script-src': [asset], 'style-src': [asset], 'img-src': [asset, media], 'font-src': [asset], 'media-src': [asset, media] });
  });
  it('scopes a design-system page to its package files', async () => {
    const sources = localSources(await srcDocFor('<p>Kit</p>', {}, '/api/design-systems/kit/static/preview/colors.html'));
    const files = [`${window.location.origin}/api/design-systems/kit/static`, `${window.location.origin}/api/design-systems/kit/static/`];
    for (const name of RESOURCE_DIRECTIVES) expect(sources[name]).toEqual(files);
  });
  it('scopes an owned import to that import\'s own stored files', async () => {
    const sources = localSources(await srcDocFor('<p>Import</p>', {}, '/api/workbench/imports/import-0123456789abcdef/files/pages/index.html'));
    const files = [`${window.location.origin}/api/workbench/imports/import-0123456789abcdef/files/`];
    for (const name of RESOURCE_DIRECTIVES) expect(sources[name], name).toEqual(files);
  });
  it.each(['/api/sections/x/preview', '/api/genui/catalog/silk/preview', '/api/workbench/recipes/gsap/section-entrance-html/preview', '/api/workbench/resources/abc/preview', '/api/workbench/kits/react95/template-window-app/preview'])('admits no local URL for the self-contained %s', async (url) => {
    const sources = localSources(await srcDocFor('<img src="/api/projects"><script src="/api/projects"></script><link rel="stylesheet" href="/api/projects">', {}, url));
    for (const name of RESOURCE_DIRECTIVES) expect(sources[name], name).toEqual([]);
  });
  it('never names the bare origin or self in any resource directive', async () => {
    const doc = await srcDocFor('<p>Plugin</p>', {}, '/api/plugins/doc/preview');
    const floor = policies(doc).find((policy) => directive(policy, 'connect-src'))!;
    for (const name of RESOURCE_DIRECTIVES) {
      const sources = directive(floor, name) ?? [];
      expect(sources).not.toContain(window.location.origin);
      expect(sources).not.toContain(`${window.location.origin}/`);
      expect(sources).not.toContain("'self'");
    }
  });
});
