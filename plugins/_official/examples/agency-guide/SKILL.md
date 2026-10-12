---
name: agency-guide-generator
description: Use the fixed guide page kind to make a static one-destination guide mock (a city, region, trail or island) from a brief naming the place, an opening chapter, further chapters, and any practical facts, places to see or a plan-a-visit URL.
version: 0.1.0
---

# guide page kind

This is a page kind, not a decoded client site: it composes nine vendored HyperUI blocks into one
fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `CS` (Content and story), archetype `CS.01` (shared with `publication`): one
destination told as chapters plus practical facts, for a visitor deciding whether to go.

The supported path is **brief → guide `schemaVersion: 2` typed recipe → executable validation →
trusted compiler → static HTML**. The section roster and order are fixed; the assistant
configures named text slots only. There are no image slots and no `<script>`.

The visitor READS the place; there is no subscription, no issue archive, no room or booking
inventory and no reservations. It must not be confused with `publication` (a recurring title with
a subscription — a magazine or newsletter, not one place), `halcyon` (one visited institution with
a programme, hours and membership), or `listings` (many independent, separately searchable
entities). A travel-themed hero with no real place content — no chapters, no practical facts — is
not a guide and stays unrouted.

## The roster

Nine sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth).
Required, ALWAYS present: header, masthead, opening chapter, chapter list, footer. Optional (the
whole section may be `null` when the brief gives no evidence): practical facts, places to see,
gallery, plan-a-visit.

1. `guide-header` (`application/tabs/4`) — the destination's name (`brand.name`) and the nav. No
   model-written nav text at all: its five labels (Chapters, Practical facts, Places to see,
   Gallery, Plan a visit) are FIXED in `render.ts`, the same strings the footer nav uses for the
   same sections, so a label can never name a target it does not point at. Practical facts, places,
   gallery and plan-a-visit are linked only when that section actually renders something.
2. `guide-masthead` (`marketing/sections/4`) — `heading` (a stylized rendering of the place name)
   and `standfirst`, the visitor's very first read of what this destination is.
3. `guide-opening-chapter` (`marketing/sections/1`) — `heading` and `body`: required prose from
   the brief, no invented facts. This is the first chapter; `chapter-list` holds the further ones.
4. `guide-chapter-list` (`marketing/feature-grids/2`) — a `heading` and one to six further
   chapters (`title`, `body`). **Required**, `min: 1` — a sparse brief that supports only one
   further chapter beyond the opening one still satisfies this section; never write a second
   chapter the brief does not support just to reach a higher count.
