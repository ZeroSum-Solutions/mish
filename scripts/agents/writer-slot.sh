#!/bin/sh
# writer-slot: cap how many checkouts of this repository agents write in at once.
#
#   sh scripts/agents/writer-slot.sh run [--agent <name>] -- <command> [args]   hold a slot while <command> runs
#   sh scripts/agents/writer-slot.sh claim [--agent <name>] [--pid <pid>] [--worktree <dir>]
#   sh scripts/agents/writer-slot.sh release [--worktree <dir>] [--force]
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
# Exit: 0 ok · 2 refused (hooks; blocks the tool call) · 3 refused (claim/run/release) · 64 usage

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

# True when process $1 is an agent: its executable, or the script a runtime runs, is named
# claude, codex or hermes. Only the first two words count, so a shell whose arguments merely
# mention an agent is not one.
is_agent() {
  set -- $(ps -o args= -p "$1" 2>/dev/null)
  for w in "${1:-}" "${2:-}"; do
    case "${w##*/}" in claude|codex|hermes) return 0 ;; esac
  done
  return 1
}

# This process and its ancestors, nearest first (at most 16).
ancestors() {
  echo $$
  p=$PPID
  i=0
  while [ "$i" -lt 16 ] && [ -n "$p" ] && [ "$p" -gt 1 ] 2>/dev/null; do
    echo "$p"
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ')
    i=$((i + 1))
  done
}

# Nearest ancestor that is an agent process; empty if none.
agent_pid() {
  for p in $(ancestors | sed 1d); do is_agent "$p" && { echo "$p"; return; }; done
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

# with_lock <command…>: run <command> holding an exclusive kernel lock (flock) on the registry.
# The kernel drops the lock when its holder exits, however it exits, so a killed process can
# never leave the registry locked. Gives up after 3 s (exit 75); holds last milliseconds.
with_lock() {
  perl -MFcntl=:flock -e '
    BEGIN { $^F = 255 }  # keep the lock descriptor open across exec
    my $file = shift;
    open(my $fh, ">>", $file) or exit 75;
    my $deadline = time + 3;
    until (flock($fh, LOCK_EX | LOCK_NB)) {
      exit 75 if time > $deadline;
      select(undef, undef, undef, 0.05);
    }
    exec { $ARGV[0] } @ARGV or exit 75;' "$DIR/registry.lock" "$@"
}

slot_live() {
  pid=$(field pid "$1")
  start=$(field pid_start "$1")
  if [ -n "$pid" ] && [ -n "$start" ]; then
    [ "$(pid_start "$pid")" = "$start" ]
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

# A pid is stored only with its start-time fingerprint; without one the slot uses the TTL.
write_slot() {
  tmp="$1.tmp.$$"
  start=""; [ -n "$5" ] && start=$(pid_start "$5")
  pid="$5"; [ -n "$start" ] || pid=""
  printf 'worktree=%s\nsession=%s\nagent=%s\npid=%s\npid_start=%s\n' \
    "$2" "$3" "$4" "$pid" "$start" > "$tmp" && mv "$tmp" "$1"
}

# True when slot $1 was taken by `run` and its live owner process is this process or an
# ancestor: a hook running under a `run`-wrapped agent belongs to the wrapper's slot.
owned_by_ancestor() {
  case "$(field session "$1")" in run-*) ;; *) return 1 ;; esac
  pid=$(field pid "$1")
  [ -n "$pid" ] && slot_live "$1" && ancestors | grep -qx "$pid"
}

# claim <worktree> <session> <agent> <owner pid>
# Returns 0 when held, 3 when every slot is taken, 4 when another writer owns this checkout,
# 5 when the registry could not be locked or written.
claim() {
  export DIR
  with_lock sh "$0" __claim "$@"
  rc=$?
  case "$rc" in 0|3|4) return "$rc" ;; *) return 5 ;; esac
}

