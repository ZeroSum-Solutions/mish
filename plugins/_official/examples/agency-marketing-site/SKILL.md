---
name: agency-marketing-site-generator
description: Use the fixed marketing-site page kind to make a static marketing site mock from a brief naming the product, its audience, what it sells and (optionally) the proof and pricing a public page would show.
version: 0.1.0
---

# marketing-site page kind

This is a page kind, not a decoded client site: it composes six vendored HyperUI marketing
blocks into one fixed layout with a typed-slot contract, the same shape the seven Agency Site
families use (`contract.ts`, `slots.ts`, `recipe.schema.json`, `render.ts`). It is registered in
`packages/agency-fast-lane/src/atlas/family-registry.json` under spine `PA` (Public asset),
archetype `PA.01` (Marketing or landing page).

The supported path is **brief → marketing-site `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The family has a fixed section roster and order;
the assistant configures named text slots only. There are no image or destination slots: the six
vendored blocks carry no `<img>` and the page has no external links beyond `#`.

## The roster

Six sections, in this order, every id stable:

1. `marketing-site-hero` — one hero (`marketing/sections/1`): `eyebrow`, `heading`, `body`,
   `primaryCta`, `secondaryCta`. All five are required.
2. `marketing-site-features` — one heading and body plus exactly three feature items
   (`marketing/feature-grids/1`): `title`, `body` each.
3. `marketing-site-proof` — exactly three testimonials (`marketing/testimonials/1`): `quote`,
   `name`, `role` each. The whole section may be `null` when the brief has no proof to show; the
   section is dropped entirely, not rendered empty. The fast lane drops it before the fill when
   the brief quotes no customer word for word (`x-optional.requires: "quote"`).
4. `marketing-site-pricing` — one heading plus exactly three pricing tiers
   (`marketing/pricing/1`): `name`, `price`, `period`, `cta`, and exactly three `features` each.
   The whole section may be `null` when the brief states no pricing; the section is dropped
   entirely.
5. `marketing-site-cta` — one banner call to action (`marketing/ctas/1`): `heading`, `body`,
   `cta`. Required.
6. `marketing-site-footer` — one tagline plus exactly three link columns
   (`marketing/footers/1`): each column has a `heading` and exactly three `links`. A link may be
   `null` when the brief names no such page or service: it is omitted, and a column with no link
   left is omitted with its heading.

The section count and order are fixed. Section mixing is not supported.

## Slots and limits

Start from `compiler/scripts/families/marketing-site/reference.fixture.json` as the finite
reference fixture (59 text slots once rendered — 57 across the six sections, plus the two
reconcilable brand slots, `brand--name` and `brand--descriptor`, which always render). Create a
fresh recipe with exactly `schemaVersion: 2`, `family: "marketing-site"`, a positive incremented
integer `revision`, the two brand text fields (`name`, `descriptor`), and the six section ids
above in order, carrying only the slots `compiler/scripts/families/marketing-site/contract.ts`
accepts.

- Text slots are plain text and bounded. Markup, HTML entities and control characters are
  rejected, and every slot names its own character limit in `compiler/scripts/families/
  marketing-site/recipe.schema.json`.
- A pricing tier's `period` (for example "/month") is a required, validated recipe field that is
  rendered but is not its own reconcilable text slot, the way the crm-dashboard chart's `unit`
  field works — kept the family inside the 40–60 slot budget.
- Repeat counts are exact: 3 features, 3 testimonials (or the whole section `null`), 3 pricing
  tiers with 3 features each (or the whole section `null`), 3 footer columns with 3 links each.

Unknown fields, markup, wrong repeat counts, and a `null` anywhere the contract does not allow it
(anywhere but the whole `proof` or `pricing` section, or one footer link) are rejected, each with the offending field
named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateMarketingSiteRecipe, renderMarketingSite } from "./compiler/scripts/families/marketing-site/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateMarketingSiteRecipe(JSON.parse(readFileSync("compiler/scripts/families/marketing-site/reference.fixture.json", "utf8")));
writeFileSync("marketing-site-r1.html", renderMarketingSite(recipe, {}));
'
```

Through the fast lane, pass `--family marketing-site` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/marketing-site/render.test.ts
```

## Before a client sees it

Replace every placeholder business fact (product, audience, numbers) with real, verified ones,
and review the candidate against the client's own brand materials. A passing compile is a shape
check. It is not design quality.
