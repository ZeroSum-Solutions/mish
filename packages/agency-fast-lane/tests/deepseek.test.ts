/** Provider table and caller wiring: URL, auth header, model and extra body per provider. */

import assert from 'node:assert/strict';
import test from 'node:test';
import { inspect } from 'node:util';
import { createModelCaller, createProviderKeyResolver, PROVIDERS, ProviderHttpError, ProviderKeyError, transportRetryReasonOf, vaultSecret } from '../src/deepseek.ts';

type Captured = { url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> };

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function fakeFetch(captured: Captured[], chunks: string[]): typeof fetch {
  return (async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    return new Response(sseBody(chunks), { status: 200 });
  }) as typeof fetch;
}

test('the provider table has the expected shape', () => {
  assert.equal(PROVIDERS.deepseek.baseURL, 'https://api.deepseek.com');
  assert.equal(PROVIDERS.deepseek.vaultKeyId, 'deepseek_api_key');
  assert.equal(PROVIDERS.deepseek.defaultModel, 'deepseek-flash');
  assert.deepEqual(PROVIDERS.deepseek.extraBody, { thinking: { type: 'disabled' } });

  assert.equal(PROVIDERS.cerebras.baseURL, 'https://api.cerebras.ai/v1');
  assert.equal(PROVIDERS.cerebras.vaultKeyId, 'cerebras_api_key');
  assert.equal(PROVIDERS.cerebras.defaultModel, 'gpt-oss-120b');
  assert.deepEqual(PROVIDERS.cerebras.extraBody, { reasoning_effort: 'low' });
});

test('deepseek: URL, auth header, model and extra body', async () => {
  const captured: Captured[] = [];
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 2 } }),
  ];
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'test-key', fetchImpl: fakeFetch(captured, chunks) });
  const response = await call({ system: 's', user: 'u' });

  assert.equal(response.text, '{"ok":true}');
  assert.deepEqual(response.usage, { input: 10, output: 5, cachedRead: 2 });
  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(request.method, 'POST');
  assert.ok(request.headers.authorization, 'authorization header must be present');
  assert.equal(request.body.model, PROVIDERS.deepseek.defaultModel);
  assert.deepEqual(request.body.thinking, { type: 'disabled' });
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.equal(request.body.stream, true);
  assert.deepEqual(request.body.stream_options, { include_usage: true });
});

test('cerebras: URL, auth header, model and extra body', async () => {
  const captured: Captured[] = [];
  const chunks = [
    JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] }),
    JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } }),
  ];
  const call = createModelCaller({ provider: 'cerebras', apiKey: async () => 'test-key', fetchImpl: fakeFetch(captured, chunks) });
  const response = await call({ system: 's', user: 'u' });

  assert.equal(response.text, '{"ok":true}');
  assert.deepEqual(response.usage, { input: 10, output: 5, cachedRead: 3 });
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.cerebras.ai/v1/chat/completions');
  assert.ok(request.headers.authorization, 'authorization header must be present');
  assert.equal(request.body.model, PROVIDERS.cerebras.defaultModel);
  assert.equal(request.body.reasoning_effort, 'low');
  assert.deepEqual(request.body.response_format, { type: 'json_object' });
  assert.deepEqual(request.body.stream_options, { include_usage: true });
});

test('createModelCaller defaults to the deepseek provider when none is given', async () => {
  const captured: Captured[] = [];
  const chunk = JSON.stringify({ choices: [{ delta: { content: '{}' } }] });
  const call = createModelCaller({ apiKey: async () => 'k', fetchImpl: fakeFetch(captured, [chunk]) });
  await call({ system: 's', user: 'u' });
  assert.equal(captured[0]!.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(captured[0]!.body.model, PROVIDERS.deepseek.defaultModel);
});

test('vaultSecret never exposes stdout/stderr from a failed zsvault call', async () => {
  const failing: Parameters<typeof vaultSecret>[1] = async () => {
    const error = new Error('Command failed: zsvault get typesafe_api_key') as Error & { stdout?: string; stderr?: string };
    error.stdout = 'SECRET-VALUE\n';
    error.stderr = '';
    throw error;
  };
  await assert.rejects(vaultSecret('typesafe_api_key', failing), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, 'failed to read typesafe_api_key from zsvault');
    assert.equal(error.message.includes('SECRET-VALUE'), false);
    assert.equal(inspect(error).includes('SECRET-VALUE'), false);
    return true;
  });
});

