/**
 * `resolveRoute` over 25 REAL Jev answers (tests/fixtures/route-corpus-25.json, re-captured from
 * the catalog references on 2026-09-23 against the 13-family registry by
 * `evals/genui/8-route-eval.mjs`). Not a coverage target — the corpus has no museum, remodeler,
 * design-build or charity brief, so those families are legitimately unreachable here; the scored
 * coverage run is the eval itself. It proves the
 * policy's contract on real data: every routed pick is legal for a considered spine and at or
 * above the threshold; every unrouted decision carries a reason and has no candidate the policy
 * should have accepted; and the whole thing is deterministic.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { loadAtlasData } from './routing-fixture.ts';
import { legalSpinesForFamily, resolveRoute, DEFAULT_MIN_TRANSFER, type ChoiceAnswer } from '../src/route.ts';

type Stored = { choice: string; confidence: number; probabilities: Record<string, number> };
type Profile = { spine: Stored; skin: Stored; family: Stored; archetype?: Stored & { spine: string } };

const THRESHOLD = 0.5;
const { atlas, registry } = await loadAtlasData();
const corpus = JSON.parse(readFileSync(path.join(import.meta.dirname, 'fixtures', 'route-corpus-25.json'), 'utf8')) as { profiles: Record<string, Profile> };
const entries = Object.entries(corpus.profiles);

function answersOf(profile: Profile): Record<string, ChoiceAnswer> {
  const choice = (s: Stored): ChoiceAnswer => ({ type: 'choice', choice: s.choice, confidence: s.confidence, probabilities: s.probabilities });
  const answers: Record<string, ChoiceAnswer> = { spine: choice(profile.spine), skin: choice(profile.skin), family: choice(profile.family) };
  if (profile.archetype) answers[`archetype_${profile.archetype.spine}`] = choice(profile.archetype);
  return answers;
}

test('the corpus is the full 25 and every profile carries the three required answers', () => {
  assert.equal(entries.length, 25);
  for (const [, profile] of entries) for (const key of ['spine', 'skin', 'family'] as const) assert.ok(profile[key], key);
});

test('every routed pick is a legal family for a considered spine, at or above the threshold', () => {
  const legal = new Map(registry.families.map((entry) => [entry.family, new Set(legalSpinesForFamily(entry, atlas, DEFAULT_MIN_TRANSFER).map((spine) => spine.code))]));
  let routed = 0;
  for (const [name, profile] of entries) {
    const policy = resolveRoute(answersOf(profile), atlas, registry);
    if (policy.decision !== 'routed') continue;
    routed += 1;
    assert.ok(policy.family, name);
    assert.ok(policy.family.probability >= THRESHOLD, `${name}: ${policy.family.id} at ${policy.family.probability}`);
    const considered = policy.spines.map((spine) => spine.code);
    assert.ok(considered.some((code) => legal.get(policy.family!.id)?.has(code)), `${name}: ${policy.family.id} is not legal from ${considered.join(',')}`);
    const top = policy.candidates[0];
    assert.ok(top && top.family === policy.family.id, `${name}: routed ${policy.family.id} but top candidate is ${top?.family}`);
  }
  // Was 15 before ownedmaker moved from spine CO/archetype CO.01 to spine TL/archetype TL.06 (G7 task
  // f8 root cause (b) — see atlas.ts and eval-v7/G7-DIAGNOSIS.md). This corpus's own
  // `prompt-hero` profile (a fashion/ecommerce brief, spine CO, archetype CO.01) had captured a
  // real Jev family answer that put ownedmaker ABOVE storefront/ownedinstitution at the time this corpus was
  // recorded — itself an instance of the exact CO.01 ownedmaker/storefront ambiguity the spine move
  // fixes. With ownedmaker no longer reachable from CO, that profile is honestly unrouted (ownedinstitution at
  // p=0.10, well below threshold) instead of landing on a family it was never meant to reach.
  assert.ok(routed >= 14, `expected the 14 known routed profiles, got ${routed}`);
});

test('every unrouted decision has a reason and no candidate the policy should have taken', () => {
  for (const [name, profile] of entries) {
    const policy = resolveRoute(answersOf(profile), atlas, registry);
    if (policy.decision !== 'unrouted') continue;
    assert.equal(policy.family, undefined, name);
    assert.ok(policy.reason && policy.reason.length > 0, `${name}: no reason`);
    for (const candidate of policy.candidates) assert.ok(candidate.probability < THRESHOLD, `${name}: ${candidate.family} at ${candidate.probability} was left unrouted`);
    if (profile.spine.choice === 'none') assert.deepEqual(policy.candidates, [], `${name}: candidates gathered without a spine`);
  }
});

test('the policy is deterministic on real answers', () => {
  for (const [name, profile] of entries) {
    const a = resolveRoute(answersOf(profile), atlas, registry);
    const b = resolveRoute(answersOf(profile), atlas, registry);
    assert.deepEqual(a, b, name);
  }
});
