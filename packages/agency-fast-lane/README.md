# agency-fast-lane

The GenUI fast lane for Agency Site families. A client brief becomes a compiled, registered page
in seconds instead of minutes: one structured model call (or one per section), the family
compiler in-process. `--verify-mode advisory` or `off` save progressively to a local daemon
project as each unit lands; `--verify-mode strict` (the default) defers every save until Jev has
verified the whole page, then publishes it in one batch — see "Faithfulness gate (Jev)" below.

The tool never changes the daemon. It uses the public project file API, and the daemon's own
project watcher reloads the canvas after every save.

## Run

```sh
pnpm --filter @mish/agency-fast-lane fast-lane -- \
  --family maben --brief ./brief.md --name "Riverbend Dental"
```

- `--mode sections` (default) — one concurrent call per section plus one for the brand; under
  `--verify-mode advisory`/`off` sections paint as they land, under the default `strict` nothing
  paints until the deferred save below. Every measured run: under 3 s for the page, 0 or 1 repair.
- `--mode single` — one streamed call fills the whole page; under `advisory`/`off` sections paint
  as they close, under `strict` painting is deferred the same way. Slower (7–9 s) and V4 Flash
  slips more often on the page-sized answer; kept for one-voice copy.
- `--spine recipe.json` — re-target an existing build: same family, same images, new copy.
- `--dry-run --out-dir NEW-dir` — no daemon; write the build locally.
- `--report report.json` — timings, calls, tokens, repairs.
- `--verify-mode strict|advisory|off` (default `strict`) — every build above now verifies every
  factual slot with Jev and fails closed on any remaining, oversized, or skipped fact; see
  "Faithfulness gate (Jev)" below for the full contract, the two modes that opt out of failing
  closed, and the Jev credential that `strict` and `advisory` both need before the build starts.

The DeepSeek key is read with `zsvault get deepseek_api_key` into process memory at call time.

## Provider

`--provider deepseek|cerebras` picks the model that fills the brief (default `deepseek`); `--model`
overrides the provider's default model. Both are OpenAI-compatible streaming JSON-mode callers
behind one provider table (`src/deepseek.ts`), so the same fast-lane run works against either. The
Cerebras key is read with `zsvault get cerebras_api_key`, the same way, and never touches disk or
the environment. Cerebras runs one site at a time across processes (a pid lock in the temp dir,
`src/lock.ts`): the account's tokens-per-minute quota returned 429 on four of five concurrent
sites, while one site at a time finishes in 0.8–2.5 s. A second run prints that it is waiting.

## What the model can and cannot change

The model receives only the text of the recipe: string values outside `assets`, `destinations`,
`type`, `family`, `revision`, `wordmark`, `language`, `colors` and `fonts`, with `id` kept as
an anchor. Everything else is merged back from the spine. The family compiler validates every
merge; a refused or incomplete unit is asked again once with the validator's message.

A family may also mark individual slots nullable — Watson's footer contact and award atoms are
the first. Those slots are shown to the model in a `NULLABLE` block beside `LIMITS`, with the kind
of fact each one holds, under the rule "return null for a fact the brief does not state". The
model answers `null` instead of inventing a phone number, an email, an address or an award; the
family renderer then omits the whole fragment, and the run report lists those paths under
`nulled`. `null` in any other slot is treated as an empty value and repaired. A slot left null
stays editable on every later run: `--spine` re-targeting keeps it in the template as `null`, with
its limit and its atom kind, so a revised brief that now states a phone number fills it back in
and counts it like any other change. Nothing is silently dropped in either direction.

## Sparse content and rendered output

Schema-declared variable arrays carry `ARRAY MINIMA` into the fill prompt. A short brief should
produce the shortest useful list within those bounds. The generator repairs repeated complete
object records instead of padding a list to the reference length. It compares every semantic
field, so distinct records may share a title or price. Fixed arrays retain their exact-count
contract. Nullability, name, quote and factual verification rules remain unchanged.

