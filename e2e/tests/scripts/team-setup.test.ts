import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

// Behaviour contract for `scripts/team-setup.sh`, the no-Node bootstrap a teammate runs on a
// fresh clone. It must run under plain POSIX `sh` before Node exists, so each case gives the
// script a PATH that holds only the stub tools that case names. Missing Node and a missing
// browser are simulated by leaving those stubs out; the macOS app-bundle lookup is pointed at an
// empty directory through `OD_SETUP_BROWSER_APP_DIRS` so a browser installed on the test machine
// cannot satisfy the check.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const script = path.join(repoRoot, "scripts", "team-setup.sh");

type Stubs = Record<string, string>;

const scratch: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A stub executable: records its argv to the call log, then runs `body`. */
function writeStub(binDir: string, name: string, body: string): void {
  const file = path.join(binDir, name);
  writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "$SETUP_CALL_LOG"\n${body}\n`, "utf8");
  chmodSync(file, 0o755);
}

/** Resolves a real system binary's absolute path using this test runner's own PATH (not the
 * script-under-test's stub-only PATH), so the wait-for-ready loop's `date`/`sleep` calls have
 * something to exec. `run()`'s PATH holds only the named stubs; without this, `date` and `sleep`
 * are both "command not found" there, same as `git`/`node` would be if not stubbed. */
function resolveSystemBin(name: string): string {
  const result = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf8" });
  const resolved = result.stdout.trim();
  if (!resolved) throw new Error(`team-setup.test.ts: cannot resolve "${name}" on this machine's PATH`);
  return resolved;
}

const REAL_DATE = resolveSystemBin("date");
const REAL_SLEEP = resolveSystemBin("sleep");
/** Real `date`/`sleep` pass-throughs, exec'd by absolute path: every real machine team-setup.sh
 * runs on has these (they are plain POSIX utilities, not something setup checks for), so every
 * `run()` call gets them unless a test overrides them. */
const REAL_TIME_STUBS: Stubs = {
  date: `exec "${REAL_DATE}" "$@"`,
  sleep: `exec "${REAL_SLEEP}" "$@"`,
};

const GIT = 'echo "git version 2.44.0"';
const NODE_24 = 'echo "v24.11.1"';
const NODE_22 = 'echo "v22.12.0"';
const PNPM_PINNED = 'echo "10.33.2"';
const CHROME = 'echo "Google Chrome 141.0"';
const MISE_EXEC = 'if [ "$1" = "exec" ]; then shift; [ "$1" = "--" ] && shift; exec "$@"; fi';
/** Stub `curl -s -o /dev/null -w '%{http_code}' --max-time 3 <url>`: a web app that answers 200
 * on the first probe, and one that never does (what a refused connection or a `000` looks like
 * to the script, which only checks for the literal string "200"). */
/** Every curl stub first checks its argv, so a script that drops `-s`, `--noproxy '*'`, the
 * timeout or the URL fails loudly (exit 2) instead of passing on a canned answer. */
const CURL_ARGS_CHECK = [
  'case "$*" in',
  '  "-s --noproxy * -o /dev/null -w %{http_code} --max-time 3 http://127.0.0.1:43217") ;;',
  '  *) echo "curl stub: unexpected args: $*" >&2; exit 2 ;;',
  "esac",
].join("\n");
const curlAnswering = (code: string) => `${CURL_ARGS_CHECK}\nprintf "${code}"`;
const CURL_READY = curlAnswering("200");
const CURL_NEVER_READY = curlAnswering("000");
/** curl that answers 000 for its first two invocations and 200 from the third probe onward. The
 * run()'s PATH holds only its named stubs, so this counts invocations with shell builtins only
 * (`read`/redirection/arithmetic) rather than reaching for `grep` or `wc`, neither of which is
 * stubbed. */
const CURL_READY_ON_THIRD = [
  CURL_ARGS_CHECK,
  '_cnt_file="$SETUP_CALL_LOG.curlcount"',
  '_n=0',
  '[ -f "$_cnt_file" ] && read _n < "$_cnt_file"',
  '_n=$((_n + 1))',
  'printf \'%s\' "$_n" > "$_cnt_file"',
  'if [ "$_n" -ge 3 ]; then printf "200"; else printf "000"; fi',
].join("\n");
/** Fast bounds for the "wait until 200" loop so tests do not sleep for a real 90 seconds. */
const FAST_WEB_READY_ENV = { OD_SETUP_WEB_READY_TIMEOUT_S: "1", OD_SETUP_WEB_READY_INTERVAL_S: "1" };
/** Wide enough bound for CURL_READY_ON_THIRD to reach its third probe, but still far under a
 * real 90s: two 1s sleeps plus three near-instant curl calls comfortably fit in 5s. */
