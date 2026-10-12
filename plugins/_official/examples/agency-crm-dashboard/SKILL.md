---
name: agency-crm-dashboard-generator
description: Use the fixed crm-dashboard page kind to make a static CRM dashboard mock from a brief naming the KPIs, pipeline, contact and (optionally) activity and chart numbers a sales or service team would see.
version: 0.1.0
---

# crm-dashboard page kind

This is a page kind, not a decoded client site: it composes six vendored HyperUI `application/*`
blocks into one fixed layout with a typed-slot contract, the same shape the seven Agency Site
families use (`contract.ts`, `slots.ts`, `recipe.schema.json`, `render.ts`). It is registered in
`packages/agency-fast-lane/src/atlas/family-registry.json` under spine `TU` (Task utility),
archetype `TU.01` (Web application or dashboard).

The supported path is **brief → crm-dashboard `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The family has a fixed section roster and order;
the assistant configures named text slots only. There are no image or destination slots: the six
vendored blocks carry no `<img>` and the page has no external links.

## The roster

Six sections, in this order, every id stable:

1. `crm-dashboard-kpis` — a strip of exactly four KPI cards (`application/stats/1`): `label`,
   `value`, `delta` each. The first two KPIs are required; the third and fourth are secondary
   KPIs and may each be `null` when the brief states no such fact — the whole card is dropped,
   not rendered empty.
2. `crm-dashboard-pipeline` — one heading plus exactly five pipeline rows
   (`application/tables/1`): `company`, `owner`, `stage`, `value`, `nextStep` each.
3. `crm-dashboard-activity` — exactly six activity items (`application/timelines/1`): `when`,
   `who`, `what` each. The whole feed may be `null` when the brief has no activity to show; the
   section is dropped entirely, not rendered as an empty timeline.
4. `crm-dashboard-contact` — one contact card (`application/details-list/1`): `name`, `role`,
   `company`, `email`, `phone`, `note`.
5. `crm-dashboard-filters` — two fixed option groups (`application/filters/1`): four owner
   options, five stage options. Plain text labels; there is no live filtering behavior.
6. `crm-dashboard-chart` — one inline SVG bar chart from exactly eight values
   (`application/charts/2`, rendered as bars, not the source's `<canvas>`): a `title`, a `unit`,
   and eight `{ label, value }` bars. The whole chart may be `null` when the brief has no numbers
   to chart; the section is dropped entirely.

The section count and order are fixed. Section mixing is not supported.

## Slots and limits

Start from `compiler/scripts/families/crm-dashboard/reference.fixture.json` as the finite
reference fixture (62 to 82 text slots once rendered — 60 to 80 across the six sections,
depending on which nullable atoms are present, plus the two reconcilable brand slots,
`brand--name` and `brand--descriptor`, which always render). Create a fresh recipe with exactly
`schemaVersion: 2`, `family: "crm-dashboard"`, a
positive incremented integer `revision`, the two brand text fields (`name`, `descriptor`), and the
six section ids above in order, carrying only the slots `compiler/scripts/families/crm-
dashboard/contract.ts` accepts.

- Text slots are plain text and bounded. Markup, HTML entities and control characters are
  rejected, and every slot names its own character limit in
  `compiler/scripts/families/crm-dashboard/recipe.schema.json`.
- The contact card's `email` and `phone` are format-checked.
- A chart bar's `value` is a finite number from 0 to 1,000,000, not a text slot: it drives the
  bar's height and is not independently reconcilable the way `label` is.
- Repeat counts are exact: 4 KPIs, 5 pipeline rows, 6 activity items (or the whole feed `null`),
  4 owner filter options, 5 stage filter options, 8 chart values (or the whole chart `null`).

Unknown fields, markup, wrong repeat counts, and a `null` anywhere the contract does not allow it
(the first two KPIs; a chart with `text` null but `items` non-null, or the reverse) are rejected,
each with the offending field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateCrmDashboardRecipe, renderCrmDashboard } from "./compiler/scripts/families/crm-dashboard/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateCrmDashboardRecipe(JSON.parse(readFileSync("compiler/scripts/families/crm-dashboard/reference.fixture.json", "utf8")));
writeFileSync("crm-dashboard-r1.html", renderCrmDashboard(recipe, {}, { outputScope: "static-prototype" }));
'
```

Through the fast lane, pass `--family crm-dashboard` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/crm-dashboard/render.test.ts
```

## Before a client sees it

Replace every placeholder business fact (company names, people, numbers) with real, verified
ones, and review the candidate against the client's own brand materials. A passing compile is a
shape check. It is not design quality.