Real family packages and composed pages run concrete HTML checks independently of
`--verify-mode`: one nonempty page heading, unique IDs, accessible form labels, and safe,
nonempty link destinations with resolved fragments. Relative URLs are accepted without
claiming their resources exist. Declared static prototypes run the unique-ID check only.
Reusable block headings become section headings; the composed opening hero owns the page
heading. Family overlays bind an adapter's generic contact fragment to a real declared contact
or footer section when available.

Failed HTML emits `render-quality` and throws `RenderQualityError` before that page can publish.
The final `renderQuality` report is separate from `verify` and `strict`. In progressive modes,
earlier valid drafts can appear before the final gate completes. These checks do not measure
computed visual hierarchy, layout, contrast, provider correctness or actual inbox delivery.

Local evidence (2026-09-30) is in the ignored `.tmp/quality-proof/shared-quality-tests.log` and
`shared-quality-typecheck.log`. The targeted tests include all 19 unchanged reference fixtures
and each schema's shortest variable arrays, sparse strict fills, duplicate repair/refusal,
native contact/disclosure links, relative and encoded links, quoted attributes, composed
heading/CSS preservation, and failure before publisher creation. Community's browser and
design evidence lives in its [quality benchmark](../../plugins/_official/examples/agency-community/QUALITY.md).

## Faithfulness gate (Jev)

`--verify-mode strict|advisory|off` (default `strict`) runs a TypeSafe System One (Jev) check
after every unit is filled and merged, before the page is registered: one Noul question per
changed text slot asks whether it states a concrete fact — a contact detail, number, date, price,
award, credential, or place — the client brief does not contain. A flagged unit is repaired with
the existing `repairUnit` path and rechecked once. `--verify-threshold` (default `0.85`) sets the
probability at which a slot counts as flagged. A prototype check (`jev/faithfulness-check.mjs` in
the overnight workspace) measured this live against a real fast-lane build: 40 slots checked in
~419 ms for ~5,845 input tokens, flagging 11/40 as fabrications later hand-verified absent from the
brief (an invented phone number, two emails, a street address, and an award caption) — at Jev's
published pricing ($0.042/Mtok input, output free) that is well under a tenth of a cent per page.

A build now verifies by default: **`strict`** is the effective mode with no flag at all. Every
mode but `off` preflights its Jev credential before spending any model call — a broken or missing
credential fails the run immediately (exit 2) rather than mid-build. The CLI prints
`verify-mode: <mode>` in its summary, and the resolved mode is written to `--report` as
`verifyMode`, so a run's output always names which check it ran. `resolveVerifyPolicy`
(`src/verify-policy.ts`) is the pure function that turns the flags below into that one mode.

The credential itself is resolved once per run — `createJevCredentialResolver`
(`src/verify-policy.ts`) checks `TYPESAFE_API_KEY` in the environment first, then falls back to
`zsvault get typesafe_api_key`, mirroring the resolution order the daemon's own Jev credential
uses (environment, then a daemon-stored key, then the vault — the fast lane CLI has no
daemon-stored key of its own, so it stops at two steps). The one cached resolver backs the
`--verify-mode` preflight below, the `--family auto` router, and the faithfulness checker, so a
run never reads the credential twice.

- **`strict`** — fail-closed, described in full below.
- **`advisory`** — the check runs and a flagged unit is still repaired and rechecked, but the page
  publishes either way; a non-empty `remaining` list is printed loudly by the CLI instead of
  blocking. A network failure or timeout does not fail the build in this mode: `checkFaithfulness`
  reports `skipped` with the reason instead of throwing. Because the check runs after the fill
  step's own progressive paints, the canvas can briefly show a flagged value before the repair
  republishes over it.
- **`off`** — no faithfulness check runs, so no credential is required for faithfulness
  verification, and no `verify` field appears in the report. `--family auto`'s ROUTE step is a
  separate Jev request with its own credential need (see "Routing" below) and is unaffected by
  this mode; only `--route-only`, which never builds, is exempt from the verify-mode preflight
  entirely.

