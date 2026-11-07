import { describe, expect, it } from 'vitest';

import { LlmError } from '@mish/linkpage';
import type { Llm } from '@mish/linkpage';
import { resolveLinkPageLlm } from '../src/linkpage/llm.js';
import { failedWarning, noModelWarning } from '../src/linkpage/service.js';

const fetch = (async () => new Response('{}')) as typeof globalThis.fetch;
const ok = (name: string): Llm => ({ json: async () => name });
const text = { system: 's', user: 'u' };
const photos = { system: 's', user: 'u', images: ['https://example.com/a.png'] };
const noKey = async () => { throw new Error('none'); };
const base = { fetch, makeOpenRouter: () => ok('openrouter'), makeClaude: () => ok('claude'), makeDeepSeek: () => ok('deepseek') };

const reply = (content: string, status = 200): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });

describe('Baseten lane', () => {
  it('never reads the other keys or runs the CLI; no key means no model', async () => {
    const llm = await resolveLinkPageLlm({
      ...base, lane: 'baseten', resolveKey: async () => { throw new Error('must not be read'); },
      resolveDeepSeekKey: async () => { throw new Error('must not be read'); },
      resolveBasetenKey: async () => 'b', basetenModel: 'org/m', findClaude: () => '/bin/claude', makeBaseten: () => ok('baseten'),
    });
    expect(await llm!.json(text)).toBe('baseten');
    expect(await llm!.json(photos)).toBe('baseten');
    expect(llm!.report()).toEqual({ lane: 'baseten', model: 'org/m', calls: 2 });
    expect(await resolveLinkPageLlm({ ...base, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: noKey, basetenModel: 'org/m', findClaude: () => '/bin/claude' })).toBeUndefined();
  });

  it('auto never touches the Baseten key', async () => {
    const llm = await resolveLinkPageLlm({ ...base, resolveKey: async () => 'k', resolveBasetenKey: async () => { throw new Error('must not be read'); }, findClaude: () => null });
    expect(await llm!.json(text)).toBe('openrouter');
  });

  it('reports model-not-set instead of guessing a model, and makes no request', async () => {
    let calls = 0;
    const llm = await resolveLinkPageLlm({
      fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'b', findClaude: () => null,
      basetenFetch: (async () => { calls += 1; return reply('{}'); }) as typeof globalThis.fetch,
    });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(calls).toBe(0);
    expect(llm!.report()).toEqual({ lane: 'none', calls: 0, failed: { lane: 'baseten', reason: 'model-not-set' } });
  });

  it('sends an OpenAI-style chat request with image_url parts to the configurable base URL', async () => {
    let url = '';
    let auth = '';
    let body: { model: string; messages: Array<{ role: string; content: unknown }> } | undefined;
    const llm = await resolveLinkPageLlm({
      fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'bt-fake', findClaude: () => null,
      basetenModel: 'org/some-model', basetenBaseUrl: 'https://inference.example.test/v1/',
      basetenFetch: (async (u: unknown, init?: RequestInit) => {
        url = String(u);
        auth = String((init?.headers as Record<string, string>).Authorization);
        body = JSON.parse(String(init?.body));
        return reply('```json\n{"a":1}\n```');
      }) as typeof globalThis.fetch,
    });
    expect(await llm!.json(photos)).toEqual({ a: 1 });
    expect(url).toBe('https://inference.example.test/v1/chat/completions');
    expect(auth).toBe('Bearer bt-fake');
    expect(body?.model).toBe('org/some-model');
    expect(body?.messages[1]!.content).toEqual([{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]);
  });

  it('defaults the base URL to Baseten inference', async () => {
    let url = '';
    const llm = await resolveLinkPageLlm({
      fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'b', findClaude: () => null, basetenModel: 'org/m',
      basetenFetch: (async (u: unknown) => { url = String(u); return reply('{}'); }) as typeof globalThis.fetch,
    });
    await llm!.json(text);
    expect(url).toBe('https://inference.baseten.co/v1/chat/completions');
  });

  it('maps failures to the same fixed codes, with no body in the report', async () => {
    const run = async (response: () => Response) => {
      const llm = await resolveLinkPageLlm({
        fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'b', findClaude: () => null, basetenModel: 'org/m',
        basetenFetch: (async () => response()) as typeof globalThis.fetch,
      });
      await expect(llm!.json(text)).rejects.toThrow();
      return llm!.report().failed;
    };
    expect(await run(() => new Response('secret', { status: 402 }))).toEqual({ lane: 'baseten', reason: 'out-of-credits' });
    expect(await run(() => new Response('secret', { status: 401 }))).toEqual({ lane: 'baseten', reason: 'bad-key' });
    expect(await run(() => new Response('secret', { status: 500 }))).toEqual({ lane: 'baseten', reason: 'http-error' });
    expect(await run(() => reply('not json'))).toEqual({ lane: 'baseten', reason: 'invalid-output' });
  });

  it('maps a stalled call to timeout', async () => {
    const stalled = ((_u: unknown, init?: RequestInit) => new Promise<Response>((_res, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
    })) as typeof globalThis.fetch;
    const llm = await resolveLinkPageLlm({
      fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'b', findClaude: () => null, basetenModel: 'org/m',
      basetenFetch: stalled, basetenTimeoutMs: 20,
    });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(llm!.report().failed).toEqual({ lane: 'baseten', reason: 'timeout' });
  });

  it('a make-seam failure keeps the code', async () => {
    const llm = await resolveLinkPageLlm({
      fetch, lane: 'baseten', resolveKey: noKey, resolveBasetenKey: async () => 'b', findClaude: () => null, basetenModel: 'org/m',
      makeBaseten: () => ({ json: async () => { throw new LlmError('bad-key', 'x', 401); } }),
    });
    await expect(llm!.json(text)).rejects.toThrow();
    expect(llm!.report().failed).toEqual({ lane: 'baseten', reason: 'bad-key' });
  });

  it('warnings name Baseten in fixed wording', () => {
    expect(noModelWarning('baseten')).toMatch(/Baseten lane was chosen but no Baseten key is set \(`od agency config set --provider baseten --key-stdin`\)/);
    expect(failedWarning({ lane: 'none', calls: 0, failed: { lane: 'baseten', reason: 'model-not-set' } })).toBe('The Baseten lane was chosen but no model is set (OD_BASETEN_MODEL): the page was built from plain signals');
    expect(failedWarning({ lane: 'none', calls: 0, failed: { lane: 'baseten', reason: 'timeout' } })).toBe('Baseten failed (timeout); the Baseten lane was chosen, so the page was built from plain signals');
  });
});
