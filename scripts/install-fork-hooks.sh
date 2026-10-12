#!/bin/sh
# Install the Mishh-Mashh 2 fork-policy git hooks.
#
# Git hooks are not versioned, so a fresh clone has to reinstall them.
# Run this from the repository root:  ./scripts/install-fork-hooks.sh
#
# Policy and rationale: docs/FORK-PIN.md
set -eu

gitdir="$(git rev-parse --git-dir)"

hook="$gitdir/hooks/pre-merge-commit"
cat > "$hook" <<'HOOK'
#!/bin/sh
# Mishh-Mashh 2 fork policy: reject full upstream merges (cherry-picks are unaffected).
# See docs/FORK-PIN.md. Reinstall on fresh clones: ./scripts/install-fork-hooks.sh
GITDIR="$(git rev-parse --git-dir 2>/dev/null)"
MSG=""
[ -n "$GITDIR" ] && [ -f "$GITDIR/MERGE_MSG" ] && MSG="$(cat "$GITDIR/MERGE_MSG")"
case "$MSG" in
  *upstream*)
    echo "FORK-PIN VIOLATION: merge message references 'upstream'." >&2
    echo "This fork is hard-pinned; cherry-pick specific commits instead (docs/FORK-PIN.md)." >&2
    exit 1
    ;;
esac
exit 0
HOOK
chmod +x "$hook"

echo "installed: $hook"
