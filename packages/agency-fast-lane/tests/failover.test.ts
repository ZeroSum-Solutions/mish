/**
 * Provider failover (`src/failover.ts`) over two REAL model callers whose transport is mocked:
 * every case below drives `createModelCaller` end to end — its retries, its key resolution, its
 * stream reader — with a scripted `fetchImpl`, so the classification is tested against what the
 * caller actually throws, not against hand-made errors.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { createModelCaller, failedAfterStreamBytes, ProviderHttpError, type ProviderName } from '../src/deepseek.ts';
import { createFailoverCaller, createRecordingCaller, failoverReason, ProviderFailoverError, ProviderKeyError, ProviderKeyUnreadableError, type FailoverReason } from '../src/failover.ts';
import { runFastLane, type RunEvent } from '../src/run.ts';
import { fakeModel, loadMaben } from './fixtures.ts';

const encoder = new TextEncoder();

function sseBody(lines: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const line of lines) controller.enqueue(encoder.encode(`data: ${line}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/** One SSE delta, then the stream breaks: output has already reached the caller. */
function sseBodyThenError(content: string): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`));
        return;
      }
      controller.error(new Error('connection reset'));
    },
  });
}

/** Bytes arrive (a role-only chunk, no content), then the stream breaks: first byte, no delta. */
function sseFirstByteThenError(): ReadableStream<Uint8Array> {
  let sent = false;
  return new ReadableStream({
    pull(controller) {
      if (!sent) {
        sent = true;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { role: 'assistant' } }] })}\n\n`));
        return;
      }
      controller.error(new Error('connection reset'));
    },
  });
}

const ok = (content: string) => () => new Response(sseBody([JSON.stringify({ choices: [{ delta: { content } }] })]), { status: 200 });
const status = (code: number) => () => new Response(`body ${code}`, { status: code });

type Step = () => Response | Promise<Response>;

/** Answers each request with the next step; the last step repeats. Counts requests. */
function scripted(steps: Step[]): typeof fetch & { count: number } {
  const f = (async (_input: unknown, init?: RequestInit) => {
    const step = steps[Math.min(f.count, steps.length - 1)]!;
    f.count += 1;
    init?.signal?.throwIfAborted();
    return step();
  }) as typeof fetch & { count: number };
  f.count = 0;
  return f;
}

const instantSleep = async () => {};

function legs(primaryFetch: typeof fetch, secondaryFetch: typeof fetch, opts: {
  primaryKey?: () => Promise<string>;
  secondaryKey?: () => Promise<string>;
  timeoutMs?: number;
  userSignal?: AbortSignal;
} = {}) {
  const failovers: Array<{ from: ProviderName; to: ProviderName; reason: FailoverReason }> = [];
  let before = 0;
  const caller = createFailoverCaller({
    primary: {
      provider: 'deepseek',
      model: 'deepseek-flash',
      call: createModelCaller({ provider: 'deepseek', apiKey: opts.primaryKey ?? (async () => 'k1'), fetchImpl: primaryFetch, sleep: instantSleep, timeoutMs: opts.timeoutMs }),
    },
    secondary: {
      provider: 'cerebras',
      model: 'gpt-oss-120b',
      call: createModelCaller({ provider: 'cerebras', apiKey: opts.secondaryKey ?? (async () => 'k2'), fetchImpl: secondaryFetch, sleep: instantSleep }),
    },
    userSignal: opts.userSignal,
    beforeSecondary: async () => { before += 1; },
    onFailover: (event) => failovers.push(event),
  });
  return { caller, failovers, before: () => before };
}

test('a 429 after bounded retries fails over once, and the secondary answers', async () => {
  const primary = scripted([status(429)]);
  const secondary = scripted([ok('{"from":"cerebras"}')]);
  const { caller, failovers, before } = legs(primary, secondary);
  const response = await caller({ system: 's', user: 'u' });
  assert.equal(response.text, '{"from":"cerebras"}');
  assert.equal(primary.count, 4, 'one attempt plus three retries on the primary first');
  assert.deepEqual(caller.active(), { provider: 'cerebras', model: 'gpt-oss-120b' });
  assert.deepEqual(failovers, [{ from: 'deepseek', to: 'cerebras', reason: 'rate-limited' }]);
  assert.equal(before(), 1);
});