`--route-only` is unaffected: routing never builds, so no verify mode ever applies to it. Two
legacy flags keep working for one release, mapped by the same pure function:
`--verify jev --verify-strict` still means `strict`, and `--verify jev` alone still means
`advisory` — exactly what it meant before this default changed — so an existing exploratory script
that never asked for strict keeps behaving as it did. Naming `--verify-strict` alongside an
explicit `--verify-mode` other than `strict` is a conflicting request, not a silent pick, and exits
2 before any file is touched.

`--verify-mode strict` turns the gate fail-closed. The fill and the check run entirely in memory —
no project is created, no asset is uploaded, and no page reaches the daemon while the gate is still
open. It passes only when the check actually ran, nothing is left in `remaining` after repair, and
nothing was set aside as `oversized` (too large to check even alone with the brief); a `skipped`
check (network failure, timeout) fails closed the same as an unresolved flag. A pass where every
editable path was locked or already null — nothing for Jev to check — still passes, but says so
explicitly: `strict: { passed: true, checked: 0 }`, and the CLI prints `strict: passed with 0 slots
checked (all locked)` alongside the usual registered line. On a pass, the project is created (or
resolved, honouring `--project`, `--name` and `--archive`) and everything publishes at once: every
asset, the final page exactly once, then the state files — never the progressive per-unit paints a
non-strict run uses. Because the fill step's own in-memory renders are never counted as paints
while strict is deciding, a strict report's `paints`, `firstPaintMs` and `finalPaintMs` describe the
daemon and nothing else: on a pass they are exactly the one deferred page save (`paints: 1`,
`firstPaintMs === finalPaintMs`); on a failure, or under `--dry-run` where nothing is ever sent,
they stay `0`/unset. With `--verify-mode strict --dry-run`, the CLI's summary reads `verify-strict:
passed — dry run, nothing registered.` — a pass, and an explicit statement that nothing published,
never the "registered" wording a real publish uses.

If publishing then fails partway through — after the project exists but before every asset, the
page and the state files have landed — the run does not leave a half-built project sitting in the
daemon for someone to find later. When this run created the project itself (no `--project <id>`
was given), it deletes that project again and the thrown error says so:
`strict publish failed after creating project <id>; the new project was removed: <cause>`. When
`--project <id>` named an existing project, this run never owned it and never deletes it; the
error instead warns that the project may hold a partial file set. Either way `runFastLane` rejects
(the CLI's existing top-level handler reports it and exits 1) — this is a genuine daemon failure,
distinct from the exit-2 strict gate above, which never touches the daemon at all.

On a strict failure, the CLI prints the remaining, oversized, or skipped facts, writes
`strict: { passed: false, reason }` to `--report` when one was requested, and exits 2 with nothing
registered anywhere. With `--dry-run`, strict makes the same in-memory pass/fail decision and exits
the same way, but never publishes either way — the local `--out-dir` build (if requested) is
written regardless, since that was already true of every dry run.

## Routing (Jev + Website Shape Atlas)

`--family auto` adds a ROUTE step in front of FILL: one Jev (TypeSafe System One) request
classifies the brief against the Website Shape Atlas (`src/atlas/shape-atlas.json`: 9 spines, 32
archetypes, a 9x9 spine compatibility matrix, 12 visual skins), and pure code (`resolveRoute` in
`src/route.ts`) turns Jev's answers into the bundled family package to build with — never a model
call that "picks" the family directly. The request is a speculative fan-out over one `spine`
question, one `archetype_<CODE>` question per spine (9, each phrased "assume the brief is a
`<spine>` site"), one `family` question, and one `skin` question, all evaluated in parallel in one
call. `state` carries only `{ brief }` — never a recipe, an asset id, or a destination.

Candidates are gathered over every spine at or above `--route-spine-share` (default 0.25) of the
`spine` answer's own probability mass, not only the top spine — a brief whose spine call is
genuinely spread (a maker-studio brief splitting between "trust the maker" and "buy the piece") can
still reach a family that only lives on the runner-up spine. `decision.spines` lists which spines
cleared that share; `decision.spine` still reports the top one. Resolution policy, in order: a
family whose own archetype matches Jev's `exact`ly beats one that merely shares its `same-spine`
(against whichever qualifying spine it matches), which beats one reached only through the atlas's
`compatible`-spine transfer (score >= `--route-min-transfer`, default 2; transfer 1, "shared
parts", is never a build target by default) — each candidate's `viaSpine` names the qualifying
spine its basis came from, which the routed spine and a runner-up can differ on. Within that
ordering, candidates are ranked by Jev's own `family` probability, ties within 0.02 broken by basis
then by whether the family's skin matches Jev's `skin` answer. The whole ranked list is always
reported, so an operator can override with an explicit `--family` on the next run.

Routing fails closed: a brief Jev cannot place on any spine, or a top-ranked family below
`--route-threshold` (default 0.5), is `unrouted` — never a guess. `--family auto` prints the
decision, then (routed) builds normally or (unrouted) prints the reason and every candidate and
exits **3** without building anything. `--route-only` implies `--family auto`, never builds or
touches the daemon or the fill model, prints the same line, writes `{ route }` to `--report` when
given, and exits **0** either way. `--family auto` cannot be combined with `--spine` (the spine
recipe already fixes the family) or `--package` (an explicit `--family` id is required instead).
A routed, non-route-only `--report` carries the full `RunReport` with `route` spread in ahead of
it; `RunReport` itself is untouched — the route lives at the CLI layer only.

```sh
pnpm --filter @mish/agency-fast-lane fast-lane -- \
  --family auto --brief ./brief.md --route-only --report route.json
