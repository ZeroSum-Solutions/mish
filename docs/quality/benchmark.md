# Agency quality benchmark

This opt-in harness measures generated sites through the public Build on brand API (`grade`) and compares designs pairwise (`compare`, below). It never starts, stops or restarts a Mishh Mashh service, deploys a site or calls a billed model API. Only `compare --writers` changes a daemon setting: it switches the Improve prompt writer (`improvePromptTransformer`) for each writer and restores the saved value afterwards, so run it on an isolated runtime. Run outputs stay on disk. The caller owns the daemon and the benchmark projects it creates.

The five original fictional briefs keep their frozen text in `e2e/benchmarks/quality/cases.ts`: dental first, then restaurant, law firm, SaaS and fitness. Brightwater Family Dental joins them as a development regression anchor. Its exact brief comes from `~/Inbox/screenshots/flagship-demo-2026-10-09/atlas-ui/evidence.json`; the saved `~/Inbox/screenshots/flagship-demo-2026-10-09/atlas-ui-d14/evidence.json` has identical text. Each case records supplied facts, omitted facts, a declared conversion and its split. Selection defaults to `dev`; this slice authors no unseen briefs. Each uses Atlas TL.02 (`user:atlas-sage-space-tl02`) by default. `--kit ID` overrides the kit for all selected cases. The daemon must already have that kit installed and published.

## First live baseline

The release candidate `agency-bar/2.0.0-rc1` lives in `e2e/benchmarks/quality/bar.ts`. [agency-bar.md](agency-bar.md) is generated with `pnpm --filter @mish/e2e bar:docs`; its drift test proves the judge reads the same source. The JSON status is `approved` for this release candidate. **The bar freezes at the end of QT-4. No baseline is taken before then.** After the freeze, a change to anchors, weights, bands or caps needs a version bump, re-calibration and a new baseline. Every criterion has explicit 1–5 anchors, weights total 11.0, and the rubric defines each letter A–F. Its complete text is hashed and retained with the judgments.

Use an already running, caller-supplied loopback HTTP daemon and the installed Claude subscription. Select an available agent/model for generation. This example uses Claude; replace the port with the daemon's actual port. From the repository root:

```bash
mkdir -p "$PWD/.tmp/quality"
pnpm exec tsx e2e/benchmarks/quality/cli.ts run \
  --daemon http://127.0.0.1:PORT \
  --out "$PWD/.tmp/quality/baseline-01" \
  --agent claude --model claude-opus-5-5 \
  --judge-model claude-sonnet-5-5
```

