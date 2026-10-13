# apps/daemon/AGENTS.md

Follow the root `AGENTS.md` and `apps/AGENTS.md` first. This file records daemon-specific code organization and editing rules.

## Role

`apps/daemon` is the local Express + SQLite daemon and owns:

- `/api/*` HTTP routes and SSE streams.
- The `od` CLI entrypoint in `src/cli.ts`.
- Project persistence, generated files, artifacts, media, skills, design systems, plugins, MCP, connector credentials, automation state, agent spawning, and static serving.
- The daemon sidecar entry under `sidecar/`.

The daemon is not a shared library for the web app. Do not import daemon private `src/` modules from `apps/web`; shared web/daemon contracts belong in `packages/contracts`.

## Source Layout

- `src/server.ts` is the composition root: create process-wide services, build dependency objects, install middleware, and register route modules. Keep request/domain logic out of `server.ts` unless the route is genuinely bootstrap-wide.
- `src/cli.ts` is the CLI composition root: parse top-level commands, dispatch subcommands, and format process output. Keep substantial command implementation in domain modules or focused `*-cli.ts` helpers.
- `src/server-context.ts`, `src/route-context-contract.ts`, `src/route-registration-guard.ts`, and small root constants/startup helpers may stay at the top level because they describe daemon-wide wiring.
- `src/routes/` contains domain route registrars that were split out of `server.ts`. New daemon domain endpoints should normally land here.
- Legacy route files still at `src/*-routes.ts` may remain until touched. When making meaningful changes in one, prefer moving it to `src/routes/<domain>.ts` if the move is small and mechanically safe.
- `src/http/` owns shared HTTP helpers, error/result adapters, origin checks, and route mounting utilities.
- `src/services/` owns reusable daemon services that are not tied to Express request/response objects.
- `src/runtimes/` owns agent runtime definitions, spawning, parser integration, executable discovery, and runtime environment shaping. Agent argument definitions belong in `src/runtimes/defs/`.
- `src/prompts/` owns daemon-side prompt construction. Keep mirrored BYOK/API wording in `packages/contracts/src/prompts/` when the same text is exposed outside the daemon.
- `src/plugins/`, `src/connectors/`, `src/registry/`, `src/research/`, `src/media-adapters/`, `src/live-artifacts/`, `src/storage/`, and `src/critique/` own their named domains. Prefer adding code inside the existing domain folder before creating a new top-level folder.
- Team resource storage is Vela-owned. Daemon adapters under `src/collab/vela-cli-*` must invoke Vela through `src/integrations/vela-command.ts`, which shares the login/agent binary resolver and environment. Do not add Resource Hub tokens, direct HTTP clients, or a second content-addressed drive implementation to Mishh Mashh. `od resource` is only a thin Vela CLI compatibility entry point.
- `tests/` contains daemon tests. Keep test paths roughly parallel to `src/` when useful.

Do not edit generated `dist/` output.

## Top-Level `src/` Hygiene

Do not keep adding unrelated files directly under `src/`. The top level is currently crowded, so use these rules for new code and for touched legacy files:

- New domain code belongs in a domain folder, not in `src/<feature>.ts`, unless it is a daemon-wide primitive.
- New route code belongs in `src/routes/` or an existing route subfolder such as `src/routes/plugins/`.
- New runtime or stream-parser code belongs in `src/runtimes/`, with runtime definitions in `src/runtimes/defs/`.
- New provider/integration client code belongs in the existing domain folder when one exists, or under `src/integrations/<provider>.ts` for provider-specific glue.
- New persistence/storage abstractions belong in `src/storage/` unless they are tightly coupled to the legacy SQLite facade in `src/db.ts`.
- New prompt construction belongs in `src/prompts/`.
- New plugin, connector, registry, research, media adapter, live-artifact, critique, metrics, logging, QA, or GenUI code belongs in the matching existing folder.
- New general-purpose helpers should be avoided. If a helper has a real owner, put it with that owner. If it is daemon-wide infrastructure, use a focused folder such as `src/http/`, `src/services/`, `src/storage/`, or `src/runtimes/` instead of creating another top-level utility file.