const THIRD_PROBE_WEB_READY_ENV = { OD_SETUP_WEB_READY_TIMEOUT_S: "5", OD_SETUP_WEB_READY_INTERVAL_S: "1" };
/** pnpm answering `tools-dev status <app> --json` with the single-app shape tools-dev prints. */
const STATUS_PNPM = [
  'case "$*" in',
  '  "--silent tools-dev status web --namespace team --json") ;;',
  '  "--silent tools-dev status daemon --namespace team --json") ;;',
  '  "install" | "--filter @open-design/daemon build" | "tools-dev start web --namespace team") exit 0 ;;',
  '  "exec tsx scripts/team-setup-report.ts --daemon-url http://127.0.0.1:43216" | \\',
  '  "exec tsx scripts/team-setup-report.ts --daemon-url http://127.0.0.1:43216 --adoption") exit 0 ;;',
  '  *) echo "pnpm stub: unexpected args: $*" >&2; exit 2 ;;',
  "esac",
  'case "$*" in',
  '  *"tools-dev status web"*) printf \'{\\n  "url": "http://127.0.0.1:43217",\\n  "pid": 1\\n}\\n\' ;;',
  '  *"tools-dev status daemon"*) printf \'{\\n  "url": "http://127.0.0.1:43216",\\n  "pid": 2\\n}\\n\' ;;',
  "esac",
].join("\n");
/** pnpm whose first `status web` reports a running web app and every later one reports idle: the
 * web process died during the wait. Counts with shell builtins only (see CURL_READY_ON_THIRD). */
const STATUS_PNPM_WEB_DIES = [
  'case "$*" in',
  '  "--silent tools-dev status web --namespace team --json")',
  '    _f="$SETUP_CALL_LOG.webstatus"; _n=0; [ -f "$_f" ] && read _n < "$_f"; _n=$((_n + 1)); printf \'%s\' "$_n" > "$_f"',
  '    if [ "$_n" -le 1 ]; then printf \'{"state": "running", "url": "http://127.0.0.1:43217"}\'; else printf \'{"state": "idle", "url": null}\'; fi ;;',
  '  "--silent tools-dev status daemon --namespace team --json") printf \'{"url": "http://127.0.0.1:43216"}\' ;;',
  "esac",
].join("\n");

function uname(system: string, machine: string): string {
  return `case "$1" in -s) echo "${system}" ;; -m) echo "${machine}" ;; *) echo "${system}" ;; esac`;
}

function run(stubs: Stubs, args: string[] = ["--check"], env: Record<string, string> = {}) {
  const binDir = tempDir("od-setup-bin-");
  const home = tempDir("od-setup-home-");
  const appDir = tempDir("od-setup-apps-");
  const envDir = tempDir("od-setup-envfiles-");
  const callLog = path.join(home, "calls.log");
  writeFileSync(callLog, "", "utf8");
  const allStubs: Stubs = { ...REAL_TIME_STUBS, ...stubs };
  for (const [name, body] of Object.entries(allStubs)) writeStub(binDir, name, body);
  const result = spawnSync("/bin/sh", [script, ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      PATH: binDir,
      HOME: home,
      SETUP_CALL_LOG: callLog,
      OD_SETUP_BROWSER_APP_DIRS: appDir,
      OD_SETUP_ENV_DIR: envDir,
      ...env,
    },
  });
  const output = `${result.stdout}${result.stderr}`;
  // A strict stub that refuses a call setup really makes would hide behind setup's `|| true`.
  expect(output).not.toMatch(/stub: unexpected args/);
  const fixLines = output.split("\n").filter((line) => line.startsWith("MISSING "));
  const calls = readFileSync(callLog, "utf8").split("\n").filter(Boolean);
  return { status: result.status, output, fixLines, calls, appDir, binDir, envDir };
}

