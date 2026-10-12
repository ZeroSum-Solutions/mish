# GenUI evals

Scripts that measure the agency fast lane against a running daemon. They use Node 24 or bash
built-ins only and need no install step beyond the repo's own. Saved reports go in
[`docs/evals/`](../../docs/evals/README.md).

Each live script spends model credit (DeepSeek, Cerebras) and Jev credit. Run one on purpose,
against a daemon built from the commit you want to measure. One agency build runs at a time on a
daemon, so the scripts run builds one after another.

| Script | Criterion | What it proves | Owner |
|---|---|---|---|
| `7-xmock-eval.mjs` | C10 | Strict-mode app, dashboard and site builds publish zero unlabelled fabricated claims, the Jev flagged-slot rate (flagged / checked fact slots) stays under 5 %, and every `x-mock` sample-data slot the gate skips is captioned on the page | M6 |
| `8-route-eval.mjs` | C8 | Route quality on the 25-item corpus, measured through a profiler-based proxy against labels that are not independent of Jev | M4 |
| `ladder-eval.mjs` | C14 | Build ladder: batches of 1, 2, 5 and 20 builds per provider, with no failed or unrouted build and all nine spines covered on each provider | M7 |
| `packed-team-proof.sh` | C15 | A fresh clone of one commit installs, builds, starts a headless daemon, lists the catalog, builds one site and serves the web app | M7 |

## 7-xmock-eval.mjs (C10)

Live mode runs ten fixed briefs per page kind (`briefs/faithfulness/`) one build at a time. The
default verify mode is `strict`: the gate repairs what it flags and publishes nothing it cannot
clear, and a build it stops ends `VERIFY_FAILED`. For every build the eval records the `verify`
event counts (`checked` fact slots, `illustrative` skipped `x-mock` slots, `flagged`,
`remaining`) and the error code. For every `done` build it reads the build record
(`AGENCY-SITE-STATE.md`), which names the entry page and the state revision, so the eval does not
hardcode the daemon's revision. It then reads the published recipe and page and records the
caption evidence: which section holds each `x-mock` slot, and the visible
`data-od-mock="caption"` text in that section. If a read fails, or a section is not in the page,
the row records `evidence: 'missing'` and the reason.

A run passes (exit 0) only in `strict` mode, and only when each of the three kinds meets every
condition below. The rule is in `xmock-score.mjs`.

1. Exactly 10 builds run, and all 10 end `done`. An 11th row, such as an appended retry, fails
   the kind.
2. The flagged rate is below 5 %. The rate is the gate's first-pass flags divided by the checked
   fact slots.
3. No `x-mock` path is flagged. A flag there is an exclusion bug.
4. Zero unlabelled fabricated claims:
   - no published build has a fact slot still flagged after repair;
   - no build ended `VERIFY_FAILED`. The report counts such a build as a caught fabrication,
     with the slots it left flagged;
   - every `done` build has caption evidence, whatever its `illustrative` count. A missing or
     zero count does not waive the check. A build with `evidence: 'missing'` fails;
   - every `x-mock` slot in the published recipe sits in a section with a visible caption;
   - the gate did not skip more `x-mock` slots than the published recipe carries.

   In strict mode the daemon does not return flagged paths, so this condition rests on
   `remaining`, `VERIFY_FAILED` and the caption evidence. The "flagged fact slot published"
   check only fires in `--verify after` runs, which cannot pass anyway.

Exit 1 is a failed run and exit 2 is a usage error. The table prints each failure reason for each
kind.

`--verify after` is the Route panel's path: it publishes first, checks later and never repairs.
It is kept for diagnosis, because it records each flagged path with its text. It can never pass
C10: the script prints a warning and exits 1.

`--rescore <dir|rows.json>` re-scores saved bake-off rows without spending anything. It is a
pre-check only. The saved rows predate the `illustrative` count and carry no published page, so
they cannot give caption evidence. Only the live strict run is the proof.

```sh
node evals/genui/7-xmock-eval.mjs --model cerebras/gpt-oss-120b --daemon http://127.0.0.1:57830 --out xmock.json
node evals/genui/7-xmock-eval.mjs --dry
node evals/genui/7-xmock-eval.mjs --verify after --model cerebras/gpt-oss-120b --out xmock-diagnosis.json
node evals/genui/7-xmock-eval.mjs --rescore <dir-with-report-json> --out rescore.json
node --experimental-strip-types --test evals/genui/xmock-score.test.mjs
```

The scorer and its tests import TypeScript from `packages/agency-fast-lane` and the family
renderers. Node 24 strips the types by default; the flag makes that explicit. One test renders the
three real families and checks that every `x-mock` slot is found under its caption.

## 8-route-eval.mjs (C8)

