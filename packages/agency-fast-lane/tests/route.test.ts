/**
 * The Jev router: request shape (`buildRouteQuestions`, against the real checked-in atlas and
 * registry), the pure resolution policy (`resolveRoute`), and `createJevRouter`'s fetch/auth/error
 * behavior (fake fetch, as in `tests/jev.test.ts`).
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAtlasData, validateFamilyRegistry, type FamilyRegistry, type FamilyRegistryEntry } from '../src/atlas.ts';
import { applyExclusionAnswer, buildExclusionQuestion, buildRouteQuestions, createJevRouter, DEFAULT_CONSENSUS_K, DEFAULT_MIN_TRANSFER, resolveRoute, type ChoiceAnswer } from '../src/route.ts';
import type { JsonObject } from '../src/spine.ts';

const { atlas, registry } = await loadAtlasData();

type Captured = { url: string; method: string; headers: Record<string, string>; body: JsonObject };

function fakeFetch(captured: Captured[], respond: (body: JsonObject) => JsonObject): typeof fetch {
  return (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body,
    });
    return new Response(JSON.stringify(respond(body)), { status: 200 });
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// buildRouteQuestions: request shape
// ---------------------------------------------------------------------------

test('buildRouteQuestions: state is {brief} only, 14 questions, none/unspecified present', () => {
  const { state, questions } = buildRouteQuestions('A dentist office in Riverbend.', atlas, registry);
  assert.deepEqual(state, { brief: 'A dentist office in Riverbend.' });
  assert.equal(Object.keys(questions).length, 14, 'spine + 9 archetype_<CODE> + family + commerceOwnership + skin + pageKind — the exclusion gate is a SEPARATE, second request (buildExclusionQuestion), never part of this fan-out');
  assert.ok('spine' in questions);
  assert.ok('family' in questions);
  assert.ok('commerceOwnership' in questions);
  assert.ok(!('exclusion' in questions), 'exclusion is asked in a second request, scoped to the winner alone — never bundled into the first fan-out');
  assert.ok('skin' in questions);
  assert.ok('pageKind' in questions);
  for (const spine of atlas.spines) assert.ok(`archetype_${spine.code}` in questions, `archetype_${spine.code} present`);

  assert.equal(questions.spine!.type, 'choice');
  assert.ok('none' in questions.spine!.criteria);
  assert.ok('none' in questions.family!.criteria);
  assert.ok('none' in questions.archetype_TL!.criteria);
  assert.ok('unspecified' in questions.skin!.criteria, 'skin has no none option, only unspecified');
  assert.ok(!('none' in questions.skin!.criteria));

  assert.equal(questions.pageKind!.type, 'choice');
  assert.deepEqual(Object.keys(questions.pageKind!.criteria).sort(), ['app', 'dashboard', 'none', 'site']);
});

test('buildRouteQuestions: the TL archetype question has one option per TL archetype (6) plus none', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  const tlArchetypes = atlas.archetypes.filter((archetype) => archetype.spine === 'TL');
  assert.equal(tlArchetypes.length, 6);
  const keys = Object.keys(questions.archetype_TL!.criteria);
  assert.equal(keys.length, 7);
  for (const archetype of tlArchetypes) assert.ok(keys.includes(archetype.id));
});

test('buildRouteQuestions: each spine criterion names its archetypes as examples (at least 3 where the atlas has 3)', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  for (const spine of atlas.spines) {
    const text = questions.spine!.criteria[spine.code]!;
    const own = atlas.archetypes.filter((archetype) => archetype.spine === spine.code);
    const named = own.filter((archetype) => text.includes(archetype.name));
    assert.equal(named.length, own.length, `${spine.code} names every archetype`);
    assert.ok(named.length >= Math.min(3, own.length), `${spine.code} names at least ${Math.min(3, own.length)} archetypes`);
    for (const other of atlas.archetypes.filter((archetype) => archetype.spine !== spine.code)) {
      assert.ok(!text.includes(`${other.name} (`), `${spine.code} does not list ${other.id}`);
    }
  }
  // The ladder-10 case: documentation belongs to CS, and the TU criterion does not claim it.
  assert.match(questions.spine!.criteria.CS!, /Documentation or knowledge base \(documentation, knowledge, base, help, support\)/);
  assert.doesNotMatch(questions.spine!.criteria.TU!, /documentation/i);
});

test('buildProfileQuestions asks the spine question in the router\'s exact words', async () => {
  const { buildProfileQuestions } = await import('../src/profile-questions.ts');
  const { loadDesignTaxonomy } = await import('../src/taxonomy.ts');
  const route = buildRouteQuestions('brief', atlas, registry).questions.spine!.criteria;
  const spineQuestion = buildProfileQuestions(atlas, registry, await loadDesignTaxonomy()).spine!;
  assert.equal(spineQuestion.type, 'choice');
  const profile = (spineQuestion as { criteria: Record<string, string> }).criteria;
  for (const spine of atlas.spines) assert.equal(profile[spine.code], route[spine.code]);
});

test('buildRouteQuestions: criteria quote the atlas\'s own text', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  const tl = atlas.spines.find((spine) => spine.code === 'TL')!;
  assert.ok(questions.spine!.criteria.TL!.includes(tl.name));
  assert.ok(questions.spine!.criteria.TL!.includes(tl.intent));
  assert.ok(questions.spine!.criteria.TL!.includes(tl.steps.join(' → ')));
  const watson = registry.families.find((f) => f.family === 'watson')!;
  assert.ok(questions.family!.criteria.watson!.includes(watson.summary));
  assert.ok(questions.family!.criteria.watson!.includes(watson.archetype));
  for (const skin of atlas.skins) assert.ok(skin in questions.skin!.criteria, `skin criteria has ${skin}`);
});

// ---------------------------------------------------------------------------
// buildRouteQuestions: family criteria are asked on each family's OWN spine's terms
// (move 1 — routing coverage). Jev answers the `spine` and `family` questions in the same
// simultaneous fan-out request without seeing each other's answer, so a family's own criterion is
// the only place that can tell Jev "this family only fits a brief whose decision sequence matches
// mine" — the same decision-sequence language the spine question itself uses. Without this, family
// probability mass has no reason to track spine legality, and a family whose spine the brief did
// NOT pick (so `resolveRoute` will never admit it as a candidate) can still absorb most of the
// probability mass, starving the legal candidates below `threshold`. See bl.json in the routing
// eval corpus: spine CS, family fervor (TL) at p=0.93 — fervor is not even a reachable candidate
// for CS, so that mass was never spendable.
// ---------------------------------------------------------------------------

test('buildRouteQuestions: every family criterion names every spine resolveRoute would actually accept it from — its own spine plus every compatible one at >= minTransfer, on the same decision-sequence terms the spine question uses', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  for (const entry of registry.families) {
    const criterion = questions.family!.criteria[entry.family]!;
    const legalSpineCodes = atlas.spines
      .filter((s) => s.code === entry.spine || (atlas.compatibility[entry.spine]?.[s.code] ?? 0) >= DEFAULT_MIN_TRANSFER)
      .map((s) => s.code);
    assert.ok(legalSpineCodes.includes(entry.spine), `${entry.family}'s own spine ${entry.spine} is always legal`);
    for (const code of legalSpineCodes) {
      const spine = atlas.spines.find((s) => s.code === code)!;
      assert.ok(criterion.includes(spine.name), `${entry.family} criterion names legal spine ${spine.name}`);
      assert.ok(criterion.includes(spine.intent), `${entry.family} criterion states legal spine ${spine.name}'s intent`);
    }
    // And a spine resolveRoute would refuse this family from must not be named as a fit. Checking
    // BOTH `name` and `intent` (not `name` alone) closes a real gap: `name` alone can't tell an
    // illegal spine's name apart from a substring of some OTHER (legal) spine's own `intent` text —
    // it would falsely pass if one ever collided with the other, since the criterion could still
    // contain the illegal name's characters without meaning to name it as legal. Requiring the
    // illegal spine's EXACT intent string absent too closes that gap: the same collision could not
    // produce a false pass on both checks at once, since the two texts are independent per spine.
    for (const spine of atlas.spines) {
      if (!legalSpineCodes.includes(spine.code)) {
        assert.ok(!criterion.includes(spine.name), `${entry.family} criterion does not name illegal spine ${spine.name}`);
        assert.ok(!criterion.includes(spine.intent), `${entry.family} criterion does not state illegal spine ${spine.name}'s intent`);
      }
    }
  }
});

test('buildRouteQuestions: a custom minTransfer changes which spines a family criterion names — the family question and the eventual resolveRoute(..., { minTransfer }) call must agree on the same legality bar', () => {
  const permissive = buildRouteQuestions('brief', atlas, registry, 1).questions.family!.criteria.fervor!;
  const strict = buildRouteQuestions('brief', atlas, registry, 3).questions.family!.criteria.fervor!;
  const defaulted = buildRouteQuestions('brief', atlas, registry).questions.family!.criteria.fervor!;
  const atDefault = buildRouteQuestions('brief', atlas, registry, DEFAULT_MIN_TRANSFER).questions.family!.criteria.fervor!;
  assert.equal(defaulted, atDefault, 'omitting minTransfer must build the same criteria as passing DEFAULT_MIN_TRANSFER explicitly');
  // minTransfer 1 admits every spine with ANY transfer to fervor's own spine (TL); minTransfer 3
  // admits only spines whose transfer to TL is exactly 3 (the diagonal max) — a strictly narrower
  // set. If buildRouteQuestions ignored the argument (the bug this test guards against — the
  // family question always describing the DEFAULT legality bar regardless of what the caller will
  // actually resolve with), all three would be identical.
  assert.notEqual(permissive, strict, 'a permissive and a strict minTransfer must produce different legal-spine lists');
  assert.ok(permissive.length >= strict.length, 'the permissive (minTransfer 1) criterion names at least as many spines as the strict (minTransfer 3) one');
});

// ---------------------------------------------------------------------------
// R1 (mishh-genui-production families-design task t25c): the router builds family choices only
// from the registry, with no per-family code. A brand-new registry row (a temp fixture, unrelated
// to any real bundled family) must become routable by editing JSON alone — no change to route.ts
// — and an id the registry does not list must fail closed rather than route or throw.
// ---------------------------------------------------------------------------

/** A throwaway registry row on an atlas archetype no shipped family currently claims (TL.01),
 * proving a fresh row is routable purely from data. */
