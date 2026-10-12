---
name: agency-restaurant-generator
description: Use the fixed restaurant page kind to make a static restaurant, cafe, bar or bakery mock from a brief naming the business, its cuisine, where it is, its hours and how a visitor reserves or gets in touch.
version: 0.1.0
---

# restaurant page kind

This is a page kind, not a decoded client site: it composes eleven vendored HyperUI blocks into
one fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `BA` (Booking attendance), archetype `BA.02` (Restaurant or food business): menu,
photography, story, reviews, location, hours, reservation, ordering.

The supported path is **brief → restaurant `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. There are no image or destination slots, no
`<script>`, and every link points at `#`.

## The roster

Nine sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth):

1. `restaurant-header` (`application/tabs/4` + `application/tabs/5`) — the brand name, four nav
   `links`, one reservation `cta`.
2. `restaurant-hero` (`marketing/sections/4` + `marketing/ctas/2`) — `eyebrow`, `heading`, `body`
   and `reservationCta`. `brand.name` and `brand.descriptor` (rendered in the header too) carry
   the restaurant's name and cuisine descriptor.
3. `restaurant-menu` (`marketing/pricing/1`) — a `heading`, an `intro`, and exactly five dishes
   (`name`, `description`, and a nullable `price` — never invent a price the brief did not give).
4. `restaurant-hours-location` (`application/details-list/1`) — a `heading`, three opening-hours
   rows (`label`, `value`), and the nullable facts `address` (plain text) and `phone` (rendered as
   a `tel:` link over the same text, so a visitor can call from the page).
5. `restaurant-reservations` (`marketing/ctas/1`) — `heading`, `body`, `cta`.
6. `restaurant-story` (`marketing/sections/2`) — `heading`, `body`: the chef, owner or founding
   story.
7. `restaurant-gallery` (`marketing/feature-grids/3`) — a `heading` and three caption-only cards
   (`caption`, `blurb`); a placeholder for photography, since this page kind renders no `<img>`.
8. `restaurant-reviews` (`marketing/testimonials/3`) — **optional**: a `heading` and three reviews
   (`title`, `quote`, `name`). The whole section may be `null` when the brief has no reviews.
9. `restaurant-footer` (`marketing/footers/4`) — `tagline`, three legal `links`, and the nullable
   facts `phone` (a `tel:` link), `email` (a `mailto:` link) and `address` (plain text).

## Slots and limits

Start from `compiler/scripts/families/restaurant/reference.fixture.json`. Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "restaurant"`, a positive integer `revision`, the brand
`name` and `descriptor` (the cuisine, e.g. "Wood-fired Neapolitan pizza and a short wine list"),
and the nine sections above in order, carrying only the slots `contract.ts` accepts.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`.
- `price`, `address`, `phone` and `email` are nullable facts (`x-atom`): write `null` when the
  brief does not state one, and the page drops that element entirely — no empty `tel:`/`mailto:`
  link, no bare label. Never invent a price, address, phone number or email. `email` must look
  like an email address. `phone` is checked by tokenizing, not by a single regular expression: an
  optional leading `+`, then digit runs and AT MOST ONE separator token between each run — a
  separator token is exactly one of ` `, `.`, `-`, `(`, `)`, or one of the two-character parens
  combinations ` (`, `) `, `)-`; two separator tokens back to back, in any combination, is
  refused, and a leading `(` before the first digit run is allowed. Across the WHOLE number there
  may be at most one `(` and one `)`, with `(` before `)` — this is what refuses a run like
  `1 (2 (3 (4 (5 (6 (7`, where each `(` on its own legally follows a digit run. The total digit
  count must be 7 to 15. So `1--2`, `123  4567`, `1- - -2` and `12 . . 34567` are refused, while
  `206-555-0148`, `+1 (206) 555-0148`, `(828) 555-0135`, `020 7946 0958`, `+44 20 7946 0958` and
  `555.010.9999` are accepted. A filled `phone` renders as `<a href="tel:…">`, and a filled
  `email` as `<a href="mailto:…">`; the link target is built only from that same filled text.
  `address` has no format check — it renders as plain text, and `x-atom: 'address'` marks it
  nullable only, the same as every other page-kind family's address atom.
- Repeat counts are exact. A `null` anywhere else is refused, with the field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateRestaurantRecipe, renderRestaurant } from "./compiler/scripts/families/restaurant/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateRestaurantRecipe(JSON.parse(readFileSync("compiler/scripts/families/restaurant/reference.fixture.json", "utf8")));
writeFileSync("restaurant-r1.html", renderRestaurant(recipe, {}));
'
```

Through the fast lane, pass `--family restaurant` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/restaurant/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (the business, dishes, prices, hours, address, reviews) with real,
verified ones, and review the page against the client's own brand. A passing compile is a shape
check, not design quality.
