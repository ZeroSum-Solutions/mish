import { describe, expect, it } from 'vitest';

import { createLinkPageFetch, LINKPAGE_FETCH_MAX_BYTES } from '../src/linkpage/safe-fetch.js';
import type { Llm } from '@mish/linkpage';
import { LlmError } from '@mish/linkpage';
import { LINKPAGE_OPENROUTER_MODEL, fetchWithTimeout, linkPageLaneFromEnv, resolveLinkPageLlm } from '../src/linkpage/llm.js';

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
  const ok = (name: string): Llm => ({ json: async () => name });
  const failing = (error: Error): Llm => ({ json: async () => { throw error; } });
  const base = { fetch, makeOpenRouter: () => ok('openrouter'), makeClaude: () => ok('claude') };
  const request = { system: 's', user: 'u' };

  it('uses OpenRouter first, claude when there is no key, none when neither', async () => {
    const both = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', findClaude: () => '/bin/claude' });
    expect(await both!.json(request)).toBe('openrouter');
    const noKey = await resolveLinkPageLlm({ ...base, resolveKey: async () => { throw new Error('none'); }, findClaude: () => '/bin/claude' });
    expect(await noKey!.json(request)).toBe('claude');
    const blank = await resolveLinkPageLlm({ ...base, resolveKey: async () => '  ', findClaude: () => null });
    expect(blank).toBeUndefined();
    const keyOnly = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', findClaude: () => null });
    expect(await keyOnly!.json(request)).toBe('openrouter');
  });

  it('gives the key store key to the OpenRouter client and the pinned model', async () => {
    const seen: string[] = [];
    await resolveLinkPageLlm({ ...base, resolveKey: async () => ' secret-1 ', findClaude: () => null, makeOpenRouter: (key) => { seen.push(key); return ok('openrouter'); } });
    expect(seen).toEqual(['secret-1']);
    expect(LINKPAGE_OPENROUTER_MODEL).toBe('anthropic/claude-sonnet-5.5');
  });

  it('sends images to OpenRouter as image_url parts with the pinned model', async () => {
    let body: { model: string; messages: Array<{ content: unknown }> } | undefined;
    const spy = (async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    }) as typeof globalThis.fetch;
    const { createLlm } = await import('@mish/linkpage');
    const llm = await resolveLinkPageLlm({ fetch, resolveKey: async () => 'k', findClaude: () => null, makeOpenRouter: (apiKey) => createLlm({ apiKey, model: LINKPAGE_OPENROUTER_MODEL, fetch: spy }) });
    expect(await llm!.json({ ...request, images: ['https://x.example/a.png'] })).toEqual({ ok: true });
    expect(body?.model).toBe(LINKPAGE_OPENROUTER_MODEL);
    expect(JSON.stringify(body?.messages[1]?.content)).toContain('image_url');
  });

  it('falls back to claude when OpenRouter fails, but not on a cancel', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', findClaude: () => '/bin/claude', makeOpenRouter: () => failing(new Error('OpenRouter 500')) });
    expect(await llm!.json(request)).toBe('claude');
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const cancelled = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', findClaude: () => '/bin/claude', makeOpenRouter: () => failing(abort) });
    await expect(cancelled!.json(request)).rejects.toBe(abort);
  });

  it('does not wait on a stalled key lookup', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: () => new Promise<string>(() => {}), findClaude: () => '/bin/claude', keyTimeoutMs: 20 });
    expect(await llm!.json(request)).toBe('claude');
  });

  it('hands the resolved claude path to the claude client', async () => {
    const seen: string[] = [];
    await resolveLinkPageLlm({ ...base, resolveKey: async () => '', findClaude: () => '/opt/bin/claude', makeClaude: (executable) => { seen.push(executable); return ok('claude'); } });
    expect(seen).toEqual(['/opt/bin/claude']);
  });

  it('gives the OpenRouter call a time limit, and a timeout falls back to claude like any failure', async () => {
    const stalled = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;
    const bounded = fetchWithTimeout(stalled, 20);
    const started = Date.now();
    await expect(bounded('https://openrouter.ai/x')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(2000);
    const llm = await resolveLinkPageLlm({
      fetch, makeClaude: () => ok('claude'), resolveKey: async () => 'k', findClaude: () => '/bin/claude',
      openRouterFetch: stalled, openRouterTimeoutMs: 20,
    });
    expect(await llm!.json(request)).toBe('claude');
  });
});

