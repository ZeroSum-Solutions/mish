#!/bin/sh
# writer-slot: cap how many checkouts of this repository agents write in at once.
#
#   sh scripts/agents/writer-slot.sh claim   [--worktree <dir>] [--session <id>] [--agent <name>]
#   sh scripts/agents/writer-slot.sh release [--worktree <dir>] [--session <id>]
#   sh scripts/agents/writer-slot.sh status
#   sh scripts/agents/writer-slot.sh hook-pre   (Claude Code PreToolUse hook; JSON on stdin)
#   sh scripts/agents/writer-slot.sh hook-end   (Claude Code SessionEnd hook; JSON on stdin)
#
# A writer is a checkout (the main one or a linked worktree) where an agent edits files.
# Several sessions in one checkout count as one writer. Slots live in the git common
# directory, so every worktree of this clone shares them. A slot is refreshed on every
# claim and expires after MISH_WRITER_TTL_MIN minutes without one (default 20), which
# frees slots held by crashed sessions.
#
# MISH_MAX_WRITERS sets the limit (default 2, never more than 3). The Mac mini is extra
# capacity outside this limit: see docs/agents/local-resources.md.
#
# Why this is a shell script and not TypeScript: it runs before every edit, so it must
# start in milliseconds and cannot depend on tsx or an installed workspace.
#
# Exit: 0 ok · 2 limit reached (hook-pre, blocks the edit) · 3 limit reached (claim) · 64 usage

set -u

MAX="${MISH_MAX_WRITERS:-2}"
case "$MAX" in ''|*[!0-9]*) MAX=2 ;; esac
[ "$MAX" -lt 1 ] && MAX=1
[ "$MAX" -gt 3 ] && MAX=3
TTL_MIN="${MISH_WRITER_TTL_MIN:-20}"
case "$TTL_MIN" in ''|*[!0-9]*) TTL_MIN=20 ;; esac

die_usage() {
  sed -n '3,7p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
}

# Absolute git common dir for a path inside a checkout, or empty when outside one.
common_dir_of() {
  git -C "$1" rev-parse --path-format=absolute --git-common-dir 2>/dev/null
}

# Top-level directory of the checkout that contains $1 (which may not exist yet).
toplevel_of() {
  p="$1"
  while [ -n "$p" ] && [ ! -d "$p" ]; do p=$(dirname "$p"); done
  git -C "$p" rev-parse --show-toplevel 2>/dev/null
}

slot_key() {
  printf '%s' "$1" | shasum | cut -c1-16
}

# Reads one string field from the hook JSON on stdin; node is required by the repo anyway.
json_fields() {
  node -e '
    let s = "";
    process.stdin.on("data", (c) => (s += c)).on("end", () => {
      let j = {};
      try { j = JSON.parse(s); } catch {}
      const t = j.tool_input || {};
      const out = [j.session_id || "", t.file_path || t.notebook_path || "", j.cwd || ""];
      process.stdout.write(out.join("\n") + "\n");
    });'
}

lock() {
  i=0
  until mkdir "$DIR/.lock" 2>/dev/null; do
    i=$((i + 1))
    # A lock older than 10 s belongs to a killed process.
    if [ "$i" -gt 50 ] && [ $(( $(date +%s) - $(stat -f %m "$DIR/.lock" 2>/dev/null || date +%s) )) -gt 10 ]; then
      rmdir "$DIR/.lock" 2>/dev/null
    fi
    [ "$i" -gt 200 ] && { echo "writer-slot: could not take $DIR/.lock" >&2; return 1; }
    sleep 0.05
  done
  trap 'rmdir "$DIR/.lock" 2>/dev/null' EXIT INT TERM
}

unlock() {
  rmdir "$DIR/.lock" 2>/dev/null
  trap - EXIT INT TERM
}

reap_stale() {
  find "$DIR" -maxdepth 1 -name '*.slot' -mmin "+$TTL_MIN" -exec rm -f {} + 2>/dev/null
}

field() { sed -n "s/^$1=//p" "$2" | head -n 1; }

