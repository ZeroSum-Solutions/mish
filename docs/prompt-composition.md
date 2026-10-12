# Prompt composition — the variant axes

Read this before changing any prompt text, wherever it lives.

## The one thing to know first

A generation run is composed by ONE of two independent implementations, and
`apps/daemon/src/prompts/` is only one of them. The fork is an early return at
the top of `composeSystemPrompt`:

```ts
// apps/daemon/src/prompts/system.ts:905
}: ComposeInput): string {
  if (odNextStrategyRecipe) {
    return composeOdNextStrategyRequestPromptV2(odNextStrategyRecipe, {...});
  }
  // ↓ everything below — the entire legacy stack — is skipped on the OD Next path
```

The API/BYOK mirror at `packages/contracts/src/prompts/system.ts:318` forks the
same way. The two sides share no composition floor: a rule added to one holds
only for the runs that take that side.

## Which runs take which path

OD Next is opt-in (off for an installation that configured nothing, decision D14) and gated. `evaluateOdNextRollout`
(`apps/daemon/src/strategies/od-next/rollout.ts:151`) is an AND over the policy
and one run's facts, and some of its inputs vary run to run on one machine —
which is why a divergence between the two sides surfaces as an **intermittent**
bug rather than a reproducible one:

- **Scenario provenance** (`rollout.ts:134`,
  `odNextTaskTypeForProjectScenarioBinding`) requires
  `provenance === 'automatic_default'`. A project where the user explicitly
  picked a scenario resolves `taskType` to null and takes the legacy path.
- `agentId` must be one of `codex` / `claude` / `opencode` / `amr`,
  `sourceKind` must be `bundled`, and the runtime capability preflight must
  have passed.

Nothing outside one run's own inputs takes part. There used to be a stop latch —
a row a failing run wrote that disabled OD Next for the whole daemon instance,
outranked the saved mode, and survived restart while the Labs switch still read
"on". It is gone, so a divergence you are chasing cannot be a leftover from an
earlier run on the same machine.

User-facing switch: Settings → Labs → Design Harness
(`apps/web/src/components/LabsSection.tsx`, reading
`GET /api/strategies/od-next/rollout`). Process override:
`OD_NEXT_STRATEGY_ROLLOUT`. Saved preference: app-config `odNextStrategyMode`.

## The variant axes

Changing "the prompt" can mean up to four edits. Check each one:

| Axis | Switch | A side | B side |
|---|---|---|---|
| Strategy | `odNextStrategyRecipe` (`apps/daemon/src/prompts/system.ts:905`) | `apps/daemon/src/prompts/` | `plugins/_official/scenarios/od-next-strategy/assets/**` plus TypeScript in `packages/contracts/src/prompts/od-next-strategy.ts` |
| Legacy core | `OD_PROMPT_CORE` (`apps/daemon/src/server.ts:10049`) — **default is `slim`**, `classic` is the opt-out | `apps/daemon/src/prompts/core-slim.ts` | `official-system.ts` + `discovery.ts` |
| Execution mode | none; hand-maintained mirror | TypeScript in `apps/daemon/src/prompts/` | TypeScript in `packages/contracts/src/prompts/` (API/BYOK) |
| OD Next internals | none; the same list is declared twice | `OD_NEXT_PROMPT_STAGE_CONTRACT_V2` (`packages/contracts/src/prompts/od-next-strategy.ts:214`) | `od.pipeline.stages` in the plugin's `open-design.json` |
| Generation route | `/api/runs` versus `/api/workbench/capture-drafts` | General legacy/API-BYOK or OD Next composition above | Dedicated `renderCaptureDraftPrompt` in `packages/contracts/src/prompts/capture-draft.ts`; initial and iteration turns share one host directive |

The capture-draft route bypasses the general composers. Web and CLI both call
the same daemon service; neither composes a prompt locally. The dedicated turn
uses the shared contracts renderer through the daemon's re-export in
`apps/daemon/src/prompts/capture-draft.ts`. It has no classic/slim, OD Next or
API/BYOK variant. Its only input variation is an initial screenshot request
versus an iteration with `currentHtml`.

