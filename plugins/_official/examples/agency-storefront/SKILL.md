---
name: agency-storefront-generator
description: Use the fixed storefront page kind to make a static retail storefront mock (a fashion label, single-SKU shop, hardware preorder or digital drop sold as goods) from a brief naming the business, its product(s) and how a visitor buys or preorders.
version: 0.1.0
---

# storefront page kind

This is a page kind, not a decoded client site: it composes eleven vendored HyperUI blocks into
one fixed layout with a typed-slot contract (`contract.ts`, `slots.ts`, `recipe.schema.json`,
`render.ts`). It is registered in `packages/agency-fast-lane/src/atlas/family-registry.json`
under spine `CO` (Commerce), archetype `CO.01`: merchandise, buy or preorder, no live cart, no
payment block.

The supported path is **brief → storefront `schemaVersion: 2` typed recipe → executable
validation → trusted compiler → static HTML**. The section roster and order are fixed; the
assistant configures named text slots only. There are no image slots and no page-authored
`<script>` (the two reviewed GenUI effect placements in `catalog.json` are the only script/CSS
this page kind carries beyond its inlined Tailwind build).

## Not `maren`, `marketing-site` or `listings`

`storefront` and `maren` share a spine and archetype but are different journeys: a made-to-order
atelier that takes orders only by phone or email, with no catalog to buy from, stays `maren`, not
`storefront`. A software trial with pricing tiers is `marketing-site`. A directory of many
independent listings from different providers is `listings`. Pick `storefront` only when the
brief has real merchandise (one product or a short catalog) and a buy or preorder action.

## The roster

Ten sections, in this order, every id stable (`slots.ts` `SECTIONS` is the source of truth); five
required, five optional (dropped, with their nav link, when the brief lacks the facts):

1. `storefront-header` (`application/tabs/4` + `application/tabs/5`) — **required**: the brand
   name, one buy `cta` anchored to `storefront-buy-preorder`. The nav itself is fixed chrome, not
   a text slot: one fixed "Shop" label (`render.ts`'s `FEATURED_NAV_LABEL`) always anchored to the
   featured-product section, plus one more nav link — its label from the fixed `NAV_LABELS` map,
   never model text — for each optional section below that survives, up to three.
2. `storefront-hero` (`marketing/sections/4`) — **required**: `eyebrow`, `heading`, `body`. No
   hero call to action — `storefront-buy-preorder` below is the one honest action; a second
   button here would either repeat it or invent a destination.
3. `storefront-featured-product` (`marketing/pricing/1`) — **required**: a `heading`, the anchor
   product's `name` and `description`, and a nullable `price` (never invent one).
4. `storefront-collection-grid` (`marketing/feature-grids/3`) — **optional**: a `heading` and
   exactly four more products (`name`, `blurb`, nullable `price`). Drop whenever the brief names
   fewer than four more products beyond the featured one — including a one-product brief. Never
   pad to four with an invented item; a catalog of two or three extra products still drops this
   section rather than fabricating a fourth.
5. `storefront-product-details` (`application/details-list/1`) — **optional**: a `heading` and
   three spec rows (`label`, `value`: material, sizing, care, origin). Drop when the brief gives
   no such facts.
6. `storefront-buy-preorder` (`marketing/ctas/1`) — **required, honest destination**: `heading`,
   `body`, `ctaLabel`, and three nullable facts `url`, `phone`, `email`. The rendered call to
   action resolves in order: a supplied `url` wins (a real external link); else a supplied
   `phone` renders a `tel:` link; else a supplied `email` renders a `mailto:` link; when none of
   the three is supplied the section still renders — its heading and body stand, since this is a
   required section — but the call to action is `ctaLabel` as plain text, never a `#` placeholder
   or any other fake or dead link. `url`, `phone` and `email` are destination data only: unlike
   every other nullable fact in this family, they never carry their own visible text or
   `data-od-id` — at most one of them becomes the single rendered link.
7. `storefront-shipping-returns` (`marketing/sections/1`) — **optional**: `heading`, `body`. Drop
   when the brief states no shipping, delivery, preorder-timing or returns policy.
8. `storefront-reviews` (`marketing/testimonials/3`) — **optional**: a `heading` and exactly two
   reviews (`title`, `quote`, `name`). Drop when the brief has no buyer reviews.
9. `storefront-story-about` (`marketing/sections/3`) — **optional**: `heading`, `body`: the
   maker, brand or label's own story. Drop when the brief gives none.
10. `storefront-footer` (`marketing/footers/4`) — **required**: `tagline` and the nullable facts `phone` (a `tel:` link), `email` (a `mailto:` link) and `address`
    (plain text). Its link list is fixed chrome: the same section labels as the header nav.

## Slots and limits

Start from `compiler/scripts/families/storefront/reference.fixture.json`. Create a fresh recipe
with exactly `schemaVersion: 2`, `family: "storefront"`, a positive integer `revision`, the brand
`name` and `descriptor`, and the ten sections above in order — a dropped optional section is
`null` in its slot, carrying only the slots `contract.ts` accepts otherwise.

- Text slots are plain text and bounded; markup, HTML entities and control characters are
  rejected. Every limit is in `recipe.schema.json`.
- `price`, `address`, `phone`, `email` and `url` are nullable facts (`x-atom`): write `null` when
  the brief does not state one. For every atom except `storefront-buy-preorder`'s `url`/`phone`/
  `email`, the page drops that element entirely when null — no empty link, no bare label. Never
  invent a price, address, phone number, email or URL.
- `email` must look like an email address; `phone` is checked by tokenizing (see
  `agency-restaurant`'s `SKILL.md` for the exact rule — this family reuses it verbatim); `url`
  must start with `http://` or `https://` (a bare domain, a `mailto:` or a `tel:` value is
  refused — use the `email`/`phone` atoms for those).
- Repeat counts are exact. A `null` anywhere else is refused, with the field named.

## Compile

```sh
node --experimental-strip-types -e '
import { validateStorefrontRecipe, renderStorefront } from "./compiler/scripts/families/storefront/render.ts";
import { readFileSync, writeFileSync } from "node:fs";
const recipe = validateStorefrontRecipe(JSON.parse(readFileSync("compiler/scripts/families/storefront/reference.fixture.json", "utf8")));
writeFileSync("storefront-r1.html", renderStorefront(recipe, {}));
'
```

Through the fast lane, pass `--family storefront` to `packages/agency-fast-lane/src/cli.ts`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/storefront/render.test.ts
```

## Before a client sees it

Replace every placeholder fact (the business, products, prices, policies, reviews) with real,
verified ones, and review the page against the client's own brand. A passing compile is a shape
check, not design quality.
