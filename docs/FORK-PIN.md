# Fork pin policy — Mishh-Mashh 2

**Decision (2026-09-12, founder):** this repository is a **hard-pinned, cherry-pick-only fork**
of the upstream repository ([`nexu-io/open-design`](https://github.com/nexu-io/open-design)). We own this product.
Upstream is a source of individual features, **never** a merge target.

## The pin

| | |
|---|---|
| Pin point | commit `73953213a6fec2c8092e8e77d229a3074aa828a9` |
| Release tag | `open-design-v0.22.2` (published 2026-09-10) |
| Upstream remote | `upstream` → `https://github.com/nexu-io/open-design.git` — **fetch-only**; its push URL is the literal string `DISABLED-no-push` |
| Our remote | `origin` → `https://github.com/ZeroSum-Solutions/mish` (public) |
| License | Apache-2.0 (upstream) — rebranding and private forks are permitted |

> **Precision note.** The pin is the **commit**, not the tag. At clone time (`2026-09-12`)
> `73953213a` was **19 commits ahead / 38 behind** `upstream/main`: the tagged release line
> and the default branch have diverged. Any cherry-pick reasoning starts from the commit,
> never from the phrase "v0.22.2".

## Rules

1. **No full upstream merges, ever.** `upstream` exists only to supply cherry-picks.
2. **Cherry-pick-only lane.** When upstream ships something we need — an agent-CLI adapter
   fix, a security patch, a whole feature — fetch and cherry-pick the specific commits:

   ```sh
   git fetch upstream
   git cherry-pick <sha>            # one commit
   git cherry-pick <sha1>^..<sha2>  # a contiguous range
   ```

   Each cherry-pick gets a one-line entry in the log at the bottom of this file.
3. **`origin` is our private repo.** Local `main` and every working branch push to `origin`,
   never to `upstream`. `remote.pushDefault` is set to `origin` so a bare `git push` cannot
   reach upstream.
4. **Enforcement.** `.git/hooks/pre-merge-commit` rejects any merge whose `MERGE_MSG`
   references `upstream` (cherry-picks are unaffected, since they are not merges). Hooks are
   unversioned — **reinstall it on a fresh clone**; run
   `./scripts/install-fork-hooks.sh` from the repo root.
5. **The one dependency to watch:** agent-CLI runtime adapters rot as the CLIs evolve. We
   maintain only the lanes we actually use. Adapter definitions for uninstalled CLIs are
   deliberately kept (small files; breakage risk outweighs the bloat win).

## Local environment (this machine)

This Mac's shell runs under **Rosetta 2** (`uname -m` reports `x86_64`,
`sysctl.proc_translated` is `1`), while the hardware is Apple silicon. Two consequences:

- **Always build and install under `arch -arm64`**, or nvm/node-gyp will fetch and build
  **x64** artifacts on an arm64 machine:
  ```sh
  arch -arm64 /bin/bash -c 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24; …'
  ```
- The repo requires **Node `~24`** and **pnpm `10.33.x`**. `.nvmrc` pins `24`; the
  `packageManager` field pins `pnpm@10.33.2`. Use Corepack so the pinned pnpm is selected
  automatically: `corepack pnpm --version` must print `10.33.2`.

`dsh` (DeepSeek Harness) is installed globally **under Node 22**, not Node 24. Keep the nvm
`default` alias on `22.22.3` so `dsh` keeps working, and select Node 24 per-project with
`nvm use`. When the daemon must launch `dsh` from a Node 24 process, point `DSH_BIN` at the
Node 22 binary: `DSH_BIN="$HOME/.nvm/versions/node/v22.22.3/bin/dsh"`.

## Local launcher

Use `pnpm tools-dev start web` (see `QUICKSTART.md`).

`tools-dev stop` uses process discovery that a sandboxed caller may block
(`spawn EPERM`); killing the reported PIDs directly works as a fallback.

Set `MISHH_DSH_PERMISSION_MODE=danger-full-access` to override the Harness tool
permission posture for the agent the daemon spawns. Leave it unset to keep the Harness
default (`workspace-write` + `ask`); set it when `sandbox-exec` is unavailable in the
spawning context and there is no approval channel, because then every shell tool call
fails while file tools still succeed.

## Local patches to upstream files

Both of these are small, deliberate edits to files upstream also changes. Re-check them
whenever a cherry-pick touches the same file; upstream does not carry either one.

| File | Patch | Why it must not be reverted |
|---|---|---|
| `packages/dsh-runtime/src/index.ts` | Replay assistant text from `assistant/message` when an attempt streamed no deltas | Without it every Mishh Mashh run ends `failed` / `empty_output` on dsh ≥ 0.1.3 |
| `apps/web/src/App.tsx` (`handleProjectChange`) | Decide the keep-alive eviction from `projectsRef.current` outside the `setProjects` updater | Evicting from inside the updater notifies pooled iframes (`useSyncExternalStore`) while `AppInner` renders, which React rejects; StrictMode's double-invoked updater makes the side effect run twice |

The `App.tsx` patch is covered by a regression spec in
`apps/web/tests/components/App.previewKeepAlive.test.tsx` ("evicts once per prompt-context
change rather than once per updater call"), which fails with
`expected "vi.fn()" to be called 1 times, but got 2 times` if the eviction moves back
inside the updater.

## Known gaps

- **DeepSeek Harness assistant text — FIXED LOCALLY in `packages/dsh-runtime` (fork patch).**
  Upstream maps dsh's `assistant/chunk` event with `chunk.type === 'text-delta'` to its `text`
  frame, and fills the `result` frame's `output` from those same deltas. dsh **0.1.5-rc.1**
  instead settles each attempt as a single `assistant/message` carrying the completed blocks
  (`message.content`) and emits **no** deltas on its live session stream — that older
  vocabulary now survives only in `dsh-session-format-v0-to-v1` migration code. Every run
  therefore wrote its artifacts correctly (the model genuinely worked and billed tokens) but
  landed as `failed` / `empty_output`, because neither the chat stream nor the result frame
  ever carried text.
  Our patch accumulates delta text per attempt and, when an attempt streamed none, replays
  that message's own text, so exactly one source contributes and nothing is doubled.
  Verified: raw stdio goes from `ready → session → usage → result` (no text) to also emitting
  `text` plus a populated `result.output`, and a Mishh Mashh run goes from
  `failed / empty_output` to `succeeded` with `text_delta` events.
  **Do not "fix" this by pinning an older dsh:** `0.1.2-rc.1` — the newest version Mishh Mashh
  lists as tested — has no knowledge of `deepseek-flash` (DeepSeek-V41-Flash) at all, and the
  adapter sets `supportsCustomModel: false`, so V4.1 Flash would become unselectable. Re-check
  this patch whenever a cherry-pick touches `packages/dsh-runtime`; upstream is not expected
  to carry it (`upstream/main` at `ad9078b87` still has the old behaviour).
- `node-pty` and the ffmpeg/ffprobe installer packages are deliberately absent from
  `onlyBuiltDependencies`, so their build scripts do not run and the daemon's terminal PTY
  degrades to `NODE_PTY_UNAVAILABLE` (handled gracefully). This is upstream's own choice —
  do not "fix" it locally or every upstream sync will fight it.

## Cherry-pick log

| Date | Upstream commit(s) | What | Why |
|---|---|---|---|
| 2026-09-12 | — | Initial pin at `73953213a` (`open-design-v0.22.2`) | Fresh base for Mishh-Mashh 2 |
| 2026-09-22 | `ad9078b87c` | fix(chat): keep footer actions and time visible in narrow panes (#8001) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `ab009b1a30` | fix(chat): preserve ranges for repeated file reads (#8019) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `712b0db974` | fix(prompts): write next-step suggestions in the run's UI locale (#7920) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `5f814a5cd0` | fix(chat): wait for pending clarification before continuing todos (#7989) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `246ec7d06d` | fix(chat): resolve folded strategy retries to their failed run (#7981) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `6734dbba2e` | fix(chat): restore persisted strategy task blocked fields in conversation history (#7967) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `7fa06a408b` | fix(diagnostics): retain bounded environment evidence for workspace failures (#7951) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `d54f5cf07d` | fix(observability): add canonical client monitoring kinds (#7945) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `f197844e27` | fix(chat): keep each folded run's own clock (#7921) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `9f73dcebf3` | fix(chat): make the run-failure card's retry tell the truth about the send gate (#7927) | Upstream bug fix; triage 2026-09-22 |
| 2026-09-22 | `4e460eae41` `00c12c6451` `8be9b0fcaf` `f95b9a6eef` `a10e4671bd` | Already present on main (empty cherry-pick) | Recorded so the next triage skips them |
| 2026-09-22 | — | Deferred: 9 conflicting fixes (`933dc96038` `6801f25c06` `98f2fd1a46` `4de36a0f79` `a3da5e06c8` `9c5ee3c915` `be0887b392` `53a47bf910` `bb9682a5f9`); skipped `eb7fbd8175` (AMR only) and upstream release/branding commits | Triage 2026-09-22 |
| 2026-09-23 | `a3da5e06c8` | fix(chat): automatically retry transient conversation reads (#7954) | Deferred-batch conflict triage; applied cleanly once resolved standalone (zero conflicts) |
| 2026-09-23 | `4de36a0f79` | fix(chat): retain readable history during workspace scope confirmation (#7955) | Deferred-batch conflict triage; depends on `a3da5e06c8` landing first (upstream #7955 was authored on top of #7954) — applied cleanly once picked in that order |
| 2026-09-23 | `9c5ee3c915` | fix(chat): resume Cloud retries after authority and history settle (#7953) | Deferred-batch conflict triage; applied cleanly once `a3da5e06c8`/`4de36a0f79` landed, no collision with the local `App.tsx` `handleProjectChange` patch |
| 2026-09-23 | `be0887b392` | fix(packaged): wait for updater predecessor before instance discovery (#7970) | Deferred-batch conflict triage; conflict resolved to the HEAD side — main already carries this fix in enriched form (`recordIncomingUpdateLifecycle` wrapping) from an earlier-applied commit, so the resolved tree matched HEAD exactly and no new commit was needed (empty pick) |

**Skipped (2026-09-23 deferred-batch triage):**
- `933dc96038` (stop delivered OD Next turn reporting failed, #7931) — 21 conflicted files (19 i18n locale rebrand collisions + validation logic), over the 15-file cap.
- `6801f25c06` (recognize linked prototype page delivery, #7949) — its own added test ("retains the observed entry when a second page is added...") contradicts a pre-existing, independently-tested main-branch feature (ambiguous-root-html disambiguation-by-touched in `inferredEntry`) for the identical 2-candidate/1-touched input shape; not a mechanical merge, needs a product call on precedence.
- `98f2fd1a46` (hide undesigned cards/aux panels, 74-file UI refactor, #7956) — 24 conflicted files (i18n rebrand collisions plus prompt/UI structure) over the 15-file cap, per the pre-decided default.
- `53a47bf910` (stamp platform metadata on telemetry, #7944) — adds new fields (`osName`, `clientType`) to the outbound safety-telemetry event payload; skipped per the never-re-enable/never-expand-telemetry rule.
- `bb9682a5f9` (make OD Next default route, #7876) — default-behavior change with a 41-file diff removing the rollout-switch machinery; needs an explicit product call, per the pre-decided default.