```

```
[  0.41s] route: TL.04 Home and property service → wrenfield (p 0.71, exact archetype, skin Heritage and craft)
```

The TypeSafe key is read the same way as the faithfulness gate's: `zsvault get typesafe_api_key`
into process memory at call time, never printed, never passed as an argument or environment
variable.

### Re-importing the atlas

`src/atlas/shape-atlas.json` is generated from the atlas's own HTML page, not hand-maintained:

```sh
node --experimental-strip-types scripts/import-shape-atlas.ts <path-or-https-url> [--out src/atlas/shape-atlas.json]
# or: pnpm --filter @mish/agency-fast-lane import-atlas -- <path-or-https-url>
```

The importer is a regex parse over the static HTML (spine cards, archetype cards, the
compatibility matrix, the skin strip, the cross-cutting-formats panel, and the page's own
`familyDetails` script object for the per-spine transfer notes), validated before writing:
every archetype's spine must exist, the compatibility matrix must be square over the spine codes,
symmetric, and diagonal 3. `src/atlas/family-registry.json` — which bundled family maps to which
archetype and skin — is hand-authored, not generated; a test checks that every registry family id
equals a bundled `agency-*` package under `plugins/_official/examples`, so a new family can never
ship unregistered.

## Design profile and index

A **design profile** classifies any design input — a catalog prompt, a client brief, a spec, or
an uploaded HTML page — in one Jev fan-out request of about 105 Choice/Noul/Score questions over
`{ text }` (or `{ text, facts }` for an HTML upload, `facts` from `src/html-facts.ts`'s regex-only
extraction of title/headings/landmarks/counts/fonts/motion signals): route (spine, archetype,
skin, format, action, family — the last four are new; route.resolved reuses `resolveRoute` from
`route.ts` exactly, so a profile and a `--family auto` router run agree), 28 page-level sections,
24 components, 20 motion mechanics, 5 depth cues, 6 style axes, and a 7-dimension rubric-derived
quality pre-score (never a ship grade — the rubric grades renders, this reads the spec's stated
intent) plus a `truth-risk` flag for plausible-specific filler. Probabilities are kept, not
collapsed to booleans, so thresholds and rankings can change without re-asking. Every label's
definition (`src/taxonomy/design-taxonomy.json`, loaded and validated by `src/taxonomy.ts`) is
used verbatim as the Jev criterion text.

`src/profile.ts` builds the question set (`buildProfileQuestions`) and resolves raw answers into a
`DesignProfile` (`resolveProfile`); `createJevProfiler` shares its request mechanics (auth,
timeout, lazy cached key, fetchImpl injection) with the faithfulness checker and the router
through `postSystemOne`/`resolveJevKey` in `jev.ts`, rather than a third copy of that fetch/auth
pattern. An over-budget input (past the same 64,000/32,000-token documented ceilings `jev.ts`
estimates against) splits the fixed question set into exactly two requests, both carrying the
full state; profiling fails closed like routing — a non-2xx response throws `ProfileError`, and a
network failure propagates as-is, never `skipped`. `source.digest` is a SHA-256 of the input text,
so a re-profiled unchanged input is detectable and the text itself never needs to be stored.

A **design index** (`src/design-index.ts`) is a JSON file of profiles; `addProfile` dedupes by
`source.digest` (re-adding an unchanged profile replaces, not duplicates), and `findProfiles`
matches every requested section/component/mechanic/depth against a `--min` probability floor
(default 0.5), a Choice filter against the judgment's chosen option or a matching probability,
ranks by the product of every matched probability then by `meta.total_likes`, and throws — listing
the valid ids — on an unknown taxonomy label.

The CLI lives in its own file, `src/design-index-cli.ts` (`npm run design-index --`), with four
subcommands:

```sh
design-index profile <file> [--kind prompt|brief|spec|html] [--id x] [--title t] [--out profile.json] [--meta key=value ...]
design-index profile --catalog-db <path> --id <prompt-id> [--out ...]      # reads text from a catalog read-only
design-index add <profile.json ...> [--index design-index.json]
design-index find [--index f] [--section s ...] [--component c ...] [--mechanic m ...] [--depth d ...]
                  [--skin k] [--spine S] [--archetype A] [--family f] [--format F] [--action a]
                  [--ground g] [--topology t] [--typography y] [--imagery i]
                  [--min 0.5] [--text substring] [--limit 25] [--json]