test('a 503 fails over as server-error', async () => {
  const { caller, failovers } = legs(scripted([status(503)]), scripted([ok('{}')]));
  await caller({ system: 's', user: 'u' });
  assert.equal(failovers[0]!.reason, 'server-error');
});

test('a timeout fails over', async () => {
  // The primary never answers; its own 20 ms deadline fires.
  const hang: Step = () => new Promise<Response>(() => {});
  const primary = (async (_input: unknown, init?: RequestInit) => {
    const signal = init!.signal!;
    return await new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      void hang();
    });
  }) as typeof fetch;
  const { caller, failovers } = legs(primary, scripted([ok('{}')]), { timeoutMs: 20 });
  const response = await caller({ system: 's', user: 'u' });
  assert.equal(response.text, '{}');
  assert.equal(failovers[0]!.reason, 'timeout');
});

test('a network error (fetch rejects) fails over', async () => {
  const primary = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
  const { caller, failovers } = legs(primary, scripted([ok('{}')]));
  await caller({ system: 's', user: 'u' });
  assert.equal(failovers[0]!.reason, 'network');
});

test('a missing primary key fails over without any primary request', async () => {
  const primary = scripted([ok('{}')]);
  const { caller, failovers } = legs(primary, scripted([ok('{}')]), { primaryKey: async () => { throw new Error('no key'); } });
  await caller({ system: 's', user: 'u' });
  assert.equal(primary.count, 0);
  assert.equal(failovers[0]!.reason, 'key-unavailable');
});

for (const code of [400, 401, 403, 404, 422]) {
  test(`a ${code} is not a failover: the primary's error is thrown as-is`, async () => {
    const secondary = scripted([ok('{}')]);
    const { caller, failovers } = legs(scripted([status(code)]), secondary);
    await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => error instanceof ProviderHttpError && error.status === code);
    assert.equal(secondary.count, 0);
    assert.equal(failovers.length, 0);
    assert.deepEqual(caller.active(), { provider: 'deepseek', model: 'deepseek-flash' });
  });
}

test('an error after streamed text is not a failover', async () => {
  const secondary = scripted([ok('{}')]);
  const { caller, failovers } = legs(scripted([() => new Response(sseBodyThenError('{"par'), { status: 200 })]), secondary);
  const deltas: string[] = [];
  await assert.rejects(caller({ system: 's', user: 'u', onDelta: (text) => deltas.push(text) }), /connection reset/);
  assert.deepEqual(deltas, ['{"par']);
  assert.equal(secondary.count, 0);
  assert.equal(failovers.length, 0);
});

test('an error after the first byte but before any delta is not a failover', async () => {
  const primary = scripted([() => new Response(sseFirstByteThenError(), { status: 200 })]);
  const secondary = scripted([ok('{}')]);
  const { caller, failovers, before } = legs(primary, secondary);
  const deltas: string[] = [];
  await assert.rejects(caller({ system: 's', user: 'u', onDelta: (text) => deltas.push(text) }), (error: unknown) => {
    assert.match((error as Error).message, /connection reset/);
    assert.ok(failedAfterStreamBytes(error), 'the caller tagged it as failed after stream bytes');
    return true;
  });
  assert.deepEqual(deltas, [], 'no delta ever reached the caller');
  assert.equal(primary.count, 1, 'no retry either: a byte had arrived');
  assert.equal(secondary.count, 0, 'zero secondary requests');
  assert.equal(failovers.length, 0);
  assert.equal(before(), 0);
});

test('a schema failure (200 with an answer that is not the expected JSON) is not a failover', async () => {
  // The caller returns whatever text streamed; parsing and schema repair belong to the run.
  const primary = scripted([ok('this is not json {"sections":')]);
  const secondary = scripted([ok('{}')]);
  const { caller, failovers } = legs(primary, secondary);
  const response = await caller({ system: 's', user: 'u' });
  assert.equal(response.text, 'this is not json {"sections":');
  assert.equal(primary.count, 1);
  assert.equal(secondary.count, 0, 'zero secondary requests');
  assert.equal(failovers.length, 0);
  assert.deepEqual(caller.active(), { provider: 'deepseek', model: 'deepseek-flash' });
});

