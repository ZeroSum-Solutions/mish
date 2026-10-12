/**
 * The ROUTE step: one Jev (TypeSafe System One) request classifies a client brief against the
 * Website Shape Atlas — a speculative fan-out (`docs.typesafe.ai/patterns/fan-out.md`) over
 * `spine`, one `archetype_<CODE>` per spine, `family` and `skin` — and `resolveRoute` turns the
 * answers into a bundled family package to build with, or `unrouted`.
 *
 * Jev decides what the brief looks like; this file owns the policy for what to build from that:
 * exact archetype match beats same-spine beats compatible-spine (>= `minTransfer`), ranked by
 * Jev's own family probability, gated by `threshold`. Fails closed: a spine Jev can't place, or a
 * top pick below `threshold`, is `unrouted` — never a guess. See
 * `docs/plans/2026-09-19-spine-router-design.md` for the full design.
 *
 * Request shape (endpoint, auth, model, timeout, lazy cached apiKey, fetchImpl injection) mirrors
 * `jev.ts` exactly. Unlike `jev.ts`'s advisory faithfulness gate, routing is a decision: a
 * non-2xx response or a network failure both throw rather than reporting `skipped`. Every answer
 * value `resolveRoute` actually uses is runtime-validated before it is trusted, the same way
 * `jev.ts` checks `typeof answer.noul === 'number'` rather than trusting its own `JevResponseBody`
 * cast — a `JSON.parse` cast claims a shape the network never actually guarantees, and Jev is a
 * model, not a schema-checked API. A malformed `spine`, `family` or `skin` answer resolves to
 * `unrouted` (never a throw); a malformed `archetype_<CODE>` answer degrades to `none` for that
 * spine and is recorded in `warnings`, since one bad archetype answer alone should not stop a
 * routable brief from routing.
 */

import type { Archetype, FamilyRegistry, FamilyRegistryEntry, PageKind, ShapeAtlas, Spine } from './atlas.ts';
import { jevErrorMessage, jevRequestSignal, resolveJevKey } from './jev.ts';
import { isObject } from './spine.ts';

export type { PageKind } from './atlas.ts';

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type ChoiceAnswer = { type: 'choice'; choice: string; confidence: number; probabilities: Record<string, number> };

/** One-line descriptions for the atlas's 12 skin names — the atlas gives names only. */
export const SKIN_DESCRIPTIONS: Record<string, string> = {
  'Minimal and quiet': 'Restrained type and whitespace, few colors, little ornament; confidence through simplicity.',
  'Corporate and institutional': 'Formal, structured, credentialed; built to read as established and accountable.',
  Editorial: 'Text-forward, expressive typography, magazine-like flow; the writing carries the page.',
  Luxury: 'Generous space, refined type, restrained color and imagery; scarcity and craft over volume.',
  'Playful and illustrative': 'Bright color, custom illustration, rounded shapes; friendly and approachable.',
  'Technical and utilitarian': 'Dense, precise, monospace accents; built for people who want the spec, not the pitch.',
  'Catalog and grid-led': 'Uniform grids of items with consistent cards; built for browsing many similar things.',
  'Cinematic and immersive': 'Full-bleed motion and imagery, scroll-linked staging; mood before detail.',
  'Heritage and craft': 'Warm materials, real photography, hand-made texture; provenance and workmanship on display.',
  'Data-dense': 'Tables, charts and dashboards; information density over decoration.',
  Conversational: 'Chat-like, first-person, informal voice; feels like a dialog, not a brochure.',
  Experimental: 'Unconventional layout or interaction; distinctiveness over convention.',
};

/**
 * A spine's criterion for the `spine` Choice question: the atlas's own intent, order and final
 * action, plus the spine's archetypes by name with their first keywords. The spine question never
 * sees the archetype questions (all are asked in one fan-out), so without the examples a brief can
 * only be matched on the intent line — a documentation site read "complete a technical task" as
 * TU (Task utility) although the atlas files documentation under CS (CS.02).
 */
export function spineCriterion(spine: Spine, archetypes: readonly Archetype[]): string {
  const examples = archetypes
    .filter((archetype) => archetype.spine === spine.code)
    .map((archetype) => `${archetype.name} (${archetype.keywords.slice(0, 5).join(', ')})`);
  const tail = examples.length > 0 ? ` Examples: ${examples.join('; ')}.` : '';
  return `${spine.name} (${spine.kind}): ${spine.intent} Order: ${spine.steps.join(' → ')}. Final action: ${spine.ctas.join(', ')}.${tail}`;
}

function archetypeCriterion(archetype: Archetype): string {
  return `${archetype.name}: ${archetype.intent} Order: ${archetype.steps.join(' → ')}. Sections: ${archetype.sections.join(', ')}. Final action: ${archetype.primaryCta}. Typical: ${archetype.keywords.join(', ')}.`;
}

/**
 * Every spine `resolveRoute`'s own `basisAgainstSpine` would accept this family from: its own
 * spine (`same-spine`, always legal regardless of transfer) plus every OTHER spine whose
 * `atlas.compatibility` transfer to it is at least `minTransfer` (`compatible`) — i.e. exactly the
 * candidate-gathering legality `resolveRoute` applies, computed here so the family question can
 * state it instead of leaving Jev to guess it. `compatibility` is symmetric (`loadAtlasData`
 * validates this), so reading `atlas.compatibility[entry.spine]` mirrors `basisAgainstSpine`'s own
 * `atlas.compatibility[spineCode]?.[entry.spine]` lookup either direction round.
 */
export function legalSpinesForFamily(entry: FamilyRegistryEntry, atlas: ShapeAtlas, minTransfer: number): Spine[] {
  const ownRow = atlas.compatibility[entry.spine] ?? {};
  return atlas.spines.filter((spine) => spine.code === entry.spine || (ownRow[spine.code] ?? 0) >= minTransfer);
}

/**
 * A family's criterion text for the `family` Choice question. `spine` and `family` are answered
 * in the SAME simultaneous fan-out request (`buildRouteQuestions`/`buildProfileQuestions` build
 * every question from the atlas/registry alone, before any Jev call), so a family criterion is the
 * only place that can tell Jev which decision sequences this family can actually be routed from —
 * `resolveRoute`'s own candidate-gathering legality (`legalSpinesForFamily`), not just its own
 * spine. Without that, family probability has no reason to track spine legality: a family that
 * absorbed most of the probability mass on a brief whose spine `resolveRoute` will never admit it
 * from leaves the truly reachable families starved below `threshold` — see e.g. a CS-spine brief
 * (spine.probabilities.CS = 0.93) whose family answer still put fervor (spine TL; CS is not in
 * TL's legal set) at p = 0.93: that mass was never spendable, and the CS-legal family (emmpo, via
 * CS -> LM transfer 2) was left with almost none. Naming every legal spine, not only the family's
 * own, also fixes the opposite miscalibration a same-only wording produced: it read a legally
 * *compatible* spine (e.g. PA for a TL family, transfer 2) as disqualifying, pushing Jev to answer
 * `none` even when `resolveRoute` would have accepted the family from PA.
 *
 * Exported so `profile-questions.ts` reuses this verbatim instead of a second, driftable copy of
 * the same string-building logic — the exact risk its former docblock flagged when it hand-rolled
 * one.
 */
export function familyCriterion(entry: FamilyRegistryEntry, archetypesById: ReadonlyMap<string, Archetype>, legalSpines: readonly Spine[]): string {
  // `legalSpinesForFamily` always includes `entry.spine` itself (its filter's first disjunct is
  // `spine.code === entry.spine`), and `validateFamilyRegistry` (`atlas.ts`) already refuses to
  // load a registry whose entry.spine isn't a real atlas spine code before any question is ever
  // built — so `legalSpines` is empty only if a caller hand-built `legalSpines` incorrectly, never
  // for a real registry entry. Asserting here, instead of silently dropping the legality sentence,
  // keeps that failure loud: the whole point of this function is that a family criterion always
  // states its legality gate, and a family question missing that gate is exactly the original bug.
  if (legalSpines.length === 0) {
    throw new Error(`familyCriterion: family ${entry.family} has no legal spines — its own spine "${entry.spine}" must be one of them; check legalSpinesForFamily's inputs`);
  }
  const decisionSequenceList = legalSpines.map((spine) => `${spine.name} (${spine.intent})`).join('; or ');
  const decisionSequence = ` Fits ONLY a business whose own decision sequence is one of these: ${decisionSequenceList}. If the brief's decision sequence is something else, this family does not fit, however similar the visuals or business type look.`;
  // A family with more than one home archetype (`archetypes`, beyond the primary `archetype`)
  // names every one of them here — a family criterion mentioning only its primary archetype would
  // read, to the classifier, as a worse fit for a brief the router already scored under one of its
  // OTHER home archetypes, even though the family's own summary describes exactly that business.
  const archetypeIds = [entry.archetype, ...(entry.archetypes ?? [])];
  const archetypeList = archetypeIds.map((id) => `${id} ${archetypesById.get(id)?.name ?? '?'}`).join(', ');
  const archetypeLabel = archetypeIds.length > 1 ? 'archetypes' : 'archetype';
  return `${entry.summary}${decisionSequence} (${archetypeLabel} ${archetypeList}; skin: ${entry.skin}).`;
}

