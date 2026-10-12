---
name: agency-nonprofit-generator
description: Use the fixed nonprofit page kind to make a static charity, foundation or cause mock from a brief naming the organisation, its cause, where it works and how people can give or volunteer.
version: 0.1.0
---

# nonprofit page kind

This is a page kind, not a decoded client site: it composes twelve vendored HyperUI blocks into
one fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `MI` (Mission impact), archetype `MI.01` (Nonprofit or charity): stakes →
mission → approach → evidence → participation.

The supported path is **brief → nonprofit `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. No images, no `<script>`, every link points at `#`.

## The roster

Eleven sections, in this order (`slots.ts` `SECTIONS` is the source of truth):

1. `nonprofit-header` (`application/tabs/4`) — the name, four nav `links`, a `donateCta`.
2. `nonprofit-hero` (`marketing/sections/1`) — `eyebrow`, `heading`, `body`, `donateCta`, `volunteerCta`.
3. `nonprofit-mission` (`marketing/sections/3`) — `heading`, `body`.
4. `nonprofit-programs` (`marketing/feature-grids/1`) — `heading`, `body`, three programmes (`title`, `body`).
5. `nonprofit-impact` (`marketing/stats/3`) — **optional**: `heading`, `body`, four figures
   (`label`, `value`). Drop the whole section (`null`) when the brief states no measured outcomes;
   never invent numbers.
6. `nonprofit-stories` (`marketing/testimonials/1`) — **optional**: a `heading` and two stories
   (`quote`, `name`, `role`). Drop it (`null`) when the brief quotes no named person.
7. `nonprofit-accountability` (`application/details-list/3`) — `heading`, `body`, and three
   nullable `fact`s (registration, spend, audit).
8. `nonprofit-events` (`application/timelines/1`) — **optional**: a `heading` and three events
   (nullable `date`, `title`, `body`). Drop it (`null`) when the brief names no dated event; the
   header's third nav link goes with it.
9. `nonprofit-give` (`marketing/pricing/1`) — `heading`, `body`, two ways to give (`name`,
   nullable `amount` and `period`, `impact`, `cta`).
10. `nonprofit-volunteer` (`marketing/ctas/2`) — `heading`, `body`, `cta`.
11. `nonprofit-footer` (`marketing/footers/1`) — `tagline`, three `links`, and the nullable
    `address`, `phone` and `email`.

## Slots and limits

Start from `compiler/scripts/families/nonprofit/reference.fixture.json`. Every limit is in
`recipe.schema.json`; markup, entities and control characters are rejected; repeat counts are
exact. The accountability `fact`s, the event `date`s, the giving `amount`s and `period`s, and the
footer `address`, `phone` and `email` are nullable facts (`x-atom`): write `null` when the brief
does not state one, and the page drops that element (a `period` never shows without its
`amount`). Never invent a charity number, a date, an amount, an address or a phone number.

## Compile

```sh
node --experimental-strip-types -e '
import { validateNonprofitRecipe, renderNonprofit } from "./compiler/scripts/families/nonprofit/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateNonprofitRecipe(JSON.parse(readFileSync("compiler/scripts/families/nonprofit/reference.fixture.json", "utf8")));
writeFileSync("nonprofit-r1.html", renderNonprofit(recipe, {}));
'
```

Through the fast lane, pass `--family nonprofit` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/nonprofit/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (figures, stories, registration, contact details) with real,
verified ones and review the page against the client's own brand.