When touching a legacy top-level file:

- Prefer a small, safe move into an existing domain folder when imports are straightforward and the change is already about that domain.
- Do not mix a broad mechanical move with behavior changes unless the move is required to make the behavior change understandable.
- If a file is split, keep the public function names stable at call sites where possible and move tests with the behavior they cover.
- Use temporary root-level compatibility exports only when they materially reduce churn; remove them in the same PR if the diff stays small.

Suggested ownership for common legacy top-level families:

- `project-routes.ts`, `import-export-routes.ts`, `mcp-routes.ts` -> `src/routes/`. (Route modules already split out, such as `routes/chat.ts`, `routes/terminal.ts`, and `routes/social-share.ts`, are done; do not list them here.)
- `copilot-stream.ts`, `acp.ts`, `agents.ts`, `run-*`, `agent-*`, `*-diagnostics.ts` -> usually `src/runtimes/` or a future `src/runs/` folder, depending on ownership. (`claude-stream.ts`, `qoder-stream.ts`, `json-event-stream.ts`, and `runs.ts` already live under `src/runtimes/`.)
- `design-systems-cli-help.ts`, `tools-design-systems-cli.ts`, `claude-design-import.ts` when used only there -> `src/design-systems/`. (Core design-system modules, design tokens, `swift-colors.ts`, and `frontmatter.ts` are already under `src/design-systems/`.)
- `inline-assets.ts`, `lint-artifact.ts`, `pdf-export.ts`, `document-preview.ts`, `static-spa.ts` -> `src/artifacts/` or the existing artifact owner. (The `artifact-*` family already moved under `src/artifacts/`.)
- `memory*.ts`, `orbit*.ts`, `automation-*.ts`, `routines.ts`, `prompt-*`, `handoff-*`, `finalize-design.ts` -> keep with their domain; introduce folders when touching multiple related files.

The `media-*` family has already moved into `src/media/`; no media modules remain at the top level.

These are migration targets, not permission to do a large cleanup PR. Move only what helps the current change or removes active ambiguity.

## Route Structure

Route modules should follow this shape:

```ts
import type { Express } from 'express';
import type { RouteDeps } from '../server-context.js';

export interface RegisterExampleRoutesDeps extends RouteDeps<'http' | 'paths'> {
  example: ExampleService;
}

export function registerExampleRoutes(app: Express, ctx: RegisterExampleRoutesDeps): void {
  // app.get/post/patch/delete(...)
}
```

Guidelines:

- Keep one exported registrar per domain, except where the existing file already has a small family of closely related registrars.
- Declare a narrow `Register*RoutesDeps` type. Pick only the `ServerContext` keys the route uses, and add explicit service interfaces for domain-specific dependencies.
- Add the registrar dependency type to `src/route-context-contract.ts` when it should be covered by the server context assertion.
- Register the route from the matching semantic section in `src/server.ts`.
- Use existing route helpers from `src/http/` when they fit. Do not invent another error envelope if a contract already exists.
- Keep parsing/validation near the route boundary and push reusable behavior into named helpers or services.
- Do not add new route handlers directly to `server.ts` unless they are bootstrap-wide process metadata such as health/version.

## Dependency Boundaries

- `src/server-context.ts` is the route dependency map. If a route needs a new cross-route dependency, add it there deliberately and keep its type narrow.
- Prefer explicit domain service interfaces in route files over `any` or `unknown`.
- Use types from the implementation module or `packages/contracts` instead of restating response shapes by hand.
- Keep `packages/contracts` pure. Do not move daemon-only Node, SQLite, Express, filesystem, or process types into contracts.
- Daemon data paths must follow the root **Daemon data directory contract**. Route all daemon-owned data through `RUNTIME_DATA_DIR` or constants derived from it.

## CLI and Surface Parity

User-facing capabilities must be reachable through both:

- Web/API routes in the daemon.
- `od` CLI subcommands in `src/cli.ts`.

Two capabilities that depend on external services and are easy to misdescribe:

- Improve prompt (`src/routes/workbench-brief.ts`, `src/workbench/brief/`; `od workbench transform`, `od workbench brief …`): the `terra` lane (GPT Terra on OpenRouter, Settings → Labs) needs an OpenRouter key and falls back to a no-tool `claude -p` turn, which needs a signed-in Claude Code CLI. With neither available it cannot run, and its availability reply says which recovery applies.
- Deploy (`src/routes/deploy.ts`, `src/deploy.ts`; `od deploy`): `POST /api/projects/:id/deploy` deploys to Vercel (the default `providerId`) or Cloudflare Pages. The Vercel provider drives the Vercel REST API with the user's saved Vercel token; polling stops on `READY`, `ERROR`, `CANCELED` or `BLOCKED`; only `READY` takes the stable alias; failures surface as `VERCEL_DEPLOY_FAILED` (502) or `VERCEL_DEPLOY_TIMEOUT` (504).

When adding a user-facing capability, close the loop in one change: contract type, daemon route, web surface if applicable, and CLI command with `--json` plus `--prompt-file <path|->` for long prompts where relevant.

## Runtime and Agent Changes

- Parser changes belong beside the matching runtime stream helper and should include focused parser tests.
- Runtime definition changes belong in `src/runtimes/defs/`.
- For agent-stream/parser changes, replay a mock CLI trace from `mocks/` when practical instead of burning provider budget.
- Preserve Claude stream-json bookkeeping in `src/runtimes/claude-stream.ts` and `src/server.ts`; do not close stdin on `tool_use` stop reasons.

## Tests