/** A clause id is `<family>:<index into entry.excludes>` — stable across a registry's lifetime as
 * long as `excludes` entries are appended rather than reordered, and never persisted anywhere
 * beyond one route decision's `reason`/`warnings` strings, so a reorder is harmless. */
export function exclusionClauseId(family: string, index: number): string {
  return `${family}:${index}`;
}

/**
 * The SECOND Jev request (G7 task f8 run-3 re-plan, general exclusion gate): asked only AFTER
 * `resolveRoute` has already picked a winner, and scoped to ONLY that winner's own `excludes`
 * clauses — never every family's at once. This was tried first as one more question bundled into
 * the SAME fan-out request, across every family's clauses at once (18 unrelated options for a
 * single brief); live DEV traces showed the model's answer spreading thin across many barely-
 * related clauses (e.g. p=0.18-0.26 split across 6+ options, `none` narrowly "winning" over the
 * one clause that actually fit) — too diffuse to trust. Asking about only the ONE family that
 * already won turns it back into a focused two- or three-way choice, which is what this function
 * builds. Returns `undefined` when the winner has no `excludes` at all, so `createJevRouter`
 * skips the second request entirely rather than spend it on a family with no self-exclusions to
 * check — that keeps every OTHER family's route byte-identical (one Jev call, same as before this
 * gate existed).
 */
export function buildExclusionQuestion(brief: string, entry: FamilyRegistryEntry): { state: { brief: string }; questions: Record<string, ChoiceQuestion> } | undefined {
  const clauses = entry.excludes;
  if (!clauses || clauses.length === 0) return undefined;
  const criteria: Record<string, string> = {};
  clauses.forEach((clause, index) => {
    criteria[exclusionClauseId(entry.family, index)] = clause;
  });
  criteria.none = `brief does not actually describe any of the excluded cases above — ${entry.family} still fits.`;
  return {
    state: { brief },
    questions: {
      exclusion: {
        type: 'choice',
        instructions:
          `\`brief\` was just routed to the "${entry.family}" family. ${entry.family}'s own criteria state some "not X" / abstain exclusion sentences — quoted VERBATIM below. Read \`brief\` again, on its own: does it actually describe the excluded case in ONE of these sentences, even though ${entry.family} otherwise looked like the best fit? Choose that sentence's id, or \`none\` if brief matches none of them.`,
        criteria,
      },
    },
  };
}

/**
 * Applies one `exclusion` answer (from `buildExclusionQuestion`'s request) to an already-decided
 * `policy`. Pure and unit-tested independent of any Jev call, exactly like `resolveRoute` itself —
 * `createJevRouter` is the only caller that actually issues the second request; every other caller
 * (tests, `--replay`) can call this directly with a hand-built answer. A malformed answer FAILS
 * OPEN to `policy` unchanged (never unroutes over a broken check) and is logged in `warnings`,
 * the same discipline `resolveRoute`'s own malformed-answer branches use. `none`, or a SUMMED
 * probability across every one of this family's own clauses below `DEFAULT_THRESHOLD`, also
 * leaves `policy` unchanged (see the clause-mass dilution note inline below). A confident hit
 * unroutes with reason `exclusion:<family>:<index>: <clause text>` — naming the single
 * highest-probability clause even when the trigger was the combined mass — never retried
 * (`shouldRetryRoute`).
 */
export function applyExclusionAnswer(policy: RoutePolicy, entry: FamilyRegistryEntry, answer: unknown): RoutePolicy {
  const clauseIds = (entry.excludes ?? []).map((_, index) => exclusionClauseId(entry.family, index));
  const choices = new Set<string>(['none', ...clauseIds]);
  const validation = validateChoiceAnswer(answer, choices);
  if ('reason' in validation) {
    return { ...policy, warnings: [...policy.warnings, `malformed answer exclusion: ${validation.reason}; treated as no answer (failing open)`] };
  }
  const exclusionAnswer = validation.answer;
  // Read PER-CLAUSE probabilities directly from `probabilities`, not the model's separately
  // self-reported top-choice `confidence` scalar. Live DEV traces (see eval-v7/G7-DIAGNOSIS.md
  // §7 for a worked one) showed a genuinely close call between a clause and `none` reported as
  // `choice: 'none'` at a near-zero `confidence` even while `probabilities` itself carried the
  // real, evenly-split signal — `confidence` appears to be the model's own margin/certainty
  // between its top two options, which collapses near a genuine tie, while `probabilities` is the
  // calibrated distribution the "confidence" the plan asked for actually lives in. `resolveRoute`'s
  // OTHER gates (`commerceOwnership`, `pageKind`) still read `.confidence` for consistency with
  // the rest of the codebase; this gate is intentionally different because unlike those two (a
  // single, usually-clear-cut question), a "does the brief trigger THIS specific abstain clause"
  // judgment is routinely a close call by nature — these are near-miss briefs.
  //
  // Clause-mass dilution (routeexcl-r1 Gemini audit, F4): a family with MULTIPLE `excludes`
  // clauses can genuinely be excluded by the brief matching more than one of them PARTIALLY —
  // e.g. two clauses each at 0.35 — without any SINGLE clause individually reaching the 0.5 bar,
  // even though together they carry a majority of the answer's probability mass (`none` itself is
  // then necessarily <= 0.5, since probabilities sum to 1). Requiring one clause alone to clear
  // 0.5 would miss this and under-trigger for exactly the multi-clause families (storefront,
  // guide) that most need the gate. The trigger is therefore the SUMMED probability across every
  // one of this family's own clauses, not any single clause's own probability; the reported
  // clause (in `reason`/`warnings`) is still the single highest-probability one, since that is
  // the clearest evidence to show, even when the trigger came from the combined mass.
  let bestClauseId: string | undefined;
  let bestProbability = 0;
  let summedProbability = 0;
  for (const clauseId of clauseIds) {
    const probability = exclusionAnswer.probabilities[clauseId] ?? 0;
    summedProbability += probability;
    if (probability > bestProbability) {
      bestProbability = probability;
      bestClauseId = clauseId;
    }
  }
  if (!bestClauseId || summedProbability < DEFAULT_THRESHOLD) return policy;
  const clauseIndex = Number(bestClauseId.slice(bestClauseId.indexOf(':') + 1));
  const clauseText = entry.excludes?.[clauseIndex] ?? '(clause text unavailable)';
  const warnings = [
    ...policy.warnings,
    `exclusion ${bestClauseId} at p=${bestProbability.toFixed(2)} (clauses sum to p=${summedProbability.toFixed(2)}) disqualifies ${entry.family}: "${clauseText}"`,
  ];
  const { family: _droppedFamily, ...withoutFamily } = policy;
  return {
    ...withoutFamily,
    decision: 'unrouted',
    warnings,
    reason: `exclusion:${bestClauseId}: ${clauseText}`,
  };
}

/**
 * The one Jev request's `state` and `questions`, built fresh from the atlas and registry every
 * call: `state` carries only `{ brief }` — never a recipe, an asset id, or a destination.
 *
 * `minTransfer` must be the SAME value the eventual `resolveRoute(..., { minTransfer })` call for
 * this same route uses (it defaults to `DEFAULT_MIN_TRANSFER`, matching `resolveRoute`'s own
 * default): the family criteria this builds state exactly which spines `basisAgainstSpine` would
 * accept each family from, so a caller that widens or narrows `minTransfer` at resolve time without
 * passing the same value here would have Jev answer a family question whose legality gate no
 * longer matches the policy that later reads its answer — the request would describe a rule
 * `resolveRoute` isn't actually enforcing, or fail to describe one it is. `createJevRouter` always
 * threads its own `input.minTransfer` through to keep the two in lockstep.
 */
