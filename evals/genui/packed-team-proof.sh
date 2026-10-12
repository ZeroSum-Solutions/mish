#!/usr/bin/env bash
# packed-team-proof.sh — criterion C15: prove a fresh clone of one commit can install, build,
# run the daemon headless, drive the agency-build CLI, and serve the web app, all outside the
# working repo (no worktree, no shared node_modules, no shared .od state).
#
# ---------------------------------------------------------------------------------------------
# What this script found in the daemon source (2026-09-23), and why it is built the way it is:
#
# - Daemon CLI entry: `apps/daemon/bin/od.mjs` imports `apps/daemon/dist/cli.js` and THROWS if
#   that dist file is missing, telling the caller to run `pnpm bootstrap` or
#   `pnpm --filter @mish/daemon build` first. So the daemon package must be BUILT (not
#   just installed) before `od.mjs` can run at all.
#
# - Minimal build chain: `apps/daemon/package.json`'s own `pretest` script is
#     pnpm --filter '@mish/daemon^...' --workspace-concurrency=4 --if-present run build
#   (`^...` = the daemon's workspace dependencies, not the daemon itself — pretest exists because
#   the daemon's OWN tests run against source via `tsx`/vitest, not its dist). We need the
#   daemon's OWN dist too (see above), so this script drops the `^` and runs
#     pnpm --filter '@mish/daemon...' run build
#   which builds the daemon AND everything it depends on — `@mish/contracts`,
#   `@mish/registry-protocol`, `@mish/agency-fast-lane`, `@mish/platform`,
#   `@mish/sidecar`, etc. — each via its own `build` script, in dependency order. This is
#   the same pnpm `--filter <pkg>...` idiom the repo's own scripts use (see also the root
#   `package.json` `typecheck` script), not a bespoke chain — deliberately, since a bespoke list
#   of "build these N packages in this order" rots the moment a new shared package is added.
#
# - The web root: `apps/daemon/src/server.ts`'s `STATIC_DIR` is `apps/web/out`, and the daemon
#   serves it with `express.static(staticDir)` ONLY `if (fs.existsSync(staticDir))` — i.e. no
#   web build, no web root, and this script's final HTTP check would see a 404 rather than a
#   packaging bug. `apps/web/next.config.ts` computes `shouldStaticExport = isProd &&
#   !isServerOutput`; `next build` sets `NODE_ENV=production` itself, and no
#   `OD_WEB_OUTPUT_MODE` is set here, so a plain `next build` in `apps/web` is a static export to
#   `out/` — exactly what the daemon looks for. So this script ALSO runs
#     pnpm --filter '@mish/web...' run build
#   (folded into the one pnpm invocation below via a second `--filter`, which pnpm unions with
#   the first rather than running the build twice for shared deps).
#
# - Isolation env vars: `apps/daemon/src/app-config.ts`'s `appConfigDir()` and
#   `apps/daemon/src/server.ts`'s `RUNTIME_DATA_DIR` both key off `OD_DATA_DIR` (falls back to
#   `<projectRoot>/.od`) — this is what isolates the SQLite DB, the plugin cache, and project
#   files. `apps/daemon/src/deploy.ts`'s `deployConfigPath()` keys off `OD_USER_STATE_DIR`
#   (falls back to `~/.mish`) — deploy-provider tokens live there; unused by this proof
#   but pointed at the temp clone anyway so nothing here can touch `~/.mish` on this
#   machine. Port: `apps/daemon/src/cli.ts`'s `runDaemonStart` reads `--port` then `OD_PORT`
#   then 7456; host similarly via `OD_BIND_HOST` (default 127.0.0.1).
#
# - Headless start: `od daemon start --headless --port <n>` (`apps/daemon/src/cli.ts`,
#   `runDaemonStart`) runs the daemon IN THE FOREGROUND until SIGINT/SIGTERM, which then awaits
#   `runtime.stop()` before the process exits — so this script backgrounds it (`&`), waits for
#   `GET /api/health` (`apps/daemon/src/server.ts`, registered unconditionally) to answer, and
#   later sends SIGTERM and waits for the process to exit on its own before SIGKILL.
#
# - `od catalog list --json`: added by the GenUI catalog milestone (M2). The step is REQUIRED by
#   default (`--require-catalog`), so a commit that claims the catalog cannot pass without it.
#   Pass `--no-require-catalog` only to prove a commit that predates the catalog; the step then
#   runs informationally and its exit code does not change PASS/FAIL.
#
# - `od agency build`: a thin HTTP client over `POST /api/agency/build` on whatever
#   `--daemon-url` names (`apps/daemon/src/cli.ts`, `runAgencyBuild` / `agency-build-cli.ts`) —
#   it does NOT run the fast lane in-process, so `--daemon-url` must point at the daemon this
#   script just started. It takes no `--provider`/`--model` flags; the daemon defaults the
#   provider per family (`defaultModelFor` in `apps/daemon/src/routes/agency-build.ts`). Passing
#   an explicit `--family` (rather than `auto`) skips Jev routing entirely, and `--verify off`
#   skips the Jev credential preflight too (`packages/agency-fast-lane/src/build.ts`:
#   `if (input.verify !== 'off') { ... preflightJevCredential ... }`) — so this one build needs
#   only a model-provider credential, not a TypeSafe/Jev key, matching the task's instruction to
#   supply only `DEEPSEEK_API_KEY`.
#
# - Where that credential is read: since the portable-keys milestone (M1) the daemon resolves
#   the model key from its environment (`DEEPSEEK_API_KEY`) first, then its stored agency config,
#   then the machine vault (`zsvault get deepseek_api_key`) when one is installed. This script
#   takes an exported DEEPSEEK_API_KEY first and falls back to `zsvault get deepseek_api_key`.
#   A key read from zsvault is exported ONLY inside the daemon's own subshell (a key the caller
#   already exported is inherited by every child, as usual). The daemon is started with a
#   plain `exec node …`, so the value never appears in any process's argv or in the log, and a
#   vault-sourced value never reaches the CLI's environment.
# ---------------------------------------------------------------------------------------------
#
# Usage:
#   packed-team-proof.sh --sha <commit> [--repo <path>] [--out <path>] [--keep] [--verbose]
#                        [--no-require-catalog]
#
# --repo defaults to this script's own repo (found via `git rev-parse --show-toplevel`, walking
#   up from the script's own directory) once it is copied into the repo tree; pass --repo
#   explicitly when running it from anywhere else (e.g. straight from the scratchpad it was
#   drafted in).
# --sha defaults to --repo's current HEAD when omitted.
# --out is the proof log's directory (default: a fresh `mktemp -d`, printed at the end).
# --keep skips deleting the temp clone on exit (the daemon is still always stopped).
# --require-catalog (default) makes `od catalog list --json` a required step;
#   --no-require-catalog makes it informational (for commits that predate the catalog).
#
# Exit 0: every REQUIRED step passed (clone, checkout, install, build, daemon health, catalog
#   listing unless --no-require-catalog, one agency build reaching `done`, web root served).
#   Exit 1: a required step failed. Exit 2: usage error.
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

