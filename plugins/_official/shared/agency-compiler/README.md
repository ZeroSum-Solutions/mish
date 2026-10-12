# Agency Site shared compiler

`scripts/` holds the one canonical copy of the Agency Site compiler files that every copy of the
compiler shares: `assets.ts`, `compose.ts`, `effects.ts`, `family.ts`, `output-scope.ts`, `render.ts`,
`schema.ts`, `sections.ts` and `styles.ts`. `sections.ts` holds the optional-section helpers every family module uses to
render a dropped section (`null` in its slot) as nothing at all.

**Edit them here, never in a copy.** `node --experimental-strip-types scripts/sync-agency-compiler.ts`
copies them byte for byte into all seventeen copies and refreshes the matching entries in each one's
`compiler/COMMIT.json`. CI runs the same script with `--check`, which fails on any copy that has
drifted. A fix applied to a copy is overwritten by the next sync run.

The seventeen copies are the sixteen family packages under `plugins/_official/examples/agency-*/` and
`design-templates/agency-site/`, the production "New Project → Prototype → Agency Site" template
the daemon loads at runtime (`apps/daemon/src/artifacts/agency-recipe.ts`, `docs/agency-site.md`).

## The two directions

1. **Shared compiler files** flow from this folder to all seventeen copies.
2. **A family module a copy carries but does not own** flows **from the package named after that
   family** — `families/<family>/**` comes from `agency-<family>`. **A family module is authored
   only in the package named after it; any other copy is listed explicitly, in a table in
   `scripts/sync-agency-compiler.ts`, and overwritten by the sync.** The owning package is the
   source of truth for its family module: it is where that family's fixes land and where its
   reference fixture and preview are verified. Mirroring is one-way and additive, so a file only
   the carrier has (the template's `render.test.ts`, `tsconfig.json`, `benchmark.ts`, the resource
   builders) is that carrier's own authoring surface and is left alone; a file a carrier's copy
   holds that the owner does not ship is reported by `--check`, never deleted.

   The template's mirrors are `TEMPLATE_MIRRORS`: `families/emmpo/**` from `agency-emmpo`,
   `families/watson/**` from `agency-watson`. Every example package's mirrors are
   `PACKAGE_MIRRORS`:

   | Package | Carries (not owned) |
   |---|---|
   | `agency-app-shell` | — |
   | `agency-crm-dashboard` | — |
   | `agency-emmpo` | `watson` |
   | `agency-fervor` | `emmpo`, `watson`, `wrenfield` |
   | `agency-halcyon` | `emmpo`, `watson`, `wrenfield` |
   | `agency-listings` | — |
   | `agency-maben` | — |
   | `agency-maren` | `emmpo`, `watson`, `wrenfield` |
   | `agency-marketing-site` | — |
   | `agency-nonprofit` | — |
   | `agency-publication` | — |
   | `agency-watson` | `emmpo` |
   | `agency-wrenfield` | `emmpo`, `watson` |

   Neither table is inferred from directory names. A directory named `families/<family>/` in a
   package that does not own `<family>` is mirrored only because that package appears in
   `PACKAGE_MIRRORS` with `<family>` listed — never because of what the directory is named. This
   keeps a package free to author a second family module of its own without the sync mistaking it
   for a stale copy and overwriting it: planning cross-checks each package's table entry against
   what is actually on disk, and reports an error, before writing anything, for either direction of
   mismatch — a carried `families/<family>/` directory the table does not list, or a table entry
   with no matching directory. Add a package's first mirrored family (or its first family module of
   its own) by updating `PACKAGE_MIRRORS` (or removing an entry), not by adding or removing a
   directory and letting the sync guess.

## The generated registry

`family.ts` is shared, but the family roster is not: the packages' family-module sets have an
empty intersection, so no single set of static imports can serve them all. The sync script
therefore generates one file per copy, `scripts/families/registry.ts`, holding the static table of
the families that copy carries; `family.ts` dispatches through it. It is generated, not
hand-edited — add a family module under `families/` and re-run the sync.

The imports have to be static. `renderFamily` is called synchronously by the daemon, the fast lane
and the e2e suites, so the roster cannot be loaded with `await import()`; and `createRequire` of a
`.ts` file fails under the Playwright loader (`exports is not defined in ES module scope`), which
`e2e/ui/agency-site.test.ts` runs on.

`family.ts` is explicit trusted dispatch. A model family ID only ever selects a key in that static
table; it is never an import specifier, a filesystem path, or any other value the runtime resolves.
A family module exports `validate<Family>Recipe(input: unknown)` (a typed recipe with an integer
`revision` and `brand.name`), `get<Family>AssetRequirements(recipe)` (`AssetRequirement[]`) and
`render<Family>(recipe, resolvedAssetPaths, options)` (an HTML string).

## Output scope

`output-scope.ts` says whether a rendered page is a working site or a static prototype. App and
dashboard families render the look of an application (navigation, forms, tabs, table controls)
under `script-src 'none'`, so none of those controls do anything. Such a page says so in the
artifact itself.

There is one source: the family registry's `pageKind`
(`packages/agency-fast-lane/src/atlas/family-registry.json`), mapped by the fast lane's
`outputScopeOfPageKind`. The daemon, `od` and the web read it at runtime through `outputScopeOf`.
A packaged compiler runs without `node_modules`, so the sync writes the same value into each
copy's generated `families/registry.ts` (`outputScope` on every row), and `--check` fails when it
drifts. `renderFamily` supplies that value to the family render. The render emits the note from it
(`outputScopeNote`). `assertRenderedOutputScope` then checks that the page declares exactly the
supplied scope (one note for a static prototype, none for a site) and throws otherwise. Slot text
is always HTML-escaped, so no slot can forge the marker. The manifest's
`metadata.agencySite.outputScope` is written from the supplied value, never read back out of the
HTML, so a page and its manifest cannot disagree.

