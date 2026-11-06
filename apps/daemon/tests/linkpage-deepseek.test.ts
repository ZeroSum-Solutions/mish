import { describe, expect, it } from 'vitest';

import { LlmError } from '@mish/linkpage';
import type { Llm } from '@mish/linkpage';
import { ProviderKeyError } from '@mish/agency-fast-lane/deepseek';
import { LINKPAGE_DEEPSEEK_MODEL, resolveLinkPageLlm } from '../src/linkpage/llm.js';
import { failedWarning, fallbackWarning, noModelWarning } from '../src/linkpage/service.js';

const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
const ok = (name: string): Llm => ({ json: async () => name });
const failing = (error: Error): Llm => ({ json: async () => { throw error; } });
const text = { system: 's', user: 'u' };
const photos = { system: 's', user: 'u', images: ['https://example.com/a.png'] };
const SKIP = 'DeepSeek reads text only; photo style was skipped';
const noKey = async () => { throw new Error('none'); };
const base = { fetch, makeOpenRouter: () => ok('openrouter'), makeClaude: () => ok('claude'), makeDeepSeek: () => ok('deepseek') };

describe('DeepSeek lane: auto order', () => {
  it('prefers OpenRouter and never reads the DeepSeek key when OpenRouter has one', async () => {
    let read = 0;
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', resolveDeepSeekKey: async () => { read += 1; return 'd'; }, findClaude: () => '/bin/claude' });
    expect(await llm!.json(text)).toBe('openrouter');
    expect(read).toBe(0);
  });

  it('uses DeepSeek for text when there is no OpenRouter key, and Claude for photos', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: noKey, resolveDeepSeekKey: async () => ' d ', findClaude: () => '/bin/claude' });
    expect(await llm!.json(text)).toBe('deepseek');
    expect(await llm!.json(photos)).toBe('claude');
    expect(llm!.report()).toEqual({ lane: 'claude-cli', calls: 2, fellBackFrom: { lane: 'openrouter', reason: 'no-key' } });
  });

  it('skips photos cleanly when only DeepSeek is available', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: noKey, resolveDeepSeekKey: async () => 'd', findClaude: () => null });
    expect(await llm!.json(text)).toBe('deepseek');
    await expect(llm!.json(photos)).rejects.toThrow(SKIP);
    expect(llm!.report()).toEqual({
      lane: 'deepseek', model: LINKPAGE_DEEPSEEK_MODEL, calls: 1, fellBackFrom: { lane: 'openrouter', reason: 'no-key' },
    });
  });

  it('falls back to Claude when DeepSeek fails, with the DeepSeek reason', async () => {
    const llm = await resolveLinkPageLlm({
      ...base, resolveKey: noKey, resolveDeepSeekKey: async () => 'd', findClaude: () => '/bin/claude',
      makeDeepSeek: () => failing(new LlmError('out-of-credits', 'x', 402)),
    });
    expect(await llm!.json(text)).toBe('claude');
    expect(llm!.report()).toEqual({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'deepseek', reason: 'out-of-credits' } });
  });

  it('keeps today\'s behaviour with no DeepSeek key or lookup: OpenRouter, then Claude', async () => {
    const withoutLookup = await resolveLinkPageLlm({ ...base, resolveKey: noKey, findClaude: () => '/bin/claude' });
    expect(await withoutLookup!.json(text)).toBe('claude');
    const missing = await resolveLinkPageLlm({ ...base, resolveKey: noKey, resolveDeepSeekKey: noKey, findClaude: () => '/bin/claude' });
    expect(await missing!.json(text)).toBe('claude');
    expect(await resolveLinkPageLlm({ ...base, resolveKey: noKey, resolveDeepSeekKey: noKey, findClaude: () => null })).toBeUndefined();
  });

  it('bounds the DeepSeek key lookup', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: noKey, resolveDeepSeekKey: () => new Promise<string>(() => {}), findClaude: () => '/bin/claude', keyTimeoutMs: 20 });
    expect(await llm!.json(text)).toBe('claude');
  });
});