REPO=""
SHA=""
OUT_DIR=""
KEEP=0
VERBOSE=0
REQUIRE_CATALOG=1

usage() {
  cat >&2 <<'EOF'
Usage: packed-team-proof.sh --sha <commit> [--repo <path>] [--out <path>] [--keep] [--verbose]
                            [--require-catalog | --no-require-catalog]
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --sha) SHA="$2"; shift 2 ;;
    --repo) REPO="$2"; shift 2 ;;
    --out) OUT_DIR="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    --require-catalog) REQUIRE_CATALOG=1; shift ;;
    --no-require-catalog) REQUIRE_CATALOG=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage; exit 2 ;;
  esac
done

if [ -z "$REPO" ]; then
  REPO="$(cd "$SCRIPT_DIR" && git rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -z "$REPO" ]; then
    echo "error: --repo not given and this script's directory is not inside a git repo (pass --repo explicitly)" >&2
    exit 2
  fi
fi
if [ ! -d "$REPO/.git" ] && ! git -C "$REPO" rev-parse --git-dir >/dev/null 2>&1; then
  echo "error: --repo does not look like a git repository: $REPO" >&2
  exit 2
fi

if [ -z "$SHA" ]; then
  SHA="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
  if [ -z "$SHA" ]; then
    echo "error: --sha not given and \`git -C '$REPO' rev-parse HEAD\` failed" >&2
    exit 2
  fi
fi
if ! git -C "$REPO" cat-file -e "${SHA}^{commit}" 2>/dev/null; then
  echo "error: $SHA is not a commit reachable in $REPO" >&2
  exit 2
fi

if [ -z "$OUT_DIR" ]; then
  OUT_DIR="$(mktemp -d "${TMPDIR:-/tmp}/packed-team-proof.XXXXXX")"
else
  mkdir -p "$OUT_DIR"
