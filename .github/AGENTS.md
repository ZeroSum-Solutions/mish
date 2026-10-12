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

## CI test-set orchestration guidance

Use the following as a recommended convergence model, not a repository-wide
conformance gate. Existing workflows and coarse test lanes may remain while
their boundaries are understood. Do not block an unrelated change or require it
to repay adjacent orchestration debt solely because it touches an existing
lane. Apply these recommendations incrementally when the local scope and
measured scheduling benefit justify the migration.

Prefer one selection direction: changed paths → source units → test sets →
execution workloads. Because the `plan` job runs before and governs downstream
jobs, new omission policy should live in the planner rather than rely on a
downstream guard to justify it after scheduling has already occurred.

When a CI area is being reorganized, prefer three named responsibilities:

- **Source units** name stable ownership or behavior boundaries in production,
  test, fixture, and control-plane paths. Prefer composing repeated selectors
  under a named unit instead of copying prefixes into unrelated rules.
- **Test sets** name independently useful semantic validation groups. Their
  membership and execution contract should converge on one authoritative
  declaration instead of accumulating more matrix or file-list copies across
  planner configuration, workflow YAML, and framework-local registries.
- **Routes** map source units to the test sets required to validate them. Routes
  should express impact rather than runner mechanics; runner image, setup,
  sharding, and job packing can remain execution concerns derived after
  selection.

Good split candidates have a stable boundary, change work that can actually be
omitted, and carry enough runtime cost or diagnostic value to justify another
scheduling identity. Directory size, file count, or the ability to write a
narrower glob is weak evidence on its own. Prefer a small number of composable
semantic units over per-file mappings, exception lists, or negative-rule
forests. Treat existing duplicated or implicit declarations as migration
surfaces without requiring every nearby change to remove them.

Before promoting a new route from observation to active omission, retain
conservative behavior such as:

- unknown, mixed, unresolved, invalid, or below-threshold input selects the
  conservative full plan;
- editing a test, fixture, or suite manifest selects the test set that consumes
  it; shared harness, contract, setup, or lockfile changes fan out to every
  affected set;
- making a selected test-set identifier that the executor cannot run fail
  visibly instead of being ignored;
- direct planner tests cover representative in-bound, out-of-bound, mixed, and
  fallback inputs without reimplementing the evaluator in another language.

This repository's `ci.yml` has no reusable-result path: it does not run a
convergence check, read R2 receipts, or produce convergence handoffs. The
paragraph below applies only if such a path is reintroduced by an explicit
owner decision.

Keep scope routing and reusable-result convergence conceptually orthogonal:
scope answers which test sets are necessary for a change, while convergence
answers whether an identically declared workload already has a validated,
reusable successful result. New designs should not use result availability to
weaken source-to-test coverage or copy route policy into
`.github/config/convergence.json`. Prefer productless reusable workloads; when a
workload owns products, declare the complete typed reuse manifest with it.

For work whose purpose is CI orchestration, start by inventorying the current
chain from changed path to match, effect, workload, job command, and concrete
test cases. Prefer naming or removing implicit joins before making them finer.
Changes under `.github/` must also follow `.github/AGENTS.md` and the current
confidence methodology in `specs/current/ci.md`.
