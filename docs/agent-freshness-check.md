# Freshness check before opening or starting work

Root `AGENTS.md` → **Local lifecycle** sends agents here. Run this check when a user asks to open the application, start a project in it, or begin work on the repository.

When a user asks to open this application, start a new project in it, or begin work
on this repository, check GitHub and the running checkout first. A successful HTTP
response or the package version alone does not prove that the app is current.

- Inspect `git status --short`, the current branch and HEAD, and `git worktree list`.
  Preserve other sessions' dirty files and establish which checkout owns the runtime.
- Fetch `origin` before comparing with `origin/main`. If fetching fails, report that
  freshness is unverified; do not describe cached refs as the latest GitHub state.
- Always name `--repo ZeroSum-Solutions/mish` in GitHub CLI commands.
  A checkout can also carry an upstream remote; implicit GitHub CLI repository
  selection can then resolve to the upstream project and return the wrong PR inventory.
- Check open PRs with `gh pr list --repo ZeroSum-Solutions/mish --state open`
  and live remote branches with
  `gh api repos/ZeroSum-Solutions/mish/branches --paginate`.
  Check PR state before treating surviving feature branches as unfinished work;
  squash-merged branches need not be ancestors of main. Do not automatically merge
  open branches, import upstream changes, or delete surviving branches.
- Treat the latest fetched `origin/main` as the default application baseline.
  Compare the checkout's application and runtime inputs with that baseline. If
  only documentation differs, say so. If application code differs, update safely
  or use an isolated checkout rather than silently presenting an older branch.
  An explicitly requested feature branch remains a valid baseline; name it.
- Use `pnpm tools-dev status --json` to identify the runtime. After source updates
  or when the running build's freshness is uncertain, rebuild affected packages
  and restart daemon/web through `tools-dev`, preserving the configured data root.
  Restart only between runs. Query `GET /api/runs?status=queued` and
  `GET /api/runs?status=running` without a project filter, covering projectless
  runs as well. Both requests must succeed and return empty `runs` arrays.
  The run handler filters status before checking Workspace scope, so
  `PROJECT_SCOPE_REQUIRED` on either active-status query also blocks restart.
  Use authorized project-scoped queries to investigate such runs, but never
  substitute a partial scoped inventory for successful empty global queries.
  Failed or unauthorized queries leave restart safety unverified.
  Verify the web URL and daemon health after restart before opening the session IDE.
- Source freshness and resource freshness are separate. Check the expected
  private resource bundle against the actual published Home/canvas catalogs;
  ignored design-system packets, fonts, saved projects, and assets do not arrive
  with a Git merge. Restore missing resources through supported app operations,
  preserve original bundles and user edits, and verify actual previews.
- When asked to reconcile all previous work, inspect local branches, saved refs,
  stashes, and relevant active/archived sessions as well as GitHub PRs. Use
  squash-merge/patch and file evidence to identify what already landed. Preserve
  failed or deliberately superseded experiments and distinguish unfinished
  work owned by an active session from completed work ready to merge.
- Report the fetched main SHA, actual checkout/branch, code differences, runtime
  verification, and open PR count. Do not promise freshness from package semver.
