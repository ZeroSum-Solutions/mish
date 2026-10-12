# GitHub automation guide

Follow the root `AGENTS.md`. This public fork keeps `.github/workflows/ci.yml`
for validation and `.github/workflows/release-mac.yml`, which builds the unsigned
macOS package on a stable `v*` tag (read-only build job) and publishes it to
GitHub Releases from a separate write-scoped job. Nothing in CI depends on it. Upstream release, bot, trusted-write and convergence
workflows were removed deliberately. Do not restore them as a CI dependency.

## Required reading

Before changing CI, read:

- `.github/workflows/ci.yml`
- `.github/config/runners.json` and `.github/scripts/runners.py`
- `.github/config/scopes.json` and `.github/scripts/scopes.py`
- `specs/current/ci.md` before changing scope confidence or omission policy
- `e2e/tests/packaged-smoke-workflow.test.ts` and `e2e/tests/scripts/scopes.test.ts`

## Active contract

CI supports non-draft `pull_request`, `workflow_dispatch` and `merge_group`.
Draft PRs defer workloads and fail the final gate closed.

All runners are GitHub-hosted. CI requires no repository variables or secrets;
the automatic `github.token` provides read-only GitHub API access. Do not add
self-hosted runners, `pull_request_target`, or secret-dependent validation.

The Linux, stdlib-only control plane resolves runners and then scopes.
`scopes.py github-output` emits the enabled workload map directly as `run`,
plus scope flags and matrices. Jobs consume that map. The final
`Validate workspace` gate requires a complete boolean workload map matching
its dependency jobs. It requires every enabled job to succeed and rejects
failed or cancelled dependencies. Merge policy remains merge-group-only. Retained notice artifacts are downloadable
diagnostics; no workflow consumes them to post PR comments.

Reusable workload results are disabled. CI neither calls `convergence.py` nor
reads R2 receipts or produces convergence handoffs. Retained convergence helpers
and configuration are inactive compatibility code, not planning authority.

Keep normal scope confidence, unknown-input fallback, rename handling and
matrix validation intact. Remove references to deleted workflows from active
configuration and tests instead of recreating upstream infrastructure.

## Verification

Run the planner's `validate`, `plan`, and `github-output` entrypoints, runner
resolution, `actionlint` when installed, and the focused e2e Vitest script and
workflow tests. Event fixtures must cover PR, manual full/hot and merge-group
planning. Verify the actual final gate with successful, failed and missing
required results. Use `git diff --check` before handoff.
