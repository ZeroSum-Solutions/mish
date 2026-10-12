---
name: agency-publication-generator
description: Use the fixed publication page kind to make a static magazine, newsletter, independent media or blog mock from a brief naming the title, what it covers, who reads it and how readers subscribe.
version: 0.1.0
---

# publication page kind

This is a page kind, not a decoded client site: it composes ten vendored HyperUI blocks into one
fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `CS` (Content subscription), archetype `CS.01` (Publication or media): headline →
consume → related → subscribe.

The supported path is **brief → publication `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. No images, no `<script>`, every link points at `#`.

## The roster

Ten sections, in this order (`slots.ts` `SECTIONS` is the source of truth):

1. `publication-masthead` (`application/tabs/4`) — the title, four section `links`, a subscribe `cta`.
2. `publication-lead` (`marketing/sections/2`) — `kicker`, `headline`, `dek`, nullable `byline`, `readCta`.
3. `publication-topics` (`application/tabs/5`) — a `heading` and five `topics`.
4. `publication-latest` (`marketing/feature-grids/4`) — a `heading` and four stories (`topic`,
   `title`, `dek`, nullable `date`).
5. `publication-series` (`marketing/feature-grids/3`) — a `heading` and four series (`title`, `blurb`).
6. `publication-archive` (`application/timelines/1`) — a `heading` and four entries (nullable
   `date`, `title`, `summary`).
7. `publication-authors` (`marketing/testimonials/2`) — **optional**: a `heading` and three
   contributors (`bio`, `name`, `beat`). The whole section may be `null` when the brief names none.
8. `publication-newsletter` (`marketing/ctas/2`) — `heading`, `body`, `emailPlaceholder`, `cta`,
   and the nullable `cadence`.
9. `publication-membership` (`marketing/pricing/1`) — a `heading` and two tiers (`name`, nullable
   `price` and `period`, three `features`, `cta`).
10. `publication-footer` (`marketing/footers/1`) — `tagline`, three `links`, the nullable `contactEmail`.

## Slots and limits

Start from `compiler/scripts/families/publication/reference.fixture.json`. Every limit is in
`recipe.schema.json`; markup, entities and control characters are rejected; repeat counts are
exact. The lead `byline`, the story and archive `date`s, the membership `price`s and `period`s,
`cadence` and `contactEmail` are nullable facts (`x-atom`): write `null` when the brief does not
state them, and the page drops that element (a `period` never shows without its `price`).
`contactEmail` must be an email address.

## Compile

```sh
node --experimental-strip-types -e '
import { validatePublicationRecipe, renderPublication } from "./compiler/scripts/families/publication/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validatePublicationRecipe(JSON.parse(readFileSync("compiler/scripts/families/publication/reference.fixture.json", "utf8")));
writeFileSync("publication-r1.html", renderPublication(recipe, {}));
'
```

Through the fast lane, pass `--family publication` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/publication/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (stories, writers, prices, dates) with real ones and review the
page against the client's own brand. A passing compile is a shape check, not design quality.
