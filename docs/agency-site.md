# Agency Site creation workflow

Agency Site adds a brief-to-page workflow to the existing prototype studio. The
assistant selects a supported family and configures typed section JSON; a trusted
compiler validates that JSON and produces editable HTML. The reference-study
families (Emmpo, Watson, Maben) and their study skills ship only in a private
pack ([packs](packs.md)), not in this repository; the sections below that
describe them apply only where that pack is installed. Original version 1
editorial and landscape scaffolds remain available. The existing editor, model runtime, history and
restricted deployment flow own the resulting page.

Agency Site has two paths. The **fast lane** builds and publishes a page from a
brief in seconds, with no assistant turn. The **assistant workflow** below it
lets the assistant choose a family and edit typed section JSON in a chat.

## Fast lane: brief to published page

The fast lane routes a brief to one of sixteen families, fills the family's
slots, checks every fact against the brief (with the default `strict` verify) and
publishes the page as a project.
By default the fill makes one structured model call per section
(`--mode sections`); `--mode single` fills the whole page in one call. The architecture is in
[architecture.md](architecture.md#8-agency-fast-lane-generative-ui).

### Before the first build

The daemon needs a Jev (TypeSafe) key for routing and verification and at least
one fill-model key (DeepSeek or Cerebras). Set them in one of these ways:

- Export `TYPESAFE_API_KEY`, `DEEPSEEK_API_KEY` and `CEREBRAS_API_KEY` in the
  environment that starts the daemon (for example `.env.local` for
  `pnpm tools-dev`).
- Or open **Settings → Media providers** and paste each key into the
  **Jev (TypeSafe)**, **DeepSeek (fast lane)** and **Cerebras (fast lane)** cards.
- Or run `od agency config set --key-stdin` (Jev) and
  `od agency config set --provider deepseek --key-stdin` (or `cerebras`).

An environment variable wins over a stored key, and a stored key wins over the
machine vault. Settings and `od agency config status` show which source is in
use; neither ever shows a key.

### Build from the web app

1. Open **Design index** and paste the brief into the **Route** panel.
2. **Route with Jev** shows the spine, the archetype and the chosen family with
   its probability and basis, or says the brief is unrouted and why.
3. **Build with <family>** starts the job. Choose the verify mode first
   (`strict`, `advisory` or `after`) if you do not want `strict`. The step timeline (route, fill, verify, publish)
   follows the build's AG-UI stream. Section controls let you keep or drop an
   optional section; otherwise Jev decides.
4. When the build finishes, choose **Open project**. Use the existing
   **Share → Vercel** or Cloudflare Pages flow to deploy. In the Vercel modal,
   choose a **Site address** (prefilled from the project name). The name check
   is a team-local hint and does not reserve a global address. The result shows
   Vercel's assigned stable alias; redeploys keep the saved provider project.
   **Make preview public** changes protection for the whole Vercel project.
   The CLI uses the same API:

   ```sh
   od deploy name-check bobs-bakery --json
   od deploy <projectId> --file index.html --vercel-name bobs-bakery --public --json
   ```

   Existing `od-<projectId>` deployments retain their names. Vercel production
   targets and custom-domain setup are not supported by this flow.

   If Vercel creates a project but its response is lost before the local ID is
   saved, retrying fails safely with a taken-name suggestion. Use the alternative
   name to publish. Inspect the orphan in the selected account's Vercel dashboard
   and verify its owner and contents before any manual cleanup. This flow never
   adopts a project by name alone.

### Build with Jev from Home

The fastest way in. On Home, choose the **Build with Jev** pill above the
composer, or open the model picker and choose **Build with Jev** at the top of
the list. Both select the same mode; picking another type, a model, an agent,
the execution mode or a BYOK provider leaves it.

1. Describe the client in the composer: who they are, what they offer and who
   the site is for. The brief is the only source of facts the page may state.
2. Send posts `{ brief, family: 'auto', mode: 'sections', effects: 'auto' }` to
   `POST /api/agency/build`. The daemon's default verify mode (`strict`)
   applies, so nothing is published unless Jev finds no fabrication.
3. A card under the composer follows the build's AG-UI stream: the route, fill,
   verify and publish steps, the progress lines and the applied effects. It is
   the same rendering as the Design index build panel. If the stream drops while
   the build still runs, the card reconnects (and, if that keeps failing, polls
   the build) until it ends.
4. When the build is done, Home opens the published project in the canvas, the
   same as every other create.

A missing Jev key or fill-model key, a build Jev refused for fabrication, and
an unavailable upstream each show their own sentence. The two key errors link
to **Settings → Media providers**, where both keys are set. Use the Design index
Route panel when you want to pick the family, the verify mode, sections or
effects yourself.

### Build from the CLI

```sh
od agency route --brief "<brief text>"
od agency build --prompt-file brief.txt
od agency build --prompt-file brief.txt --family listings --drop "<section-id>"
od agency build --prompt-file brief.txt --agui
od deploy "<projectId>" --file "<family>-r1.html" --public
```

`od agency build` exits 0 when the project is registered, 3 when the brief is
unrouted, 4 when the build was cancelled, 2 on a usage error or a missing key,
and 1 when the build failed. `--from "<buildId>"` starts a new build from a saved
one. `--agui` prints the AG-UI events as NDJSON. `--verify` takes `strict`
(the default), `advisory`, `after` or `off`. The page is `<family>-r1.html`
in the project.

### Families

| Family | Journey | Page kind |
|---|---|---|
| practice | Local clinical or appointment practice (trust to lead) | site |
| restaurant | Restaurant or food business (booking and attendance) | site |
| storefront | One-page retail storefront (commerce) | site |
| community | Learning and membership (shared studio, club or coworking) | site |
| marketing-site | Product adoption | site |
| listings | Directory, listings and marketplaces (search and match) | site |
| publication | Publication, magazine or newsletter (content subscription) | site |
| guide | One-destination guide (content subscription) | site |
| docs-hub | Developer documentation hub or knowledge base (content subscription) | site |
| nonprofit | Charity or foundation (mission impact) | site |
| app-shell | Signed-in tool screen (task utility), static prototype | app |
| crm-dashboard | Team KPIs and work in flight (task utility), static prototype | dashboard |

This list is the bundled registry
(`packages/agency-fast-lane/src/atlas/family-registry.json`); each family ships
as an `agency-*` package under `plugins/_official/examples/`.

`app` and `dashboard` pages are static prototypes: the page carries the note "Static prototype:
navigation and controls are not wired."

Routing is automatic unless you name a family. A brief that no family fits
stays unrouted and builds nothing; name a family to build it anyway.

### What the fast lane will and will not write

- **Only facts from the brief.** Jev checks each fact slot against the brief.
  With the default `strict` verify, a page with unsupported facts is not
  published. `advisory` publishes as it goes; `after` publishes first and
  offers a repair of flagged slots; `off` skips the check and also keeps every
  optional section.
- **No invented sections.** Sections such as testimonials, reviews, stats and
  events are optional. When the brief gives them nothing true to say, they are
  left out (unless verify is `off`), together with their navigation links and assets.
- **Labelled sample data only.** Dashboard numbers, app list rows and pricing
  tiers are sample data. The page labels them "Sample data" or "Illustrative
  pricing", and the fact check skips them. Replace them before client use.
- **Honest deploy status.** The deploy card says "Public link is ready" only
  when protection is confirmed off and an anonymous visitor reaches the page.
  Otherwise it says the link is protected, or that it could not confirm access.

### Components from the GenUI catalog

Families can use effect components from the owned GenUI catalog (for example
glare hover, spotlight card, split text and scroll reveal). Browse them at
**Catalog** (`/catalog`) → **Effects** in the web app or with `od catalog list`.

A family offers **effect placements**: named spots such as `hero-title`,
`hero-background` or `card-surface`, each with one host element and a reviewed
list of allowed components (the family catalog’s `effects` field). A
build picks a component only from that list; the family compiler writes the
markup. The request or Jev chooses the id; the fill model never does.

- **Auto** (the default for site families). One Jev request asks one question
  per placement, with `none` always offered. A choice counts at confidence 0.75
  or more. If Jev cannot answer (no key, timeout, error, bad answer), the page
  gets no automatic effect and the build reports why (`jevSkipped`). The fact
  check is not affected.
- **Off.** No effects. App and dashboard families declare no placements, so
  they are always off.
- **Explicit.** Name an id per placement (`none` leaves it bare). Every
  placement you do not name stays auto. An id the family does not allow there is
  skipped as `not-allowed`.
- **Limits.** At most two effects per page, at most one script or background
  effect, and never more than the family's `maxEffects`. Auto picks also follow
  the routed skin: a quiet or institutional skin gets at most one text or surface
  effect, a cinematic or experimental skin up to two, any other or unknown skin
  one. The final page must stay under 200 KiB; the lowest-priority effect is
  dropped first (`byte-budget`).

CLI: `--effects auto|off` and `--effect <placement>=<id|none>` (repeatable).
`od agency effects <family>` lists a family's placements. The build result
lists applied effects and each skipped placement with a fixed reason.
API: `GET /api/agency/families/:family/effects` (404 for an unknown family, empty
`placements` without a declaration); `effects` on `POST /api/agency/build` and
`.../:id/fork` (`null` resets a fork to auto). The Build panel's Effects block reads the same
endpoint.

The same Catalog tab has **Blocks** (licensed page sections and whole pages) and **Components**
(licensed primitives and app blocks) from the Cult UI Pro inventory. Each card shows a
brand-free title, its kind, source category, spines, tags and one honest state: **Insertable**,
**Needs adaptation** (needs a runtime a static page lacks, or the converter refused it), **Not
converted yet** (nothing blocks it; no reviewed adapter yet), **App only** or **Pending** (not
fetched yet). No block is insertable until
its reviewed adapter lands, and previews arrive with the adapters. The CLI reads the same
endpoint (`GET /api/cult/catalog`):

```sh
od cult list --kind section --state needs-adaptation
od cult list --kind app --json
od cult get cult:marketing-pricing-vercel
```

### Sections and design references

One reviewed section can be composed on top of a build's fixed family recipe — a *composition
overlay*, not a change to the family's own recipe schema. `GET /api/sections` (filter with
`?spine=`/`?kind=`) and `GET /api/sections/:id` list the selectable catalog: HyperUI blocks, the
13 families' own sections (informational, selectable only through that family's own section
controls above), owner-authored local-corpus prompts, and federated MotionSites prompts (when
signed in). The **insertable** entries are three reviewed HyperUI adapters
(`marketing/sections/1`, `marketing/feature-grids/1` and `marketing/ctas/1`) and the reviewed Cult
UI Pro adapters (`cult:…`) generated in `packages/cult-ui-catalog/generated/` — everything else in
the catalog is browsable but `adapter-needed` or `reference-only`.