export function buildRouteQuestions(
  brief: string,
  atlas: ShapeAtlas,
  registry: FamilyRegistry,
  minTransfer: number = DEFAULT_MIN_TRANSFER,
): { state: { brief: string }; questions: Record<string, ChoiceQuestion> } {
  const archetypesById = new Map(atlas.archetypes.map((archetype) => [archetype.id, archetype]));
  const questions: Record<string, ChoiceQuestion> = {};

  const spineCriteria: Record<string, string> = {};
  for (const spine of atlas.spines) spineCriteria[spine.code] = spineCriterion(spine, atlas.archetypes);
  spineCriteria.none = 'brief does not describe a website, or gives too little to place it on any spine.';
  questions.spine = {
    type: 'choice',
    instructions: 'Which website spine (decision sequence) best fits the site `brief` describes? Judge by what the visitor must decide and by the final action, not by industry words alone.',
    criteria: spineCriteria,
  };

  for (const spine of atlas.spines) {
    const criteria: Record<string, string> = {};
    for (const archetype of atlas.archetypes) {
      if (archetype.spine === spine.code) criteria[archetype.id] = archetypeCriterion(archetype);
    }
    criteria.none = 'No archetype of this spine fits.';
    questions[`archetype_${spine.code}`] = {
      type: 'choice',
      instructions: `Assume \`brief\` describes a ${spine.name} site (${spine.intent}). Which archetype fits it best?`,
      criteria,
    };
  }

  const familyCriteria: Record<string, string> = {};
  for (const entry of registry.families) {
    familyCriteria[entry.family] = familyCriterion(entry, archetypesById, legalSpinesForFamily(entry, atlas, minTransfer));
  }
  familyCriteria.none = 'No bundled family fits this brief.';
  questions.family = {
    type: 'choice',
    instructions:
      "Which bundled family package best fits the business and website `brief` describes? First rule out any family whose criterion lists decision sequences that do not include the brief's own decision sequence (what the visitor must decide, and their final action — the same thing the spine question judges) — that family cannot be routed to, however similar its visuals or business type look. Among the families left, judge business type, page purpose and visual register.",
    criteria: familyCriteria,
  };

  const skinCriteria: Record<string, string> = {};
  for (const skin of atlas.skins) skinCriteria[skin] = SKIN_DESCRIPTIONS[skin] ?? skin;
  skinCriteria.unspecified = 'brief gives no visual direction.';
  questions.skin = {
    type: 'choice',
    instructions: 'Which visual skin does `brief` ask for or imply, from its tone, brand words and audience?',
    criteria: skinCriteria,
  };

  // The thirteenth question: what KIND of page `brief` wants, independent of spine, archetype and
  // family. `resolveRoute` uses this answer only as a consistency check on the family pick those
  // other questions already made — see its own docblock for the four cases.
  // The fourteenth question: for a brief that describes buying or ordering something, who builds
  // the actual cart, checkout or payment step? A family criterion can SAY "abstain if this page
  // must build the cart inline" (storefront's own summary does), but that exclusion sits inside a
  // long, mostly-affirmative paragraph and loses to the paragraph's own stronger, earlier
  // affirmative match — G7 task f8 root cause (a): a brief that explicitly asks for its own
  // in-page "add to cart" step (no external shop/checkout to link to) still routed to storefront
  // at p=0.57-0.9 on 5 of 5 reproduced dev/fresh cases. `resolveRoute`'s `commerceOwnership` gate
  // below reads this answer directly, the same way its `pageKind` gate already does, instead of
  // leaving the exclusion to compete for attention inside prose. See eval-v7/G7-DIAGNOSIS.md.
  // Criteria text tightened 2026-09-27 (routefix-r1 Grok audit, BLOCK finding): the original
  // wording let a NAMED wallet or processor (Apple Pay, Stripe, PayPal) pull the answer to
  // `linksOut` even when the brief puts the cart/bundle/payment MECHANIC itself on this page. The
  // distinction is mechanic-on-this-page vs. named-separate-destination, not merely whether a
  // payment brand is mentioned.
  //
  // Criteria text REWORKED 2026-09-27, run-3 re-plan (§8), replacing the first (reverted)
  // attempt that simply inverted the default. That inversion over-corrected: a bare "does the
  // brief mention ANY on-page detail" test cannot separate a shop that hands the whole
  // transaction to a named third-party PLATFORM from one that builds it itself, because a real
  // shop always has product pages, shipping info and a payment step either way — those details
  // alone say nothing about who builds them.
  //
  // The actual discriminator: WHO builds and owns the transaction, judged in three tiers, not
  // one. (1) A FULL-STACK commerce PLATFORM — a complete hosted-storefront system, or a
  // marketplace — that owns the whole transaction and supplies its own cart/checkout/bundle/
  // shipping features settles `linksOut` regardless of which of ITS OWN features the brief also
  // lists (those are the platform's features, not evidence this page builds them); a platform
  // name used only as a STYLE or aesthetic reference (not the actual system running the shop)
  // does not count as naming one. (2) A HOSTED PAYMENT DESTINATION — a specific checkout or
  // payment page, or a payment link, that the visitor is actually SENT TO in order to pay — is
  // ALSO `linksOut`, even when the brief lists on-page product/variant browsing beforehand: the
  // test is whether the PAYMENT step itself happens on a page the visitor leaves this page for,
  // not whether anything earlier in the flow (choosing a size, a color, a pack) happens here.
  // Redirecting the visitor for a moment to complete a purchase does not become this page's own
  // build merely because the earlier browsing steps are. (3) A bare PAYMENT PROCESSOR or method
  // (a card network, a digital wallet, a processor named only as what a checkout accepts, with no
  // redirect or hosted destination described) says nothing by itself about who builds the
  // surrounding mechanic, so it stays `linksOut` by default UNLESS the brief also describes a
  // CONCRETE on-page mechanic beyond the bare payment step itself: a chosen product option/
  // variant, a computed (not flat-stated) shipping cost, an order-customization field, combining
  // multiple items into one purchase, computed bundle or discount pricing, or a subscription/
  // recurring setup — any of those flips the answer to `inline`, since they describe a custom
  // on-page build using the processor only as an invisible backend, not a hosted checkout product
  // or destination. See eval-v7/G7-DIAGNOSIS.md §8 for the DEV traces that motivated this
  // distinction and its validation; that document, not this file, is where any brief-specific
  // wording belongs.
  questions.commerceOwnership = {
    type: 'choice',
    instructions:
      'If `brief` describes buying, ordering or checking out, who actually builds and owns that step — a named third-party commerce platform this page hands off to, or this page itself (even if a payment processor runs underneath)? A platform NAME and a payment-processor NAME are different kinds of evidence — read the "linksOut" and "inline" criteria carefully for how each is judged.',
    criteria: {
      linksOut: 'ANY of: (1) `brief` names a FULL-STACK, hosted commerce PLATFORM or storefront system (a complete hosted-commerce product, or a marketplace) as what ACTUALLY RUNS the shop — that platform supplies its own cart, checkout, bundle-pricing and shipping features, so naming it settles `linksOut` even when the brief ALSO lists features that platform provides (bundle discounts, a shipping calculator, a progress bar, gift options) — those are the platform\'s own features, not evidence this page builds them. A platform name used ONLY as a STYLE or aesthetic reference (describing a LOOK the page should imitate, not which system actually runs the shop) does NOT count here — treat it as if no platform were named at all and judge by (2)-(4) and by `inline` instead — (2) `brief` names a HOSTED PAYMENT DESTINATION — a specific checkout or payment page, or a payment link, that the visitor is SENT TO in order to actually pay (a payment provider\'s own hosted checkout page, a generated payment link). This is `linksOut` even when the brief ALSO lists product options, variants, or pack sizes: those describe what the visitor picks BEFORE being sent to pay, not who renders the payment step. The test is whether the visitor leaves THIS page\'s own checkout flow to complete payment, not whether the destination is styled to match this page — (3) `brief` names only a BARE payment processor or method (a card network, a digital wallet, a processor named only as what a checkout accepts, with no redirect or hosted destination described) with NO OTHER concrete on-page commerce mechanic described beyond the basic buy/checkout step itself — OR (4) the buy step is only a phone number or email, with no online checkout described at all. Choose linksOut by DEFAULT whenever none of (1)/(2) is named AND no `inline`-criterion mechanic is also described.',
      inline: 'EITHER (1) `brief` names NO commerce platform, hosted payment destination, or payment processor/method at all, describing this page\'s own purchase flow with nothing to link out to — OR (2) `brief` names only a bare payment processor or method used PURELY AS AN INVISIBLE BACKEND for a checkout THIS PAGE renders itself — never a redirect or a hosted destination the visitor is sent to (that is `linksOut`\'s case (2), regardless of what else is described) — AND ALSO describes at least one CONCRETE on-page commerce mechanic beyond the bare payment step: choosing a product OPTION/VARIANT — a different physical version of the SAME item (size, color, material) — as part of buying (NOT the same thing as choosing among PRICING OR ORDER TIERS for otherwise-identical goods, which alone is not a qualifying mechanic), a shipping cost that is COMPUTED (not merely a flat rate stated as a fact), an order-customization field at checkout (adding a note, engraving, or personalization), combining several items into one purchase, a price or discount computed for that combination, or setting up a subscription/recurring purchase. A bare processor/payment-method name with NONE of those extra mechanics described, OR any hosted/redirect destination at all, is NOT enough for inline — that stays linksOut.',
      none: 'brief describes no buying, ordering or checkout step at all.',
    },
  };

  questions.pageKind = {
    type: 'choice',
    instructions:
      'Separate from spine and family: what KIND of page does `brief` want? Judge by what the page is FOR, not by its visual style or its industry.',
    criteria: {
      site: 'a public page that presents and sells something: services, a product, a practice, a cause.',
      app: 'the working screen of a tool people sign in to: navigation, lists, details, settings; no selling.',
      dashboard: 'a screen of numbers and status for one team: KPIs, a table of work in flight, activity, one chart.',
      none: 'brief gives too little to tell.',
    },
  };

  return { state: { brief }, questions };
}

