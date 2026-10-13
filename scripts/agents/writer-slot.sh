#!/bin/sh
# writer-slot: cap how many checkouts of this repository agents write in at once.
#
#   sh scripts/agents/writer-slot.sh run [--agent <name>] -- <command> [args]   hold a slot while <command> runs
#   sh scripts/agents/writer-slot.sh claim [--agent <name>] [--pid <pid>] [--worktree <dir>]
#   sh scripts/agents/writer-slot.sh release [--worktree <dir>]
#   sh scripts/agents/writer-slot.sh status
#   sh scripts/agents/writer-slot.sh hook-pre | hook-bash | hook-end   (Claude Code hooks; JSON on stdin)
#
# A writer is one agent session editing one checkout (the main checkout or a linked
# worktree). Each checkout has at most one writer, and at most MISH_MAX_WRITERS checkouts of
# a clone have one at a time (default 2, never more than 3). Slots live in the git common
# directory, so every worktree of the clone sees them.
#
# A slot belongs to its owner process (the Claude Code or Codex process, or the command under
# `run`) and frees itself when that process exits, so a crashed session never holds one. A
# slot without a known owner process expires after MISH_WRITER_TTL_MIN minutes without a
# claim (default 240).
#
# Why this is a shell script and not TypeScript: it runs before every edit and every writing
# shell command, so it must start in milliseconds and work before the workspace is installed.
#
# Exit: 0 ok · 2 refused (hooks; blocks the tool call) · 3 refused (claim/run) · 64 usage

set -u

MAX="${MISH_MAX_WRITERS:-2}"
case "$MAX" in ''|*[!0-9]*) MAX=2 ;; esac
[ "$MAX" -lt 1 ] && MAX=1
[ "$MAX" -gt 3 ] && MAX=3
TTL_MIN="${MISH_WRITER_TTL_MIN:-240}"
case "$TTL_MIN" in ''|*[!0-9]*) TTL_MIN=240 ;; esac
SELF_DIR=$(cd "$(dirname "$0")" && pwd)

usage() {
  sed -n '3,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}

common_dir_of() { git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null; }

# Top-level directory of the checkout that contains $1, which may not exist yet.
toplevel_of() {
  p="$1"
  while [ -n "$p" ] && [ "$p" != "/" ] && [ ! -d "$p" ]; do p=$(dirname "$p"); done
  git -C "$p" rev-parse --show-toplevel 2>/dev/null
}

slot_path() { printf '%s/%s.slot' "$DIR" "$(printf '%s' "$1" | cksum | cut -d' ' -f1)"; }
mtime() { date -r "$1" +%s 2>/dev/null || echo 0; }
pid_start() { ps -o lstart= -p "$1" 2>/dev/null | sed 's/^ *//'; }
field() { sed -n "s/^$1=//p" "$2" | head -n 1; }

# Nearest ancestor of this script that is an agent process (claude, codex, hermes); empty if none.
agent_pid() {
  p=$PPID
  i=0
  while [ "$i" -lt 12 ] && [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    case "$(ps -o args= -p "$p" 2>/dev/null)" in
      *claude*|*codex*|*hermes*) echo "$p"; return ;;
    esac
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
}

# Fields of the hook JSON on stdin, one per line: session, file path, cwd, bash command.
json_fields() {
  node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let j = {};
      try { j = JSON.parse(s); } catch {}
      const t = j.tool_input || {};
      const one = (v) => String(v || "").replace(/\s+/g, " ");
      process.stdout.write([j.session_id, t.file_path || t.notebook_path, j.cwd, t.command].map(one).join("\n") + "\n");
    });'
}

lock() {
  i=0
  until mkdir "$DIR/.lock" 2>/dev/null; do
    i=$((i + 1))
    # A lock older than 10 s belongs to a killed process; rmdir is atomic, so only one waiter wins.
    if [ $(( $(date +%s) - $(mtime "$DIR/.lock") )) -gt 10 ]; then rmdir "$DIR/.lock" 2>/dev/null; fi
    [ "$i" -gt 200 ] && return 1
    sleep 0.05
  done
  trap 'rmdir "$DIR/.lock" 2>/dev/null' EXIT INT TERM
}

unlock() { rmdir "$DIR/.lock" 2>/dev/null; trap - EXIT INT TERM; }

slot_live() {
  pid=$(field pid "$1")
  if [ -n "$pid" ]; then
    [ "$(pid_start "$pid")" = "$(field pid_start "$1")" ]
  else
    [ $(( $(date +%s) - $(mtime "$1") )) -lt $((TTL_MIN * 60)) ]
  fi
}

