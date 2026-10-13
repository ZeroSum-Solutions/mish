# Local resources for agents

How agents share one developer machine without slowing it down. Root `AGENTS.md` → "Local resources" holds the rules; this page holds the detail. The scripts live in `scripts/agents/`.

## Writer limit

A writer is a checkout (the main one or a linked worktree) where an agent edits files. At most `MISH_MAX_WRITERS` checkouts of one clone are edited at the same time: 2 by default, never more than 3. Each writer runs its own type checks, tests and dev servers, so this limit is what keeps memory and CPU in check.

- Claude Code enforces it with hooks in `.claude/settings.json`: a file edit claims a slot for its checkout, and the session's slots are released when it ends. When every slot is held, the edit is blocked and the message names the holders.
- Other agents (Codex, Hermes, scripts) claim before the first edit and release when they finish:

  ```bash
  sh scripts/agents/writer-slot.sh claim --agent codex
  sh scripts/agents/writer-slot.sh release
  sh scripts/agents/writer-slot.sh status
  ```

- Several sessions in one checkout share its slot. A slot that sees no edit for `MISH_WRITER_TTL_MIN` minutes (default 20) expires, so a crashed session cannot hold one forever.
- Edits made through shell commands (`sed -i`, heredocs, generators) do not pass the hook. Claim a slot before you make them.
- Reading, searching, reviewing and planning need no slot.

When the limit is reached, do not work around it. Wait for a writer to finish, or move the work to the offload machine.

## Offload machine (Mac mini)

The owner's Mac mini runs work the laptop should not: full type checks, package test suites and an extra writer. It runs one job at a time and is outside the local writer limit.

- **Heavy checks for a pushed branch:**

  ```bash
  sh scripts/agents/offload.sh <branch>                                  # pnpm guard && pnpm typecheck
  sh scripts/agents/offload.sh <branch> 'pnpm --filter @mish/daemon test'
  ```

  The mini fetches the branch from GitHub into one reusable checkout and runs the command there. Exit 3 means it is busy: retry later or run the check locally.
- **An extra writer:** start the agent on the mini in its own clone through the owner's dispatcher (`mini-run`), for example a `codex exec` or `claude -p` job with a written brief. It pushes its own branch and opens its own PR.
- The mini has 16 GB of memory. Run one heavy job there at a time and keep its CodeGraph caps (below).

## CodeGraph

A full index build parses all ~6,500 files and can use several GB of memory. Two things keep it cheap:

- **Worktrees clone the main index.** `sh scripts/agents/codegraph-worktree.sh` gives a checkout an index by cloning the main checkout's (an APFS clone, so no extra disk until it changes) and running `codegraph sync`, which reparses only the files that differ. It takes seconds. Claude Code runs it in the background when a session starts in a worktree without an index. Never run `codegraph init` in a worktree.
- **Worker caps.** Every CodeGraph process should run with `CODEGRAPH_PARSE_WORKERS=2`, `CODEGRAPH_RESOLVE_WORKERS=2` and `CODEGRAPH_QUERY_POOL_SIZE=2`. Without them, each checkout's background daemon starts up to one query thread per core, and an index build one parser per core. `.claude/settings.json` sets them for Claude Code; set them in your shell and in any other agent's CodeGraph MCP entry.

Until a new worktree's index is ready, CodeGraph either answers from the nearest index above the worktree (for Claude Code worktrees in `.claude/worktrees/`, the main checkout's) or reports no index. Read the file itself when branch-specific code matters.

A daemon stops 5 minutes after its last client disconnects. Never stop one another session may be using; `codegraph daemons` lists them.
