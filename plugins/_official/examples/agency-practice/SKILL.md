---
name: agency-practice-generator
description: Use the fixed practice page kind to make a static local clinical or appointment practice mock (dental, veterinary, medical specialist, physiotherapy, aesthetics or med-spa) from a brief naming the business, its services or treatments, its providers, what a visit is like, and how a visitor books.
version: 0.1.0
---

# practice page kind

This is a page kind, not a decoded client site: it composes twelve vendored HyperUI blocks into
one fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `TL` (Trust to lead), archetypes `TL.01` (Local appointment business) and `TL.02`
(clinic-shaped briefs): local need, services, credentials, what to expect, and a book step.

The supported path is **brief → practice `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. There are no image slots and no `<script>`.

A public site for a local clinical or appointment practice whose visitor judges fit and books —
not a signed-in patient portal. It must not be confused with `watson` (a studio or consultancy;
never hours, providers, insurance or a book-appointment step), `fervor` (an agency reel),
`wrenfield`/`maben` (a property or remodeling estimate), `restaurant` (a table reservation),
`halcyon` (a visited membership institution), or `app-shell`/`crm-dashboard` (a working app or
dashboard screen).

## The roster

Eleven sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth).
Required: header, hero, services, book, footer. Optional (the whole section may be `null` when the
brief gives no evidence): providers, expect, reviews, insurance, faq, hours-location.

1. `practice-header` (`application/tabs/4` + `application/tabs/5`) — the brand name and one
   `bookCta`. The nav itself carries no model-written text at all: its four labels (Services,
   Providers, FAQ, Hours & location) are FIXED in `render.ts`, the same strings the footer nav
   uses for the same sections, so a label can never name a target it does not point at. Providers,
   FAQ and hours-and-location are linked only when that section actually renders something.
2. `practice-hero` (`marketing/sections/4` + `marketing/ctas/2`) — `eyebrow`, `heading`, `body`
   and `bookCta`. `brand.name` and `brand.descriptor` (rendered in the header too) carry the
   practice's name and what it treats.
3. `practice-services` (`marketing/feature-grids/1`) — a `heading`, a `body`, and one to three
   services or treatments (`title`, `body`). **Required** — but never padded past what the brief
   actually names: a one-service practice gets one card. A deterministic keyword match against
   each `title` picks its icon from a small reviewed set (tooth, shield, sparkle, paw,
   stethoscope, eye, bone; a calendar otherwise) — never a placeholder glyph.
4. `practice-providers` (`marketing/feature-grids/2`) — a `heading`, a `body`, and one to three
   providers (`name`, `credential`). **Optional** — keep it when the brief names at least one real
   clinician, drop it (`null`) when it names none; never invent a person to fill it, never invent a credential the brief did not give, and never pad
   a one-provider practice to three cards with content borrowed from `services`/`expect`
   (whole-word match against those sections' own item titles) or invented. A duplicate — the SAME
   provider written twice under different filler credential text, or under a different honorific
   or credential suffix on the name itself ("Dr. Hannah Okafor" vs "Dr. Hannah Okafor, DVM") — is
   recognized and rendered once.
5. `practice-expect` (`application/timelines/1`) — a `heading`, a `body`, and one to three visit
   steps (`step`, `title`, `body`). **Optional** — keep it when the brief describes what happens at
   a visit, drop it (`null`) when it does not; never pad to three steps the brief does not state.
6. `practice-book` (`marketing/ctas/1`) — `heading`, `body`, `cta`, and a nullable `destination`
   (`x-atom: 'destination'`). `contract.ts` refuses anything that is not a well-formed URL, email
   or phone number — never prose, a scheme-less domain, or a stray `@`. The destination is
   classified from its own filled text into the matching honest scheme, an `http(s)://` scheme
   checked BEFORE `@` (a URL can legitimately carry `@` in its path or query) — a leading
   `http://`/`https://` used as-is, else an `@` makes it `mailto:`, else `tel:` (stripped the same
   way the `phone` atoms are). When the recipe's own `destination` is `null`, the rendered page
   falls back to a phone or email the SAME recipe already validates elsewhere (hours-and-location's
   `phone`, then the footer's `phone`, then the footer's `email`) — reusing a fact already on the
   page, not inventing one — and styles it as the primary action either way. Only when nothing real
   exists anywhere does the call render as plain, non-interactive text with no button chrome at
   all — never a greyed-out or dead-looking control. `destination`, hours-location's `phone`, and
   the footer's `phone`/`email` all carry `x-verify: 'destination'` too (see "A second,
   deterministic honesty check" below): a non-null value at any of them must be the EXACT URL,
   email or phone the brief itself gives, by token equality, not a substring match.
