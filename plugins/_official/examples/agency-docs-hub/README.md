# docs-hub native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `docs-hub` family defined in
`compiler/scripts/families/docs-hub/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/docs-hub/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/docs-hub/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/docs-hub/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`docs-hub` is a page KIND for atlas archetype CS.02 (Documentation or knowledge base): a fixed
composition of ten vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`,
MIT, commit `ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference
fixture is a placeholder (a fictional developer tool, "Loomwork"). The page has no images and no
`<script>`. Its Tailwind build is `css/docs-hub.css`, compiled once by
`scripts/build-ui-kit-css.ts docs-hub` and inlined.

## Rights and provenance

No image, font or video assets ship with this family (`families/docs-hub/approved-assets.json` is
empty), so there is no `media-provenance.json`. The only third-party material this page kind
carries is the vendored HyperUI markup and its compiled Tailwind CSS, both MIT-licensed under
`plugins/_official/shared/ui-kits/hyperui/LICENSE` and `UPSTREAM.json`. The reference fixture's
product name, guide titles, API entries, changelog and contact details are all invented
placeholders, not a decoded client site and not commercial clearance for any real product.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/docs-hub/render.test.ts
```