`--out` must be a new directory under an existing parent. Relative output paths resolve from the caller working directory; use absolute paths as above. Reuse fails before any build request. If authentication is required, the caller supplies `OD_TOOL_TOKEN` through the environment; it never enters saved requests or command arguments. Daemon-managed paths follow the root [AGENTS.md data directory contract](../../AGENTS.md#daemon-data-directory-contract).

Each build gets a fresh daemon project. `run.json` also carries a fingerprint: the brief/fact fixture digest, kit id and complete kit-inventory content hash when public APIs expose every file, saved local font and non-HTML asset receipts, public prompt routing metadata, actual builder identity when exposed, and capture settings. The harness reads only public APIs and the saved inventory. Every unavailable field has an explicit reason; requested agent/model settings remain separate from actual identity. Non-HTML receipts cover final saved bytes; the API does not identify which assets came from staging rather than the builder. Kit bytes are sampled before generation, not claimed as an immutable build-time snapshot. A missing full kit inventory, font file or actual model identity never gets a guessed hash. The fingerprint has its own digest. Adding structured facts and Brightwater changes the fixture digest, so older case sets need a fresh measurement. QT-1's bar-version fingerprint hookup follows its merge. The harness saves request, returned plan and run identity, terminal run metadata, site-check results, wall time, copied files and file hashes. It uses the public file inventory and raw-file API, including nested assets. Missing planned pages and failed generations stay visible. Timeout handling cancels only the benchmark's own run and verifies a terminal state. An uncertain admission or cancellation stops the batch with retained receipts; inspect its project/run inventory before retrying. It never deletes a benchmark project automatically.

Capture uses the installed e2e Playwright Chromium, one isolated context per page and viewport. If Chromium is absent, install it with `pnpm --filter @mish/e2e exec playwright install chromium`. Every generated HTML page, excluding staged `_brand-build` fragments, gets full-page screenshots at 320×640, 375×812, 390×844, 768×1024 and 1440×900. `captures.json` now uses `quality-captures/2`; packet verification and scoring reject the old schema. Full-page PNGs retain their SHA-256 receipts and stay at the requested viewport width even when the document overflows. Images and fonts settle; scrolling triggers reveal content. Capture records horizontal overflow, console and page errors, broken images, blocked remote requests and capture failures. Capture blocks off-origin HTTP requests and WebSockets. This diagnostic browser is not a security sandbox for arbitrary imported code. Pages serve from an ephemeral loopback artifact server; it shuts down after capture.

Each page/width gets an id such as `dental-p0-320`. Every visible landmark and section gets a crop with an id such as `dental-p0-320-s0`, its DOM selector, original document bounding box, clipped crop box and PNG hash. Nested landmarks are included. The crop box records any clipping to the full-page PNG. A page without visible landmarks records missing section evidence.

The evidence JSON beside each PNG records:

- Conversion controls matched against the case's declared action labels; ordinary Contact navigation does not substitute for an appointment, table, consultation or demo action, with served-file or in-page target resolution. The returned plan supplies destination page roles. Cross-page fragments are checked against saved HTML; JavaScript-only destinations remain unresolved.
- Demo form action/method, whether a submit control could be exercised, and observed request attempts. Capture uses synthetic inputs, blocks all requests during interaction, and records attempted POSTs. A synthetic 204 keeps native form navigation on the captured document; no submission reaches a service. The observation window is two render frames after the click, so delayed requests beyond it are not proven absent. Unexercised forms retain the reason.
- A bounded keyboard tab walk: initial tab-stop count, visited control selectors, visible outline/shadow evidence, repeated-focus trap detection, primary-control reachability and budget exhaustion. Other focus paint treatments stay unknown rather than passing. The trap flag records a repeat before all initially counted controls were reached; it is diagnostic evidence, not an accessibility verdict.
- Normal and reduced-motion samples in separate contexts, each over 12 render frames: running animation count, measured layout shift and moved-element count. Late or interaction-triggered motion outside that window remains unobserved.
- Requested resources with response status and available body-byte counts, image/font byte totals, declared font-face loading state, requested text families/weights/styles, and rendered versus natural image dimensions. System-font availability stays unknown. A failed response-body read records that failure.

Each probe records `complete`, `missing` or `failed`. Complete means the measurement ran; a broken destination or keyboard trap remains visible in its values. QT-2 adds no quality judgment or new scoring policy. Per-capture JSON has a hash and must match `captures.json`; verification also checks every section PNG, full-page PNG, copied artifact and page/viewport identity.

QT-3 uses `quality-judgments/2`. The judge evaluates one page per request. It sends lossless full-page tiles at 1440 and 390, then up to four section crops per width (each at most 800 px high) if they fit. The other three widths travel as mechanical facts. Each page includes its HTML and the case's frozen CSS/JS source. Required source/facts must fit 2 MB; required images and content must fit 23 MB and 100 images, leaving request headroom.

Each page has two subscription reviewers and three independent inventory-to-score samples per reviewer: twelve calls per page. The harness runs two cases at a time, with six independent samples together on each page (at most twelve provider children); the harness serializes receipt publication and waits for every sibling before reporting a provider failure. Inventory cites unread items. Scoring determines evidence separately for each criterion. Required visual criteria are artDirection, imagery, typography, layout, briefFidelity and responsive. A required null makes the case missing-evidence. Optional craft/accessibility gaps keep a null with a reason, including uncaptured carousel or menu states. They do not void the case. Missing rendered evidence stays inconclusive without a fabricated F.

Case criterion scores use the weakest page median. Reports retain page scores, null reasons and page uncertainty. A full eight-criterion rubric roll-up stays unavailable if any criterion is null. The separate `informational-letters.json` reports UNCALIBRATED reviewer letters: the median of six letters per page, ties toward the weaker band, then the weakest page letter for the case. If a reviewer leaves its overall letter null but scores all required visual criteria, derive that sample letter from its non-null criteria using their normalized weights and report the derived count. The raw null scores and letter stay in the receipts; the full rubric M stays unavailable. Known criterion caps still apply; Partial evidence or incomplete eligibility cannot produce A. These letters never fill null scores, compute M, establish eligibility or accept a draft.

Claude Sonnet 5.5 or Opus 5.5 runs through `claude -p` on Max, with image blocks, JSON schema, tools/MCP/settings sources disabled, filtered environment, subscription authentication and initialization/model checks. Codex runs `codex exec -i` with `gpt-6.1-sol`, `service_tier="priority"`, forced ChatGPT authentication, the built-in OpenAI provider, ignored user config/rules, read-only sandbox, disabled shell/apps/search/agent tools and an isolated working directory. The output uses a schema and a separate last-message file. API credentials and routing overrides do not reach either child. Both lanes reject unlisted models and have no fallback; Jev is disabled. `subscription.ts:assertJudgeRoute` is the clearly marked **QT-34 integration point**, pending integration of the external billing-policy core; this slice does not depend on its branch.

Requested model identities and observed actual model identities are separate. Claude must report an allowed actual model. Codex may omit model identity from its JSONL events: the requested model remains pinned, and actual identity is reported as unknown rather than inferred from the argument. The [official configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference) documents the authentication, provider, tier and tool controls; local `codex exec --help` verifies image/schema/ephemeral/config flags. Live inference receipts provide packet-specific evidence; they do not establish calibration.

Full-page PNGs stay intact; each reviewer receives bounded lossless tiles, at most 1600 pixels high. Each sample retains immutable inventory and score receipts, their hashes, reviewer/index/model provenance, timing and input digests. Judgment evidence binds the saved run/case bytes, captures and rubric. Scoring and baseline use verify all phase hashes, sample values, timing and live subscription provenance. Relabelling stub receipts as live is refused. Partial progress and phase publication are atomic; resume preserves the original first-judge timestamp, verifies prior hashes and reuses completed phases. Changed inputs, evaluators or settings require a fresh packet. Keep corrupted packets for diagnosis; do not delete receipts to force a silent rerun.

Reports show each reviewer's per-criterion median, minimum, maximum and spread, then the weakest page median for the case and the largest page-level reviewer disagreement. Spread is the largest within-page sample spread. They keep all samples and any unassessable criterion visible. A criterion with any unassessable sample has no aggregate score; partial missing-evidence samples cannot produce a recommendation. This is descriptive judge variation, not builder variance or calibrated confidence. The advisory roll-up permits fractional sample medians while individual ratings remain whole numbers. No minimum-of-reviewers rule is applied. Worker time, judge wall time, incremental cash ($0 on these lanes) and unavailable subscription usage are separate. Repeated builds are still needed to estimate builder variance. Stub mode makes no provider calls.

## Compare a candidate

Keep generation settings, selected case set, kit, judge model and rubric identical to the saved baseline:

```bash
pnpm exec tsx e2e/benchmarks/quality/cli.ts run \
  --daemon http://127.0.0.1:PORT \
  --out "$PWD/.tmp/quality/candidate-01" \
  --agent claude --model claude-opus-5-5 \
  --baseline "$PWD/.tmp/quality/baseline-01" --threshold 0 --gate
```

Comparisons also require the same Chromium version and capture protocol. The protocol hashes cover the full capture and judge source, so any source edit, including comments or line endings, requires a fresh baseline. Take the live baseline after those files settle. The report shows per-case grades, criterion scores, failures, build seconds, criterion deltas and build-time deltas. Criterion deltas and drops greater than `--threshold` are advisory only; they never change the mechanical gate or the exit code. The option ranges from 0 to 4 score points and defaults to 0 for compatibility. It is a reporting filter, not a calibrated regression threshold. Interpret deltas using measured variance and matching case sets; the harness applies no aggregate five-case mean rule. Build time is reported, never a quality target. Evidence failures also exit 1. `--gate` additionally refuses synthetic evidence or an unapproved rubric. Incomparable or incomplete baseline packets fail closed before generation. Current and baseline files and screenshots must match their stored hashes. The default baseline must have complete collected evidence and passing mechanical checks. Add `--measurement-baseline` with `--baseline` to compare against complete evidence with failed mechanical checks. Existing failures and current eligibility remain visible: a regression gate can pass while the current mechanical outcome is failed. New or worsened confirmed findings gate; quality deltas never do. Missing, stale, malformed or unread evidence is refused in both policies. Baselines require matching case sets, requested settings, kit-byte identities when available, exposed prompt variants and actual builder identities, reviewer configuration and observed model provenance. Unavailable fingerprint fields remain explicit uncertainty; a comparison does not prove they were frozen. Model findings stay advisory. No baseline means an initial measurement, not a claim that quality improved.

To collect **blind human ratings before judging**, run `run --capture-only` (with `--stub` for local validation) or the capture stage. Both write `human-check.html` before any model evaluation. The sheet exhausts every generated page, all its sections through full-page images, and all five widths; its criterion list follows the selected rubric. It hides model results and supports A–F, every criterion from 1–5 or not assessable, rater identity and notes. Export downloads `quality-human-check/2` only when every field is rated. State is page-local until export; reload loses unexported work. The export includes run, fixture, rubric and rating-time identities.

After judging, score with `--human-ratings HUMAN_RATINGS_JSON` (repeat the option for a second rater). `human-agreement.json` reports per-criterion agreement and disagreements, letter gaps and any two-letter gap requiring investigation. Raters and complete case sets are validated; ratings after the original first-judge timestamp are refused as human-first evidence, including after resume. This is an input-timestamp check, not independent proof of blindness. One rater cannot claim AC-R15.4. The source-blind calibration set and explicit protocol-freeze workflow are described below. No expected Brightwater C, calibrated grade or holdout is claimed.

Only confirmed mechanical regressions and missing/stale collected evidence control the gate. Body-byte read failures, suspected keyboard traps, exhausted tab walks, unverified generation termination and blocked form attempts stay inconclusive rather than becoming confirmed failures or silent passes. Model findings, criterion deltas and letters stay advisory. Content truthfulness and factual-image provenance still require authoritative judgments; the harness leaves them inconclusive and cannot recommend A. Passing the measured regression gate never accepts or deploys a draft, changes a product review outcome or clears a required judgment. The gate can pass complete measured checks while these separate required content judgments remain open.

To rerun a stage without another generation:

```bash
pnpm exec tsx e2e/benchmarks/quality/cli.ts capture --out ABSOLUTE_RUN_DIR
pnpm exec tsx e2e/benchmarks/quality/cli.ts judge --out ABSOLUTE_RUN_DIR
pnpm exec tsx e2e/benchmarks/quality/cli.ts score --out ABSOLUTE_RUN_DIR --baseline ABSOLUTE_BASELINE_DIR --gate
```

Capture requires no existing `screenshots/` directory. Judge refuses an existing final `judgments.json`. Interrupted judging resumes from atomic `judgments.partial.json` and matching per-sample phase receipts without repeating completed phases. Changed inputs or settings fail closed. Preserve the old packet before attempting a fresh capture or judgment. Score rewrites only the derived report files. `--case dental` is a focused diagnostic; it compares only with a baseline of that same selected case.

## Compare designs pairwise (`compare`)

`grade` scores one build path against the bar. `compare` answers a different question: which of several inputs, or which build of the same input, makes the better design? Every design is built through a product path, captured with the same protocol as `grade`, then judged against the others blind and in both orders.

```bash
pnpm --filter @mish/e2e exec tsx benchmarks/quality/cli.ts compare --help
```

- **`--writers original,claude,terra`** builds every improve-prompt case once per writer: `original` is the client request alone, and every other name is an Improve prompt writer whose brief is attached and bound to the run. Briefs come from the daemon's own lanes, or with `--briefs DIR` from `DIR/<case>/<writer>.preview.json`. Every brief is saved under `briefs/`, so any run can be frozen and replayed without writer calls. Any writer name works with `--briefs`, which is how experimental brief styles are compared before a writer changes.
- **`--build PREVIOUS_DIR`** rebuilds each arm of an earlier compare on the current code from its frozen briefs and judges each new design against the stored one. Use it before a brand-look or builder change ships.
- **`--reps N`** (1–5) builds each case and input N times. Pairs are judged within a rep and summed in the report. One rep is labelled single-rep; read its margins as direction only.

**Builders.** One `Builder` interface (`builders/`) with three implementations; the run fingerprint records which ran and with what options:

| Builder | Path | Used by |
|---|---|---|
| `build-on-brand` | `POST /api/build-on-brand`, four pages on the case kit. QT's path, unchanged. | `grade` (default) |
| `chat-run` | New project with discovery skipped, `POST /api/workbench/briefs/attach`, then `POST /api/runs` with the brief bound by id, revision and hash. | `compare --writers` (required) |
| `agency-build` | Home "Build with Jev": `POST /api/agency/build` (`family: auto`, `verify: strict`), polled through `/api/agency/builds/:id`. Fill models are the agency lane's own; the observed provider and model are recorded. | `compare --build` on Jev builds |

**Cases.** The five improve-prompt cases (`bakery-preorder`, `saas-invoicing`, `win95-portfolio`, `clinic-access`, `warehouse-dashboard`) are client-style requests, not briefs. They are a separate suite: `grade` still selects only the agency cases unless `--case` names others, so the agency fixture digests are unchanged. Their stated requirements are `suppliedFacts.requirements`, facts the request does not give are `omittedFacts`, and gaps a good brief raises are `questions`. All are `dev`; nothing is a holdout until an `unseen` case exists.

**Judging.** Claude (`claude-opus-5-5` on Max) and GPT-6.1 Sol (`codex exec -i`, ChatGPT subscription) each see the entry page of two designs at 1440 and 390 wide, labelled Design 1 and 2, with the request, the stated requirements, the facts not given and the complete generated bar as the definition of "better". They answer overall, fidelity and visual. Each pair is judged in both orders; a verdict counts only when both orders agree, and otherwise it is reported as unsettled. Every ordered verdict is saved under `pairwise/` with a digest of its inputs, so an interrupted run resumes without re-judging. A mechanical check lists names and numbered tokens from the request missing from each entry page.

**Outputs.** `compare.json` (bar version, case fixture digests, builder, judges, brief digests, arm fingerprints, every verdict), `compare-report.md` (records per judge and aspect, judge agreement, missing terms, build times) and `gallery.html`, a blind gallery for a person to rank before revealing inputs.

**Known limits.** The brief preview does not say which model wrote it, so a writer that fell back to Claude is not visible in the report; the daemon log records it. Judge accuracy is uncalibrated until a person's blind ranking is compared with the judges'.

**Pilot, 2026-10-10.** The first 20-build comparison of Improve prompt writers ran before this tool, with Claude Opus and Gemini Pro (OpenRouter) as judges, so it is not a baseline for this tool's default judges. Its results and blind gallery (`report.md`, `gallery.html`) are kept outside this repository. Terra briefs led (Claude judge 10–2, visual 17–4 across both judges); the original prompt lost on fidelity (2–12). That data set the D28.4 default.

## Local harness checks

```bash
pnpm --filter @mish/e2e exec vitest run -c vitest.config.ts tests/quality
pnpm --filter @mish/e2e typecheck
pnpm exec tsx e2e/benchmarks/quality/cli.ts run \
  --stub --out "$PWD/.tmp/quality/stub-01"
```

Unit tests use temporary HTTP stub daemons and stub judgments. They never generate through a real agent or call a provider. The opt-in stub CLI additionally renders the synthetic files with real Chromium and produces the human sheet. A successful stub run proves harness behavior only.

Output layout: `run.json`, `cases.json`, per-case `request.json` and `files/`, `captures.json`, `screenshots/` (full pages, section crops and hashed probe JSON), `judgments.partial.json`, `judgments.json`, `cases/<id>/judge/<reviewer>-<sample>-<phase>.json` phase receipts and live image tiles, `score.json`, `report.md` `human-check.html` and optional `human-agreement.json`.

## Measurement-baseline example

```bash
pnpm exec tsx e2e/benchmarks/quality/cli.ts score \
  --out ABSOLUTE_CANDIDATE_DIR --baseline ABSOLUTE_BASELINE_DIR \
  --measurement-baseline --gate
```

`score.json` separates `outcome` (current measured state) from `passed` (the regression gate). The report preserves each current defect and its evidence even when no new defect appeared. The evaluator digest covers gate, evidence-validation, aggregation and bar source; the judge and capture protocols have separate digests. A changed evaluator is not silently applied to historical packets.

Live judging and scoring reject unsupported versions or altered published rubric contracts. The judge requires the complete generated bar document. Unjudged cases have no numeric scores, letters, caps or deltas.

Keyboard evidence stops at shadow hosts, custom elements and frames. Incomplete walks carry an explicit reason; obstructed clicks leave forms unexercised.

Codex failures retain sanitized `error` and `turn.failed` events, stderr, exit status, timeout state and scratch location in a diagnostic receipt. The harness hash-binds its copy in `phaseReceipts`; resume checks those hashes. Failed Codex scratch stays in the packet for diagnosis, while successful scratch is removed. Nested HTML paths use encoded receipt filenames. Image input digests bind labels and bytes without the packet's absolute directory.

## Blind calibration (QT-4)

Calibration extends the QT-3 judges with a separate, local screenshot set. The
human sheet comes first. `calibration-cli.ts` provides three commands:

- `sheet --set FILE --out HTML --image-base PREFIX` verifies the frozen images
  and writes a source-blind sheet. Supply `--evidence-root DIR` when images live
  outside the manifest directory. Outputs inside a checkout must be git-ignored. Each item has complete 1440 and 390 captures,
  all eight anchored criteria, an independent A–F letter, evidence fields,
  browser-local autosave and Download JSON. Source names and URLs stay in a
  separate private key, never the sheet or repository. Original pixels retain
  branding, so recognisable designs can still reveal their identity.
- `judge --set FILE --human FILE --out NEW_DIR` refuses missing, incomplete,
  duplicate, stale or unsubmitted human packets before any provider call. Repeat
  `--human` for a second rater. The exported submission must predate judging.
  Human packets and their hashes are saved before the first provider call. The
  submission time is an operator assertion, not independent proof of blindness.
  Judges receive the full frozen screenshots and rubric; human grades, notes,
  source URLs, source labels and expected grades are excluded. This command uses
  the Claude Max and Codex subscription adapters, three inventory → score samples
  per reviewer, and no billed fallback. `--stub` is for synthetic local tests.
- `freeze --out SESSION_DIR --review JSON` pins the bar version/digest, capture
  and judge protocol digests, reviewer identities, sample count, set fingerprint,
  human packets and report digests. It requires completed live evidence and an
  explicit human review bound to the exact agreement/model digests, with a written
  disposition for every score, letter, assessability or reviewer disagreement.
  Inconclusive model coverage cannot freeze.
  It refuses stale inputs, changed phase receipts, stub evidence and an existing
  freeze. Bar changes require a version bump, re-calibration and a new baseline.

Run from the repository root through the pinned package runtime:

```bash
pnpm exec tsx e2e/benchmarks/quality/calibration-cli.ts --help
```

The manifest is `quality-calibration-set/1`: `setId`, `rubricDigest` (SHA-256 of
`JSON.stringify(AGENCY_BAR)`), `protocolDigest`, and 8–12 `items`. Each item has a
blind `P01`-style id, two `screenshots` with `width`, full-document `height`,
relative `file`, and `sha256`, an `unavailable` criterion-id list and a neutral
`limitation`. The capture harness is `reference-capture.ts`. Unlike generated
artifact capture, it permits public GET resources to preserve reference designs,
blocks writes and sockets, scrolls the entire document, records incomplete image
loads, and rejects exact “Reject all” consent controls when present. Inspect
captures for overlays or unread content before issuing a sheet. Public references
are internal calibration evidence only; never commit or redistribute screenshots
or the URL key. Keep the key under ignored `.tmp/` with mode 600. All harness
output lives under caller-supplied directories; it owns no daemon lifecycle.

`calibration-model.json` preserves all six sample letters and scores per page,
requested reviewer models, observed model identities when emitted, phase receipt
digests, judge worker/wall time and subscription cash cost. Interrupted sessions
retain partial reports and receipts; this command requires a new output directory
for a retry and does not promise resume. `calibration-agreement.json` reports
exact agreement, agreement within one score, mean absolute error, reviewer
medians/ranges/spreads, disagreement and excluded assessments per criterion.
Model letters remain independent. Per-reviewer median-letter gaps of two or more
require investigation; one letter is within the calibration tolerance. No score
or grade is adjusted to match a human or an expected Brightwater letter.

Copy the generated `calibration-review-template.json` and complete its fields.
A review JSON has `reviewedBy`, an ISO `reviewedAt` after judging, the exact
`agreementDigest` and `modelDigest`, and `dispositions`, an object keyed by every disagreement id in the report with a
non-empty explanation. Review does not replace ratings. The freeze remains
pending until human submission, live judging and that review are complete.
This screenshot-only schema requires supplied-fact fidelity, interaction and
technical hygiene to stay not assessable. It locks `briefFidelity`, `craft` and
`accessibility` to null for such items; visible
scores do not prove zoom, other widths or working conversions. Missing or unread
model evidence stays inconclusive. One rater cannot establish AC-R15.4, and
calibration never accepts, deploys or clears a required judgment on a draft.