test('an explicit model overrides the provider default', async () => {
  const captured: Captured[] = [];
  const chunk = JSON.stringify({ choices: [{ delta: { content: '{}' } }] });
  const call = createModelCaller({ provider: 'cerebras', model: 'qwen-3.8-27b', apiKey: async () => 'k', fetchImpl: fakeFetch(captured, [chunk]) });
  await call({ system: 's', user: 'u' });
  assert.equal(captured[0]!.body.model, 'qwen-3.8-27b');
});

// -- retry on rate limits and transient server errors --------------------------------------

/** Returns a different response (or throws) on each successive call; the last entry repeats. */
function sequencedFetch(captured: Captured[], responses: Array<() => Response>): typeof fetch {
  let index = 0;
  return (async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    const make = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    return make();
  }) as typeof fetch;
}

/** A body that yields one SSE chunk, then errors the stream — simulating a mid-stream drop. `code`,
 * when given, is set on the thrown error's own `.code`, the way a real Node/undici network-reset
 * error carries one; omitted, the error is a plain `Error` with no `.code` at all — the shape a
 * genuine content or parse failure mid-stream would have, not a network one. */
function sseBodyThenError(firstChunk: string, message: string, code?: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${firstChunk}\n\n`));
        return;
      }
      const error = new Error(message) as Error & { code?: string };
      if (code !== undefined) error.code = code;
      controller.error(error);
    },
  });
}

const instantSleep = async () => {};
const refusingSleep = async () => { throw new Error('sleep should not be called'); };

test('a 429 then a 200 succeeds, and the response reports one retry', async () => {
  const captured: Captured[] = [];
  const okChunk = JSON.stringify({ choices: [{ delta: { content: '{"ok":true}' } }] });
  const fetchImpl = sequencedFetch(captured, [
    () => new Response('rate limited', { status: 429 }),
    () => new Response(sseBody([okChunk]), { status: 200 }),
  ]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: instantSleep });
  const response = await call({ system: 's', user: 'u' });
  assert.equal(response.text, '{"ok":true}');
  assert.equal(response.retries, 1);
  assert.equal(captured.length, 2);
});

test('a retry-after header (seconds) sets the backoff delay', async () => {
  const captured: Captured[] = [];
  const okChunk = JSON.stringify({ choices: [{ delta: { content: '{}' } }] });
  const fetchImpl = sequencedFetch(captured, [
    () => new Response('rate limited', { status: 429, headers: { 'retry-after': '2' } }),
    () => new Response(sseBody([okChunk]), { status: 200 }),
  ]);
  const sleepCalls: number[] = [];
  const sleep = async (ms: number) => { sleepCalls.push(ms); };
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep });
  await call({ system: 's', user: 'u' });
  assert.deepEqual(sleepCalls, [2000]);
});

test('an absurdly large retry-after is capped at five minutes instead of overflowing the timer', async () => {
  const captured: Captured[] = [];
  const okChunk = JSON.stringify({ choices: [{ delta: { content: '{}' } }] });
  const fetchImpl = sequencedFetch(captured, [
    () => new Response('rate limited', { status: 429, headers: { 'retry-after': '99999999999' } }),
    () => new Response(sseBody([okChunk]), { status: 200 }),
  ]);
  const sleepCalls: number[] = [];
  const sleep = async (ms: number) => { sleepCalls.push(ms); };
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep });
  await call({ system: 's', user: 'u' });
  assert.deepEqual(sleepCalls, [300_000]);
});

test('retries exhausted throws the last provider error, status-only in message, body on detail', async () => {
  const captured: Captured[] = [];
  const fetchImpl = sequencedFetch(captured, [
    () => new Response('server error 1', { status: 500 }),
    () => new Response('server error 2', { status: 502 }),
    () => new Response('server error 3', { status: 503 }),
  ]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: instantSleep, maxRetries: 2 });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.message, 'deepseek 503');
    assert.equal(error.detail, 'server error 3');
    assert.equal(error.message.includes('server error 3'), false);
    return true;
  });
  assert.equal(captured.length, 3, 'one initial attempt plus two retries');
});

test('a 400 is not retried', async () => {
  const captured: Captured[] = [];
  const fetchImpl = sequencedFetch(captured, [() => new Response('bad request', { status: 400 })]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: refusingSleep });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError);
    assert.equal(error.message, 'deepseek 400');
    assert.equal(error.detail, 'bad request');
    return true;
  });
  assert.equal(captured.length, 1);
});

test('a network error before any byte arrives is retried', async () => {
  const captured: Captured[] = [];
  const okChunk = JSON.stringify({ choices: [{ delta: { content: '{}' } }] });
  let attempts = 0;
  const fetchImpl = (async (input, init) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    });
    attempts += 1;
    if (attempts === 1) throw new Error('ECONNRESET');
    return new Response(sseBody([okChunk]), { status: 200 });
  }) as typeof fetch;
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: instantSleep });
  const response = await call({ system: 's', user: 'u' });
  assert.equal(response.retries, 1);
  assert.equal(captured.length, 2);
});

// -- transportRetryReasonOf: what `run.ts`'s bounded unit-level retry may retry (G8 final on
// 857a46b982, ownedinstitution x deepseek ECONNRESET mid-request, --no-failover) ------------------------

test('transportRetryReasonOf: an exhausted pre-first-byte network error is retryable, by its code', async () => {
  const captured: Captured[] = [];
  const fetchImpl = (async (...args: Parameters<typeof fetch>) => {
    captured.push({ url: String(args[0]), method: 'POST', headers: {}, body: {} });
    const error = new Error('read ECONNRESET') as Error & { code: string };
    error.code = 'ECONNRESET';
    throw error;
  }) as typeof fetch;
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: instantSleep, maxRetries: 0 });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), 'ECONNRESET');
    return true;
  });
});

test('transportRetryReasonOf: undici\'s own "terminated" TypeError is retryable', async () => {
  const fetchImpl = (async () => { throw new TypeError('terminated'); }) as typeof fetch;
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: instantSleep, maxRetries: 0 });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), 'terminated');
    return true;
  });
});

test('transportRetryReasonOf: an exhausted 429/5xx with no body read is retryable; a 400 is not', async () => {
  const captured: Captured[] = [];
  const rateLimited = sequencedFetch(captured, [() => new Response('rate limited', { status: 429 })]);
  const call429 = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl: rateLimited, sleep: refusingSleep, maxRetries: 0 });
  await assert.rejects(call429({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), 'http-429');
    return true;
  });
  const badRequest = sequencedFetch([], [() => new Response('bad request', { status: 400 })]);
  const call400 = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl: badRequest, sleep: refusingSleep, maxRetries: 0 });
  await assert.rejects(call400({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), undefined, 'a refusal-class 4xx is never retryable');
    return true;
  });
});

// Round 2 audit (Opus F2): a mid-stream failure carrying a recognized network-reset code IS
// retryable at this classifier's level (G8 final root cause (b): ownedinstitution x deepseek's own failure
// was exactly this shape, ECONNRESET after the first token). Whether `run.ts`'s `callModel`
// actually retries it is a separate, higher-layer decision — see `ModelRequest.hasMergedOutput`'s
// own doc — this function only classifies the error.
test('transportRetryReasonOf: a mid-stream failure with a recognized network-reset code is retryable, by its code', async () => {
  const captured: Captured[] = [];
  const fetchImpl = sequencedFetch(captured, [
    () => new Response(sseBodyThenError('{"partial":true}', 'read ECONNRESET', 'ECONNRESET'), { status: 200 }),
  ]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: refusingSleep });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), 'ECONNRESET');
    return true;
  });
});

test('transportRetryReasonOf: a mid-stream failure with no recognized code is never retryable', async () => {
  const captured: Captured[] = [];
  const fetchImpl = sequencedFetch(captured, [
    () => new Response(sseBodyThenError('{"partial":true}', 'stream closed'), { status: 200 }),
  ]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: refusingSleep });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.equal(transportRetryReasonOf(error), undefined, 'an unrecognized mid-stream error might be a content/parse problem, not a network blip');
    return true;
  });
});

test('transportRetryReasonOf: a plain content/refusal error is never retryable', () => {
  assert.equal(transportRetryReasonOf(new Error('the model refused')), undefined);
  assert.equal(transportRetryReasonOf('not even an object'), undefined);
});

test('an error after the first streamed byte is not retried', async () => {
  const captured: Captured[] = [];
  const firstChunk = JSON.stringify({ choices: [{ delta: { content: 'partial' } }] });
  const fetchImpl = sequencedFetch(captured, [
    () => new Response(sseBodyThenError(firstChunk, 'connection reset'), { status: 200 }),
  ]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl, sleep: refusingSleep });
  await assert.rejects(call({ system: 's', user: 'u' }), /connection reset/);
  assert.equal(captured.length, 1, 'the request is not retried once bytes were already received');
});

test('aborting during backoff rejects promptly and does not retry', async () => {
  const captured: Captured[] = [];
  const fetchImpl = sequencedFetch(captured, [() => new Response('rate limited', { status: 429 })]);
  const call = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl });
  const controller = new AbortController();
  const started = Date.now();
  const promise = call({ system: 's', user: 'u', signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(promise);
  assert.ok(Date.now() - started < 500, 'abort should reject promptly, not wait out the backoff');
  assert.equal(captured.length, 1, 'the retry never fires once aborted mid-backoff');
});

// -- key resolution: environment first, vault only when the environment has none -------------

test('env-only resolution works with the vault absent: the vault reader throws and is never called', async () => {
  let vaultReads = 0;
  const throwingVault = async (id: string): Promise<string> => { vaultReads += 1; throw new Error(`no vault for ${id}`); };
  const resolve = createProviderKeyResolver({ DEEPSEEK_API_KEY: ' env-deepseek ', CEREBRAS_API_KEY: 'env-cerebras' }, throwingVault);
  assert.equal(await resolve('deepseek'), 'env-deepseek');
  assert.equal(await resolve('cerebras'), 'env-cerebras');
  assert.equal(vaultReads, 0);
});

test('a blank or unset env var falls through to the vault, by the provider vault id', async () => {
  const reads: string[] = [];
  const resolve = createProviderKeyResolver({ DEEPSEEK_API_KEY: '   ' }, async (id) => { reads.push(id); return `vault-${id}`; });
  assert.equal(await resolve('deepseek'), 'vault-deepseek_api_key');
  assert.equal(await resolve('cerebras'), 'vault-cerebras_api_key');
  assert.deepEqual(reads, ['deepseek_api_key', 'cerebras_api_key']);
});

test('the provider table names the env var for each provider', () => {
  assert.equal(PROVIDERS.deepseek.envKey, 'DEEPSEEK_API_KEY');
  assert.equal(PROVIDERS.cerebras.envKey, 'CEREBRAS_API_KEY');
});

test('a key resolver rejection becomes ProviderKeyError, with no request sent and no key text in the message', async () => {
  const captured: Captured[] = [];
  const call = createModelCaller({
    provider: 'cerebras',
    apiKey: async () => { throw new Error('zsvault said SECRET-ish detail'); },
    fetchImpl: fakeFetch(captured, ['{}']),
  });
  await assert.rejects(call({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderKeyError);
    assert.equal(error.provider, 'cerebras');
    assert.equal(error.message, 'cerebras key unavailable');
    return true;
  });
  assert.equal(captured.length, 0);
});