const FIXTURE_ENTRY: FamilyRegistryEntry = {
  family: 'route-negatives-fixture',
  archetype: 'TL.01',
  spine: 'TL',
  skin: 'Minimal and quiet',
  skinInferred: true,
  summary: 'Temporary fixture family for a router unit test: a plain one-page trust-to-lead brief.',
  pageKind: 'site',
};

test('R1: a new registry row is routable with no router code change — a temp fixture family added to the registry alone reaches resolveRoute', () => {
  const extendedRegistry: FamilyRegistry = { families: [...registry.families, FIXTURE_ENTRY] };
  // The fixture must first pass the same structural check every real row passes — proves it is a
  // legitimate registry entry, not a specially-shaped test double route.ts would treat differently.
  assert.doesNotThrow(() => validateFamilyRegistry(extendedRegistry, atlas));

  // buildRouteQuestions (unmodified) must surface the new row on its own, from the registry alone.
  const { questions } = buildRouteQuestions('brief', atlas, extendedRegistry);
  assert.ok(questions.family!.criteria['route-negatives-fixture']!.includes(FIXTURE_ENTRY.summary));

  // resolveRoute (unmodified) must be able to route TO the new family when Jev picks it, on an
  // ordinary exact-archetype answer set — exactly the same shape every shipped family uses.
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.01', { 'TL.01': 1, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 0 }),
    family: choice('route-negatives-fixture', { 'route-negatives-fixture': 0.9, watson: 0.1, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, extendedRegistry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'route-negatives-fixture');
  assert.equal(decision.family?.basis, 'exact');
});

test('R1: an unknown family id from the model (not in the registry) fails closed — unrouted, never a throw, never routed', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 1, 'TL.06': 0, none: 0 }),
    // Jev hallucinates a family id that was never offered as a criterion (not a registered
    // family, not "none") — e.g. an answer naming a family still being built on another branch.
    family: { type: 'choice' as const, choice: 'not-yet-a-family', confidence: 0.95, probabilities: { 'not-yet-a-family': 0.95, watson: 0.05 } },
    skin: choice('unspecified', { unspecified: 1 }),
  };
  assert.doesNotThrow(() => resolveRoute(answers, atlas, registry));
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^malformed answer family: choice is not one of the offered options$/);
  assert.deepEqual(decision.candidates, []);
  assert.equal(decision.family, undefined);
});

test('createJevRouter: the request body carries the family question built from the caller\'s own minTransfer, not always the default', async () => {
  const captured: Captured[] = [];
  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl: fakeFetch(captured, allNone) });
  await router.route({ brief: 'A dentist office.', atlas, registry, minTransfer: 1 });
  const sentFervorCriterion = (captured[0]!.body.questions as JsonObject).family as { criteria: Record<string, string> };
  const expected = buildRouteQuestions('A dentist office.', atlas, registry, 1).questions.family!.criteria.fervor!;
  assert.equal(sentFervorCriterion.criteria.fervor, expected, 'createJevRouter must thread its own minTransfer into buildRouteQuestions, not silently use the default');
});

test('buildRouteQuestions: fervor is scoped to agencies selling their own creative services, not any motion-heavy or cinematic brief', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  const fervor = questions.family!.criteria.fervor!;
  assert.ok(/not\b.*(saas|e-?commerce|course|museum|contractor)/i.test(fervor), 'fervor criterion names businesses it excludes');
  assert.ok(/motion|cinematic/i.test(fervor) && /alone|merely/i.test(fervor), 'fervor criterion says motion/cinematic styling alone is not enough');
});

test('buildRouteQuestions: commerceOwnership criteria distinguish a full-stack PLATFORM name (always linksOut, regardless of which of its own features the brief also lists) from a bare payment PROCESSOR name (linksOut by default, but flips to inline when a concrete on-page mechanic is also described) — run-3 §8, replacing a reverted blanket-inversion attempt', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  const commerce = questions.commerceOwnership!.criteria;
  // `linksOut` must distinguish a full-stack platform from a bare processor, and say the
  // platform's own features (bundle pricing, shipping calculators, gift options) don't flip a
  // platform-named brief to inline.
  assert.ok(/platform/i.test(commerce.linksOut!), 'linksOut criterion names a full-stack commerce platform as one path');
  assert.ok(/processor/i.test(commerce.linksOut!), 'linksOut criterion also names a bare payment processor as a separate path');
  assert.ok(/bundle|shipping calculator/i.test(commerce.linksOut!), 'linksOut criterion says the platform\'s own features do not override a named platform');
  // `inline` must flip a bare-processor brief to inline only when a concrete extra mechanic is
  // named, and must enumerate mechanics beyond the literal words "cart"/"combining".
  assert.ok(/variant|option/i.test(commerce.inline!), 'inline criterion names product-option/variant selection as a qualifying mechanic');
  assert.ok(/computed|calculat/i.test(commerce.inline!), 'inline criterion names computed shipping as a qualifying mechanic');
  assert.ok(/gift note|customization/i.test(commerce.inline!), 'inline criterion names an order-customization field as a qualifying mechanic');
  assert.ok(/subscription|recurring/i.test(commerce.inline!), 'inline criterion names subscription/recurring setup as a qualifying mechanic');
  assert.ok(/not enough for inline/i.test(commerce.inline!), 'inline criterion says a bare processor name alone, with none of those mechanics, stays linksOut');
  // `linksOut` must explicitly say a platform name used ONLY as a style/aesthetic reference
  // ("Shopify-style") does not count as that platform actually running the shop.
  assert.ok(/style/i.test(commerce.linksOut!), 'linksOut criterion carves out a platform name used only as a style reference');
});

test('buildRouteQuestions: commerceOwnership criteria treat a HOSTED PAYMENT DESTINATION (a checkout/payment page or link the visitor is sent to) as linksOut even when on-page product/variant browsing is also described — routeexcl-r1 Gemini audit F1', () => {
  const { questions } = buildRouteQuestions('brief', atlas, registry);
  const commerce = questions.commerceOwnership!.criteria;
  assert.ok(/hosted payment destination/i.test(commerce.linksOut!), 'linksOut criterion names a hosted payment destination as its own category, distinct from a full-stack platform and a bare processor');
  assert.ok(/sent to/i.test(commerce.linksOut!), 'linksOut criterion frames the test as whether the visitor is sent away to pay');
  assert.ok(/variant/i.test(commerce.linksOut!), 'linksOut criterion says on-page variant/option browsing before the handoff does not override a hosted destination');
  // `inline`'s bare-processor path must explicitly require an on-page, non-redirecting checkout —
  // a hosted/redirect destination is excluded from inline even when a qualifying mechanic exists.
  assert.ok(/invisible backend/i.test(commerce.inline!), 'inline criterion requires the processor to be an invisible backend, not a redirect');
  assert.ok(/redirect/i.test(commerce.inline!), 'inline criterion explicitly excludes a redirect/hosted destination from qualifying as inline');
});

test('createJevRouter: request shape — endpoint, model, Authorization header', async () => {
  const captured: Captured[] = [];
  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl: fakeFetch(captured, allNone) });
  await router.route({ brief: 'A dentist office.', atlas, registry });

  assert.equal(captured.length, 1);
  const request = captured[0]!;
  assert.equal(request.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.headers['content-type'], 'application/json');
  assert.equal(request.body.model, 'jev-1.13.0');
  assert.deepEqual(request.body.state, { brief: 'A dentist office.' });
});

test('createJevRouter: a resolved apiKey function is called and cached across calls', async () => {
  let calls = 0;
  const captured: Captured[] = [];
  const router = createJevRouter({ consensusK: 1, apiKey: async () => {
      calls += 1;
      return 'lazy-key';
    },
    fetchImpl: fakeFetch(captured, allNone),
  });
  await router.route({ brief: 'b', atlas, registry });
  await router.route({ brief: 'b', atlas, registry });
  assert.equal(calls, 1);
});

test('createJevRouter: a failed key read is not cached, so the next route retries it', async () => {
  let calls = 0;
  const captured: Captured[] = [];
  const router = createJevRouter({ consensusK: 1, apiKey: async () => {
      calls += 1;
      if (calls === 1) throw new Error('failed to read typesafe_api_key from zsvault');
      return 'lazy-key';
    },
    fetchImpl: fakeFetch(captured, allNone),
  });
  // The daemon reads the key on the first Jev request of the process and answers 503 when that
  // fails; a cached rejection would make every later request fail the same way until a restart.
  // The consensus wrapper never throws (Promise.allSettled), so the first call resolves unrouted
  // instead of rejecting — the caching behavior under test is unchanged either way.
  const firstDecision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(firstDecision.decision, 'unrouted');
  assert.equal(firstDecision.reason, 'consensus:vote-failed');
  assert.equal(captured.length, 0);
  const decision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(calls, 2);
  assert.equal(captured[0]!.headers.authorization, 'Bearer lazy-key');
});

test('createJevRouter: a non-2xx response fails that vote closed (sanitized status/phrase, never the body) — consensusK: 1 resolves unrouted, never throws (Promise.allSettled, run-3 §9 follow-up)', async () => {
  const fetchImpl = (async () => new Response('bad request', { status: 422 })) as typeof fetch;
  const router = createJevRouter({ consensusK: 1, apiKey: 'k', fetchImpl });
  const decision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'consensus:vote-failed');
});

test('sentinel: an upstream response body never rides out anywhere on a failed vote, including a failed vote\'s own RouteError', async () => {
  const sentinel = 'SENTINEL-BODY-7731';
  const fetchImpl = (async () => new Response(`<html>${sentinel} — internal trace</html>`, { status: 401 })) as typeof fetch;
  const router = createJevRouter({ consensusK: 1, apiKey: 'k', fetchImpl });
  const decision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'consensus:vote-failed');
  assert.ok(!JSON.stringify(decision).includes(sentinel), 'the upstream body never rides out anywhere on the returned decision');
});