5. `guide-practical-facts` (`application/details-list/1`, label/value rows) — **optional**: a
   `heading` and exactly four ITEM SLOTS, one per FIXED category — getting there, best time to
   visit, currency, language, in that order (`slots.ts`'s `PRACTICAL_FACTS_LABELS`). A category
   the brief does not support returns `null` for the WHOLE ITEM (`{"label":..., "value":...}`
   together, not `value: null` alone) — the row is then dropped entirely, never rendered as an
   empty or placeholder row ("Not published"), and never a half-filled row with a guessed value
   under a real-looking label. `label` DOES stay in the schema on a PRESENT item (so the model can
   see which fixed category each position answers), but it is not free text: `contract.ts` hard-
   refuses any present item's `label` that is not `PRACTICAL_FACTS_LABELS[index]` exactly — copy
   it verbatim, never invent or reword it. Drop the WHOLE SECTION only when every category is
   unsupported (all four items null).
6. `guide-places-to-see` (`marketing/feature-grids/1`) — **optional**: a `heading`, a `body`, and
   one to five named places (`name`, `body`). `name` must come from the brief verbatim
   (`x-verify: 'traceable'`); `body` should describe the place using the BRIEF'S OWN words and
   facts, never a distance, a walking or driving time, or a count of places the brief does not
   give — a card with no real description to write is OMITTED entirely, never filled with an
   invented or padded one. Drop the whole section when the brief names no real place worth
   seeing, or names places but gives nothing to say about any of them.
7. `guide-gallery` (`marketing/testimonials/3`, reused as a typographic card grid) —
   **optional**: a `heading` and two to six place labels (`label`). A pure CSS/typography
   treatment — a large numeral, the place name set in display type, a hairline rule — never a
   photograph, a stock image, or any external embed. Reuses the SAME named places the brief
   already gave (often the same ones as `places-to-see`), never a new invented place. Drop the
   whole section when the brief names fewer than two real places.
8. `guide-plan-a-visit` (`marketing/ctas/1`) — **optional**: `heading`, `body`, `cta`, and `url`
   (`x-atom: 'url'`, the same shared contact-atom marker any family's email or phone field uses).
   `contract.ts` refuses anything that is not a well-formed full `http(s)://` URL — never prose, a
   scheme-less domain, or a stray `@`. `url` is never nullable itself: a brief with no plan-a-visit
   URL drops the WHOLE section instead, never a section that exists with no link. `url` must also
   be the EXACT URL the brief itself gives (see "A second, deterministic honesty check" below) —
   never a plausible-looking invention.
9. `guide-footer` (`marketing/footers/4`) — a `tagline` and a nav built the same fixed way the
   header's is, from whichever optional sections actually rendered.

## Slots and limits

Start from `compiler/scripts/families/guide/reference.fixture.json`. Create a fresh recipe with
exactly `schemaVersion: 2`, `family: "guide"`, a positive integer `revision`, the brand `name`
(the destination's own name) and `descriptor` (a one-line description of the place), and the nine
sections above in order, carrying only the slots `contract.ts` accepts.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`. Multi-paragraph prose (the opening chapter's
  `body`) may use a blank line as a paragraph break; it still renders as one text slot.
- This family has two nullable atoms. (1) practical-facts' own ITEM (round-4 fix: the WHOLE row —
  label and value together — is what may be `null`, not `value` alone; see the section list above)
  — a free-text `label` field was tried and REJECTED in an earlier round (round-3 fix: a model-
  written category name is free text standing in for fixed chrome, not a fact, and a sparse brief
  drove a live filler to invent implausible-sounding category names that then correctly failed the
  traceability check for being exactly that; `label` stays in the schema as fixed, hard-checked
  chrome instead). (2) `brand.descriptor` (round 4): nullable AND traceable together, the same
  combination storefront's own `price` field uses — see "A second, deterministic honesty check"
  below. Every OTHER "unknown fact" is handled by array minima (a short chapter list, no places-to-
  see rows) and by whole-section optionality: when a brief lacks a category of fact entirely, the
  WHOLE section (and its nav link) is dropped.
- Repeat counts have a minimum and a maximum (chapter-list and places-to-see take `min: 1`; gallery
  takes `min: 2`; practical-facts is FIXED at exactly four rows, one per category, with `value`
  null for an unsupported one). Fill exactly as many chapter/place/gallery items as the brief gives
  real facts for, never padded to the maximum with an invented item or one borrowed from another
  section. A `null` outside a nullable atom or an optional section's own slot, or a count outside
  `[min, count]`, is refused, with the field named. This floor is deliberately per ROW, not just
  per section: a practical-facts `value`, a places-to-see card, a gallery label, and the brand
  `descriptor` must each use ONLY words and facts the brief itself states — never a plausible
  detail dressed up as local knowledge (a claimed proximity, a season, a currency name, a
  language, a road or parking note) that the brief never gave. When the brief supports fewer
  chapter/place/gallery items than `count`, OMIT the unsupported ones rather than writing them —
  down to, but never below, each section's own `min`. Getting there, best time, currency, and
  language are four independent facts: a brief that states some but not all of them still fills
  only the `value` of the ones it states, returning `null` for the rest.
  (`x-atom: 'url'` already checks `plan-a-visit`'s `url` this way, exactly, against the brief; the
  same per-row token check for these string rows is `x-verify: 'traceable'` — practical-facts'
  `value` (never its fixed `label`), `places-to-see`'s `name` (never its `body`, round-5 fix — see
  below), `gallery`'s `label`, and `brand.descriptor` all carry it, and it IS a deterministic gate
  here, checked by `deterministicTraceableFlags`, not only an instruction to the filler.
  `places-to-see`'s `body` is deliberately NOT whole-field traceable — a distance, a walking time
  or a count invented there is still a claim to catch, but a free-prose body may honestly
  paraphrase the brief's own words, which whole-field tracing would false-flag; see "A second,
  deterministic honesty check" below for the actual mechanism this maps to and its current reach.)
- Do not restate the same fact in more than one section's intro or body. `places-to-see` and
  `gallery` reusing the SAME named places the chapters already mention is the one deliberate
  exception (a second, more visual pass over an honest fact already on the page) — narrative
  prose itself should never be copied verbatim into two places.
- Every `href` on the page is either a real in-page anchor (`#id`) to a section that actually
  renders, or plan-a-visit's own exact, brief-supplied URL. No `#`, no invented pages.
- At most one effect placement (`hero-title`, `split-text`) — this family's
  `catalog.json` declares `maxEffects: 1`.

## Compile

```sh
node --experimental-strip-types -e '
import { validateGuideRecipe, renderGuide } from "./compiler/scripts/families/guide/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateGuideRecipe(JSON.parse(readFileSync("compiler/scripts/families/guide/reference.fixture.json", "utf8")));
writeFileSync("guide-r1.html", renderGuide(recipe, {}));
'
```

Through the fast lane, pass `--family guide` to `packages/agency-fast-lane/src/cli.ts`, or
`od agency build --family guide --brief "<text>"` against a running daemon.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/guide/render.test.ts
```

## A second, deterministic honesty check

One schema marker drives a shared, deterministic supplement to the strict Jev faithfulness gate
every family already goes through (a model call, which a live build proved CAN be talked past by
a plausible-sounding invention). It is wired automatically into
`packages/agency-fast-lane/src/run.ts`'s `makeCheckOnce` — nothing in this family's own package
calls it; a strict build fails closed on it the same way it fails on Jev's own flags.

- `x-atom: 'url'` (plan-a-visit's `url`): must be the EXACT URL the brief gives, by token equality
  — never a substring match, and never a plausible-looking URL the brief did not actually state —
  `contactPathsFor` / `deterministicContactFlags` (`spine.ts`, `jev.ts`), the same shared
  contact-atom gate any family's email or phone field uses.
- `x-verify: 'traceable'` (practical-facts' `value` — never its fixed `label`, see above —
  `places-to-see`'s `name` (never its `body`, see below), `gallery`'s `label`, and
  `brand.descriptor`): every stemmed content word of the value must trace to the brief —
  `traceablePathsFor` / `deterministicTraceableFlags` (`spine.ts`, `jev.ts`), the same shared
  marker any family may adopt on a free-prose fact row. This is what catches the invented season,
  language, proximity claim, or place name (round 1's own finding: Cerebras inventing
  "amber-coast") slipping past Jev's own judgment alone. `brand.descriptor` (round 4) is ALSO
  nullable — traced word-for-word when present, `null` (dropped from render entirely, including
  the `<meta name="description">` tag) when the brief supports no one-sentence synthesis at all —
  the same `atom` + `traceable` combination storefront's own `price` field uses.
- `places-to-see`'s `body`: NOT whole-field traceable — a full-word trace over free descriptive
  prose false-flagged ordinary, faithful paraphrase. The check for a claim IN free prose (a count,
  a distance, a walking or driving time, a clock time) is a per-SENTENCE claim gate over number/
  number-word/distance-stem/commercial-stem/clock-time signals — `deterministicSentenceClaimFlags`
  (`jev.ts`). **This IS wired into every live guide build**: `guide` is in `run.ts`'s
  `SENTENCE_CLAIM_FAMILIES` (alongside `storefront` and `practice`) — NOT the older,
  storefront-only `COMMERCIAL_WORD_FAMILIES` set, a separate constant this doc used to (wrongly)
  name here. A spelled-out small count ("Four must-see spots"), a bare distance/proximity phrase
  with no number at all ("a short walk from the harbor", "within walking distance of the dock"),
  and a glued clock time ("5am" against a brief's own "6am") are all live claim signals as of
  round 4 — `packages/agency-fast-lane/tests/guide-sentence-claims.test.ts` proves each one is
  actually caught, not merely documented as a gap.

`packages/agency-fast-lane/tests/guide-recipe-faithfulness.test.ts` runs the `x-verify:'traceable'`
gate over the committed `reference.fixture.json` against its own documented source brief
(`compiler/scripts/families/guide/reference.fixture.brief.txt`), so a hand-edited or stale
fixture is caught by a test rather than waiting for a live build. It does NOT check free prose (a
brand descriptor, a chapter's own body text, or — since round 5 — `places-to-see`'s own `body`) —
the same gap every family's deterministic gates leave open; see
`practice-recipe-faithfulness.test.ts`'s own docblock for why.

## Before a client sees it

Replace every placeholder fact (the destination, its chapters, practical facts, places, and any
plan-a-visit URL) with real, verified ones, and review the page against the client's own brand. A
passing compile is a shape check, not design quality.