export type RouteBasis = 'exact' | 'same-spine' | 'compatible';
/** `viaSpine` is the qualifying spine (see `spineShare`) that produced this candidate's basis —
 * usually the routed spine itself, but can be a runner-up spine when the spine call is spread and
 * a family only reaches (or reaches more strongly) through that runner-up. */
export type RouteCandidate = { family: string; probability: number; basis: string; transfer: number; archetype: string; skin: string; viaSpine: string };
/** `viaSpine` is the winning candidate's own `viaSpine`: the spine the family was admitted from,
 * which differs from `spine.code` when the family reached through a runner-up spine. `resolveRoute`
 * always sets it; it is optional only so a decision recorded before the field existed still reads. */
export type RouteFamilyPick = { id: string; probability: number; basis: RouteBasis; transfer: number; viaSpine?: string };

/** `resolveRoute`'s output before the caller adds call metadata (`ms`, `calls`, `model`, `usage`). */
export type RoutePolicy = {
  decision: 'routed' | 'unrouted';
  reason?: string;
  spine: { code: string; name: string; confidence: number; probabilities: Record<string, number> };
  /** The routed spine (`spine.choice`) plus every runner-up spine at or above `spineShare` of the
   * `spine` answer's probability mass — the spines candidate-gathering actually considered,
   * highest probability first. The routed spine is always included here regardless of its own
   * share of the mass; `spineShare` only gates *additional* runner-up spines. Empty when the
   * spine answer is `none`, or when a required answer was too malformed to route at all (see
   * `reason`) — in either case candidate-gathering never ran. */
  spines: Array<{ code: string; probability: number }>;
  archetype?: { id: string; name: string; confidence: number };
  skin: { choice: string; confidence: number };
  family?: RouteFamilyPick;
  /** The `pageKind` answer, when one was given — absent entirely for an older caller (or the
   * 25-profile corpus) that never asked the question. Recorded even when it changed nothing (a
   * `none` choice, or a confidence below `DEFAULT_THRESHOLD`); see `resolveRoute`'s docblock for
   * the four cases. */
  pageKind?: { choice: PageKind | 'none'; confidence: number };
  candidates: RouteCandidate[];
  /** Non-fatal problems `resolveRoute` worked around rather than failing on — currently only a
   * malformed `archetype_<CODE>` answer, degraded to `none` for that one spine. Empty when
   * nothing was ignored. */
  warnings: string[];
};

/** `ms`, `calls`, `model` and `usage` describe the Jev request(s) that produced the decision.
 * `calls` is 1 normally, or 2 when `resolveRoute` routed to a family with its own `excludes` and
 * `createJevRouter` therefore sent the exclusion gate's second request (G7 task f8 run-3
 * re-plan) — counted even when that second request failed and the gate failed open, the same way
 * a failed `routeBuild` retry still counts toward `routeAttempts` below. `ms` and `usage` cover
 * both requests when `calls` is 2. Since the consensus wrapper (`CONSENSUS_K`, same task) runs
 * several full route attempts concurrently, `calls` on the TOP-LEVEL decision it returns is the
 * SUM of every attempt's own `calls` (so up to `2 * k`), not `1 | 2` — a single `singleAttempt`
 * result (used internally, and by any caller that bypasses consensus) still reports `1 | 2`.
 * `routeAttempts` is a SEPARATE count: how many routing requests `routeBuild` SENT at its own
 * layer — 1, or 2 after the one bounded retry (see `shouldRetryRoute`) — also when that retry
 * failed on the network and the first refusal stands. A decision straight from a router has no
 * `routeAttempts`. `votes` and `consensusK` are present only on a consensus decision (see
 * `RouteVote`'s docblock); absent for a bare `singleAttempt` result. `consensusK` logs how many
 * votes the decision was computed from (the "k" of the ask), and `calls`/`usage` together are the
 * cost record — the total requests and tokens spent across every successful vote (a failed vote
 * spent no tokens `route()` can see, so it contributes 0 to both). */
export type RouteDecision = RoutePolicy & {
  ms: number;
  calls: number;
  model: string;
  usage?: { input_tokens: number; output_tokens: number };
  routeAttempts?: number;
  votes?: RouteVote[];
  consensusK?: number;
};

/**
 * One consensus member's outcome, recorded on the top-level `RouteDecision.votes` so an eval
 * answer (or any other caller) can see what the `CONSENSUS_K` attempts individually decided, not
 * only the final consensus verdict. `family` is present only for a `routed` vote; `reason` is
 * present only for an `unrouted` vote (mirrors `RoutePolicy.family`/`RoutePolicy.reason`). A vote
 * that failed outright (a network error, or the per-vote timeout — see `voteTimeoutMs`) is
 * recorded as `{ decision: 'unrouted', reason: 'consensus:vote-failed' }`: it counts as a
 * non-agreeing vote, exactly like an ordinary refusal, and never throws `route()` itself.
 */
export type RouteVote = { decision: 'routed' | 'unrouted'; family?: string; reason?: string };

export type ResolveOptions = { threshold?: number; minTransfer?: number; spineShare?: number };

const DEFAULT_THRESHOLD = 0.5;
/** Also the legality bar `familyCriterion`'s `legalSpinesForFamily` uses to build the family
 * question, so the request Jev sees and the policy `resolveRoute` applies afterwards agree on
 * exactly the same bar — a lower `minTransfer` passed to `resolveRoute` at request time would
 * accept a spine the question told Jev was illegal, and vice versa. Exported so the request-side
 * caller (`buildRouteQuestions`, `buildProfileQuestions`) can reuse the same constant `resolveRoute`
 * defaults to, rather than a second hardcoded `2`. */
export const DEFAULT_MIN_TRANSFER = 2;
/** A spine needs at least this share of the `spine` answer's probability mass to be considered
 * for candidate-gathering alongside the top spine — the fix for a brief whose spine call is
 * genuinely spread (e.g. a maker-studio brief splitting between "trust the maker" and "buy the
 * piece"), where the family Jev actually favours sits on the runner-up spine. */
const DEFAULT_SPINE_SHARE = 0.25;
/** Two probabilities this close are a tie, broken by basis and then by skin (section 5 of the design doc). */
const TIE_EPSILON = 0.02;

function basisRank(basis: RouteBasis): number {
  return basis === 'exact' ? 0 : basis === 'same-spine' ? 1 : 2;
}

/** A family's basis and transfer against one particular spine, or `undefined` when that spine
 * gives the family no path at all (different spine, and below `minTransfer`). */