test('createJevRouter: a network failure never throws into the build — the consensus wrapper catches it via Promise.allSettled and resolves unrouted (consensus:vote-failed)', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch failed');
  }) as typeof fetch;
  const router = createJevRouter({ consensusK: 1, apiKey: 'k', fetchImpl });
  const decision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'consensus:vote-failed');
  assert.deepEqual(decision.votes, [{ decision: 'unrouted', reason: 'consensus:vote-failed' }]);
});

test('createJevRouter: singleAttempt itself still throws on a network failure — only the consensus wrapper catches it (Promise.allSettled boundary)', async () => {
  const fetchImpl = (async () => {
    throw new Error('fetch failed');
  }) as typeof fetch;
  // No public API calls singleAttempt directly, so this is verified indirectly: a bare
  // Promise.all (not allSettled) over N of the SAME failing fetchImpl would reject — proven by
  // the fact that every consensusK > 1 request in this suite below still resolves (never
  // rejects) even when a vote fails, which is only possible because the wrapper uses allSettled.
  const router = createJevRouter({ consensusK: 3, apiKey: 'k', fetchImpl });
  const decision = await router.route({ brief: 'b', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^consensus:/);
  assert.equal(decision.votes?.length, 3);
  assert.ok(decision.votes!.every((vote) => vote.reason === 'consensus:vote-failed'));
});

// A fake Jev answer set: every criteria option answered 'none'/'unspecified' with all probability there.
function allNone(body: JsonObject): JsonObject {
  const questions = body.questions as Record<string, JsonObject>;
  const answers: JsonObject = {};
  for (const [id, question] of Object.entries(questions)) {
    const criteria = question.criteria as JsonObject;
    const noneKey = 'none' in criteria ? 'none' : 'unspecified';
    const probabilities: Record<string, number> = {};
    for (const key of Object.keys(criteria)) probabilities[key] = key === noneKey ? 1 : 0;
    answers[id] = { type: 'choice', choice: noneKey, confidence: 1, probabilities };
  }
  return { model: 'jev-1.13.0', answers, usage: { input_tokens: 50, output_tokens: 5 } };
}

// ---------------------------------------------------------------------------
// resolveRoute: pure resolution policy
// ---------------------------------------------------------------------------

function choice(choiceValue: string, probabilities: Record<string, number>, confidence = 1): ChoiceAnswer {
  return { type: 'choice', choice: choiceValue, confidence, probabilities };
}

test('createJevRouter: saturated raw confidence cannot bypass the family threshold', async () => {
  const captured: Captured[] = [];
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.3, none: 0.7 }, 1),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl: fakeFetch(captured, () => ({ model: 'jev-stub', answers })) });
  const input = { brief: 'A museum.', atlas, registry };
  const rejected = await router.route({ ...input, threshold: 0.5 });
  assert.equal(rejected.decision, 'unrouted');
  assert.match(rejected.reason!, /below 0\.5/);
  const admitted = await router.route({ ...input, threshold: 0.3 });
  assert.equal(admitted.decision, 'routed');
  assert.equal(admitted.family?.id, 'halcyon');
  assert.equal(admitted.family?.probability, 0.3);
  assert.equal(captured.length, 2);
});

test('resolveRoute: exact archetype match wins outright', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.8, watson: 0.1, fervor: 0.02, wrenfield: 0.02, maben: 0.02, maren: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'halcyon', probability: 0.8, basis: 'exact', transfer: 3, viaSpine: 'BA' });
  assert.equal(decision.archetype?.id, 'BA.03');
});

// ---------------------------------------------------------------------------
// restaurant (BA.02): offline routing proof for the two route-corpus-labels.json v3 additions.
// resolveRoute is the same pure, no-network policy route-corpus.test.ts scores the real 25-item
// corpus against; these two cases stand in for coastal-trattoria-brief and
// neighborhood-bistro-brief (both BA.02, family restaurant) without needing a live Jev call.
// ---------------------------------------------------------------------------

test('resolveRoute: a BA.02 restaurant-shaped answer set (menu, reservation, dining) routes to restaurant', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.02', { 'BA.01': 0, 'BA.02': 1, 'BA.03': 0, none: 0 }),
    family: choice('restaurant', { restaurant: 0.82, halcyon: 0.08, watson: 0.02, fervor: 0.02, wrenfield: 0.02, maben: 0.02, maren: 0.01, emmpo: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'restaurant', probability: 0.82, basis: 'exact', transfer: 3, viaSpine: 'BA' });
  assert.equal(decision.archetype?.id, 'BA.02');
});

test('resolveRoute: a BA.03 museum/venue-shaped answer set still routes to halcyon, not restaurant — restaurant does not steal BA.03', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.7, restaurant: 0.15, watson: 0.05, fervor: 0.02, wrenfield: 0.02, maben: 0.02, maren: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'halcyon');
  assert.notEqual(decision.family?.id, 'restaurant');
  assert.equal(decision.archetype?.id, 'BA.03');
});

// ---------------------------------------------------------------------------
// community (LM.03): offline routing proof for the two route-corpus-labels.json v4 additions.
// ---------------------------------------------------------------------------

test('resolveRoute: an LM.03 community-membership answer routes to community, not emmpo (M11)', () => {
  const answers = {
    spine: choice('LM', { LM: 1 }),
    archetype_LM: choice('LM.03', { 'LM.01': 0, 'LM.02': 0, 'LM.03': 1, none: 0 }),
    family: choice('community', { community: 0.8, emmpo: 0.15, watson: 0.02, fervor: 0.01, wrenfield: 0.01, maben: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'community', probability: 0.8, basis: 'exact', transfer: 3, viaSpine: 'LM' });
  assert.equal(decision.archetype?.id, 'LM.03');
});

test('resolveRoute: an LM.01 course/cohort answer still routes to emmpo, not community (M11 regression guard)', () => {
  const answers = {
    spine: choice('LM', { LM: 1 }),
    archetype_LM: choice('LM.01', { 'LM.01': 1, 'LM.02': 0, 'LM.03': 0, none: 0 }),
    family: choice('emmpo', { emmpo: 0.8, community: 0.15, watson: 0.02, fervor: 0.01, wrenfield: 0.01, maben: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'emmpo', probability: 0.8, basis: 'exact', transfer: 3, viaSpine: 'LM' });
  assert.equal(decision.archetype?.id, 'LM.01');
});

test('resolveRoute: same-spine candidates are ranked by family probability', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.01', { 'TL.01': 1, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 0 }),
    family: choice('watson', { watson: 0.5, fervor: 0.3, wrenfield: 0.1, maben: 0.05, halcyon: 0.02, maren: 0.02, emmpo: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'watson', probability: 0.5, basis: 'same-spine', transfer: 3, viaSpine: 'TL' });
});

test('resolveRoute: a family reached only through spine compatibility (transfer 2) is picked when Jev favours it — the design doc\'s SM -> storefront (CO, transfer 2) example', () => {
  // Was SM -> maren before maren moved to spine TL (G7 task f8 root cause (b)); storefront kept
  // its own spine (CO) and archetype (CO.01), so it now carries this compatible-spine-transfer
  // mechanism test instead — the mechanism under test (transfer >= minTransfer admits a family
  // from a non-home spine) is unchanged.
  const answers = {
    spine: choice('SM', { SM: 1 }),
    archetype_SM: choice('none', { 'SM.01': 0, 'SM.02': 0, 'SM.03': 0, 'SM.04': 0, 'SM.05': 0, none: 1 }),
    family: choice('storefront', { storefront: 0.6, halcyon: 0.3, watson: 0.02, fervor: 0.02, wrenfield: 0.02, maben: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry, { minTransfer: 2 });
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'storefront', probability: 0.6, basis: 'compatible', transfer: 2, viaSpine: 'SM' });
  // emmpo sits on LM, and the atlas scores SM -> LM at 1 — below minTransfer, so it never becomes a candidate.
  assert.ok(!decision.candidates.some((c) => c.family === 'emmpo'), 'transfer 1 (SM -> LM) is excluded, not just outranked');
  assert.ok(decision.candidates.some((c) => c.family === 'storefront' && c.transfer === 2));
});

test('resolveRoute: spine none is unrouted', () => {
  const answers = {
    spine: choice('none', { none: 1 }),
    family: choice('none', { none: 1 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'no spine');
  assert.deepEqual(decision.candidates, []);
});

test('resolveRoute: a top-ranked family below the threshold is unrouted, but the ranking is still reported', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.3, watson: 0.1, fervor: 0.1, wrenfield: 0.1, maben: 0.1, maren: 0.1, emmpo: 0.1, none: 0.2 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry, { threshold: 0.5 });
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^family halcyon at p=0\.3.* below 0\.5$/);
  assert.ok(decision.candidates.length > 0, 'the ranking is still present');
});

test('resolveRoute: unrouted when no family is within transfer >= minTransfer (MI family removed from a test registry)', () => {
  // MI has no registry family on its own spine, and every MI -> family-spine score is below 2
  // except MI -> MI itself (no registry family there either): TL 2, PA 1, CO 1, SM 0, CS 2, LM 2, BA 1, TU 2.
  // maren sits on CO (score 1, excluded) and emmpo on LM (score 2, kept) — pick an archetype/spine
  // combination with truly nothing in range instead: use minTransfer 3, which only same-spine/exact clear.
  // PA itself now carries a family (marketing-site, page-kind Task 4) and cannot be used here.
  // Every spine now carries a family (nonprofit sits on MI), so the MI family is left out of the
  // registry for this case: the policy, not the data, is under test.
  const answers = {
    spine: choice('MI', { MI: 1 }),
    archetype_MI: choice('none', { 'MI.01': 0, 'MI.02': 0, none: 1 }),
    family: choice('none', { watson: 0.1, fervor: 0.1, wrenfield: 0.1, maben: 0.1, halcyon: 0.1, maren: 0.1, emmpo: 0.1, none: 0.3 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  // The SHIPPED registry does have an MI family (nonprofit, MI.01); only this test copy drops it.
  const withoutMi = { families: registry.families.filter((entry) => entry.spine !== 'MI') };
  assert.ok(registry.families.some((entry) => entry.spine === 'MI'), 'the shipped registry keeps its MI family');
  const decision = resolveRoute(answers, atlas, withoutMi, { minTransfer: 3 });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'no bundled family within transfer >= 3 of spine MI');
  assert.deepEqual(decision.candidates, []);
});

test('resolveRoute: a tie within 0.02 is broken by basis (exact beats same-spine)', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 1, 'TL.06': 0, none: 0 }),
    // watson (TL.05, exact) at 0.52 vs wrenfield (TL.04, same-spine) at 0.53: 0.01 apart, a tie —
    // exact must still win even though wrenfield's raw probability is (barely) higher. Both clear
    // the default 0.5 threshold; halcyon (BA, compatible via TL -> BA transfer 3) sits well below
    // either, so it never becomes a tie candidate.
    family: choice('wrenfield', { watson: 0.52, fervor: 0.05, wrenfield: 0.53, maben: 0.02, halcyon: 0.1, maren: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.family?.id, 'watson');
  assert.equal(decision.family?.basis, 'exact');
});