describe_slots() {
  now=$(date +%s)
  for f in "$DIR"/*.slot; do
    [ -e "$f" ] || continue
    age=$(( (now - $(stat -f %m "$f")) / 60 ))
    printf '  - %s (agent %s, session %s, last edit %s min ago)\n' \
      "$(field worktree "$f")" "$(field agent "$f")" "$(field session "$f" | cut -c1-8)" "$age"
  done
}

count_slots() {
  n=0
  for f in "$DIR"/*.slot; do [ -e "$f" ] && n=$((n + 1)); done
  echo "$n"
}

# claim <worktree> <session> <agent>; returns 0 when held, 3 when the limit is reached.
claim() {
  wt="$1"; session="$2"; agent="$3"
  slot="$DIR/$(slot_key "$wt").slot"
  lock || return 0  # never block work on a lock failure
  reap_stale
  if [ -e "$slot" ]; then
    # Same checkout: refresh, and record the latest session that edited it.
    printf 'worktree=%s\nsession=%s\nagent=%s\n' "$wt" "$session" "$agent" > "$slot"
    unlock
    return 0
  fi
  if [ "$(count_slots)" -ge "$MAX" ]; then
    unlock
    return 3
  fi
  printf 'worktree=%s\nsession=%s\nagent=%s\n' "$wt" "$session" "$agent" > "$slot"
  unlock
  return 0
}

limit_message() {
  printf 'Writer limit reached: %s of %s checkouts of this repository are being edited.\n' "$(count_slots)" "$MAX"
  describe_slots
  printf '%s\n' \
    "Do not work around this. Choose one:" \
    "  - wait until a writer finishes (slots free on session end or after ${TTL_MIN} min idle);" \
    "  - offload the work to the Mac mini (docs/agents/local-resources.md);" \
    "  - finish here only if a listed slot is your own stale session: sh scripts/agents/writer-slot.sh release --worktree <dir>."
}

cmd="${1:-}"; [ -n "$cmd" ] && shift
WT=""; SESSION="${CLAUDE_SESSION_ID:-manual}"; AGENT="${MISH_AGENT_NAME:-manual}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --worktree) WT="${2:-}"; shift 2 ;;
    --session) SESSION="${2:-}"; shift 2 ;;
    --agent) AGENT="${2:-}"; shift 2 ;;
    *) die_usage ;;
  esac
done

case "$cmd" in
  hook-pre)
    fields=$(json_fields)
    SESSION=$(printf '%s\n' "$fields" | sed -n 1p)
    target=$(printf '%s\n' "$fields" | sed -n 2p)
    cwd=$(printf '%s\n' "$fields" | sed -n 3p)
    [ -n "$target" ] || exit 0
    case "$target" in /*) ;; *) target="$cwd/$target" ;; esac
    WT=$(toplevel_of "$target")
    [ -n "$WT" ] || exit 0
    # Only edits inside a checkout of this repository count.
    DIR="$(common_dir_of "$WT")/mish-writers"
    [ "$(common_dir_of "$WT")" = "$(common_dir_of "$(dirname "$0")")" ] || exit 0
    mkdir -p "$DIR"
    if claim "$WT" "$SESSION" "claude"; then exit 0; fi
    limit_message >&2
    exit 2
    ;;
  hook-end)
    fields=$(json_fields)
    SESSION=$(printf '%s\n' "$fields" | sed -n 1p)
    DIR="$(common_dir_of "$(dirname "$0")")/mish-writers"
    [ -d "$DIR" ] && [ -n "$SESSION" ] || exit 0
    for f in "$DIR"/*.slot; do
      [ -e "$f" ] || continue
      [ "$(field session "$f")" = "$SESSION" ] && rm -f "$f"
    done
    exit 0
    ;;
esac

[ -n "$WT" ] || WT=$(git rev-parse --show-toplevel 2>/dev/null) || { echo "writer-slot: run inside a checkout" >&2; exit 64; }
DIR="$(common_dir_of "$WT")/mish-writers"
mkdir -p "$DIR"

case "$cmd" in
  claim)
    claim "$WT" "$SESSION" "$AGENT" && { echo "writer slot held: $WT"; exit 0; }
    limit_message >&2
    exit 3
    ;;
  release)
    rm -f "$DIR/$(slot_key "$WT").slot"
    echo "writer slot released: $WT"
    ;;
  status)
    reap_stale
    printf 'Writers: %s of %s (idle slots expire after %s min)\n' "$(count_slots)" "$MAX" "$TTL_MIN"
    describe_slots
    ;;
  *) die_usage ;;
esac
