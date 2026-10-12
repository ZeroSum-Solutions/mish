/**
 * One bounded routing retry. Ladder run 3 (seq 5, ladder-05): Jev placed the brief on spine CO but
 * admitted no family in one request, while the same brief routed on two other requests — model
 * variance, not an honest "no fit". `routeBuild` asks again exactly once when the spine is
 * confident and no family clears the 0.5 bar; a second refusal stands.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadAtlasData } from './routing-fixture.ts';
import { routeBuild } from '../src/build.ts';
import { shouldRetryRoute, type RouteDecision, type RouteInput } from '../src/route.ts';

const { atlas, registry } = await loadAtlasData();

const base = {
  spine: { code: 'CO', name: 'Convert', confidence: 0.92, probabilities: { CO: 0.92 } },
  spines: [{ code: 'CO', probability: 0.92 }],
  skin: { choice: 'Minimal and quiet', confidence: 0.8 },
  candidates: [],
  warnings: [],
  ms: 200,
  calls: 1 as const,
  model: 'fake-router-model',
  usage: { input_tokens: 100, output_tokens: 10 },
};
const spineOnly: RouteDecision = { ...base, decision: 'unrouted', reason: 'family ownedcontractor at p=0.41 below 0.5' };
const admitted: RouteDecision = { ...base, decision: 'routed', family: { id: 'ownedcontractor', probability: 0.78, basis: 'same-spine', transfer: 3, viaSpine: 'CO' } };
const noSpine: RouteDecision = { ...base, decision: 'unrouted', reason: 'no spine', spine: { code: 'none', name: 'none', confidence: 0.7, probabilities: { none: 0.7 } }, spines: [] };
const weakSpine: RouteDecision = { ...spineOnly, spine: { ...base.spine, confidence: 0.3 } };

/** A fake router answering `answers` in order, recording every request it is given. An Error
 * answer is thrown after 30 ms, so a failed request takes measurable wall time. */
function fakeRouter(...answers: Array<RouteDecision | Error>) {
  const requests: RouteInput[] = [];
  const deps = {
    createJevRouter: () => ({
      route: async (input: RouteInput) => {
        requests.push(input);
        const next = answers[Math.min(requests.length - 1, answers.length - 1)]!;
        if (next instanceof Error) {
          await new Promise((resolve) => setTimeout(resolve, 30));
          throw next;
        }
        return next;
      },
    }),
  };
  return { deps, requests };
}

const input = { brief: 'A brief.', atlas, registry, jevKey: async () => 'key', options: { threshold: 0.5 } };

test('first call spine-only, second admits: routed, with routeAttempts 2', async () => {
  const { deps, requests } = fakeRouter(spineOnly, admitted);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 2);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'ownedcontractor');
  assert.equal(decision.routeAttempts, 2);
  assert.equal(decision.ms, 400, 'the route time covers both requests');
  assert.deepEqual(decision.usage, { input_tokens: 200, output_tokens: 20 });
  assert.equal(requests[1]!.threshold, 0.5, 'the retry is the same request: the admission bar never moves');
});

test('both calls refuse: the honest refusal stands, unrouted with routeAttempts 2', async () => {
  const { deps, requests } = fakeRouter(spineOnly, spineOnly);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 2, 'exactly one retry, never more');
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.family, undefined);
  assert.equal(decision.routeAttempts, 2);
});

test('first call admits: no retry, routeAttempts 1', async () => {
  const { deps, requests } = fakeRouter(admitted, spineOnly);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 1);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.routeAttempts, 1);
});

test('no spine, or a spine below the bar: no retry, the refusal stands', async () => {
  for (const refusal of [noSpine, weakSpine, { ...spineOnly, reason: 'malformed answer family: type is not "choice"' }]) {
    const { deps, requests } = fakeRouter(refusal, admitted);
    const decision = await routeBuild(input, deps);
    assert.equal(requests.length, 1, refusal.reason);
    assert.equal(decision.decision, 'unrouted');
    assert.equal(decision.routeAttempts, 1);
  }
});

