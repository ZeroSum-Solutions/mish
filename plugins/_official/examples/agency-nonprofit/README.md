# nonprofit native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `nonprofit` family defined in
`compiler/scripts/families/nonprofit/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/nonprofit/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/nonprofit/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/nonprofit/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`nonprofit` is a page KIND for atlas archetype MI.01 (Nonprofit or charity): a fixed composition
of twelve vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`,
MIT, commit `ae5038979b77320793360a46b85e7c71a73beda6`). Every business fact in the reference
fixture is a placeholder (a fictional river charity, "Riverkeepers Trust"). The
page has no images and no `<script>`. Its Tailwind build is `css/nonprofit.css`, compiled once by
`scripts/build-ui-kit-css.ts nonprofit` and inlined.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/nonprofit/render.test.ts
```