test('an unreadable key store is its own error and never fails over', async () => {
  const primary = scripted([ok('{}')]);
  const secondary = scripted([ok('{}')]);
  const { caller, failovers, before } = legs(primary, secondary, {
    primaryKey: async () => { throw new ProviderKeyUnreadableError('deepseek'); },
  });
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderKeyUnreadableError, 'surfaced as-is, not wrapped as a missing key');
    assert.ok(!(error instanceof ProviderKeyError));
    assert.equal(error.provider, 'deepseek');
    return true;
  });
  assert.equal(primary.count, 0);
  assert.equal(secondary.count, 0, 'zero secondary requests');
  assert.equal(failovers.length, 0);
  assert.equal(before(), 0);
});

test('an unreadable key store on the secondary surfaces as-is after a failover', async () => {
  const { caller } = legs(scripted([status(503)]), scripted([ok('{}')]), {
    secondaryKey: async () => { throw new ProviderKeyUnreadableError('cerebras'); },
  });
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => error instanceof ProviderKeyUnreadableError && error.provider === 'cerebras');
});

test('a cancellation is not a failover', async () => {
  const controller = new AbortController();
  const secondary = scripted([ok('{}')]);
  const primary = (async (_input: unknown, init?: RequestInit) => {
    controller.abort();
    init!.signal!.throwIfAborted();
    return new Response(null, { status: 500 });
  }) as typeof fetch;
  const { caller, failovers } = legs(primary, secondary, { userSignal: controller.signal });
  await assert.rejects(caller({ system: 's', user: 'u', signal: controller.signal }), (error: unknown) => (error as Error).name === 'AbortError');
  assert.equal(secondary.count, 0);
  assert.equal(failovers.length, 0);
});

test('both legs failing throws ProviderFailoverError naming both outcomes', async () => {
  const { caller } = legs(scripted([status(429)]), scripted([status(503)]));
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailoverError);
    assert.equal(error.name, 'ProviderFailoverError');
    assert.equal(error.attempts.length, 2);
    assert.deepEqual(error.attempts, [
      { provider: 'deepseek', reason: 'rate-limited', status: 429 },
      { provider: 'cerebras', reason: 'server-error', status: 503 },
    ]);
    assert.equal(error.message, 'deepseek answered 429, then cerebras answered 503');
    assert.ok(!error.message.includes('body'), 'no response body in the message');
    return true;
  });
});

test('a secondary auth refusal is still reported with both outcomes', async () => {
  const { caller } = legs(scripted([status(502)]), scripted([status(401)]));
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailoverError);
    assert.equal(error.message, 'deepseek answered 502, then cerebras answered 401');
    return true;
  });
});

test('a missing key on both legs stays a ProviderKeyError', async () => {
  const noKey = async () => { throw new Error('no key'); };
  const { caller } = legs(scripted([ok('{}')]), scripted([ok('{}')]), { primaryKey: noKey, secondaryKey: noKey });
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => error instanceof ProviderKeyError && error.provider === 'cerebras');
});

test('three concurrent calls failing on the primary produce one failover, then stick', async () => {
  const primary = scripted([status(429)]);
  const secondary = scripted([ok('{}')]);
  const { caller, failovers, before } = legs(primary, secondary);
  const responses = await Promise.all([1, 2, 3].map(() => caller({ system: 's', user: 'u' })));
  assert.equal(responses.length, 3);
  assert.equal(failovers.length, 1);
  assert.equal(before(), 1);
  const primaryRequests = primary.count;
  await caller({ system: 's', user: 'u' });
  assert.equal(primary.count, primaryRequests, 'after the switch no call goes back to the primary');
  assert.equal(secondary.count, 4);
});

test('a later call failing on the sticky secondary names the primary as skipped, not the old outcome', async () => {
  const primary = scripted([status(429)]);
  let secondaryAnswers = 0;
  const secondary = (async () => {
    secondaryAnswers += 1;
    return secondaryAnswers === 1 ? ok('{}')() : status(401)();
  }) as typeof fetch;
  const { caller } = legs(primary, secondary);
  await caller({ system: 's', user: 'u' });
  const primaryRequests = primary.count;
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailoverError);
    assert.equal(error.message, 'deepseek skipped after an earlier failover, then cerebras answered 401');
    assert.deepEqual(error.attempts[0], { provider: 'deepseek', reason: 'skipped' });
    return true;
  });
  assert.equal(primary.count, primaryRequests, 'the sticky call never asked the primary');
});

