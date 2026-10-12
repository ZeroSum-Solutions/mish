---
name: agency-community-generator
description: Use the fixed community page kind to make a members' studio, club, coworking space or professional-community mock from a brief naming the community, who it is for, what members get and how a visitor joins.
version: 0.1.0
---

# community page kind

This is a page kind, not a decoded client site: its original poster layout uses a
fixed typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `LM` (Learning membership), archetype `LM.03` (Community or membership): shared
identity → member value → activity preview → norms → membership.

This is a **standing membership**, not a course: a shared studio, club, coworking space or
professional community that gives members ongoing access to a space and a group. A brief built
around a curriculum, instructors, cohorts or enrollment is a course or cohort (archetype LM.01,
family `emmpo`), not this family.

The supported path is **brief → community `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. There are no image or arbitrary destination slots.
The compiler owns responsive layout and geometric artwork. Header and tier links target real
sections. A supplied email enables a progressive details → review → email draft journey;
only the visitor's email app can send. The supplied phone remains a real telephone link.
With JavaScript disabled, contact links and native FAQ disclosures work. With no email or
phone, the page shows the missing contact details and does not simulate an application.
The one inline script uses an exact CSP hash; network and form submission remain blocked.

## The roster

Ten sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth):

1. `community-header` — the brand name, up to four compiler-owned section links, one join `cta`.
2. `community-hero` — `eyebrow` (who it is for),
   `heading`, `body`, the join `cta`, and the nullable `memberCount` fact.
3. `community-benefits` — a `heading` and four member benefits
   (`title`, `blurb`).
4. `community-tiers` — a `heading`, intro `body`, and three membership
   tiers (`name`, `description`, the nullable `price`, `cta`, three `features`).
5. `community-how-it-works` — a `heading` and three onboarding steps
   (`title`, `body`).
6. `community-events` — a `heading` and three upcoming
   events (`title`, the nullable `date`, `blurb`).
7. `community-voices` — **optional**: a `heading` and three member
   quotes (`quote`, `name`, `role`). The whole section may be `null` when the brief has no
   quotes.
8. `community-faq` — a `heading` and four questions (`question`,
   `answer`).
9. `community-join` — `heading`, `body`, `cta`, and two nullable facts:
   `phone`, `email`.
10. `community-footer` — `tagline`, three nullable `link1`/`link2`/
    `link3` facts, and the nullable `address`.

## Slots and limits

Start from `compiler/scripts/families/community/reference.fixture.json`. Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "community"`, a positive integer `revision`, the brand
`name` and `descriptor`, and the ten sections above in order, carrying only the slots
`contract.ts` accepts.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`.
- `price`, `date`, `memberCount`, `phone`, `email`, `link1`, `link2`, `link3` and `address` are
  nullable facts (`x-atom`): write `null` when the brief does not state one, and the page drops
  that element. Never invent a price, a member count, a date, a phone number, an email address
  or a link label. `email` must look like an email address; `phone` is checked by
  `isPhoneNumber` (`contract.ts`): an optional leading `+`, then digit runs separated by a single
  space, dot or hyphen, at most one `(` and one `)` (a `(` before the first digit run, or a
  `(...)` / `(...) ` pair around one group), 7-15 digits total, and nothing else — so a value
  padded with repeated or mixed separator punctuation, however many digits it carries, is refused.
- `phone` and `email`, when not null, render as real links: `phone` becomes `<a href="tel:...">`
  with only the filled value's digits (plus its own leading `+`, if it has one) — no other
  character survives into the href; `email` becomes `<a href="mailto:...">` with the filled
  address as-is. Both hrefs are derived only from the atom's own text, never invented. Tier and join actions are compiler-owned links or progressive controls; footer labels remain
  plain text because no destination is supplied for them.
- Repeat counts are exact. A `null` anywhere else is refused, with the field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateCommunityRecipe, renderCommunity } from "./compiler/scripts/families/community/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateCommunityRecipe(JSON.parse(readFileSync("compiler/scripts/families/community/reference.fixture.json", "utf8")));
writeFileSync("community-r1.html", renderCommunity(recipe, {}));
'
```

Through the fast lane, pass `--family community` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/community/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (the business, its members, prices, quotes) with real, verified
ones, and review the page against the client's own brand. A passing compile is a shape check,
not design quality.
