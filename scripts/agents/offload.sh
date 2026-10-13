#!/bin/sh
# offload: run a heavy check for a pushed branch on the offload machine (the Mac mini),
# so the laptop stays responsive.
#
#   sh scripts/agents/offload.sh <branch> [<command>]
#
# The default command is `pnpm guard && pnpm typecheck`. Give your own as one quoted
# string, e.g. 'pnpm --filter @mish/daemon test'. The branch must be pushed to origin:
# the offload machine fetches it from GitHub, never from this disk.
#
# The offload machine keeps one clone (~/projects/mish) and one reusable check checkout
# (~/projects/mish-check) that is moved to each branch, so its disk use stays flat. It runs
# one job at a time; a busy machine returns exit 3 and you run the check locally or retry.
#
# The transport is MISH_OFFLOAD_RUNNER (default `mini-run`, the owner's dispatcher, which
# runs the job in the logged-in GUI session so git and gh credentials work).
#
# Why this is a shell script and not TypeScript: it only builds a shell job for another
# machine and needs nothing from the workspace.
#
# The job checks out the exact commit origin had when you called it, not the branch tip at
# run time, and ends with a receipt: commit, command, runtime versions and exit code.
#
# Exit: the remote command's exit code · 3 runner busy · 4 timeout · 64 usage

set -u

BRANCH="${1:-}"
CMD="${2:-pnpm guard && pnpm typecheck}"
RUNNER="${MISH_OFFLOAD_RUNNER:-mini-run}"
TIMEOUT="${MISH_OFFLOAD_TIMEOUT:-3600}"

if [ -z "$BRANCH" ] || [ "$BRANCH" = "-h" ] || [ "$BRANCH" = "--help" ]; then
  sed -n '4,8p' "$0" | sed 's/^# \{0,1\}//' >&2
  exit 64
fi
case "$BRANCH" in *[!A-Za-z0-9._/-]*) echo "offload: unsupported branch name: $BRANCH" >&2; exit 64 ;; esac
command -v "$RUNNER" >/dev/null 2>&1 || { echo "offload: $RUNNER not found; run the check locally" >&2; exit 64; }

SHA=$(git ls-remote --exit-code --heads origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
if [ -z "$SHA" ]; then
  echo "offload: origin has no branch $BRANCH; push it first" >&2
  exit 64
fi
LOCAL=$(git rev-parse --verify --quiet "$BRANCH" 2>/dev/null || true)
[ -n "$LOCAL" ] && [ "$LOCAL" != "$SHA" ] && echo "offload: note: local $BRANCH is $LOCAL; checking origin's $SHA" >&2

# The command, single-quoted for the remote shell.
Q="'$(printf '%s' "$CMD" | sed "s/'/'\\\\''/g")'"

JOB=$(mktemp -t mish-offload) || exit 1
trap 'rm -f "$JOB"' EXIT INT TERM
cat > "$JOB" <<EOF
set -eu
export PATH="/opt/homebrew/bin:\$HOME/.local/bin:\$PATH"
export CODEGRAPH_PARSE_WORKERS=2 CODEGRAPH_RESOLVE_WORKERS=2 CODEGRAPH_QUERY_POOL_SIZE=2
R="\$HOME/projects/mish"
C="\$HOME/projects/mish-check"
[ -d "\$R/.git" ] || git clone --quiet https://github.com/ZeroSum-Solutions/mish.git "\$R"
git -C "\$R" fetch --quiet --prune origin
git -C "\$R" cat-file -e "$SHA^{commit}"
if [ -d "\$C" ]; then
  git -C "\$C" checkout --quiet --force --detach "$SHA"
  git -C "\$C" clean -fdxq -e node_modules -e '**/node_modules'
else
  git -C "\$R" worktree add --quiet --detach "\$C" "$SHA"
fi
cd "\$C"
command -v mise >/dev/null 2>&1 && eval "\$(mise activate bash --shims)"
corepack enable >/dev/null 2>&1 || true
pnpm install --frozen-lockfile --reporter=silent
set +e
sh -c $Q
rc=\$?
echo "--- offload receipt"
echo "host:    \$(hostname -s)"
echo "commit:  \$(git rev-parse HEAD) ($BRANCH)"
printf 'command: %s\n' $Q
echo "node:    \$(node --version)  pnpm: \$(pnpm --version)"
echo "exit:    \$rc"
exit \$rc
EOF

"$RUNNER" -t "$TIMEOUT" -f "$JOB"
