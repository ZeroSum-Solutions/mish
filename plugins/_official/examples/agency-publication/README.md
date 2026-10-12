# publication native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `open-design.json`. The package carries
the shared compiler closure under `compiler/` and the `publication` family defined in
`compiler/scripts/families/publication/`.

| Path | What it is |
| --- | --- |
| `open-design.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/publication/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/publication/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/publication/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`publication` is a page KIND for atlas archetype CS.01 (Publication or media): a fixed composition
of ten vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`,
MIT, commit `ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference
fixture is a placeholder (a fictional farming magazine, "Field Notes Weekly"). The
page has no images and no `<script>`. Its Tailwind build is `css/publication.css`, compiled once by
`scripts/build-ui-kit-css.ts publication` and inlined.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/publication/render.test.ts
```