function basisAgainstSpine(
  entry: FamilyRegistryEntry,
  spineCode: string,
  archetypeChoice: string | undefined,
  archetypeConfidence: number,
  atlas: ShapeAtlas,
  minTransfer: number,
): { basis: RouteBasis; transfer: number } | undefined {
  const transfer = atlas.compatibility[spineCode]?.[entry.spine] ?? 0;
  // `sameSpineOnly` (maren) never claims `exact` — see its own docblock in atlas.ts for why (G7
  // task f8 root cause (b)/(d)): TL.06 is a shared general-portfolio archetype, not maren's alone.
  const exactMatch = !entry.sameSpineOnly && archetypeChoice !== undefined && (entry.archetype === archetypeChoice || entry.archetypes?.includes(archetypeChoice));
  // `requiresExactArchetype` (fervor) never reaches `compatible` at all, on ANY spine — not just
  // its own (routefix-r1 Grok audit, FIX finding: the original guard only fired when
  // `entry.spine === spineCode`, so a runner-up spine at or above `spineShare` — e.g. BA or PA,
  // whose transfer into TL is 2 or 3, both >= `minTransfer` — still fell through to the
  // `compatible` branch below regardless of what `archetype_TL` answered, readmitting fervor on a
  // content-free brief exactly like scroll-landing through the back door). It also never falls
  // back to same-spine on its own spine unless that spine's OWN archetype question found
  // SOMETHING with real confidence — undefined (`none`, or a malformed answer degraded to `none`)
  // or a confidence below `DEFAULT_THRESHOLD` both count as "found nothing", including a
  // technically-matching TL.05 answer Jev itself was not confident about (the exact source of
  // model variance reproduced on scroll-landing: the same content-free stub answered
  // `archetype_TL: none` most runs but `TL.05` at confidence 0.38-0.41 on others — a low-
  // confidence "match" is not a real signal either). See atlas.ts's own docblock for why (G7 task
  // f8 root cause (c)). A real, CONFIDENT but non-matching archetype answer on this family's OWN
  // spine (e.g. TL.06 at 0.96 when fervor's own archetype is TL.05) still reaches same-spine
  // normally: Jev did find something plausible on this spine, which is a materially different
  // signal from finding nothing/nothing-confident, and real captured answers do legitimately
  // split this way (route-corpus-25.json's 3d-jack-portfolio-hero: archetype_TL answered TL.06 at
  // 0.96 while the family question still confidently and correctly picked fervor at 0.81 — this
  // case must keep routing). An exact match reached via a RUNNER-UP spine (this family's own
  // archetype confirmed from a different qualifying spine) still counts as `exact`, same as any
  // other family — only the `compatible`/unconfirmed-same-spine fallback is disallowed.
  if (entry.requiresExactArchetype) {
    // The confidence gate applies to EVERY basis this family can reach, exact included: a
    // technically-matching archetype answer Jev itself was not confident about (e.g. TL.05 at
    // 0.4, the exact scroll-landing model-variance shape) is not a real signal either, and must
    // not short-circuit past the gate just because the string happens to match.
    const hasConfidentArchetype = archetypeChoice !== undefined && archetypeConfidence >= DEFAULT_THRESHOLD;
    if (!hasConfidentArchetype) return undefined;
    if (exactMatch) return { basis: 'exact', transfer };
    return entry.spine === spineCode ? { basis: 'same-spine', transfer } : undefined;
  }
  if (exactMatch) return { basis: 'exact', transfer };
  if (entry.spine === spineCode) return { basis: 'same-spine', transfer };
  if (transfer >= minTransfer) return { basis: 'compatible', transfer };
  return undefined;
}

/**
 * Runtime-validates one Jev Choice answer before it is trusted: `type` is `"choice"`, `choice` is
 * one of the options this question actually offered, `confidence` and every `probabilities`
 * value are finite numbers in [0, 1]. `answers: Record<string, ChoiceAnswer>` is what the response
 * body is cast to at the network boundary (`createJevRouter`'s `JSON.parse(text) as
 * JevResponseBody`) — a cast, not a check, exactly like `jev.ts`'s own `JevResponseBody` cast. This
 * is the check underneath it, mirroring `jev.ts`'s `typeof answer.noul === 'number'` habit for
 * Choice's larger shape (a string `choice`, an options-membership check, and a `probabilities`
 * map, instead of one number).
 */
export function validateChoiceAnswer(value: unknown, validChoices: ReadonlySet<string>): { answer: ChoiceAnswer } | { reason: string } {
  if (!isObject(value)) return { reason: 'missing or not an object' };
  if (value.type !== 'choice') return { reason: 'type is not "choice"' };
  if (typeof value.choice !== 'string' || !validChoices.has(value.choice)) return { reason: 'choice is not one of the offered options' };
  if (typeof value.confidence !== 'number' || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) {
    return { reason: 'confidence is not a finite number in [0, 1]' };
  }
  if (!isObject(value.probabilities)) return { reason: 'probabilities is missing or not an object' };
  for (const [option, probability] of Object.entries(value.probabilities)) {
    if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      return { reason: `probabilities.${option} is not a finite number in [0, 1]` };
    }
  }
  return { answer: value as unknown as ChoiceAnswer };
}

/** Returned when the `spine` answer itself is too malformed to build a real `spine` field from. */
const FALLBACK_SPINE = { code: 'none', name: 'none', confidence: 0, probabilities: {} };
/** Returned when the `skin` answer itself is too malformed to build a real `skin` field from. */
const FALLBACK_SKIN = { choice: 'unspecified', confidence: 0 };

/** `spine`'s reported shape, built the same way whether `spine.choice` is a real spine or `none`. */
function spineResultOf(spineAnswer: ChoiceAnswer, atlas: ShapeAtlas): RoutePolicy['spine'] {
  const spine = atlas.spines.find((candidate) => candidate.code === spineAnswer.choice);
  return { code: spineAnswer.choice, name: spine?.name ?? spineAnswer.choice, confidence: spineAnswer.confidence, probabilities: spineAnswer.probabilities };
}

/**
 * The candidate set and their ranking — the policy itself, pure and unit-tested independent of
 * any Jev call. Every registry family is checked against the routed spine and archetype in
 * priority order (exact archetype > same spine > compatible spine), ranked by Jev's own family
 * probability, ties broken by basis then by skin match.
 * New features must not depend on Jev's raw `confidence` field: the Oct 2026
 * audit returned 1.0 on all 20 cases, including hard tiebreakers. Keep this
 * policy's family-probability `threshold` and legality checks as the route gate.
 *
 * The `pageKind` answer (spec §4 "one more choice question") is applied last, as a consistency
 * CHECK on the family pick above — never a second routing signal of its own. Five cases:
 *  1. No `pageKind` key in `answers` at all (an older caller, or the 25-profile corpus, that has
 *     never heard of the question) — the decision is untouched and `pageKind` stays absent.
 *  2. An answer is present but its choice is `none`, or its confidence is below
 *     `DEFAULT_THRESHOLD` — recorded on the policy, but the decision is untouched: Jev itself was
 *     not confident enough to police the family pick.
 *  3. A confident answer whose choice matches the winning family's own `pageKind`
 *     (`family-registry.json`) — recorded, decision untouched.
 *  4. A confident answer that DISAGREES with the winning family's `pageKind` — the highest-
 *     probability candidate whose own `pageKind` matches is picked instead, if its probability is
 *     still at or above `threshold`; otherwise the brief becomes `unrouted` rather than publish
 *     the wrong shape of page. Either way a warning is recorded.
 *  5. A `pageKind` key is present but too malformed to trust (fails `validateChoiceAnswer`) — a
 *     warning is recorded and `pageKind` is left absent from the policy, exactly as if case 1 had
 *     applied; the decision is untouched. Unlike a malformed `spine`/`skin`/`family` answer (which
 *     unroutes the whole brief, since those are load-bearing), a malformed `pageKind` degrades to
 *     "no answer" — the question is a check on an already-made decision, not a precondition for
 *     making one, so there is nothing here worth failing the brief over.
 */