test('a retry that fails on the network leaves the first refusal standing', async () => {
  const { deps, requests } = fakeRouter(spineOnly, new Error('socket hang up'));
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 2);
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.routeAttempts, 2, 'two requests were sent');
  assert.ok(decision.ms >= base.ms + 25, `ms (${decision.ms}) includes the failed retry's wall time`);
  assert.ok(decision.ms < base.ms + 1000);
  assert.deepEqual(decision.usage, base.usage, 'a failed retry reported no usage, so usage is the first request\'s');
  assert.ok(decision.warnings.some((warning) => warning.includes('retry failed')));
});

test('a confident named spine with no runner-ups considered still earns the retry', async () => {
  // `spines` plays no part in the retry decision: only the top spine answer and the reason do.
  const bare: RouteDecision = { ...spineOnly, spines: [] };
  assert.equal(shouldRetryRoute(bare), true);
  const { deps, requests } = fakeRouter(bare, admitted);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 2);
  assert.equal(decision.decision, 'routed');
});

test('a cancelled build does not retry', async () => {
  const controller = new AbortController();
  const { deps, requests } = fakeRouter(spineOnly, admitted);
  const cancelling = { ...deps, createJevRouter: () => ({ route: async (request: RouteInput) => { const answer = await deps.createJevRouter().route(request); controller.abort(); return answer; } }) };
  await assert.rejects(routeBuild({ ...input, signal: controller.signal }, cancelling), { name: 'AbortError' });
  assert.equal(requests.length, 1);
});

test('shouldRetryRoute: only a confident spine with no admitted family', () => {
  assert.equal(shouldRetryRoute(spineOnly), true);
  assert.equal(shouldRetryRoute({ ...spineOnly, reason: 'no bundled family within transfer >= 2 of spine CO' }), true);
  assert.equal(shouldRetryRoute(admitted), false);
  assert.equal(shouldRetryRoute(noSpine), false);
  assert.equal(shouldRetryRoute(weakSpine), false);
});

// ---------------------------------------------------------------------------
// routefix-r1 Grok audit, FIX finding: a commerceOwnership abstain (route.ts's `commerceOwnership`
// gate, G7 task f8 root cause (a)) is a DECISION, not a refusal-to-place-a-spine — retrying it
// risks a flaky second answer (linksOut, or a lower-confidence inline) overturning a correct
// abstain and publishing a family the first request correctly declined.
// ---------------------------------------------------------------------------

const commerceUnroute: RouteDecision = {
  ...base,
  decision: 'unrouted',
  reason: 'commerceOwnership inline at p=0.97: storefront requires an external buy step to link to',
};

test('shouldRetryRoute: a commerceOwnership-gated unroute is never retry-worthy, even with a confident spine', () => {
  assert.equal(shouldRetryRoute(commerceUnroute), false);
});

test('routeBuild: a confident commerceOwnership inline unroute sends exactly one request, never a retry', async () => {
  const { deps, requests } = fakeRouter(commerceUnroute, admitted);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 1, 'the commerceOwnership abstain must not be re-asked');
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, commerceUnroute.reason);
  assert.equal(decision.routeAttempts, 1);
});

// ---------------------------------------------------------------------------
// G7 task f8 run-3 re-plan: the general exclusion gate's own unroute (`exclusion:<family>:<index>`)
// is never retried either, for the identical reason — it is a DECISION, not a refusal to place
// the brief on a spine.
// ---------------------------------------------------------------------------

const exclusionUnroute: RouteDecision = {
  ...base,
  decision: 'unrouted',
  reason: "exclusion:storefront:3: Not storefront (abstain instead): a brief that asks this page itself to build or embed the cart, checkout, or payment form inline, with no separate existing buy step to link to.",
};

test('shouldRetryRoute: an exclusion-gated unroute is never retry-worthy, even with a confident spine', () => {
  assert.equal(shouldRetryRoute(exclusionUnroute), false);
});

test('routeBuild: a confident exclusion unroute sends exactly one request, never a retry', async () => {
  const { deps, requests } = fakeRouter(exclusionUnroute, admitted);
  const decision = await routeBuild(input, deps);
  assert.equal(requests.length, 1, 'the exclusion abstain must not be re-asked');
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, exclusionUnroute.reason);
  assert.equal(decision.routeAttempts, 1);
});
