---
name: mish-bugfix
description: Fix a bug in this repository the house way - red spec first at the cheapest layer that sees the symptom, a named-helper fix, scoped checks, and a PR that links the issue. Use when asked to fix a bug, regression, crash or wrong behavior in Mish, or when given a GitHub issue to fix.
---

# Mish bug fix

Root `AGENTS.md` → "Bug follow-up workflow" is the source; this is the order of work.

1. **Reproduce in a test before touching source.** Pick the cheapest layer that sees the symptom: daemon HTTP e2e Vitest → app Vitest → Playwright (`e2e/ui/`) → platform harnesses. Tests go in the package's `tests/`, never `src/`. Run it and see it fail for the reported reason. Read `docs/testing/test-efficiency.zh-CN.md` before writing timing-sensitive tests (completion signals, virtual clocks, no sleeps).
2. **Find the cause, not the symptom.** `codegraph explore "<symptom symbols>"`, then `codegraph impact <symbol>` before editing. Read the `AGENTS.md` of every directory you will touch.
3. **Fix as a named helper** whose docblock states the invariant it protects. No bolt-on guard at the call site.
4. **Stay in scope.** Defects you notice outside the bug go in the PR's "Adjacent issues" section, not in this diff.
5. **Check only what you changed:** `pnpm guard`, `pnpm --filter <package> typecheck` and the test files that cover the change. If neighbouring suites already fail, compare against `main` before claiming "no new failures". Heavy suites can run on the Mac mini: `docs/agents/local-resources.md`.
6. **Visible bugs** (UI, native behavior, races): green specs are not acceptance. Leave the reviewer a `main`-vs-fix comparison seeded only through production HTTP APIs.
7. **Ship** with the `mish-ship` skill. The PR body links the red spec, says it failed on `main` and passes on the branch, and carries `Fixes #N`.

Done when: the spec failed on `main`, passes on the branch, scoped checks pass, and the PR is open with the template filled.