describe("team-setup.sh prerequisite check", () => {
  test("[P0] passes with git, Node 24, pnpm 10.33.2 and a browser on PATH", () => {
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED, "google-chrome": CHROME });
    expect(result.fixLines, result.output).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  test("[P0] passes with mise standing in for Node and pnpm", () => {
    const result = run({ git: GIT, mise: 'echo "2026.9.0"', chromium: CHROME });
    expect(result.fixLines, result.output).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  test("[P0] missing Node: exactly one fix line naming mise and Node 24, and a non-zero exit", () => {
    const result = run({ git: GIT, "google-chrome": CHROME });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/Node 24/);
    expect(result.fixLines[0]).toMatch(/mise/);
  });

  test("[P0] the wrong Node major is reported as missing Node 24", () => {
    const result = run({ git: GIT, node: NODE_22, pnpm: PNPM_PINNED, "google-chrome": CHROME });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/Node 24/);
    expect(result.fixLines[0]).toMatch(/v22/);
  });

  test("[P0] missing pnpm with Node 24 but no Corepack: one fix line for pnpm 10.33.2", () => {
    const result = run({ git: GIT, node: NODE_24, "google-chrome": CHROME });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/pnpm 10\.33\.2/);
  });

  test("[P1] Corepack stands in for a global pnpm", () => {
    const result = run({ git: GIT, node: NODE_24, corepack: 'echo "0.34.0"', "google-chrome": CHROME });
    expect(result.fixLines, result.output).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  test("[P1] a pnpm other than 10.33.2 without Corepack is reported", () => {
    const result = run({ git: GIT, node: NODE_24, pnpm: 'echo "9.15.0"', "google-chrome": CHROME });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/pnpm 10\.33\.2/);
  });

  test("[P0] missing browser: exactly one fix line naming Chrome, Edge or Chromium and the override", () => {
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/Chrome/);
    expect(result.fixLines[0]).toMatch(/Edge/);
    expect(result.fixLines[0]).toMatch(/Chromium/);
    expect(result.fixLines[0]).toMatch(/OD_BROWSER_EXECUTABLE_PATH/);
  });

  test("[P1] a macOS app bundle in an application directory counts as a browser", () => {
    const appDir = tempDir("od-setup-bundle-");
    const macos = path.join(appDir, "Microsoft Edge.app", "Contents", "MacOS");
    mkdirSync(macos, { recursive: true });
    const binary = path.join(macos, "Microsoft Edge");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o755);
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED }, ["--check"], { OD_SETUP_BROWSER_APP_DIRS: appDir });
    expect(result.fixLines, result.output).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  test("[P1] OD_BROWSER_EXECUTABLE_PATH pointing at an executable counts as a browser", () => {
    const dir = tempDir("od-setup-browser-");
    const binary = path.join(dir, "my-chromium");
    writeFileSync(binary, "#!/bin/sh\n", "utf8");
    chmodSync(binary, 0o755);
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED }, ["--check"], { OD_BROWSER_EXECUTABLE_PATH: binary });
    expect(result.fixLines, result.output).toEqual([]);
    expect(result.status, result.output).toBe(0);
  });

  test("[P0] everything missing: one fix line each for git, Node 24 and the browser", () => {
    const result = run({});
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(3);
    expect(result.fixLines.some((line) => /git/.test(line))).toBe(true);
    expect(result.fixLines.some((line) => /Node 24/.test(line))).toBe(true);
    expect(result.fixLines.some((line) => /Chromium/.test(line))).toBe(true);
  });
});

