# guide native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `open-design.json`. The package carries
the shared compiler closure under `compiler/` and the `guide` family defined in
`compiler/scripts/families/guide/`.

| Path | What it is |
| --- | --- |
| `open-design.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/guide/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/guide/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/guide/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |
| `fixtures/` | three plain-text brief fixtures used for the family's build and routing checks: `rich-windward-point.txt` (every optional section supplied), `near-miss-tide-and-table.txt` (a recurring travel magazine — must NOT route here), `sparse-lowmoor-crossing.txt` (drops the optional sections) |

## Page kind, not a client site

`guide` is a page KIND for atlas archetype CS.01 (shared with `publication`): a fixed composition
of nine vendored HyperUI blocks (`plugins/_official/shared/ui-kits/hyperui/pagekinds.json`, MIT).
Every fact in the reference fixture is a placeholder for a fictional destination ("Windward
Point", a fictional fishing town on the fictional Amberlee Coast). There are no images and no
`<script>`. Its Tailwind build is `css/guide.css`, compiled once by `scripts/build-ui-kit-css.ts
guide` and inlined.

## Fits and does not fit

One destination — a city, region, trail or island — told as chapters plus practical facts, for a
visitor deciding whether to go. The visitor READS the place; there is no subscription, no issue
archive, no room or booking inventory and no reservations. An optional "plan a visit" section
links only to a supplied URL, never a booking flow. It must not be confused with `publication`
(a recurring title the visitor subscribes to — a magazine, newsletter or journal, not one place),
`halcyon` (one institution with a programme, hours and membership — a museum or gallery, not a
destination), or `listings` (many independent, separately searchable entities — a directory, not
one place's own chapters). A travel-themed hero with no real place content — no chapters, no
practical facts, nothing to read about the destination itself — is not a guide and stays
unrouted.

## Rights and provenance

Every fact in `families/guide/recipe.json` and
`compiler/scripts/families/guide/reference.fixture.json` is fictional: no real town, business,
person, phone number or address is represented. The nine HyperUI blocks the page composes are
vendored under MIT license; see `plugins/_official/shared/ui-kits/hyperui/LICENSE` and
`UPSTREAM.json`. This package ships no image, font or video assets, so
`families/guide/approved-assets.json` is empty and there is no `media-provenance.json`. The
gallery section is a pure CSS/typography treatment of named places — never a photograph, a stock
image or an external embed.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/guide/render.test.ts
```
