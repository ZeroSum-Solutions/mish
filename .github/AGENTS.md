# GitHub automation guide

Published surface (2026-10-12): `.github/workflows/ci.yml` is the only workflow in this repository. The upstream release, publication, follow-on (`comment`/`autofix`/`report`/`rerun`/`convergence` atoms) and maintenance workflows were deliberately not published. `ci.yml` runs on GitHub-hosted runners only, reads no repository variables and no secrets, and never uses `pull_request_target` or self-hosted labels; keep it that way (root `AGENTS.md`, "Cost discipline"). References below to unpublished workflows describe the intended topology if one is added back; they are not present today.

Shared CI settings (owner rule, 2026-10-09): rulesets and merge-queue settings, and any repository variable or secret a future workflow reads, apply at once to every PR and to the merge queue. Change one only after the code that reads the new value is on `main`, and only after one green run proves it on the change's own branch. Writers never change them; the captain or the owner does. On 2026-10-09 a writer set `OD_CI_RUNNER_MODE=aws` before aws mode was on `main`, which failed every CI run for 14 minutes and delayed nine queued PRs.

This directory is still only partially standardized. Several historical workflows and helper locations do not yet follow one uniform shape. Do not copy old patterns blindly. For new work, bug fixes, and cleanup, use the `ci.yml` + `comment.atom.yml` + `autofix.atom.yml` + `report.atom.yml` + `.github/scripts/handoff.py` system as the reference topology unless a maintainer explicitly chooses a different boundary.

## Required reading

Before changing GitHub automation, read the current versions of:

- `.github/workflows/ci.yml`
- `.github/scripts/handoff.py`
- `.github/config/runners.json` and `.github/config/scopes.json`
- `.github/scripts/runners.py` and `.github/scripts/scopes.py`
- `specs/current/ci.md` when changing scope rules, confidence tiers, or planner invariants
- `e2e/tests/packaged-smoke-workflow.test.ts`, `e2e/tests/actions-cache-workflows.test.ts` and `e2e/tests/scripts/scopes.test.ts`
- `scripts/approve-fork-pr-workflows.ts` and `e2e/tests/scripts/approve-fork-pr-workflows.test.ts` when touching fork PR approval behavior

If the change affects cross-workflow behavior, update the topology tests instead of relying only on workflow YAML review.

## Architecture

GitHub automation uses two layers.

Business layer:

- Business workflows decide what happened and what should be requested next.
- `ci.yml` is the main low-privilege PR, merge-queue, and manual validation gate (application merge bar only).
- `ci.yml` runs on `pull_request`, `push` to `main`, `merge_group` and `workflow_dispatch`. It resolves runners, composes the scope decision in its Linux `plan` job (the planner's `run` map gates every workload and is what `Validate workspace` requires), runs validation, and produces typed handoff artifacts.
- A push to `main` is planned from its pushed range at pull-request strength; an unresolvable range (branch creation, force push, API error, the 300-file compare ceiling) takes the full plan. Pushes to `main` queue rather than cancel, and the `preflight` (Linux) and Windows payload jobs seed the pnpm store cache from them.
- Docker image checks are standalone and outside the merge gate. Do not re-attach `docker-image.yml` to `Validate workspace`.
- Business workflows should not perform trusted writes to PR comments or branches when a capability workflow can do it.

Atomic capability layer:

- Capability workflows perform reusable trusted operations from well-defined inputs.
- `comment.atom.yml` consumes `handoff-comment-*` artifacts and upserts pure text PR comments.
- `autofix.atom.yml` consumes `handoff-autofix-*` artifacts and applies same-repository patches.
- `report.atom.yml` consumes `handoff-report-*` artifacts and handles advanced comments that need trusted materialization, such as dependency install, R2 access, artifact processing, or report generation before upsert.
- `rerun.atom.yml` (not published) would watch completed `ci` runs and request one `gh run rerun --failed` when leaf jobs died to runner/spot cancel. Decision logic lives in `.github/scripts/rerun_infra_cancel.py`; it must not rerun ordinary assertion failures or stale heads. Reruns follow owner decision D25 (root `AGENTS.md` "Cost discipline").
- None of the atom consumers is published today. `ci.yml` still produces `handoff-comment-*` artifacts for merge-queue ejection notices so a future `comment.atom.yml` can consume them without a producer change; it no longer produces the visual `handoff-report-*` artifact, whose consumer needed R2.
- Reusable workload results ("convergence") were removed: they needed a trusted publisher and an R2 result store this repository does not have. Every workload the scope plan enables runs. Do not reintroduce result reuse without a trusted, secretless-for-PRs publication design and an owner decision.
- `.github/scripts/handoff.py` owns artifact names, directory layout, discovery, and contract validation for `comment`, `autofix`, and `report` handoffs.

Default rule: do not add a new domain-specific follow-on workflow such as `foo.comment.atom.yml`, `foo.autofix.atom.yml`, or `foo.report.atom.yml` until the flow has been tested against these existing atomic capabilities.

## Directory conventions

- `.github/workflows/` contains GitHub Actions workflow entrypoints.
- `.github/actions/` contains reusable composite actions for workflow setup steps.
- `.github/scripts/` contains workflow-owned scripts and contracts that are not general repo developer commands.
- `.github/scripts/release/` contains release workflow implementation helpers. Keep release-only helpers there and CI handoff helpers at `.github/scripts/`.
- Root `scripts/` remains for repo-level developer checks, product scripts, and guard/test logic. Do not move workflow-only handoff glue there just to make it look more general.

New workflow-owned helpers should usually live under `.github/scripts/`. Prefer TypeScript for project-owned scripts in general, but Python is acceptable for small GitHub runner glue when stdlib portability and low setup cost matter. Keep such exceptions narrow and covered by `pnpm guard` policy.

The planning control plane is deliberately Linux-only and stdlib-only. Runner classes
and scope rules live in `.github/config/`; their Python entrypoints initialize metadata
before workload runners start. A Windows job must never invoke these scripts. Keep
runner placement, changed-file relevance, and fine-grained commands inside a workload
independent.

Every profile in `runners.json` must be a GitHub-hosted image label. `runners.py` still
accepts an `OD_CI_RUNNER_MODE` environment override for local experiments, but
`ci.yml` never sets it, so every run uses `defaultMode`.

`lib/r2.py` is R2 transport only (used by `publish_whats_new.py`, which no published
workflow runs) and must not interpret workload policy or handoff schemas.

## Handoff contract

Use `.github/scripts/handoff.py` for all CI follow-on artifact names and paths. The canonical layout is:

- `handoff/comment/<id>/metadata.json` plus `body.md`
- `handoff/autofix/<id>/metadata.json` plus `patch.diff`
- `handoff/report/<id>/metadata.json`

Artifact names must come from `handoff.py artifact-name <kind> <id>`, and download patterns must come from `handoff.py artifact-pattern <kind>`.

PR-targeting handoffs identify the target PR, head SHA, base SHA, CI run id, kind, and id. Capability-specific fields must be validated by `handoff.py`.

Do not hand-roll artifact name prefixes, alternate directory layouts, or one-off metadata parsers in workflows. Extend `handoff.py` first, then use the new contract from producers and consumers.

## Capability rules

### `comment.atom.yml`

Use `comment.atom.yml` for pure text PR comments only.

- Input is an already-final `body.md`.
- The body must contain a stable marker.
- The workflow validates PR state, draft state, head SHA, and base SHA before upsert.
- It writes the GitHub API payload through `jq -n --rawfile body ...` and `gh api --input`.
- It must not install dependencies, access R2, execute report scripts, understand Nix, understand visual diffs, or checkout PR code.

### `autofix.atom.yml`

Use `autofix.atom.yml` for same-repository patch application.

- Input is `patch.diff` plus metadata including `allowed_paths` and `commit_message`.
- Fork PRs must skip, not fail.
- Closed, draft, stale head, and stale base cases must skip, not fail.
- Apply patches only after validating the live PR state.
- Verify the resulting changed files exactly match `allowed_paths`.
- Prefer the configured bot app token for pushes so follow-up CI is triggered as expected.
- Do not use this workflow for arbitrary commands, generated scripts, or PR-head code execution.

### `report.atom.yml`

Use `report.atom.yml` for advanced comments, meaning comment bodies that are not pure text inputs.

Examples include reports that need:

- downloading and combining artifacts,
- installing dependencies,
- accessing R2 or other trusted secrets,
- rendering media or diffs,
- generating a rich markdown body from trusted base code.

`report.atom.yml` is a trusted writer and materializer. It may upsert comments directly because that is part of the advanced comment capability, but it must do so with the same file-backed payload hygiene as `comment.atom.yml`.

Rules:

- Treat all PR-produced artifacts as untrusted data.
- Do not checkout or execute PR-head code in `report.atom.yml`.
- Checkout trusted base/default code before running repository scripts.
- Validate PR state, draft state, head SHA, and base SHA before secret use and again before comment upsert when practical.
- Keep report type dispatch explicit. If multiple report types grow, add a clear handler boundary instead of burying branching in shell fragments.

## Fork PR approval

`fork-pr-workflow-approval.yml` and `scripts/approve-fork-pr-workflows.ts` are a separate security boundary. They may approve low-risk fork PR `pull_request` runs, but must not approve trusted `workflow_run` capability workflows.

Keep `.github/workflows/ci.yml` as the only approved workflow path unless a maintainer explicitly expands the allowlist. `comment.atom.yml`, `autofix.atom.yml`, `report.atom.yml`, release workflows, deployment workflows, and any workflow with trusted secrets or write permissions must stay outside fork auto-approval.

## Common iteration flow

1. Classify the change.
   - Validation or business decision: start in `ci.yml`.
   - Pure text PR comment: produce `handoff/comment` and let `comment.atom.yml` consume it.
   - Same-repo patch: produce `handoff/autofix` and let `autofix.atom.yml` consume it.
   - Rich/generated comment: produce `handoff/report` and let `report.atom.yml` materialize and upsert it.
   - New naming, paths, or metadata: update `.github/scripts/handoff.py`.
2. Update scope routing in `.github/config/scopes.json`, then run `python3 .github/scripts/scopes.py validate`.
3. Update topology coverage in `e2e/tests/packaged-smoke-workflow.test.ts` or the relevant script test.
4. Run the focused checks:
   - `python3 .github/scripts/handoff.py self-check`
   - `actionlint -color` (the static gate pins actionlint 1.7.12 and ShellCheck 0.11.0)
   - `pnpm --filter @mish/e2e test tests/packaged-smoke-workflow.test.ts tests/actions-cache-workflows.test.ts tests/scripts/scopes.test.ts`
5. Run repo-level checks before handing off:
   - `pnpm guard`
   - `pnpm typecheck`

Use `git diff --check` before finishing workflow edits.

## FAQ

### Should I add a new `*.comment.atom.yml` workflow?

Usually no. If the body is already final markdown, produce `handoff/comment` and use `comment.atom.yml`. If the body must be generated from artifacts, secrets, or report code, produce `handoff/report` and use `report.atom.yml`.

### Why not put rich visual report generation in `comment.atom.yml`?

Because `comment.atom.yml` is the pure text comment shell. Installing dependencies, using R2 secrets, downloading screenshots, and generating diffs are advanced comment materialization, which belongs in `report.atom.yml`.

### Why can `report.atom.yml` upsert comments directly?

`report.atom.yml` is not a pure producer. It is the auditable advanced comment capability: materialize a non-pure text comment and publish it. The key boundary is that this power is explicit in one workflow with trusted inputs, stale checks, and file-backed payload hygiene.

### Why does `autofix.atom.yml` skip fork PRs?

Fork PR branches are not writable by the base repository in the same trust model, and pushing generated changes to forks would require a different permission and ownership design. Skip fork PRs and use comments or report output for contributor guidance.

### Can trusted `workflow_run` workflows checkout PR code?

No, not by default. They may download PR artifacts as data, but must not execute PR-provided code or scripts. Checkout trusted base/default code before running repository scripts.

### Why centralize handoff names in `handoff.py`?

GitHub artifact behavior is easy to drift: artifact names must be unique per upload, and consumers need stable patterns. Centralizing names, paths, and validation keeps producers and consumers aligned and makes topology tests meaningful.

### Where should tests live?

Cross-workflow topology tests belong in `e2e/tests/` when they observe repository-level behavior. Root `scripts/` is test-free (enforced by `pnpm guard`); script behavior-contract coverage lives in `e2e/tests/scripts/`. Do not add one-off `*.test.ts` files just because a workflow helper exists; prefer existing topology coverage and helper self-checks when that is enough.