test('timeout classification uses the caller tag, not the error name', () => {
  // An error that merely looks like a timeout (e.g. from some other deadline) is not the caller's
  // own deadline, so it is not eligible; the real case is covered by 'a timeout fails over'.
  assert.equal(failoverReason(new DOMException('the operation timed out', 'TimeoutError'), false, undefined), undefined);
});

test('interleaved sections: accepted output from both providers is recorded, in first-use order', async () => {
  // Two concurrent section calls. `hero` is answered by the primary, but only AFTER `footer` has
  // hit a 503 and switched the build to the secondary; a third call then goes straight there.
  let releaseHero: () => void = () => {};
  const heroGate = new Promise<void>((resolve) => { releaseHero = resolve; });
  let primaryRequests = 0;
  const primary = (async (_input: unknown, init?: RequestInit) => {
    primaryRequests += 1;
    const body = String(init?.body ?? '');
    if (body.includes('fill hero')) {
      await heroGate;
      return ok('{"from":"deepseek"}')();
    }
    return new Response('down', { status: 503 });
  }) as typeof fetch;
  const secondary = scripted([ok('{"from":"cerebras"}')]);
  const { caller, failovers } = legs(primary, secondary);

  const hero = caller({ system: 's', user: 'fill hero', label: 'hero' });
  const footer = await caller({ system: 's', user: 'fill footer', label: 'footer' });
  assert.equal(footer.text, '{"from":"cerebras"}');
  assert.deepEqual(caller.active(), { provider: 'cerebras', model: 'gpt-oss-120b' });
  releaseHero();
  assert.equal((await hero).text, '{"from":"deepseek"}', 'the hero answer the primary produced is kept');
  await caller({ system: 's', user: 'fill about', label: 'about' });

  assert.equal(failovers.length, 1);
  assert.deepEqual(caller.providers(), [
    { provider: 'cerebras', model: 'gpt-oss-120b', sections: ['footer', 'about'] },
    { provider: 'deepseek', model: 'deepseek-flash', sections: ['hero'] },
  ]);
  // The scalar stays "the last provider that answered", for compatibility.
  assert.deepEqual(caller.answered(), { provider: 'cerebras', model: 'gpt-oss-120b' });
  assert.equal(secondary.count, 2);
  assert.ok(primaryRequests >= 2);
});

test('a single-provider build records that provider only, with its sections', async () => {
  const call = createRecordingCaller({
    provider: 'deepseek',
    model: 'deepseek-flash',
    call: createModelCaller({ provider: 'deepseek', apiKey: async () => 'k1', fetchImpl: scripted([ok('{}')]), sleep: instantSleep }),
  });
  await Promise.all([call({ system: 's', user: 'a', label: 'hero' }), call({ system: 's', user: 'b', label: 'hero' }), call({ system: 's', user: 'c' })]);
  assert.deepEqual(call.providers(), [{ provider: 'deepseek', model: 'deepseek-flash', sections: ['hero'] }]);
  assert.deepEqual(call.answered(), { provider: 'deepseek', model: 'deepseek-flash' });
});

test('a request-only cancellation racing a primary 5xx does not switch providers', async () => {
  // No build-level signal at all: only the request carries one. The primary answers 503 and the
  // request is cancelled at the same moment; with no retries left the 503 itself is what rejects.
  const controller = new AbortController();
  const secondary = scripted([ok('{}')]);
  const primary = (async () => {
    controller.abort();
    return new Response('down', { status: 503 });
  }) as typeof fetch;
  const failovers: FailoverReason[] = [];
  let before = 0;
  const caller = createFailoverCaller({
    primary: { provider: 'deepseek', model: 'deepseek-flash', call: createModelCaller({ provider: 'deepseek', apiKey: async () => 'k1', fetchImpl: primary, sleep: instantSleep, maxRetries: 0 }) },
    secondary: { provider: 'cerebras', model: 'gpt-oss-120b', call: createModelCaller({ provider: 'cerebras', apiKey: async () => 'k2', fetchImpl: secondary, sleep: instantSleep }) },
    beforeSecondary: async () => { before += 1; },
    onFailover: (event) => failovers.push(event.reason),
  });
  await assert.rejects(caller({ system: 's', user: 'u', signal: controller.signal }));
  assert.equal(secondary.count, 0, 'no request reaches the secondary');
  assert.equal(before, 0, 'the secondary lock is never taken');
  assert.deepEqual(failovers, []);
  assert.deepEqual(caller.active(), { provider: 'deepseek', model: 'deepseek-flash' });
  assert.deepEqual(caller.providers(), []);
});