describe('link page model report', () => {
  const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
  const ok = (name: string): Llm => ({ json: async () => name });
  const failing = (error: Error): Llm => ({ json: async () => { throw error; } });
  const request = { system: 's', user: 'u' };
  const base = { fetch, makeOpenRouter: () => ok('openrouter'), makeClaude: () => ok('claude') };
  const deps = { fetch, makeClaude: () => ok('claude'), resolveKey: async () => 'k', findClaude: () => '/bin/claude' };

  it('names OpenRouter and its model after a successful call, counting calls', async () => {
    const llm = await resolveLinkPageLlm({ ...deps, makeOpenRouter: () => ok('openrouter') });
    expect(llm!.report()).toEqual({ lane: 'openrouter', model: LINKPAGE_OPENROUTER_MODEL, calls: 0 });
    await llm!.json(request);
    await llm!.json(request);
    expect(llm!.report()).toEqual({ lane: 'openrouter', model: LINKPAGE_OPENROUTER_MODEL, calls: 2 });
  });

  it.each([
    ['402', new LlmError('out-of-credits', 'x', 402), 'out-of-credits'],
    ['401', new LlmError('bad-key', 'x', 401), 'bad-key'],
    ['500', new LlmError('http-error', 'x', 500), 'http-error'],
    ['invalid output', new LlmError('invalid-output', 'x'), 'invalid-output'],
    ['timeout', Object.assign(new Error('t'), { name: 'TimeoutError' }), 'timeout'],
    ['network error', new Error('ECONNRESET https://openrouter.ai sk-secret'), 'http-error'],
  ])('falls back to the claude lane on %s with a fixed reason', async (_name, error, reason) => {
    const llm = await resolveLinkPageLlm({ ...deps, makeOpenRouter: () => failing(error as Error) });
    expect(await llm!.json(request)).toBe('claude');
    const report = llm!.report();
    expect(report).toEqual({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'openrouter', reason } });
    expect(JSON.stringify(report)).not.toMatch(/sk-secret|https?:/);
  });

  it('reports no-key when claude answers without a key, and a failure with no claude still throws', async () => {
    const llm = await resolveLinkPageLlm({ ...deps, resolveKey: async () => '' });
    await llm!.json(request);
    expect(llm!.report()).toEqual({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'openrouter', reason: 'no-key' } });
    const alone = await resolveLinkPageLlm({ ...deps, findClaude: () => null, makeOpenRouter: () => failing(new LlmError('out-of-credits', 'OpenRouter is out of credits', 402)) });
    await expect(alone!.json(request)).rejects.toThrow('out of credits');
  });

  describe('forced lanes', () => {
    const noKeyLookup = async () => { throw new Error('the key store must not be read'); };

    it('claude-cli never calls resolveKey or builds OpenRouter, and reports the lane without a fallback', async () => {
      let made = 0;
      const llm = await resolveLinkPageLlm({ ...base, lane: 'claude-cli', resolveKey: noKeyLookup, findClaude: () => '/bin/claude', makeOpenRouter: () => { made += 1; return ok('openrouter'); } });
      expect(await llm!.json(request)).toBe('claude');
      expect(llm!.report()).toEqual({ lane: 'claude-cli', calls: 1 });
      expect(made).toBe(0);
    });

    it('claude-cli with no claude found gives no model, still without reading the key', async () => {
      expect(await resolveLinkPageLlm({ ...base, lane: 'claude-cli', resolveKey: noKeyLookup, findClaude: () => null })).toBeUndefined();
    });

    it('openrouter never falls back to the CLI: no key means no model, a failure rejects with a coded report', async () => {
      expect(await resolveLinkPageLlm({ ...base, lane: 'openrouter', resolveKey: async () => '', findClaude: () => '/bin/claude' })).toBeUndefined();
      const llm = await resolveLinkPageLlm({ ...base, lane: 'openrouter', resolveKey: async () => 'k', findClaude: () => '/bin/claude', makeOpenRouter: () => failing(new LlmError('out-of-credits', 'x', 402)) });
      await expect(llm!.json(request)).rejects.toThrow();
      expect(llm!.report()).toEqual({ lane: 'none', calls: 0, failed: { lane: 'openrouter', reason: 'out-of-credits' } });
      const good = await resolveLinkPageLlm({ ...base, lane: 'openrouter', resolveKey: async () => 'k', findClaude: () => '/bin/claude' });
      await good!.json(request);
      expect(good!.report()).toEqual({ lane: 'openrouter', model: LINKPAGE_OPENROUTER_MODEL, calls: 1 });
    });

    it('reads the env default and ignores unknown values', () => {
      expect(linkPageLaneFromEnv({ OD_LINKPAGE_MODEL_LANE: ' Claude-CLI ' })).toBe('claude-cli');
      expect(linkPageLaneFromEnv({ OD_LINKPAGE_MODEL_LANE: 'openrouter' })).toBe('openrouter');
      expect(linkPageLaneFromEnv({ OD_LINKPAGE_MODEL_LANE: 'nope' })).toBe('auto');
      expect(linkPageLaneFromEnv({})).toBe('auto');
    });
  });
});