test('resolveRoute: a tie within 0.02 at the same basis is broken by skin match', () => {
  const answers = {
    // TL.01 has no exact registry match, so every registry TL family is a same-spine candidate.
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.01', { 'TL.01': 1, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 0 }),
    // maben (skin Minimal and quiet) at 0.51, watson (skin Editorial) at 0.52: a tie, same basis —
    // the requested skin (Minimal and quiet, maben's own) must break it over the raw ranking.
    family: choice('watson', { watson: 0.52, maben: 0.51, fervor: 0.05, wrenfield: 0.02, halcyon: 0.05, maren: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('Minimal and quiet', { 'Minimal and quiet': 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.family?.id, 'maben');
});

test('resolveRoute: a family on the runner-up spine is a candidate when the spine call is spread (the storefront case: TL 0.48 / CO 0.36)', () => {
  // Was the maren case before maren moved to spine TL (G7 task f8 root cause (b)); storefront
  // kept spine CO/archetype CO.01, so it now exercises this runner-up-spine mechanism instead.
  const answers = {
    spine: choice('TL', { TL: 0.48, CO: 0.36, BA: 0.14, PA: 0.01, SM: 0.01 }),
    // No archetype_TL answer: nothing on TL should reach 'exact' here. CO.01 is storefront's own archetype.
    archetype_CO: choice('CO.01', { 'CO.01': 1, 'CO.02': 0, 'CO.03': 0, none: 0 }),
    family: choice('storefront', { storefront: 0.8, watson: 0.02, fervor: 0.02, wrenfield: 0.02, maben: 0.02, halcyon: 0.02, emmpo: 0.02, none: 0.08 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  // CO (0.36) clears the default 0.25 spineShare alongside TL (0.48); BA/PA/SM (0.14/0.01/0.01) do not.
  assert.deepEqual(
    decision.spines.map((s) => s.code).sort(),
    ['CO', 'TL'],
  );
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'storefront', probability: 0.8, basis: 'exact', transfer: 3, viaSpine: 'CO' });
  assert.notEqual(decision.family!.viaSpine, decision.spine.code, 'viaSpine names the runner-up spine the family was admitted from, not the top spine');
  const storefrontCandidate = decision.candidates.find((c) => c.family === 'storefront');
  assert.equal(storefrontCandidate?.viaSpine, 'CO', 'storefront is reached through the runner-up spine CO, not the top spine TL');
  // The routed spine itself is still reported as TL: spine mass only widens the candidate pool.
  assert.equal(decision.spine.code, 'TL');
});

test('resolveRoute: a runner-up spine below spineShare stays excluded from candidate-gathering', () => {
  const answers = {
    spine: choice('TL', { TL: 0.7, CO: 0.2, BA: 0.05, PA: 0.03, SM: 0.02 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    // storefront (spine CO) would win outright if CO qualified; it must not even become a candidate.
    family: choice('storefront', { storefront: 0.9, watson: 0.02, fervor: 0.02, wrenfield: 0.02, maben: 0.02, halcyon: 0.02, emmpo: 0, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  // CO's 0.2 sits below the default 0.25 share, so only TL qualifies.
  assert.deepEqual(decision.spines, [{ code: 'TL', probability: 0.7 }]);
  assert.ok(!decision.candidates.some((c) => c.family === 'storefront'), 'storefront stays excluded: its only spine (CO) never qualified');
});

test('resolveRoute: a probability exactly at the threshold still routes (the gate is strictly-less-than)', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.5, watson: 0.1, fervor: 0.1, wrenfield: 0.1, maben: 0.1, maren: 0.1, emmpo: 0.1, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry, { threshold: 0.5 });
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.probability, 0.5);
});

test('resolveRoute: the routed spine is always a candidate-gathering spine even when its own probability is below spineShare (the item-1 repro)', () => {
  // Spine mass spread thin across many options (p 0.22 for the winning spine) must not drop the
  // routed spine itself from candidate-gathering — only ADDITIONAL runner-up spines need spineShare.
  const answers = {
    spine: choice('TL', { TL: 0.22, PA: 0.1, CO: 0.1, SM: 0.1, CS: 0.1, LM: 0.1, BA: 0.1, TU: 0.09, MI: 0.09 }),
    archetype_TL: choice('TL.04', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0.5, 'TL.05': 0.3, 'TL.06': 0.2, none: 0 }),
    family: choice('wrenfield', { wrenfield: 0.7, watson: 0.1, fervor: 0.05, maben: 0.05, halcyon: 0.05, maren: 0.03, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'wrenfield', probability: 0.7, basis: 'exact', transfer: 3, viaSpine: 'TL' });
  assert.ok(decision.spines.some((s) => s.code === 'TL'), 'the routed spine TL is in the candidate-gathering set despite p=0.22');
});

test('resolveRoute: a missing family answer is unrouted with a malformed-answer reason, never a throw', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    skin: choice('unspecified', { unspecified: 1 }),
    // family answer omitted entirely
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^malformed answer family: /);
  assert.deepEqual(decision.candidates, []);
});

test('resolveRoute: a missing archetype_<spine> answer is treated as none — the brief still routes on same-spine, and it is recorded in warnings', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    // archetype_TL omitted entirely — must degrade to "no archetype", not throw or crash.
    family: choice('watson', { watson: 0.6, fervor: 0.1, wrenfield: 0.1, maben: 0.1, halcyon: 0.05, maren: 0.03, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'watson', probability: 0.6, basis: 'same-spine', transfer: 3, viaSpine: 'TL' });
  assert.equal(decision.archetype, undefined);
  assert.ok(decision.warnings.some((w) => w.startsWith('archetype_TL:')), `expected an archetype_TL warning, got ${JSON.stringify(decision.warnings)}`);
});

test('resolveRoute: warnings is empty when nothing was ignored', () => {
  const answers = {
    spine: choice('BA', { BA: 1 }),
    archetype_BA: choice('BA.03', { 'BA.01': 0, 'BA.02': 0, 'BA.03': 1, none: 0 }),
    family: choice('halcyon', { halcyon: 0.9, watson: 0.02, fervor: 0.02, wrenfield: 0.02, maben: 0.02, maren: 0.02, emmpo: 0, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.deepEqual(decision.warnings, []);
});

test('resolveRoute: a non-numeric confidence is unrouted with a malformed-answer reason', () => {
  const answers = {
    // A live Jev response is JSON.parse output cast to ChoiceAnswer, not schema-checked — this
    // stands in for a malformed field the cast lets through undetected.
    spine: { ...choice('TL', { TL: 1 }), confidence: 'high' as unknown as number },
    family: choice('none', { none: 1 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^malformed answer spine: confidence is not a finite number/);
  assert.deepEqual(decision.spines, []);
});

test('resolveRoute: an out-of-range probability value is unrouted with a malformed-answer reason', () => {
  const answers = {
    spine: choice('TL', { TL: 75, PA: 0 }),
    family: choice('none', { none: 1 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^malformed answer spine: probabilities\.TL is not a finite number in \[0, 1\]/);
});

test('resolveRoute: a malformed archetype_<spine> answer (an option outside this spine\'s own set) is treated as none and recorded in warnings', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    // BA.01 is not a TL archetype: invalid for the archetype_TL question specifically.
    archetype_TL: choice('BA.01', { 'BA.01': 1 }),
    family: choice('watson', { watson: 0.6, fervor: 0.1, wrenfield: 0.1, maben: 0.1, halcyon: 0.05, maren: 0.03, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.archetype, undefined);
  assert.ok(
    decision.warnings.some((w) => w.startsWith('archetype_TL:') && w.includes('offered options')),
    `expected an archetype_TL "not offered" warning, got ${JSON.stringify(decision.warnings)}`,
  );
});

test('resolveRoute: skin is always reported, regardless of routed/unrouted', () => {
  const answers = {
    spine: choice('none', { none: 1 }),
    family: choice('none', { none: 1 }),
    skin: choice('Luxury', { Luxury: 0.9, unspecified: 0.1 }, 0.9),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.deepEqual(decision.skin, { choice: 'Luxury', confidence: 0.9 });
});

// ---------------------------------------------------------------------------
// resolveRoute: the pageKind consistency check (Task 5, spec §4 "one more choice question").
// pageKind is a CHECK on the family pick already made above, never a second routing signal —
// see the four cases in resolveRoute's own docblock.
// ---------------------------------------------------------------------------

/** A routed-to-fervor answer set (TL.05 exact match, family fervor at 0.9), with an optional
 * pageKind answer appended. `undefined` omits the key entirely — an older caller, or the
 * 25-profile corpus, that has never heard of the question. */
function fervorAnswers(pageKind: 'site' | 'app' | 'dashboard' | 'none' | undefined): Record<string, ChoiceAnswer> {
  const answers: Record<string, ChoiceAnswer> = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 1, 'TL.06': 0, none: 0 }),
    family: choice('fervor', { fervor: 0.9, watson: 0.02, wrenfield: 0.02, maben: 0.02, halcyon: 0.02, maren: 0.01, emmpo: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  if (pageKind !== undefined) {
    const probabilities: Record<string, number> = { site: 0, app: 0, dashboard: 0, none: 0 };
    probabilities[pageKind] = 1;
    answers.pageKind = choice(pageKind, probabilities, 1);
  }
  return answers;
}

test('resolveRoute: no pageKind answer at all (the 25-profile corpus, older callers) leaves the decision unchanged and pageKind absent', () => {
  const decision = resolveRoute(fervorAnswers(undefined), atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.equal(decision.pageKind, undefined);
});

test('createJevRouter + resolveRoute: a pageKind answer of none is recorded but leaves the routed decision byte-identical otherwise', async () => {
  const captured: Captured[] = [];
  // fervor DOES have `excludes`, so `createJevRouter` sends a second (exclusion-gate) request too
  // — answer it `none` so this test's own invariant (nothing else about the decision changes)
  // still holds; the exclusion gate's own behavior is covered separately above.
  const respond = (body: JsonObject): JsonObject => {
    const questions = body.questions as JsonObject | undefined;
    if (questions && 'exclusion' in questions) {
      return { model: 'jev-1.13.0', answers: { exclusion: { type: 'choice', choice: 'none', confidence: 0.95, probabilities: { none: 0.95 } } } };
    }
    return {
      model: 'jev-1.13.0',
      answers: fervorAnswers('none') as unknown as JsonObject,
      usage: { input_tokens: 50, output_tokens: 5 },
    };
  };
  const router = createJevRouter({ consensusK: 1, apiKey: 'k', fetchImpl: fakeFetch(captured, respond) });
  const withPageKind = await router.route({ brief: 'An ad agency that makes its own campaigns.', atlas, registry });
  const withoutPageKind = resolveRoute(fervorAnswers(undefined), atlas, registry);

  assert.equal(withPageKind.decision, 'routed');
  assert.equal(withPageKind.family?.id, 'fervor');
  assert.equal(withPageKind.pageKind?.choice, 'none');
  const { pageKind: _pageKind, ms: _ms, calls: _calls, model: _model, usage: _usage, votes: _votes, consensusK: _consensusK, ...withPageKindPolicy } = withPageKind;
  assert.deepEqual(withPageKindPolicy, withoutPageKind, 'a none pageKind answer must not change anything else about the decision');
});

test('resolveRoute: a confident pageKind answer that agrees with the winning family changes nothing', () => {
  // fervor's own pageKind (family-registry.json) is "site".
  const decision = resolveRoute(fervorAnswers('site'), atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.equal(decision.pageKind?.choice, 'site');
  assert.deepEqual(decision.warnings, []);
});

test('resolveRoute: a pageKind answer below DEFAULT_THRESHOLD changes nothing, but is still recorded', () => {
  const answers = fervorAnswers(undefined);
  answers.pageKind = choice('dashboard', { site: 0.1, app: 0.1, dashboard: 0.3, none: 0.5 }, 0.3);
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.deepEqual(decision.pageKind, { choice: 'dashboard', confidence: 0.3 });
  assert.deepEqual(decision.warnings, []);
});

test('resolveRoute: a confident pageKind answer that disagrees, with no bundled family at or above threshold to reroute to, becomes unrouted (maben 0.7 site vs pageKind dashboard 0.9)', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    // crm-dashboard sits on TU; TL -> TU transfer is below minTransfer, so it never becomes a
    // candidate here at all — the reroute search below must come up empty.
    family: choice('maben', { maben: 0.7, watson: 0.02, fervor: 0.02, wrenfield: 0.02, halcyon: 0.02, maren: 0.02, emmpo: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
    pageKind: choice('dashboard', { site: 0.05, app: 0.05, dashboard: 0.9, none: 0 }, 0.9),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.family, undefined);
  assert.match(decision.reason!, /^page kind dashboard at p=0\.90 has no bundled family at or above 0\.5$/);
  assert.equal(decision.warnings.length, 1);
  assert.equal(decision.warnings[0], 'page kind dashboard disagrees with family maben (site)');
});

test('resolveRoute: a confident pageKind answer that disagrees re-routes to the highest-probability matching candidate when one clears threshold (maben 0.7 site vs crm-dashboard 0.55 dashboard)', () => {
  const answers = {
    // TL (maben's own spine) and TU (crm-dashboard's own spine) both qualify for
    // candidate-gathering: TU's 0.3 share clears the default 0.25 spineShare.
    spine: choice('TL', { TL: 0.6, TU: 0.3, BA: 0.1 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    archetype_TU: choice('none', { 'TU.01': 0, 'TU.02': 0, 'TU.03': 0, none: 1 }),
    family: choice('maben', {
      maben: 0.7,
      'crm-dashboard': 0.55,
      watson: 0.02,
      fervor: 0.02,
      wrenfield: 0.02,
      halcyon: 0.02,
      maren: 0.02,
      emmpo: 0.02,
      none: 0,
    }),
    skin: choice('unspecified', { unspecified: 1 }),
    pageKind: choice('dashboard', { site: 0.05, app: 0.05, dashboard: 0.9, none: 0 }, 0.9),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'crm-dashboard', probability: 0.55, basis: 'same-spine', transfer: 3, viaSpine: 'TU' });
  // The reroute changes which candidate WINS, not the ranking itself: maben, the original
  // (higher-probability) winner, stays listed at the top of `candidates`.
  assert.equal(decision.candidates[0]?.family, 'maben');
  assert.equal(decision.warnings.length, 1);
  assert.equal(decision.warnings[0], 'page kind dashboard disagrees with family maben (site)');
});

test('resolveRoute: a malformed pageKind answer degrades to no answer — a warning is recorded, the decision is untouched, and policy.pageKind stays absent', () => {
  const answers = fervorAnswers(undefined);
  // `choice` is not one of the offered options ('site' | 'app' | 'dashboard' | 'none') —
  // `validateChoiceAnswer` rejects it the same way it would for the spine/skin/family answers.
  answers.pageKind = { type: 'choice', choice: 'sites', confidence: 0.9, probabilities: { site: 0.9 } };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.equal(decision.pageKind, undefined);
  assert.equal(decision.warnings.length, 1);
  assert.equal(decision.warnings[0], 'malformed answer pageKind: choice is not one of the offered options; treated as no answer');
});

// ---------------------------------------------------------------------------
// guide (CS.01): a family sharing its home archetype with `publication` — the family answer
// itself, not the archetype alone, must still pick the right one of the two.
// ---------------------------------------------------------------------------

test('resolveRoute: a one-destination, chapters-and-practical-facts answer set routes to guide, not publication, on the shared CS.01 archetype', () => {
  const answers = {
    spine: choice('CS', { CS: 1 }),
    archetype_CS: choice('CS.01', { 'CS.01': 1, 'CS.02': 0, 'CS.03': 0, none: 0 }),
    family: choice('guide', { guide: 0.82, publication: 0.1, watson: 0.03, fervor: 0.02, wrenfield: 0.02, maben: 0.01, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.deepEqual(decision.family, { id: 'guide', probability: 0.82, basis: 'exact', transfer: 3, viaSpine: 'CS' });
  assert.equal(decision.archetype?.id, 'CS.01');
});

test('resolveRoute: a recurring-title, subscribe-and-archive answer set still routes to publication, not guide, on the same CS.01 archetype (regression guard)', () => {
  const answers = {
    spine: choice('CS', { CS: 1 }),
    archetype_CS: choice('CS.01', { 'CS.01': 1, 'CS.02': 0, 'CS.03': 0, none: 0 }),
    family: choice('publication', { publication: 0.78, guide: 0.12, watson: 0.03, fervor: 0.02, wrenfield: 0.02, none: 0.01 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'publication');
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.archetype?.id, 'CS.01');
});

// ---------------------------------------------------------------------------
// guide (CS.01) never steals another family's own brief — negatives for every family the brief
// names, each shaped like that family's own real archetype and spine. `guide`'s spine (CS) has a
// nonzero atlas transfer FROM `PA` (marketing-site's spine, transfer 2, exactly the
// `DEFAULT_MIN_TRANSFER` floor) — every other spine below transfers at 1, under the floor — so a
// PA-spine case is the one genuine edge here; the rest are excluded by transfer alone, and these
// tests prove that structurally rather than assuming it. `practice` and `storefront` are both
// registered on this branch's registry (practice landed on main ahead of guide's rebuild), so
// their own negatives use the real family ids rather than `none`.
// ---------------------------------------------------------------------------

test('resolveRoute: a practice-shaped (TL.01, clinical/booking) answer set never yields guide', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.01', { 'TL.01': 1, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, none: 0 }),
    family: choice('practice', { practice: 0.55, guide: 0.3, watson: 0.1, wrenfield: 0.05 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'practice');
});

test('resolveRoute: a storefront-shaped (CO.01, buy/preorder catalog) answer set never yields guide', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.5, guide: 0.35, none: 0.15 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'storefront');
});

test('resolveRoute: a maren-shaped (TL.06, made-to-order atelier) answer set never yields guide', () => {
  // maren moved from CO/CO.01 to TL/TL.06 (G7 task f8 root cause (b) — see atlas.ts and
  // eval-v7/G7-DIAGNOSIS.md): a made-to-order maker/atelier brief (no cart, orders by call or
  // email) is a TL "personal expert or portfolio" story, not a CO "move to purchase" one.
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.06', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 1, none: 0 }),
    family: choice('maren', { maren: 0.82, guide: 0.15, none: 0.03 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'maren');
});

test('resolveRoute: a marketing-site-shaped (PA.01, software trial/pricing) answer set never yields guide, even though PA is the one spine with atlas transfer to CS at the floor', () => {
  const answers = {
    spine: choice('PA', { PA: 1 }),
    archetype_PA: choice('PA.01', { 'PA.01': 1, 'PA.02': 0, 'PA.03': 0, none: 0 }),
    family: choice('marketing-site', { 'marketing-site': 0.7, guide: 0.2, 'app-shell': 0.05, none: 0.05 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'marketing-site');
});

test('resolveRoute: a listings-shaped (SM.02, searchable directory) answer set never yields guide', () => {
  const answers = {
    spine: choice('SM', { SM: 1 }),
    archetype_SM: choice('SM.02', { 'SM.01': 0, 'SM.02': 1, none: 0 }),
    family: choice('listings', { listings: 0.78, guide: 0.17, none: 0.05 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'listings');
});

test('resolveRoute: the committed near-miss fixture (Tide & Table, a recurring travel magazine) is loaded and never routes to guide', () => {
  const briefPath = path.join(import.meta.dirname, '../../../plugins/_official/examples/agency-guide/fixtures/near-miss-tide-and-table.txt');
  const brief = readFileSync(briefPath, 'utf8');
  // Confirm this is really the committed near-miss brief before routing it, so the test fails
  // loudly if the fixture is ever replaced with different content.
  assert.match(brief, /bimonthly independent travel and food magazine/);
  assert.match(brief, /not.{0,40}single destination guide/s);
  const answers = {
    spine: choice('CS', { CS: 1 }),
    archetype_CS: choice('CS.01', { 'CS.01': 1, 'CS.02': 0, 'CS.03': 0, none: 0 }),
    family: choice('publication', { publication: 0.75, guide: 0.15, watson: 0.05, fervor: 0.03, wrenfield: 0.02, none: 0 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.notEqual(decision.family?.id, 'guide');
  assert.equal(decision.family?.id, 'publication');
});

// ---------------------------------------------------------------------------
// G7 task f8 fixes — see eval-v7/G7-DIAGNOSIS.md for the reproduced dev/fresh evidence behind
// each of these three mechanisms.
// ---------------------------------------------------------------------------

test('resolveRoute: commerceOwnership gate — a confident inline answer unroutes a requiresExternalBuyStep winner (root cause (a): storefront must abstain when the page itself builds the cart)', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.85, maren: 0.05, 'marketing-site': 0.02, listings: 0.02, none: 0.06 }),
    commerceOwnership: choice('inline', { inline: 0.97, linksOut: 0.02, none: 0.01 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /commerceOwnership inline.*storefront requires an external buy step/);
  assert.ok(decision.warnings.some((w) => w.includes('disqualifies storefront')));
});

test('resolveRoute: commerceOwnership gate — a confident linksOut answer changes nothing (a named platform/processor still fits storefront)', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, maren: 0.05, none: 0.05 }),
    commerceOwnership: choice('linksOut', { linksOut: 0.95, inline: 0.03, none: 0.02 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
});

test('resolveRoute: commerceOwnership gate — an inline answer never touches a winner without requiresExternalBuyStep (e.g. maren, which is already cart-free by design)', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.06', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 1, none: 0 }),
    family: choice('maren', { maren: 0.85, watson: 0.1, none: 0.05 }),
    commerceOwnership: choice('inline', { inline: 0.9, linksOut: 0.05, none: 0.05 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'maren');
});

test('resolveRoute: commerceOwnership gate — an absent answer (older caller / 25-profile corpus) leaves the decision byte-identical', () => {
  const withGate = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, none: 0.1 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(withGate, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
  assert.deepEqual(decision.warnings, []);
});

test('resolveRoute: commerceOwnership gate — a `none` answer (no buying/ordering step described) changes nothing', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, none: 0.1 }),
    commerceOwnership: choice('none', { none: 0.95, linksOut: 0.03, inline: 0.02 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
});

test('resolveRoute: commerceOwnership gate — an inline answer below the 0.5 threshold (0.49) does not disqualify the winner', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, none: 0.1 }),
    commerceOwnership: choice('inline', { inline: 0.49, linksOut: 0.4, none: 0.11 }, 0.49),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
  assert.deepEqual(decision.warnings, []);
});

test('resolveRoute: commerceOwnership gate — a malformed answer degrades to no answer, exactly like pageKind case 5, and never unroutes the brief over it', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, none: 0.1 }),
    commerceOwnership: { type: 'choice', choice: 'somethingElse', confidence: 0.9, probabilities: { linksOut: 0.9 } } as ChoiceAnswer,
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'storefront');
  assert.ok(decision.warnings.some((w) => w.startsWith('malformed answer commerceOwnership')));
});

test('resolveRoute: commerceOwnership gate runs BEFORE the pageKind consistency check — a commerceOwnership unroute leaves nothing routed for pageKind to promote, but pageKind is still recorded', () => {
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.9, none: 0.1 }),
    commerceOwnership: choice('inline', { inline: 0.95, linksOut: 0.03, none: 0.02 }),
    // A confident, AGREEING pageKind answer (storefront's own pageKind is 'site') — proves the
    // gate above already dropped the family before pageKind's own consistency check ever had a
    // routed decision with a family to promote or agree with.
    pageKind: choice('site', { site: 0.95, app: 0.03, dashboard: 0.01, none: 0.01 }, 0.95),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.family, undefined);
  assert.match(decision.reason!, /^commerceOwnership inline/);
  assert.deepEqual(decision.pageKind, { choice: 'site', confidence: 0.95 }, 'pageKind is still recorded even though the decision was already unrouted by commerceOwnership');
});

// ---------------------------------------------------------------------------
// The general exclusion gate (G7 task f8 run-3 re-plan): a SECOND Jev request, scoped to the
// winner's own `excludes` clauses only, sent by `createJevRouter` after `resolveRoute` has
// already picked a winner. `buildExclusionQuestion` builds that request; `applyExclusionAnswer`
// (pure, unit-tested independent of any network call, exactly like `resolveRoute` itself) applies
// its answer. See route.ts's own docblocks for why this is a second request rather than one more
// question bundled into the first fan-out.
// ---------------------------------------------------------------------------

const storefrontEntry: FamilyRegistryEntry = registry.families.find((entry) => entry.family === 'storefront')!;
const routedStorefront = resolveRoute(
  {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('storefront', { storefront: 0.86, none: 0.14 }),
    skin: choice('unspecified', { unspecified: 1 }),
  },
  atlas,
  registry,
);

test('buildExclusionQuestion: one choice question over ONLY the winner\'s own excludes clauses, plus none — never every family\'s at once', () => {
  const request = buildExclusionQuestion('A brief.', storefrontEntry);
  assert.ok(request);
  assert.deepEqual(request.state, { brief: 'A brief.' });
  const criteria = request.questions.exclusion!.criteria;
  assert.equal(Object.keys(criteria).length, storefrontEntry.excludes!.length + 1, 'exactly storefront\'s own clauses plus none — not maren\'s, watson\'s, or any other family\'s');
  for (let i = 0; i < storefrontEntry.excludes!.length; i += 1) {
    assert.equal(criteria[`storefront:${i}`], storefrontEntry.excludes![i]);
  }
  assert.ok('none' in criteria);
  assert.ok(!('maren:0' in criteria), 'a different family\'s clause never appears in this family-scoped question');
});

test('buildExclusionQuestion: undefined for a family with no excludes — createJevRouter must skip the second request entirely', () => {
  const noExcludesEntry: FamilyRegistryEntry = { ...storefrontEntry, family: 'wrenfield', excludes: undefined };
  assert.equal(buildExclusionQuestion('A brief.', noExcludesEntry), undefined);
  const emptyExcludesEntry: FamilyRegistryEntry = { ...storefrontEntry, excludes: [] };
  assert.equal(buildExclusionQuestion('A brief.', emptyExcludesEntry), undefined);
});

test('applyExclusionAnswer: a confident clause hit on the winner unroutes, with reason exclusion:<family>:<index>', () => {
  assert.equal(routedStorefront.decision, 'routed');
  const result = applyExclusionAnswer(routedStorefront, storefrontEntry, choice('storefront:3', { 'storefront:3': 0.9, none: 0.1 }));
  assert.equal(result.decision, 'unrouted');
  assert.equal(result.family, undefined);
  assert.match(result.reason!, /^exclusion:storefront:3:/);
  assert.ok(result.reason!.includes(storefrontEntry.excludes![3]!), 'the reason quotes the clause text verbatim');
  assert.ok(result.warnings.some((w) => w.includes('disqualifies storefront')));
});

test('applyExclusionAnswer: a `none` answer changes nothing', () => {
  const result = applyExclusionAnswer(routedStorefront, storefrontEntry, choice('none', { none: 0.95, 'storefront:3': 0.05 }));
  assert.deepEqual(result, routedStorefront);
});

test('applyExclusionAnswer: a clause hit below the 0.5 threshold (0.49) does not disqualify the winner', () => {
  const result = applyExclusionAnswer(routedStorefront, storefrontEntry, choice('storefront:3', { 'storefront:3': 0.49, none: 0.51 }, 0.49));
  assert.deepEqual(result, routedStorefront);
});

test('applyExclusionAnswer: clause-mass dilution — two clauses at 0.35 each (summing to 0.70, over 0.5) exclude, even though NEITHER alone clears 0.5 (routeexcl-r1 Gemini audit F4)', () => {
  assert.ok(storefrontEntry.excludes!.length >= 2, 'storefront must have at least 2 excludes clauses for this test to be meaningful');
  const result = applyExclusionAnswer(
    routedStorefront,
    storefrontEntry,
    choice('storefront:0', { 'storefront:0': 0.35, 'storefront:3': 0.35, none: 0.3 }, 0.35),
  );
  assert.equal(result.decision, 'unrouted');
  assert.match(result.reason!, /^exclusion:storefront:0:/);
  assert.ok(result.reason!.includes(storefrontEntry.excludes![0]!), 'the reason names the single highest-probability clause among the diluted set');
  assert.ok(result.warnings.some((w) => w.includes('clauses sum to p=0.70')), 'the warning records the summed probability that actually triggered the exclusion');
});

test('applyExclusionAnswer: clause-mass dilution does NOT fire when the clauses sum to under 0.5 — two clauses at 0.2 each (0.40 total) change nothing', () => {
  const result = applyExclusionAnswer(
    routedStorefront,
    storefrontEntry,
    choice('storefront:0', { 'storefront:0': 0.2, 'storefront:3': 0.2, none: 0.6 }, 0.2),
  );
  assert.deepEqual(result, routedStorefront);
});

test('applyExclusionAnswer: a malformed answer fails open to the routed decision, and is logged', () => {
  const malformed = { type: 'choice', choice: 'not-a-real-clause-id', confidence: 0.9, probabilities: { none: 0.9 } } as ChoiceAnswer;
  const result = applyExclusionAnswer(routedStorefront, storefrontEntry, malformed);
  assert.equal(result.decision, 'routed');
  assert.equal(result.family?.id, 'storefront');
  assert.ok(result.warnings.some((w) => w.startsWith('malformed answer exclusion') && w.includes('failing open')));
});

test('excludes: every excludes entry is a verbatim substring of its own family\'s summary', () => {
  for (const entry of registry.families) {
    for (const clause of entry.excludes ?? []) {
      assert.ok(entry.summary.includes(clause), `${entry.family}'s excludes clause is not a substring of its own summary: ${JSON.stringify(clause)}`);
    }
  }
});

test('createJevRouter: a routed family with excludes sends a SECOND request, scoped to only that family\'s clauses, and applies its answer', async () => {
  const captured: Captured[] = [];
  let requestCount = 0;
  const fetchImpl: typeof fetch = (async (input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    captured.push({ url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(new Headers(init?.headers).entries()), body });
    requestCount += 1;
    if (requestCount === 1) {
      // First request: route everything to storefront.
      const answers: Record<string, unknown> = { skin: { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } } };
      answers.spine = { type: 'choice', choice: 'CO', confidence: 1, probabilities: { CO: 1 } };
      answers.archetype_CO = { type: 'choice', choice: 'CO.01', confidence: 1, probabilities: { 'CO.01': 1, none: 0 } };
      answers.family = { type: 'choice', choice: 'storefront', confidence: 0.9, probabilities: { storefront: 0.9, none: 0.1 } };
      for (const spine of atlas.spines) if (spine.code !== 'CO') answers[`archetype_${spine.code}`] = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
      return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 });
    }
    // Second request: the exclusion gate, scoped to storefront alone.
    assert.deepEqual((body.questions as JsonObject).exclusion !== undefined, true, 'the second request asks the exclusion question');
    assert.ok(!('family' in (body.questions as JsonObject)), 'the second request re-asks nothing else — only exclusion');
    return new Response(JSON.stringify({ model: 'jev-test', answers: { exclusion: { type: 'choice', choice: 'storefront:3', confidence: 0.95, probabilities: { 'storefront:3': 0.95, none: 0.05 } } } }), { status: 200 });
  }) as typeof fetch;

  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl });
  const decision = await router.route({ brief: 'An inline-checkout brief.', atlas, registry });

  assert.equal(captured.length, 2, 'exactly two requests: the route fan-out, then the exclusion gate');
  assert.equal(decision.calls, 2);
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^exclusion:storefront:3:/);
});

test('createJevRouter: a family with no excludes (or an unrouted decision) sends exactly one request', async () => {
  const captured: Captured[] = [];
  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl: fakeFetch(captured, allNone) });
  const decision = await router.route({ brief: 'Nothing describable.', atlas, registry });
  assert.equal(captured.length, 1);
  assert.equal(decision.calls, 1);
});

test('createJevRouter: the exclusion gate\'s second request failing (network error) fails open to the routed decision, and is logged', async () => {
  let requestCount = 0;
  const fetchImpl: typeof fetch = (async (input, init) => {
    requestCount += 1;
    if (requestCount === 1) {
      const answers: Record<string, unknown> = { skin: { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } } };
      answers.spine = { type: 'choice', choice: 'CO', confidence: 1, probabilities: { CO: 1 } };
      answers.archetype_CO = { type: 'choice', choice: 'CO.01', confidence: 1, probabilities: { 'CO.01': 1, none: 0 } };
      answers.family = { type: 'choice', choice: 'storefront', confidence: 0.9, probabilities: { storefront: 0.9, none: 0.1 } };
      for (const spine of atlas.spines) if (spine.code !== 'CO') answers[`archetype_${spine.code}`] = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
      return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 });
    }
    throw new TypeError('network unreachable');
  }) as typeof fetch;

  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl });
  const decision = await router.route({ brief: 'An inline-checkout brief.', atlas, registry });
  assert.equal(decision.calls, 2, 'the failed exclusion request still counts — it was sent');
  assert.equal(decision.decision, 'routed', 'a failed exclusion request fails OPEN to the already-routed decision');
  assert.equal(decision.family?.id, 'storefront');
  assert.ok(decision.warnings.some((w) => w.startsWith('exclusion gate request failed, failing open')));
});