export function resolveRoute(answers: Record<string, ChoiceAnswer>, atlas: ShapeAtlas, registry: FamilyRegistry, options: ResolveOptions = {}): RoutePolicy {
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;
  const minTransfer = options.minTransfer ?? DEFAULT_MIN_TRANSFER;
  const spineShare = options.spineShare ?? DEFAULT_SPINE_SHARE;

  const spineChoices = new Set<string>(['none', ...atlas.spines.map((s) => s.code)]);
  const spineValidation = validateChoiceAnswer(answers.spine, spineChoices);
  if ('reason' in spineValidation) {
    return { decision: 'unrouted', reason: `malformed answer spine: ${spineValidation.reason}`, spine: FALLBACK_SPINE, spines: [], skin: FALLBACK_SKIN, candidates: [], warnings: [] };
  }
  const spineAnswer = spineValidation.answer;

  const skinChoices = new Set<string>(['unspecified', ...atlas.skins]);
  const skinValidation = validateChoiceAnswer(answers.skin, skinChoices);
  if ('reason' in skinValidation) {
    return { decision: 'unrouted', reason: `malformed answer skin: ${skinValidation.reason}`, spine: spineResultOf(spineAnswer, atlas), spines: [], skin: FALLBACK_SKIN, candidates: [], warnings: [] };
  }
  const skin = { choice: skinValidation.answer.choice, confidence: skinValidation.answer.confidence };

  if (spineAnswer.choice === 'none') {
    return { decision: 'unrouted', reason: 'no spine', spine: spineResultOf(spineAnswer, atlas), spines: [], skin, candidates: [], warnings: [] };
  }

  const spineResult = spineResultOf(spineAnswer, atlas);

  // A spread spine call (e.g. a maker-studio brief splitting between two plausible spines) must
  // not silently exclude every family on the runner-up spine: every spine carrying at least
  // `spineShare` of the answer's own probability mass is considered too. The routed spine itself
  // is ALWAYS included regardless of its own share — `spineShare` only gates additional runner-up
  // spines — since otherwise a spine call spread thin across many options (e.g. p=0.22 across 9)
  // would drop the very spine Jev actually picked.
  const qualifyingSpines = [
    { code: spineAnswer.choice, probability: spineAnswer.probabilities[spineAnswer.choice] ?? spineAnswer.confidence },
    ...Object.entries(spineAnswer.probabilities)
      .filter(([code, probability]) => code !== 'none' && code !== spineAnswer.choice && probability >= spineShare)
      .map(([code, probability]) => ({ code, probability })),
  ].sort((a, b) => b.probability - a.probability);

  // Every qualifying spine's own archetype_<CODE> answer, validated once and reused both for the
  // reported top-spine archetype and for every family's basis check below. A malformed answer
  // degrades to "no archetype fits this spine" rather than failing the whole route.
  const warnings: string[] = [];
  const archetypeBySpine = new Map<string, { choice: string | undefined; confidence: number }>();
  for (const { code } of qualifyingSpines) {
    const validChoices = new Set<string>(['none', ...atlas.archetypes.filter((a) => a.spine === code).map((a) => a.id)]);
    const validation = validateChoiceAnswer(answers[`archetype_${code}`], validChoices);
    if ('reason' in validation) {
      warnings.push(`archetype_${code}: ${validation.reason} — treated as none`);
      archetypeBySpine.set(code, { choice: undefined, confidence: 0 });
    } else {
      archetypeBySpine.set(code, { choice: validation.answer.choice === 'none' ? undefined : validation.answer.choice, confidence: validation.answer.confidence });
    }
  }

  const topArchetype = archetypeBySpine.get(spineAnswer.choice)!;
  const archetypeChoice = topArchetype.choice;
  const archetype = archetypeChoice ? atlas.archetypes.find((candidate) => candidate.id === archetypeChoice) : undefined;
  const archetypeResult = archetypeChoice ? { id: archetypeChoice, name: archetype?.name ?? archetypeChoice, confidence: topArchetype.confidence } : undefined;

  const familyChoices = new Set<string>(['none', ...registry.families.map((f) => f.family)]);
  const familyValidation = validateChoiceAnswer(answers.family, familyChoices);
  if ('reason' in familyValidation) {
    return {
      decision: 'unrouted',
      reason: `malformed answer family: ${familyValidation.reason}`,
      spine: spineResult,
      spines: qualifyingSpines,
      archetype: archetypeResult,
      skin,
      candidates: [],
      warnings,
    };
  }
  const familyProbabilities = familyValidation.answer.probabilities;

  const candidates: RouteCandidate[] = [];
  for (const entry of registry.families) {
    // Each qualifying spine may reach this family differently (its own archetype answer, its own
    // matrix transfer); keep whichever gives the family the best basis, highest transfer as the
    // tie-break between spines that land on the same basis tier.
    let best: { basis: RouteBasis; transfer: number; viaSpine: string } | undefined;
    for (const { code: spineCode } of qualifyingSpines) {
      const spineArchetypeChoice = archetypeBySpine.get(spineCode)?.choice;
      const spineArchetypeConfidence = archetypeBySpine.get(spineCode)?.confidence ?? 0;
      const result = basisAgainstSpine(entry, spineCode, spineArchetypeChoice, spineArchetypeConfidence, atlas, minTransfer);
      if (!result) continue;
      const better = !best || basisRank(result.basis) < basisRank(best.basis) || (basisRank(result.basis) === basisRank(best.basis) && result.transfer > best.transfer);
      if (better) best = { ...result, viaSpine: spineCode };
    }
    if (!best) continue;
    candidates.push({ family: entry.family, probability: familyProbabilities[entry.family] ?? 0, basis: best.basis, transfer: best.transfer, archetype: entry.archetype, skin: entry.skin, viaSpine: best.viaSpine });
  }

  candidates.sort((a, b) => {
    if (Math.abs(a.probability - b.probability) > TIE_EPSILON) return b.probability - a.probability;
    const basisDiff = basisRank(a.basis as RouteBasis) - basisRank(b.basis as RouteBasis);
    if (basisDiff !== 0) return basisDiff;
    const aSkinMatch = a.skin === skin.choice ? 0 : 1;
    const bSkinMatch = b.skin === skin.choice ? 0 : 1;
    return aSkinMatch - bSkinMatch;
  });

  const base: RoutePolicy = { decision: 'unrouted', spine: spineResult, spines: qualifyingSpines, archetype: archetypeResult, skin, candidates, warnings };

  const winner = candidates[0];
  let result: RoutePolicy;
  if (!winner) {
    result = { ...base, reason: `no bundled family within transfer >= ${minTransfer} of spine ${spineAnswer.choice}` };
  } else if (winner.probability < threshold) {
    result = { ...base, reason: `family ${winner.family} at p=${winner.probability.toFixed(2)} below ${threshold}` };
  } else {
    result = { ...base, decision: 'routed', family: { id: winner.family, probability: winner.probability, basis: winner.basis as RouteBasis, transfer: winner.transfer, viaSpine: winner.viaSpine } };
  }

  // The commerceOwnership gate: a structural check on a routed `requiresExternalBuyStep` family
  // (storefront), mirroring the pageKind consistency check just below. A confident `inline`
  // answer means the brief asks THIS page to build its own cart/checkout/payment form, with no
  // separate existing buy step to link to — exactly the case storefront's own summary already
  // says to abstain on. Left as prose alone, that exclusion competes for attention against the
  // rest of storefront's much longer, mostly-affirmative summary and loses (G7 task f8 root cause
  // (a): 5/5 reproduced dev/fresh cases still picked storefront at p=0.57-0.9). Reading the answer
  // directly, the same way pageKind is read directly, does not depend on Jev re-deriving the
  // exclusion from prose. An absent or malformed answer (an older caller, or a corpus that never
  // asked the question) leaves `result` untouched, same as pageKind case 1/5.
  if (answers.commerceOwnership !== undefined && result.decision === 'routed' && result.family) {
    const commerceValidation = validateChoiceAnswer(answers.commerceOwnership, new Set(['linksOut', 'inline', 'none']));
    if ('reason' in commerceValidation) {
      warnings.push(`malformed answer commerceOwnership: ${commerceValidation.reason}; treated as no answer`);
    } else {
      const commerceAnswer = commerceValidation.answer;
      const winnerEntry = registry.families.find((entry) => entry.family === result.family!.id);
      if (commerceAnswer.choice === 'inline' && commerceAnswer.confidence >= DEFAULT_THRESHOLD && winnerEntry?.requiresExternalBuyStep) {
        warnings.push(`commerceOwnership inline at p=${commerceAnswer.confidence.toFixed(2)} disqualifies ${result.family.id} (requires an external buy step to link to)`);
        const { family: _droppedFamily, ...withoutFamily } = result;
        result = {
          ...withoutFamily,
          decision: 'unrouted',
          reason: `commerceOwnership inline at p=${commerceAnswer.confidence.toFixed(2)}: ${result.family.id} requires an external buy step to link to`,
        };
      }
    }
  }

  // The pageKind consistency check — see this function's docblock for the five cases. An absent
  // key (case 1) leaves `result` untouched entirely, so an older caller sees byte-identical output.
  if (answers.pageKind !== undefined) {
    const pageKindValidation = validateChoiceAnswer(answers.pageKind, new Set(['site', 'app', 'dashboard', 'none']));
    if ('reason' in pageKindValidation) {
      // Case 5: degrade to "no answer", same as case 1 — never unroute the brief over a
      // malformed CHECK on a decision the load-bearing questions already made.
      warnings.push(`malformed answer pageKind: ${pageKindValidation.reason}; treated as no answer`);
    } else {
      const pageKindAnswer = pageKindValidation.answer;
      const pageKind = { choice: pageKindAnswer.choice as PageKind | 'none', confidence: pageKindAnswer.confidence };
      result = { ...result, pageKind };

      // Cases 3 and 4 only apply on top of an already-routed decision: a confident pageKind
      // answer has nothing to check against when there was no winning family to begin with.
      // `DEFAULT_THRESHOLD` here is deliberately NOT `threshold` (the plan's own wording): the
      // pageKind confidence gate is fixed, not caller-tunable the way the family `threshold`
      // two lines below is — a caller that widens `threshold` to route more briefs must not
      // also loosen how confident Jev has to be before pageKind is allowed to police that pick.
      if (pageKind.choice !== 'none' && pageKind.confidence >= DEFAULT_THRESHOLD && result.decision === 'routed' && result.family) {
        const winnerPageKind = registry.families.find((entry) => entry.family === result.family!.id)?.pageKind;
        if (winnerPageKind !== pageKind.choice) {
          warnings.push(`page kind ${pageKind.choice} disagrees with family ${result.family.id} (${winnerPageKind})`);
          // `candidates` is already sorted highest-probability first, so the first match here IS
          // the highest-probability candidate whose own pageKind agrees.
          const rerouted = candidates.find(
            (candidate) => candidate.probability >= threshold && registry.families.find((entry) => entry.family === candidate.family)?.pageKind === pageKind.choice,
          );
          if (rerouted) {
            result = { ...result, decision: 'routed', family: { id: rerouted.family, probability: rerouted.probability, basis: rerouted.basis as RouteBasis, transfer: rerouted.transfer, viaSpine: rerouted.viaSpine } };
          } else {
            const { family: _droppedFamily, ...withoutFamily } = result;
            result = {
              ...withoutFamily,
              decision: 'unrouted',
              reason: `page kind ${pageKind.choice} at p=${pageKind.confidence.toFixed(2)} has no bundled family at or above ${threshold}`,
            };
          }
        }
      }
    }
  }

  // The general exclusion gate (G7 task f8 run-3 re-plan) is NOT applied here: unlike
  // commerceOwnership and pageKind, it depends on knowing which family actually won before its
  // own question can even be built (see `buildExclusionQuestion`'s docblock for why a single
  // all-families question, asked in the same request, tested too diffuse on live DEV traces).
  // `createJevRouter` issues a SECOND request once this function has returned a routed decision,
  // then applies its answer via the separate pure `applyExclusionAnswer`.

  return result;
}