describe("team-setup.sh full run", () => {
  test("[P0] refuses to install or start anything while a prerequisite is missing", () => {
    const result = run({ git: GIT, mise: 'echo "2026.9.0"' }, []);
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.calls.filter((call) => !/--version|^git /.test(call) && call !== "mise version")).toEqual([]);
  });

  test("[P0] with mise: install, workspace install, daemon build, start web in a namespace, then print the web URL once it answers 200", () => {
    // `mise exec -- <cmd>` runs <cmd> from this PATH; pnpm answers `tools-dev status` with the
    // shape tools-dev prints for a single app (`{ "url": ... }`). curl answers 200 on the first
    // probe, so the wait loop exits immediately without sleeping.
    const result = run(
      {
        git: GIT,
        mise: MISE_EXEC,
        pnpm: STATUS_PNPM,
        "google-chrome": CHROME,
        curl: CURL_READY,
      },
      [],
    );
    expect(result.status, result.output).toBe(0);
    const ordered = result.calls.filter(
      (call) => !/--version/.test(call) && !/^git /.test(call) && !/^mise exec/.test(call) && !/^date /.test(call),
    );
    expect(ordered).toEqual([
      "mise install",
      "pnpm install",
      "pnpm --filter @open-design/daemon build",
      "pnpm tools-dev start web --namespace team",
      "pnpm --silent tools-dev status web --namespace team --json",
      "pnpm --silent tools-dev status daemon --namespace team --json",
      "pnpm exec tsx scripts/team-setup-report.ts --daemon-url http://127.0.0.1:43216",
      "curl -s --noproxy * -o /dev/null -w %{http_code} --max-time 3 http://127.0.0.1:43217",
    ]);
    expect(result.output).toContain("Mishh Mashh is running: http://127.0.0.1:43217");
  });

  test("[P0] when the web app never answers 200 within the bound, says the first load compiles and still exits 0", () => {
    // Same wiring as the happy path, but curl always reports a closed port ("000"), the way a
    // Next.js dev server looks before it has bound its listener. The wait is bounded by
    // OD_SETUP_WEB_READY_TIMEOUT_S/INTERVAL_S so this test does not sleep for a real 90 seconds.
    const result = run(
      {
        git: GIT,
        mise: MISE_EXEC,
        pnpm: STATUS_PNPM,
        "google-chrome": CHROME,
        curl: CURL_NEVER_READY,
      },
      [],
      FAST_WEB_READY_ENV,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Mishh Mashh started: http://127.0.0.1:43217");
    expect(result.output).toMatch(/first load compiles the app and takes about 30s/i);
    expect(result.output).not.toContain("Mishh Mashh is running:");
  });

  test("[P1] becomes ready on the third probe (000, 000, 200)", () => {
    const result = run(
      {
        git: GIT,
        mise: MISE_EXEC,
        pnpm: STATUS_PNPM,
        "google-chrome": CHROME,
        curl: CURL_READY_ON_THIRD,
      },
      [],
      THIRD_PROBE_WEB_READY_ENV,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Mishh Mashh is running: http://127.0.0.1:43217");
    const curlCalls = result.calls.filter((call) => call.startsWith("curl "));
    expect(curlCalls, result.output).toHaveLength(3);
  });

  test.each(["204", "301", "302"])("[P1] treats HTTP %s as ready (any 2xx or 3xx)", (code) => {
    const result = run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM, "google-chrome": CHROME, curl: curlAnswering(code) },
      [],
      FAST_WEB_READY_ENV,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Mishh Mashh is running: http://127.0.0.1:43217");
  });

  test.each(["404", "500", "199"])("[P1] does not treat HTTP %s as ready", (code) => {
    const result = run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM, "google-chrome": CHROME, curl: curlAnswering(code) },
      [],
      FAST_WEB_READY_ENV,
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain("Mishh Mashh is running:");
  });

  test("[P0] stops waiting and exits non-zero when the web process exits during the wait", () => {
    const result = run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM_WEB_DIES, "google-chrome": CHROME, curl: CURL_NEVER_READY },
      [],
      // A bound far above the test timeout: only the exit check can end this wait early.
      { OD_SETUP_WEB_READY_TIMEOUT_S: "600", OD_SETUP_WEB_READY_INTERVAL_S: "1" },
    );
    expect(result.status, result.output).toBe(1);
    expect(result.output).toMatch(/web process exited before it answered at http:\/\/127\.0\.0\.1:43217/);
    expect(result.output).not.toContain("Mishh Mashh is running:");
    expect(result.output).not.toContain("Mishh Mashh started:");
    expect(result.calls.filter((call) => call.startsWith("curl "))).toHaveLength(1);
  });

  test("[P1] a huge timeout override falls back to the default instead of looping forever", () => {
    // 99999999999999999999 is out of range, so the bound becomes the 90s default; the web app
    // answers on the first probe, so the run still finishes at once.
    const result = run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM, "google-chrome": CHROME, curl: CURL_READY },
      [],
      { OD_SETUP_WEB_READY_TIMEOUT_S: "99999999999999999999", OD_SETUP_WEB_READY_INTERVAL_S: "99999999999999999999" },
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Mishh Mashh is running: http://127.0.0.1:43217");
  });

  test("[P1] with no curl on PATH, prints the immediate 'started' line without waiting", () => {
    // No `curl` stub at all: `have curl` is false, so the wait loop never runs and setup falls
    // straight to the "started" message, the same one a timed-out wait would print.
    const result = run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM, "google-chrome": CHROME },
      [],
    );
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain("Mishh Mashh started: http://127.0.0.1:43217");
    expect(result.output).not.toContain("Mishh Mashh is running:");
    expect(result.calls.some((call) => call.startsWith("curl "))).toBe(false);
  });

  test("[P1] forwards an explicit OD_DATA_DIR and a chosen namespace to tools-dev", () => {
    const dataDir = tempDir("od-setup-data-");
    const result = run(
      {
        git: GIT,
        node: NODE_24,
        pnpm: [
          'if [ "$1" = "--version" ]; then echo "10.33.2"; exit 0; fi',
          'echo "pnpm-env OD_DATA_DIR=$OD_DATA_DIR" >> "$SETUP_CALL_LOG"',
          'case "$*" in',
          '  *"tools-dev status web"*) printf \'{ "url": "http://127.0.0.1:5000" }\\n\' ;;',
          "esac",
        ].join("\n"),
        "google-chrome": CHROME,
      },
      ["--namespace", "alice"],
      { OD_DATA_DIR: dataDir },
    );
    expect(result.status, result.output).toBe(0);
    expect(result.calls).toContain("pnpm tools-dev start web --namespace alice");
    const envLines = result.calls.filter((call) => call.startsWith("pnpm-env "));
    expect(envLines.length).toBeGreaterThan(0);
    for (const line of envLines) expect(line).toBe(`pnpm-env OD_DATA_DIR=${dataDir}`);
    expect(result.output).toContain("http://127.0.0.1:5000");
  });

  test("[P1] invents no daemon data root when OD_DATA_DIR is not set", () => {
    const result = run(
      {
        git: GIT,
        node: NODE_24,
        pnpm: [
          'if [ "$1" = "--version" ]; then echo "10.33.2"; exit 0; fi',
          'echo "pnpm-env OD_DATA_DIR=${OD_DATA_DIR-<unset>}" >> "$SETUP_CALL_LOG"',
          'case "$*" in',
          '  *"tools-dev status web"*) printf \'{ "url": "http://127.0.0.1:5001" }\\n\' ;;',
          "esac",
        ].join("\n"),
        "google-chrome": CHROME,
      },
      [],
    );
    expect(result.status, result.output).toBe(0);
    const envLines = result.calls.filter((call) => call.startsWith("pnpm-env "));
    expect(envLines.length).toBeGreaterThan(0);
    for (const line of envLines) expect(line).toBe("pnpm-env OD_DATA_DIR=<unset>");
  });
});