reap() {
  for f in "$DIR"/*.slot; do
    [ -e "$f" ] || continue
    slot_live "$f" || rm -f "$f"
  done
}

count_slots() {
  n=0
  for f in "$DIR"/*.slot; do [ -e "$f" ] && n=$((n + 1)); done
  echo "$n"
}

describe_slots() {
  now=$(date +%s)
  for f in "$DIR"/*.slot; do
    [ -e "$f" ] || continue
    printf '  - %s (agent %s, pid %s, last claim %s min ago)\n' "$(field worktree "$f")" \
      "$(field agent "$f")" "$(field pid "$f")" "$(( (now - $(mtime "$f")) / 60 ))"
  done
}

write_slot() {
  tmp="$1.tmp.$$"
  printf 'worktree=%s\nsession=%s\nagent=%s\npid=%s\npid_start=%s\n' \
    "$2" "$3" "$4" "$5" "$( [ -n "$5" ] && pid_start "$5")" > "$tmp" && mv "$tmp" "$1"
}

# claim <worktree> <session> <agent> <owner pid>
# Returns 0 when held, 3 when every slot is taken, 4 when another writer owns this checkout.
claim() {
  slot=$(slot_path "$1")
  lock || return 0  # never block work because the lock is unavailable
  reap
  if [ -e "$slot" ]; then
    if [ "$(field session "$slot")" = "$2" ]; then
      touch "$slot"; unlock; return 0
    fi
    unlock; return 4
  fi
  if [ "$(count_slots)" -ge "$MAX" ]; then unlock; return 3; fi
  write_slot "$slot" "$1" "$2" "$3" "$4"
  unlock
  return 0
}

refusal() {
  if [ "$1" = 4 ]; then
    printf 'Another agent session is the writer for %s:\n' "$2"
    describe_slots | grep -F "$2 ("
    printf '%s\n' "Use your own worktree, or wait for that session to end."
  else
    printf 'Writer limit reached: %s of %s checkouts of this repository have an active writer.\n' "$(count_slots)" "$MAX"
    describe_slots
    printf '%s\n' "Do not work around this. Wait for a writer to finish, or offload the work to the Mac mini" \
      "(docs/agents/local-resources.md). Slots free when their owner process exits."
  fi
}

# Handles a hook: claim for the checkout that contains $target, or allow when it is not ours.
hook_claim() {
  target="$1"; session="$2"
  [ -n "$target" ] || exit 0
  WT=$(toplevel_of "$target")
  [ -n "$WT" ] || exit 0
  [ "$(common_dir_of "$WT")" = "$(common_dir_of "$SELF_DIR")" ] || exit 0
  DIR="$(common_dir_of "$WT")/mish-writers"
  mkdir -p "$DIR" || exit 0
  claim "$WT" "$session" "claude" "$(agent_pid)"
  rc=$?
  [ "$rc" = 0 ] && exit 0
  refusal "$rc" "$WT" >&2
  exit 2
}

cmd="${1:-}"; [ -n "$cmd" ] && shift

case "$cmd" in
  hook-pre)
    fields=$(json_fields)
    target=$(printf '%s\n' "$fields" | sed -n 2p)
    cwd=$(printf '%s\n' "$fields" | sed -n 3p)
    case "$target" in ''|/*) ;; *) target="$cwd/$target" ;; esac
    hook_claim "$target" "$(printf '%s\n' "$fields" | sed -n 1p)"
    ;;
  hook-bash)
    payload=$(cat)
    # Cheap pre-filter: only commands that change files or git state need a slot.
    printf '%s' "$payload" | grep -Eq 'git (commit|merge|rebase|cherry-pick|revert|apply|am|checkout|switch|reset|restore|stash|rm|mv)|sed -i|perl -[a-z]*i|tee |cat >|> *[A-Za-z.]|pnpm (install|add|remove|i )|npm (install|i )|(^|[;&| "])(mv|cp|rm|mkdir|touch|patch) ' || exit 0
    fields=$(printf '%s' "$payload" | json_fields)
    hook_claim "$(printf '%s\n' "$fields" | sed -n 3p)" "$(printf '%s\n' "$fields" | sed -n 1p)"
    ;;
  hook-end)
    session=$(json_fields | sed -n 1p)
    DIR="$(common_dir_of "$SELF_DIR")/mish-writers"
    [ -d "$DIR" ] && [ -n "$session" ] || exit 0
    lock || exit 0
    for f in "$DIR"/*.slot; do
      [ -e "$f" ] && [ "$(field session "$f")" = "$session" ] && rm -f "$f"
    done
    unlock
    exit 0
    ;;
esac

WT=""; AGENT="${MISH_AGENT_NAME:-manual}"; PID=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree) WT="${2:-}"; shift 2 ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    --pid) PID="${2:-}"; shift 2 ;;
    --) shift; break ;;
    *) usage ;;
  esac
done
[ -n "$WT" ] || WT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "writer-slot: run inside a checkout" >&2; exit 64; }
WT=$(cd "$WT" && pwd -P)
DIR="$(common_dir_of "$WT")/mish-writers"
mkdir -p "$DIR"

case "$cmd" in
  run)
    [ "$#" -gt 0 ] || usage
    # The slot's owner is this process; exec keeps the pid, so the slot lives exactly as long
    # as the command.
    claim "$WT" "run-$$" "$AGENT" "$$"
    rc=$?
    [ "$rc" = 0 ] || { refusal "$rc" "$WT" >&2; exit 3; }
    exec "$@"
    ;;
  claim)
    [ -n "$PID" ] || PID=$(agent_pid)
    session="${CLAUDE_SESSION_ID:-pid-${PID:-none}}"
    claim "$WT" "$session" "$AGENT" "$PID"
    rc=$?
    [ "$rc" = 0 ] && { echo "writer slot held: $WT (owner pid ${PID:-none})"; exit 0; }
    refusal "$rc" "$WT" >&2
    exit 3
    ;;
  release)
    lock || true
    rm -f "$(slot_path "$WT")"
    unlock
    echo "writer slot released: $WT"
    ;;
  status)
    lock && { reap; unlock; }
    printf 'Writers: %s of %s\n' "$(count_slots)" "$MAX"
    describe_slots
    ;;
  *) usage ;;
esac