7. `practice-reviews` (`marketing/testimonials/3`) — **optional**: a `heading` and one to three
   reviews (`quote`, `name`). Drop the whole section when the brief has no real patient or client
   reviews; render exactly as many as it gives, never padded.
8. `practice-insurance` (`marketing/pricing/1`) — **optional**: a `heading`, a `body`, and one or
   two items (`name`, `detail`, and a nullable `price`). Drop the whole section when the brief
   states no accepted insurance, plan or price.
9. `practice-faq` (`application/details-list/1`, as question/answer pairs) — **optional**: a
   `heading` and one to three items (`question`, `answer`). Drop the whole section when the brief
   supplies no real, answerable question specific to this practice.
10. `practice-hours-location` (`application/details-list/1`, as label/value rows) — **optional**:
    a `heading`, zero to three rows (`label`, `value`), and the nullable facts `address` (plain
    text) and `phone` (rendered as a `tel:` link over the same text; verified, see item 6). A row
    counts as real only when its LABEL contains an actual day-of-week or day-range token as a
    WHOLE WORD ("Mon-Thu", "Fri", "Weekend") — a label like "Open" or "Birthday" names no day at
    all and is dropped, defensively, even though `min: 0` means a fill never has to write one. A
    row's VALUE is dropped only when it is entirely a hedge phrase with no real schedule
    information of its own ("Call to confirm", "Varies"); a value that mixes real hours with a
    hedge aside ("8am-5pm, call for holiday hours") keeps its real hours. A brief with no real
    hours supplies zero rows — never a placeholder row asserting "not published". Drop the whole
    section, and its header/footer nav links, when nothing meaningful remains: no real row, no
    address, no phone. No map embed — this page kind renders no iframes or external embeds.
11. `practice-footer` (`marketing/footers/4`) — `tagline`, the nullable facts `address` (plain
    text), `phone` (a `tel:` link, verified) and `email` (a `mailto:` link, verified), and three
    legal `links`. Also shows a read-only summary of hours-and-location's own real rows, when that
    section renders — reusing that section's already-validated facts, never a new one.

## Slots and limits

