# restaurant native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `restaurant` family defined in
`compiler/scripts/families/restaurant/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/restaurant/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/restaurant/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/restaurant/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`restaurant` is a page KIND for atlas archetype BA.02 (Restaurant or food business): a fixed
composition of eleven vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`,
MIT, commit `ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference
fixture is a placeholder (a fictional Seattle trattoria, "Vela Trattoria"). The gallery section is
caption-only — this page kind has no images and no `<script>`. Its Tailwind build is
`css/restaurant.css`, compiled once by `scripts/build-ui-kit-css.ts restaurant` and inlined.

## Rights and provenance

Every fact in `families/restaurant/recipe.json` and `compiler/scripts/families/restaurant/reference.fixture.json`
is fictional: no real restaurant, chef, menu, phone number or address is represented. The eleven
HyperUI blocks the page composes are vendored under MIT license; see
`plugins/_official/shared/ui-kits/hyperui/LICENSE` and `UPSTREAM.json`. This package ships no
image, font or video assets, so `families/restaurant/approved-assets.json` is empty and there is
no `media-provenance.json`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/restaurant/render.test.ts
```