describe('DeepSeek lane: forced', () => {
  it('never reads the OpenRouter key or runs the CLI; no key means no model', async () => {
    const llm = await resolveLinkPageLlm({
      ...base, lane: 'deepseek', resolveKey: async () => { throw new Error('must not be read'); },
      resolveDeepSeekKey: async () => 'd', findClaude: () => '/bin/claude',
    });
    expect(await llm!.json(text)).toBe('deepseek');
    await expect(llm!.json(photos)).rejects.toThrow(SKIP);
    expect(llm!.report()).toEqual({ lane: 'deepseek', model: LINKPAGE_DEEPSEEK_MODEL, calls: 1 });
    expect(await resolveLinkPageLlm({ ...base, lane: 'deepseek', resolveKey: noKey, resolveDeepSeekKey: noKey, findClaude: () => '/bin/claude' })).toBeUndefined();
  });

  it('does not fall back; a failure carries a fixed reason code', async () => {
    const llm = await resolveLinkPageLlm({
      ...base, lane: 'deepseek', resolveKey: noKey, resolveDeepSeekKey: async () => 'd', findClaude: () => '/bin/claude',
      makeDeepSeek: () => failing(new LlmError('bad-key', 'x', 401)),
    });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(llm!.report()).toEqual({ lane: 'none', calls: 0, failed: { lane: 'deepseek', reason: 'bad-key' } });
  });

  it('a skipped photo step alone is not a failure', async () => {
    const llm = await resolveLinkPageLlm({ ...base, lane: 'deepseek', resolveKey: noKey, resolveDeepSeekKey: async () => 'd', findClaude: () => null });
    await expect(llm!.json(photos)).rejects.toThrow(SKIP);
    expect(llm!.report()).toEqual({ lane: 'none', calls: 0 });
  });
});

describe('DeepSeek client (fake fetch, fake key)', () => {
  const sse = (content: string) => new Response(
    `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`,
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
  const build = (deepSeekFetch: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => resolveLinkPageLlm({
    fetch, lane: 'deepseek', resolveKey: noKey, resolveDeepSeekKey: async () => 'ds-fake', findClaude: () => null, deepSeekFetch, ...extra,
  });

  it('sends JSON mode with the pinned model and parses the reply', async () => {
    let body: { model: string; response_format: unknown; messages: Array<{ role: string; content: string }> } | undefined;
    let auth = '';
    const llm = await build((async (_url: unknown, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      auth = String((init?.headers as Record<string, string>).authorization);
      return sse('```json\n{"a":1}\n```');
    }) as typeof globalThis.fetch);
    expect(await llm!.json(text)).toEqual({ a: 1 });
    expect(body?.model).toBe(LINKPAGE_DEEPSEEK_MODEL);
    expect(LINKPAGE_DEEPSEEK_MODEL).toBe('deepseek-flash');
    expect(body?.response_format).toEqual({ type: 'json_object' });
    expect(body?.messages.map((m) => m.role)).toEqual(['system', 'user']);
    expect(auth).toBe('Bearer ds-fake');
  });

  it('maps HTTP and parse failures to fixed codes', async () => {
    const run = async (response: () => Response) => {
      const llm = await build((async () => response()) as typeof globalThis.fetch, { deepSeekMaxRetries: 0 });
      await expect(llm!.json(text)).rejects.toThrow();
      return llm!.report().failed?.reason;
    };
    expect(await run(() => new Response('secret body', { status: 402 }))).toBe('out-of-credits');
    expect(await run(() => new Response('secret body', { status: 401 }))).toBe('bad-key');
    expect(await run(() => new Response('secret body', { status: 500 }))).toBe('http-error');
    expect(await run(() => sse('not json'))).toBe('invalid-output');
  });

  it('maps a stalled call to timeout', async () => {
    const stalled = ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;
    const llm = await build(stalled, { deepSeekTimeoutMs: 20, deepSeekMaxRetries: 0 });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(llm!.report().failed).toEqual({ lane: 'deepseek', reason: 'timeout' });
  });

  it('reports a key failure inside the call as no-key', async () => {
    const llm = await build(fetch, { makeDeepSeek: () => failing(new ProviderKeyError('deepseek')) });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(llm!.report().failed).toEqual({ lane: 'deepseek', reason: 'no-key' });
  });
});

describe('DeepSeek warnings', () => {
  it('names the lane in each plain warning', () => {
    expect(noModelWarning('deepseek')).toMatch(/DeepSeek lane was chosen but no DeepSeek key is set/);
    expect(noModelWarning(undefined)).toMatch(/DeepSeek/);
    expect(fallbackWarning({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'openrouter', reason: 'no-key' } })).toBe('No OpenRouter key is set; used the Claude CLI');
    expect(fallbackWarning({ lane: 'deepseek', model: 'deepseek-flash', calls: 1, fellBackFrom: { lane: 'openrouter', reason: 'no-key' } })).toBe('No OpenRouter key is set; used DeepSeek (text only)');
    expect(fallbackWarning({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'deepseek', reason: 'out-of-credits' } })).toBe('DeepSeek is out of credits; used the Claude CLI');
    expect(failedWarning({ lane: 'none', calls: 0, failed: { lane: 'deepseek', reason: 'timeout' } })).toBe('DeepSeek failed (timeout); the DeepSeek lane was chosen, so the page was built from plain signals');
  });
});