test('createJevRouter: the exclusion gate\'s second request failing on a CANCELLED build (options.signal aborted) does NOT fail open — it rethrows, so the vote itself fails rather than silently publishing the stale routed decision', async () => {
  const controller = new AbortController();
  let requestCount = 0;
  const fetchImpl: typeof fetch = (async () => {
    requestCount += 1;
    if (requestCount === 1) {
      const answers: Record<string, unknown> = { skin: { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } } };
      answers.spine = { type: 'choice', choice: 'CO', confidence: 1, probabilities: { CO: 1 } };
      answers.archetype_CO = { type: 'choice', choice: 'CO.01', confidence: 1, probabilities: { 'CO.01': 1, none: 0 } };
      answers.family = { type: 'choice', choice: 'storefront', confidence: 0.9, probabilities: { storefront: 0.9, none: 0.1 } };
      for (const spine of atlas.spines) if (spine.code !== 'CO') answers[`archetype_${spine.code}`] = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
      return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 });
    }
    // The exclusion gate's second request: simulate the caller cancelling the build right as it
    // fails, so `options.signal.aborted` is true by the time the catch block runs.
    controller.abort();
    throw new TypeError('network unreachable');
  }) as typeof fetch;

  const router = createJevRouter({ consensusK: 1, apiKey: 'test-key', fetchImpl, signal: controller.signal });
  const decision = await router.route({ brief: 'An inline-checkout brief.', atlas, registry });
  // The vote itself failed (rethrown, not failed-open) — the consensus wrapper still never
  // throws into the caller (Promise.allSettled), so this resolves `consensus:vote-failed` rather
  // than publishing storefront.
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'consensus:vote-failed');
  assert.notEqual(decision.family?.id, 'storefront', 'a cancelled build must never publish the stale routed decision');
});

