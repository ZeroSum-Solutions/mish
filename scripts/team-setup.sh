#!/bin/sh
# Mishh Mashh team setup: the one command a teammate runs on a fresh clone.
#
#   sh scripts/team-setup.sh            check prerequisites, install, build, start web
#   sh scripts/team-setup.sh --check    check prerequisites only
#   sh scripts/team-setup.sh --namespace <name> [-- <extra tools-dev start flags>]
#   sh scripts/team-setup.sh --enable-apply   report why setup cannot turn catalogue Apply on yet
#
# Why this is a shell script and not TypeScript: it is the bootstrap that runs BEFORE Node
# exists on the machine, so it cannot depend on Node, tsx or the workspace. It is plain POSIX
# sh and uses only shell built-ins for its checks, so it also runs where coreutils differ.
#
# Lifecycle stays with tools-dev (root AGENTS.md "Local lifecycle"): this script never starts a
# process itself, it calls `pnpm tools-dev start web` in a namespace. It never chooses a daemon
# data directory: when OD_DATA_DIR is set in the environment it is forwarded unchanged, as the
# root AGENTS.md "Daemon data directory contract" requires; when it is not set, the daemon's own
# default applies.

set -u

NAMESPACE="${OD_SETUP_NAMESPACE:-team}"
CHECK_ONLY=0
ENABLE_APPLY=0
APPLY_CANNOT="Apply can't be turned on by setup yet; use Copy code"

usage() {
  printf '%s\n' \
    "Usage: sh scripts/team-setup.sh [--check] [--namespace <name>] [-- <tools-dev start flags>]" \
    "" \
    "  --check             check prerequisites only; exit non-zero if any is missing" \
    "  --namespace <name>  tools-dev namespace to start in (default: team)" \
    "  --enable-apply      report why setup cannot turn catalogue Apply on yet, with the" \
    "                      daemon's gate list; starts nothing extra (off by default)" \
    "  -- <flags>          passed on to 'pnpm tools-dev start web', e.g. -- --web-port 3000" \
    "" \
    "Set OD_DATA_DIR to give this runtime its own daemon data root." \
    "Set OD_BROWSER_EXECUTABLE_PATH when your browser is not in a standard place."
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --enable-apply) ENABLE_APPLY=1 ;;
    --namespace)
      if [ "$#" -lt 2 ] || [ -z "$2" ]; then
        echo "team-setup: --namespace needs a name" >&2
        exit 2
      fi
      NAMESPACE="$2"
      shift
      ;;
    --namespace=*) NAMESPACE="${1#--namespace=}" ;;
    -h | --help) usage; exit 0 ;;
    --) shift; break ;;
    *) echo "team-setup: unknown option: $1 (see --help)" >&2; exit 2 ;;
  esac
  shift
done

# Remaining arguments ("$@") are forwarded to `tools-dev start web`.

