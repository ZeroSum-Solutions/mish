# Generative UI bake-off — 2026-09-22

> Copied into the repo on 2026-09-23 from the agency workspace (`work/genui-2026-09-22/bakeoff/REPORT.md`). Numbers are unchanged. The harness was the workspace script `evals/genui/6-bakeoff.mjs`; it is not in this repo. The daemon port is the one that run used.

Daemon: `http://127.0.0.1:57830`. 90 of 90 planned builds ran. Every build used `verify: 'after'`, `mode: 'sections'`, sequential (one build at a time; a second concurrent build would answer 409 `BUILD_BUSY`).

Prices (USD per million tokens), read at the top of this harness as of 2026-09-22 — a 0 means the price was not set before this run:

| Model | $/M in | $/M out |
|---|---|---|
| deepseek-v4-flash | 0.3 | 1.2 |
| gpt-oss-120b | 0.35 | 0.75 |
| qwen-3.8-27b | price not set | price not set |

Flagged rate uses the `verify` build-event's `counts.checked` as the denominator when the daemon reported it; when it did not, the row says "unknown" and shows the flagged-slot count on its own — reading it as a rate would be wrong, since it is missing its denominator.

## site

| Provider | Model | ok | preview p50 (ms) | preview p90 (ms) | final paint p50 (ms) | flagged rate | repair rate | repair p50 (ms) | remaining after repair | tokens in | tokens out | cost / build |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek | deepseek-v4-flash | 9/10 | 2341 | 3747 | 2173 | 5.2% (29/558) | 89% | 2933 | 7 | 38844 | 7783 | $0.0023 |
| cerebras | gpt-oss-120b | 8/10 | 1470 | 1715 | 1295 | 10.3% (51/496) | 100% | 2454 | 17 | 45237 | 27114 | $0.0045 |
| cerebras | qwen-3.8-27b | 10/10 | 2330 | 3156 | 2159 | 9.4% (58/620) | 100% | 4652 | 17 | 50069 | 101201 | price not set |

Winner per page kind: **cerebras/gpt-oss-120b** — lowest preview p50 (1470ms), none of the models cleared the bar (flagged rate >= 5%).

## app

| Provider | Model | ok | preview p50 (ms) | preview p90 (ms) | final paint p50 (ms) | flagged rate | repair rate | repair p50 (ms) | remaining after repair | tokens in | tokens out | cost / build |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek | deepseek-v4-flash | 10/10 | 1896 | 2043 | 1730 | 16.1% (103/640) | 100% | 3211 | 50 | 39832 | 5733 | $0.0019 |
| cerebras | gpt-oss-120b | 10/10 | 1074 | 2493 | 899 | 17.8% (114/640) | 100% | 2334 | 64 | 44930 | 16926 | $0.0028 |
| cerebras | qwen-3.8-27b | 10/10 | 1500 | 1955 | 1324 | 19.7% (126/640) | 100% | 4695 | 82 | 49013 | 47608 | price not set |

Winner per page kind: **cerebras/gpt-oss-120b** — lowest preview p50 (1074ms), none of the models cleared the bar (flagged rate >= 5%).

## dashboard

| Provider | Model | ok | preview p50 (ms) | preview p90 (ms) | final paint p50 (ms) | flagged rate | repair rate | repair p50 (ms) | remaining after repair | tokens in | tokens out | cost / build |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| deepseek | deepseek-v4-flash | 10/10 | 2262 | 3047 | 2090 | 42.4% (352/830) | 100% | 4091 | 225 | 44817 | 9262 | $0.0025 |
| cerebras | gpt-oss-120b | 10/10 | 1134 | 1921 | 961 | 38.6% (320/830) | 100% | 3071 | 221 | 47512 | 20137 | $0.0032 |
| cerebras | qwen-3.8-27b | 10/10 | 1475 | 61221 | 1301 | 37.5% (311/830) | 100% | 5381 | 155 | 53254 | 48665 | price not set |

Winner per page kind: **cerebras/gpt-oss-120b** — lowest preview p50 (1134ms), none of the models cleared the bar (flagged rate >= 5%).

## Errors (3)

- site-09 deepseek/deepseek-v4-flash: the build failed
- site-04 cerebras/gpt-oss-120b: the build failed
- site-09 cerebras/gpt-oss-120b: the build failed

## Totals

Tokens in: 413508. Tokens out: 284429. Spend was DeepSeek metered plus Cerebras prepaid; no key is printed above or anywhere in this harness.
