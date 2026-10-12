# storefront native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `storefront` family defined in
`compiler/scripts/families/storefront/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/storefront/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json`, `catalog.json` |
| `families/storefront/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/storefront/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |
| `fixtures/briefs/` | three natural-language briefs for the proficiency bar: `rich.txt` (direct hit), `near-miss.txt` (must stay `maren`, not `storefront`), `sparse.txt` (drops the optional sections) |

## Page kind, not a client site

`storefront` is a page KIND for atlas archetype CO.01 (Commerce): a fixed composition of eleven
vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`, MIT, commit
`ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference fixture is a
placeholder (a fictional Portland workwear label, "Tallow Row"). The collection grid and product
details sections are caption-only — this page kind has no images and no page-authored `<script>`
(the two reviewed GenUI effect placements are the only exceptions; see `catalog.json`). Its
Tailwind build is `css/storefront.css` (mirrored at `compiler/scripts/catalog/hyperui/storefront.css`),
compiled once by `scripts/build-ui-kit-css.ts storefront` and inlined.

## Honest buy/preorder destination

`buy-preorder` is the one section every storefront page always renders, because a storefront
exists to move a visitor to a buy or preorder decision — but it never fakes one. Its call to
action resolves, in order: a supplied `url` (a real external link), else a supplied `phone`
(a `tel:` link), else a supplied `email` (a `mailto:` link), else the label alone as plain text —
never a `#` placeholder. See `render.ts`'s `renderBuyPreorder`.

## Not `maren`, `marketing-site` or `listings`

Both `maren` and `storefront` sit on the same spine and archetype (`CO` · `CO.01`) but serve
different journeys: `maren` is a made-to-order atelier that takes orders only by phone or email,
with nothing to buy from a catalog; `storefront` is the catalog-buy family. A brief with no catalog
and no buy action, only "order by phone or email", stays `maren`. A software trial with pricing
tiers is `marketing-site`, not a shop. A directory of many independent listings from different
providers is `listings`, not one storefront's own catalog. See the family's summary in
`packages/agency-fast-lane/src/atlas/family-registry.json` for the full exclusion language, and
`fixtures/briefs/near-miss.txt` for a worked atelier brief that must stay `maren`.

## Rights and provenance

Every fact in `families/storefront/recipe.json` and
`compiler/scripts/families/storefront/reference.fixture.json` is fictional: no real label, product,
phone number or address is represented. The eleven HyperUI blocks the page composes are vendored
under MIT license; see `plugins/_official/shared/ui-kits/hyperui/LICENSE` and `UPSTREAM.json`. This
package ships no image, font or video assets, so `families/storefront/approved-assets.json` is
empty and there is no `media-provenance.json`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/storefront/render.test.ts
```