/**
 * Whether an unrouted decision is worth ONE more routing request: Jev placed the brief on a spine
 * with confidence at or above the admission bar, yet no family reached `threshold` there (no
 * candidate, a family below the bar, or a page-kind check that left none). The same brief routes
 * on another request often enough (ladder run 3: CO refused once, admitted twice) that this is
 * model variance, not an honest "no fit". A spine answered `none`, a spine below the bar, or a
 * malformed answer is a refusal a retry should not argue with. The decision rests on the top
 * spine answer alone: `spines` (the runner-ups considered) plays no part. The bar itself never moves: the
 * retry is re-asked, never re-graded.
 *
 * A `commerceOwnership`-gated unroute is ALSO never retried (routefix-r1 Grok audit, FIX
 * finding): that gate is a DECISION ("this page must build the cart itself, so abstain"), not a
 * refusal to place the brief on a spine — a retry that lands on `linksOut`, or on `inline` at a
 * lower confidence that no longer clears `DEFAULT_THRESHOLD`, would publish exactly the family
 * the first request correctly declined. `routeBuild` (build.ts) always adopts whichever response
 * this function says to keep asking for, so treating the gate's own reason as retry-worthy would
 * let one flaky second answer overturn a structural abstain the eval runner's single `route()`
 * call would never see fail. See eval-v7/G7-DIAGNOSIS.md.
 *
 * The general `exclusion` gate (G7 task f8 run-3 re-plan) is never retried for the identical
 * reason: `exclusion:<family>:<index>` is also a DECISION ("brief describes the case this
 * family's own summary already says to abstain on"), not a refusal to place the brief on a
 * spine, so the same flaky-retry-overturns-a-structural-abstain risk applies.
 */
export function shouldRetryRoute(policy: RoutePolicy): boolean {
  return policy.decision === 'unrouted'
    && policy.spine.code !== 'none'
    && policy.spine.confidence >= DEFAULT_THRESHOLD
    && !(policy.reason ?? '').startsWith('malformed')
    && !(policy.reason ?? '').startsWith('commerceOwnership')
    && !(policy.reason ?? '').startsWith('exclusion:');
}

export class RouteError extends Error {}

export type JevRouterOptions = {
  apiKey: string | (() => Promise<string>);
  fetchImpl?: typeof fetch;
  model?: string;
  timeoutMs?: number;
  endpoint?: string;
  /** Cancels a routing request in flight. Combined with this router's own timeout, never
   * replacing it, so a cancelled build stops waiting on Jev at once. */
  signal?: AbortSignal;
  /**
   * How many independent, CONCURRENT full route attempts (fan-out request + `resolveRoute` +
   * the exclusion gate's own second request) `route()` runs before deciding — variance-aware
   * consensus (G7 task f8 run-3 re-plan §9). The key finding motivating this: identical repeated
   * calls on the same near-miss brief moved the deciding probability across the 0.5 line run to
   * run (see `G7-DIAGNOSIS.md` §7 for a worked trace), so the remaining illegal picks after the
   * exclusion gate are largely VARIANCE, not missing logic. `route()` only returns a `routed`
   * decision when all `consensusK` attempts agree on the exact same family; any disagreement, any
   * attempt landing `unrouted`, or any attempt FAILING (a network error, a timeout — see
   * `voteTimeoutMs`) returns `unrouted` with reason `consensus: …`. A failed vote never rejects
   * `route()` itself: it is recorded as a `consensus:vote-failed` vote and counted as
   * non-agreeing, the same as an ordinary disagreement — `route()` uses `Promise.allSettled`
   * over the `consensusK` attempts, not `Promise.all`, specifically so one failed vote cannot
   * throw the whole build. Defaults to `DEFAULT_CONSENSUS_K` (3). `1` disables consensus (a
   * single attempt always "agrees with itself"), which is how `singleAttempt`-only callers
   * effectively behaved before this option existed — except a `consensusK: 1` vote that fails now
   * also resolves to `unrouted` (`consensus:vote-failed`) rather than throwing, for the same
   * "never throw into the build" reason.
   */
  consensusK?: number;
  /**
   * Per-VOTE timeout (one `singleAttempt` — up to two sequential Jev requests when the exclusion
   * gate's second request runs) — separate from `timeoutMs`, which bounds each individual
   * request. Without this, one vote could take up to `2 * timeoutMs` before either of its two
   * requests gives up, while the other `consensusK - 1` votes may have long since settled.
   * Defaults to `2 * timeoutMs` (covers the worst case of two full-length individual requests). A
   * vote that exceeds this is treated exactly like any other failed vote (see `consensusK`):
   * recorded, never thrown.
   */
  voteTimeoutMs?: number;
};

export type RouteInput = { brief: string; atlas: ShapeAtlas; registry: FamilyRegistry; threshold?: number; minTransfer?: number; spineShare?: number };

export type JevRouter = { route: (input: RouteInput) => Promise<RouteDecision> };

const DEFAULT_MODEL = 'jev-1.13.0';
const DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const DEFAULT_TIMEOUT_MS = 15_000;
/** Default `JevRouterOptions.consensusK` — see that field's own docblock. */
export const DEFAULT_CONSENSUS_K = 3;

type JevResponseBody = { model: string; answers: Record<string, ChoiceAnswer>; usage?: { input_tokens: number; output_tokens: number } };