## Effect placements

`effects.ts` applies reviewed GenUI catalog components to a rendered page. A family opts in with an
`effects` object in `families/<family>/catalog.json`:
`{scriptPolicy, maxEffects, placements: {<placement>: {host: {id} | {odId}, allow: [ids]}}}`.
Each host is a real element that always renders (never inside an optional section), each allowed
id is in `catalogComponents` (so the sync copies it), and a `scriptPolicy: "none"` family allows
only `css-only` components. `hash` is for the HyperUI families, which ship `script-src 'none'`;
`inline` is for the hand-crafted families, which already ship `script-src 'unsafe-inline'`.
Components that need their own child markup (galleries, stacks, the chat input, the video hero)
are never allowed: no family host is shaped for them.

`renderAgencySite(input, entry, approvedManifest, { effects, compose })` passes the plan to
`renderFamily`, which renders as usual, runs the caller's `compose` (the fast lane splices its
selected section there), and then calls `applyEffectPlan` on that composed page. This is the only
place effects are fitted to the byte budget:

- Each item must be allowed for its placement, fit the script policy and `maxEffects`, and find
  its host exactly once, on an open tag with no `data-genui` and no `genui-*` class token (a
  family may mount a component by its class alone). Otherwise it is skipped with a fixed
  reason (`not-allowed`, `script-policy`, `max-effects`, `host-missing`, `host-occupied`,
  `incompatible` for an ambiguous host or a repeated placement).
- The host gets `genui-<id>` merged into its class and `data-genui="<id>"`. No options and no
  custom properties in v1, so every component runs on its catalog defaults.
- The component CSS is inlined once before `</head>`; for a `js` component, `auto.js` is inlined
  once before `</body>` as a module script. A component the family already inlines is reused.
- On a `hash` page, `script-src 'none'` becomes `'sha256-<base64>'` of the exact inlined script
  text (CSP3 hash source). The directive is rebuilt from tokens, not pattern-replaced. A css-only plan leaves the CSP untouched.
- The final page must be strictly below `PAGE_BYTE_LIMIT` (200 KiB) UTF-8 bytes. Effects are
  dropped in `EFFECT_DROP_ORDER` (section-reveal first, hero-title last) and reported as
  `byte-budget`. A base page already at the limit throws `PageByteLimitError`
  (`code: 'page-too-large'`). A render with no plan is not checked here. The fast lane
  (`packages/agency-fast-lane/src/effects.ts`) maps a `PageByteLimitError` from its final render to
  its own `PageTooLargeError` (same code, same byte count) and throws that class for a final page
  with no plan at or over the limit too; the build fails and publishes nothing.
- `none` and the placement ids are reserved: a declaration that lists one in `allow` fails to load.

Hosts, `</head>` and `</body>` come from a small structural tag scan that skips comments and
raw-text elements (script, style, title, ...), the same rules as
`packages/contracts/src/runtime/html-injection-points.ts`. A packed compiler cannot import that
workspace package; `tests/effects.test.ts` checks both agree on every insertion point.
`componentKind` reads the `kind` that `sync-catalog-assets.ts` writes into `catalog/CATALOG.json`.

## Frozen package budget

`design-templates/agency-site/SKILL.md` lists the compiler's runtime closure under "Portable
compiler resources". The daemon freezes exactly those files into an OD Next Skill package
(`apps/daemon/src/strategies/od-next/frozen-skill-package.ts`). **A new shared file that `family.ts`,
`render.ts` or `compose.ts` imports must be added to that list**, or the materialized compiler
fails with `ERR_MODULE_NOT_FOUND`.

The whole package is capped at 1.5 MiB (`MAX_PACKAGE_BYTES`). The cap leaves headroom for the
GenUI catalog components the compiler inlines (`scripts/catalog-block.ts` and the synced
`scripts/catalog/` assets). The daemon persists the package in SQLite and materializes it under
`.od-skills`; the ACP prompt carries only Skill text and a digest roster, never side-file bytes.
So the 1 MiB ACP prompt-frame limit is a separate risk: it applies to prompt text, not to this
package. Agency Site plus the three reference studies (`agency-emmpo`, `agency-watson`,
`agency-cult-heroes`) is the largest shipped selection.
`apps/daemon/tests/agency-reference-skills.test.ts` freezes that selection, checks that it keeps
the catalog files and at least 256 KiB of headroom, and fails otherwise. So every shipped
compiler file keeps its comments to short pointers, and rationale lives in this README, which is
never frozen.

## What stays copy-owned

- `compiler/scripts/families/<family>/**` in `agency-<family>` — a family's own package, the one
  place its contract, slots, render, CSS, tokens, schema and fixture are authored. The same path
  shape in a package that does not own that family is a mirror, kept in step by the sync (see
  above), not an authoring surface. `registry.ts` sits beside these, never inside one.
- `compiler/FAMILY-PATCH.json` — the reviewed patch record for family sources. It records no
  shared-file hash, so the sync script leaves it alone.
- `families/`, `preview/`, `assets/`, `README.md`, `SKILL.md`, `mish.json`.

This folder is not a plugin: it has no `mish.json`, so the daemon's bundled-plugin walker
(`apps/daemon/src/plugins/bundled.ts`) never registers it. It is also not runnable on its own —
`family.ts` imports the `families/registry.ts` that only exists in a copy.

Packages are installed packed, without `node_modules`, and run outside the workspace, so they
cannot import a shared workspace package. A copied file plus a drift check is what keeps them
self-contained and still in step.
