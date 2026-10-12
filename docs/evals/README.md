# GenUI evals

Reports that the fast-lane code cites. Each file is a copy of a report from the agency
workspace, with a note at the top that names its source. They are historical records: their raw
inputs and outputs are not in this repo, so this checkout cannot reproduce them. The eval scripts that produce new
results live in [`evals/genui/`](../../evals/genui/README.md).

| Report | Date | What it measured | Cited by |
|---|---|---|---|
| [2026-09-22-genui-bakeoff.md](2026-09-22-genui-bakeoff.md) | 2026-09-22 | 90 builds: DeepSeek `deepseek-v4-flash`, Cerebras `gpt-oss-120b` and Cerebras `qwen-3.8-27b` on the site, app and dashboard page kinds. Latency, flagged rate, repair rate, tokens and cost. | `DEFAULT_MODEL_BY_FAMILY` in `apps/daemon/src/routes/agency-build.ts`; the per-family default in `packages/agency-fast-lane/src/build.ts` |
| [2026-09-19-route-live-proof.md](2026-09-19-route-live-proof.md) | 2026-09-19 | Live Jev routing of 14 briefs with the default policy (threshold 0.5, min transfer 2, spine share 0.25). 8/8 labelled briefs correct after the spine-share change. | `packages/agency-fast-lane/src/route.ts` defaults |
| [2026-09-19-catalog-25-profiles.md](2026-09-19-catalog-25-profiles.md) | 2026-09-19 | Jev design profiles of the 25-item route corpus: spine, archetype, skin, sections, mechanics and the routed family. | The route corpus fixture `packages/agency-fast-lane/tests/fixtures/route-corpus-25.json` |

## Rules for this folder

- Copy the markdown report only. Do not copy catalog prompt text, brief bodies or media.
- Put a source note under the title. Keep the numbers as the run produced them.
- Name each file `<run date>-<subject>.md` and add a row to the table above.
- Code comments cite `docs/evals/<file>`, never a path outside the repo.
