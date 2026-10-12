# Owned example replacement record

Scope: the 18 disputed example packages named in `NOTICE`, at baseline
`f65f2117dc930aaeb22137a606ac1522c06717a6`. Worktree:
`codex/t8-motionsites-owned`. Review date: 2026-10-09. Fetched main was
`31f4a9fdb10116c982f4262ef60f91453f4464e8`, three commits ahead of the worker
baseline with application changes. The requested branch was retained. GitHub
had five open PRs at the freshness check; no running app belonged to this worktree.

Eight replacements are complete. The remaining ten retain their disputed
metadata and attribution. This is a partial replacement, not clearance of the
entire catalogue or historical distributions.

## Method and boundary

The input to each replacement is an industry, a section-role list and interaction
ideas. Original HTML was inspected mechanically for section roles, not reused as
implementation input. No source-site browsing, screenshots, external media or
source prompts were used to build these replacements. Each new example has fresh
fictional branding, copy, layout, inline SVG drawings and browser behavior.

The paused run had eight uncommitted replacement drafts. They were preserved in
ignored worktree scratch, then rechecked and refined from the current checkout.
Their existence was not treated as completion or proof. The new examples replace
the source HTML and generation instructions together, including localized prompts.
Every replacement carries a package-local `RIGHTS.md`.

### Provenance limits

These limits are stated so the owned claim is not overstated. (1) Each brief reuses the original package's section-role list one for one; roles are generic ideas, but the order mirrors the original. (2) The eight drafts started in an earlier session that was paused; its prompts and intermediate outputs were not recorded, so their exact inputs cannot be shown. They were rechecked and refined from the current checkout, and no original markup, CSS, copy, media or script appears in the result. (3) Bundled fonts are third-party SIL OFL 1.1 files, listed in each package's `RIGHTS.md` and `assets/OFL.txt` and in the root `NOTICE`.

