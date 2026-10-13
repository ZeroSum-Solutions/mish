# Directory guide

The single source of truth for agents in this repository. It holds only cross-repository boundaries, workflow and commands. Module detail lives in each directory's own `AGENTS.md`, which loads when you work in that directory; do not copy it back here. Keep this file under 200 lines: when you add a rule, move or cut one that matters less.

## Where to read next

- Product and onboarding: `README.md`, `QUICKSTART.md`. Contributing: `CONTRIBUTING.md`, `TRANSLATIONS.md`.
- Architecture and protocols: `docs/architecture.md`, `docs/skills-protocol.md`, `docs/agent-adapters.md`, `docs/modes.md`.
- UI system (tokens, interaction, motion, shared components): `docs/design/ui-system.md`.
- Current plans and references: `docs/references.md`, `docs/code-review-guidelines.md`, `specs/current/maintainability-roadmap.md`. `docs/spec.md` and `docs/roadmap.md` are archived; their dated decisions are not current behavior. Product plans are private and not in this repository.
- Read before changing these areas:

| Area | Read first |
|---|---|
| Any prompt text (`apps/daemon/src/prompts/`, `packages/contracts/src/prompts/`, `plugins/_official/scenarios/od-next-strategy/`) | `docs/prompt-composition.md`, and "Prompt variants" below |
| CI planner confidence, routing or omission (`.github/config/scopes.json`, `.github/scripts/scopes.py`) | `specs/current/ci.md`, `.github/AGENTS.md` |
| Chat rendering, tool-call display, execution records | `specs/current/chat-panel-next.md`, `apps/web/src/components/chat/AGENTS.md` |
| Packaged updater, release-channel identity, installer, updater UI | `tools/pack/AGENTS.md` → "Packaged auto-update architecture and harness" |
| A packaged build-cache node key | `tools/pack/CACHE.md` |
| Release channels and promotion | `tools/release/AGENTS.md` |
| Adding or restyling web UI (`apps/web`, `packages/components`) | `docs/design/ui-system.md`, `apps/web/AGENTS.md` |

## Workspace map

- Workspace packages (`pnpm-workspace.yaml`): `apps/*`, `packages/*`, `shells/*`, `tools/*`, `e2e`.
- `apps/web`: Next.js 16 App Router + React 18 web runtime. `apps/daemon`: local privileged daemon and `od` bin; owns `/api/*`, agent spawning, skills, design systems, artifacts and static serving. `apps/desktop`: Electron shell, reads web/daemon status through the sidecar client. `apps/packaged`: thin packaged Electron entry and `od://` glue. `apps/closure`: distributable Closure content only.
- `packages/contracts`: pure TypeScript web/daemon contract layer. `packages/sidecar-proto`: business DTOs and action names. `packages/sidecar`: business-agnostic sidecar client and protocol. `packages/platform`: generic OS process primitives. `packages/standalone`: shell-neutral metadata, verification, materialization and launcher contract. `shells/terminal`: the Node carrier; shells must not import Closure app source.
- `tools/dev` (local lifecycle), `tools/pack` (packaged build/start/stop/logs, updater harness, installer identity, mac beta artifacts), `tools/serve` (fixture services, e.g. `tools-serve start updater`), `tools/release` (release metadata, publishing, reports). `e2e`: end-to-end smoke tests and Playwright UI automation.
- Content: `skills/` (functional skills the agent calls mid-task), `design-templates/` (rendering catalogue), `design-systems/` (`neutral-product` only; `docs/design-systems/QUALITY-STANDARD.md`), `craft/` (brand-agnostic craft rules opted into via `od.craft.requires`), `mocks/` (replay-based mock CLIs for a selected, non-exhaustive set of agent CLIs, built from anonymized traces; check `mocks/bin/` covers your agent before a PATH-overlay replay, or the real CLI runs; `mocks/README.md`).
- Removed: `apps/nextjs`, `packages/shared`, `apps/landing-page`. Do not recreate or reference them. PR-duty tooling moved to the standalone `PerishCode/duty` project; do not recreate `tools/pr`, `@mish/tools-pr` or a root `pnpm tools-pr` script without a new explicit maintainer decision.
- Runtime data, `.tmp/`, Playwright reports and agent scratch directories stay out of git.