test('failoverReason treats an aborted request signal as a cancellation', () => {
  const aborted = AbortSignal.abort();
  assert.equal(failoverReason(new ProviderHttpError('deepseek', 503), false, undefined, aborted), undefined);
  assert.equal(failoverReason(new ProviderHttpError('deepseek', 503), false, undefined, undefined), 'server-error');
});

for (const which of ['build', 'request'] as const) {
  test(`a ${which} cancellation while the switch wait is held does not switch providers`, async () => {
    // The primary answers 503 (eligible). The secondary's lock wait is held open; the cancellation
    // arrives during the wait, and only then does the lock resolve.
    const controller = new AbortController();
    const secondary = scripted([ok('{}')]);
    let releaseWait!: () => void;
    let waitEntered!: () => void;
    const entered = new Promise<void>((resolve) => { waitEntered = resolve; });
    const failovers: FailoverReason[] = [];
    const caller = createFailoverCaller({
      primary: { provider: 'deepseek', model: 'deepseek-flash', call: createModelCaller({ provider: 'deepseek', apiKey: async () => 'k1', fetchImpl: scripted([status(503)]), sleep: instantSleep, maxRetries: 0 }) },
      secondary: { provider: 'cerebras', model: 'gpt-oss-120b', call: createModelCaller({ provider: 'cerebras', apiKey: async () => 'k2', fetchImpl: secondary, sleep: instantSleep }) },
      userSignal: which === 'build' ? controller.signal : undefined,
      beforeSecondary: () => new Promise<void>((resolve) => { releaseWait = resolve; waitEntered(); }),
      onFailover: (event) => failovers.push(event.reason),
    });
    const pending = caller({ system: 's', user: 'u', signal: which === 'request' ? controller.signal : undefined });
    await entered;
    controller.abort();
    releaseWait();
    await assert.rejects(pending, (error: unknown) => error instanceof ProviderHttpError && error.status === 503);
    assert.equal(secondary.count, 0, 'no request reaches the secondary');
    assert.deepEqual(failovers, [], 'no failover event');
    assert.deepEqual(caller.active(), { provider: 'deepseek', model: 'deepseek-flash' }, 'the switch is not committed');
  });
}

// -- Round 3 audit (Opus B1, reproduced): once the switch to the secondary is sticky, a transport-
// class secondary failure must NOT become a `ProviderFailoverError` — that error is never retried
// (`transportRetryReasonOf` never classifies it), so wrapping it there left the secondary with an
// effective retry budget of 0 (worse than before this PR's `maxRetries: 0` on every leg, when the
// secondary had `createModelCaller`'s own default of 3). It must instead surface RAW, so `run.ts`'s
// `callModel` retries it on the same (now sticky) secondary and emits its own event. ---------------

/** Same shape as `legs`, but with `maxRetries: 0` on BOTH callers — matching `build.ts`'s real
 * configuration (every provider's own internal retry is disabled; `run.ts`'s `callModel` is meant
 * to be the one budget). `legs` itself keeps `createModelCaller`'s default of 3 internal retries,
 * which is right for its own (pre-existing) tests but would silently absorb the 503s these new
 * tests are specifically about, inside `createModelCaller`, before `failover.ts` ever saw them. */
function legsNoInternalRetry(primaryFetch: typeof fetch, secondaryFetch: typeof fetch) {
  const failovers: Array<{ from: ProviderName; to: ProviderName; reason: FailoverReason }> = [];
  const caller = createFailoverCaller({
    primary: { provider: 'deepseek', model: 'deepseek-flash', call: createModelCaller({ provider: 'deepseek', apiKey: async () => 'k1', fetchImpl: primaryFetch, sleep: instantSleep, maxRetries: 0 }) },
    secondary: { provider: 'cerebras', model: 'gpt-oss-120b', call: createModelCaller({ provider: 'cerebras', apiKey: async () => 'k2', fetchImpl: secondaryFetch, sleep: instantSleep, maxRetries: 0 }) },
    onFailover: (event) => failovers.push(event),
  });
  return { caller, failovers };
}