function sumUsage(
  a: { input_tokens: number; output_tokens: number } | undefined,
  b: { input_tokens: number; output_tokens: number } | undefined,
): { input_tokens: number; output_tokens: number } | undefined {
  if (!a) return b;
  if (!b) return a;
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

export function createJevRouter(options: JevRouterOptions): JevRouter {
  const fetchImpl = options.fetchImpl ?? fetch;
  const model = options.model ?? DEFAULT_MODEL;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const consensusK = options.consensusK ?? DEFAULT_CONSENSUS_K;
  if (!Number.isInteger(consensusK) || consensusK < 1) {
    throw new RangeError(`createJevRouter: consensusK must be an integer >= 1, got ${consensusK}`);
  }
  const voteTimeoutMs = options.voteTimeoutMs ?? timeoutMs * 2;
  // Shared with `profile.ts`'s profiler: caches a successful key read and forgets a failed one,
  // so a daemon that answered 503 because the vault was unreachable retries on the next request.
  const key = resolveJevKey(options.apiKey);

  /**
   * ONE full route attempt: the fan-out request, `resolveRoute`, and the exclusion gate's own
   * second request when the winner has `excludes`. This is exactly what `route()` used to be,
   * before the consensus wrapper below — kept as its own function so `route()` can fire
   * `consensusK` of these CONCURRENTLY via `Promise.all` rather than sequentially. A network
   * failure or timeout here propagates as a throw (routing fails closed), which `Promise.all`
   * turns into the whole consensus call rejecting — consistent with a single-attempt router's own
   * "network failure throws" contract; a call that could not even complete is not a legitimate
   * "unrouted" vote to out-vote the others.
   */
  const singleAttempt = async (input: RouteInput): Promise<RouteDecision> => {
    const startedAt = performance.now();
    const { state, questions } = buildRouteQuestions(input.brief, input.atlas, input.registry, input.minTransfer);

    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await key()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ state, model, questions }),
      signal: jevRequestSignal(timeoutMs, options.signal),
    });
    const text = await response.text();
    // Sanitized: the response body (`text`) is never read into this message, only reused below to
    // parse a genuine 2xx answer — see `jevErrorMessage`'s docblock.
    if (!response.ok) throw new RouteError(jevErrorMessage(response.status));
    const json = JSON.parse(text) as JevResponseBody;

    let policy = resolveRoute(json.answers, input.atlas, input.registry, { threshold: input.threshold, minTransfer: input.minTransfer, spineShare: input.spineShare });
    let calls: 1 | 2 = 1;
    let usage = json.usage;

    // The exclusion gate's second request (G7 task f8 run-3 re-plan): only when `resolveRoute`
    // routed, and only when the winner actually declares `excludes` (`buildExclusionQuestion`
    // returns undefined otherwise) — every other route stays exactly one Jev call, byte-identical
    // to before this gate existed. A network failure or malformed answer here fails OPEN to the
    // routed decision `resolveRoute` already returned (logged in `warnings`), unlike the FIRST
    // request's own failures a few lines up: this second call is a check on an already-made
    // decision, not a precondition for making one, the same "advisory, not load-bearing" posture
    // `pageKind`'s malformed-answer case takes.
    if (policy.decision === 'routed' && policy.family) {
      const winnerEntry = input.registry.families.find((entry) => entry.family === policy.family!.id);
      const exclusionRequest = winnerEntry ? buildExclusionQuestion(input.brief, winnerEntry) : undefined;
      if (winnerEntry && exclusionRequest) {
        calls = 2;
        try {
          const exclusionResponse = await fetchImpl(endpoint, {
            method: 'POST',
            headers: { Authorization: `Bearer ${await key()}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ state: exclusionRequest.state, model, questions: exclusionRequest.questions }),
            signal: jevRequestSignal(timeoutMs, options.signal),
          });
          const exclusionText = await exclusionResponse.text();
          if (!exclusionResponse.ok) throw new RouteError(jevErrorMessage(exclusionResponse.status));
          const exclusionJson = JSON.parse(exclusionText) as JevResponseBody;
          policy = applyExclusionAnswer(policy, winnerEntry, exclusionJson.answers.exclusion);
          usage = sumUsage(usage, exclusionJson.usage);
        } catch (error) {
          // A cancelled build (the caller's own `options.signal` aborted) is NEVER failed open:
          // publishing the already-routed decision here would ship a family the caller asked to
          // stop building, exactly the "cancelled build stops waiting on Jev at once" contract
          // `signal`'s own docblock states. Every OTHER failure (network error, timeout, a
          // non-2xx response, a malformed answer already handled by `applyExclusionAnswer`) still
          // fails open, since those are real answers this build asked for and didn't get — a
          // cancellation is the caller changing its mind, not Jev failing to answer.
          if (options.signal?.aborted) throw error;
          policy = { ...policy, warnings: [...policy.warnings, `exclusion gate request failed, failing open to the routed decision: ${error instanceof Error ? error.message : String(error)}`] };
        }
      }
    }

    return {
      ...policy,
      ms: Math.round(performance.now() - startedAt),
      calls,
      model: json.model,
      ...(usage ? { usage } : {}),
    };
  };

  /** Races `promise` against a timer that rejects after `ms` — the per-vote timeout, separate
   * from the per-REQUEST `timeoutMs` each individual fetch already carries (see
   * `voteTimeoutMs`'s own docblock). The timer is always cleared, win or lose, so it never keeps
   * the process alive past this call. */
  function withVoteTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new RouteError(`vote timed out after ${ms}ms`)), ms);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error as Error);
        },
      );
    });
  }

  type VoteOutcome = { status: 'ok'; result: RouteDecision } | { status: 'failed'; error: unknown };

  /**
   * Variance-aware consensus (G7 task f8 run-3 re-plan §9): runs `consensusK` `singleAttempt`s
   * CONCURRENTLY, each raced against `voteTimeoutMs`, via `Promise.allSettled` — NOT
   * `Promise.all` — specifically so ONE failed or slow vote (a network error, a timeout) never
   * rejects the whole `route()` call into the build; it is recorded as a `consensus:vote-failed`
   * vote and counted as non-agreeing, exactly like an ordinary disagreement. `route()` routes only
   * when every attempt AGREED on the exact same family (which requires every attempt to have
   * succeeded — a failed vote can never be part of an unanimous decision); any disagreement, any
   * attempt landing `unrouted`, or any failed vote unroutes with reason `consensus: …` naming
   * each vote. `votes` on the returned decision records every attempt's own outcome, win, lose or
   * fail, so a caller (the eval runner's saved answers, in particular) can see the disagreement
   * itself, not only the final verdict; `consensusK` logs how many votes were asked for. The
   * representative decision on an unanimous vote is the FIRST successful attempt's own policy
   * fields (archetype, skin, pageKind, etc. — these are expected to already agree closely across
   * a unanimous vote); `calls`, `ms` and `usage` are always the total across every SUCCESSFUL
   * attempt (a failed vote spent no calls/tokens `route()` can see) — this is the cost record for
   * the decision.
   */
  const route: JevRouter['route'] = async (input) => {
    const startedAt = performance.now();
    const settled = await Promise.allSettled(Array.from({ length: consensusK }, () => withVoteTimeout(singleAttempt(input), voteTimeoutMs)));
    const outcomes: VoteOutcome[] = settled.map((entry) => (entry.status === 'fulfilled' ? { status: 'ok', result: entry.value } : { status: 'failed', error: entry.reason }));

    const votes: RouteVote[] = outcomes.map((outcome) =>
      outcome.status === 'failed'
        ? { decision: 'unrouted', reason: 'consensus:vote-failed' }
        : {
            decision: outcome.result.decision,
            ...(outcome.result.decision === 'routed' && outcome.result.family ? { family: outcome.result.family.id } : {}),
            ...(outcome.result.decision === 'unrouted' && outcome.result.reason ? { reason: outcome.result.reason } : {}),
          },
    );

    const okResults = outcomes.filter((outcome): outcome is Extract<VoteOutcome, { status: 'ok' }> => outcome.status === 'ok').map((outcome) => outcome.result);
    const calls = okResults.reduce((sum, result) => sum + result.calls, 0);
    const usage = okResults.reduce<{ input_tokens: number; output_tokens: number } | undefined>((sum, result) => sumUsage(sum, result.usage), undefined);
    const ms = Math.round(performance.now() - startedAt);
    const resultModel = okResults[0]?.model ?? model;
    const warnings = okResults.flatMap((result) => result.warnings);

    // `consensusK: 1` is a true pass-through, not a trivial one-voter "election": there is no
    // disagreement to synthesize a `consensus: …` reason over, so the single attempt's own
    // decision (routed OR unrouted, with its own original `reason`) is returned exactly as
    // `singleAttempt` produced it — only `votes`/`consensusK` are added. A failed single vote
    // still never throws: it resolves `unrouted` with reason `consensus:vote-failed`.
    if (consensusK === 1) {
      const only = outcomes[0]!;
      if (only.status === 'ok') {
        return { ...only.result, warnings, votes, ms, calls, model: resultModel, consensusK, ...(usage ? { usage } : {}) };
      }
      return {
        decision: 'unrouted',
        reason: 'consensus:vote-failed',
        spine: FALLBACK_SPINE,
        spines: [],
        skin: FALLBACK_SKIN,
        candidates: [],
        warnings: [],
        votes,
        ms,
        calls: 0,
        model: resultModel,
        consensusK,
      };
    }

    const allOk = outcomes.every((outcome) => outcome.status === 'ok');
    const firstFamily = allOk && okResults[0]!.decision === 'routed' ? okResults[0]!.family?.id : undefined;
    const unanimous = allOk && firstFamily !== undefined && okResults.every((result) => result.decision === 'routed' && result.family?.id === firstFamily);

    if (unanimous) {
      const representative = okResults[0]!;
      return {
        ...representative,
        warnings,
        votes,
        ms,
        calls,
        model: resultModel,
        consensusK,
        ...(usage ? { usage } : {}),
      };
    }

    const voteSummary = votes.map((vote) => vote.family ?? vote.reason ?? 'unrouted').join(', ');
    const representative = okResults[0];
    return {
      decision: 'unrouted',
      reason: `consensus: ${voteSummary} (${consensusK}-way, unanimity required)`,
      spine: representative?.spine ?? FALLBACK_SPINE,
      spines: representative?.spines ?? [],
      skin: representative?.skin ?? FALLBACK_SKIN,
      candidates: representative?.candidates ?? [],
      warnings,
      votes,
      ms,
      calls,
      model: resultModel,
      consensusK,
      ...(usage ? { usage } : {}),
    };
  };

  return { route };
}