design-index list [--index f] [--json]
```

`--catalog-db` opens the given SQLite file read-only (`new DatabaseSync(path, { readOnly: true
})`, built into Node 24) and reads one prompt's `title`/`original_text` as the profile input.
Exit codes match the router's: 0 success (including `find` with no matches, which prints
"0 matches"), 1 usage or runtime error — `profile`'s Jev errors throw, they are never advisory.

`scripts/profile-catalog.ts` profiles the 25 most-liked full-page entries in a local prompt
catalog (read-only, `node:sqlite`) and writes a design index plus `REPORT.md` under the agency
workspace, never the product repo or the catalog repo; `original_text` (licence-restricted
reference text) is read into memory as the profile input only, never written to a file or
printed. An API error for one entry is retried up to twice before the entry is recorded as a
failure and the run continues.

## Test

```sh
pnpm --filter @mish/agency-fast-lane test
```

## Bundled word list

`src/wordlist/scowl-en-us-50.ts` is the English word list the composed fill's lexical completion
gate reads (`src/lexicon.ts`): ESDB (formerly SCOWL) size 50, US spelling, lowercase words only,
61,700 words, gzip + base64 (about 214 KB as code; decoded once per process in about 10 ms). The
source revision and parameters are in the module's header and `SCOWL_EN_US_50_REVISION`; the
licence (Kevin Atkinson, permissive) is `src/wordlist/LICENSE-SCOWL.txt`, copied to
`dist/wordlist/`. Regenerate with `scripts/build-wordlist.ts` (usage in its header).
