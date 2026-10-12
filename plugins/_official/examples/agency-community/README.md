# community native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `open-design.json`. The package carries
the shared compiler closure under `compiler/` and the `community` family defined in
`compiler/scripts/families/community/`.

| Path | What it is |
| --- | --- |
| `open-design.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure (synced from `plugins/_official/shared/agency-compiler`) and the family's own source |
| `compiler/scripts/families/community/` | the family module: `slots.ts`, `contract.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json` |
| `families/community/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/community/approved-assets.json` | an empty `{version:1,assets:[]}` manifest: this family has no image assets |

## Page kind, not a client site

`community` is a page kind for atlas archetype LM.03 (Community or membership). Its fixed
content contract grew from ten pinned MIT HyperUI blocks; the current renderer authors its own
poster typography, rectilinear grid, monochrome geometric illustration and responsive layout.
Every business fact in the reference fixture is a placeholder (the fictional makers' studio
"Kiln Row Collective" in Bristol). It uses no client imagery or external fonts.

The portable renderer inlines the compiled HyperUI baseline (`css/community.css`) plus its
owned styles. Membership actions select a tier and open a two-step application when an email
address is supplied. The visitor reviews details, opens an email draft and sends it in their own
email app. Nothing submits from the page. Without JavaScript, supplied email and phone links
remain usable; FAQs use native disclosures. With no contact facts, the page says so. Its one
inline script is authorized by its exact SHA-256 CSP hash; network and form submission remain
blocked. See `QUALITY.md` for reference rationale and verification evidence.

## Rights and provenance

Every text slot in the reference fixture is invented for this package; no client content,
photography or brand asset is used or implied. The HyperUI blocks are MIT-licensed markup
vendored at a pinned upstream commit (see `plugins/_official/shared/ui-kits/hyperui/LICENSE` and
`UPSTREAM.json`); this package carries no image, font or other binary asset of its own
(`families/community/approved-assets.json` is empty). A generated page is a shape check against
this recipe contract, not a commercial clearance for any real business's name, copy or imagery.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/community/render.test.ts
```