describe("team-setup.sh --enable-apply", () => {
  // Setup cannot open the placement adoption executor yet (ADOPTION.md: it needs a dev-built native
  // owner and a data root created by that same boot, and closes again on restart). The flag is an
  // honest report: it says so, starts nothing extra, and asks the daemon for its gate list.
  const CANNOT = "Apply can't be turned on by setup yet; use Copy code";

  function applyRun(machine: [string, string], args: string[], env: Record<string, string> = {}) {
    return run(
      { git: GIT, mise: MISE_EXEC, pnpm: STATUS_PNPM, "google-chrome": CHROME, uname: uname(machine[0], machine[1]) },
      args,
      env,
    );
  }

  const startCall = (calls: string[]) => calls.find((call) => call.startsWith("pnpm tools-dev start web"));

  test.each([
    ["Darwin", "arm64"],
    ["Darwin", "x86_64"],
    ["Linux", "x86_64"],
  ])("[P0] %s %s: says Apply cannot be turned on, starts nothing extra, and prints the daemon's gate list", (system, machine) => {
    const result = applyRun([system, machine], ["--enable-apply"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(CANNOT);
    expect(startCall(result.calls)).toBe("pnpm tools-dev start web --namespace team");
    expect(result.calls.some((call) => call.includes("--placement-adoption-executor"))).toBe(false);
    expect(result.calls).toContain("pnpm exec tsx scripts/team-setup-report.ts --daemon-url http://127.0.0.1:43216 --adoption");
    expect(result.output).not.toMatch(/Enabled: /);
  });

  test("[P0] needs no OD_DATA_DIR and never adds the executor flag, even with one set", () => {
    const result = applyRun(["Darwin", "arm64"], ["--enable-apply"], { OD_DATA_DIR: tempDir("od-setup-apply-") });
    expect(result.status, result.output).toBe(0);
    expect(result.fixLines, result.output).toEqual([]);
    expect(startCall(result.calls)).toBe("pnpm tools-dev start web --namespace team");
  });

  test("[P0] off by default: no Apply line and no gate report", () => {
    const result = applyRun(["Darwin", "arm64"], []);
    expect(result.status, result.output).toBe(0);
    expect(result.output).not.toContain(CANNOT);
    expect(result.calls).toContain("pnpm exec tsx scripts/team-setup-report.ts --daemon-url http://127.0.0.1:43216");
  });

  test("[P1] --check --enable-apply reports without starting anything", () => {
    const result = applyRun(["Darwin", "arm64"], ["--check", "--enable-apply"]);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toContain(CANNOT);
    expect(result.calls.some((call) => call.startsWith("pnpm ") || call === "mise install")).toBe(false);
  });
});

/** pnpm that logs the two env vars setup may hand tools-dev, and answers status like STATUS_PNPM. */
const ENV_LOGGING_PNPM = [
  'if [ "$1" = "--version" ]; then echo "10.33.2"; exit 0; fi',
  'echo "pnpm-env OD_DATA_DIR=${OD_DATA_DIR-<unset>} OD_BROWSER_EXECUTABLE_PATH=${OD_BROWSER_EXECUTABLE_PATH-<unset>}" >> "$SETUP_CALL_LOG"',
  STATUS_PNPM,
].join("\n");

describe("team-setup.sh browser override and discovery", () => {
  test("[P0] a stale OD_BROWSER_EXECUTABLE_PATH is MISSING even when another browser is installed", () => {
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED, "google-chrome": CHROME }, ["--check"], {
      OD_BROWSER_EXECUTABLE_PATH: "/nonexistent/od-setup/chrome",
    });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/OD_BROWSER_EXECUTABLE_PATH/);
    expect(result.fixLines[0]).toContain("/nonexistent/od-setup/chrome");
  });

  test("[P0] a non-executable OD_BROWSER_EXECUTABLE_PATH is MISSING", () => {
    const dir = tempDir("od-setup-noexec-");
    const file = path.join(dir, "chrome");
    writeFileSync(file, "not a program", "utf8");
    chmodSync(file, 0o644);
    const result = run({ git: GIT, node: NODE_24, pnpm: PNPM_PINNED, "google-chrome": CHROME }, ["--check"], {
      OD_BROWSER_EXECUTABLE_PATH: file,
    });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toMatch(/OD_BROWSER_EXECUTABLE_PATH/);
  });

  test("[P0] a browser found where the daemon does not look is passed to tools-dev as OD_BROWSER_EXECUTABLE_PATH, and setup says so", () => {
    const result = run({ git: GIT, node: NODE_24, pnpm: ENV_LOGGING_PNPM, "google-chrome": CHROME }, []);
    expect(result.status, result.output).toBe(0);
    const chrome = path.join(result.binDir, "google-chrome");
    const envLines = result.calls.filter((call) => call.startsWith("pnpm-env "));
    expect(envLines.length).toBeGreaterThan(0);
    for (const line of envLines) expect(line).toContain(`OD_BROWSER_EXECUTABLE_PATH=${chrome}`);
    expect(result.output).toContain(`OD_BROWSER_EXECUTABLE_PATH=${chrome}`);
  });
});

