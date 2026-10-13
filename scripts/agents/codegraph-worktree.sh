#!/bin/sh
# codegraph-worktree: give a checkout a CodeGraph index without a full rebuild.
#
#   sh scripts/agents/codegraph-worktree.sh [<checkout dir>]   (default: the current checkout)
#   sh scripts/agents/codegraph-worktree.sh --hook             (Claude Code SessionStart hook)
#
# A full `codegraph init` parses all ~6,500 files with one worker per core and peaks at
# several GB; doing that in every new worktree is what slowed the machine down. Instead:
#
#   1. The main checkout is indexed once with `codegraph init`, at low priority.
#   2. A seed copy of that index is taken with SQLite's online backup, which is consistent
#      even while the main daemon writes. The seed is refreshed when the main index changes.
#   3. A linked worktree APFS-clones the seed (no extra disk until pages change), checks it,
#      and runs `codegraph sync`, which reparses only the files that differ.
#   4. `.codegraph/mish-ready` marks a finished bootstrap. A database without the marker is
#      an interrupted bootstrap and is synced again.
#
# Every CodeGraph process this script starts uses the worker caps below. The same caps sit
# in `.claude/settings.json` so the MCP daemons Claude Code starts honour them too.
#
# Why this is a shell script and not TypeScript: it runs from a session hook before the
# workspace is installed, and only drives the codegraph, git and sqlite3 executables.
#
# Exit: 0 index ready, or skipped (no codegraph) · 1 failed · 64 usage

set -u

export CODEGRAPH_PARSE_WORKERS="${CODEGRAPH_PARSE_WORKERS:-2}"
export CODEGRAPH_RESOLVE_WORKERS="${CODEGRAPH_RESOLVE_WORKERS:-2}"
export CODEGRAPH_QUERY_POOL_SIZE="${CODEGRAPH_QUERY_POOL_SIZE:-2}"

HOOK=0
WT=""
case "${1:-}" in
  --hook) HOOK=1 ;;
  -h|--help) sed -n '3,5p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
  "") ;;
  *) WT="$1" ;;
esac

if [ "$HOOK" = 1 ]; then
  # The hook passes JSON on stdin; only `cwd` matters.
  WT=$(node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{process.stdout.write(JSON.parse(s).cwd||"")}catch{}})' 2>/dev/null)
fi
[ -n "$WT" ] || WT=$(pwd)
WT=$(git -C "$WT" rev-parse --show-toplevel 2>/dev/null) || { [ "$HOOK" = 1 ] && exit 0; echo "codegraph-worktree: not a checkout: $WT" >&2; exit 64; }

command -v codegraph >/dev/null 2>&1 || { [ "$HOOK" = 1 ] || echo "codegraph-worktree: codegraph is not installed; skipping" >&2; exit 0; }

DB="$WT/.codegraph/codegraph.db"
READY="$WT/.codegraph/mish-ready"
if [ -s "$DB" ] && [ -f "$READY" ]; then
  [ "$HOOK" = 1 ] || echo "index ready: $WT/.codegraph"
  exit 0
fi

COMMON=$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)
MAIN=$(dirname "$COMMON")
STATE="$COMMON/mish-codegraph"
mkdir -p "$STATE"
KEY=$(printf '%s' "$WT" | cksum | cut -d' ' -f1)
LOG="$STATE/$KEY.log"

if [ "$HOOK" = 1 ]; then
  # Run in the foreground so the session's first query sees this worktree's index. Stay
  # silent on success; a failure only adds a note to the session, it never blocks it.
  # Wait at most 45 s for another bootstrap's lock, inside the hook's 120 s budget.
  if MISH_CG_LOCK_WAIT=45 sh "$0" "$WT" >>"$LOG" 2>&1 </dev/null; then exit 0; fi
  echo "CodeGraph could not prepare this worktree's index (log: $LOG). Answers may come from the main checkout's index; run \`sh scripts/agents/codegraph-worktree.sh\` or read files directly."
  exit 0
fi

mtime() { date -r "$1" +%s 2>/dev/null || echo 0; }