# Development workflow

## Environment

- Node `~24` only (`package.json#engines`; Node 22 is unsupported) and `pnpm@10.33.2` through Corepack. Windows native is best-effort: `docs/windows-troubleshooting.md`.
- New project-owned entrypoints, modules, scripts, tests and configs are TypeScript. New `.js`/`.mjs`/`.cjs` files need a generated, vendored or compatibility reason and must pass the allowlist in `scripts/guard.ts`.
- Run `pnpm install` after changing package manifests, workspace layout, command entrypoints or bin links.

## Local lifecycle

- Before opening the app, starting a project in it, or beginning work here, run the freshness check in `docs/agent-freshness-check.md`. A 200 response or the package version does not prove the app is current.
- Always pass `--repo ZeroSum-Solutions/mish` to `gh`; a checkout can carry an upstream remote that `gh` would pick instead.
- `pnpm tools-dev` is the only lifecycle entry point, so daemon, web and desktop always start with one env, port, namespace and log layout. Do not add `pnpm dev`, `dev:all`, `daemon`, `preview` or `start` aliases.
- Ports come from `tools-dev --daemon-port` and `--web-port`. `tools-dev` exports `OD_PORT` (web proxy target) and `OD_WEB_PORT` (web listener); do not use `NEXT_PORT`.

## Daemon data directory contract

The only repository-wide source of truth for daemon-managed data paths. Every README, guide, deployment note and handoff that mentions them must point here instead of restating them. Do not write concrete filesystem examples for the daemon data directory, a recommended or shared data directory, a deployment mount, or an example data directory. If a change needs a rule not covered here, ask for a core-maintainer decision in the PR.

- On startup, `apps/daemon/src/server.ts` resolves `OD_DATA_DIR` into `RUNTIME_DATA_DIR`. Every daemon-owned path derives from it or from a constant derived from it (`PROJECTS_DIR`, `ARTIFACTS_DIR`).
- `PROJECTS_DIR` is the managed-project root. Imported-folder projects are the exception: they use `metadata.baseDir`, the user-selected external workspace.
- Artifacts, SQLite, app config, memory, MCP config and tokens, automation and plugin state, connector credentials, generated files, sandbox-mode logs and agent runtime homes all stay under the resolved data root unless this section names an exception.
- Agent subprocesses receive the resolved root as `OD_DATA_DIR`; they never guess their own.
- Development: `tools-dev` owns orchestration only. `--namespace` alone does not isolate data; a run that needs an isolated root passes `OD_DATA_DIR` to the daemon.
- Packaged: `tools-pack` / `apps/packaged` own channel and namespace layout, resolve the final namespace-scoped root before spawning the daemon, and pass it as `OD_DATA_DIR`. Daemon code never infers packaged paths from app names, Electron `userData`, ports, channels or namespaces.

Sanctioned exceptions:

- `OD_MEDIA_CONFIG_DIR` overrides `media-config.json` only. `OD_LEGACY_DATA_DIR` is a legacy-import source only. Neither is a second data root.
- External tool homes such as `CODEX_HOME` are integration inputs, not Mish runtime data. Agent/project-cwd skill staging aliases, manifest metadata keys and CSS identifiers are not data roots either.
- Placement adoption helper (decided 2026-10-08): with an explicit `OD_DATA_DIR` and `--placement-adoption-executor`, tools-dev builds the helper into `<data root>/placement/adoption-helper`, and writes the root creation record named by `WORKBENCH_ADOPTION_ROOT_RECORD` when its own `mkdir` creates the root. The daemon re-derives the path from `RUNTIME_DATA_DIR` and re-verifies ownership, permissions and digest.

