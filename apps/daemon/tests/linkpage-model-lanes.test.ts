import { describe, expect, it } from 'vitest';

import { LlmError } from '@mish/linkpage';
import { LINKPAGE_MODEL_TABLE, modelsForJob } from '../src/linkpage/model-lanes.js';
import { LINKPAGE_OPENROUTER_MODEL, resolveLinkPageLlm } from '../src/linkpage/llm.js';

const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';
const SONNET = 'anthropic/claude-sonnet-5.5';
const photos = { system: 's', user: 'u', images: ['https://example.com/a.png'], job: 'vision' as const };
const accept = (value: unknown) => Array.isArray((value as { colors?: unknown } | null)?.colors) && (value as { colors: unknown[] }).colors.length > 0;
const style = JSON.stringify({ colors: [{ hex: '#112233', weight: 5 }] });
const reply = (content: string, status = 200): Response => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status });
const noKey = async () => { throw new Error('none'); };

/** A fake OpenRouter that answers per model id and records every request. */
function openRouter(answers: Record<string, () => Response | Promise<Response>>) {
  const requests: Array<{ url: string; model: string; messages: Array<{ role: string; content: unknown }>; response_format: unknown }> = [];
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    requests.push({ url: String(url), model: body.model, messages: body.messages, response_format: body.response_format });
    const answer = answers[body.model];
    return answer ? answer() : new Response('{}', { status: 404 });
  }) as typeof globalThis.fetch;
  return { requests, fetchImpl };
}

const lane = (fetchImpl: typeof globalThis.fetch, extra: Record<string, unknown> = {}) => resolveLinkPageLlm({
  fetch: fetchImpl, lane: 'openrouter', resolveKey: async () => 'or-fake', resolveDeepSeekKey: noKey, findClaude: () => null, openRouterFetch: fetchImpl, ...extra,
});

describe('the lane table', () => {
  it('lists the vision job with DeepSeek V4.1 Flash first and Sonnet 5.5 as the fallback', () => {
    expect(LINKPAGE_MODEL_TABLE.vision).toEqual([DEEPSEEK, SONNET]);
    expect(LINKPAGE_MODEL_TABLE.understand).toEqual([SONNET]);
    expect(LINKPAGE_OPENROUTER_MODEL).toBe(SONNET);
  });

  it('puts an override first without duplicating it', () => {
    expect(modelsForJob('vision')).toEqual([DEEPSEEK, SONNET]);
    expect(modelsForJob('vision', SONNET)).toEqual([SONNET, DEEPSEEK]);
    expect(modelsForJob('vision', ' other/model ')).toEqual(['other/model', DEEPSEEK, SONNET]);
    expect(modelsForJob('vision', '   ')).toEqual([DEEPSEEK, SONNET]);
    expect(modelsForJob('understand', SONNET)).toEqual([SONNET]);
    expect(modelsForJob(undefined)).toEqual([SONNET]);
  });
});

