# J6 block-plan support gate, round 2

Round 2 corrects FAQ recovery, shares the planner deadline, and replaces oracle accuracy with
live Jev judgments on the original J4 inputs. The branch merges fetched `origin/main`
`3234e18a44775042f827d8d9366bb5526dac3d3c` without rewriting history.

## Behavior

FAQ recovery only adds on clear question or policy intent. Bare insurance, privacy-policy links
and “Questions?” do not trigger it. The gate never removes a picker-chosen FAQ. Both Jev calls
share the planner's total deadline (15 seconds by default), including setup. Support timeout
keeps the picker plan and records `jev-timeout`. `composition.planner` carries attempted calls
and elapsed milliseconds through the composition event, run report and daemon API. Historical
support receipts remain readable; new `removed` arrays stay empty.
The canonical behavior and runner interface live in [Block composition](../agency-site.md#block-composition).

## Live eval

The raw J4 directory is present on this machine. The committed fixtures copy
`~/Inbox/notes/jev-audit-data/j4/blockplan-cases.json` and `blockplan-battery.json` byte-for-byte.
Those files contain the original 16 briefs, labels written before the J4 calls, ambiguous-label
exclusions, and the exact 10-question picker battery. Fixture SHA-256:
`e62f7461ac3f4cb73ca2cbe47ee0bc119e8185401ece536ebe932129b5516122`.
Question SHA-256: `6b08e621929dd7ca82c7944fa6f7898da403deb1d73ffc82d947aaacfeb8c2a8`.

Live evaluation completed at 2026-10-09 16:07 UTC with 32 successful requests. Every response
reported `jev-1.13.0`; input usage totaled 51,606 tokens. Each brief went through the original
picker battery, then the production support-question builder for missing roles. Labels never
enter a request. Both support thresholds use the same live scores; picker inclusion remains
`1 - P(none) >= 0.5`. Four ambiguous decisions are excluded, leaving 124 role decisions.

| Support threshold | Before, correct/total | After, correct/total | After TP / FP / TN / FN |
| --- | --- | --- | --- |
| 0.8 | 116/124 (93.5%) | 120/124 (96.8%) | 15 / 4 / 105 / 0 |
| 0.9 | 116/124 (93.5%) | 120/124 (96.8%) | 14 / 3 / 106 / 1 |

At 0.8, recovery fixes all five picker misses: B1 team/pricing, B9/B12 logo-wall and B13 team.
It adds one false positive under the original labels: B2 testimonials (0.84). At 0.9 that
addition falls below threshold, but B12 logo-wall (also 0.84) remains missing. The three
picker FAQ false positives (B2, B14, B16) persist under both thresholds, as the additive rule
requires. The labels remain unchanged even where their treatment of named clients differs
from the support rubric.

The committed [answer receipt](2026-10-09-j6-live-block-support.json) contains per-case picker
and support scores, provider responses/usage, request digests and both confusion matrices.
Full raw requests and answers are saved at
`~/Inbox/notes/2026-10-09-j6-live-block-support-raw.json`.

These are original audit briefs, which J4 authored as synthetic examples; they are not
customer production briefs. This eval isolates role judgments. It does not replay catalog
compatibility, block-variant taste, seven-block capacity, rendering or generated-page quality.
The current catalog still cannot recover every labelled role on every spine. Eval calls use
60 seconds per request to measure judgments, separately from the production total deadline.
This is an in-sample regression replay. The support rubric was clarified after inspecting J4
errors; these same briefs informed those changes. The lead required the 0.8 threshold, and 0.9
is an illustrative comparison, not a threshold selected on held-out data. No held-out dataset
was tested. Roles within a brief are correlated; the percentages are descriptive point estimates,
not population accuracy or a statistical generalization. FAQ recovery adds nothing in this sample;
the FAQ unit specs, rather than this accuracy table, exercise the deterministic rule.
The former 8/16 to 16/16 stub result was label-derived and is superseded by this live evidence.

## Validation

Red specs reproduced FAQ deletion, bare-keyword additions, doubled timeout, uncounted picker
timeout and missing planner metrics. A second red spec caught nested planner prose surviving
API hydration; the projection now emits only finite counts/timings.

- `pnpm guard`: passed.
- `pnpm typecheck`: passed.
- Scoped package tests: 49 passed.
- Scoped daemon composition tests: 12 passed.
- Live Jev: 32 successful requests; both thresholds scored from those answers.
- Independent Claude review: all WARN findings fixed after red specs; final focused review accepts the change with NITs only. Canonical documentation validation passed.

This worktree reports a shared running development instance. No restart or source-refresh
claim is part of this change; this run verifies package behavior and the API test harness.