- Tests belong under `apps/daemon/tests/`, not under `src/`.
- Use the cheapest layer that can observe the behavior: pure helper test, route-level Vitest with `startServer`, then broader integration only when necessary.
- For bug fixes, prefer a red spec that fails before the fix.
- If a test depends on native modules such as `better-sqlite3`, make sure local dependencies were built for the active Node version before blaming the code.
- `tests/setup.ts` scrubs `ANTHROPIC_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `CLAUDE_CONFIG_DIR` from the inherited environment, because the daemon forwards them to spawned Claude processes and the Claude diagnostics change guidance on them. A test that needs one sets it explicitly.
- Tests that make a file or directory unreadable with `chmod` cannot fail as root (`CAP_DAC_OVERRIDE`), and process-group tests that wait for orphans to be reaped need a reaping PID 1. A failure of that kind in a container running as uid 0 is an environment limit to prove and report, not a reason to weaken the test.

## Commands

Common daemon checks:

```bash
pnpm --filter @mish/daemon typecheck
pnpm --filter @mish/daemon test
pnpm --filter @mish/daemon build
```

Focused tests from `apps/daemon`:

```bash
pnpm exec vitest run -c vitest.config.ts tests/<file>.test.ts
```

For local runtime validation, start through the repo control plane, not daemon package lifecycle aliases:

```bash
pnpm tools-dev run web --daemon-port <port> --web-port <port>
```

## Review Checklist

Before handing off daemon changes, check:

- Route logic is in a route module, not newly embedded in `server.ts`.
- New route deps are explicit and covered by `route-context-contract.ts` where appropriate.
- Shared DTOs or error shapes live in `packages/contracts` when the web or CLI consumes them.
- CLI parity is handled or explicitly not applicable.
- Daemon data paths derive from the resolved daemon data root.
- Tests are under `tests/` and relevant checks were run.

## Agent runtime conventions

- `RuntimeAgentDef.promptInputFormat` selects how the daemon writes the prompt to a child's stdin. The default `'text'` writes the composed prompt and ends stdin immediately. `'stream-json'` wraps the prompt as one JSONL `user` message and KEEPS stdin open so the daemon can stream further user messages back in mid-turn. Claude (`apps/daemon/src/runtimes/defs/claude.ts`) ships `'stream-json'` together with `--input-format stream-json` as generic mid-turn input infrastructure; the daemon closes stdin once the turn terminates cleanly. Every other agent stays on `'text'`.
- `apps/daemon/src/server.ts` tracks `run.stdinOpen` on the run object. `applyClaudeStreamJsonRunBookkeeping` closes stdin (and records `turnCompletedCleanly`) when a `turn_end` (or `usage`) event arrives with a non `tool_use` `stop_reason`. The `tool_use` stop reason means the model paused mid tool (waiting on claude-code's internal runner); closing stdin there would truncate the follow up response.
- `claude-stream.ts` reads the turn's `stop_reason` from **three** frames, because Claude Code moved the field and the daemon does not control which build a user has installed. In order of precedence per message: (1) `stream_event` → `message_delta` → `delta.stop_reason`, the only place Claude Code 2.1.259 carries it, available only when `--include-partial-messages` is negotiated; (2) `assistant` → `message.stop_reason`, the legacy shape, which 2.1.259 leaves `null` on every frame but which older CLIs and argv-compatible forks still populate; (3) the terminal `result` frame, surfaced as `usage`, present on every build and flag combination. `emitTurnEndOnce` dedupes them by assistant message id so a build that fills both (1) and (2) announces one turn once. There is deliberately no version gate — nothing tells us which release stopped filling the legacy field, and forks version themselves independently.
- Whichever source fires, `turn_end` is emitted AFTER every tool_use of the message has been emitted, so the daemon never closes stdin before it has seen the turn's tool calls. Only a main-turn frame may fire it: a forwarded Task sub-agent frame carries a non-null top-level `parent_tool_use_id` and is refused (#5487).
- A `result` frame ends one **user turn**, not the CLI process: a stream-json session whose stdin stays open emits one `result` per turn and keeps reading. That makes it a valid per-turn reset point for `claude-stream.ts`'s artifact-echo dedup, and on a build with no in-stream boundary at all it is the only one.
- The verbatim CLI recordings behind all of the above are not published in this repository. The owned synthetic fixtures in `apps/daemon/tests/fixtures/daemon-b/claude-stream/` reproduce the current frame shapes (`message_delta` stop_reason, forwarded sub-agent frames, multi-turn `result` frames, no-partial-messages streams) and back the `w1xx-*` runtime tests. Assert new turn-boundary behavior against those, **not** against the older hand-built Claude fixtures elsewhere in `apps/daemon/tests/` — those put `stop_reason` on the `assistant` wrapper and describe a stream the current CLI no longer produces.
- The host asks the user clarifying questions through the `<question-form>` artifact (see root `AGENTS.md` → "Asking the user questions"), NOT through a stdin-injected `tool_result`. There is no `AskUserQuestion` tool wiring, no `/api/runs/:id/tool-result` endpoint, and no host-answer return path. The stream-json input skeleton is generic infrastructure, and its one product consumer is `POST /api/runs/:id/steer` (「引导对话」, B11): the USER pushes a further message into a turn that is still running, which is the opposite direction from `<question-form>`. Admissibility lives in `apps/daemon/src/runtimes/run-steering.ts` (`classifyRunSteering`) — do not re-derive it at a call site, and do not extend it into a host-question path.

## Starting a physical Run

- Every physical Run is started through `internalRunCreation.start(run, analytics, starter)` (`apps/daemon/src/services/internal-run-service.ts`). Calling the run registry's `start` directly bypasses the Run analytics lifecycle, so the Run reports no `run_created` and no `run_finished` and nothing says so. `pnpm guard`'s "run start choke point" check enforces this; the only allowed caller of `.runs.start(` is the service itself.
- The `analytics` argument is required on purpose. A caller with no identity to attribute the Run to — a scheduled Automation, a background refresh — passes `requestAnalyticsContext: null` explicitly; the lifecycle then stays silent instead of inventing one. Stating "no identity" is a decision the code has to record, not a step a caller can skip.
- A daemon-created Run that continues an existing task inherits its analytics identity and lineage from the Run that caused it, via `inheritedRunLineageHints` (`apps/daemon/src/services/run-analytics-lifecycle.ts`). Resolve lineage through that helper rather than from the source Run's `analyticsRecovery`: the lifecycle re-reads host facts before it captures, so a short Run can hand off before its own recovery record exists.
- `run-artifacts.ts:runAskedUserQuestion` sets the `run_finished.asked_user_question` analytics signal by scanning the run's streamed text for a `<question-form` marker (reassembled across `text_delta` chunks), not by detecting a tool call.