test('sticky secondary: a transport-class failure surfaces raw, not wrapped, so callModel can retry it', async () => {
  const primaryFetch = scripted([status(503)]); // the primary always fails -> triggers the switch
  const secondaryFetch = scripted([ok('{}'), status(503), ok('{}')]);
  const { caller } = legsNoInternalRetry(primaryFetch, secondaryFetch);
  // Call 1: the primary fails, the switch commits, the secondary answers.
  await caller({ system: 's', user: 'u' });
  assert.deepEqual(caller.active(), { provider: 'cerebras', model: 'gpt-oss-120b' });
  // Call 2: sticky — goes straight to the secondary, which this time answers 503.
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderHttpError, 'the raw secondary error, never a ProviderFailoverError');
    assert.equal(error.status, 503);
    return true;
  });
  // Call 3: the secondary is healthy again — a caller retrying call 2's request would succeed.
  await caller({ system: 's', user: 'u' });
});

test('sticky secondary: a refusal (non-transport) still wraps in ProviderFailoverError, never retried', async () => {
  const primaryFetch = scripted([status(503)]);
  const secondaryFetch = scripted([ok('{}'), status(400)]);
  const { caller } = legsNoInternalRetry(primaryFetch, secondaryFetch);
  await caller({ system: 's', user: 'u' });
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailoverError, 'a refusal is not a transport blip — still reported as a failover outcome');
    return true;
  });
});

test('committing the switch itself (not yet sticky) still reports ProviderFailoverError when both legs fail, never retried', async () => {
  const primaryFetch = scripted([status(503)]);
  const secondaryFetch = scripted([status(503)]);
  const { caller } = legs(primaryFetch, secondaryFetch);
  await assert.rejects(caller({ system: 's', user: 'u' }), (error: unknown) => {
    assert.ok(error instanceof ProviderFailoverError, 'both legs failed on the very call that would have committed the switch — no third leg to retry on');
    assert.equal(error.message, 'deepseek answered 503, then cerebras answered 503');
    return true;
  });
});

// Opus's own repro (`/tmp/hg8r3/failover.test.ts`), in tree: the full real stack through
// `runFastLane`'s `sections` mode. The primary is a real outage (always 503); the secondary
// answers everything except a single transient 503 on its 2nd request. Before this fix this failed
// the whole build with a `ProviderFailoverError` and 0 `transport-retry` events; after it, the
// build succeeds with exactly one `transport-retry` event on the secondary.
test('Opus repro: a transient 503 on the sticky secondary no longer fails the whole build', async () => {
  const pkg = await loadMaben();
  const BRIEF = 'Riverbend Dental, a family dental practice in Boise. Same-day crowns, sedation options, open Saturdays.';
  const good = fakeModel();
  const primaryFetch = (async () => new Response('down', { status: 503 })) as typeof fetch;
  let secondaryRequests = 0;
  const secondaryFetch = (async (_input, init) => {
    secondaryRequests += 1;
    if (secondaryRequests === 2) return new Response('busy', { status: 503 });
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages: Array<{ role: string; content: string }> };
    const response = await good({ system: '', user: body.messages[1]!.content });
    return new Response(sseBody([JSON.stringify({ choices: [{ delta: { content: response.text } }] })]), { status: 200 });
  }) as typeof fetch;
  const primary = createModelCaller({ provider: 'deepseek', apiKey: async () => 'k', fetchImpl: primaryFetch, sleep: async () => {}, maxRetries: 0 });
  const secondary = createModelCaller({ provider: 'cerebras', apiKey: async () => 'k', fetchImpl: secondaryFetch, sleep: async () => {}, maxRetries: 0 });
  const failovers: unknown[] = [];
  const model = createFailoverCaller({
    primary: { provider: 'deepseek', model: 'deepseek-flash', call: primary },
    secondary: { provider: 'cerebras', model: 'gpt-oss-120b', call: secondary },
    onFailover: (event) => failovers.push(event),
  });
  const events: RunEvent[] = [];
  const report = await runFastLane({ pkg, brief: BRIEF, mode: 'sections', entry: 'maben-r1.html', revision: 1, model, modelName: 'fake', onEvent: (event) => events.push(event) });
  assert.equal(failovers.length, 1, 'the switch to the secondary happens exactly once');
  const retryEvents = events.filter((event) => event.type === 'transport-retry');
  assert.equal(retryEvents.length, 1, 'the secondary\'s own transient 503 is retried, not fatal');
  assert.equal(retryEvents[0]!.type === 'transport-retry' && retryEvents[0]!.reason, 'http-5xx');
  assert.ok(report.html.includes('Riverbend Dental'));
});
