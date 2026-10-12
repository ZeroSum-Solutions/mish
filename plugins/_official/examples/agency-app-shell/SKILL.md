---
name: agency-app-shell-generator
description: Use the fixed app-shell page kind to make a static web-app shell mock from a brief naming the tool, its navigation, a five-row list, one detail record and (optionally) its settings sections.
version: 0.1.0
---

# app-shell page kind

This is a page kind, not a decoded client site: it composes six vendored HyperUI `application/*`
blocks into one fixed layout with a typed-slot contract, the same shape the seven Agency Site
families use (`contract.ts`, `slots.ts`, `recipe.schema.json`, `render.ts`). It is registered in
`packages/agency-fast-lane/src/atlas/family-registry.json` under spine `TU` (Task utility),
archetype `TU.01` (Web application or dashboard).

The supported path is **brief → app-shell `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The family has a fixed section roster and order;
the assistant configures named text slots only. There are no image or destination slots: the six
vendored blocks carry no `<img>` and the page has no external links beyond `#`.

## The roster

Six sections, in this order, every id stable:

1. `app-shell-topnav` — one top nav (`application/vertical-menu/1`, styled as a horizontal bar):
   exactly four `links` plus one `user` label.
2. `app-shell-sidenav` — exactly four nav groups (`application/side-menu/1`): `heading` plus
   exactly three `links` each. Groups 3 and 4 may each be `null` when the brief states no such
   group; the whole group is dropped, not rendered empty.
3. `app-shell-empty` — one empty state (`application/empty-states/1`): `heading`, `body`, `cta`.
   Required.
4. `app-shell-list` — one heading plus exactly five list rows (`application/tables/2`): `name`,
   `status`, `owner`, `updated` each.
5. `app-shell-detail` — one heading plus exactly five label/value pairs
   (`application/details-list/2`).
6. `app-shell-settings` — exactly three settings sections, rendered as a static tab strip
   (`application/tabs/1`, first tab shown selected, no script): `heading`, `body` each. Any of
   the three may be `null` when the brief has no such section to show; that section is dropped
   entirely, not rendered empty.

The section count and order are fixed. Section mixing is not supported.

## Slots and limits

Start from `compiler/scripts/families/app-shell/reference.fixture.json` as the finite reference
fixture (64 text slots once rendered — 62 across the six sections, plus the two reconcilable
brand slots, `brand--name` and `brand--descriptor`, which always render). Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "app-shell"`, a positive incremented integer
`revision`, the two brand text fields (`name`, `descriptor`), and the six section ids above in
order, carrying only the slots `compiler/scripts/families/app-shell/contract.ts` accepts.

- Text slots are plain text and bounded. Markup, HTML entities and control characters are
  rejected, and every slot names its own character limit in `compiler/scripts/families/
  app-shell/recipe.schema.json`.
- Repeat counts are exact: 4 top-nav links, 4 side-nav groups (2 and 3 of them nullable) with 3
  links each, 5 list rows, 5 detail pairs, 3 settings sections (each independently nullable).

Unknown fields, markup, wrong repeat counts, and a `null` anywhere the contract does not allow
it (side-nav groups 3 and 4, or any settings section) are rejected, each with the offending
field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateAppShellRecipe, renderAppShell } from "./compiler/scripts/families/app-shell/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateAppShellRecipe(JSON.parse(readFileSync("compiler/scripts/families/app-shell/reference.fixture.json", "utf8")));
writeFileSync("app-shell-r1.html", renderAppShell(recipe, {}, { outputScope: "static-prototype" }));
'
```

Through the fast lane, pass `--family app-shell` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/app-shell/render.test.ts
```

## Before a client sees it

Replace every placeholder business fact (the tool, its people, its numbers) with real, verified
ones, and review the candidate against the client's own brand materials. A passing compile is a
shape check. It is not design quality.