describe("team-setup.sh effective daemon data root", () => {
  function withEnvFile(content: string) {
    return (envDir: string) => writeFileSync(path.join(envDir, ".env.local"), content, "utf8");
  }

  function runWithEnvFile(content: string, args: string[], env: Record<string, string> = {}) {
    // `run` creates the env-file directory; write .env.local into one we pass explicitly.
    const envDir = tempDir("od-setup-envfiles-");
    withEnvFile(content)(envDir);
    return run({ git: GIT, node: NODE_24, pnpm: ENV_LOGGING_PNPM, "google-chrome": CHROME }, args, {
      ...env,
      OD_SETUP_ENV_DIR: envDir,
    });
  }

  test("[P0] stops when the shell and .env.local name different data roots, naming both", () => {
    const shellRoot = tempDir("od-setup-shellroot-");
    const fileRoot = tempDir("od-setup-fileroot-");
    const result = runWithEnvFile(`OD_DATA_DIR=${fileRoot}\n`, [], { OD_DATA_DIR: shellRoot });
    expect(result.status, result.output).not.toBe(0);
    expect(result.fixLines, result.output).toHaveLength(1);
    expect(result.fixLines[0]).toContain(shellRoot);
    expect(result.fixLines[0]).toContain(fileRoot);
    expect(result.fixLines[0]).toContain(".env.local");
    const work = result.calls.filter((call) => !/--version/.test(call) && !/^git /.test(call));
    expect(work, result.output).toEqual([]);
  });

  test("[P0] reports a data root that only .env.local sets as the effective one", () => {
    const fileRoot = tempDir("od-setup-fileroot-");
    const result = runWithEnvFile(`# team data root\nexport OD_DATA_DIR="${fileRoot}"\n`, []);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Daemon data root: OD_DATA_DIR from \.env\.local/);
    expect(result.output).toContain(fileRoot);
  });

  test("[P1] the same root in the shell and .env.local is not a conflict", () => {
    const root = tempDir("od-setup-sameroot-");
    const result = runWithEnvFile(`OD_DATA_DIR=${root}\n`, [], { OD_DATA_DIR: root });
    expect(result.status, result.output).toBe(0);
    expect(result.fixLines).toEqual([]);
  });

  test("[P1] with no OD_DATA_DIR anywhere it says the daemon's own default applies", () => {
    const result = runWithEnvFile("TYPESAFE_API_KEY=x\n", []);
    expect(result.status, result.output).toBe(0);
    expect(result.output).toMatch(/Daemon data root: the daemon's own default/);
  });
});