describe('OpenRouter lane by job', () => {
  it('sends photos to DeepSeek V4.1 Flash as image_url parts in JSON mode', async () => {
    const { requests, fetchImpl } = openRouter({ [DEEPSEEK]: () => reply(style) });
    const llm = await lane(fetchImpl);
    expect(await llm!.json({ ...photos, accept })).toEqual({ colors: [{ hex: '#112233', weight: 5 }] });
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(requests[0]!.model).toBe(DEEPSEEK);
    expect(requests[0]!.response_format).toEqual({ type: 'json_object' });
    expect(requests[0]!.messages[1]!.content).toEqual([{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: 'https://example.com/a.png' } }]);
    expect(llm!.report()).toEqual({ lane: 'openrouter', model: DEEPSEEK, calls: 1 });
  });

  it('keeps the person-reading job on Sonnet 5.5', async () => {
    const { requests, fetchImpl } = openRouter({ [SONNET]: () => reply('{"a":1}'), [DEEPSEEK]: () => reply('{"wrong":true}') });
    const llm = await lane(fetchImpl);
    expect(await llm!.json({ system: 's', user: 'u', job: 'understand' })).toEqual({ a: 1 });
    expect(await llm!.json({ system: 's', user: 'u' })).toEqual({ a: 1 });
    expect(requests.map((r) => r.model)).toEqual([SONNET, SONNET]);
    expect(llm!.report()).toEqual({ lane: 'openrouter', model: SONNET, calls: 2 });
  });

  it.each([
    ['an HTTP error', () => new Response('secret', { status: 500 })],
    ['a rate limit', () => new Response('secret', { status: 429 })],
    ['text that is not JSON', () => reply('sorry, I cannot')],
    ['JSON the step cannot use', () => reply('{"colors":"red"}')],
    ['an error inside a 200', () => new Response(JSON.stringify({ error: { message: 'x' } }), { status: 200 })],
  ])('falls back to Sonnet 5.5 after %s from DeepSeek, in order, and reports the model that answered', async (_name, bad) => {
    const { requests, fetchImpl } = openRouter({ [DEEPSEEK]: bad, [SONNET]: () => reply(style) });
    const llm = await lane(fetchImpl);
    expect(await llm!.json({ ...photos, accept })).toEqual({ colors: [{ hex: '#112233', weight: 5 }] });
    expect(requests.map((r) => r.model)).toEqual([DEEPSEEK, SONNET]);
    expect(llm!.report()).toEqual({ lane: 'openrouter', model: SONNET, calls: 1 });
  });

  it('rejects invalid output from every model, with the fixed code and no fallback past the table', async () => {
    const { requests, fetchImpl } = openRouter({ [DEEPSEEK]: () => reply('{"x":1}'), [SONNET]: () => reply('{"y":2}') });
    const llm = await lane(fetchImpl);
    await expect(llm!.json({ ...photos, accept })).rejects.toBeInstanceOf(LlmError);
    expect(requests.map((r) => r.model)).toEqual([DEEPSEEK, SONNET]);
    expect(llm!.report()).toEqual({ lane: 'none', calls: 0, failed: { lane: 'openrouter', reason: 'invalid-output' } });
  });

  it('does not try the next model when the account is the problem (402, 401)', async () => {
    for (const [status, reason] of [[402, 'out-of-credits'], [401, 'bad-key']] as const) {
      const { requests, fetchImpl } = openRouter({ [DEEPSEEK]: () => new Response('secret', { status }), [SONNET]: () => reply(style) });
      const llm = await lane(fetchImpl);
      await expect(llm!.json({ ...photos, accept })).rejects.toBeInstanceOf(LlmError);
      expect(requests).toHaveLength(1);
      expect(llm!.report().failed).toEqual({ lane: 'openrouter', reason });
    }
  });

  it('does not try the next model after a cancel', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const { requests, fetchImpl } = openRouter({ [DEEPSEEK]: () => { throw abort; }, [SONNET]: () => reply(style) });
    const llm = await lane(fetchImpl);
    await expect(llm!.json({ ...photos, accept })).rejects.toBe(abort);
    expect(requests).toHaveLength(1);
  });

  it('puts the selected override first and keeps DeepSeek as its fallback', async () => {
    const { requests, fetchImpl } = openRouter({ [SONNET]: () => reply('{"nope":1}'), [DEEPSEEK]: () => reply(style) });
    const llm = await lane(fetchImpl, { visionModel: SONNET });
    expect(await llm!.json({ ...photos, accept })).toEqual({ colors: [{ hex: '#112233', weight: 5 }] });
    expect(requests.map((r) => r.model)).toEqual([SONNET, DEEPSEEK]);
  });

  it('in auto, a photo call that fails every model still falls back to the Claude CLI', async () => {
    const { fetchImpl } = openRouter({ [DEEPSEEK]: () => reply('{"x":1}'), [SONNET]: () => reply('{"y":2}') });
    const llm = await resolveLinkPageLlm({
      fetch: fetchImpl, resolveKey: async () => 'or-fake', findClaude: () => '/bin/claude', openRouterFetch: fetchImpl,
      makeClaude: () => ({ json: async () => ({ colors: [] }) }),
    });
    expect(await llm!.json({ ...photos, accept })).toEqual({ colors: [] });
    expect(llm!.report()).toEqual({ lane: 'claude-cli', calls: 1, fellBackFrom: { lane: 'openrouter', reason: 'invalid-output' } });
  });
});