Owned describes the new template work. It does not describe the bundled fonts:
Archivo and Bodoni Moda were copied from the then-vendored `agency-emmpo` assets
(that package is not part of this public repository; the copies now live in each
replacement's `assets/`);
IBM Plex Mono comes from `apps/web/public/fonts`. Copies retain the complete SIL
OFL notices beside the bytes. It also does not change rights to old Git revisions,
old installed resources, cached clips or previously distributed builds.

## Exposure and execution order

Baseline literal searches for all 18 full package IDs under `apps/`, `packages/` and
`plugins/` found **one app reference each**, in
`apps/daemon/tests/fixtures/workbench/local-inventory.json`. There are no
ID-specific production app references or curator pins for these 18.
Package-local manifest/SKILL references are self-references, not independent
exposure. The historical MotionSites restore note also lists them.

All 18 have the same generic discovery path:

- `apps/daemon/src/plugins/bundled.ts` walks official tiers and registers manifests.
- `apps/web/src/components/HomeHero.tsx` filters example presets by tags/mode,
  applies gallery ordering and caps most chip rails at 18. Prototype ordering
  excludes usage popularity; other chips may use it. The final tie is title order.
- `apps/web/src/components/plugins-home/curatedPriority.ts` has no pins for these IDs.
- `apps/web/src/components/PluginLoopHome.tsx` lists plugins and sorts query-backed
  scenarios before a title tie-break.
- `apps/web/src/components/PluginsView.tsx` and `CommunityTemplatePreview.tsx`
  consume manifest metadata, rather than hardcoding these IDs.
- `apps/daemon/src/routes/plugins/assets.ts` serves the HTML preview and rewrites
  its local asset URLs. `apps/daemon/src/plugins/duplicate-project.ts` collects
  `od.useCase.exampleOutputs` for a project seed.

No live user-usage evidence is available in this idle worktree. A code-reference
count is not a usage count. Static exposure is tied, so replacement order uses
ascending package ID as a reproducible tie-break: acreage, aerocore, AI portfolio,
cinematic, codenest, dreamcore, evergreen, innovation. This does not claim those
are the eight most-used examples. Quality review is bounded to these eight.

## Inventory of the original packages

Section labels below are abstract roles. They describe purpose and behavior, not
source text or implementation instructions. All IDs have the `example-` prefix.
The reference column names the line of the one literal app-ID reference; the
shared discovery paths above apply to every row.

| Package | Industry / purpose | Original section roles | Original motion / interaction | Fixture line | Status |
|---|---|---|---|---:|---|
| acreage-farming | Precision agriculture product | Hero; platform; metrics; services; enquiry; footer | Background film; metric entry; scrolling logo strip | 351 | Owned |
| aerocore | Aerospace propulsion engineering | Hero; company; technology; solutions; differentiation; team; footer | Scroll parallax; expanding film; pinned selection; chart reveal; horizontal stories | 365 | Owned |
| ai-designer-portfolio | Creative studio / designer portfolio | Hero; endorsement; offers; reviews; projects; contact; footer | Moving image strip; parallax; automatic carousel; pointer trail; floating navigation | 407 | Owned |
| cinematic-landing-page | B2B food / ingredient supplier | Hero; product gallery; company story; partners; features; offices | Scroll-driven film selection; shaped transition; letter reveal; masonry; animated illustrations | 1527 | Owned |
| codenest-coding-platform | Coding education | Hero; navigation; learning CTA | Atmospheric backdrop; translucent panel; mobile menu | 1625 | Owned |
| dreamcore-landing | Imaginary travel / immersive destination showcase | Entrance; portal; destination chooser | Scroll zoom; entrance curtains; curved destination slider | 2451 | Owned |
| evergreen-finance | Personal finance product | Hero; account overview; customer story; features | Alternating film playback; blurred entry; floating chart panels | 2619 | Owned |
| innovation | Creative / strategy agency | Hero; about; project film; philosophy; services | Film crossfade; translucent navigation; section entry | 4019 | Owned |
| layered-depth | Architecture studio | Architectural hero; second editorial scene | Layered parallax; background film; animated foreground; glass panels | 4117 | Disputed; left |
| liquid-glass-agency | AI web-design agency | Hero; introduction; services; work; process; pricing; CTA | Background films; word reveal; translucent panels; staged storytelling | 4145 | Disputed; left |
| luxury-botanical | Fragrance brand | Hero; bottle collection; newsletter; footer | Shaped scroll reveal; rotating product carousel; focal scaling | 4327 | Disputed; left |
| mindloop-landing | Newsletter / content platform | Hero; how it works; mission; use cases; subscription; footer | Background film; progressive word reveal; translucent controls | 5181 | Disputed; left |
| mythic-naturecore | Fantasy world / nature experience | Entrance; portal; layered world | Long scroll zoom; parting curtains; pointer-driven depth | 5307 | Disputed; left |
| nimbus-grid | Secure cloud storage | Hero console; platform; pricing; security; plans; operations | Typing; sticky accordion; changing bar field; console tilt; exploding cube | 5433 | Disputed; left |
| orbis-nft | Digital art collection | Hero; gallery; acquisition; contact | Background films; translucent controls | 5615 | Disputed; left |
| portfolio-cosmic | Designer portfolio | Hero; works; résumé; exploration; metrics; contact | Loading count; pinned parallax gallery; scrolling footer text | 5755 | Disputed; left |
| skyelite-private-jets | Private aviation service | Hero; navigation; discovery / booking CTA | Background film; mobile navigation dropdown | 6637 | Disputed; left |
| stellar-launch | Venture award / founder prize | Hero; submission categories; founder information | Shaped CTA; moving nomination scene; metric entry | 6847 | Disputed; left |

Bare slugs also occur in the separate on-demand MotionSites reference integration:
`dreamcore-landing` in `packages/contracts/tests/motionsites.test.ts` and
`apps/daemon/tests/motionsites-bridge.test.ts`; `dreamcore-landing`,
`innovation-landing` and `portfolio-cosmic-hero` in the agency fast-lane catalogue
profiling script and route corpus. Those are external discovery identities, not
references to the bundled `example-*` packages. Their semantics were not changed.

## Replacement briefs and design decisions

The brief column is the complete behavior/structure source for the replacements.
The design column records new decisions. Typography uses the bundled design skill's
craft guidance: clear scale, readable body text, local font pairing and focus.
Motion uses short feedback and one-time section entry; reduced motion disables
animation. These craft rules do not import a reference site's composition.

| Package / new fictional name | Brief: purpose, sections, interactions | New design decisions |
|---|---|---|
| acreage-farming / Fieldnotes | Farm planning: field-map hero; seasonal workflow; FAQ; trial enquiry. Select a field to inspect crop and next job. | Green agronomic map plate with hand-drawn zones; serif split hero; numbered work rows; one-shot location pulse. |
| aerocore / Vector | Propulsion studio: technical introduction; diagram; engineering stages; brief specifications; capabilities; enquiry. Select a stage to read its test goal. | Cool white engineering sheet; original sectional engine drawing; dark side panel; orange stage numbers; horizontal specification rules. |
| ai-designer-portfolio / Mira | Independent designer: introduction; selected identity/product studies; service offers; contact. Filter work by discipline. | Blue-ink portfolio index; alternating large original publication and product studies; short service descriptions; accessible pressed filters. |
| cinematic-landing-page / Common Supply | Ingredient supplier: introduction; range selection; sourcing story; ordering process; enquiry. Switch between baking, pantry and seasonal ranges. | Oversized serif title; illustrated ingredient plate overlapping a red band; range list; practical three-step order conversation. |
| codenest-coding-platform / Loop School | Beginner coding: introduction; runnable lesson; curriculum; practice approach; enrolment enquiry. Choose a name and run a bounded greeting function. | Slate editor, light output pane and course rail; blue instructional accents; no evaluation of arbitrary code; output changes with the learner's input. |
| dreamcore-landing / Elsewhere | Imaginary destinations: introduction; illustrated world selector; journal notes; customisation invitation; newsletter. Change destination and landscape palette. | Night-blue atlas frame with large serif masthead; original layered landscape; warm map colors; destination notes beside the drawing. No scroll trap. |
| evergreen-finance / Clear Account | Cash planning: introduction; sample ledger; six-month calculator; principles; FAQ; enquiry. A keyboard-operable range changes the savings total. | Teal account sheet with original chart; outlined calculator split between input and total; fictional balances labelled; calculation excludes returns and fees. |
| innovation / Index Office | Strategy studio: statement; selected study; services; working principle; enquiry. Select a study and expand service details. | Asymmetric typographic hero; original publication diagram; rust-red statement panel; native service disclosures. |

Common controls include a mobile menu with Escape/focus return, visible focus,
local-only demo enquiry feedback, native disclosures where needed, and readable
content when scripts are blocked. Controls requiring scripts are disabled until
initialisation. All imagery is labelled illustration/sample work. No claimed
clients, awards, returns or live account data are introduced.

Package IDs, scenario fields, capability names, preview entry, use-case outputs,
locale keys and asset contracts remain compatible. Metadata titles, descriptions,
localized build instructions, rights and obsolete motion tags are updated. HTML
is the canonical preview. Each package ships `fonts.css`: the preview handler
rewrites its relative link into the package asset route, and the stylesheet’s
relative font URLs then resolve beside it. Inline CSS font URLs were removed
after the real route regression test exposed their incorrect URL base. `data/plugin-previews/manifest.json` has no entries for
these eight at baseline, so no baked-source clip removal was needed.

## Verification and handoff

Receipts are recorded here after execution. No push, PR, main mutation or landing
operation is part of this worker task. One replacement package per commit includes
its corresponding NOTICE removal. Remaining attribution stays until its package
is independently replaced.

The ten remaining packages listed as disputed above are future work. For them,
repeat the brief-only process and validate the resulting design before changing
rights metadata. An owned replacement is not a reason to relabel an untouched
source package.

### Executed receipts (2026-10-09)

| Check | Receipt |
|---|---|
| `mise exec -- corepack pnpm guard` | Exit 0. Repository guards passed, including preview-manifest and mirror-URL checks. The structural HTML guard checked zero `template.json`-backed examples here; the dedicated eight real-folder and eight HTTP tests cover these replacements. |
| `mise exec -- corepack pnpm --filter @mish/plugin-runtime test` | 11 test files / 80 tests passed, including eight real-folder ownership/manifest/asset/size cases. |
| `mise exec -- corepack pnpm --filter @mish/plugin-runtime typecheck` | Exit 0; source and test configurations. |
| `mise exec -- corepack pnpm --filter @mish/daemon exec vitest run tests/plugins-preview-route.test.ts tests/plugins-asset-route.test.ts tests/plugins-validate.test.ts` | 3 files / 24 tests passed after local dependency repair. |
| `mise exec -- corepack pnpm --filter @mish/daemon exec vitest run tests/plugins-owned-examples-preview.test.ts` | 8 tests passed. Each real package returns HTTP 200 HTML through the preview handler, resolves its linked stylesheet and serves byte-identical local font assets. Uses the production route registrar with a read-only package lookup fixture, not a full running application. |
| `mise exec -- corepack pnpm --filter @mish/daemon exec node --max-old-space-size=4096 node_modules/typescript/bin/tsc -p tsconfig.tests.json --noEmit` | Exit 0 after fixing the new test fixture's constructor signature. |
| EGO browser QA | All eight at 1200, 768 and 320px: no horizontal overflow, all fonts loaded, no external resource requests, all anchor targets present. Working package-specific selectors, mobile menus with Escape/focus return and local-only enquiry feedback. |
| No-script / reduced motion | Eight checks each: visible heading/navigation, disabled script-dependent controls; reduced-motion media active with zero animations. |
| Font provenance | Archivo, Bodoni Moda and IBM Plex Mono copies match existing repository font bytes by SHA-256; complete OFL notices preserved. |
| Size / whitespace | Largest committed replacement asset: 46,248 bytes. `git diff --check` passed. |
| Independent review | Initial two documentation nits fixed. Follow-up compiler issue in the new HTTP test fixed. Final reviewer verdict APPROVE; independently reran daemon test typecheck and eight HTTP tests. |

Initial daemon route tests failed because the local SQLite binary had ABI 147
while the pinned Node 24 runtime needed ABI 137. Rebuilding only the dependency
in this worktree resolved it; rerunning the three targeted suites passed. The
plain `pnpm rebuild` attempt did not rebuild that binary; the package-local npm
rebuild did. No dependency versions or lockfile changed.

The first preview-handler test was deliberately useful: it failed on all eight
inline font URLs. Moving the declarations into `fonts.css` made the same handler
and font-byte assertions pass. The independent compiler check also caught a
constructor signature that Vitest alone would not detect. No failures were
waived. EGO screenshot capture initially timed out until the owned QA page was
brought to the foreground; capture and the final complete browser pass succeeded.

Browser JSON and captures are in ignored worktree scratch under `.tmp/t8-owned/`;
`gallery.html` there was opened for visual review and links to the eight working
examples. Those local screenshots are verification artifacts, not catalogue
assets. Old HTML versus new visible copy has no shared eight-word runs in a
mechanical audit; that check is supporting evidence, not a legal proof of origin.

### Package commits

| Package ID | Local commit |
|---|---|
| example-acreage-farming | `e55e2f7d694757f4c616dd9d7a2dea83e73da513` |
| example-aerocore | `77f5178a1d52d0cf8140e2fe6448596b37e2d675` |
| example-ai-designer-portfolio | `15dce458d49492c4e6399aefb9681f1da16a17b4` |
| example-cinematic-landing-page | `49df9c6329d550b5f44b558fa8ee4b611ce09a90` |
| example-codenest-coding-platform | `33ecb2d4ecb7b32edd1ecd33d679ececb77dbe7f` |
| example-dreamcore-landing | `c2a1fe3290ec8ae9d811aa881f2c042e33f9968b` |
| example-evergreen-finance | `b3885b83952c26ba2d5a750102fa05cef98b8618` |
| example-innovation | `ead1b25472f5e3cecec0eb0f747c2eb73d8dba8d` |

Runtime app references changed: **none**. The new daemon HTTP test and plugin-runtime
manifest test add verification references only. Existing inventory fixture rows and
external on-demand MotionSites discovery identities remain intact.