fi
LOG_FILE="$OUT_DIR/proof.log"
LOGS_DIR="$OUT_DIR/logs"
mkdir -p "$LOGS_DIR"
: > "$LOG_FILE"

CLONE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/packed-team-clone.XXXXXX")"

REQUIRED_FAILED=0
STEP_N=0

log() {
  echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*" | tee -a "$LOG_FILE"
}

# Runs one step, logs its command + exit code + where its full output landed, and — unless
# called with `--optional` as the first argument — marks the whole proof FAILED (but keeps
# going) when the command exits non-zero. Never logs argv verbatim when it might carry a
# secret; callers pass a `--label` instead for anything that touches DEEPSEEK_API_KEY.
run_step() {
  local optional=0
  if [ "$1" = "--optional" ]; then optional=1; shift; fi
  local label="$1"; shift
  STEP_N=$((STEP_N + 1))
  local step_log="$LOGS_DIR/$(printf '%02d' "$STEP_N")-$(echo "$label" | tr -c 'a-zA-Z0-9' '-' | tr -s '-').log"
  log "STEP $STEP_N: $label"
  log "  cmd: $*"
  local start_ms end_ms
  start_ms=$(($(date +%s%N) / 1000000))
  if [ "$VERBOSE" = "1" ]; then
    "$@" > >(tee "$step_log") 2> >(tee -a "$step_log" >&2)
    local code=$?
  else
    "$@" > "$step_log" 2>&1
    local code=$?
  fi
  end_ms=$(($(date +%s%N) / 1000000))
  log "  exit: $code (${label}) — $((end_ms - start_ms))ms — full output: $step_log"
  if [ "$code" -ne 0 ]; then
    log "  --- last 20 lines of $step_log ---"
    tail -n 20 "$step_log" | while IFS= read -r line; do log "  | $line"; done
    if [ "$optional" = "1" ]; then
      log "  (optional step — proof continues, exit code not gating)"
    else
      REQUIRED_FAILED=1
      log "  REQUIRED STEP FAILED"
    fi
  fi
  return "$code"
}

DAEMON_PID=""
cleanup() {
  if [ -n "$DAEMON_PID" ] && kill -0 "$DAEMON_PID" 2>/dev/null; then
    log "cleanup: sending SIGTERM to daemon pid $DAEMON_PID"
    kill -TERM "$DAEMON_PID" 2>/dev/null || true
    for _ in $(seq 1 15); do
      kill -0 "$DAEMON_PID" 2>/dev/null || break
      sleep 1
    done
    if kill -0 "$DAEMON_PID" 2>/dev/null; then
      log "cleanup: daemon pid $DAEMON_PID did not exit within 15s of SIGTERM, sending SIGKILL"
      kill -KILL "$DAEMON_PID" 2>/dev/null || true
    else
      log "cleanup: daemon pid $DAEMON_PID exited cleanly"
    fi
  fi
  if [ "$KEEP" = "1" ]; then
    log "cleanup: --keep set, leaving clone at $CLONE_DIR"
  else
    log "cleanup: removing $CLONE_DIR"
    rm -rf "$CLONE_DIR"
  fi
}
trap cleanup EXIT INT TERM

log "packed-team-proof: repo=$REPO sha=$SHA clone=$CLONE_DIR out=$OUT_DIR"

if ! command -v mise >/dev/null 2>&1; then
  log "FATAL: mise is not on PATH — this repo pins node/pnpm via mise.toml (node 24, pnpm 10.33.2) and this script relies on \`mise exec --\` to use exactly those versions"
  REQUIRED_FAILED=1
fi

# ---- 1. Fresh clone + checkout ---------------------------------------------------------------
# A `git clone --depth 1` only clones a BRANCH tip, not an arbitrary commit SHA (there is no ref
# name to give `--branch`) — the task brief's own documented fallback is used instead: a full
# clone over the local `file://` transport (cheap — same disk, no network) followed by an
# explicit checkout of the SHA. This also sidesteps guessing which branch (if any) still
# contains the SHA.
if [ "$REQUIRED_FAILED" = "0" ]; then
  run_step "git clone (file:// transport, full history)" git clone --no-hardlinks "file://$REPO" "$CLONE_DIR"
fi
if [ "$REQUIRED_FAILED" = "0" ]; then
  run_step "git checkout $SHA" git -C "$CLONE_DIR" checkout --detach "$SHA"
fi

