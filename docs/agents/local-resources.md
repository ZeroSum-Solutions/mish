# Local resources for agents

How agents share one developer machine without slowing it down. Root `AGENTS.md` → "Local resources" holds the rules; this page holds the detail. The scripts live in `scripts/agents/`, and `e2e/tests/scripts/agent-writer-slot.test.ts` pins the writer limit's behavior.

## Writer limit

A writer is one agent session editing one checkout (the main checkout or a linked worktree). Each checkout has at most one writer, and at most `MISH_MAX_WRITERS` checkouts of one clone have a writer at the same time: 2 by default, never more than 3. Each writer runs its own type checks, tests and dev servers, so this limit is what keeps memory and CPU in check.

- **A slot belongs to its owner process** (the Claude Code or Codex process, or the command under `run`) and frees itself when that process exits, so a crashed session never holds one. A slot with no known owner process expires `MISH_WRITER_TTL_MIN` minutes (default 240) after its last claim.
- **Claude Code** enforces the limit with hooks in `.claude/settings.json`. A file edit, and a shell command that writes (`git commit`, `sed -i`, redirects, `pnpm install`, `mv`/`cp`/`rm`, …), claims a slot for its checkout. The session's slots are released when it ends. When no slot is free, the tool call is blocked and the message names the holders. A second session editing a checkout that already has a writer is blocked too.
- **Other agents** (Codex, Hermes, scripts) start through the wrapper, which holds a slot exactly as long as the command runs:

  ```bash
  sh scripts/agents/writer-slot.sh run --agent codex -- codex exec "…" < /dev/null
  sh scripts/agents/writer-slot.sh status
  ```

  An agent that cannot be wrapped claims before its first edit and releases when it finishes (`claim --agent <name>`, `release`). `release` frees only your own slot; `release --force` frees another session's, for a session you know has ended. An agent started without either is not counted; that is a rule violation, not a gap to use.
- Claude Code under `run` (for example `writer-slot.sh run --agent claude -- claude -p …`) uses the wrapper's slot; its own hooks do not claim a second one.
- The shell-command check is a pattern match, not a parser. It catches common writes (`git commit`, `git -C … commit`, `sed -i`, redirects, `pnpm install`, `mv`/`cp`/`rm`) and claims the checkout of the command's working directory. A command that writes in another checkout through `cd` is not seen; claim that checkout yourself.
- If the registry cannot be locked or written, the edit is refused rather than let through uncounted. The registry uses a kernel file lock, which the system drops when its holder exits, so a crashed process never leaves it locked.
- Reading, searching, reviewing and planning need no slot.

When the limit is reached, do not work around it. Wait for a writer to finish, or move the work to the offload machine.

## Offload machine (Mac mini)

The owner's Mac mini runs work the laptop should not: full type checks, package test suites and an extra writer. It runs one job at a time and is outside the local writer limit.

- **Heavy checks for a pushed branch:**

  ```bash
  sh scripts/agents/offload.sh <branch>                                  # pnpm guard && pnpm typecheck
  sh scripts/agents/offload.sh <branch> 'pnpm --filter @mish/daemon test'
  ```

  The script resolves the commit origin has for the branch, and the mini checks out exactly that commit in one reusable checkout. The output ends with a receipt (host, commit, command, Node and pnpm versions, exit code); quote it as evidence. The receipt's `exit:` line is the command's real exit code; the script itself returns 1 for any remote failure. Local edits that are not pushed are not checked. Exit 3 means the mini is busy: retry later or run the check locally.
- **An extra writer:** start the agent on the mini in its own clone through the owner's dispatcher (`mini-run`), for example a `codex exec` or `claude -p` job with a written brief. It pushes its own branch and opens its own PR.
- The mini has 16 GB of memory. Run one heavy job there at a time and keep its CodeGraph caps (below).

## CodeGraph

A full index build parses all ~6,500 files and can use several GB of memory. Three things keep it cheap:

- **Worktrees clone a seed of the main index.** `sh scripts/agents/codegraph-worktree.sh` takes a consistent seed of the main checkout's index with SQLite's online backup (refreshed when the main index changes), APFS-clones it into the worktree and runs `codegraph sync`, which reparses only the files that differ. A warm run takes about 2 seconds and 400 MB. `.codegraph/mish-ready` marks a finished bootstrap. Never run `codegraph init` in a worktree.
- **Bootstrap before the first query.** Claude Code runs the script in the foreground when a session starts, so the index exists before the session's first CodeGraph call. If you create a worktree during a session, run the script in it yourself before you query.
- **Worker caps.** Every CodeGraph process runs with `CODEGRAPH_PARSE_WORKERS=2`, `CODEGRAPH_RESOLVE_WORKERS=2` and `CODEGRAPH_QUERY_POOL_SIZE=2`. Without them a checkout's daemon may grow to one query thread per core, and an index build starts one parser per core. `.claude/settings.json` sets them for Claude Code; set them in your shell and in any other agent's CodeGraph MCP entry. The caps limit threads, not total memory: fewer live checkouts is what saves memory.

A CodeGraph MCP server binds to the index it finds first and keeps it. In a worktree, prefer the `codegraph` CLI run from the worktree root, or pass the worktree path as `projectPath` to the MCP tools. When branch-specific code matters, read the file.

A daemon stops 5 minutes after its last client disconnects. Never stop one another session may be using; `codegraph daemons` lists them.