On the third axis, five pairs are still hand-maintained and have already
drifted, so diffing a pair is not a reliable way to find what a change is
missing:

| File | daemon | contracts |
|---|---|---|
| `system.ts` | 2048 | 1141 |
| `discovery.ts` | 317 | 286 |
| `directions.ts` | 321 | 284 |
| `media-contract.ts` | 594 | 154 |
| `official-system.ts` | 202 | 163 |
| `core-slim.ts` | 429 | **absent** |

`core-slim.ts` having no contracts counterpart means the API/BYOK path cannot
receive the slim charter at all — `packages/contracts/src/prompts/system.ts`
has no `promptCoreVariant` input. Whether that is intended has not been
established here; treat it as an observed asymmetry, not a known bug.

`deck-framework.ts` is the exception and the model: see below.

## Host runtime contracts

These are not style preferences. Each is consumed by product code, and a
generated artifact that omits one is not controllable by the host. They belong
to the **host**, not to either strategy — if a strategy is retired, these stay.

| Contract | Host consumer | Legacy | OD Next | Capture draft |
|---|---|---|---|---|
| `data-od-deck-protocol="1"` on `<html>` | `apps/web/src/runtime/srcdoc.ts:3136` — how the host recognizes a v1-native deck | ✅ | ✅ | N/A |
| `od:deck-ready` announce (`protocolVersion`, `capabilities`) | `srcdoc.ts` ready listener — a message without `protocolVersion === 1` is ignored | ✅ | ✅ | N/A |
| `od:slide-state` `{active, count}` posts | unified slide counter and toolbar state | ✅ | ✅ | N/A |
| `od:slide` navigate listener | host-driven paging (`next`/`prev`/`first`/`last`/`go`) | ✅ | ✅ | N/A |
| `id="deck-stage"` | `srcdoc.ts:3145` `isFrameworkDeck` → stage style fix, disables click-nav | ✅ | ✅ | N/A |
| `@media print` block | Share → PDF multi-page stitching | ✅ | ✅ | N/A |
| `<question-form>` | `AssistantMessage.tsx` → `QuestionFormView`; `runAskedUserQuestion` analytics | ✅ `discovery.ts` | ✅ `od-next-strategy.ts:434` | N/A |
| `.od-frames/` device shells | prototype device frames | ❌ | ✅ OD Next only | N/A |
| `<design-brief>` accepted R15 brief | `POST /api/runs` `brief` → `resolveRunDesignBrief` (`apps/daemon/src/workbench/brief/run-binding.ts`) | ✅ daemon + API/BYOK `## Accepted design brief` | ✅ `kind="fact" name="accepted-design-brief"` | N/A |
| Screenshot draft JSON: exactly `html` and `assumptions`; editable standalone HTML with no imported assets, network calls or navigation escape APIs | `apps/daemon/src/workbench/capture/draft-generator.ts` structured output → `draft-service.ts` validation/persistence → `apps/web/src/providers/workbench-capture-drafts.ts` sandboxed preview and unit source | N/A | N/A | ✅ `CAPTURE_DRAFT_HOST_DIRECTIVE`, `CAPTURE_DRAFT_MODEL_JSON_SCHEMA` and `renderCaptureDraftPrompt` in shared contracts |

N/A means the contract belongs to a different route or artifact kind. Capture
drafts are standalone HTML references, not deck or general agent runs. Their
host directive and schema have one source in contracts, following the shared
deck-contract pattern. Both initial and iteration turns use that source;
prompt text, screenshot text and current HTML remain untrusted reference data.
The service strips EXIF/GPS and other metadata before the generator receives
image bytes; the adapter also strips at staging for direct calls and older
captures. Focused checks are `packages/contracts/tests/capture-draft-prompt.test.ts`
and `apps/daemon/tests/workbench/capture-draft-generator.test.ts`.

Two things to read off this table.