Known escape patterns, which must not be copied or extended: module defaults pointing at a cwd-relative legacy directory; helpers such as `defaultRegistryRoots()` that recompute a root from `process.env.OD_DATA_DIR` or cwd; `openDatabase(projectRoot)` relying on its fallback; help text suggesting concrete legacy directories. When the fix is obvious, route the path through `RUNTIME_DATA_DIR` or an explicit data-root argument; otherwise block the PR and ask a core maintainer.

## Root commands and CI

- Root scripts are reserved for `pnpm guard`, `pnpm typecheck`, `pnpm tools-dev`, `pnpm tools-pack` and `pnpm tools-serve`. Build, test and e2e commands stay package-scoped (`pnpm --filter <package> …`) or tool-scoped; do not add root `build`, `test` or e2e aliases.
- This repository ships `.github/workflows/ci.yml` (validation) and `.github/workflows/release-mac.yml` (unsigned macOS package on a `v*` tag). Read `.github/AGENTS.md` before editing anything under `.github/`, CI handoff artifacts, or the workflow topology checks that guard those surfaces wherever they live (for example `e2e/tests/packaged-smoke-workflow.test.ts`). It also holds the CI test-set orchestration guidance.
- The repository is public. CI runs on GitHub-hosted runners with only the read-only `github.token`: no self-hosted runners, no `pull_request_target`, no secrets in workflows.
- Never commit licensed, paid or scraped third-party content without a licence that allows public redistribution; it belongs in a private pack (`docs/packs.md`).

## CodeGraph

Each checkout carries a git-ignored CodeGraph index in `.codegraph/`. Build the main checkout's index once (`sh scripts/agents/codegraph-worktree.sh`). A linked worktree gets its index from the same script, which clones a consistent seed of the main index and syncs only the changed files in seconds; never run `codegraph init` in a worktree. Claude Code runs it at session start; after creating a worktree mid-session, run it yourself before querying, and in a worktree prefer the CLI or pass the worktree as `projectPath` to the MCP tools. Refresh with `codegraph sync .` after a pull or a large merge.

- Before `grep`, `find` or reading files to locate or understand code, run `codegraph explore "<symbol names or question>"` or the `codegraph_explore` MCP tool when it is registered: it returns the symbols' source and the call paths between them, including dynamic-dispatch hops text search cannot follow. Name a file or symbol in the query to read its current source. If it misses, fall back to `rg`.
- Before changing a symbol, run `codegraph impact <symbol>` or `codegraph callers <symbol>` to see what depends on it and which tests cover it.
- Run every CodeGraph process with `CODEGRAPH_PARSE_WORKERS=2`, `CODEGRAPH_RESOLVE_WORKERS=2` and `CODEGRAPH_QUERY_POOL_SIZE=2`; uncapped, each checkout's daemon starts a query thread per core. Do not stop a daemon another session may be using.

## Local resources

One developer machine hosts several agents; keep it responsive. Detail: `docs/agents/local-resources.md`.

- One writer session per checkout, and at most 2 checkouts of a clone with a writer at once (`MISH_MAX_WRITERS`, never above 3). Claude Code enforces this with hooks on edits and writing shell commands. Start other agents through `sh scripts/agents/writer-slot.sh run --agent <name> -- <command>`; a slot frees when its owner process exits.
- When the limit is reached, wait or offload. Full type checks and package suites for a pushed branch run on the offload machine with `sh scripts/agents/offload.sh <branch> ['<command>']`, which checks the exact pushed commit and prints a receipt.

## Boundary constraints

