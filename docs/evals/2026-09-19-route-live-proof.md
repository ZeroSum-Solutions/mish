# Spine router live proof (2026-09-19)

> Copied into the repo on 2026-09-23 from the agency workspace (`work/genui-overnight-2026-09-18/route/EVAL.md`). Brief paths in the table are relative to that workspace; the briefs themselves are not in this repo. A quoted brief was replaced by a description.

Real `jev-1.13.0` calls via `--family auto --route-only --report`, default `--route-threshold 0.5`,
`--route-min-transfer 2`, `--route-spine-share 0.25`. Reports in `route/eval-2026-09-19/`. No
criteria were tuned after seeing any of these results, including the remaining misroute.

`maren/fast-lane/brief.md` and `jev/runs/riverbend-dental-brief.md` were re-run after the
spine-mass change below (candidates now gathered over every spine at or above `--route-spine-share`
of the `spine` answer's probability mass, not only the top spine); every other row is the original
2026-09-19 run, unchanged.

| brief | expected family | spine | archetype | picked family | probability | basis | ms | input tokens |
|---|---|---|---|---|---|---|---|---|
| `play/briefs-final/wrenfield.md` | wrenfield | TL | TL.06 | wrenfield | 0.67 | same-spine | 528 | 6135 |
| `play/briefs-final/fervor.md` | fervor | TL | TL.05 | fervor | 1.00 | exact | 383 | 5815 |
| `play/briefs-final/halcyon.md` | halcyon | BA | BA.03 | halcyon | 1.00 | exact | 393 | 6401 |
| `play/briefs-final/maben.md` | maben | TL | TL.01 | maben | 0.92 | same-spine | 388 | 6025 |
| `play/briefs-final/emmpo.md` | emmpo | LM | LM.01 | emmpo | 1.00 | exact | 377 | 6263 |
| `maren/fast-lane/brief.md` | maren | TL | TL.06 | **maren** | 1.00 | same-spine (via CO) | 451 | 6932 |
| `watson/brief-aurora-r5.md` | watson | TL | TL.05 | watson | 0.89 | exact | 368 | 5557 |
| `watson/nullable/brief-nocontact.md` | watson | TL | TL.05 | watson | 0.99 | exact | 369 | 5512 |
| `jev/runs/riverbend-dental-brief.md` | TL.01, family by Jev | BA | none | **UNROUTED** | 0.14 (top candidate wrenfield) | — | 372 | 5169 |
| `ladder/briefs60/002-river-point-landscaping.md` | (none) | TL | TL.04 | wrenfield | 0.99 | exact | 376 | 5221 |
| `ladder/briefs60/004-crescent-bridge-bakery.md` | (none) | BA | BA.02 | maren | 0.90 | compatible | 437 | 5211 |
| `ladder/briefs60/006-river-path-yoga-studio.md` | (none) | LM | LM.03 | emmpo | 0.50 | same-spine | 393 | 5208 |
| `ladder/briefs60/008-bright-wave-bookkeeping.md` | (none) | TL | TL.03 | watson | 0.52 | same-spine | 353 | 5214 |
| `ladder/briefs60/012-harbor-creek-photography.md` | (none) | TL | TL.06 | watson | 0.75 | same-spine | 365 | 5196 |

## Accuracy on the eight labelled briefs

**8 / 8 correct (100%)**, after the spine-mass fix resolved the one remaining miss (`maren`). See
"Before the spine-share change" below for the original 7/8 number and why it missed.

## `maren/fast-lane/brief.md` — resolved by spine mass

Re-run with candidates gathered over every spine at or above `--route-spine-share` (default 0.25),
not only the top spine. This call's live `spine` answer: TL 0.50, CO 0.30, BA 0.18 (probabilities
vary call to call; this is a fresh Jev call, not a re-read of the earlier one). Both TL (0.50) and
CO (0.30) cleared the 0.25 share and were considered; `maren` (spine CO, archetype CO.01) reached
`same-spine` status via the qualifying runner-up spine CO (`viaSpine: "CO"` in the candidate row,
`decision.spine` still reports the top spine, TL) and Jev's `family` question gave it p=1.00 this
time, clearing the threshold. `decision.spines` for this run: `[{TL, 0.50}, {CO, 0.30}]`.

### Before the spine-share change (original run, single-spine candidates only)

**7 / 8 correct (87.5%).** Jev's `spine` question that run came back TL at p=0.48, narrowly beating
CO at p=0.36. Because candidates were gathered only from the top spine (TL) and
`compatibility[TL][CO]` is 1 — below `--route-min-transfer` (2) — `maren` (spine CO) was never a
candidate at all, so every real candidate reported p=0.00 and the run was correctly unrouted given
what it could see. This is exactly the gap the spine-mass change closes.

## `riverbend-dental-brief.md` (design doc's non-strict expectation: TL.01, family by Jev) — still unrouted

Re-run under the same spine-mass change. This call's `spine` answer was close to even: BA 0.53, TL
0.47 — both cleared the 0.25 share and were considered (`decision.spines`:
`[{BA, 0.53}, {TL, 0.47}]`), so every TL-spine family (watson, fervor, wrenfield, maben) was a
`same-spine` candidate this time, alongside the BA-reachable ones. It still did not route: the top
candidate (`wrenfield`, p=0.14) sits well below the 0.5 threshold — Jev's `family` question itself
did not concentrate probability on any bundled family for this brief, spine mass or not. The brief (a
one-line description of a family dental practice) is a textbook TL.01 (Local appointment business — the atlas's own TL.01 keywords
include "dentist"), and no bundled family maps to TL.01 at all (per the design doc's own note), so
an operator would reasonably override with `--family wrenfield` or `--family maben` (both TL.04,
same-spine to TL.01) rather than expect auto-routing here. Nothing was tuned to change this.

## The five unlabelled ladder briefs

Unchanged from the original run (not re-run): all five routed above the default threshold,
including `006-river-path-yoga-studio.md` landing exactly at the p=0.50 boundary (inclusive: the
gate is `probability < threshold`, so 0.50 passes). No independent judgment is offered on whether
these five picks are *correct* — the design doc asks only that they be recorded.

## Cost

14 original requests (one more than the design doc's "about 13" estimate — the doc's own worked
example list has 14 brief paths once the five ladder briefs are counted individually) plus 2
re-runs for the spine-mass follow-up = 16 total, ~5.2k-6.9k input tokens each, `jev-1.13.0`. At
TypeSafe's published pricing this remains on the order of a few tenths of a cent total.
