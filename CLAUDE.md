@AGENTS.md

## Claude Code in this repository

- `.claude/settings.json` hooks enforce the writer limit and prepare CodeGraph in new worktrees (`docs/agents/local-resources.md`). When an edit is blocked by the writer limit, follow the message; never route the edit through Bash to get around it.
- Project skills: `mish-bugfix` (red spec first) and `mish-ship` (branch to merged PR). Subagent `mish-reviewer` gives a fast same-family pre-check; the required review is still by the other model family.
- Keep the main context for decisions: send broad searches and multi-file reading to a subagent, and use `codegraph explore` before reading files by hand.
