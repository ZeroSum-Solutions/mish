---
name: mish-ship
description: Take a finished change in this repository from branch to merged PR - scoped local gates, CI scope preview, PR template, other-model-family review, ready once, land. Use when work is done and the user says ship it, open the PR, get it merged, or land it.
---

# Ship a Mish change

`CONTRIBUTING.md` is the source; this is the checklist. Always pass `--repo ZeroSum-Solutions/mish` to `gh`.

1. **Branch hygiene.** Feature branch, conventional commits, no `Co-authored-by` or other attribution lines. One coherent PR per feature; fold docs and small tooling changes in.
2. **Base is current.** `git fetch origin && git merge origin/main`. A test failing in code you never touched usually means a moved base: check `git merge-base --is-ancestor origin/main HEAD` before anything else.
3. **Local gates, scoped to the diff:** `pnpm guard`, `pnpm typecheck` (or `pnpm --filter <pkg> typecheck` for each touched package), and the tests of each touched package. Never the full suite locally. Long suites: `sh scripts/agents/offload.sh <branch> '<command>'` after pushing.
4. **Preview CI:** `python3 .github/scripts/scopes.py plan --context pr --files $(git diff --name-only origin/main...HEAD)`. If it plans lanes you did not expect, find out why before pushing.
5. **Review by the other model family.** Claude-written code is reviewed by GPT-6.1 Sol; Codex-written code by Claude. BLOCK/WARN/NIT with `file:line`. Fix every BLOCK and every WARN you agree with, then a short re-check of the fixes only. Skip only for docs-only diffs.
6. **Open as draft:** `gh pr create --draft --repo ZeroSum-Solutions/mish`, every template section filled ("Why" = use case + pain; "What users will see" = clicks and defaults, not code; tick every surface; screenshots for UI).
7. **Mark ready once:** `gh pr ready --repo ZeroSum-Solutions/mish <n>`. Every later push is a new head and a new CI run: push only real fixes.
8. **Land:** `~/bin/zs-land` waits for CI and squash-merges. `main` has no required check, so never merge a PR whose CI is red or still running. A red test is a real failure: fix it on a new head; rerun only with recorded proof of an infrastructure failure, once.

Done when: the PR is merged, the branch and worktree are cleaned up, and your writer slot is released (`sh scripts/agents/writer-slot.sh release`).