- Tests live in a `tests/` directory beside `src/`; keep `src/` source-only. Playwright UI automation belongs in `e2e/ui/`. Checks that span apps or packages belong in `e2e/tests/`; promote reusable logic to a pure package instead of borrowing another app's private source.
- An app must not import another app's `src/` or `tests/`. `apps/web` never imports `apps/daemon/src`; web/daemon integration goes through HTTP APIs, `packages/contracts` and app-local providers.
- Shared API DTOs, SSE event unions, error shapes, task shapes and example payloads live in `packages/contracts`; update the contract before wiring a new request or response shape. `packages/contracts` stays free of Next.js, Express, Node filesystem/process APIs, browser APIs, SQLite, daemon internals and the sidecar protocol.
- Edit `.ts` sources, not generated `dist/*.js`.
- App business logic does not know about the sidecar or control plane; keep that in `apps/<app>/sidecar` or the desktop sidecar entry.
- Sidecar stamps have exactly five fields: `channel`, `namespace`, `source`, `mode`, `app`. IPC is never a stamp field. Identity is argv-only; do not create identity or state files from a stamp.
- `tools-dev`, `tools-pack` and packaged launchers call `@mish/sidecar` client/atomic primitives; they do not assemble argv, IPC paths or process scans themselves.
- Packaged runtime paths are namespace-scoped and independent of ports. Default runtime files live under `<project-root>/.tmp/<source>/<namespace>/...`; IPC endpoints come from `@mish/sidecar` and are opaque to callers.

## Capability exposure (UI and CLI)

Every user-facing capability ships in both the web UI and the `od` CLI (`apps/daemon/src/cli.ts`). External agents (hermes-agent, openclaw, chat bots, other shells) drive Mish only through `od`, so a UI-only capability cannot be composed into them.

- Both surfaces call the same `/api/*` endpoints, with DTOs in `packages/contracts`.
- CLI commands support `--json` and accept long prompts via `--prompt-file <path|->`.
- One PR lands all three parts: the endpoint in `apps/daemon/src/*-routes.ts` (contract type in `packages/contracts/src/api/`), the UI in `apps/web/src/`, and the `od <capability>` subcommand registered in `SUBCOMMAND_MAP`. Tick both surfaces in the PR template, or explain why one does not apply.
- Copy an existing pair: `od automation …` mirrors the Automations tab (`/api/routines`); `od workbench transform` and `od workbench brief …` mirror Improve prompt (`/api/workbench/briefs*`); `od deploy …` mirrors in-product deploy.

## Commits, PRs and review

- Commits carry no `Co-authored-by` trailer or other co-author metadata.
- Batch work into one coherent PR. Open it as a draft and mark it ready once, after review and the local gates. A red test is a real failure: fix it on a new head; do not rerun for green.
- Before a non-trivial change is marked ready, get an independent review from another model family.
- Fill every section of `.github/pull_request_template.md`. "Why" gives the use case and the pain addressed. "What users will see" describes clicks, new UI and changed defaults, not code. Tick every surface touched (including `skills/`, `design-systems/`, `design-templates/`, `craft/`, CLI flags, env vars, i18n keys, root dependencies). UI changes need screenshots of the entry point. Bug fixes link the red spec that failed on `main` and passes on the branch.
- `CONTRIBUTING.md` is the path from branch to merged PR. Review against `docs/code-review-guidelines.md`, top-down; this file wins where they disagree. Before reviewing under `apps/`, `packages/`, `tools/` or `e2e/`, read that directory's `AGENTS.md`. Block only on correctness, security, data integrity, boundary violations, contract or migration breakage, missing validation, or high-risk maintainability.

## Prompt variants (two implementations, one switch)

A generation run is composed by one of two independent prompt implementations. `composeSystemPrompt` returns early at `apps/daemon/src/prompts/system.ts:962` when the run carries an OD Next recipe, skipping the whole legacy stack; the API/BYOK mirror at `packages/contracts/src/prompts/system.ts:334` forks the same way. A rule added to one side holds only for runs on that side.

- **Legacy:** `apps/daemon/src/prompts/`, mirrored for API/BYOK in `packages/contracts/src/prompts/`.
- **OD Next:** `plugins/_official/scenarios/od-next-strategy/assets/**` (sent to the model verbatim) plus `packages/contracts/src/prompts/od-next-strategy.ts`, which carries host contracts such as `<question-form>` and the deck framework.
- **Switch:** Settings → Labs → Design Harness, app-config `odNextStrategyMode`, or `OD_NEXT_STRATEGY_ROLLOUT`. `evaluateOdNextRollout` (`apps/daemon/src/strategies/od-next/rollout.ts:151`) decides per run from the run's own inputs (task type, scenario provenance, agent, preflight), so two runs on one machine can take different sides with the switch unchanged.

