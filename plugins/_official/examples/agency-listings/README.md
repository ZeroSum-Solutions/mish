# listings native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `listings` family defined in
`compiler/scripts/families/listings/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/listings/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/listings/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/listings/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`listings` is a page KIND for atlas archetype SM.02 (Directory or listings): a fixed composition
of twelve vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`,
MIT, commit `ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference
fixture is a placeholder (a fictional coastal lettings directory, "Harbourline Homes"). The
results, comparison and featured items are `x-mock` sample data shown under a fixed, visible
template caption (`SAMPLE_DATA_CAPTION` in `slots.ts`, not a recipe slot); `phone`, `email` and `address` are nullable; `listings-reviews` is optional. The
page has no images and no `<script>`. Its Tailwind build is `css/listings.css`, compiled once by
`scripts/build-ui-kit-css.ts listings` and inlined.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/listings/render.test.ts
```