Start from `compiler/scripts/families/practice/reference.fixture.json`. Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "practice"`, a positive integer `revision`, the brand
`name` and `descriptor` (what the practice treats, e.g. "A family and cosmetic dental practice in
Northeast Portland"), and the eleven sections above in order, carrying only the slots
`contract.ts` accepts.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`.
- `price`, `destination`, `address`, `phone` and `email` are nullable facts (`x-atom`): write
  `null` when the brief does not state one, and the page drops that element entirely — no empty
  link, no bare label. Never invent a price, booking destination, address, phone number or email.
  `email` must look like an email address. `phone` accepts digits, spaces, dots, hyphens and
  parentheses with an optional leading `+`, 7-20 characters with at least 7 digits (e.g.
  `(503) 555-0142`, `+44 20 7946 0958`). `destination` must be a well-formed full `http(s)://` URL,
  an email, or a phone number in that same shape — never prose, a scheme-less domain, or a stray
  `@` — AND (when non-null) must be the exact one the brief gives (see "A second, deterministic
  honesty check" below). `address` has no format check — it renders as plain text.
- Repeat counts have a minimum and a maximum (services, providers, reviews, insurance and FAQ all
  take `min: 1`; hours-and-location's rows take `min: 0`). Fill exactly as many items as the brief
  gives real facts for, never padded to the maximum with an invented item or one borrowed from
  another section (a padded "provider" card built from a service's own name and description is
  exactly the fabrication this contract exists to refuse). A `null` outside a nullable atom, or a
  count outside `[min, count]`, is refused, with the field named.
- Do not restate the same fact in more than one section's intro or body. If a section's `body`
  would only repeat something the hero, another section, or the footer already states (a founding
  year, a provider's own name, "sees every patient"), write a shorter intro specific to that
  section instead, or leave it terse — never copy the same sentence into two places on the page.
- At most one effect placement (`hero-title`, `split-text` or `masked-heading`) — this family's
  `catalog.json` declares `maxEffects: 1`.

## Compile

```sh
node --experimental-strip-types -e '
import { validatePracticeRecipe, renderPractice } from "./compiler/scripts/families/practice/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validatePracticeRecipe(JSON.parse(readFileSync("compiler/scripts/families/practice/reference.fixture.json", "utf8")));
writeFileSync("practice-r1.html", renderPractice(recipe, {}));
'
```

Through the fast lane, pass `--family practice` to `packages/agency-fast-lane/src/cli.ts`, or
`od agency build --family practice --brief "<text>"` against a running daemon.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/practice/render.test.ts
```

## A second, deterministic honesty check

Three schema markers drive shared, deterministic supplements to the strict Jev faithfulness gate
every family already goes through (a model call, which a live build proved CAN be talked past by
a plausible-sounding invention). All three are wired automatically into
`packages/agency-fast-lane/src/run.ts`'s `makeCheckOnce` — nothing in this family's own package
calls them; a strict build fails closed on any of them the same way it fails on Jev's own flags.

- `x-atom: 'person-name'` (a provider's `name`, a review's `name`): must appear in the brief,
  verbatim (case-insensitive), or the build is refused — `personNamePathsFor` /
  `deterministicAttributionFlags` (`spine.ts`, `jev.ts`).
- `x-verify: 'quote'` (a review's `quote`): must trace to the brief's own words — a run of at
  least 6 consecutive shared words, or 70% overlap for a shorter quote — `quotePathsFor` /
  `deterministicQuoteFlags`.
- `x-verify: 'destination'` (the book section's `destination`, hours-location's `phone`, the
  footer's `phone`/`email`): a non-null value must be the EXACT URL, email or phone the brief
  gives, by token equality (a URL by scheme+host+path, an email case-insensitively, a phone by its
  digits with only a leading country-code `1` allowed to differ) — never a substring match, and
  never a digit run harvested from inside a URL or email span — `destinationPathsFor` /
  `deterministicDestinationFlags`.

The `reviews` section also sets `x-optional.requires: 'quote'` (`slots.ts`), the same mechanism
`agency-community`'s `voices` section uses: the fast lane drops the whole section before any fill
call when the brief quotes no one word for word, so a brief that only asks for reviews can never
reach a model call for this section at all.

`packages/agency-fast-lane/tests/practice-recipe-faithfulness.test.ts` runs these same three
gates over the committed `reference.fixture.json` against its own documented source brief
(`compiler/scripts/families/practice/reference.fixture.brief.txt`), so a hand-edited or stale
fixture is caught by a test rather than waiting for a live build. It does NOT check free prose (a
brand descriptor, a section's own `body` text) — see that test's own docblock for why that gap is
real and deliberately left open, the same as the free-prose gap in live builds.

## Before a client sees it

Replace every placeholder fact (the business, services, providers, credentials, hours, address,
reviews) with real, verified ones, and review the page against the client's own brand. A passing
compile is a shape check, not design quality.