**The deck rows are the model for how a host contract should be carried.** One
source — `renderDeckFrameworkDirective` /
`renderLegacyDeckCompatibilityDirective` in
`packages/contracts/src/prompts/deck-framework.ts:573`, whose skeleton pins
`data-od-deck-protocol="1"` at line 48 — feeds all three prompt paths. The
daemon file is now a ten-line re-export whose own docblock states the reason:
"the canonical deck scaffold lives in contracts so classic, BYOK, and OD Next
prompt paths cannot drift." OD Next reaches it through
`resolveOdNextDeckFrameworkMode` (`od-next-strategy.ts:187`), which picks
`canonical` for a blank deck and `legacy_compatible` when a seed or existing
deck HTML is present, and the directive is emitted as an
`<od-next-context kind="instruction" name="deck-framework">` block
(`od-next-strategy.ts:548`). The wiring that supplies those inputs lives at
`apps/daemon/src/server.ts:10125`. Copy this shape for the next contract.

**The divergence still runs both ways.** OD Next is not a superset of legacy;
it owns `.od-frames/` device shells that legacy has no equivalent for. And OD
Next content has two possible homes — the plugin's markdown assets and the
TypeScript in `od-next-strategy.ts`. The deck contract lives in the TypeScript,
not in `ppt.md`. Check both before concluding a contract is absent on that
side.

## Worked example: #7568, then #7651

These two PRs are the same author, three days apart, and together they are the
clearest statement of what this document is for.

**#7568** (`fix(deck): make legacy thumbnail navigation instant`, merged
2026-08-29, `973e868ce`) introduced deck protocol v1 across 18 files,
+510/-44. Its stated purpose, in its own PR body, was to give newly generated
decks "one canonical, versioned navigation protocol so future agents do not
create more navigation dialects."

It handled the daemon ↔ contracts axis completely: a shared constant so the two
prompt copies could not drift on the protocol, both copies changed, a guard
added on each side, and validation that ran the full web (7,139 tests) and
contracts (500) suites plus two packaged DMG end-to-end runs. By every
convention in this repository it was a thorough PR.

It touched nothing under `plugins/_official/scenarios/` and nothing in
`od-next-strategy.ts`. Every deck generated on the OD Next path still shipped
no protocol: the PR whose goal was to stop new navigation dialects left one
live.

Three things made the miss invisible. All three are worth checking against your
own change:

- **The guards it added could not reach the other side.** Both new tests called
  `composeSystemPrompt({ skillMode: 'deck' })` with no `odNextStrategyRecipe`,
  so they never passed the fork. The daemon one was named
  `'ships new Agent decks with OD Deck Protocol v1'` — a claim about Agent
  decks that was false for every OD Next run, asserted by a test that was
  green. A test name is not coverage; check what its inputs can actually reach.
- **The snapshot moved and stayed green.**
  `apps/daemon/tests/prompts/__snapshots__/system-prompt-matrix.test.ts.snap`
  updated cleanly, because every scenario in that matrix takes the legacy
  branch. That is still true today.
- **Sharing a constant fixed the machine-readable half only.** The directive
  prose around the shared protocol constant had already drifted between the two
  copies before #7568, and #7568 inserted the same new clause into both — into
  two sentences that already disagreed.

**#7651** (`fix(deck): pin deck protocol in OD Next prompts`, merged
2026-08-31, `f65d245de`) repaid it: 16 files, +855/-622, including a new
`od-next-prompt-recipe.test.ts`, a new `plugins-strategy-recipe.test.ts`, and
new `e2e/ui/real-daemon-run.test.ts` coverage. The fix is the right shape — it
collapsed the deck scaffold to a single source in contracts and reached OD Next
through the recipe rather than copying the skeleton into markdown — and it is
the reason the deck rows above now read ✅ on both sides.

The transferable rule is the cost, not the outcome: closing a one-sided change
took a second PR nearly twice the size of the first. Before landing a change to
generated-artifact behavior, name every path that composes a prompt, then say
for each one whether your change reaches it. "The tests are green" answers a
narrower question than that.