`8-route-eval.mjs` checks whether `resolveRoute` in `packages/agency-fast-lane`, using the current
family registry, sends the 25-item catalog corpus to families that the corpus labels judge
acceptable. The labels are not blind to Jev: read [Labels provenance](#labels-provenance) before
you treat a score as an accuracy measurement.

**Mode: profiler-proxy.** The eval does not call the production single-request router. It rebuilds
each item's answers from the design profiler's output (`spine`, `skin`, `family` and one
`archetype_<SPINE>` answer per spine). These answers have no `pageKind`, so `resolveRoute` skips
its page-kind check. The production router also asks `pageKind`. When that answer is confident
(0.5 or more) and disagrees with the winning family's page kind, production reroutes to the best
family of the matching kind, or leaves the brief unrouted. The profiler also words its questions
differently from the production router. The eval prints `mode: profiler-proxy` first, and
`score.json` records `"mode": "profiler-proxy"`.

### Run

```sh
# Live run: profiles the corpus with Jev (25 calls; about 14 s in one recorded run). The key comes from ZS Vault.
mise exec -- node --experimental-strip-types evals/genui/8-route-eval.mjs --out evals/genui/out/<run>

# Re-score saved answers with no Jev calls
mise exec -- node --experimental-strip-types evals/genui/8-route-eval.mjs --replay evals/genui/out/<run>/answers.json

# Sweep the policy knobs on saved answers
mise exec -- node --experimental-strip-types evals/genui/8-route-eval.mjs --replay <answers.json> --threshold 0.5,0.45,0.4 --spine-share 0.25,0.2

# Unit test for the scoring rule and the labels file
mise exec -- node --experimental-strip-types --test evals/genui/route-eval.test.ts
```

Each run writes `answers.json` and `score.json` to the run directory. `answers.json` holds every
item's Jev answers and model id. Runs go under `evals/genui/out/`, which is gitignored. The run
directory must be new or empty. The eval refuses a used `--out` directory, so it never reads a
profile that an earlier run left there.

### Scoring

The labels are in `fixtures/route-corpus-labels.json`.

- An item is **correct** in two cases:
  - It routed to one of its `acceptableFamilies`.
  - It stayed unrouted, and either `acceptableFamilies` is empty or the label sets `unroutedAcceptable: true`.
- An item is **illegal** when it routed to one of its `illegalFamilies`.
- An item is **missing** when it has no saved answers, or its answers lack `spine`, `skin` or
  `family`. A missing item counts as wrong and is never scored as unrouted. The printed table marks
  it `(no answers: …)`.
- A run **passes** (exit 0) when correct >= 20 of 25, the routed picks span >= 5 families, and
  there are 0 illegal picks.

### Labels provenance

The labels file has a `provenance` block with the full record. In short:

- **v1** is frozen, byte for byte, in `fixtures/route-corpus-labels.v1.json`. A claude-sonnet-5
  agent labelled all 25 items on 2026-09-23 at 22:55 UTC. It wrote one judged decision per item.
  - **It saw:** Jev's captured spine, skin, family and archetype answers, with their probabilities,
    for every item (`route-corpus-25.json` as it was then); the structured catalog fields of each
    design profile (title, category, vertical, use case, niche, catalog action, motion level); the
    atlas; and the 10-family registry with its summaries from before this branch.
  - **It did not see:** any prose brief (the corpus has none); the three new families as built
    (it used the placeholders `search-match` on SM.01, `content-sub` on CS.01 and `mission` on
    MI.01; `listings` shipped on SM.02); or any eval score (the first live run came 66 minutes
    later).
  - **Jev signal:** every item's `sourceMeta` carries Jev's spine and family pick, and three reasons
    cite Jev's answer. The labeller's note calls Jev's pick "one signal among several". The
    artefacts cannot show how much it moved a verdict. The labels are therefore **not independent
    of the router's input**.
  - `illegalFamilies` is computed from the atlas compatibility matrix (transfer below 2). It is not
    a judgement.
  - The v2 file maps the placeholder names to `listings`, `publication` and `nonprofit` (`aliases`).
- **v2 (2026-09-23)** changes two verdicts from an adjudication stored in
  `fixtures/route-corpus-adjudication-2026-09-23.json`:
  - `dreamcore-landing`: `acceptableFamilies` changed from `["watson"]` to `[]`, so unrouted is
    the correct outcome.
  - `mostar-guide`: `acceptableFamilies` stays `["publication"]` and now has
    `unroutedAcceptable: true`, so publication or unrouted is correct.
  - **Selection:** only these two items were adjudicated. Both were misses in the live runs made
    before the adjudication, and both were unrouted in r2. Both changes make that outcome correct:
    the r2 answers score 17/25 under v1 and 19/25 under v2. No correctly routed item was
    re-examined, so the adjudication could only raise the score.
  - The adjudication records hold catalog evidence only, with no Jev answer. The adjudicator's
    prompt was not kept, so what else it saw cannot be confirmed.
  - No other label changed. `route-eval.test.ts` diffs v1 (with the name map) against v2 and
    asserts that exactly these two item fields differ.

## ladder-eval.mjs (C14)

Posts `family: 'auto'` builds to `POST /api/agency/build` (daemon default verify mode `strict`),
reads each build to its end over `GET /api/agency/builds/:id/events`, and records for each build:

- the top spine (`routedSpine`);
- the spine the winning family was admitted from (`viaSpine`, from the route when the daemon
  reports it, else null);
- the failure class;
- the verify counts;
- the request-to-terminal wall time (POST to the build's final event).

A run passes (exit 0) when every condition below holds:

- **Every provider ran.** Each provider in `--providers` produced at least one build. A listed
  provider with no builds fails the run.
- **No failed build.** An unrouted build counts as a failed build. A `done` build whose record
  has no route at all (no top spine and no admitted spine) cannot be graded, so it fails as
  `unrouted-record`. The summary counts each failure by class: `unrouted`, `unrouted-record`,
  `BUILD_FAILED`, `VERIFY_FAILED` or `other`.
- **Latency.** The p50 is under 4 s on Cerebras and under 6 s on DeepSeek. The report shows p50
  and p95 for each provider (nearest rank, not interpolated).
- **Spine set.** Each of the nine spines is the `expectedSpine` of at least one brief that ran.
- **Spine match.** Each build is graded on `viaSpine ?? routedSpine`, and that spine equals its
  brief's `expectedSpine`. The report lists each mismatch with both spines. A build with no known
  spine (unrouted, or failed before the route was kept) is a failure, not a mismatch.
- **Per-provider coverage.** On every provider listed or seen in the results, each of the nine
  spines has at least one `ok` build that is graded to its expected spine. The report shows the coverage table and each
  gap.

Output is `results.json` and `REPORT.md` in `--out`. Exit 1 is a failed build, a coverage gap or
any other failed check. Exit 2 is a usage error.

The 20 briefs in `briefs/ladder/` are invented (no real business, no catalog text). Each
`ladder-NN.txt` has a sidecar `ladder-NN.json` with `expectedSpine`, `expectedPageKind` and a
note; there are two briefs per spine and four for TU (app and dashboard). A brief with no valid
sidecar is a usage error (exit 2).

| Spine | Briefs (archetype) |
|---|---|
| TL | ladder-01 dental practice (TL.01), ladder-02 business law firm (TL.03) |
| PA | ladder-03 bookkeeping SaaS (PA.01), ladder-04 fleet maintenance platform (PA.02) |
| CO | ladder-05 leather goods shop (CO.01), ladder-06 pantry-box subscription (CO.02) |
| SM | ladder-07 residential brokerage (SM.03), ladder-08 contractor marketplace (SM.01) |
| CS | ladder-09 regional food magazine (CS.01), ladder-10 local-government newsroom (CS.01) |
| LM | ladder-11 culinary certificate school (LM.02), ladder-12 evening data-analytics cohort (LM.01) |
| BA | ladder-13 maritime craft museum (BA.03), ladder-14 coastal inn (BA.01) |
| TU | ladder-15 repair coordination app, ladder-16 freight claims app, ladder-17 roofing CRM dashboard, ladder-18 donor pipeline dashboard (TU.01) |
| MI | ladder-19 land conservation trust (MI.01), ladder-20 transit funding campaign (MI.02) |

**Replaced 2026-09-24.** Three briefs asked for archetypes that no bundled family serves, so
they could only end unrouted (or on a family that forces invented facts):
ladder-10 developer documentation hub (CS.02), ladder-12 shared-studio community membership
(LM.03) and ladder-13 restaurant (BA.02). They are now in-archetype briefs for the
`publication` (CS.01), `emmpo` (LM.01) and `halcyon` (BA.03, visited institution) families. The
new briefs state every fact those templates show (dates, prices, times, names), so a fill has no
gap to invent into. Each sidecar's `replaced` field names the old brief. The spine of each
replaced brief is unchanged, so the set still covers each spine at least twice.

```sh
node evals/genui/ladder-eval.mjs --daemon http://127.0.0.1:7456 --briefs evals/genui/briefs/ladder --out ladder-out --dry-run
node evals/genui/ladder-eval.mjs --daemon http://127.0.0.1:7456 --briefs evals/genui/briefs/ladder --out ladder-out --providers deepseek,cerebras --rungs 1,2,5,20
node --test evals/genui/ladder-eval.test.mjs
```

## packed-team-proof.sh (C15)

Clones `--sha` from `--repo` into a temp directory with no shared `node_modules` or daemon data,
runs `pnpm install`, builds the daemon and web packages with their dependencies, starts
`od daemon start --headless` on a free port with isolated `OD_DATA_DIR` and
`OD_USER_STATE_DIR`, runs `od catalog list --json`, runs one
`od agency build --verify off` with a named family, and checks that the daemon serves the web
root. The catalog step is required by default (`--require-catalog`); pass
`--no-require-catalog` only for a commit that predates the catalog. It takes `DEEPSEEK_API_KEY`
from the environment first and falls back to `zsvault`. A key read from `zsvault` is exported only inside the
daemon's own subshell; a key you export yourself is inherited by every step, as usual. The key
is never passed as a command argument and never logged. Exit 0 when every required step
passed, 1 when one failed, 2 on a usage error.

```sh
bash evals/genui/packed-team-proof.sh --sha "$(git rev-parse HEAD)" --out packed-proof
```