// ---------------------------------------------------------------------------
// Variance-aware consensus (G7 task f8 run-3 re-plan §9): `createJevRouter`'s `route()` runs
// `consensusK` (default `DEFAULT_CONSENSUS_K`, 3) full attempts CONCURRENTLY and routes only when
// every one of them picks the SAME family. See route.ts's own docblocks (`JevRouterOptions.
// consensusK`, `route`'s own docblock) for the design.
// ---------------------------------------------------------------------------

/** Builds a fetchImpl that answers a plain `family` fan-out request (no `excludes`, so no second
 * exclusion-gate request follows) deterministically per CALL INDEX — `perCall[callIndex]` is
 * either a family id (routed) or `undefined` (unrouted, family `none`). Each call optionally
 * waits `delayMs` before responding, so a caller can assert concurrency by timing. */
function fanOutSequenceFetch(perCall: Array<string | undefined>, delayMs = 0): typeof fetch {
  let callIndex = 0;
  return (async () => {
    const index = callIndex;
    callIndex += 1;
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const familyChoice = perCall[index];
    const answers: Record<string, unknown> = {
      skin: { type: 'choice', choice: 'unspecified', confidence: 1, probabilities: { unspecified: 1 } },
      spine: { type: 'choice', choice: 'TL', confidence: 1, probabilities: { TL: 1 } },
      archetype_TL: { type: 'choice', choice: 'TL.05', confidence: 1, probabilities: { 'TL.05': 1, none: 0 } },
      family: familyChoice
        ? { type: 'choice', choice: familyChoice, confidence: 0.9, probabilities: { [familyChoice]: 0.9, none: 0.1 } }
        : { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } },
    };
    for (const spine of atlas.spines) if (spine.code !== 'TL') answers[`archetype_${spine.code}`] = { type: 'choice', choice: 'none', confidence: 1, probabilities: { none: 1 } };
    return new Response(JSON.stringify({ model: 'jev-test', answers }), { status: 200 });
  }) as typeof fetch;
}