## Editing rules

- **Changing a rule that affects generated artifacts?** Apply it to every
  affected path, or state in the PR body why one is genuinely out of scope.
  "I'll do OD Next later" leaves the bug live for whichever runs take that path.
- **Adding a host contract?** Give it one source that all paths consume, the
  way `deck-framework.ts` now does, and add its row to the table above in the
  same PR.
- **Prompt-facing vs. maintenance text.** Everything under
  `plugins/_official/scenarios/od-next-strategy/assets/` is sent to the model
  verbatim. Never put repository-maintenance notes there — put them in that
  folder's `AGENTS.md`, which is not part of the asset roster. In
  `apps/daemon/src/prompts/` and `packages/contracts/src/prompts/` the exported
  string is the prompt, so `/** */` docblocks above an export are safe.
- **A green suite is not evidence that both sides carry your change.**
  `apps/daemon/tests/prompts/system-prompt-matrix.test.ts` freezes which
  sections each scenario receives, but every one of its scenarios takes the
  legacy branch, so it cannot see an OD Next regression.

## Editing the OD Next plugin assets

`plugins/_official/scenarios/od-next-strategy/assets/core-system-prompt.md`,
`plugins/_official/scenarios/od-next-strategy/assets/general-orchestration.md`, and exactly
one `assets/task-profiles/<taskType>.md` are decoded and concatenated verbatim
into the prompt bundle
(`apps/daemon/src/strategies/od-next/initial-prompt-bundle-service.ts`).

`apps/daemon/src/plugins/strategy-package.ts:158` builds an explicit roster:

- The package's `open-design.json` and `SKILL.md`.
- `assets.core.path` and `assets.orchestration.path`.
- The selected task profile's `path` and `assets.taskProfileMapping.path`.
- The selected profile's `resources[*].path`.

Only those files are read, and only those are hashed into the package identity.

- A file the manifest does not declare (that folder's `AGENTS.md`, for
  instance) has **zero** runtime effect — not read, not hashed.
- `open-design.json` and `SKILL.md` **are** in the roster. Editing either moves
  the package identity.
- Only the *selected* profile's `resources` join the roster, so one task type's
  resources changing does not move another task type's hash.
- Changing a task profile's body should come with a `version` bump on its entry
  in `open-design.json`.

Two shapes for adding content a profile needs. **Prompt text** goes in the
profile's own `.md`. **Non-prompt files** (skeletons, shells, stylesheets) get a
`resources` entry on that profile in `open-design.json`; `prototype` does this
with `assets/task-profiles/prototype/device-frames/*.html` and `layout.css`,
staged into the project as `.od-frames/` and referenced by the profile, never
concatenated into the prompt head. Prefer neither when the content is a host
contract — give it one source in `packages/contracts` and have every path
consume it, as the deck framework now does.

## Known gaps

Verified on `6fb440a86` (2026-08-31).

- Five daemon/contracts prompt pairs remain hand-maintained and already
  divergent (table above). `deck-framework.ts` shows what unifying one looks
  like; none of the others has been done.
- `core-slim.ts` exists only on the daemon side, so the API/BYOK path cannot
  select the slim charter.
- No machine check covers the OD Next column of the contract table.
  `packages/contracts/tests/system-prompt.test.ts` and
  `apps/daemon/tests/prompts/system.test.ts` keep the legacy copies honest, but
  neither passes an OD Next recipe. #7651 added
  `packages/contracts/tests/od-next-prompt-recipe.test.ts`, which does exercise
  the OD Next recipe for the deck contract specifically; nothing generalizes
  that to the other rows.

## Design-system consumer binding

`packages/contracts/src/prompts/design-system-binding.ts` owns the shared Plan/Build binding instruction and token/usage block builders. The daemon legacy composer, API/BYOK legacy composer and OD Next composer all include that instruction for an active system. API/BYOK legacy also carries the supplied CSS and usage text. OD Next keeps CSS as reference data and carries its application contract as a separate instruction block.

