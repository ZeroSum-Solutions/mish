---
name: agency-docs-hub-generator
description: Use the fixed docs-hub page kind to make a static developer documentation hub or knowledge base mock from a brief naming the product, what the docs cover and who reads them.
version: 0.1.0
---

# docs-hub page kind

This is a page kind, not a decoded client site: it composes ten vendored HyperUI blocks into one
fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `CS` (Content subscription), archetype `CS.02` (Documentation or knowledge base):
orient → search → follow steps → verify → troubleshoot → continue.

The supported path is **brief → docs-hub `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. No images, no `<script>`, every link points at `#`.
The header's search field and the one code sample are static, labelled mocks, never a live
`<input>` or model-written code.

## The roster

Nine sections, in this order (`slots.ts` `SECTIONS` is the source of truth):

1. `docs-hub-header` (`application/tabs/4` + `application/empty-states/5`) — the product name, three
   nav `links`, and a labelled, non-functional search field (`searchLabel` is the accessible
   `<label>` text; `searchPlaceholder` is the static mock's own text), plus a `cta`.
2. `docs-hub-hero` (`marketing/ctas/1`) — `heading` and `body` naming what the docs cover, and a
   "Get started" `cta`.
3. `docs-hub-quickstart` (`application/details-list/3`) — a `heading` and five quick-start steps
   (`title`, `description`).
4. `docs-hub-guides` (`marketing/feature-grids/1`) — a `heading`, intro `body`, and six guide cards
   (`title`, `description`). Titles and descriptions are brief-specific but non-factual copy, not
   real product claims.
5. `docs-hub-api` (`application/details-list/1`) — **optional**: a `heading` and four API or
   reference entry points (`name`, `description`). The whole section may be `null` when the brief
   names no API, SDK or reference surface.
6. `docs-hub-code-sample` (`application/tables/2`) — a `heading` and a `caption`. The `<pre>` code
   block itself is one fixed static literal in `render.ts`, never a recipe slot: no model writes
   code for this page.
7. `docs-hub-changelog` (`application/timelines/3`) — **optional**: a `heading` and four entries
   (`title`, `summary`, plus the nullable `version` and `date`). A brief that gives no release
   history drops the whole section; one that gives titles but no version numbers or dates keeps
   the entries with those two facts omitted.
8. `docs-hub-community` (`marketing/ctas/4`) — **optional**: `heading`, `body`, and the nullable
   `supportEmail`, `communityLink` and `statusLink`. The whole section may be `null` when the brief
   names no community, support channel or status page.
9. `docs-hub-footer` (`marketing/footers/1`) — `tagline`, the three independently nullable
   `link1`/`link2`/`link3`, and the nullable `contactEmail`.

## Slots and limits

Start from `compiler/scripts/families/docs-hub/reference.fixture.json`. Every limit is in
`recipe.schema.json`; markup, entities and control characters are rejected; repeat counts are
exact. `version`, `date`, `supportEmail`, `communityLink`, `statusLink`, `link1`, `link2`,
`link3` and `contactEmail` are nullable facts (`x-atom`): write `null` when the brief does not
state them, and the page drops that element. `supportEmail` and `contactEmail` must be email
addresses.

`supportEmail` and `contactEmail` are the two exceptions to "every link points at `#`": each
renders as `<a href="mailto:ADDRESS">ADDRESS</a>`, with the href derived only from that atom's
own validated text (never invented, never any other slot) — nothing at all when the atom is
`null`. `version`, `date`, `communityLink`, `statusLink`, `link1`, `link2` and `link3` stay plain,
non-interactive text (a styled `<p>` or `<span>`) when present, and nothing when `null`; no
`<script>` and no other real destination appears anywhere on the page.

## Compile

```sh
node --experimental-strip-types -e '
import { validateDocsHubRecipe, renderDocsHub } from "./compiler/scripts/families/docs-hub/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateDocsHubRecipe(JSON.parse(readFileSync("compiler/scripts/families/docs-hub/reference.fixture.json", "utf8")));
writeFileSync("docs-hub-r1.html", renderDocsHub(recipe, {}));
'
```

Through the fast lane, pass `--family docs-hub` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/docs-hub/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (guide titles, API entries, versions, dates, support contacts)
with real ones and review the page against the client's own brand. A passing compile is a shape
check, not design quality.