# Resolve the repository root with built-ins only (no dirname): this script lives in scripts/.
case "$0" in
  */*) REPO_ROOT=$(CDPATH="" cd -- "${0%/*}/.." && pwd) ;;
  *) REPO_ROOT=$(pwd) ;;
esac

PINNED_PNPM="10.33.2"
MISSING=0

# tools-dev (tools/dev/src/local-env.ts) loads these files from the repository root, in this order.
# The first file that defines a key wins, the last line for that key inside a file wins, and the
# value REPLACES one exported in the shell. Setup must reason about the same effective values.
# OD_SETUP_ENV_DIR exists only so tests can point this at a scratch directory.
ENV_DIR="${OD_SETUP_ENV_DIR:-$REPO_ROOT}"
ENV_FILES=".env.development.local .env.local .env.development .env"

trim() {
  _t=$1
  _t=${_t#"${_t%%[![:space:]]*}"}
  _t=${_t%"${_t##*[![:space:]]}"}
  printf '%s' "$_t"
}

# Sets ENV_FILE_VALUE and ENV_FILE_NAME from the env file tools-dev would take KEY ($1) from.
# Returns 1 when no env file defines it. Mirrors parseDotEnvLocal for the plain forms
# (KEY=value, export KEY=value, quoted values, " #" inline comments).
env_file_lookup() {
  ENV_FILE_VALUE=""
  ENV_FILE_NAME=""
  for _f in $ENV_FILES; do
    [ -r "$ENV_DIR/$_f" ] || continue
    _found=0
    while IFS= read -r _line || [ -n "$_line" ]; do
      _line=$(trim "$_line")
      case "$_line" in '' | '#'*) continue ;; esac
      case "$_line" in 'export '*) _line=$(trim "${_line#export }") ;; esac
      case "$_line" in *=*) ;; *) continue ;; esac
      [ "$(trim "${_line%%=*}")" = "$1" ] || continue
      _v=$(trim "${_line#*=}")
      case "$_v" in
        \"*) _v=${_v#\"}; _v=${_v%%\"*} ;;
        \'*) _v=${_v#\'}; _v=${_v%%\'*} ;;
        *) _v=$(trim "${_v%% #*}") ;;
      esac
      ENV_FILE_VALUE=$_v
      _found=1
    done < "$ENV_DIR/$_f"
    if [ "$_found" -eq 1 ]; then
      ENV_FILE_NAME=$_f
      return 0
    fi
  done
  return 1
}

# Resolves a data-root value the way tools-dev does (~, $HOME and ${HOME} prefixes; relative
# paths anchor to the repository root), so two spellings of one directory compare equal.
normalize_root() {
  _p=$1
  # The patterns below match the literal text "~", "$HOME" and "${HOME}" a file may hold.
  # shellcheck disable=SC2088,SC2016
  case "$_p" in
    '~' | '~/'*) _p="${HOME:-}${_p#\~}" ;;
    '$HOME' | '$HOME/'*) _p="${HOME:-}${_p#\$HOME}" ;;
    '${HOME}' | '${HOME}/'*) _p="${HOME:-}${_p#\$\{HOME\}}" ;;
  esac
  case "$_p" in /*) ;; *) _p="$REPO_ROOT/$_p" ;; esac
  while [ "$_p" != "/" ] && [ "${_p%/}" != "$_p" ]; do _p=${_p%/}; done
  printf '%s' "$_p"
}

ok() { printf 'ok       %s\n' "$1"; }
missing() {
  # One line per missing item, always starting with "MISSING ", so a person or a script can
  # count them.
  printf 'MISSING %s\n' "$1" >&2
  MISSING=$((MISSING + 1))
}

have() { command -v "$1" >/dev/null 2>&1; }

first_line() {
  # Prints the first line of the command's output, using only built-ins.
  _out=$("$@" 2>/dev/null) || _out=""
  printf '%s\n' "$_out" | {
    IFS= read -r _line || true
    printf '%s' "$_line"
  }
}

# --- git -------------------------------------------------------------------
if have git; then
  ok "git ($(first_line git --version))"
else
  missing "git: install it (macOS: xcode-select --install; Linux: your package manager), then re-run."
fi

# --- Node 24 + pnpm 10.33.2, or mise ----------------------------------------
TOOLCHAIN=""
if have mise; then
  TOOLCHAIN="mise"
  ok "mise (installs Node 24 and pnpm ${PINNED_PNPM} from mise.toml)"
else
  NODE_VERSION=""
  if have node; then NODE_VERSION=$(first_line node --version); fi
  case "$NODE_VERSION" in
    v24.*)
      ok "node ${NODE_VERSION}"
      PNPM_VERSION=""
      if have pnpm; then PNPM_VERSION=$(first_line pnpm --version); fi
      if [ "$PNPM_VERSION" = "$PINNED_PNPM" ]; then
        TOOLCHAIN="pnpm"
        ok "pnpm ${PNPM_VERSION}"
      elif have corepack; then
        TOOLCHAIN="corepack"
        ok "corepack (selects pnpm ${PINNED_PNPM} from package.json)"
      else
        found=""
        if [ -n "$PNPM_VERSION" ]; then found=" (found ${PNPM_VERSION})"; fi
        missing "pnpm ${PINNED_PNPM}${found}: run 'npm install -g pnpm@${PINNED_PNPM}', or install mise (https://mise.jdx.dev), then re-run."
      fi
      ;;
    "")
      missing "Node 24: install mise (https://mise.jdx.dev; it reads mise.toml) or Node 24 from https://nodejs.org, then re-run."
      ;;
    *)
      missing "Node 24 (found ${NODE_VERSION}): install mise (https://mise.jdx.dev; it reads mise.toml) or switch to Node 24, then re-run."
      ;;
  esac
fi

# --- a local Chrome, Edge or Chromium (G11: a local browser is required) -----
# The daemon (findBrowserExecutable in apps/daemon/src/browser-sessions.ts) treats
# OD_BROWSER_EXECUTABLE_PATH as authoritative: a bad override means no browser, never a fallback.
# Without one it looks only at fixed macOS app bundles (or PATH on Linux), so a browser setup
# finds anywhere else is handed to tools-dev as OD_BROWSER_EXECUTABLE_PATH.
BROWSER=""
BROWSER_PASS=0
OVERRIDE="${OD_BROWSER_EXECUTABLE_PATH:-}"
OVERRIDE_FROM="your shell"
if env_file_lookup OD_BROWSER_EXECUTABLE_PATH && [ -n "$ENV_FILE_VALUE" ]; then
  OVERRIDE=$ENV_FILE_VALUE
  OVERRIDE_FROM=$ENV_FILE_NAME
fi
if [ -n "$OVERRIDE" ]; then
  if [ -f "$OVERRIDE" ] && [ -x "$OVERRIDE" ]; then
    BROWSER=$OVERRIDE
    ok "browser ($BROWSER, OD_BROWSER_EXECUTABLE_PATH from $OVERRIDE_FROM)"
  else
    missing "a working OD_BROWSER_EXECUTABLE_PATH: it points at ${OVERRIDE} (from ${OVERRIDE_FROM}), which is missing or not executable, and the daemon will not look anywhere else. Fix the path or remove the setting, then re-run."
  fi
else
  APP_DIRS="${OD_SETUP_BROWSER_APP_DIRS-/Applications:${HOME:-}/Applications}"
  _ifs=$IFS
  IFS=:
  for dir in $APP_DIRS; do
    [ -n "$dir" ] || continue
    for app in "Google Chrome" "Microsoft Edge" "Chromium"; do
      candidate="$dir/$app.app/Contents/MacOS/$app"
      if [ -z "$BROWSER" ] && [ -x "$candidate" ]; then
        BROWSER="$candidate"
        # The daemon's own macOS candidates; anything else must be handed to it.
        case "$dir|$app" in
          "/Applications|"*) ;;
          "${HOME:-}/Applications|Google Chrome" | "${HOME:-}/Applications|Microsoft Edge") ;;
          *) BROWSER_PASS=1 ;;
        esac
      fi
    done
  done
  IFS=$_ifs
  if [ -z "$BROWSER" ]; then
    for name in google-chrome-stable google-chrome microsoft-edge-stable microsoft-edge chromium chromium-browser; do
      if [ -z "$BROWSER" ] && have "$name"; then
        BROWSER=$(command -v "$name")
        BROWSER_PASS=1
      fi
    done
  fi
  if [ -n "$BROWSER" ]; then
    ok "browser ($BROWSER)"
  else
    missing "a local Chrome, Edge or Chromium: install Google Chrome, or set OD_BROWSER_EXECUTABLE_PATH to a Chromium-based browser, then re-run."
  fi
fi

# --- one effective daemon data root -------------------------------------------
# AGENTS.md "Daemon data directory contract": setup never picks a root. It reports the one the
# daemon will get, and refuses when the shell and an env file disagree, because tools-dev would
# silently use the env file's value.
SHELL_ROOT="${OD_DATA_DIR:-}"
DATA_ROOT_LINE="Daemon data root: the daemon's own default (OD_DATA_DIR is not set)."
if env_file_lookup OD_DATA_DIR; then
  FILE_ROOT=$ENV_FILE_VALUE
  if [ -n "$SHELL_ROOT" ] && { [ -z "$FILE_ROOT" ] || [ "$(normalize_root "$SHELL_ROOT")" != "$(normalize_root "$FILE_ROOT")" ]; }; then
    missing "one daemon data root: your shell sets OD_DATA_DIR=${SHELL_ROOT} but ${ENV_FILE_NAME} sets OD_DATA_DIR=${FILE_ROOT:-(empty)}, and tools-dev would use ${ENV_FILE_NAME}. Remove one of the two, then re-run."
  elif [ -n "$FILE_ROOT" ]; then
    DATA_ROOT_LINE="Daemon data root: OD_DATA_DIR from ${ENV_FILE_NAME} (${FILE_ROOT})."
  fi
elif [ -n "$SHELL_ROOT" ]; then
  DATA_ROOT_LINE="Daemon data root: OD_DATA_DIR from your shell (${SHELL_ROOT})."
fi

# --- catalogue Apply: an honest report, not a switch -------------------------
# The placement adoption executor (apps/daemon/src/workbench/placement/ADOPTION.md) opens only with a
# dev-built native placement owner, Apple Silicon, and a data root created by that same boot; it
# closes again on every restart. Setup cannot provide that safely, so it says so and, once the
# daemon is up, prints the daemon's own gate list. It never passes --placement-adoption-executor.
if [ "$ENABLE_APPLY" -eq 1 ]; then
  echo "$APPLY_CANNOT"
fi

if [ "$MISSING" -gt 0 ]; then
  echo "team-setup: ${MISSING} prerequisite(s) missing; fix the MISSING line(s) above and re-run." >&2
  exit 1
fi

if [ "$CHECK_ONLY" -eq 1 ]; then
  echo "team-setup: all prerequisites present."
  exit 0
fi

# --- install, build, start ----------------------------------------------------
cd "$REPO_ROOT" || exit 1

# Hand tools-dev (and so the daemon) the browser setup found where the daemon does not look.
if [ "$BROWSER_PASS" -eq 1 ]; then
  OD_BROWSER_EXECUTABLE_PATH=$BROWSER
  export OD_BROWSER_EXECUTABLE_PATH
fi

step() { printf '\n==> %s\n' "$1"; }

run_pnpm() {
  case "$TOOLCHAIN" in
    mise) mise exec -- pnpm "$@" ;;
    corepack) corepack pnpm "$@" ;;
    *) pnpm "$@" ;;
  esac
}

fail() {
  echo "team-setup: $1 failed. Fix the error above and re-run; completed steps are skipped quickly." >&2
  exit 1
}

if [ "$TOOLCHAIN" = "mise" ]; then
  step "mise install (Node 24, pnpm ${PINNED_PNPM})"
  mise install || fail "mise install"
fi

step "pnpm install"
run_pnpm install || fail "pnpm install"

step "build the daemon"
run_pnpm --filter @mish/daemon build || fail "the daemon build"

step "start the daemon and web app (tools-dev namespace: ${NAMESPACE})"
echo "$DATA_ROOT_LINE"
if [ -n "${OD_DATA_DIR:-}" ]; then export OD_DATA_DIR; fi
if [ "$BROWSER_PASS" -eq 1 ]; then
  echo "Browser: OD_BROWSER_EXECUTABLE_PATH=${BROWSER} is passed to tools-dev, because the daemon does not look there on its own."
fi
run_pnpm tools-dev start web --namespace "$NAMESPACE" "$@" || fail "tools-dev start web"

# Prints the "url" field of `tools-dev status <app> --json`, using only built-ins.
status_url() {
  _json=$(run_pnpm --silent tools-dev status "$1" --namespace "$NAMESPACE" --json 2>/dev/null) || _json=""
  case "$_json" in
    *'"url": "'*) _rest=${_json#*\"url\": \"} ;;
    *'"url":"'*) _rest=${_json#*\"url\":\"} ;;
    *) return 0 ;;
  esac
  printf '%s' "${_rest%%\"*}"
}

WEB_URL=$(status_url web)
DAEMON_URL=$(status_url daemon)

if [ -n "$DAEMON_URL" ]; then
  if [ "$ENABLE_APPLY" -eq 1 ]; then
    run_pnpm exec tsx scripts/team-setup-report.ts --daemon-url "$DAEMON_URL" --adoption || true
  else
    run_pnpm exec tsx scripts/team-setup-report.ts --daemon-url "$DAEMON_URL" || true
  fi
fi

# Bounds an override to a whole number of seconds: $1 is the value, $2 the default, $3 the
# largest accepted. Empty, non-numeric, zero or negative floors to 1 (no busy-loop, no skipped
# wait). A number above $3, or too long for shell arithmetic, is out of range and falls back to
# $2, so a typo like 99999999999999999999 can neither overflow nor hang setup.
positive_int() {
  case "$1" in
    ''|*[!0-9]*|0) printf '1'; return ;;
  esac
  _digits=${1#"${1%%[!0]*}"}
  if [ "${#_digits}" -gt 9 ] || [ "${_digits:-0}" -gt "$3" ] 2>/dev/null; then
    printf '%s' "$2"
  elif [ -z "$_digits" ]; then
    printf '1'
  else
    printf '%s' "$_digits"
  fi
}

# True when tools-dev says the web process is no longer there (state "idle"), so the wait can
# stop instead of polling a dead server for the full timeout.
web_exited() {
  _s=$(run_pnpm --silent tools-dev status web --namespace "$NAMESPACE" --json 2>/dev/null) || return 1
  case "$_s" in
    *'"state": "idle"'* | *'"state":"idle"'*) return 0 ;;
  esac
  return 1
}

echo
if [ -n "$WEB_URL" ]; then
  # tools-dev reports the URL as soon as the web process is spawned, before Next.js finishes its
  # first compile; a probe right away gets a refused connection or curl's "000", not a real
  # answer. Poll for an actual 2xx/3xx instead of printing "running" on a guess, bounded by wall-clock
  # time (not loop iterations: curl's own --max-time plus the sleep between probes would
  # otherwise stretch a "90s" bound well past 90 real seconds) so a server that never comes up
  # does not hang setup. WEB_READY_TIMEOUT_S/WEB_READY_INTERVAL_S are overridable only so tests
  # can shrink them (see e2e/tests/scripts/team-setup.test.ts).
  WEB_READY_TIMEOUT_S=$(positive_int "${OD_SETUP_WEB_READY_TIMEOUT_S:-90}" 90 3600)
  WEB_READY_INTERVAL_S=$(positive_int "${OD_SETUP_WEB_READY_INTERVAL_S:-2}" 2 60)
  WEB_READY=0
  WEB_DIED=0
  if have curl; then
    _wait_start=$(date +%s)
    while :; do
      _code=$(curl -s --noproxy '*' -o /dev/null -w '%{http_code}' --max-time 3 "$WEB_URL" 2>/dev/null) || _code=""
      case "$_code" in
        2?? | 3??) WEB_READY=1; break ;;
      esac
      if web_exited; then
        WEB_DIED=1
        break
      fi
      _wait_elapsed=$(($(date +%s) - _wait_start))
      if [ "$_wait_elapsed" -ge "$WEB_READY_TIMEOUT_S" ]; then
        break
      fi
      sleep "$WEB_READY_INTERVAL_S"
    done
  fi
  if [ "$WEB_READY" -eq 1 ]; then
    echo "Mishh Mashh is running: $WEB_URL"
  elif [ "$WEB_DIED" -eq 1 ]; then
    echo "team-setup: the web process exited before it answered at $WEB_URL." >&2
    echo "Read the logs with: pnpm tools-dev logs --namespace ${NAMESPACE}, fix the error, then re-run." >&2
    exit 1
  else
    echo "Mishh Mashh started: $WEB_URL"
    echo "The first load compiles the app and takes about 30s; give it a moment, then open $WEB_URL."
  fi
else
  echo "Mishh Mashh started. Find the web URL with: pnpm tools-dev status --namespace ${NAMESPACE}"
fi
echo "Stop it with: pnpm tools-dev stop --namespace ${NAMESPACE}"