refusal() {
  if [ "$1" = 5 ]; then
    printf 'Could not register a writer slot for %s: the registry in %s is locked or not writable.\n' "$2" "$DIR"
    printf '%s\n' "Another process has held the registry lock for over 3 s, or the directory is not writable."
  elif [ "$1" = 4 ]; then
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
  rc=5
  mkdir -p "$DIR" && { claim "$WT" "$session" "claude" "$(agent_pid)"; rc=$?; }
  [ "$rc" = 0 ] && exit 0
  refusal "$rc" "$WT" >&2
  exit 2
}

cmd="${1:-}"; [ -n "$cmd" ] && shift

# Internal steps that run under with_lock in a child process; DIR comes from the environment.
case "$cmd" in
  __claim)
    slot=$(slot_path "$1")
    reap
    if [ -e "$slot" ]; then
      if [ "$(field session "$slot")" = "$2" ] || owned_by_ancestor "$slot"; then
        touch "$slot"; exit 0
      fi
      exit 4
    fi
    [ "$(count_slots)" -ge "$MAX" ] && exit 3
    write_slot "$slot" "$1" "$2" "$3" "$4" && [ "$(field session "$slot")" = "$2" ] || exit 5
    exit 0
    ;;
  __release)  # <worktree> <my session> <force>
    slot=$(slot_path "$1")
    if [ -e "$slot" ] && [ "$3" = 0 ] && slot_live "$slot" && [ "$(field session "$slot")" != "$2" ] && ! owned_by_ancestor "$slot"; then
      printf 'writer slot for %s belongs to a live session (%s); not releasing. Use --force only if that session is gone.\n' "$1" "$(field session "$slot")" >&2
      exit 3
    fi
    rm -f "$slot"
    exit 0
    ;;
  __end)  # <session>
    for f in "$DIR"/*.slot; do
      [ -e "$f" ] && [ "$(field session "$f")" = "$1" ] && rm -f "$f"
    done
    exit 0
    ;;
  __reap) reap; exit 0 ;;
esac

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
    printf '%s' "$payload" | grep -Eq 'git (-C [^;&|]+ )?(commit|merge|rebase|cherry-pick|revert|apply|am|checkout|switch|reset|restore|stash|rm|mv|pull)|sed -i|perl -[a-z]*i|tee |cat >|>>? *[A-Za-z0-9./~$"'"'"'\\]|pnpm (install|add|remove|update|i)([ ";&|]|$)|npm (install|ci|i)([ ";&|]|$)|(^|[;&| "])(mv|cp|rm|mkdir|touch|patch|ln|install) ' || exit 0
    fields=$(printf '%s' "$payload" | json_fields)
    hook_claim "$(printf '%s\n' "$fields" | sed -n 3p)" "$(printf '%s\n' "$fields" | sed -n 1p)"
    ;;
  hook-end)
    session=$(json_fields | sed -n 1p)
    DIR="$(common_dir_of "$SELF_DIR")/mish-writers"
    [ -d "$DIR" ] && [ -n "$session" ] || exit 0
    export DIR
    with_lock sh "$0" __end "$session"
    exit 0
    ;;
esac

WT=""; AGENT="${MISH_AGENT_NAME:-manual}"; PID=""; FORCE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree) WT="${2:-}"; shift 2 ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    --pid) PID="${2:-}"; shift 2 ;;
    --force) FORCE=1; shift ;;
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
    [ -n "$PID" ] || PID=$(agent_pid)
    export DIR
    with_lock sh "$0" __release "$WT" "${CLAUDE_SESSION_ID:-pid-${PID:-none}}" "$FORCE"
    rc=$?
    [ "$rc" = 75 ] && { refusal 5 "$WT" >&2; exit 3; }
    [ "$rc" = 0 ] || exit 3
    echo "writer slot released: $WT"
    ;;
  status)
    export DIR
    with_lock sh "$0" __reap
    printf 'Writers: %s of %s\n' "$(count_slots)" "$MAX"
    describe_slots
    ;;
  *) usage ;;
esac
