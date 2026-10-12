---
name: agency-listings-generator
description: Use the fixed listings page kind to make a static directory or listings mock (real estate, rentals, holiday stays, a marketplace or a local directory) from a brief naming the business, what it lists, where, and how a visitor gets in touch.
version: 0.1.0
---

# listings page kind

This is a page kind, not a decoded client site: it composes twelve vendored HyperUI blocks into
one fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `SM` (Search and match), archetype `SM.02` (Directory or listings): search → filter
→ summary → detail → contact.

The supported path is **brief → listings `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. There are no image or destination slots, no
`<script>`, and every link points at `#`.

## The roster

Ten sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth):

1. `listings-header` (`application/tabs/4`) — the brand name, four nav `links`, one `cta`.
2. `listings-search` (`marketing/sections/4` + `marketing/ctas/2`) — `eyebrow`, `heading`,
   `body`, the search field's `queryPlaceholder` and its `searchCta`. The search field is a
   read-only `<input type="search">` with no form and no script; `queryPlaceholder` is its
   placeholder text.
3. `listings-categories` (`marketing/feature-grids/3`) — a `heading` and four items
   (`title`, `blurb`).
4. `listings-filters` (`application/filters/1`) — a `heading` and three filter groups
   (`label`, three `options`).
5. `listings-results` (`application/tabs/5`, bordered cards) — a `heading`, three `sorts`,
   and four **sample** results (`location`, `title`, `price`, `summary`).
6. `listings-compare` (`application/tables/3`) — a `heading`, three `columns`,
   three **sample** rows of three `cells`.
7. `listings-featured` (`marketing/feature-grids/2` + `application/details-list/1`) —
   `heading`, `body`, three **sample** facts (`label`, `value`).
8. `listings-reviews` (`marketing/testimonials/3`) — **optional**: a `heading` and three reviews
   (`title`, `quote`, `name`). The whole section may be `null` when the brief has no reviews.
9. `listings-inquiry` (`marketing/ctas/1`) — `heading`, `body`, `cta`, and two nullable facts:
   `phone`, `email`.
10. `listings-footer` (`marketing/footers/4`) — `tagline`, three legal `links`, and the nullable
    `address`.

## Slots and limits

Start from `compiler/scripts/families/listings/reference.fixture.json`. Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "listings"`, a positive integer `revision`, the brand
`name` and `descriptor`, and the ten sections above in order, carrying only the slots
`contract.ts` accepts.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`.
- `phone`, `email` and `address` are nullable facts (`x-atom`): write `null` when the brief does
  not state one, and the page drops that element. Never invent a phone number or address.
  `email` must look like an email address and `phone` like a phone number.
- The results, comparison and featured items are illustrative sample data (`x-mock`): the page
  shows a fixed caption before them that says they are examples. The caption is part of the
  template, not a slot: a recipe carries no caption text. Write sample values that fit the
  brief's kind of directory; they are never read as facts about the client.
- Repeat counts are exact. A `null` anywhere else is refused, with the field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateListingsRecipe, renderListings } from "./compiler/scripts/families/listings/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateListingsRecipe(JSON.parse(readFileSync("compiler/scripts/families/listings/reference.fixture.json", "utf8")));
writeFileSync("listings-r1.html", renderListings(recipe, {}));
'
```

Through the fast lane, pass `--family listings` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/listings/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (the business, towns, prices, reviews) with real, verified ones,
and review the page against the client's own brand. A passing compile is a shape check, not
design quality.
