# crm-dashboard native example package

Native Mishh Mashh format is this folder's `SKILL.md` plus `mish.json`. The package carries
the shared compiler closure under `compiler/` and the `crm-dashboard` family registered in
`compiler/scripts/family.ts` (generic dispatch) and defined in
`compiler/scripts/families/crm-dashboard/`.

| Path | What it is |
| --- | --- |
| `mish.json` | the plugin manifest |
| `SKILL.md` | how to drive the family: roster, slots, limits and the compile command |
| `compiler/` | the offline compiler closure and the family's own source |
| `compiler/scripts/families/crm-dashboard/` | the family module: `contract.ts`, `slots.ts`, `recipe.schema.json`, `render.ts`, `render.test.ts`, `reference.fixture.json`, `tokens.json` |
| `families/crm-dashboard/recipe.json` | the package loader's default spine (`loadFamilyPackage`); a copy of the reference fixture |
| `families/crm-dashboard/approved-assets.json` | an empty `{version:1,assets:[]}` manifest — this family has no image assets |

## Page kind, not a client site

Unlike `agency-maben` and `agency-watson`, `crm-dashboard` is a page KIND — a fixed composition of
six vendored HyperUI `application/*` blocks (`plugins/_official/shared/ui-kits/hyperui/blocks/
application/{stats/1,tables/1,timelines/1,details-list/1,filters/1,charts/2}.html`, MIT, commit
`ae5038979b77320793360a46b85e7c71a73beda6`) rather than a decoded client homepage. There is no
private client data or compiled preview checked into this package beyond the reference fixture:
every business fact in it is a placeholder (a fictional sales org, "Anchor Pipeline").

The page has no images: the six vendored blocks carry no `<img>` once vendored (Task 1 strips
every image tag), so this family has no asset roster the way maben and watson do. It also has no
`<script>`: the chart is server-rendered inline SVG from the recipe's own numbers, and the filter
groups are native `<details>`/`<summary>` disclosures.

## Test

```sh
node --experimental-strip-types --test compiler/scripts/families/crm-dashboard/render.test.ts
```

## Rebuild the compiler closure

The shared compiler files (`assets.ts`, `compose.ts`, `family.ts`, `render.ts`, `schema.ts`,
`styles.ts`) and this copy's `compiler/scripts/families/registry.ts` are generated, not authored
here. From the repo root:

```sh
node --experimental-strip-types scripts/sync-agency-compiler.ts
node --experimental-strip-types scripts/sync-agency-compiler.ts --check
```

## Rights

This family reuses only MIT-licensed HyperUI HTML and CSS structure, rhythm and composition — no
HyperUI branding, copy or imagery ships. The reference fixture's company, people and numbers are
fictional placeholders, not a real client's data.
