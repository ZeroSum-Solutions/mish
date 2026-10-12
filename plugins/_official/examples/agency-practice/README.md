# practice native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `practice` family defined in
`compiler/scripts/families/practice/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/practice/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/practice/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/practice/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |
| `fixtures/` | three plain-text brief fixtures used for the family's build and routing checks: `rich-dental.txt` (every optional section supplied), `near-miss-design-studio.txt` (must NOT route here), `sparse-vet.txt` (drops the optional sections) |

## Page kind, not a client site

`practice` is a page KIND for atlas archetype TL.01 (Local appointment business, also closely
related to TL.02 Healthcare or aesthetic practice): a fixed composition of twelve vendored HyperUI
blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`, MIT). Every business fact in
the reference fixture is a placeholder (a fictional Portland dental practice, "Willow Creek Family
Dental"). There are no images and no `<script>`. Its Tailwind build is `css/practice.css`,
compiled once by `scripts/build-ui-kit-css.ts practice` and inlined.

## Fits and does not fit

A public site for a local clinical or appointment practice (dental, veterinary, medical
specialist, physiotherapy, aesthetics or med-spa) whose visitor judges fit and books a real
appointment. Not a signed-in patient portal. It is not a studio or consultancy (`watson`), an
agency reel (`fervor`), a property or remodeling estimate (`wrenfield`, `maben`), a restaurant
table reservation (`restaurant`), a visited membership institution (`halcyon`), or a working app
or dashboard screen (`app-shell`, `crm-dashboard`).

## Rights and provenance

Every fact in `families/practice/recipe.json` and
`compiler/scripts/families/practice/reference.fixture.json` is fictional: no real practice,
provider, patient, phone number or address is represented. The twelve HyperUI blocks the page
composes are vendored under MIT license; see `plugins/_official/shared/ui-kits/hyperui/LICENSE`
and `UPSTREAM.json`. This package ships no image, font or video assets, so
`families/practice/approved-assets.json` is empty and there is no `media-provenance.json`.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/practice/render.test.ts
```