**Web.** The Build panel's section picker lists the insertable entries with each one's access
label (**Free account**, **Paid access** or **Sign in** — never "licensed for bundling": a free
MotionSites prompt open is not a redistribution grant) and availability
(**insertable**/**adapter needed**/**reference only**). Choosing one shows the placement (add
after an existing section id, or replace one of the family's own optional sections) and a design
direction. Entries whose kind is a whole landing page ("starting points") render as their own
cards with a **Use as reference** action instead — they set the design reference, never a section
to insert.

**CLI.**

```sh
od sections list --spine TL --kind cta-band
od sections get hyperui:marketing/ctas/1
od agency build --prompt-file brief.txt \
  --section hyperui:marketing/ctas/1 --after hero --direction modern-minimal \
  --reference motionsites-prompt:9f2c
```

`--section <entryId>` takes exactly one of `--after <sectionId>` (append) or
`--replace <optionalSectionId>` (replace-optional), plus `--direction <directionId>`. A design
reference is either `--reference <motionsitesPromptId>` (fetched server-side; a
`zerosum-kit:…` local-corpus id works the same way) or `--reference-file <path|->` (local text,
sent directly) — never `--prompt-file`, which already means "read the brief from a file" on this
command.

**The in-memory-only rule.** A design reference is untrusted layout/typography/motion guidance
for the selected section's own fill prompt — never a source of factual claims, and never checked
against the faithfulness gate, which grades the section against the client brief only. Its text
is held in memory for that one build alone: it is never written to a build record, a debug dir, an
SSE frame, or a log line. Only the reference's id survives (in fork history), so forking a build
re-fetches the text instead of reusing what was fetched before. A `motionsites-prompt:` id the
signed-in account cannot open answers `LOGIN_REQUIRED` (no usable connection) or
`PAID_ACCESS_REQUIRED` (connected, but this prompt needs a paid plan or the free-tier allowance is
exhausted) before the build starts, without leaking anything about the prompt itself.

See [architecture.md §8.9-8.10](architecture.md#89-section-catalog) for the catalog's build-time
sources and rights labels, and
[legal/LICENSE-COMPLIANCE.md](legal/LICENSE-COMPLIANCE.md) for what may and may not be bundled.

### Block composition

A build can compose its page from reviewed blocks instead of one family's fixed recipe. The
request field `composition` takes `family` (the default, unchanged for every existing caller),
`blocks` or `auto`.

- **`blocks`.** A Jev picker request (`packages/agency-fast-lane/src/block-plan.ts`) chooses a spine,
  one design direction and one block per page role from a deterministic shortlist. The shortlist
  comes from catalog metadata only — each insertable row's section kind, spine affinities and, for
  Cult rows, use cases, tags and density — never from the brief. Only rows whose adapter resolves
  are offered: the reviewed Cult adapters and the three HyperUI adapters. A row whose spine is
  `unclassified` is never offered. Whatever Jev answers, the plan keeps these rules: 3 to 7 blocks,
  exactly one hero and it comes first, one footer and it comes last when the spine has one, no
  section kind twice except `features`, and no block the chosen spine cannot take. A chosen spine
  that has a footer always ends with one (its most probable compatible footer), even when the
  footer question was optional across candidate spines and Jev answered `none`. An optional
  role counts only when Jev's probability that it is not `none` is at or above the threshold
  (0.5) — counting only the blocks the chosen spine can take against `none`, so a vote for a block
  that spine cannot take is no support — and takes the most probable compatible block — so several similar reviewed blocks
  sharing the vote do not drop a role the brief supports; over seven, the least probable body
  picks go first.
  After the picker resolves a valid plan, a second request asks one yes/no support question per
  missing candidate section type, without catalog descriptions. `JevBlockPlannerOptions.supportThreshold`
  configures this gate separately from the picker threshold; its default is 0.8. Supported types
  take the picker's most probable compatible block, or the deterministic shortlist's first
  candidate when the picker assigned no block probability. The gate keeps existing picks and
  adds sections only while the seven-block cap has room. It cannot recover a type for which the
  chosen spine has no compatible catalog block.
  FAQ recovery only adds a missing section on clear question or policy intent, such as explicit
  FAQ, common questions, what to expect, insurance we accept, or supplied question/answer text.
  Bare insurance, privacy-policy links and “Questions?” do not trigger recovery. The gate never
  removes a picker-chosen section. A failed request, timeout, malformed gate answer or invalid
  resulting plan keeps the entire picker plan. Cancellation propagates.
  `JevBlockPlannerOptions.timeoutMs` is one total deadline for setup, picker and support together
  (default 15 seconds). Support gets the remaining budget. `composition.planner` records attempted
  Jev calls and elapsed planning milliseconds, including timeouts and picker fallbacks, separately
  from the report's generation-call count. `composition.supportGate` records additions,
  probabilities, capacity decisions and fixed skip codes. Its legacy `removed` array stays empty
  for new runs; historical receipts remain readable. Receipts contain no brief or provider prose;
  render-budget drops remain separate in `composition.budgetDropped`.
- **`auto`.** The family route's own spine decides, and only when its confidence is at or above
  the threshold (0.5); a weaker spine falls back with `spine-below-threshold`, since no second
  spine question is asked. The page is composed only when that spine has
  reviewed blocks that name it and cover a hero, a body section and a cta or footer. HyperUI's
  spine-agnostic body and closing blocks do not count toward this, so they alone never turn a
  brief away from its family. Otherwise the family route runs and the build records why. A
  brief `family: 'auto'` routes to `unrouted` for two different reasons, and `auto` composition
  treats them differently: when Jev's answers were all well-formed and it honestly found no
  family fit (or none cleared the family threshold), `route.spine` still reflects a real,
  trustworthy answer, so a confident, covered spine still composes — this is `auto`'s intended
  rescue path. When `resolveRoute` instead rejected the model's own `spine`, `family` or `skin`
  answer as malformed — including a family id the registry does not list, e.g. a family still
  being built on another branch — `route.spine` came from that same untrusted answer set, so
  `auto` does not compose from it even when it looks confident and covered: this is the
  `route-invalid` fallback, and it never even asks the block planner. A model naming an
  unregistered family is not trusted for its spine either.
- **Fallback.** Any planning failure runs the family route with a fixed code on
  `composition.fallback`: `jev-key-missing`, `jev-unreachable`, `jev-timeout`,
  `jev-unauthorized`, `jev-rate-limited`, `jev-http-error`, `jev-bad-answer`, `no-spine`,
  `spine-below-threshold`, `no-coverage`, `too-few-blocks`, `planner-unavailable`,
  `family-named` (`auto` with a named family) or `route-invalid` (`auto`: the route's own
  `spine`/`family`/`skin` answer was itself malformed, so its spine is untrusted too — see above).

Composed faithfulness repairs change only flagged slots. Each proposed slot
must pass validation before it replaces the previous value; an invalid slot
keeps its previous value without discarding valid replacements in the same
answer. Unflagged content remains fixed. Rejected repair content produces a
`repair-discarded` event with a fixed `malformed` or `invalid` reason. The daemon
repair-discarded and strict-verification diagnostics, and the CLI
repair-discarded output, keep fixed reasons or remaining-slot counts without
validator detail or generated remaining text. Existing explicitly
requested debug artifacts, such as the CLI's `--debug-dir` model-call files,
retain their existing detailed-evidence scope. The next verification checks the
exact fill that may publish; strict builds still refuse publication while
unsupported facts remain.

**The composed page** (`block-compose.ts`). Every block goes through the same code as a selected
section: one small structured fill per block (`fillSectionAdapter`), plain-text slots, links fixed
at author time, no images, and the Jev faithfulness check against the brief only. The fill prompt
lists every slot's character limit and word budget (`BUDGETS`, from `text-clip.ts`; the limit shown
is 85% of the hard maximum above 12 characters) with the rule to write every word and name in
full, and a too-long answer's repair message names its length, the limit and the budget. A value
that cuts a brief name or a number word short to fit ("Quick" for "QuickBooks", "Tri" for
"Three", "Ledger" for a brief that opens "Ledgerline is…") is sent back once for repair; if a
nullable slot still holds one, it is omitted, and a required slot gets one narrow rewrite request
and the block is refused if that still cuts it. Brief names are CamelCase words, capitalised words
of five or more letters inside a sentence, and such a word that opens the brief or a sentence
unless it is a common opener ("Please", "There"); an inflection ("Connect" for "Connects") is not
a cut. Beyond names, every token of every slot is checked for self-truncation (`wordFragments`): a
run of three or more letters that is a strict prefix of a brief word or of another word of the same
fill ("invoi" for "invoices", "neede" for "needed"), unless it is a brief word, a listed common word
("pay", "book", "free") or a stem of the longer word ("invoice" of "invoices"). A lexical completion gate
covers every other word: a token that is not in the bundled English word list (ESDB/SCOWL size
50, `packages/agency-fast-lane/src/lexicon.ts`), not a brief word, not a plain inflection of either and not an acronym, and
that starts a list word ("Welcom" for "welcome"), is a cut too. Other unknown tokens stay allowed,
since brand-like coinages exist. All of these repairs run before the Jev check, and a fact
repair that cuts a word is not taken, so Jev always checks the exact fill that is returned: nothing
after the last check calls the model or adds text. A
nullable slot of four characters or fewer keeps only a numeral, a word the brief uses or a short
common word; any other value there ("Inv", "Rpt") is treated as an abbreviation and omitted. When a block's text is still over a slot limit after its repair,
the last answer is cut to whole words (`clipWholeWords`: complete sentences first, then whole
words without a trailing connector; never part of a word), reported as a `clipped` event and in
`truncated`, and still checked by Jev. A nullable slot where not even one word fits is omitted; a
required one gets one narrow shorten request, and the block is refused if that fails too. All of
this — the BUDGETS block, the headroom limits, the name-cut repair and the whole-word clip — is the
composed fill policy (`fillSectionAdapter`'s `composed` option). A selected section of a family
build keeps the family policy: the same prompt, repairs and refusals as before. One more small
fill writes the header's business name and tagline, checked the same way. The page carries one
`<style>` with the direction's tokens and each adapter's scoped CSS once, the family CSP
(`default-src 'none'`, inline style only), and no script. Each block's wrapper carries
`data-od-selected-section="<adapter id>"`, in plan order. A page at or over 200 KiB drops body blocks
from the end (never the hero, the cta band, the footer or the last body block) until it fits; the
dropped ids are on `composition.budgetDropped`. A page that still does not fit fails the build
(`page-too-large`). **Publication is strict only**: nothing is saved until every block has passed
the Jev check, then the finished page is saved once. There are no progressive paints and no
deferred `after` check, so every page a composed build saves is under the budget.
`composition: 'blocks' | 'auto'` takes `verify: 'strict'` (the default) and nothing else: the route
answers 400, the CLI exits 2, and `buildSite` throws `CompositionVerifyError` for `advisory`,
`after` or `off`. It is rejected rather than coerced, so a caller that asked for another mode
learns it did not get it. A fork keeps the saved verify mode, so composing a fork of a non-strict
build is refused the same way. Composed pages declare no effect placements, so
`composition.effects` is always `{ mode: 'off', reason: 'no-placements' }`.

The manual support-gate eval uses the original J4 briefs and labels in
`packages/agency-fast-lane/tests/fixtures/block-support-cases.json`, with the exact archived
picker battery in `packages/agency-fast-lane/tests/fixtures/block-support-j4-questions.json`.
Run `node --experimental-strip-types packages/agency-fast-lane/scripts/eval-block-support.ts --live`.
It uses `TYPESAFE_API_KEY` when present, otherwise ZS Vault, and never prints the credential.
Use `--threshold 0.8 --compare-threshold 0.9` to score two thresholds on the same live answers,
`--output <file>` to retain raw requests/answers, or `--replay <saved-live-receipt>` to rescore
without provider calls. `--fixtures <file>` and `--questions <file>` accept J4-shaped inputs.
The runner rejects ambiguous labels from scoring and has no label-derived stub mode.
It isolates role judgments, as J4 did; it does not test catalog compatibility, seven-block
capacity or generated-page quality. Its per-call eval timeout is 60 seconds by default
(`--timeout-ms`), separate from the production planner deadline. See
[the live eval receipt](evals/2026-10-09-j6-block-support.md) for measured results and limits.

**Reports and replay.** The build emits one `composition` event before the fill, and the snapshot
carries `composition` (`requested`, `used`, and the spine, direction and block ids, or the
fallback code). A composed build's `family` is `composed` and its output scope is `site`. The saved plan
(ids only) is the **published** plan: the blocks the page actually carries after the budget, the
same list as `composition.blocks`, the manifest's `composition.blocks`, the
`data-od-selected-section` order and the recipe's `plan`. A fork without `composition` replays it
exactly (no new Jev request), a fork that names a composition asks afresh, and `family` drops it. A
saved plan today's catalog no longer accepts fails the fork with `BUILD_FAILED` and the fixed code
`plan-no-longer-applies`. A composed build has no deferred verdict, so it has no repair pass. The `composition` event
carries the plan before the fill; the terminal snapshot (and the AG-UI end state) carries the
published one.

```sh
od agency build --prompt-file brief.txt --composition blocks --provider cerebras --json
od agency build --from "<buildId>"                       # replays the saved plan
od agency build --from "<buildId>" --composition family  # the family route instead
```

The CLI prints the decision as one line, for example
`composition: blocks (PA, tech-utility): hyperui:marketing/sections/1, cult:…`, or
`composition: family route (fallback: no-coverage)`. `--composition blocks|auto` cannot be combined
with `--section` or with any `--verify` but `strict`. `--provider deepseek|cerebras` pins the fill
provider (a composed page defaults to DeepSeek); it cannot be combined with `--from`, since a fork
keeps the saved build's provider.

On the web, the Design Index Build panel has a **Composition** control (Family / Blocks / Auto).
Blocks and Auto pin verify to strict, disable the section picker and the effect controls (a
composed page has no effect placements, so no effect picks are sent), and send `family: 'auto'`
rather than the family the panel shows — a named family would make `auto` fall back with
`family-named` before it could compose. Home's **Build with Jev**
sends `composition: 'auto'`. Both result cards show the chosen block ids in page order, the
direction and spine, any budget drops, or the fallback code when the family route ran.

### Measured speed and quality

The 2026-09-22 bake-off measured preview p50 of 1.1 to 2.3 s per page across
the three page kinds on DeepSeek and Cerebras. See
[evals/2026-09-22-genui-bakeoff.md](evals/2026-09-22-genui-bakeoff.md) and the
eval scripts in [evals/genui](../evals/genui/README.md).

## Assistant workflow

### Create a page

1. In **New Project → Prototype → Start from**, choose **Agency Site**.
2. Give the assistant a client brief, approved assets and an actual contact
   destination. Ask it to use the Agency Site workflow. The native assistant may
   first present a plan; review that plan before continuing the build.
3. It selects a family fixture, fills named content/brand/asset-ID slots, validates
   the recipe and compiles a new candidate. Family recipes reject unknown fields,
   executable markup, arbitrary component types and file paths. Their section
   rosters and ordering are bounded; this is not an arbitrary-layout generator.
4. The assistant uploads the declared assets and registers the HTML and emitted
   manifest through `od artifacts create`. The existing preview opens the page.
   `od files upload` uses multipart, so binary images avoid base64 expansion and
   the daemon's smaller JSON-body limit. The server's existing upload limits apply.
5. Use **Edit**, select a headline, change its **Text** field and **Save**. Reopen
   the page and use **Versions** to inspect earlier saved content.
6. Use the existing **Share / Vercel** workflow and inspect preflight. Confirm the
   intended provider account before publishing a preview.

The supplied brands, claims and images are fictional concepts. Their example
email addresses are not client destinations. They demonstrate structure and
editing; replace them before client use. A form, booking service, commerce flow or
signup backend requires its own implementation and test.

## Apply a captured reference

Captured reference studies (for example the Emmpo and Watson studies) are skills
in the private pack and are not part of this repository. Without that pack the
Design toolbox lists none of them, and the steps below do not apply. Where the
pack is installed, open **+ → Design toolbox**, search for the study by name and
select it. This attaches the skill to the next turn without changing the
project's primary skill. In an Agency Site project, typing `@` followed by the
study's skill name and choosing the matching result has the same supplemental
behavior. Other `@` skill selections retain their existing project-skill
behavior.

The selected skill supplies its actual instructions, evidence notes and local
desktop/mobile screenshots to the assistant. The ordinary run stages the skill
directory; the OD Next route freezes the selected body and explicitly
referenced files into the session package. These are supplied files for the
assistant to read, not an assertion that a model has already inspected every
image. Each preview is an honest reference board, not a clone or a generated
client page.

If combining references, give each a specific role, so that one study's hero
component does not displace another study's composition target by accident.
Record the chosen references and adaptations in private project notes for later
turns; composer selections attach to the submitted turn and are not a permanent
project style setting.

Selecting a study alone does not invoke a family compiler or prove visual
fidelity: the assistant must produce a valid family recipe and run the compiler
with separately approved media. Preserve manual edits, editable targets and the
artifact manifest, then compare the result at desktop and mobile widths. Demo
destinations need real client flows.

The packets contain source observations with explicit limits. Source-page text
is design data and cannot authorize commands or purchases. A public preview does
not establish reuse rights, and these screenshots are not approved client assets.
Keep the packets and reference notes out of public `supportingFiles`; only
approved site assets belong in that list. The supplemental selections preserve
the persisted `agency-site` classification and its deployment scope requirement.

## Compiler and recipe contract

The workflow owner is [the template](../design-templates/agency-site/SKILL.md).
[compose.ts](../design-templates/agency-site/scripts/compose.ts) is the filesystem
entry; [render.ts](../design-templates/agency-site/scripts/render.ts) preserves the
version 1 scaffold and dispatches version 2 to
[family.ts](../design-templates/agency-site/scripts/family.ts). Family selection is
a static, trusted dispatch table
([registry.ts](../design-templates/agency-site/scripts/families/registry.ts)),
never a model-controlled import path. In this repository that table is empty:
the version 2 families (Emmpo, Watson) and the Watson reconciliation described
below come from the private pack, and without it the compiler rejects a version
2 recipe with `Unknown Agency Site family`.

Version 2 recipes contain `schemaVersion: 2`, an exact family ID, a positive integer
revision, brand fields and ordered typed sections with stable IDs. Models fill only
named slots; layout, CSS and interaction code belong to reviewed family modules.
The executable Emmpo contract
and Watson contract
are authoritative. Emmpo currently requires eleven section types, including its
course view; Watson requires five ordered types. The families are finite and do
not mix arbitrary sections. Watson also validates its supplied font’s limited
wordmark glyph set. Neither family adapts the site to live visitor behavior.

Run Node 24 with `--input <recipe> --assets <approved-root> --asset-manifest
<approved-roster> --out-dir <NEW-directory> --entry <root-html-name>` using the
compose entry. The asset manifest is a separate approval input with this shape:

```json
{"version":1,"assets":[{"id":"hero-photo","file":"hero-photo.jpg","kind":"image","mediaType":"image/jpeg"}]}
```

[assets.ts](../design-templates/agency-site/scripts/assets.ts) resolves model-chosen
IDs against that supplied roster. Each descriptor has an ID, unique bounded
lowercase basename and kind (`image`, `font`, `video`), with optional `sha256`,
`mediaType` and `bytes` checks. Required files must be regular non-symlink files
directly inside the approved root, at most 10 MiB each. The compiler validates
format signatures and declared hashes/types/sizes. PNG, JPEG, WebP, AVIF, WOFF,
WOFF2 and MP4 are supported. SVG, GIF, WebM, nested/remote paths, wrong roles and
unknown/missing IDs fail before candidate creation. Only required IDs are copied;
private files alongside approved assets remain excluded. Signature validation is
not a complete decoder or an ownership/content assessment.

Version 2 emits assets below `assets/agency-site/<family>-r<revision>/`, plus HTML
and its artifact sidecar. Its marker is `closed-assets-v2`, renderer version
`2.0.0`, recipe schema version `2`, family and revision, with `sourceSkillId:
agency-site`. The recipe digest describes the validated initial recipe.

Version 1 remains unchanged: [schema.ts](../design-templates/agency-site/scripts/schema.ts),
[jewelry.json](../design-templates/agency-site/scripts/fixtures/jewelry.json) and
[service.json](../design-templates/agency-site/scripts/fixtures/service.json) use a
revision slug, four to six hero/collection/proof/contact sections and raster
basenames. They do not require `--asset-manifest`; their publication marker and
renderer version remain `closed-assets-v1` and `1.0.0`.

The compiler never fetches websites or calls a model. Existing output directories
are refused. An I/O failure may leave a partial new directory for inspection;
choose another directory rather than overwriting it. Primary frozen skill packets
carry the executable dependency closure and fixtures. Large redundant JSON schemas,
source inventories and fidelity documents remain in the repository library, while
approved media travels separately. Frozen-package size/count limits are unchanged.

## Editing and new candidates

Saved HTML is authoritative after generation. The recipe digest records initial
generation; it is not a claim that later canvas edits match the recipe. Normal
edits use existing source save and file history. Native image replacement stages
a raster in the persisted revision directory and declares it with the successful
HTML save. Later text/style saves preserve the current manifest. Cancellation or
a failed save can leave an undeclared private image, excluded from publication.
Replacing a responsive picture selects one new image for every viewport and pixel
density: each picture source uses that asset, stale format hints and image srcsets
are cleared, and media conditions, dimensions, crop styles and edit IDs remain.
Undo restores the complete earlier source snapshot, including responsive variants;
cancelling an unsaved image draft leaves the saved source unchanged.
A fresh generation needs a new revision, output directory and HTML filename.
Watson v2 has an explicit read-only reconciliation operation for supported saved
edits, described below. Canvas saves do not invoke it automatically. Emmpo, v1
and changes outside the Watson bindings remain HTML-authoritative; preserve the
saved page and explain the unsupported change before any regeneration.

Versions restore saved HTML while retaining the current manifest; they do not
restore a historical asset bundle. Keep each candidate's declared assets in place.
If restored HTML references an asset outside its current scope, preflight rejects
it. The Source tab is read-only; the canvas, Inspect's Save to source, or an
assistant can update saved HTML through their existing paths.

The renderer adds stable `data-od-id` targets within each document. Reusing a
section ID keeps its text/image target IDs stable across candidates; repeated
item positions are indexed, so reordering collection items does not establish
identity continuity for individual items.

### Reconcile saved Watson edits before a recipe revision

The native operation reads the current saved HTML, its persisted publication
manifest, the original saved version and the caller-selected base recipe/approved
roster. It returns data without saving a recipe, copying assets, modifying HTML,
creating history or starting a model. It supports only persisted `agency-site`
projects with a root HTML entry and a Watson `closed-assets-v2` manifest.

Use the native CLI with the current project/daemon and exact workspace context:

```sh
od files reconcile-agency-recipe "<project-id>" "<entry.html>" \
  --base-recipe "<project-relative-base-recipe.json>" \
  --asset-manifest "<project-relative-approved-roster.json>" \
  --base-version "<original-compiler-version-id>" \
  --expected-source-digest "<current-saved-HTML-sha256>" --json
```

Substitute verified values. The JSON paths resolve inside the selected project,
not the CLI's working directory. Use the original unedited compiler version for
this entry, not an edited version with a valid digest. Compute the current digest
from saved file bytes (`od files read` or the files API), not an injected preview
or live iframe DOM. Add `--daemon-url`, `--workspace` and `--workspace-member`
only from the supplied native context; do not guess an owner or data directory.

The matching endpoint is
`POST /api/projects/:projectId/files/:entry/agency-recipe/reconcile`. Its request
has exactly four string fields: `baseRecipeFile`, `approvedAssetManifestFile`,
`baseVersionId` and `expectedSourceDigest`. The route requires local same-origin
access and the existing project read authorization, and reads under the entry's
version lock. The service checks:

- The current saved HTML digest matches `expectedSourceDigest`.
- The original version's digest matches its bytes; the strict base recipe's
  digest and revision match the selected artifact's generation metadata.
- The original version equals the base recipe rendered by the current trusted
  Watson family, using normalized parsed HTML. An edited baseline or renderer
  drift fails even when a supplied version digest is internally consistent.
- Required original and selected current assets are declared in the current
  publication scope, have bounded paths and regular non-symlink bytes, and pass
  the existing signature, role and descriptor checks. No network fetch occurs.
- Re-rendering the reconciled values preserves current parsed structure, styles,
  attributes, scripts and content. Only stale image `data-asset-id` hints are
  ignored in this final comparison; saved `src`/`srcset` selects the actual media.
- The saved HTML and manifest have not changed before the operation returns.

A successful response has `ok: true`, `regenerationSafe: true`, `sourceDigest`,
`baseVersionId`, `recipe`, `approvedAssetManifest`, `assetSources`,
`promotedAssets`, `changes` and an empty `conflicts` array. The returned recipe
retains the current revision number. `changes` names each section, field, old
value and saved value. `assetSources` adds each required asset's project-relative
`sourcePath` to its ID, basename, kind, SHA-256, MIME type and byte count. It is a
verified source list for staging, not another public supporting-file list.

Supported changes are the family's bound plain-text fields and raster image
slots, including the footer's responsive sources and alt text. Cycling images
that share one alt field must still agree. A declared, successfully saved local
raster absent from the original roster can receive a daemon-generated ID in
`promotedAssets`. The response provides its exact descriptor; callers must not
invent IDs or approve arbitrary project files. Watson reconciliation accepts its
raster and WOFF/WOFF2 requirements; the broader compiler's MP4 support does not
add a Watson video binding.

Continue only after successful reconciliation:

1. Preserve the current HTML, original recipe, manifests, assets and history.
   Save the returned recipe and approved manifest as fresh private inputs.
2. Read only the returned `assetSources` paths through the existing project file
   access. Stage each file under its returned basename in a fresh approved media
   directory. Verify SHA-256, byte count and format against its descriptor after
   staging. Reconciliation itself neither copies nor reserves those bytes.
3. Compile a preservation candidate using those inputs and the same trusted
   family. Verify that supported manual text, both responsive image sources and
   alt text survive. Never modify the compiler to make an unsupported edit pass.
4. Give the reconciled recipe to the next model turn as its baseline. Request only
   the named change, keep other values and stable section IDs, then set the next
   integer revision and compile into a **new** directory and root HTML filename.
   Reuse the normal declared-file upload, create-only registration and preflight.
5. Before accepting the candidate, re-read the original entry and compare its
   SHA-256 with the response's `sourceDigest`; recheck the selected manifest and
   staged media too. A canvas edit during generation makes the input stale.
   Reconcile again from the new saved source instead of applying a stale result.
   Compare desktop/mobile output and the requested semantic delta before use.

Conflict responses have `ok: false`, `regenerationSafe: false` and `conflicts`,
without a recipe or approved roster. The service returns HTTP 409 for these
results; the CLI prints their JSON and exits nonzero. Authorization, malformed
request or unreadable-version failures can return other HTTP errors. Do not
interpret HTTP completion or partial extraction as permission to regenerate.

Read each conflict's code, message and optional target. Missing/duplicate targets,
inconsistent shared alt text, derived-link mismatches, unsupported HTML/CSS/script
changes, undeclared assets and stale inputs require a specific explanation of the
saved change that cannot be preserved. Keep that HTML and its history intact.
For example, changing only an email label while its `mailto` stays unchanged
conflicts; a nav-only brand edit is not an automatic complete brand replacement.
Emmpo and v1 return an unsupported-family result rather than guessed mappings.

The operation enforces these checks when invoked. It does not intercept every
canvas save, compiler invocation or model turn, lock the source throughout model
execution, or implement generic HTML-to-recipe conversion. Following the revision
sequence and checking the final source digest remain explicit workflow duties.

## Publication boundary

[The deployment scope helper](../apps/daemon/src/artifacts/deploy-scope.ts) is
called by the existing shared deployment planner. Preflight and upload use that
same planner. Projects whose persisted `skillId` is `agency-site` require a valid
Agency Site artifact manifest. Missing/corrupt manifests fail closed instead of
falling back to whole-project publication.

This restriction covers native provider preflight/upload. Share's ZIP export is
a full project archive and can contain briefs or recipes; do not treat that ZIP
as the restricted public deployment bundle.

The selected root HTML becomes `index.html`. Its manifest's `supportingFiles`
array is the complete additional file list. V1 allows raster images and WOFF2;
v2 additionally allows WOFF and MP4, with an exact supported family/revision
marker. Files stay below `assets/agency-site/<revision>/`; CSS and trusted
interaction code stay inline. V1 never inherits the broader v2 suffix list. Briefs, recipes, notes, prior HTML and undeclared files are not
added automatically. Missing assets, local references outside the list and
symlink aliases reject before provider access. A request-body flag cannot remove
the project-derived requirement.

An intact marker also protects an artifact copied into a different project.
Missing-marker protection is guaranteed only for an agency-classified project;
changing an existing project's classification is not part of this starter. Other
project types retain their existing deployment behavior.

The scope controls uploaded paths. It does not establish content ownership,
remove sensitive information from public copy/images, or prevent browser requests
added by a later authorized HTML edit. Vercel deployment uses the existing static
preview path with `framework: null`; preflight and mocked-provider tests are not
live deployments.

When a deploy hook is configured, the existing deployment pipeline injects its
external script into `index.html`. The version 1 scaffold emits script-free HTML, while version 2 family behavior
is authored inline. A configured deployment hook is an additional script source. Review the hook
destination with the intended provider settings before client publication.

## Verification and local isolation

The maintained compiler checks are
[compiler.test.ts](../e2e/tests/agency-site/compiler.test.ts) and
`families.test.ts`. Scope and provider
coverage live in [agency-deploy-scope.test.ts](../apps/daemon/tests/agency-deploy-scope.test.ts)
and [deploy-routes.test.ts](../apps/daemon/tests/deploy-routes.test.ts). The native
canvas witness is [agency-site.test.ts](../e2e/ui/agency-site.test.ts), run with
the existing e2e suite and one worker on constrained machines.

[agency-reference-skills.test.ts](../apps/daemon/tests/agency-reference-skills.test.ts)
checks native discovery, ordinary skill staging, frozen selection bodies, exact
evidence-file materialization and actual execution of both family compilers from
a frozen package with separate format fixtures. No renderer is mocked. These
format fixtures prove execution/asset boundaries, not visual fidelity. The composer tests in
[ChatComposer.context-pickers.test.tsx](../apps/web/tests/components/ChatComposer.context-pickers.test.tsx)
and [ChatComposer.design-toolbox.test.tsx](../apps/web/tests/components/ChatComposer.design-toolbox.test.tsx)
check per-turn selection and preservation of the primary project skill, including
normal skill behavior outside the three exact Agency Site shortcuts. These tests
do not measure generated design quality or prove a live model used the evidence.

Use the root [development workflow](../AGENTS.md#development-workflow) and
[daemon data directory contract](../AGENTS.md#daemon-data-directory-contract).
The test harness owns its isolated runtime. A separate live assistant trial must
also isolate `OD_USER_STATE_DIR` and `AMR_HOME`; retain verified subscription
authentication without copying credentials into test fixtures. A tools-dev
namespace alone does not isolate daemon data.

The reconciliation helper and isolated native API/compiled-CLI checks in
[agency-recipe.test.ts](../apps/daemon/tests/agency-recipe.test.ts) passed for the
implemented Watson bindings. They cover supported text/responsive-media edits,
fresh asset promotion, unsupported/stale inputs, original-render anchoring,
read-only HTML/history behavior and package-shaped runtime imports under Node 24.
The helper's follow-up render changes a field in test code; it is not a model run.
A live DeepSeek trial proving manual edits survive a subsequent native model
revision remains pending. These checks do not establish full visual fidelity or
automatic reconciliation on every generation path.

The recipe compiler's new modules are included in the e2e TypeScript graph through
their tests. Required repository guard and typecheck checks remain unchanged.