# ---- 2. Install -------------------------------------------------------------------------------
if [ "$REQUIRED_FAILED" = "0" ]; then
  if ! run_step --optional "pnpm install --frozen-lockfile --offline" \
      mise exec -C "$CLONE_DIR" -- pnpm install --frozen-lockfile --offline; then
    log "offline install failed — falling back to online install (packages not yet in the local pnpm store, e.g. after a lockfile change)"
    run_step "pnpm install --frozen-lockfile (online fallback)" \
      mise exec -C "$CLONE_DIR" -- pnpm install --frozen-lockfile
  fi
fi

# ---- 3. Build what the daemon (+ the web root it serves) needs ------------------------------
# See the header comment: this is `@mish/daemon`'s own `pretest` filter pattern, widened
# to include the daemon's own build (needed for `dist/cli.js` to exist) and unioned with
# `@mish/web` (needed for `apps/web/out` to exist, so the daemon has a web root to serve).
if [ "$REQUIRED_FAILED" = "0" ]; then
  run_step "pnpm build (daemon + web + their workspace deps)" \
    mise exec -C "$CLONE_DIR" -- pnpm \
      --filter '@mish/daemon...' \
      --filter '@mish/web...' \
      --workspace-concurrency=4 --if-present run build
fi

# ---- 4. Start the daemon headless, isolated, on a free port ---------------------------------
PORT=""
if [ "$REQUIRED_FAILED" = "0" ]; then
  PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close();});")"
  if [ -z "$PORT" ]; then
    log "FATAL: could not allocate a free port"
    REQUIRED_FAILED=1
  fi
fi

DAEMON_URL=""
if [ "$REQUIRED_FAILED" = "0" ]; then
  DAEMON_URL="http://127.0.0.1:$PORT"
  OD_DATA_DIR="$CLONE_DIR/.od-proof-data"
  OD_USER_STATE_DIR="$CLONE_DIR/.mish-proof-state"
  mkdir -p "$OD_DATA_DIR" "$OD_USER_STATE_DIR"

  # An exported DEEPSEEK_API_KEY wins (the daemon resolves env -> stored config -> vault);
  # zsvault is only a fallback for machines that have it.
  DEEPSEEK_KEY="${DEEPSEEK_API_KEY:-}"
  if [ -z "$DEEPSEEK_KEY" ] && command -v zsvault >/dev/null 2>&1; then
    DEEPSEEK_KEY="$(zsvault get deepseek_api_key 2>>"$LOG_FILE")"
  fi
  if [ -z "$DEEPSEEK_KEY" ]; then
    log "WARNING: no DEEPSEEK_API_KEY in the environment and \`zsvault get deepseek_api_key\` returned nothing — the agency build step below will fail closed (MODEL_UNAVAILABLE) unless the daemon can resolve the key itself (e.g. zsvault already configured on PATH for the daemon's own process)"
  fi

  DAEMON_LOG="$LOGS_DIR/daemon-server.log"
  log "STEP $((STEP_N + 1)): start daemon headless on $DAEMON_URL (OD_DATA_DIR=$OD_DATA_DIR)"
  STEP_N=$((STEP_N + 1))
  # Export inside the subshell and exec node with no `env NAME=value` arguments, so the key
  # never lands in any process's argv (visible to `ps`).
  (
    cd "$CLONE_DIR" || exit 1
    export OD_PORT="$PORT" OD_BIND_HOST=127.0.0.1
    export OD_DATA_DIR OD_USER_STATE_DIR
    if [ -n "$DEEPSEEK_KEY" ]; then
      export DEEPSEEK_API_KEY="$DEEPSEEK_KEY"
    fi
    unset DEEPSEEK_KEY
    exec node apps/daemon/bin/od.mjs daemon start --headless --port "$PORT" --host 127.0.0.1
  ) > "$DAEMON_LOG" 2>&1 &
  DAEMON_PID=$!
  unset DEEPSEEK_KEY
  log "  daemon pid: $DAEMON_PID, log: $DAEMON_LOG"

  # ---- 5. Wait for GET /api/health ------------------------------------------------------------
  HEALTHY=0
  for i in $(seq 1 60); do
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
      log "  daemon process exited before becoming healthy (see $DAEMON_LOG)"
      break
    fi
    if curl -sf -m 2 "$DAEMON_URL/api/health" > "$LOGS_DIR/health-check.json" 2>/dev/null; then
      HEALTHY=1
      break
    fi
    sleep 1
  done
  if [ "$HEALTHY" = "1" ]; then
    log "  exit: 0 (daemon became healthy within ${i}s) — $(cat "$LOGS_DIR/health-check.json")"
  else
    log "  exit: 1 (daemon never answered GET /api/health within 60s)"
    REQUIRED_FAILED=1
  fi
