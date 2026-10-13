# Contributing to Mish!

This is a public repository owned by ZeroSum Solutions. People and agents who work on it follow the rules below. [`AGENTS.md`](AGENTS.md) holds the full engineering rules; this page is the short path to a merged pull request.

## Before you start

1. Read [`AGENTS.md`](AGENTS.md). It is the source of truth for boundaries, commands and checks. When this page and `AGENTS.md` disagree, `AGENTS.md` wins.
2. Set up the app with one command: `sh scripts/team-setup.sh`. See [`QUICKSTART.md` → Team setup](QUICKSTART.md#team-setup).
3. Run `./scripts/install-fork-hooks.sh` once per clone.

## The path to a merged change

1. **Branch.** Create a feature branch from `main`. Use a git worktree when other work is open in the same checkout. Never commit to `main` directly.
2. **Test first for bugs.** Write a test that fails on `main`, then fix the code. See "Bug follow-up workflow" in `AGENTS.md`.
3. **Check locally, only what you changed.** Run `pnpm guard`, the typecheck for each package you touched, and the test files that cover your change. Do not run the full test suite locally; CI runs it once.
4. **Commit.** Use a conventional commit message (`feat:`, `fix:`, `docs:`, `chore:`, `ci:`, `test:`). Do not add `Co-authored-by` or other attribution lines. Keep evidence (screenshots, timings, receipts) out of the repository: it goes in the pull request body or in the owner's notes folder.
5. **Get an independent review from the other model family.** Code written by a GPT model (Codex) is reviewed by a Claude model; code written by a Claude model is reviewed by GPT-6.1 Sol. The review reports BLOCK, WARN and NIT findings with `file:line`. Fix every BLOCK and every WARN you agree with, then ask for a short re-check of the fixes only. A non-trivial change does not land without this review.
6. **Open the pull request as a draft** against `ZeroSum-Solutions/mish`: `gh pr create --draft --repo ZeroSum-Solutions/mish` (always pass `--repo`; without it `gh` picks the upstream repo). Fill every section of the template. CI runs no workloads on a draft: only a one-step gate that fails until the PR is ready. That gate still bills about one runner minute per push, so push at review rounds, not every commit. Build a feature as one pull request; fold docs and small tooling changes into it instead of opening separate ones.
7. **Mark it ready once.** When the review and the local checks pass, run `gh pr ready --repo ZeroSum-Solutions/mish <number>`. That starts the head's one CI attempt. Preview what CI will run with `python3 .github/scripts/scopes.py plan --context pr --files <files>`. A later push to a ready pull request is a new head and runs CI again, so push only a real fix or a forced merge-conflict resolution. If no `pull_request` run starts after you mark it ready, tell the owner; do not toggle draft and ready to force one.
8. **Land with a squash merge.** `main` has no merge queue and no required status check, so nothing on GitHub stops a red pull request from merging: merge only after the pull request's own CI is green. `~/bin/zs-land` waits for that CI, then squash-merges. Land a change to CI configuration alone, after other open pull requests have merged. Never use the administrator bypass unless the owner asks for it.

If CI fails, treat it as a real failure and fix it on a new head. Rerun only with recorded proof of an infrastructure failure (a lost runner or a platform cancellation), only the failed jobs, and only once. "Cannot reproduce locally" and "flaky" are not proof.

## What goes where

| Change | Rule |
|---|---|
| Tests | In the package's `tests/` folder, never in `src/`. Playwright UI tests go in `e2e/ui/`. |
| UI text | Add the key to `apps/web/src/i18n/types.ts`, then to `en.ts`. We ship English only. See [`TRANSLATIONS.md`](TRANSLATIONS.md). |
| A capability users reach | Web UI and `od` CLI in the same pull request, through the same `/api/*` endpoint. See "Capability exposure" in `AGENTS.md`. |
| Design systems | Follow [`docs/design-systems/QUALITY-STANDARD.md`](docs/design-systems/QUALITY-STANDARD.md). Do not copy a real company's brand. `pnpm guard` runs the promotion gate. |
| Plugins | Follow [`docs/plugins/PLAYBOOK.md`](docs/plugins/PLAYBOOK.md): scaffold, `od plugin validate`, then a pull request to this repository. |
| Workflows and CI | Read [`.github/AGENTS.md`](.github/AGENTS.md). Use GitHub-hosted runners only; this repository is public. |
| Changes from upstream | Cherry-pick single commits and log each one in [`docs/FORK-PIN.md`](docs/FORK-PIN.md). Never merge from upstream. |

## Never

- Commit licensed, paid, scraped or other third-party content without a recorded licence that allows public redistribution. Such content belongs in a private pack ([`docs/packs.md`](docs/packs.md)).
- Commit secrets. Credentials come from environment variables or the app's settings, never from files in the repository.
- Force-push `main`, rewrite shared history, or use a bare `git stash` in a shared checkout.
- Add upstream names or logos as our identity. See [`docs/legal/LICENSE-COMPLIANCE.md`](docs/legal/LICENSE-COMPLIANCE.md).
- Give a desktop build to anyone before the open items in `LICENSE-COMPLIANCE.md` are closed.

## Ownership

ZeroSum Solutions owns this repository. Devin reviews product and design decisions. Questions: devin@zerosumsolutions.com.