Give each host contract one source that every path consumes; `packages/contracts/src/prompts/deck-framework.ts` is the example. Never write repository notes into that plugin's `assets/`: the model receives them.

## Asking the user questions

The only clarification mechanism is the inline `<question-form>` artifact, valid on any turn. `AssistantMessage.tsx` renders it; answers return as the next user message. There is no `AskUserQuestion` wiring, Questions tab or host-answer endpoint. Prompt guidance lives in `apps/daemon/src/prompts/system.ts` and `discovery.ts`, mirrored in `packages/contracts/src/prompts/system.ts`.

## Validation strategy

- Before adding, repairing or optimizing tests, follow `docs/testing/test-efficiency.zh-CN.md` (completion signals, virtual clocks, isolation).
- Before marking work ready: `pnpm guard`, `pnpm typecheck`, and the package-scoped tests and builds for the files changed.
- Agent-stream and parser changes: replay a recorded session through `mocks/` instead of spending provider budget: `export PATH="$PWD/mocks/bin:$PATH" OD_MOCKS_TRACE=<8-char-id> OD_MOCKS_NO_DELAY=1`.
- E2E tests use the shared harness in `e2e/lib/tools-dev/` and the suite adapters; Playwright tests import `test`/`expect` from `@/playwright/suite`. Details: `e2e/AGENTS.md`.
- Desktop, on a GUI-capable machine: `pnpm tools-dev`, then `pnpm tools-dev inspect desktop status`. Stamp or namespace changes: validate two concurrent namespaces with `inspect eval` and `inspect screenshot` each. Path or log changes: confirm `pnpm tools-dev logs --namespace <name> --json` paths sit under `.tmp/tools-dev/<namespace>/`.
- The Docker image is outside CI. Publish by hand with `deploy/scripts/publish-images.sh --image_namespace zerosum-solutions`.

## Bug follow-up workflow

A default shape, not a contract; use judgment when a case does not fit.

- Lead with a red spec at the cheapest layer that sees the symptom: daemon HTTP e2e Vitest, then app Vitest, then Playwright, then platform harnesses.
- Keep to the bug's scope. Defects found outside it go in the PR's "Adjacent issues" section and get their own spec and PR.
- Write the fix as a named helper whose docblock states the invariant, not a bolt-on guard.
- When neighbouring suites already fail, compare against `main` before claiming "no new failures".
- Link the issue with `Fixes #N` so it closes on merge and release lookups can trace it.
- For visible bugs (UI, native behavior, races), green specs are not acceptance: set up a `main`-vs-fix comparison the reviewer can drive, seeded only through production HTTP APIs.

Worked example: `e2e/tests/dialog/stop-reconciles-message.test.ts` (issue #135).

# Common commands

```bash
pnpm install
pnpm tools-dev                      # start; also: start web, stop, check
pnpm tools-dev run web --daemon-port 17456 --web-port 17573
pnpm tools-dev status --json        # also: inspect desktop status --json
pnpm tools-dev logs --json
pnpm tools-dev inspect desktop screenshot --path /tmp/mish.png
pnpm tools-serve start updater
pnpm guard && pnpm typecheck
pnpm --filter @mish/web typecheck   # likewise test / build for @mish/web, @mish/daemon
pnpm --filter @mish/desktop build   # likewise @mish/tools-dev, @mish/tools-pack, @mish/tools-serve
pnpm tools-pack mac build --to all  # then: mac install, mac cleanup
pnpm tools-pack win build --to nsis  # then: win install, win cleanup
pnpm tools-pack linux build --to appimage   # or --containerized; then: linux install
```