fi

# ---- 6. `od catalog list --json` (required unless --no-require-catalog) ------------------------
if [ "$REQUIRED_FAILED" = "0" ]; then
  CATALOG_LIST_CMD=(node "$CLONE_DIR/apps/daemon/bin/od.mjs" catalog list --json --daemon-url "$DAEMON_URL")
  if [ "$REQUIRE_CATALOG" = "1" ]; then
    run_step "od catalog list --json" "${CATALOG_LIST_CMD[@]}"
  else
    run_step --optional "od catalog list --json (--no-require-catalog)" "${CATALOG_LIST_CMD[@]}"
  fi
fi

# ---- 7. One `od agency build` ------------------------------------------------------------------
if [ "$REQUIRED_FAILED" = "0" ]; then
  BRIEF_FILE="$OUT_DIR/proof-brief.txt"
  cat > "$BRIEF_FILE" <<'EOF'
A small neighborhood coffee roaster wants a simple marketing website that shows their story,
their current roast lineup, where to buy the beans locally, and a way to sign up for a mailing
list. Warm, small-batch, craft feel.
EOF
  # `--family marketing-site` (a real bundled family — `plugins/_official/examples/agency-
  # marketing-site`) skips Jev routing; `--verify off` skips the Jev credential preflight too —
  # see the header comment on why this needs only DEEPSEEK_API_KEY, no TypeSafe key.
  BUILD_LOG="$LOGS_DIR/agency-build.json"
  STEP_N=$((STEP_N + 1))
  log "STEP $STEP_N: od agency build --family marketing-site --verify off --prompt-file $BRIEF_FILE"
  node "$CLONE_DIR/apps/daemon/bin/od.mjs" agency build \
    --family marketing-site --verify off --mode sections \
    --name packed-team-proof --prompt-file "$BRIEF_FILE" \
    --daemon-url "$DAEMON_URL" --json > "$BUILD_LOG" 2>&1
  BUILD_CODE=$?
  log "  exit: $BUILD_CODE — full output: $BUILD_LOG"
  BUILD_STATUS="$(node -e "try{const j=JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'));console.log(j.build?.status ?? j.status ?? '?');}catch{console.log('?');}" "$BUILD_LOG" 2>/dev/null)"
  log "  build status: $BUILD_STATUS"
  # Exit codes per \`od agency build\` help text: 0 done, 3 unrouted, 4 cancelled, 2 usage/no-key/
  # busy, 1 failed. 0 is the only pass for THIS proof (an explicit --family skips routing, so
  # 'unrouted' would itself indicate a bug worth failing on here).
  if [ "$BUILD_CODE" -ne 0 ]; then
    log "  REQUIRED STEP FAILED (od agency build exited $BUILD_CODE, status=$BUILD_STATUS)"
    tail -n 20 "$BUILD_LOG" | while IFS= read -r line; do log "  | $line"; done
    REQUIRED_FAILED=1
  fi
fi

# ---- 8. Fetch the web root over HTTP -----------------------------------------------------------
if [ "$REQUIRED_FAILED" = "0" ]; then
  WEB_CODE="$(curl -s -o "$LOGS_DIR/web-root.html" -w '%{http_code}' -m 10 "$DAEMON_URL/" || echo '000')"
  STEP_N=$((STEP_N + 1))
  log "STEP $STEP_N: GET $DAEMON_URL/ -> HTTP $WEB_CODE (body saved to $LOGS_DIR/web-root.html, $(wc -c < "$LOGS_DIR/web-root.html" 2>/dev/null || echo 0) bytes)"
  if [ "$WEB_CODE" != "200" ]; then
    log "  REQUIRED STEP FAILED (expected 200; apps/web/out may not have built, or express.static's fs.existsSync(staticDir) guard found nothing there)"
    REQUIRED_FAILED=1
  fi
fi

log "----------------------------------------------------------------------"
if [ "$REQUIRED_FAILED" = "0" ]; then
  log "PACKED-TEAM-PROOF: PASS (repo=$REPO sha=$SHA)"
else
  log "PACKED-TEAM-PROOF: FAIL (repo=$REPO sha=$SHA) — see failed steps above"
fi
log "proof log: $LOG_FILE"
echo "$LOG_FILE"

if [ "$REQUIRED_FAILED" = "0" ]; then
  exit 0
else
  exit 1
fi