# One bootstrap per checkout at a time, to avoid duplicate work; correctness does not depend on
# it (every temporary file is unique and published by rename). The script re-runs itself under
# an exclusive kernel lock (flock), which the kernel drops when the holder exits, so a killed
# bootstrap never leaves it held. Waits MISH_CG_LOCK_WAIT seconds (default 300).
if [ -z "${MISH_CG_LOCKED:-}" ]; then
  MISH_CG_LOCKED=1 exec perl -MFcntl=:flock -e '
    BEGIN { $^F = 255 }  # keep the lock descriptor open across exec
    my ($file, $wait) = (shift, shift);
    open(my $fh, ">>", $file) or do { print "codegraph-worktree: cannot open lock $file: $!\n"; exit 1 };
    my $deadline = time + $wait;
    until (flock($fh, LOCK_EX | LOCK_NB)) {
      if (time > $deadline) { print "codegraph-worktree: another bootstrap still holds $file\n"; exit 1 }
      select(undef, undef, undef, 0.5);
    }
    exec { $ARGV[0] } @ARGV or exit 1;' "$STATE/$KEY.flock" "${MISH_CG_LOCK_WAIT:-300}" sh "$0" "$WT"
fi
trap 'rm -f "$STATE/seed.db.tmp.$$"* "$DB.tmp.$$"' EXIT INT TERM

echo "[$(date -u +%FT%TZ)] bootstrap $WT"

# Another run may have finished while this one waited for the lock.
[ -s "$DB" ] && [ -f "$READY" ] && exit 0

if [ "$WT" = "$MAIN" ]; then
  echo "main checkout: building the index at low priority"
  nice -n 15 codegraph init -y "$WT" && touch "$READY"
  exit $?
fi

SRC="$MAIN/.codegraph/codegraph.db"
if [ ! -s "$SRC" ]; then
  echo "main checkout has no index; build it first: sh scripts/agents/codegraph-worktree.sh $MAIN"
  exit 1
fi

if [ ! -s "$DB" ]; then
  # Refresh the seed when the main index (or its WAL) is newer than it.
  SEED="$STATE/seed.db"
  newest=$(mtime "$SRC"); [ -e "$SRC-wal" ] && [ "$(mtime "$SRC-wal")" -gt "$newest" ] && newest=$(mtime "$SRC-wal")
  if [ ! -s "$SEED" ] || [ "$newest" -gt "$(mtime "$SEED")" ]; then
    # No lock: each refresher writes its own temporary file and publishes it by rename, so
    # concurrent refreshes only repeat work. The seed is one self-contained file (rollback
    # journal, no WAL), so cloning it is safe. The backup goes to a bare relative name, so no
    # path needs quoting inside the dot-command.
    echo "refreshing the seed from $SRC (online backup)"
    TMPSEED="seed.db.tmp.$$"
    if (cd "$STATE" && sqlite3 "$SRC" ".backup $TMPSEED") &&
       sqlite3 "$STATE/$TMPSEED" 'PRAGMA journal_mode=DELETE;' >/dev/null &&
       [ "$(sqlite3 "$STATE/$TMPSEED" 'PRAGMA quick_check;')" = "ok" ]; then
      mv "$STATE/$TMPSEED" "$SEED"
    else
      echo "backup of the main index failed"; exit 1
    fi
  fi

  mkdir -p "$WT/.codegraph"
  [ -f "$MAIN/.codegraph/.gitignore" ] && cp "$MAIN/.codegraph/.gitignore" "$WT/.codegraph/.gitignore"
  # The seed is a closed, consistent file, so an APFS clone of it is safe; plain cp elsewhere.
  cp -c "$SEED" "$DB.tmp.$$" 2>/dev/null || cp "$SEED" "$DB.tmp.$$" || exit 1
  mv "$DB.tmp.$$" "$DB"
  echo "index cloned from the seed"
fi

echo "syncing changed files"
nice -n 15 codegraph sync "$WT" || { echo "[$(date -u +%FT%TZ)] sync failed"; exit 1; }
touch "$READY"
echo "[$(date -u +%FT%TZ)] ready"