When a source stylesheet is supplied, copy it completely, including scoped themes and media queries. Prose-only systems use the documented roles, typography and layout directly; consumers must not search for missing CSS or label invented values as source tokens. Product declarations must reference the selected source or consumer-adapter variables. Role aliases may reference source variables; palette order and saturation do not establish a role. Packages may supply a consumer adapter in USAGE.md with explicit source evidence, local range choices and font substitutions. Original source values remain intact; ambiguous roles stay labeled rather than acquiring an invented semantic meaning.

Source descriptions may name a Feature Checklist component. The OD Next source-context guard disambiguates that specific visual noun without rewriting the source sent to the model. It still rejects post-Build workflow instructions. Focused consumer-fidelity tests cover that distinction, the API/OD Next binding seam, complete dark-mode CSS retention and both daemon core variants.

## Accepted design brief (R15 Improve prompt)

Home Improve holds a portable preview in client state. Opening, transforming, editing and dismissing the dialog create no project or stored brief. `POST /api/workbench/briefs/preview` transforms without project context or persistence; `od workbench transform --prompt-file <path|-> --json` uses that endpoint when `--project` is omitted. The preview cannot carry admitted resource refs or reference attribution. Existing project-bound transforms still use `POST /api/workbench/briefs`.

Use prompt accepts the preview locally. On Run, Home checks the reviewed setup and AMR gate, creates the project, then calls `POST /api/workbench/briefs/attach` with `{projectId, preview}`. Attachment attributes adopted facts to the accepting user, preserves inferred assumptions, and saves the reviewed wording as draft revision 1 and accepted revision 2 without another model call. `od workbench brief attach --project <id> --input-file <path|-> --json` exposes the same operation. A failed attachment can retry against the project already created by that Run.

`packages/contracts/src/prompts/design-brief.ts` is the one renderer. `renderDesignBriefPrompt` produces the stored `renderedPrompt`; `renderDesignBriefDirective` wraps it as the `## Accepted design brief` section. The daemon legacy composer (classic, slim, ask and media), the API/BYOK legacy composer and the OD Next stable request context (a `kind="fact"` block named `accepted-design-brief`) all inject that directive, and each composer forwards `designBrief` across its OD Next fork. The daemon sets `designBrief` only from the `brief: {id, revision, hash}` on `POST /api/runs`, after `resolveForRun` checks the accepted revision, its hash and a fresh render; a `designBrief` in request JSON is stripped. The OD Next strategy-task path receives it through `meta.designBrief` in `initial-prompt-bundle-service.ts`.

The brief is user intent, not host authority. The renderer states that it cannot change workspace, file, output, tool or security instructions, labels `assumed` values as inferences, and escapes `&`, `<` and `>` inside the fenced JSON so brief text cannot close the fence. Reference titles, attribution, excerpts and proposed diffs stay in the brief record and are never rendered. Focused checks: `packages/contracts/tests/workbench-brief.test.ts` (API/BYOK and OD Next) and `apps/daemon/tests/workbench/design-brief-routes.test.ts` (daemon classic, slim, ask and OD Next fork).

Before storing a transformed brief, `apps/daemon/src/workbench/brief/grounding.ts` checks each stated field and section against the original client description through a separate typed judgment on the existing no-tool Claude Max lane. Supported paraphrases retain `stated`; unsupported or contradicted claims become `assumed` with a visible `groundingReason`. Missing, invalid or unavailable checker output marks every stated claim `unverified`. The same check extracts explicitly requested font families and roles into stated typography, without claiming font files are admitted or available. The transformer cannot assign host-owned `user`, `reference` or `unverified` bases or grounding reasons. User overrides still win. The dialog and shared renderer carry the reasons and unverified labels; the renderer prevents contradicted values from becoming business claims or defaults. Tests stub the checker and model process in `apps/daemon/tests/workbench/design-brief-grounding.test.ts`; they make no live provider calls.