/** Runs the script's own `positive_int` in a bare `sh`, so the edge cases hit the real function. */
function positiveInt(value: string, fallback: number, max: number): string {
  const source = readFileSync(script, "utf8");
  const start = source.indexOf("positive_int() {");
  const end = source.indexOf("\n}\n", start);
  if (start < 0 || end < 0) throw new Error("positive_int not found in team-setup.sh");
  const result = spawnSync("/bin/sh", ["-c", `${source.slice(start, end + 3)}\npositive_int "$1" "$2" "$3"`, "sh", value, String(fallback), String(max)], {
    encoding: "utf8",
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

describe("team-setup.sh positive_int", () => {
  test.each([
    ["", "1"],
    ["0", "1"],
    ["000", "1"],
    ["-5", "1"],
    ["abc", "1"],
    ["1.5", "1"],
    ["5s", "1"],
    ["7", "7"],
    ["007", "7"],
    ["3600", "3600"],
    ["3601", "90"],
    ["99999999999999999999", "90"],
    ["0000000000000000000000005", "5"],
  ])("maps %j to %s (default 90, max 3600)", (input, expected) => {
    expect(positiveInt(input, 90, 3600)).toBe(expected);
  });
});

describe("pnpm build-script approvals", () => {
  const workspace = readFileSync(path.join(repoRoot, "pnpm-workspace.yaml"), "utf8");
  const manifest = JSON.parse(readFileSync(path.join(repoRoot, "package.json"), "utf8")) as {
    pnpm: { onlyBuiltDependencies: string[]; ignoredBuiltDependencies: string[] };
  };

  function yamlList(key: string): string[] {
    const block = workspace.match(new RegExp(`^${key}:\\n((?:  - .*\\n)+)`, "m"));
    if (!block?.[1]) throw new Error(`${key} not found in pnpm-workspace.yaml`);
    return block[1].split("\n").filter(Boolean).map((line) => line.replace(/^  - /, "").replace(/^"|"$/g, ""));
  }

  test("package.json and pnpm-workspace.yaml list the same onlyBuiltDependencies", () => {
    expect(yamlList("onlyBuiltDependencies")).toEqual(manifest.pnpm.onlyBuiltDependencies);
  });

  test("package.json and pnpm-workspace.yaml list the same ignoredBuiltDependencies", () => {
    expect(yamlList("ignoredBuiltDependencies")).toEqual(manifest.pnpm.ignoredBuiltDependencies);
  });

  test("every ffmpeg and ffprobe platform package with a chmod postinstall is approved", () => {
    const expected = ["darwin-arm64", "darwin-x64", "linux-arm", "linux-arm64", "linux-ia32", "linux-x64"].flatMap(
      (platform) => [`@ffmpeg-installer/${platform}`, `@ffprobe-installer/${platform}`],
    );
    for (const name of expected) {
      expect(manifest.pnpm.onlyBuiltDependencies, name).toContain(name);
      expect(manifest.pnpm.ignoredBuiltDependencies, name).not.toContain(name);
    }
  });
});