test('createJevRouter consensus: unanimity (all 3 attempts pick the same family) routes, with 3 votes recorded', async () => {
  const router = createJevRouter({ consensusK: 3, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(['watson', 'watson', 'watson']) });
  const decision = await router.route({ brief: 'A studio brief.', atlas, registry });
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'watson');
  assert.equal(decision.votes?.length, 3);
  assert.ok(decision.votes!.every((vote) => vote.decision === 'routed' && vote.family === 'watson'));
  assert.equal(decision.calls, 3, 'watson has no excludes, so each attempt is exactly one call');
});

test('createJevRouter consensus: a split vote (attempts disagree on the family) unroutes, with reason consensus: … naming each vote', async () => {
  const router = createJevRouter({ consensusK: 3, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(['watson', 'fervor', 'watson']) });
  const decision = await router.route({ brief: 'An ambiguous studio-or-agency brief.', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^consensus:/);
  assert.equal(decision.family, undefined);
  assert.equal(decision.votes?.length, 3);
  assert.deepEqual(decision.votes!.map((vote) => vote.family), ['watson', 'fervor', 'watson']);
});

test('createJevRouter consensus: an unroute in any one of the k attempts unroutes the whole decision, even when the OTHER attempts agree', async () => {
  const router = createJevRouter({ consensusK: 3, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(['watson', 'watson', undefined]) });
  const decision = await router.route({ brief: 'A borderline studio brief.', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.match(decision.reason!, /^consensus:/);
  assert.equal(decision.votes?.length, 3);
  assert.deepEqual(
    decision.votes!.map((vote) => vote.decision),
    ['routed', 'routed', 'unrouted'],
  );
});

test('createJevRouter consensus: the k attempts are sent CONCURRENTLY, not sequentially', async () => {
  const delayMs = 40;
  const k = 3;
  const router = createJevRouter({ consensusK: k, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(Array(k).fill('watson'), delayMs) });
  const startedAt = performance.now();
  await router.route({ brief: 'A studio brief.', atlas, registry });
  const elapsedMs = performance.now() - startedAt;
  // Sequential would take roughly k * delayMs (120ms); concurrent takes roughly one delayMs
  // (40ms) plus overhead. A generous bound well below the sequential total proves concurrency
  // without being flaky under normal test-runner scheduling jitter.
  assert.ok(elapsedMs < delayMs * (k - 0.5), `expected concurrent k=${k} calls to finish well under ${delayMs * k}ms sequential time; took ${elapsedMs.toFixed(1)}ms`);
});

test('createJevRouter consensus: default consensusK is DEFAULT_CONSENSUS_K (3) when unspecified', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = (async (...args) => {
    calls += 1;
    return fanOutSequenceFetch(['watson', 'watson', 'watson'])(...args);
  }) as typeof fetch;
  const router = createJevRouter({ apiKey: 'test-key', fetchImpl });
  await router.route({ brief: 'A studio brief.', atlas, registry });
  assert.equal(calls, DEFAULT_CONSENSUS_K);
});

test('createJevRouter: consensusK must be an integer >= 1 — rejects 0, negative and non-integer values at construction', () => {
  assert.throws(() => createJevRouter({ consensusK: 0, apiKey: 'k' }), RangeError);
  assert.throws(() => createJevRouter({ consensusK: -1, apiKey: 'k' }), RangeError);
  assert.throws(() => createJevRouter({ consensusK: 2.5, apiKey: 'k' }), RangeError);
  assert.doesNotThrow(() => createJevRouter({ consensusK: 1, apiKey: 'k' }));
  assert.doesNotThrow(() => createJevRouter({ consensusK: 5, apiKey: 'k' }));
});

test('createJevRouter consensus: a vote that exceeds voteTimeoutMs counts as a failed vote (consensus:vote-failed) — never throws into route()', async () => {
  const fetchImpl: typeof fetch = (async () => {
    // Never resolves within the test's voteTimeoutMs — simulates a hung request.
    await new Promise(() => {});
    return new Response('unreachable', { status: 200 });
  }) as typeof fetch;
  const router = createJevRouter({ consensusK: 1, voteTimeoutMs: 20, apiKey: 'test-key', fetchImpl });
  const decision = await router.route({ brief: 'A studio brief.', atlas, registry });
  assert.equal(decision.decision, 'unrouted');
  assert.equal(decision.reason, 'consensus:vote-failed');
});

test('createJevRouter: RouteDecision logs consensusK on both an unanimous and a disagreeing decision', async () => {
  const unanimousRouter = createJevRouter({ consensusK: 3, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(['watson', 'watson', 'watson']) });
  const unanimousDecision = await unanimousRouter.route({ brief: 'A studio brief.', atlas, registry });
  assert.equal(unanimousDecision.consensusK, 3);

  const splitRouter = createJevRouter({ consensusK: 3, apiKey: 'test-key', fetchImpl: fanOutSequenceFetch(['watson', 'fervor', 'watson']) });
  const splitDecision = await splitRouter.route({ brief: 'An ambiguous brief.', atlas, registry });
  assert.equal(splitDecision.consensusK, 3);
});

test('resolveRoute: maren now lives on spine TL / archetype TL.06 (root cause (b): a made-to-order maker/atelier brief with no cart is a TL "personal expert or portfolio" story, not a CO one)', () => {
  const marenEntry = registry.families.find((entry) => entry.family === 'maren');
  assert.equal(marenEntry?.spine, 'TL');
  assert.equal(marenEntry?.archetype, 'TL.06');
  // CO -> TL transfer is 1 (below minTransfer 2 by default), so a CO-spine brief never reaches
  // maren any more — the exact mismatch that made maren unroutable when 5/5 dev maren briefs
  // spine-classified as TL, never CO.
  const answers = {
    spine: choice('CO', { CO: 1 }),
    archetype_CO: choice('CO.01', { 'CO.01': 1, none: 0 }),
    family: choice('maren', { maren: 0.9, storefront: 0.05, none: 0.05 }),
    skin: choice('unspecified', { unspecified: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.ok(!decision.candidates.some((c) => c.family === 'maren'), 'maren is unreachable from spine CO now that its home spine is TL');
});

test('resolveRoute: maren\'s TL.06 archetype match is sameSpineOnly — it never claims exact, so a higher-probability watson pick on a confident TL.06 photographer brief is NOT beaten by basis inside the 0.02 tie window (routefix-r1 Grok audit, FIX finding: TL.06 is the atlas\'s shared general-portfolio archetype, not maren\'s alone)', () => {
  const marenEntry = registry.families.find((entry) => entry.family === 'maren');
  assert.equal(marenEntry?.sameSpineOnly, true);
  // A photographer/freelancer brief that confidently reads TL.06 ("Personal expert or
  // portfolio") but whose family vote actually favours watson (a text-forward studio statement),
  // not maren (a made-to-order atelier) — watson at 0.55 vs. maren at 0.54, within TIE_EPSILON
  // (0.02). Before this fix, maren's `exact` TL.06 ownership would have beaten watson's
  // `same-spine` basis purely on basis rank, publishing an atelier page over the family
  // question's own (near-)preference. Both are now same-spine, so probability alone decides.
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.06', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0.02, 'TL.06': 0.98, none: 0 }),
    family: choice('watson', { watson: 0.55, maren: 0.54, fervor: 0.05, wrenfield: 0, maben: 0, none: 0 }),
    skin: choice('Editorial', { Editorial: 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  const watsonCandidate = decision.candidates.find((c) => c.family === 'watson');
  const marenCandidate = decision.candidates.find((c) => c.family === 'maren');
  assert.equal(watsonCandidate?.basis, 'same-spine');
  assert.equal(marenCandidate?.basis, 'same-spine', 'maren no longer claims exact on TL.06');
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'watson', 'with both same-spine, the higher family probability (watson 0.55) wins the tie, not maren\'s old exact-basis privilege');
});

test('resolveRoute: requiresExactArchetype (fervor) never falls back to a same-spine or compatible-spine basis (root cause (c): a content-free stub with archetype_TL: none still won fervor on tag-word matching alone)', () => {
  const answers = {
    // No content beyond visual/motion tags and a generic vertical — the archetype question itself
    // finds nothing to match (archetype_TL: none), the same shape reproduced on scroll-landing.
    spine: choice('TL', { TL: 0.8, BA: 0.1, none: 0.05 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    family: choice('fervor', { fervor: 0.65, watson: 0.02, wrenfield: 0, none: 0.05 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.ok(!decision.candidates.some((c) => c.family === 'fervor'), 'fervor is excluded outright, not merely outranked, when it has no exact archetype match');
  assert.equal(decision.decision, 'unrouted');
});

test('resolveRoute: requiresExactArchetype (fervor) excludes a technically-matching but low-confidence archetype answer too (model variance reproduced on scroll-landing: the same content-free stub answered archetype_TL: TL.05 at confidence 0.38-0.41 on some runs, none on others)', () => {
  const answers = {
    spine: choice('TL', { TL: 0.8, BA: 0.1, none: 0.05 }),
    archetype_TL: choice('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0.4, 'TL.06': 0, none: 0.02 }, 0.4),
    family: choice('fervor', { fervor: 0.66, watson: 0.02, none: 0.05 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.ok(!decision.candidates.some((c) => c.family === 'fervor'), 'a matching but low-confidence (< threshold) archetype answer does not count as a confident signal');
  assert.equal(decision.decision, 'unrouted');
});

test('resolveRoute: requiresExactArchetype (fervor) never reaches a compatible-spine basis either (routefix-r1 Grok audit, FIX finding: the original guard only fired when entry.spine === spineCode, so a qualifying runner-up spine — BA, whose transfer into TL is 3, or PA, whose transfer into TL is 2 — still fell through to the compatible branch regardless of archetype_TL)', () => {
  const answersBA = {
    // BA clears the default 0.25 spineShare alongside TL, so it becomes a qualifying spine too.
    spine: choice('TL', { TL: 0.7, BA: 0.25, PA: 0.05 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    family: choice('fervor', { fervor: 0.65, watson: 0.02, halcyon: 0.02, none: 0.05 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decisionBA = resolveRoute(answersBA, atlas, registry);
  assert.deepEqual(
    decisionBA.spines.map((s) => s.code).sort(),
    ['BA', 'TL'],
    'BA clears spineShare and becomes a qualifying (candidate-gathering) spine',
  );
  assert.ok(!decisionBA.candidates.some((c) => c.family === 'fervor'), 'fervor must not be admitted via BA -> TL compatible transfer (3) when archetype_TL found nothing');
  assert.equal(decisionBA.decision, 'unrouted');

  const answersPA = {
    spine: choice('TL', { TL: 0.7, PA: 0.25, BA: 0.05 }),
    archetype_TL: choice('none', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0, 'TL.06': 0, none: 1 }),
    family: choice('fervor', { fervor: 0.65, watson: 0.02, 'marketing-site': 0.02, none: 0.05 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decisionPA = resolveRoute(answersPA, atlas, registry);
  assert.deepEqual(
    decisionPA.spines.map((s) => s.code).sort(),
    ['PA', 'TL'],
    'PA clears spineShare and becomes a qualifying (candidate-gathering) spine',
  );
  assert.ok(!decisionPA.candidates.some((c) => c.family === 'fervor'), 'fervor must not be admitted via PA -> TL compatible transfer (2, exactly minTransfer) when archetype_TL found nothing');
  assert.equal(decisionPA.decision, 'unrouted');
});

test('resolveRoute: requiresExactArchetype (fervor) still reaches same-spine (not exact) on a confident but non-matching archetype answer (route-corpus-25.json\'s 3d-jack-portfolio-hero: archetype_TL answered TL.06 at 0.96 while family still correctly picked fervor)', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.06', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 0.04, 'TL.06': 0.96, none: 0 }),
    family: choice('fervor', { fervor: 0.81, watson: 0.17, none: 0.01 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.equal(decision.family?.basis, 'same-spine');
});

test('resolveRoute: requiresExactArchetype (fervor) still wins normally on an exact TL.05 archetype match', () => {
  const answers = {
    spine: choice('TL', { TL: 1 }),
    archetype_TL: choice('TL.05', { 'TL.01': 0, 'TL.02': 0, 'TL.03': 0, 'TL.04': 0, 'TL.05': 1, 'TL.06': 0, none: 0 }),
    family: choice('fervor', { fervor: 0.9, watson: 0.05, none: 0.05 }),
    skin: choice('Cinematic and immersive', { 'Cinematic and immersive': 1 }),
  };
  const decision = resolveRoute(answers, atlas, registry);
  assert.equal(decision.decision, 'routed');
  assert.equal(decision.family?.id, 'fervor');
  assert.equal(decision.family?.basis, 'exact');
});
