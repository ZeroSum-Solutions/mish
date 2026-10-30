import { describe, expect, it } from 'vitest';

import { createLinkPageFetch, LINKPAGE_FETCH_MAX_BYTES } from '../src/linkpage/safe-fetch.js';
import { resolveLinkPageLlm } from '../src/linkpage/llm.js';

describe('link page fetch', () => {
  it('refuses loopback, private and metadata addresses before any request is made', async () => {
    const f = createLinkPageFetch();
    for (const url of ['http://127.0.0.1/', 'http://localhost:3000/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/meta-data', 'file:///etc/passwd']) {
      await expect(f(url)).rejects.toThrow();
    }
  });

  it('passes a response through with a time limit, and caps how much is read', async () => {
    let seen: RequestInit | undefined;
    const ok = createLinkPageFetch(async (_url, init) => { seen = init; return new Response('hello', { status: 200, headers: { 'content-type': 'text/plain' } }); });
    const res = await ok('https://example.com/', { headers: { 'x-a': '1' } });
    expect(await res.text()).toBe('hello');
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
    expect(new Headers(seen?.headers).get('x-a')).toBe('1');

    const big = createLinkPageFetch(async () => new Response(new Uint8Array(LINKPAGE_FETCH_MAX_BYTES + 1)));
    await expect(big('https://example.com/')).rejects.toThrow(/too large/);
    const declared = createLinkPageFetch(async () => new Response('x', { headers: { 'content-length': String(LINKPAGE_FETCH_MAX_BYTES + 1) } }));
    await expect(declared('https://example.com/')).rejects.toThrow(/too large/);
  });
});

describe('link page model choice', () => {
  const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
  it('prefers the claude command, then OpenRouter, then none', () => {
    expect(resolveLinkPageLlm({ env: { OPENROUTER_API_KEY: 'k' }, fetch, findClaude: () => '/bin/claude' })).toBeDefined();
    expect(resolveLinkPageLlm({ env: { OPENROUTER_API_KEY: 'k' }, fetch, findClaude: () => null })).toBeDefined();
    expect(resolveLinkPageLlm({ env: {}, fetch, findClaude: () => null })).toBeUndefined();
    expect(resolveLinkPageLlm({ env: { OPENROUTER_API_KEY: '  ' }, fetch, findClaude: () => null })).toBeUndefined();
  });
});
