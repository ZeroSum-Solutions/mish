/**
 * Jev (TypeSafe System One) faithfulness checker: request shape, response parsing, threshold,
 * batching over the documented context ceilings, and advisory (skipped, never thrown) behavior
 * on a network failure. `collectFaithfulnessSlots` is covered separately for its exclusions.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { batchFaithfulnessSlots, collectFaithfulnessSlots, createJevChecker, deterministicAttributionFlags, deterministicClaimFlags, deterministicCommercialWordFlags, deterministicContactFlags, deterministicQuoteFlags, deterministicSentenceClaimFlags, deterministicTraceableFlags, jevErrorMessage, mergeFlagsByMaxProbability, resolveJevKey, type FaithfulnessSlot } from '../src/jev.ts';
import { traceablePathsFor, type ContactKind } from '../src/spine.ts';
import type { JsonObject } from '../src/spine.ts';

const RICH_TXT = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../plugins/_official/examples/agency-storefront/fixtures/briefs/rich.txt'),
  'utf8',
);

type Captured = { url: string; method: string; headers: Record<string, string>; body: JsonObject };

function fakeFetch(captured: Captured[], answers: (body: JsonObject) => JsonObject): typeof fetch {
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    return new Response(JSON.stringify(answers(body)), { status: 200 });
  }) as typeof fetch;
}

function allFalse(body: JsonObject): JsonObject {
  const questions = body.questions as JsonObject;
  const answers: JsonObject = {};
  for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.05 };
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 2 } };
}

test('request shape: endpoint, model, Authorization header, one Noul question per slot', async () => {
  const captured: Captured[] = [];
  const checker = createJevChecker({ apiKey: 'test-key', fetchImpl: fakeFetch(captured, allFalse) });
  const slots: FaithfulnessSlot[] = [{ path: 'brand.name', text: 'WASOTO' }, { path: 'sections[0].text.statement', text: 'Built on craft' }];
  await checker.checkFaithfulness({ brief: 'A plastic surgery practice.', slots });

  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body.model, 'jev-1.13.0');
  assert.equal(request.body.state && (request.body.state as JsonObject).brief, 'A plastic surgery practice.');
  const questions = request.body.questions as Record<string, JsonObject>;
  assert.equal(Object.keys(questions).length, 2);
  assert.equal(questions.slot_0!.type, 'noul');
  assert.ok(typeof questions.slot_0!.instructions === 'string' && (questions.slot_0!.instructions as string).includes('text_0'));
  // never asset ids, destinations, or the id anchor — only what was passed as slots
  assert.equal(JSON.stringify(request.body).includes('destination'), false);
});

test('a resolved apiKey function is called and cached across batches', async () => {
  let calls = 0;
  const captured: Captured[] = [];
  const checker = createJevChecker({
    apiKey: async () => {
      calls += 1;
      return 'lazy-key';
    },
    fetchImpl: fakeFetch(captured, allFalse),
  });
  await checker.checkFaithfulness({ brief: 'b', slots: [{ path: 'a', text: 'x' }] });
  await checker.checkFaithfulness({ brief: 'b', slots: [{ path: 'a', text: 'x' }] });
  assert.equal(calls, 1, 'apiKey resolver is called once and cached');
});

test('response parsing: flags only slots whose noul meets the threshold, with probability', async () => {
  const captured: Captured[] = [];
  const checker = createJevChecker({
    apiKey: 'k',
    fetchImpl: fakeFetch(captured, () => ({
      model: 'jev-1.13.0',
      answers: { slot_0: { type: 'noul', noul: 0.97 }, slot_1: { type: 'noul', noul: 0.1 } },
      usage: { input_tokens: 123, output_tokens: 4 },
    })),
  });
  const result = await checker.checkFaithfulness({
    brief: 'brief',
    slots: [{ path: 'sections[2].text.phone', text: '555-0100' }, { path: 'sections[0].text.statement', text: 'built on craft' }],
  });
  assert.deepEqual(result.flagged, [{ path: 'sections[2].text.phone', probability: 0.97 }]);
  assert.deepEqual(result.usage, { input_tokens: 123, output_tokens: 4 });
  assert.equal(result.calls, 1);
  assert.equal(typeof result.ms, 'number');
});

test('threshold: default 0.85, a custom threshold changes what counts as flagged', async () => {
  const captured: Captured[] = [];
  const fetchImpl = fakeFetch(captured, () => ({ model: 'jev-1.13.0', answers: { slot_0: { type: 'noul', noul: 0.8 } } }));
  const slots: FaithfulnessSlot[] = [{ path: 'p', text: 't' }];

  const atDefault = await createJevChecker({ apiKey: 'k', fetchImpl }).checkFaithfulness({ brief: 'b', slots });
  assert.deepEqual(atDefault.flagged, [], '0.8 is below the default 0.85 threshold');

  const atLower = await createJevChecker({ apiKey: 'k', fetchImpl, threshold: 0.5 }).checkFaithfulness({ brief: 'b', slots });
  assert.deepEqual(atLower.flagged, [{ path: 'p', probability: 0.8 }]);
});

test('batching: many slots over the documented context ceiling split into multiple requests', async () => {
  const captured: Captured[] = [];
  const checker = createJevChecker({ apiKey: 'k', fetchImpl: fakeFetch(captured, allFalse) });
  // ~3,000 chars per slot (~750 estimated tokens) x 50 slots is well past the 28,000-token state
  // budget, so this must split into more than one request.
  const slots: FaithfulnessSlot[] = Array.from({ length: 50 }, (_, index) => ({ path: `sections[${index}].text.statement`, text: 'x'.repeat(3000) }));
  const result = await checker.checkFaithfulness({ brief: 'brief', slots });
  assert.ok(captured.length > 1, `expected multiple batched requests, got ${captured.length}`);
  const totalQuestions = captured.reduce((sum, request) => sum + Object.keys(request.body.questions as JsonObject).length, 0);
  assert.equal(totalQuestions, 50, 'every slot is asked exactly once across all batches');
  assert.equal(result.calls, captured.length);
  assert.equal(result.flagged.length, 0);
});

test('batchFaithfulnessSlots never produces an empty batch and always accounts for every slot', () => {
  const slots: FaithfulnessSlot[] = Array.from({ length: 12 }, (_, index) => ({ path: `p${index}`, text: 'y'.repeat(4000) }));
  const { batches, oversized } = batchFaithfulnessSlots('brief text', slots);
  assert.ok(batches.every((batch) => batch.length > 0));
  assert.equal(batches.flat().length, 12);
  assert.deepEqual(oversized, []);
});

test('batchFaithfulnessSlots: a slot too large to fit even alone with the brief is set aside as oversized, not batched', () => {
  const normal: FaithfulnessSlot = { path: 'sections[0].text.statement', text: 'Built on craft' };
  // ~29,000 estimated tokens (chars/4) alone already exceeds MAX_STATE_TOKENS (28,000) before any
  // other slot joins it, so it can never form a valid batch of its own.
  const huge: FaithfulnessSlot = { path: 'sections[1].text.body', text: 'z'.repeat(120_000) };
  const { batches, oversized } = batchFaithfulnessSlots('brief', [normal, huge]);
  assert.deepEqual(oversized, [huge]);
  assert.deepEqual(batches.flat(), [normal]);
});

test('non-2xx response throws a sanitized jev <status> <phrase>, never the response body', async () => {
  const fetchImpl = (async () => new Response('bad request: state too large', { status: 422, statusText: 'Unprocessable' })) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  await assert.rejects(checker.checkFaithfulness({ brief: 'b', slots: [{ path: 'p', text: 't' }] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, jevErrorMessage(422));
    assert.equal(error.message, 'jev 422 request failed');
    assert.ok(!error.message.includes('bad request'), 'the upstream body never rides out on the thrown error');
    return true;
  });
});

test('jevErrorMessage: a fixed phrase per status, never the caller-supplied body', () => {
  assert.equal(jevErrorMessage(401), 'jev 401 unauthorized');
  assert.equal(jevErrorMessage(403), 'jev 403 unauthorized');
  assert.equal(jevErrorMessage(404), 'jev 404 not found');
  assert.equal(jevErrorMessage(429), 'jev 429 rate limited');
  assert.equal(jevErrorMessage(500), 'jev 500 upstream error');
  assert.equal(jevErrorMessage(503), 'jev 503 upstream error');
  assert.equal(jevErrorMessage(422), 'jev 422 request failed');
});

test('sentinel: an upstream body never rides out through a thrown error or a skipped result', async () => {
  const sentinel = 'SENTINEL-BODY-7731';
  const fetchImpl = (async () => new Response(`<html>${sentinel} — internal trace, secrets, whatever the upstream sends</html>`, { status: 500 })) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });

  // The first batch's failure throws (advisory-vs-throwing policy lives in run.ts's caller, not
  // here); the thrown message must not carry the sentinel body.
  await assert.rejects(checker.checkFaithfulness({ brief: 'b', slots: [{ path: 'p', text: 't' }] }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.ok(!error.message.includes(sentinel));
    assert.equal(error.message, 'jev 500 upstream error');
    return true;
  });

  // A later-batch failure reports `skipped` instead of throwing (see the batching test above);
  // that path must not carry the sentinel either. Two oversized-enough slots force two batches.
  let call = 0;
  const twoBatchFetch = (async (_input, init) => {
    call += 1;
    if (call === 1) {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
      const questions = body.questions as JsonObject;
      const answers: JsonObject = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.1 };
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers }), { status: 200 });
    }
    return new Response(`${sentinel} on batch two`, { status: 500 });
  }) as typeof fetch;
  const bigA = 'a'.repeat(90_000);
  const bigB = 'b'.repeat(90_000);
  const twoBatchChecker = createJevChecker({ apiKey: 'k', fetchImpl: twoBatchFetch });
  const result = await twoBatchChecker.checkFaithfulness({
    brief: 'brief',
    slots: [{ path: 'sections[0].text.a', text: bigA }, { path: 'sections[1].text.b', text: bigB }],
  });
  assert.equal(result.skipped, 'jev 500 upstream error');
  assert.ok(!result.skipped?.includes(sentinel));
});

test('a network failure or timeout is reported as skipped, never thrown', async () => {
  const fetchImpl = (async () => { throw new Error('fetch failed'); }) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  const result = await checker.checkFaithfulness({ brief: 'b', slots: [{ path: 'p', text: 't' }] });
  assert.deepEqual(result.flagged, []);
  assert.equal(result.skipped, 'fetch failed');
});

test('a later-batch failure (non-2xx, not retryable) keeps the earlier batch\'s flags instead of discarding them', async () => {
  // Two oversized-enough slots force two batches (well past MAX_STATE_TOKENS on their own so each
  // is its own batch); the first request succeeds and flags its slot, the second returns 400 — a
  // request-shape error (`jevErrorMessage`'s "request failed" case), never retried, unlike a 429
  // or a 5xx (see the two retry tests below).
  const bigA = 'a'.repeat(90_000);
  const bigB = 'b'.repeat(90_000);
  const slots: FaithfulnessSlot[] = [{ path: 'sections[0].text.a', text: bigA }, { path: 'sections[1].text.b', text: bigB }];
  let call = 0;
  const fetchImpl = (async (_input, init) => {
    call += 1;
    if (call === 1) {
      const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
      const questions = body.questions as JsonObject;
      const answers: JsonObject = {};
      for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.95 };
      return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 500, output_tokens: 10 } }), { status: 200 });
    }
    return new Response('bad request', { status: 400, statusText: 'Bad Request' });
  }) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  const result = await checker.checkFaithfulness({ brief: 'brief', slots });

  assert.equal(call, 2, 'both batches were attempted, the second exactly once (not retryable)');
  assert.deepEqual(result.flagged, [{ path: 'sections[0].text.a', probability: 0.95 }], 'batch one\'s flag survives the batch-two failure');
  assert.equal(result.calls, 2);
  assert.deepEqual(result.usage, { input_tokens: 500, output_tokens: 10 }, 'batch one\'s usage is kept');
  assert.ok(result.skipped?.includes('jev 400'), `expected a jev 400 skip reason, got ${result.skipped}`);
});

test('a transient 503 is retried and a later success is not reported as skipped', async () => {
  // A live G8 build matrix run (repo pre-1dc67a1135, community x deepseek) hit one Jev request
  // that ran the full timeout and never answered, so the strict build failed closed on a
  // `skipped` result with nothing actually wrong with the page (`checked`/`flagged`/`remaining`
  // all reported 0). This is the fix: a transient failure (a 429, a 5xx, or a network error) gets
  // retried a bounded couple of times before `checkFaithfulness` gives up as `skipped`.
  let call = 0;
  const fetchImpl = (async (_input, init) => {
    call += 1;
    if (call < 3) return new Response('unavailable', { status: 503, statusText: 'Service Unavailable' });
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    const questions = body.questions as JsonObject;
    const answers: JsonObject = {};
    for (const id of Object.keys(questions)) answers[id] = { type: 'noul', noul: 0.1 };
    return new Response(JSON.stringify({ model: 'jev-1.13.0', answers, usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
  }) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  const result = await checker.checkFaithfulness({ brief: 'brief', slots: [{ path: 'p', text: 't' }] });

  assert.equal(call, 3, 'two retries, then a third attempt that succeeded');
  assert.equal(result.skipped, undefined, 'the eventual success is not reported as a skip');
  assert.deepEqual(result.flagged, []);
});

test('retries on a persistent 429 are bounded, never unbounded', async () => {
  // Batch one's own non-ok response is a real API/request-shape error worth failing loudly on
  // (`createJevChecker`'s unchanged `calls === 1` throw) — that policy is orthogonal to this
  // retry loop, which only decides how many PHYSICAL attempts happen before that policy runs.
  let call = 0;
  const fetchImpl = (async () => {
    call += 1;
    return new Response('rate limited', { status: 429, statusText: 'Too Many Requests' });
  }) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  await assert.rejects(
    () => checker.checkFaithfulness({ brief: 'brief', slots: [{ path: 'p', text: 't' }] }),
    /jev 429 rate limited/,
  );
  assert.equal(call, 3, 'the first attempt plus exactly two retries, never unbounded');
});

test('checkFaithfulness: an oversized slot is reported distinctly from an API failure, others still checked', async () => {
  const captured: Captured[] = [];
  const normal: FaithfulnessSlot = { path: 'sections[0].text.statement', text: 'Built on craft' };
  const huge: FaithfulnessSlot = { path: 'sections[1].text.body', text: 'z'.repeat(120_000) };
  const checker = createJevChecker({ apiKey: 'k', fetchImpl: fakeFetch(captured, allFalse) });
  const result = await checker.checkFaithfulness({ brief: 'brief', slots: [normal, huge] });

  assert.equal(captured.length, 1, 'only the slot that fits is ever sent');
  const questions = captured[0]!.body.questions as JsonObject;
  assert.equal(Object.keys(questions).length, 1);
  assert.deepEqual(result.oversized, ['sections[1].text.body']);
  assert.equal(result.skipped, undefined, 'oversized is distinct from an API/network failure');
  assert.equal(result.calls, 1);
});

test('no slots means no request and an empty result', async () => {
  let calls = 0;
  const fetchImpl = (async () => { calls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;
  const checker = createJevChecker({ apiKey: 'k', fetchImpl });
  const result = await checker.checkFaithfulness({ brief: 'b', slots: [] });
  assert.deepEqual(result, { flagged: [], ms: 0, calls: 0 });
  assert.equal(calls, 0);
});

test('collectFaithfulnessSlots: text slots only, never assets, destinations, or the id anchor', () => {
  const recipe = {
    schemaVersion: 2,
    family: 'ownededitorial',
    revision: 1,
    wordmark: 'ignored-locked',
    colors: { primary: '#000' },
    brand: { id: 'brand', name: 'WASOTO' },
    sections: [
      {
        id: 'hero',
        assets: { media: 'hero.png' },
        destinations: { primary: 'contact' },
        text: { statement: 'Built on craft', empty: '   ' },
      },
    ],
  };
  const slots = collectFaithfulnessSlots(recipe as unknown as Parameters<typeof collectFaithfulnessSlots>[0]);
  assert.deepEqual(slots, [
    { path: 'brand.name', text: 'WASOTO' },
    { path: 'sections[0].text.statement', text: 'Built on craft' },
  ]);
  assert.ok(!slots.some((slot) => slot.path.includes('assets')));
  assert.ok(!slots.some((slot) => slot.path.includes('destinations')));
  assert.ok(!slots.some((slot) => slot.path.endsWith('.id') || slot.path === 'id'));
});

test('collectFaithfulnessSlots: a nulled slot is skipped, since a null asserts no fact to check', () => {
  const recipe = { brand: { name: 'WASOTO' }, sections: [{ id: 's', content: { phone: null, businessEmail: null, locations: 'Portland' } }] };
  const slots = collectFaithfulnessSlots(recipe as unknown as Parameters<typeof collectFaithfulnessSlots>[0]);
  assert.deepEqual(slots, [
    { path: 'brand.name', text: 'WASOTO' },
    { path: 'sections[0].content.locations', text: 'Portland' },
  ]);
});

test('collectFaithfulnessSlots: locked paths are excluded, since that text was not written by this run', () => {
  const recipe = { brand: { id: 'brand', name: 'Kept From Spine' }, sections: [{ id: 's', text: { statement: 'New copy' } }] };
  const slots = collectFaithfulnessSlots(recipe as unknown as Parameters<typeof collectFaithfulnessSlots>[0], new Set(['brand.name']));
  assert.deepEqual(slots, [{ path: 'sections[0].text.statement', text: 'New copy' }]);
});

test('collectFaithfulnessSlots: an illustrative (x-mock) path never reaches Jev; the default argument keeps it', async () => {
  const recipe = {
    brand: { name: 'Harbor Freight Co' },
    sections: [{ id: 'kpis', items: [{ label: 'Open deals', value: '$1.2M' }] }],
  } as unknown as Parameters<typeof collectFaithfulnessSlots>[0];
  const illustrative = new Set(['sections[0].items[0].value']);
  const bodies: Captured[] = [];
  const checker = createJevChecker({ apiKey: 'k', fetchImpl: fakeFetch(bodies, allFalse) });

  await checker.checkFaithfulness({ brief: 'A freight broker.', slots: collectFaithfulnessSlots(recipe, new Set(), illustrative) });
  const excluded = bodies[0]!.body.state as Record<string, string>;
  assert.deepEqual(Object.values(excluded), ['A freight broker.', 'Harbor Freight Co', 'Open deals']);
  assert.equal(JSON.stringify(bodies[0]!.body).includes('$1.2M'), false, 'the illustrative value is not sent');

  // The daemon repair lists every text path with the default argument and locks all but the
  // flagged ones; an excluding default would leave the mock slot unlocked and re-generated.
  await checker.checkFaithfulness({ brief: 'A freight broker.', slots: collectFaithfulnessSlots(recipe) });
  const state = bodies[1]!.body.state as Record<string, string>;
  assert.equal(Object.keys(state).filter((key) => key.startsWith('text_')).length, 3);
  assert.ok(Object.values(state).includes('$1.2M'));
});

// ---------------------------------------------------------------------------
// resolveJevKey
// ---------------------------------------------------------------------------

test('resolveJevKey: a successful read is cached, the reader runs once', async () => {
  let reads = 0;
  const key = resolveJevKey(async () => {
    reads += 1;
    return 'secret-value';
  });
  assert.equal(await key(), 'secret-value');
  assert.equal(await key(), 'secret-value');
  assert.equal(reads, 1);
});

test('resolveJevKey: a failed read is not cached, so the next call retries', async () => {
  let reads = 0;
  const key = resolveJevKey(async () => {
    reads += 1;
    if (reads === 1) throw new Error('failed to read typesafe_api_key from zsvault');
    return 'secret-value';
  });
  await assert.rejects(key(), /failed to read typesafe_api_key from zsvault/);
  // A cached rejection would keep a long-lived process (the daemon) failing forever even after
  // the vault became readable again.
  assert.equal(await key(), 'secret-value');
  assert.equal(reads, 2);
});

test('a caller cancellation throws an AbortError, while a timeout or network failure stays advisory', async () => {
  // The two look identical at the `fetch` boundary — both arrive as a rejected request — but they
  // mean opposite things to the build above: a cancelled build must unwind, and a flaky Jev call
  // must be left to `--verify-mode` to judge. Only the caller's own signal separates them.
  const controller = new AbortController();
  const abortingFetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    controller.abort();
    throw init?.signal?.reason ?? new DOMException('aborted', 'AbortError');
  }) as typeof fetch;
  const cancelled = createJevChecker({ apiKey: 'k', fetchImpl: abortingFetch, signal: controller.signal });
  await assert.rejects(
    cancelled.checkFaithfulness({ brief: 'brief', slots: [{ path: 'brand.name', text: 'WASOTO' }] }),
    (error: unknown) => (error as { name?: string }).name === 'AbortError',
  );

  const failingFetch = (async () => { throw new Error('socket hang up'); }) as typeof fetch;
  const advisory = createJevChecker({ apiKey: 'k', fetchImpl: failingFetch, signal: new AbortController().signal });
  const result = await advisory.checkFaithfulness({ brief: 'brief', slots: [{ path: 'brand.name', text: 'WASOTO' }] });
  assert.equal(result.skipped, 'socket hang up', 'a failure the caller did not ask for is still reported, never thrown');
});

// ---------------------------------------------------------------------------
// deterministicAttributionFlags: the hard, non-LLM-judged person-name check
// ---------------------------------------------------------------------------

test('deterministicAttributionFlags reproduces and catches the exact storefront defect: two invented review names Jev itself passed at 0 flagged', () => {
  // The live Cerebras storefront brief (fixtures/briefs/rich.txt) never names a customer; its
  // model output nonetheless attributed reviews to "R. Achebe" and "M. Solberg", and Jev's own
  // LLM judge flagged nothing. Neither name is a substring of the brief.
  const brief = 'We\'ve had a couple of nice notes from repeat customers: one wore the field jacket through a wet Portland winter and says it only got better with age; another says the canvas is heavier than expected, in a good way, and the stitching is clean.';
  const slots: FaithfulnessSlot[] = [
    { path: 'sections[7].items[0].name', text: 'R. Achebe' },
    { path: 'sections[7].items[1].name', text: 'M. Solberg' },
    { path: 'sections[7].items[0].quote', text: 'Wore the field jacket through a wet Portland winter and it only got better with age.' },
  ];
  const personNamePaths = new Set(['sections[7].items[0].name', 'sections[7].items[1].name']);
  const flagged = deterministicAttributionFlags(brief, slots, personNamePaths);
  assert.deepEqual(flagged.map((f) => f.path).sort(), ['sections[7].items[0].name', 'sections[7].items[1].name']);
  assert.ok(flagged.every((f) => f.probability === 1));
  // The quote slot is not marked as a person-name path, so it is never flagged by this check —
  // proving the check is scoped, not a blanket re-verification of every slot.
});

test('deterministicAttributionFlags accepts a name that literally appears in the brief, case-insensitively and with surrounding punctuation', () => {
  const brief = 'A note from Priya Raman: "best jacket I own."';
  const slots: FaithfulnessSlot[] = [{ path: 'sections[0].items[0].name', text: 'priya raman' }];
  const flagged = deterministicAttributionFlags(brief, slots, new Set(['sections[0].items[0].name']));
  assert.deepEqual(flagged, []);
});

test('deterministicAttributionFlags ignores slots the schema did not mark as a person-name path', () => {
  const brief = 'Tallow Row makes canvas jackets.';
  const slots: FaithfulnessSlot[] = [{ path: 'sections[3].name', text: 'Completely Invented Product Name' }];
  const flagged = deterministicAttributionFlags(brief, slots, new Set());
  assert.deepEqual(flagged, [], 'only marked person-name paths are checked; a product name is never blocked by this check');
});

test('deterministicAttributionFlags: (4th audit round) a short invented name hiding as a substring of an unrelated brief word is now flagged — "Ed"/"Al"/"Pat" hiding in "expected"/"small"/"patterns"', () => {
  // The exact rich.txt brief a fourth audit pass used: "Ed" is a substring of "expected"/
  // "undyed", "Al" of "small"/"seasonal", "Pat" of "patterns" — none of those are the brief
  // naming a reviewer, but the old raw-substring rule (`haystack.includes(name)`) passed all
  // three. Whole-word-sequence matching closes this: none of these short names appear as their
  // OWN word anywhere in the brief.
  const brief = 'We\'re Tallow Row, a small fashion label based in Portland, Oregon. We make natural-fibre workwear '
    + 'in short seasonal runs: undyed cotton canvas jackets, trousers, shirting and a couple of accessories. '
    + 'We started as two sewists cutting patterns on a kitchen table, and we still cut and sew every piece '
    + 'ourselves in runs small enough to know where each bolt of cloth came from. Everything held up exactly '
    + 'as expected through a wet Portland winter.';
  const slots: FaithfulnessSlot[] = [
    { path: 'a', text: 'Ed' },
    { path: 'b', text: 'Al' },
    { path: 'c', text: 'Pat' },
  ];
  const paths = new Set(['a', 'b', 'c']);
  const flagged = deterministicAttributionFlags(brief, slots, paths);
  assert.deepEqual(new Set(flagged.map((f) => f.path)), paths, `"Ed"/"Al"/"Pat" must all be flagged as invented names, not passed as substrings of unrelated words; got ${JSON.stringify(flagged)}`);
});

test('deterministicAttributionFlags: a multi-word name still matches when the brief genuinely contains that exact phrase, even with a short first name', () => {
  const brief = 'A note from Ed Ramirez: "held up through a hard winter."';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Ed Ramirez' }];
  const flagged = deterministicAttributionFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [], 'a real name the brief actually states must still pass, even though its first word is short');
});

// ---------------------------------------------------------------------------
// deterministicQuoteFlags: review/testimonial quotes traced against the brief's own words
//
// Token-based (not a percentage-coverage scorer) as of this version — see the function's own
// docblock in jev.ts for why: TWO earlier coverage-percentage designs each let a real audit find
// a way to launder invented content past them (a fixed word-count floor, then a cursor-arithmetic
// bug in its percentage-based replacement). CLEAN_BRIEF below deliberately contains none of the
// words these regression cases inject ("free", "shipping", "stock", "star(s)", any digit or
// currency symbol), so a false pass here cannot be explained by coincidental overlap with the
// brief's own unrelated text the way an earlier round's "In stock" case could have been.
// ---------------------------------------------------------------------------

const CLEAN_BRIEF = 'One customer wore the canvas jacket through a long, wet winter and said it only got better with age.';
// Exactly the 16 words of CLEAN_BRIEF's own review clause, word-for-word — the "16-word traced
// sentence" the regression cases below each add one invented tail to.
const TRACED_16 = 'Wore the canvas jacket through a long wet winter and it only got better with age';

test('deterministicQuoteFlags flags a quote that is a plausible paraphrase but shares no real content words with the brief', () => {
  const slots: FaithfulnessSlot[] = [{ path: 'sections[7].items[0].quote', text: 'Absolutely love this jacket, best purchase of the year and it fits perfectly every time.' }];
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, new Set(['sections[7].items[0].quote']));
  assert.deepEqual(flagged, [{ path: 'sections[7].items[0].quote', probability: 1 }]);
});

test('deterministicQuoteFlags accepts a quote that carries the brief\'s own words, even lightly reworded and reordered around them', () => {
  const slots: FaithfulnessSlot[] = [{ path: 'sections[7].items[0].quote', text: '"Wore the canvas jacket through a long, wet winter and it only got better with age."' }];
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, new Set(['sections[7].items[0].quote']));
  assert.deepEqual(flagged, []);
});

test('deterministicQuoteFlags ignores slots the schema did not mark as a quote path', () => {
  const brief = 'Tallow Row makes canvas jackets.';
  const slots: FaithfulnessSlot[] = [{ path: 'sections[1].body', text: 'A completely unrelated sentence about nothing in the brief at all.' }];
  assert.deepEqual(deterministicQuoteFlags(brief, slots, new Set()), []);
});

test('deterministicQuoteFlags: (a) an invented lead-in before an otherwise fully-traced run is flagged, not laundered through by the traced words that follow it (the cursor-arithmetic hole)', () => {
  const slots: FaithfulnessSlot[] = [{ path: 'sections[7].items[0].quote', text: `Free shipping now. ${TRACED_16}.` }];
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, new Set(['sections[7].items[0].quote']));
  assert.deepEqual(flagged, [{ path: 'sections[7].items[0].quote', probability: 1 }], '"free" and "shipping" are unstated content words; an invented lead-in must not be credited as "covered" just because the real run follows it');
});

test('deterministicQuoteFlags: (b) a price or a star rating appended to a fully-traced sentence is flagged (the CLAIM_GLYPH single-match / stripped-glyph hole)', () => {
  const dollarSlot: FaithfulnessSlot = { path: 'sections[7].items[0].quote', text: `${TRACED_16}. $999.` };
  const starsSlot: FaithfulnessSlot = { path: 'sections[7].items[1].quote', text: `${TRACED_16}. ★★★★★` };
  const emojiStarsSlot: FaithfulnessSlot = { path: 'sections[7].items[2].quote', text: `${TRACED_16}. ⭐⭐⭐⭐⭐` };
  const paths = new Set(['sections[7].items[0].quote', 'sections[7].items[1].quote', 'sections[7].items[2].quote']);
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, [dollarSlot, starsSlot, emojiStarsSlot], paths);
  assert.deepEqual(
    new Set(flagged.map((flag) => flag.path)),
    paths,
    'a dollar amount, a ★ star run and a ⭐ star run each appended to an otherwise fully-traced sentence must all be flagged — the old single-match, non-global CLAIM_GLYPH regex only caught the FIRST glyph in a slot, and stripped-to-letters tokenizing made a glyph-only addition invisible to word coverage entirely',
  );
});

test('deterministicQuoteFlags: (c) a short commercial tail appended to a fully-traced 16-word sentence is flagged, however small a fraction of the quote it is (the 85%-coverage hole)', () => {
  const freeShippingSlot: FaithfulnessSlot = { path: 'sections[7].items[0].quote', text: `${TRACED_16}. Free shipping.` };
  const inStockSlot: FaithfulnessSlot = { path: 'sections[7].items[1].quote', text: `${TRACED_16}. In stock.` };
  const fiveStarsSlot: FaithfulnessSlot = { path: 'sections[7].items[2].quote', text: `${TRACED_16}. Five stars.` };
  const paths = new Set(['sections[7].items[0].quote', 'sections[7].items[1].quote', 'sections[7].items[2].quote']);
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, [freeShippingSlot, inStockSlot, fiveStarsSlot], paths);
  assert.deepEqual(
    new Set(flagged.map((flag) => flag.path)),
    paths,
    'a 2-word commercial tail on a 16-word traced sentence (89% coverage under the old percentage rule) must still be flagged: there is no coverage percentage a genuinely new, unstated fact should ever clear',
  );
});

test('deterministicQuoteFlags: a star rating with no other alphabetic content is flagged, not skipped for an empty content-word list', () => {
  const slots: FaithfulnessSlot[] = [{ path: 'sections[7].items[0].quote', text: '★★★★★' }];
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, new Set(['sections[7].items[0].quote']));
  assert.deepEqual(flagged, [{ path: 'sections[7].items[0].quote', probability: 1 }], 'a glyph-only quote must never be skipped just because it carries no content words');
});

test('deterministicQuoteFlags: a claim token that IS in the brief (the real price) is accepted, not flagged just for being a number', () => {
  const brief = 'The Field Jacket is $248. One customer wore it through a wet winter and said it only got better with age.';
  const slots: FaithfulnessSlot[] = [{ path: 'sections[7].items[0].quote', text: 'The $248 jacket only got better with age through the wet winter.' }];
  const flagged = deterministicQuoteFlags(brief, slots, new Set(['sections[7].items[0].quote']));
  assert.deepEqual(flagged, [], 'a price the brief itself states is a real, checkable fact, not an invented one — the check must not flag every number on principle');
});

test('deterministicQuoteFlags: realistic paraphrase generally (not just this family\'s own fixture) still passes — reordering, contractions, tense change and plural forms', () => {
  const brief = 'Our tailor hand-stitches every jacket in a small Lyon workshop. Customers say the fit is close and the fabric wears well for years.';
  const slots: FaithfulnessSlot[] = [
    // Reordering: the fabric clause moved ahead of the fit clause.
    { path: 'a', text: 'The fabric wears well for years, and the fit is close.' },
    // Passive-voice restructuring of the same facts, still every content word traceable.
    { path: 'b', text: 'Every jacket is hand-stitched by our tailor in a small workshop in Lyon.' },
    // A contraction ("it's") standing in for "it is", plus reordering.
    { path: 'c', text: "Customers say it's a close fit and the fabric wears well." },
    // -ed tense change on a word the brief gives in -es form ("stitches" -> "stitched").
    { path: 'd', text: 'Every jacket is hand-stitched in a small Lyon workshop by our tailor.' },
  ];
  const flagged = deterministicQuoteFlags(brief, slots, new Set(['a', 'b', 'c', 'd']));
  assert.deepEqual(flagged, [], `realistic light paraphrase (reordering, contractions, tense/plural variation) must not be over-flagged; got ${JSON.stringify(flagged)}`);
});

// ---------------------------------------------------------------------------
// Round 3 audit: tokenizer edge cases in claimTokensOf and stemVariants/comparableForm, all
// against CLEAN_BRIEF/TRACED_16 (no digits, currency, ratings or commercial words of their own) so
// a pass cannot be explained by coincidental unrelated overlap.
// ---------------------------------------------------------------------------

test('deterministicQuoteFlags: (1) a thousands-separated amount is one claim token, not two — a quote claiming only the first digit group of a larger brief amount is flagged, not blessed by a partial match', () => {
  const brief = 'The jacket costs $1,499 and ships within three business days.';
  const partialSlot: FaithfulnessSlot = { path: 'a', text: 'It costs $1 and ships within three business days.' };
  const exactSlot: FaithfulnessSlot = { path: 'b', text: 'It costs $1,499 and ships within three business days.' };
  const flagged = deterministicQuoteFlags(brief, [partialSlot, exactSlot], new Set(['a', 'b']));
  assert.deepEqual(flagged.map((f) => f.path), ['a'], `only the partial-amount quote should flag; the exact one should pass. got ${JSON.stringify(flagged)}`);
});

test('deterministicQuoteFlags: (1) a postfix-currency amount cannot be smuggled in by coincidentally matching a bare non-price number elsewhere in the brief (the "15oz" hole)', () => {
  const brief = 'Made of 15oz undyed canvas, hand-sewn in Portland.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Made of 15oz canvas, hand-sewn in Portland, on sale for 15€ this week.' }];
  const flagged = deterministicQuoteFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], 'a postfix-currency "15€" must not be satisfied by the brief\'s unrelated bare "15" (the fabric weight)');
});

test('deterministicQuoteFlags: (1) fullwidth digits and currency symbols are NFKC-normalized before checking — an unstated fullwidth price is still caught, and a genuine one (matching the brief\'s real ASCII price) still passes', () => {
  const brief = 'The jacket costs $248 and ships within three business days.';
  const inventedFullwidth: FaithfulnessSlot = { path: 'a', text: 'It costs ＄１２４８ and ships within three business days.' }; // ＄1248
  const genuineFullwidth: FaithfulnessSlot = { path: 'b', text: 'It costs ＄２４８ and ships within three business days.' }; // ＄248
  const flagged = deterministicQuoteFlags(brief, [inventedFullwidth, genuineFullwidth], new Set(['a', 'b']));
  assert.deepEqual(flagged.map((f) => f.path), ['a'], `an invented fullwidth price must flag; the genuine one (same amount as the brief, just fullwidth digits) must pass. got ${JSON.stringify(flagged)}`);
});

test('deterministicQuoteFlags: (2) rating marks — bare asterisks, "N/5" and "N-star"/"N star(s)" phrases — are all claim tokens that must appear in the brief', () => {
  const asterisks: FaithfulnessSlot = { path: 'a', text: `${TRACED_16}. *****` };
  const fiveOfFive: FaithfulnessSlot = { path: 'b', text: `${TRACED_16}. 5/5` };
  const fiveStar: FaithfulnessSlot = { path: 'c', text: `${TRACED_16}. 5-star quality` };
  const fiveStars: FaithfulnessSlot = { path: 'd', text: `${TRACED_16}. 5 stars` };
  const paths = new Set(['a', 'b', 'c', 'd']);
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, [asterisks, fiveOfFive, fiveStar, fiveStars], paths);
  assert.deepEqual(new Set(flagged.map((f) => f.path)), paths, `all four rating-mark forms must flag when the brief states no rating at all; got ${JSON.stringify(flagged)}`);
});

test('deterministicQuoteFlags: (2) a symbol-only quote (no claim token the regex recognizes, no content word) still flags rather than passing by default', () => {
  // A single asterisk: below RATING_RE's {2,} threshold, so it produces zero recognized claim
  // tokens and zero content words — exactly the "nothing to check" case that must not pass by
  // default per the audit's explicit instruction.
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: '*' }];
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], 'a quote with nothing recognizable must flag unless verbatim-present in the brief, never pass by default');
});

test('deterministicQuoteFlags: (3) the commercial-word denylist forces an exact match, closing the Porter-stem collision class rather than one example of it', () => {
  const stockBrief = 'We also make a wool stocking cap for winter.';
  const stockingVsStock: FaithfulnessSlot = { path: 'a', text: 'In stock.' };
  const starBrief = 'One customer kept staring at how the jacket aged through a long winter.';
  const staringVsStarRating: FaithfulnessSlot = { path: 'b', text: 'Kept staring at how the jacket aged through a long winter. ★★★★★' };
  const flaggedStock = deterministicQuoteFlags(stockBrief, [stockingVsStock], new Set(['a']));
  const flaggedStar = deterministicQuoteFlags(starBrief, [staringVsStarRating], new Set(['b']));
  assert.deepEqual(flaggedStock, [{ path: 'a', probability: 1 }], '"stocking" (a knit item) must not make an unstated "In stock." pass just because they share a Porter stem');
  assert.deepEqual(flaggedStar, [{ path: 'b', probability: 1 }], '"staring"/"stared" must not make an unstated ★★★★★ rating pass just because a naive stemmer\'s stripped form happens to spell "star"');
});

test('deterministicQuoteFlags: (3) a denylisted commercial word is still accepted when the quote reuses the BRIEF\'S OWN exact form of it', () => {
  const brief = 'Customers left glowing reviews about the jacket.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Glowing reviews about the jacket.' }];
  const flagged = deterministicQuoteFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [], 'the denylist forces EXACT matching, not zero matching — a brief that genuinely uses a denylisted word must still let a quote reuse that exact word');
});

// ---------------------------------------------------------------------------
// Property-style generative coverage: for CLEAN_BRIEF, every one of a broad list of commercial
// tails (many price formats, many rating formats, stock/shipping/free/discount phrasing) appended
// to the genuinely-traced TRACED_16 sentence must flag — not just the handful of specific examples
// named above — and a separate broad list of genuine/paraphrased sentences from the brief must all
// pass cleanly. This is the "close the whole bug class" coverage the audit asked for, distinct from
// pinning individual reproductions.
// ---------------------------------------------------------------------------

const COMMERCIAL_TAILS: readonly string[] = [
  '$99', '$1,499', '99.99', '15%', '15€', '€15', '15 EUR', 'EUR 15', '99 USD',
  '★★★★★', '⭐⭐⭐⭐⭐', '*****', '5/5', '10/10', '5 stars', '5-star', 'five-star',
  'In stock.', 'Ships free.', 'Free shipping.', 'On sale now.', '20% off.', 'Discounted price.',
  'Fully guaranteed.', 'Lifetime warranty.', 'Highly rated.', 'Top reviews.',
];

test('property: every commercial tail in COMMERCIAL_TAILS, appended to the genuinely-traced TRACED_16 sentence, is flagged', () => {
  const slots: FaithfulnessSlot[] = COMMERCIAL_TAILS.map((tail, index) => ({ path: `tail-${index}`, text: `${TRACED_16}. ${tail}` }));
  const paths = new Set(slots.map((slot) => slot.path));
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, paths);
  const flaggedPaths = new Set(flagged.map((f) => f.path));
  const missed = COMMERCIAL_TAILS.filter((_, index) => !flaggedPaths.has(`tail-${index}`));
  assert.deepEqual(missed, [], `every commercial tail must be caught; these were NOT flagged: ${JSON.stringify(missed)}`);
});

const GENUINE_PARAPHRASES: readonly string[] = [
  TRACED_16,
  'One customer wore the canvas jacket through a long, wet winter and said it only got better with age.',
  'It only got better with age, through a long wet winter, the canvas jacket.',
  "The canvas jacket only got better with age — one customer wore it through a long, wet winter.",
  'Wore it through a long wet winter and it only got better with age.',
];

test('property: every genuine sentence/paraphrase in GENUINE_PARAPHRASES (drawn from or closely paraphrasing CLEAN_BRIEF) passes cleanly — no false positives from the stricter tokenizer', () => {
  const slots: FaithfulnessSlot[] = GENUINE_PARAPHRASES.map((text, index) => ({ path: `genuine-${index}`, text }));
  const paths = new Set(slots.map((slot) => slot.path));
  const flagged = deterministicQuoteFlags(CLEAN_BRIEF, slots, paths);
  assert.deepEqual(flagged, [], `every genuine paraphrase must pass cleanly; got ${JSON.stringify(flagged)}`);
});

// ---------------------------------------------------------------------------
// mergeFlagsByMaxProbability: Jev and a deterministic check must never weaken each other
// ---------------------------------------------------------------------------

test('mergeFlagsByMaxProbability: a lower Jev score for the same path is overridden by the deterministic check\'s higher probability, not kept', () => {
  const jevFlagged = [{ path: 'sections[7].items[0].name', probability: 0.4 }];
  const deterministicFlagged = [{ path: 'sections[7].items[0].name', probability: 1 }];
  const merged = mergeFlagsByMaxProbability(jevFlagged, deterministicFlagged);
  assert.deepEqual(merged, [{ path: 'sections[7].items[0].name', probability: 1 }], 'the deterministic check\'s certainty must win over a softer LLM score on the same path');
});

test('mergeFlagsByMaxProbability: a higher Jev score than the deterministic check is kept, not overwritten', () => {
  const jevFlagged = [{ path: 'sections[1].body', probability: 0.99 }];
  const deterministicFlagged = [{ path: 'sections[1].body', probability: 0.5 }];
  const merged = mergeFlagsByMaxProbability(jevFlagged, deterministicFlagged);
  assert.deepEqual(merged, [{ path: 'sections[1].body', probability: 0.99 }], 'the max, not always the second argument, wins');
});

test('mergeFlagsByMaxProbability: paths flagged by only one side pass through unchanged', () => {
  const jevFlagged = [{ path: 'sections[2].heading', probability: 0.9 }];
  const deterministicFlagged = [{ path: 'sections[7].items[0].name', probability: 1 }];
  const merged = mergeFlagsByMaxProbability(jevFlagged, deterministicFlagged);
  const byPath = Object.fromEntries(merged.map((flag) => [flag.path, flag.probability]));
  assert.deepEqual(byPath, { 'sections[2].heading': 0.9, 'sections[7].items[0].name': 1 });
});

test('deterministicQuoteFlags: the fixture\'s genuine paraphrased quotes still pass cleanly (no false positives)', () => {
  const brief = 'We\'ve had a couple of nice notes from repeat customers: one wore the field jacket through a wet Portland winter and says it only got better with age; another says the canvas is heavier than expected, in a good way, and the stitching is clean.';
  const slots: FaithfulnessSlot[] = [
    { path: 'sections[7].items[0].quote', text: 'I wore the field jacket through a wet Portland winter, and it only got better with age.' },
    { path: 'sections[7].items[1].quote', text: 'The canvas is heavier than expected, in a good way, and the stitching is clean.' },
  ];
  const flagged = deterministicQuoteFlags(brief, slots, new Set(['sections[7].items[0].quote', 'sections[7].items[1].quote']));
  assert.deepEqual(flagged, [], 'both genuine review paraphrases from the storefront rich fixture must pass cleanly');
});

// ---------------------------------------------------------------------------
// Fourth audit round: percent/comma-decimal/thousands-separator/rating/polarity holes in
// claimTokensOf and contentWordsOf, and the new deterministicCommercialWordFlags export.
// ---------------------------------------------------------------------------

test('deterministicQuoteFlags: (round 4, BLOCK 1) "15% off" no longer collides with an unrelated bare "15oz" in the brief — percent is its own claim token', () => {
  const brief = 'Made of 15oz undyed canvas, hand-sewn in Portland.';
  const percentOff: FaithfulnessSlot = { path: 'a', text: 'Made of 15oz undyed canvas, hand-sewn in Portland. 15% off.' };
  const cottonPercent: FaithfulnessSlot = { path: 'b', text: 'Made of 100% cotton. 100% off today.' };
  const genuinePercentBrief = 'Take 15% off your next order.';
  const genuinePercentQuote: FaithfulnessSlot = { path: 'c', text: 'Take 15% off your next order.' };
  const flagged1 = deterministicQuoteFlags(brief, [percentOff], new Set(['a']));
  const flagged2 = deterministicQuoteFlags('Made of 100% cotton.', [cottonPercent], new Set(['b']));
  const flagged3 = deterministicQuoteFlags(genuinePercentBrief, [genuinePercentQuote], new Set(['c']));
  assert.deepEqual(flagged1, [{ path: 'a', probability: 1 }], '"15% off" must flag against a brief that only ever says "15oz"');
  assert.deepEqual(flagged2.length > 0, true, '"100% off" must not be blessed by an unrelated "100% cotton" claim');
  assert.deepEqual(flagged3, [], 'a percent the brief genuinely states must still pass');
});

test('deterministicQuoteFlags: (round 4, BLOCK 2) a European decimal-comma amount no longer collides with a thousands-comma amount', () => {
  const decimalBrief = 'The price is only €12,50 today.';
  const thousandsQuote: FaithfulnessSlot = { path: 'a', text: 'The price is only €1,250 today.' };
  const exactQuote: FaithfulnessSlot = { path: 'b', text: 'The price is only €12,50 today.' };
  const thousandsBrief = 'The price is only €1,250 today.';
  const decimalQuote: FaithfulnessSlot = { path: 'c', text: 'The price is only €12,50 today.' };
  assert.deepEqual(deterministicQuoteFlags(decimalBrief, [thousandsQuote], new Set(['a'])), [{ path: 'a', probability: 1 }], '€1,250 must flag against a brief that actually said €12,50 — a ~100x price error');
  assert.deepEqual(deterministicQuoteFlags(decimalBrief, [exactQuote], new Set(['b'])), [], 'the exact same decimal-comma price must pass');
  assert.deepEqual(deterministicQuoteFlags(thousandsBrief, [decimalQuote], new Set(['c'])), [{ path: 'c', probability: 1 }], 'and the reverse direction must flag too');
});

test('deterministicQuoteFlags: (round 4, BLOCK 3) NBSP-separated and Indian-style grouped amounts are captured as one full span, not fragmented into a matchable prefix', () => {
  const nbspBrief = 'The price is €1 499 today.';
  const nbspPartial: FaithfulnessSlot = { path: 'a', text: 'The price is €1 today.' };
  const nbspExact: FaithfulnessSlot = { path: 'b', text: 'The price is €1 499 today.' };
  const indianBrief = 'The price is only ₹1,49,999 today.';
  const indianPartial: FaithfulnessSlot = { path: 'c', text: 'The price is only ₹149 today.' };
  const indianExact: FaithfulnessSlot = { path: 'd', text: 'The price is only ₹1,49,999 today.' };
  assert.deepEqual(deterministicQuoteFlags(nbspBrief, [nbspPartial], new Set(['a'])), [{ path: 'a', probability: 1 }], 'a quote claiming just "€1" must flag against an NBSP-grouped "€1 499"');
  assert.deepEqual(deterministicQuoteFlags(nbspBrief, [nbspExact], new Set(['b'])), [], 'the exact same NBSP-grouped price must pass');
  assert.deepEqual(deterministicQuoteFlags(indianBrief, [indianPartial], new Set(['c'])), [{ path: 'c', probability: 1 }], 'a quote claiming just "₹149" must flag against an Indian-grouped "₹1,49,999"');
  assert.deepEqual(deterministicQuoteFlags(indianBrief, [indianExact], new Set(['d'])), [], 'the exact same Indian-grouped price must pass');
});

test('deterministicQuoteFlags: (round 4, BLOCK 4) "N out of M"/"N of M" ratings are recognized, and a decimal rating is never truncated to its integer part', () => {
  const outOfBrief = 'The jacket has 5 pockets.';
  const outOfQuote: FaithfulnessSlot = { path: 'a', text: 'The jacket has 5 pockets. Rated 5 out of 5.' };
  const decimalSilentBrief = 'One customer wore it through winter.';
  const decimalQuote: FaithfulnessSlot = { path: 'b', text: 'Wore it through winter. 4.5 stars.' };
  const wrongDecimalBrief = 'Customers rate it 4.5 stars on average.';
  const wrongDecimalQuote: FaithfulnessSlot = { path: 'c', text: 'Rate it 5 stars on average.' };
  const exactDecimalQuote: FaithfulnessSlot = { path: 'd', text: 'Rate it 4.5 stars on average.' };
  assert.deepEqual(deterministicQuoteFlags(outOfBrief, [outOfQuote], new Set(['a'])), [{ path: 'a', probability: 1 }], '"5 out of 5" must flag against a brief whose only "5" is an unrelated pocket count');
  assert.deepEqual(deterministicQuoteFlags(decimalSilentBrief, [decimalQuote], new Set(['b'])), [{ path: 'b', probability: 1 }], '"4.5 stars" must flag when the brief states no rating at all');
  assert.deepEqual(deterministicQuoteFlags(wrongDecimalBrief, [wrongDecimalQuote], new Set(['c'])), [{ path: 'c', probability: 1 }], '"5 stars" must flag against a brief that actually said "4.5 stars" — the decimal must never be silently dropped');
  assert.deepEqual(deterministicQuoteFlags(wrongDecimalBrief, [exactDecimalQuote], new Set(['d'])), [], 'the exact same "4.5 stars" rating the brief states must pass');
});

test('deterministicQuoteFlags: (round 4, BLOCK 5) stock/shipping polarity is no longer invisible — "Out of stock." and "Shipping is on us." are distinguished from their opposites', () => {
  const inStockBrief = 'Everything is live while stock lasts.';
  const outOfStockQuote: FaithfulnessSlot = { path: 'a', text: 'Everything is live. Out of stock.' };
  const genuineInStockBrief = 'Everything is in stock right now.';
  const genuineInStockQuote: FaithfulnessSlot = { path: 'b', text: 'Everything is in stock right now.' };
  const noShippingInfoBrief = 'We do not have shipping dates yet.';
  const onUsQuote: FaithfulnessSlot = { path: 'c', text: 'We do not have shipping dates yet. Shipping is on us.' };
  assert.deepEqual(deterministicQuoteFlags(inStockBrief, [outOfStockQuote], new Set(['a'])), [{ path: 'a', probability: 1 }], '"Out of stock." must flag against a brief that says items ARE in stock ("while stock lasts")');
  assert.deepEqual(deterministicQuoteFlags(genuineInStockBrief, [genuineInStockQuote], new Set(['b'])), [], 'a genuine "in stock" claim matching the brief must still pass');
  assert.deepEqual(deterministicQuoteFlags(noShippingInfoBrief, [onUsQuote], new Set(['c'])), [{ path: 'c', probability: 1 }], '"Shipping is on us." (free shipping) must flag when the brief never discusses shipping cost at all');
});

test('deterministicClaimFlags: (round 4, BLOCK 7 wiring proof) a schema field whose own name embeds a digit ("line1", hyphenated "main-title-elem-2") is never mistaken for a numeric claim', () => {
  // A fourth audit pass found deterministicClaimFlags wired broadly across every family surfaced
  // a tokenizer gap: a bare digit glued to surrounding letters OR joined by a hyphen to a letter-
  // led identifier (a schema field's own name, not any real fact) must never be extracted as a
  // freestanding numeric claim token.
  const brief = 'Riverbend Dental, a family dental practice in Boise.';
  const slots: FaithfulnessSlot[] = [
    { path: 'a', text: 'New line1 for Riverbend Dental' },
    { path: 'b', text: 'New main-title-elem-2 for Riverbend Dental' },
    { path: 'c', text: 'New footer-form-caption-3 for Riverbend Dental' },
  ];
  const paths = new Set(['a', 'b', 'c']);
  const flagged = deterministicClaimFlags(brief, slots, paths);
  assert.deepEqual(flagged, [], `compound schema-field-name identifiers must never be treated as numeric claims; got ${JSON.stringify(flagged)}`);
});

test('deterministicClaimFlags: a genuine standalone number next to a hyphen (not part of an identifier) still checks correctly', () => {
  const brief = 'The jacket is $248.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Now just $199 - limited time!' }];
  const flagged = deterministicClaimFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], 'a real invented price next to a hyphen must still be caught');
});

// ---------------------------------------------------------------------------
// deterministicCommercialWordFlags: BLOCK 7's storefront-specific half — commercial words checked
// broadly across general prose (hero, shipping, description), not only review quotes.
// ---------------------------------------------------------------------------

test('deterministicCommercialWordFlags: an unstated commercial claim in the hero or shipping body flags, even though neither is a review quote', () => {
  const brief = 'One product, made in Portland.';
  const freeShippingHero: FaithfulnessSlot = { path: 'hero', text: 'Free shipping on every order.' };
  const ratedShipping: FaithfulnessSlot = { path: 'shipping', text: 'Ships within three days. Rated 5 stars.' };
  const cleanHero: FaithfulnessSlot = { path: 'clean', text: 'A jacket made in Portland, cut for layering.' };
  const paths = new Set(['hero', 'shipping', 'clean']);
  const flagged = deterministicCommercialWordFlags(brief, [freeShippingHero, ratedShipping, cleanHero], paths);
  const flaggedPaths = new Set(flagged.map((f) => f.path));
  assert.ok(flaggedPaths.has('hero'), 'an unstated "Free shipping" claim in the hero must flag');
  assert.ok(flaggedPaths.has('shipping'), 'an unstated "Rated 5 stars" claim in the shipping body must flag');
  assert.ok(!flaggedPaths.has('clean'), 'prose with no commercial words at all must not flag');
});

test('deterministicCommercialWordFlags: ignores paths not passed in, and passes cleanly when the brief genuinely states the commercial fact', () => {
  const brief = 'Free shipping on every order over $50.';
  const slots: FaithfulnessSlot[] = [
    { path: 'checked', text: 'Enjoy free shipping on every order.' },
    { path: 'unchecked', text: 'Free shipping on every order — completely invented and never checked.' },
  ];
  const flagged = deterministicCommercialWordFlags(brief, slots, new Set(['checked']));
  assert.deepEqual(flagged, [], 'a genuine "free shipping" claim matching the brief passes, and the unlisted path is never even considered');
});

// ---------------------------------------------------------------------------
// A FIFTH audit pass (round 9, storefront-r5-grok.md BLOCK 2) found a number the brief already
// uses for something else (rich.txt's "15oz" fabric weight, tokenizing as bare `num:15`) could
// bless an entirely different, invented price or discount once an English unit word replaced the
// symbol: "15 percent off" and "15 dollars" both fell through to the same bare `num:15` token —
// `PERCENT_WORD_RE`/`CURRENCY_UNIT_WORD_RE` close this by treating a number followed by a spelled-
// out percent/currency word as its own distinct claim token, exactly like `%`/ISO codes already are.
// ---------------------------------------------------------------------------

test('deterministicClaimFlags: (round 9, BLOCK 2) "15 dollars" is its own price claim, never satisfied by an unrelated "15oz" fabric weight in the brief', () => {
  const brief = 'The Field Jacket is $248, cut from a 15oz waxed canvas.';
  const slots: FaithfulnessSlot[] = [{ path: 'price', text: 'Now just 15 dollars.' }];
  const flagged = deterministicClaimFlags(brief, slots, new Set(['price']));
  assert.deepEqual(flagged, [{ path: 'price', probability: 1 }], '"15 dollars" must flag even though the brief\'s "15oz" shares the bare digits 15');
});

test('deterministicClaimFlags: (round 9, BLOCK 2) "15 percent off" and "15 per cent" are their own percent claim, never satisfied by an unrelated "15oz" fabric weight', () => {
  const brief = 'The Field Jacket is $248, cut from a 15oz waxed canvas.';
  const percentOff: FaithfulnessSlot = { path: 'a', text: 'Take 15 percent off today.' };
  const perCent: FaithfulnessSlot = { path: 'b', text: 'Save 15 per cent right now.' };
  const flagged = deterministicClaimFlags(brief, [percentOff, perCent], new Set(['a', 'b']));
  assert.deepEqual(
    new Set(flagged.map((f) => f.path)),
    new Set(['a', 'b']),
    `both spelled-out percent forms must flag against a brief with no discount at all; got ${JSON.stringify(flagged)}`,
  );
});

test('deterministicClaimFlags: a genuine spelled-out price or percent the brief actually states still passes', () => {
  const brief = 'The Field Jacket is 248 dollars, 15 percent off this week.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'The jacket is 248 dollars, 15 percent off this week.' }];
  const flagged = deterministicClaimFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [], 'a spelled-out price/percent that matches the brief exactly must not flag');
});

test('deterministicClaimFlags: a rewritten "$15" repaired into "15 dollars" is caught, not laundered through the repair rule', () => {
  // storefront-r5-grok.md BLOCK 2's own exploit: the repair rule keeps the same NUMBER and changes
  // only the wording, so a flagged "$15" rewritten as "15 dollars" must still flag, not silently
  // pass a recheck by trading its currency SYMBOL for a currency WORD.
  const brief = 'The Field Jacket is $248.';
  const before: FaithfulnessSlot = { path: 'a', text: 'Now just $15.' };
  const after: FaithfulnessSlot = { path: 'a', text: 'Now just 15 dollars.' };
  assert.deepEqual(deterministicClaimFlags(brief, [before], new Set(['a'])), [{ path: 'a', probability: 1 }]);
  assert.deepEqual(deterministicClaimFlags(brief, [after], new Set(['a'])), [{ path: 'a', probability: 1 }], 'the reworded "15 dollars" must still flag against the same unstated $15/$248 mismatch');
});

// ---------------------------------------------------------------------------
// A FIFTH audit pass (round 9, storefront-r5-grok.md NOTE) found several stock phrases invisible
// to `deterministicCommercialWordFlags`: "sold out" and "available now" carry no denylist word at
// all, and "no longer in stock" missed the old polarity-rescue window of 2. `sold`/`available`
// were added to `COMMERCIAL_DENYLIST_WORDS` and `POLARITY_RESCUE_WINDOW` was widened to 3.
// ---------------------------------------------------------------------------

test('deterministicCommercialWordFlags: (round 9 NOTE) "Sold out." and "Available now." are no longer invisible', () => {
  const brief = 'The Field Jacket is in stock, ships within three business days.';
  const soldOut: FaithfulnessSlot = { path: 'a', text: 'Sold out.' };
  const availableNow: FaithfulnessSlot = { path: 'b', text: 'Available now.' };
  const flagged = deterministicCommercialWordFlags(brief, [soldOut, availableNow], new Set(['a', 'b']));
  assert.deepEqual(
    new Set(flagged.map((f) => f.path)),
    new Set(['a', 'b']),
    `both stock phrases must flag against a brief that never says "sold" or "available"; got ${JSON.stringify(flagged)}`,
  );
});

test('deterministicCommercialWordFlags: (round 9 NOTE) "No longer in stock." is caught even though "stock" alone appears in an "in stock" brief — the polarity window now reaches distance 3', () => {
  const brief = 'The Field Jacket is in stock right now.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'The Field Jacket is no longer in stock.' }];
  const flagged = deterministicCommercialWordFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"no longer in stock" must flag as the opposite of a brief that says "in stock" — the shared word "stock" must never let the polarity flip pass');
});

test('deterministicCommercialWordFlags: (round 9 NOTE) "back in stock" and "limited stock" still need brief support (already covered by the "stock" denylist word)', () => {
  const brief = 'The Field Jacket is a Portland-made workwear staple.';
  const backInStock: FaithfulnessSlot = { path: 'a', text: 'Back in stock.' };
  const limitedStock: FaithfulnessSlot = { path: 'b', text: 'Limited stock.' };
  const flagged = deterministicCommercialWordFlags(brief, [backInStock, limitedStock], new Set(['a', 'b']));
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b']), `both must flag against a brief with no "stock" fact at all; got ${JSON.stringify(flagged)}`);
});

test('deterministicCommercialWordFlags: (round 9 NOTE) a genuine "sold out"/"available now" claim the brief actually states still passes', () => {
  const brief = 'The Field Jacket sold out in one week; a restock is available now.';
  const slots: FaithfulnessSlot[] = [
    { path: 'a', text: 'Sold out.' },
    { path: 'b', text: 'Available now.' },
  ];
  const flagged = deterministicCommercialWordFlags(brief, slots, new Set(['a', 'b']));
  assert.deepEqual(flagged, [], 'genuine "sold"/"available" claims matching the brief must pass');
});

// ---------------------------------------------------------------------------
// A sixth audit pass (round 10, storefront-r6-grok.md BLOCK 1) found the polarity mechanism was
// still a BAG OF WORDS: it asked only whether a rescued modifier word occurs SOMEWHERE in the
// brief, never whether it sits on the SAME claim as the commercial word. `rich.txt` contains both
// "stock" ("while stock lasts") and "no" ("no preorder needed") for unrelated reasons, so a bare
// word-presence check let every one of these publish clean against the real, unmodified fixture
// brief. `commercialOccurrencesOf`/`spanOf` (structural: the local span from the nearest modifier
// through the commercial word, required as a literal contiguous run in the brief) close this.
// ---------------------------------------------------------------------------

test('deterministicCommercialWordFlags: (round 10 BLOCK 1) rich.txt contains both "stock" and "no" for unrelated reasons, so a bare word-presence check would wrongly bless every one of these', () => {
  const noLongerInStock: FaithfulnessSlot = { path: 'a', text: 'No longer in stock.' };
  const backInStock: FaithfulnessSlot = { path: 'b', text: 'Back in stock.' };
  const shipOnUs: FaithfulnessSlot = { path: 'c', text: 'Orders ship on us.' };
  const paths = new Set(['a', 'b', 'c']);
  const flagged = deterministicCommercialWordFlags(RICH_TXT, [noLongerInStock, backInStock, shipOnUs], paths);
  assert.deepEqual(
    new Set(flagged.map((f) => f.path)),
    new Set(['a', 'b', 'c']),
    `every claim must flag against the real rich.txt fixture, which never states any of these three exact spans; got ${JSON.stringify(flagged)}`,
  );
});

test('deterministicCommercialWordFlags: (round 10 BLOCK 1) a genuine rich.txt echo ("while stock lasts") next to the same brief text still passes, unaffected by the clause-aware fix', () => {
  const heroEyebrow: FaithfulnessSlot = { path: 'hero.eyebrow', text: 'Autumn run, while stock lasts' };
  const shipping: FaithfulnessSlot = { path: 'shipping.body', text: 'Orders ship within three business days.' };
  const flagged = deterministicCommercialWordFlags(RICH_TXT, [heroEyebrow, shipping], new Set(['hero.eyebrow', 'shipping.body']));
  assert.deepEqual(flagged, [], `genuine, unmodified echoes of the brief's own commercial words must not flag; got ${JSON.stringify(flagged)}`);
});

test('deterministicCommercialWordFlags: (round 10 BLOCK 1) the reverse polarity flip — a brief that only ever says "out of stock" must not license a bare "in stock" claim', () => {
  const outOfStockBrief = 'The Field Jacket is out of stock until next season.';
  const bareInStock: FaithfulnessSlot = { path: 'a', text: 'In stock now.' };
  const flagged = deterministicCommercialWordFlags(outOfStockBrief, [bareInStock], new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"in stock" must flag against a brief whose only "stock" occurrence is negated — the brief never states a bare, unmodified stock claim to point to');
});

test('deterministicCommercialWordFlags: (round 10 BLOCK 1) the same reverse-flip brief still accepts the exact "out of stock" claim it actually states', () => {
  const outOfStockBrief = 'The Field Jacket is out of stock until next season.';
  const genuineOutOfStock: FaithfulnessSlot = { path: 'a', text: 'Out of stock until next season.' };
  const flagged = deterministicCommercialWordFlags(outOfStockBrief, [genuineOutOfStock], new Set(['a']));
  assert.deepEqual(flagged, [], 'the brief\'s own exact "out of stock" span must still pass');
});

test('deterministicCommercialWordFlags: (round 10 BLOCK 1) a brief that genuinely states each exact span passes cleanly', () => {
  const brief = 'The Field Jacket is no longer in stock. It is back in stock every spring. Shipping is on us this week.';
  const slots: FaithfulnessSlot[] = [
    { path: 'a', text: 'No longer in stock.' },
    { path: 'b', text: 'Back in stock every spring.' },
    { path: 'c', text: 'Shipping is on us this week.' },
  ];
  const flagged = deterministicCommercialWordFlags(brief, slots, new Set(['a', 'b', 'c']));
  assert.deepEqual(flagged, [], `every span the brief genuinely states must pass; got ${JSON.stringify(flagged)}`);
});

// ---------------------------------------------------------------------------
// A sixth audit pass (round 10, storefront-r6-grok.md BLOCK 2) found "fifteen percent off" and
// "five stars" produced no claim token at all: `PERCENT_WORD_RE` and `RATING_RE`'s star form both
// required an actual digit, and "percent"/"stars" carry no denylist word either, so a spelled-out
// number+unit claim was entirely invisible. `numberWordValueOf`/`PERCENT_ANY_RE`/`STAR_COUNT_RE`
// normalize a number word to its digit VALUE so a word form and a digit form of the SAME claim
// produce the identical canonical token.
// ---------------------------------------------------------------------------

test('deterministicClaimFlags: (round 10 BLOCK 2) "fifteen percent off" and "five stars" are claim tokens now, unsatisfied by an unrelated bare number', () => {
  const brief = 'The Field Jacket is $248, cut from a 15oz waxed canvas.';
  const fifteenPercent: FaithfulnessSlot = { path: 'a', text: 'Take fifteen percent off.' };
  const fiveStars: FaithfulnessSlot = { path: 'b', text: 'Rated five stars by customers.' };
  const flagged = deterministicClaimFlags(brief, [fifteenPercent, fiveStars], new Set(['a', 'b']));
  assert.deepEqual(
    new Set(flagged.map((f) => f.path)),
    new Set(['a', 'b']),
    `both spelled-out claims must flag against a brief with neither a discount nor a rating; got ${JSON.stringify(flagged)}`,
  );
});

test('deterministicClaimFlags: (round 10 BLOCK 2) a digit form and its spelled-out sibling normalize to the SAME token — a digit-form brief accepts a word-form page claim and vice versa', () => {
  const digitBrief = 'The Field Jacket is $248, 15% off this week, rated 5 stars.';
  const wordPage: FaithfulnessSlot = { path: 'a', text: 'Fifteen percent off this week, rated five stars.' };
  const flaggedWordAgainstDigit = deterministicClaimFlags(digitBrief, [wordPage], new Set(['a']));
  assert.deepEqual(flaggedWordAgainstDigit, [], `a spelled-out claim must be satisfied by the brief's own digit form of the SAME value; got ${JSON.stringify(flaggedWordAgainstDigit)}`);

  const wordBrief = 'The Field Jacket is $248, fifteen percent off this week, rated five stars.';
  const digitPage: FaithfulnessSlot = { path: 'b', text: '15% off this week, rated 5 stars.' };
  const flaggedDigitAgainstWord = deterministicClaimFlags(wordBrief, [digitPage], new Set(['b']));
  assert.deepEqual(flaggedDigitAgainstWord, [], `a digit claim must be satisfied by the brief's own spelled-out form of the SAME value; got ${JSON.stringify(flaggedDigitAgainstWord)}`);
});

test('deterministicClaimFlags: (round 10 BLOCK 2) the repair-laundering exploit — a flagged "15%" reworded as "fifteen percent off" — still flags', () => {
  const brief = 'The Field Jacket is $248.';
  const before: FaithfulnessSlot = { path: 'a', text: 'Now 15% off.' };
  const after: FaithfulnessSlot = { path: 'a', text: 'Now fifteen percent off.' };
  assert.deepEqual(deterministicClaimFlags(brief, [before], new Set(['a'])), [{ path: 'a', probability: 1 }]);
  assert.deepEqual(deterministicClaimFlags(brief, [after], new Set(['a'])), [{ path: 'a', probability: 1 }], 'the reworded "fifteen percent off" must still flag against the same unstated discount');
});

test('deterministicClaimFlags: (round 10 BLOCK 2) an ordinary spelled-out count elsewhere in prose is never treated as a bare numeric claim', () => {
  // "two sewists" is not a percent or a star rating — it must not become a bare `num:2` claim
  // token satisfiable by, or flaggable against, an unrelated digit "2" anywhere in the brief.
  const brief = 'Tallow Row started as two sewists cutting patterns on a kitchen table.';
  const paraphrase: FaithfulnessSlot = { path: 'a', text: 'We started as a couple of sewists cutting patterns.' };
  const flagged = deterministicClaimFlags(brief, [paraphrase], new Set(['a']));
  assert.deepEqual(flagged, [], 'an ordinary spelled-out count must never surface as a claim token at all');
});

test('deterministicClaimFlags: (round 10 BLOCK 2) "a dozen", "half" and "one hundred" all normalize to their digit value', () => {
  const brief = 'The Field Jacket is $248.';
  const dozen: FaithfulnessSlot = { path: 'a', text: 'Rated a dozen percent higher than average.' };
  const half: FaithfulnessSlot = { path: 'b', text: 'Half percent off for members.' };
  const hundred: FaithfulnessSlot = { path: 'c', text: 'Rated one hundred stars by every customer.' };
  const flagged = deterministicClaimFlags(brief, [dozen, half, hundred], new Set(['a', 'b', 'c']));
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b', 'c']), `every unstated spelled-out claim must flag; got ${JSON.stringify(flagged)}`);
  const matchingBrief = 'The Field Jacket is a dozen percent lighter and half percent off, rated one hundred stars.';
  const flaggedGenuine = deterministicClaimFlags(matchingBrief, [dozen, half, hundred], new Set(['a', 'b', 'c']));
  assert.deepEqual(flaggedGenuine, [], `the same claims must pass once the brief states them in the same spelled-out form; got ${JSON.stringify(flaggedGenuine)}`);
});

// ---------------------------------------------------------------------------
// deterministicContactFlags: a round-10 audit pass (storefront-r6-grok.md FIX 5) found a buy URL,
// email or hyphenated phone was never required to occur in the brief at all — a phone in
// "503-555-0199" form is also excluded from claimTokensOf entirely (it reads as a SKU/slug, per
// NUMBER_RE's own docblock), so it needs this dedicated, atom-aware check rather than a claim
// token.
// ---------------------------------------------------------------------------

test('deterministicContactFlags: an invented email, URL and hyphenated phone each flag against a brief that never states them', () => {
  const brief = 'Tallow Row, contact: hello@tallowrow.example, https://shop.tallowrow.example/autumn.';
  const invented: FaithfulnessSlot[] = [
    { path: 'a', text: 'shop@tallowrow.example' },
    { path: 'b', text: 'https://tallowrow.example/invented' },
    { path: 'c', text: '503-555-0199' },
  ];
  const contactPaths = new Map<string, ContactKind>([['a', 'email'], ['b', 'url'], ['c', 'phone']]);
  const flagged = deterministicContactFlags(brief, invented, contactPaths);
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b', 'c']), `every invented contact atom must flag; got ${JSON.stringify(flagged)}`);
});

test('deterministicContactFlags: a hyphenated phone matches its digit-only form in the brief, in any punctuation the brief itself uses', () => {
  const brief = 'Call us at (503) 555-0199 any weekday.';
  const hyphenated: FaithfulnessSlot = { path: 'a', text: '503-555-0199' };
  const flagged = deterministicContactFlags(brief, [hyphenated], new Map<string, ContactKind>([['a', 'phone']]));
  assert.deepEqual(flagged, [], 'the same digits in a different punctuation must still match');
});

test('deterministicContactFlags: a genuine email and URL matching the brief exactly pass, and paths not in contactPaths are ignored', () => {
  const brief = 'Contact hello@tallowrow.example or visit https://shop.tallowrow.example/autumn.';
  const email: FaithfulnessSlot = { path: 'a', text: 'hello@tallowrow.example' };
  const url: FaithfulnessSlot = { path: 'b', text: 'https://shop.tallowrow.example/autumn' };
  const unrelated: FaithfulnessSlot = { path: 'c', text: 'shop@tallowrow.example' };
  const contactPaths = new Map<string, ContactKind>([['a', 'email'], ['b', 'url']]);
  const flagged = deterministicContactFlags(brief, [email, url, unrelated], contactPaths);
  assert.deepEqual(flagged, [], 'genuine contact atoms pass, and the path not marked as a contact atom is never even considered');
});

test('deterministicContactFlags: a nulled contact slot (empty text) is never flagged', () => {
  const brief = 'Contact hello@tallowrow.example.';
  const empty: FaithfulnessSlot = { path: 'a', text: '' };
  const flagged = deterministicContactFlags(brief, [empty], new Map<string, ContactKind>([['a', 'email']]));
  assert.deepEqual(flagged, [], 'an empty slot states no contact fact and must not flag');
});

// ---------------------------------------------------------------------------
// traceablePathsFor / deterministicTraceableFlags: a round-10 audit pass (storefront-r6-grok.md
// item 7) added a new SHARED `x-verify: 'traceable'` marker — looser than `x-verify: 'quote'` (no
// verbatim contiguous run needed) and stricter than the bare LLM judge (every stemmed content word
// must trace to the brief) — for any family to adopt on a practical-fact row, a gallery label, a
// place card or a descriptor. No bundled family adopts it yet; these tests exercise the primitive
// directly.
// ---------------------------------------------------------------------------

test('traceablePathsFor: reads the x-verify: "traceable" marker off a minimal schema, and only that marker', () => {
  const schema = {
    type: 'object',
    properties: {
      label: { type: 'string', 'x-verify': 'traceable' },
      quote: { type: 'string', 'x-verify': 'quote' },
      plain: { type: 'string' },
    },
  };
  const template = { label: 'x', quote: 'y', plain: 'z' };
  const paths = traceablePathsFor(schema, template);
  assert.deepEqual(paths, new Set(['label']));
});

test('deterministicTraceableFlags: an invented descriptor with no brief support flags, a genuine paraphrase passes', () => {
  const brief = 'The gallery includes a hand-thrown ceramic vase from a Portland studio.';
  const invented: FaithfulnessSlot = { path: 'a', text: 'A blown glass sculpture from a Seattle studio.' };
  const genuine: FaithfulnessSlot = { path: 'b', text: 'A hand-thrown ceramic vase from a Portland studio.' };
  const paths = new Set(['a', 'b']);
  const flagged = deterministicTraceableFlags(brief, [invented, genuine], paths);
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], `only the invented descriptor must flag; got ${JSON.stringify(flagged)}`);
});

test('deterministicTraceableFlags: no verbatim run is required — light reordering and plural/tense forms still trace', () => {
  const brief = 'A hand-thrown ceramic vase from a Portland studio, glazed in soft blue.';
  const reordered: FaithfulnessSlot = { path: 'a', text: 'Glazed in soft blue, this ceramic vase was hand-thrown by a Portland studio.' };
  const flagged = deterministicTraceableFlags(brief, [reordered], new Set(['a']));
  assert.deepEqual(flagged, [], 'a light paraphrase, reordered and re-tensed, must still pass without a verbatim run');
});

test('deterministicTraceableFlags: ignores paths not marked traceable, and a slot with no content word at all is never flagged', () => {
  const brief = 'A hand-thrown ceramic vase.';
  const unmarked: FaithfulnessSlot = { path: 'unmarked', text: 'A completely invented sculpture never checked.' };
  const empty: FaithfulnessSlot = { path: 'empty', text: '   ' };
  const flagged = deterministicTraceableFlags(brief, [unmarked, empty], new Set(['empty']));
  assert.deepEqual(flagged, [], 'the unmarked path is never even considered, and an empty slot asserts no fact to flag');
});

// ---------------------------------------------------------------------------
// Round 11 (storefront-r7-grok.md): every named failure scenario, as a red-then-green case. Item
// A (x-verify: 'traceable' widened to price/shipping/stock/product-detail rows) and item C
// (contact-atom exact equality) are exercised at the integration level in storefront-family.test.ts;
// these are the deterministic-function-level BLOCK/FIX cases.
// ---------------------------------------------------------------------------

test('deterministicClaimFlags: (round 11 BLOCK 1) "Five out of five" is a claim token, unsatisfied by an unrelated brief', () => {
  const brief = 'The Field Jacket is $248, cut for a four-pocket layer.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Rated five out of five by every customer.' }];
  const flagged = deterministicClaimFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"five out of five" must flag against a brief with no rating at all');
});

test('deterministicClaimFlags: (round 11 BLOCK 1) digit and spelled-out "N (out) of M" ratings normalize to the SAME token in either direction', () => {
  const digitBrief = 'The Field Jacket is $248, rated 5 out of 5.';
  const wordPage: FaithfulnessSlot = { path: 'a', text: 'Rated five out of five.' };
  assert.deepEqual(deterministicClaimFlags(digitBrief, [wordPage], new Set(['a'])), [], 'a spelled-out rating must be satisfied by the brief\'s own digit form of the SAME rating');

  const wordBrief = 'The Field Jacket is $248, rated five of five.';
  const digitPage: FaithfulnessSlot = { path: 'b', text: '5/5.' };
  assert.deepEqual(deterministicClaimFlags(wordBrief, [digitPage], new Set(['b'])), [], 'a digit rating must be satisfied by the brief\'s own spelled-out form of the SAME rating');
});

test('deterministicClaimFlags: (round 11 BLOCK 1) the repair-laundering exploit — a flagged "5 out of 5" reworded as "Five out of five" — still flags', () => {
  const brief = 'The Field Jacket is $248.';
  const before: FaithfulnessSlot = { path: 'a', text: 'Rated 5 out of 5.' };
  const after: FaithfulnessSlot = { path: 'a', text: 'Rated Five out of five.' };
  assert.deepEqual(deterministicClaimFlags(brief, [before], new Set(['a'])), [{ path: 'a', probability: 1 }]);
  assert.deepEqual(deterministicClaimFlags(brief, [after], new Set(['a'])), [{ path: 'a', probability: 1 }], 'the reworded rating must still flag against the same unstated 5/5');
});

test('deterministicContactFlags: (round 11 BLOCK 2) whole-brief digit concatenation no longer blesses an invented phone (street + ZIP; four prices + "15oz")', () => {
  const brief = 'Contact us at 1420 SE Division St, Portland, OR 97202. The Field Jacket is $248, Trouser $168, Chore Shirt $132, Tote $58, Cap $34, made from 15oz canvas.';
  const invented: FaithfulnessSlot = { path: 'a', text: '142-097-202' };
  const invented2: FaithfulnessSlot = { path: 'b', text: '248-168-1325' };
  const flagged = deterministicContactFlags(brief, [invented, invented2], new Map([['a', 'phone' as const], ['b', 'phone' as const]]));
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b']), `neither digit-concatenation phone must ever be blessed by unrelated digits scattered across the brief; got ${JSON.stringify(flagged)}`);
});

test('deterministicContactFlags: (round 11 BLOCK 2) a real phone\'s own trailing digits are not a separate, satisfiable candidate', () => {
  const brief = 'Call us at 503-555-0199 any weekday.';
  const suffixOnly: FaithfulnessSlot = { path: 'a', text: '555-0199' };
  const flagged = deterministicContactFlags(brief, [suffixOnly], new Map([['a', 'phone' as const]]));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"555-0199" must flag: the brief only ever writes the phone as ONE run, "503-555-0199", never as this shorter suffix on its own');
});

test('deterministicContactFlags: (round 11 BLOCK 2) email substring and URL proper-prefix holes are closed', () => {
  const brief = 'Contact hello@tallowrow.example or visit https://shop.tallowrow.example/autumn.';
  const emailSubstring: FaithfulnessSlot = { path: 'a', text: 'o@tallowrow.example' };
  const urlPrefix: FaithfulnessSlot = { path: 'b', text: 'https://shop.tallowrow.example' };
  const flagged = deterministicContactFlags(brief, [emailSubstring, urlPrefix], new Map([['a', 'email' as const], ['b', 'url' as const]]));
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b']), `a substring email and a prefix-only URL (missing the real path) must both flag; got ${JSON.stringify(flagged)}`);
});

test('deterministicContactFlags: (round 11 BLOCK 2) a URL differing only by a trailing slash still passes', () => {
  const brief = 'Visit https://shop.tallowrow.example/autumn/ for the full run.';
  const noSlash: FaithfulnessSlot = { path: 'a', text: 'https://shop.tallowrow.example/autumn' };
  const flagged = deterministicContactFlags(brief, [noSlash], new Map([['a', 'url' as const]]));
  assert.deepEqual(flagged, [], 'a trailing-slash-only difference must not flag');
});

test('deterministicCommercialWordFlags: (round 11 BLOCK 3) "free" and "shipping" are paired as a span — two independently-bare brief words no longer license the combined claim', () => {
  const brief = 'Feel free to email us. Shipping takes three business days.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Free shipping.' }];
  const flagged = deterministicCommercialWordFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"Free shipping" must flag: the brief never states that combined claim, only each word separately for unrelated reasons');
});

test('deterministicCommercialWordFlags: (round 11 BLOCK 3) a genuine "free shipping" claim the brief actually states still passes, and unrelated bare uses of each word still pass on their own', () => {
  const brief = 'Free shipping on every order. Feel free to call us; we ship anywhere.';
  const genuine: FaithfulnessSlot = { path: 'a', text: 'Free shipping on every order.' };
  const bareFree: FaithfulnessSlot = { path: 'b', text: 'Feel free to call us.' };
  const flagged = deterministicCommercialWordFlags(brief, [genuine, bareFree], new Set(['a', 'b']));
  assert.deepEqual(flagged, [], `a genuine combined claim and an unrelated bare use of "free" must both pass; got ${JSON.stringify(flagged)}`);
});

test('deterministicClaimFlags: (round 11 BLOCK 4) "100% off" and "100% cotton" no longer satisfy each other', () => {
  const materialOnlyBrief = 'The jacket is 100% cotton canvas.';
  const discountClaim: FaithfulnessSlot = { path: 'a', text: '100% off everything.' };
  assert.deepEqual(deterministicClaimFlags(materialOnlyBrief, [discountClaim], new Set(['a'])), [{ path: 'a', probability: 1 }], '"100% off" must flag against a brief whose only "100%" is a material composition');

  const discountBrief = 'The jacket is 100% off this week.';
  const materialClaim: FaithfulnessSlot = { path: 'b', text: '100% cotton canvas.' };
  assert.deepEqual(deterministicClaimFlags(discountBrief, [materialClaim], new Set(['b'])), [{ path: 'b', probability: 1 }], '"100% cotton" must flag against a brief whose only "100%" is a discount');
});

test('deterministicClaimFlags: (round 11 BLOCK 4) "fifteen dollars" merges with the currency word, unsatisfied by an unrelated "15oz"', () => {
  const brief = 'The Field Jacket is $248, cut from a 15oz waxed canvas. Prices are in US dollars.';
  const slots: FaithfulnessSlot[] = [{ path: 'a', text: 'Now just fifteen dollars.' }];
  const flagged = deterministicClaimFlags(brief, slots, new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"fifteen dollars" must flag: the brief never states that price, only an unrelated "15oz" and the bare word "dollars"');
});

test('deterministicClaimFlags: (round 11 BLOCK 4) "fifteen dollars" and "15 dollars" normalize to the SAME token, in either direction', () => {
  const digitBrief = 'The Field Jacket is 15 dollars this week.';
  const wordPage: FaithfulnessSlot = { path: 'a', text: 'Fifteen dollars this week.' };
  assert.deepEqual(deterministicClaimFlags(digitBrief, [wordPage], new Set(['a'])), [], 'a spelled-out price must be satisfied by the brief\'s own digit form of the SAME price');
});

// ---------------------------------------------------------------------------
// FIX (storefront-r7-grok.md): plural/stem twins of a denylist word no longer false-flag a
// faithful paraphrase on a `traceable` slot.
// ---------------------------------------------------------------------------

test('deterministicTraceableFlags: (round 11 FIX) "ships" licenses "shipping", and "review" licenses "reviews" — plain stemming, not the commercial-denylist exact-match rule', () => {
  const shipBrief = 'Orders ship within three business days.';
  const shippingPage: FaithfulnessSlot = { path: 'a', text: 'Shipping within three business days.' };
  assert.deepEqual(deterministicTraceableFlags(shipBrief, [shippingPage], new Set(['a'])), [], '"shipping" must trace to the brief\'s own "ship" under ordinary stemming');

  const reviewBrief = 'Read our customer review of the Field Jacket.';
  const reviewsPage: FaithfulnessSlot = { path: 'b', text: 'Customer reviews of the Field Jacket.' };
  assert.deepEqual(deterministicTraceableFlags(reviewBrief, [reviewsPage], new Set(['b'])), [], '"reviews" must trace to the brief\'s own "review" under ordinary stemming');
});

test('deterministicTraceableFlags: (round 4, guide live-build finding) "over"/"across" are pure spatial prepositions with no fact of their own — a gallery label naming a real, brief-stated landmark and its own brief-stated location must still trace', () => {
  const brief = "Lowmoor Crossing grew up around the ford where the old drovers' road crosses the Lowmoor Beck. There's a stone bridge now instead of the ford.";
  const over: FaithfulnessSlot = { path: 'a', text: 'Stone bridge over Lowmoor Beck' };
  const across: FaithfulnessSlot = { path: 'b', text: 'Stone bridge across Lowmoor Beck' };
  assert.deepEqual(deterministicTraceableFlags(brief, [over, across], new Set(['a', 'b'])), [], '"over"/"across" must not block an otherwise fully brief-supported label');
});

test('deterministicTraceableFlags: (round 2 Grok audit) the exact false-flagged practice credential still flags — a paraphrase of an unrelated services list is not the brief\'s own short fact', () => {
  // The live sparse-vet build this audit reviewed: the brief names only "Dr. Hannah Okafor, DVM"
  // for its one provider, with no further credential detail. A model padded the `credential`
  // slot with a paraphrase of the SERVICES section instead of the brief's own short fact — the
  // exact case that first motivated widening TRACEABLE_STOPWORDS with pronoun AND quantifier/verb
  // entries. The quantifier/verb entries were wrong and have been removed; this proves the
  // deterministic check was never actually broken and still catches this phrasing without them —
  // the real fix belongs in the prompt (see prompt.ts's own `traceable` field), not in the gate.
  const brief = 'We see dogs and cats for wellness exams, vaccinations, and minor sick visits. Dr. Hannah Okafor, DVM, sees every patient.';
  const paraphrase: FaithfulnessSlot = { path: 'a', text: 'Provides exams, vaccinations, and minor sick visits for dogs and cats' };
  assert.deepEqual(
    deterministicTraceableFlags(brief, [paraphrase], new Set(['a'])),
    [{ path: 'a', probability: 1 }],
    'a services-list paraphrase in the credential slot is not the brief\'s own short fact ("DVM") and must still flag',
  );
});

// ---------------------------------------------------------------------------
// deterministicSentenceClaimFlags (item B): claim-bearing sentences must fully trace; ordinary
// prose sentences (no digit, no number-word signal, no commercial stem) are left alone.
// ---------------------------------------------------------------------------

test('deterministicSentenceClaimFlags: (round 11 item B) "Half off" and "complimentary delivery" — residual open-word gaps a prior round\'s NOTE named — now flag with no dedicated denylist entry', () => {
  const brief = 'The Field Jacket is $248, made in Portland.';
  const halfOff: FaithfulnessSlot = { path: 'a', text: 'Half off this week.' };
  const compDelivery: FaithfulnessSlot = { path: 'b', text: 'Complimentary delivery on every order.' };
  const flagged = deterministicSentenceClaimFlags(brief, [halfOff, compDelivery], new Set(['a', 'b']));
  assert.deepEqual(new Set(flagged.map((f) => f.path)), new Set(['a', 'b']), `both must flag as claim-bearing sentences with no brief support; got ${JSON.stringify(flagged)}`);
});

test('deterministicSentenceClaimFlags: an ordinary, non-claim sentence stays free prose — no digit, number-word or commercial stem means no trace requirement at all', () => {
  const brief = 'Tallow Row is a small workwear label.';
  // Was 'We started as two sewists...' before round 4 — 'two' is now a deliberate claim signal
  // (NUMBER_WORD_SIGNAL_WORDS was extended to two-through-twelve for the guide finding; see
  // jev.ts's own docblock), so this example is rewritten to stay genuinely signal-free rather than
  // exercising the NEW, intentional catch this same file tests elsewhere.
  const paraphrase: FaithfulnessSlot = { path: 'a', text: 'We started small, cutting patterns on a kitchen table, in one small Portland workshop.' };
  const flagged = deterministicSentenceClaimFlags(brief, [paraphrase], new Set(['a']));
  assert.deepEqual(flagged, [], 'a sentence with no commercial or numeric signal must never require full word-tracing');
});

test('deterministicSentenceClaimFlags: a genuine claim-bearing sentence that traces fully still passes, and one that adds an untraceable word flags', () => {
  const brief = 'Orders ship within three business days. The Field Jacket is $248.';
  const genuine: FaithfulnessSlot = { path: 'a', text: 'Orders ship within three business days.' };
  const invented: FaithfulnessSlot = { path: 'b', text: 'Orders ship free within three business days.' };
  const flagged = deterministicSentenceClaimFlags(brief, [genuine, invented], new Set(['a', 'b']));
  assert.deepEqual(flagged, [{ path: 'b', probability: 1 }], `only the sentence with the untraceable "free" must flag; got ${JSON.stringify(flagged)}`);
});

// ---------------------------------------------------------------------------
// A round-2 Grok audit (goal watcher) found a FIRST attempt at closing the round-1 pronoun gap
// above went too far: it also added every quantifier (`all`/`every`/`most`/`any`/`each`/`some`/
// `many`) and several content verbs to `TRACEABLE_STOPWORDS`, which does let a claim-bearing
// sentence widen a real brief-stated condition into an unconditional one purely through a
// quantifier word the brief never used — "Free shipping on every order" would have read as
// faithful against a brief that only offers it "on orders over $50". `all`/`every`/`most`/etc.
// were removed from the stopword list (they were never proven safe the way a pure pronoun or
// preposition is: a quantifier is exactly the kind of word that changes what a sentence claims).
// With them gone, "every" is an ordinary untraceable content word again, and this closes clean.
// ---------------------------------------------------------------------------

test('deterministicSentenceClaimFlags: "Free shipping on every order" flags against a brief that only offers free shipping conditionally, on orders over $50 — a quantifier must never widen a stated condition unchecked', () => {
  const brief = 'Free shipping on orders over $50.';
  const widened: FaithfulnessSlot = { path: 'a', text: 'Free shipping on every order.' };
  const flagged = deterministicSentenceClaimFlags(brief, [widened], new Set(['a']));
  assert.deepEqual(flagged, [{ path: 'a', probability: 1 }], '"every order" drops the brief\'s own $50 condition and must flag');
});
