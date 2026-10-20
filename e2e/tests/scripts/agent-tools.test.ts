import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

// Behaviour contracts for the agent tooling beside writer-slot.sh: `offload.sh`, which sends a
// check for the exact pushed commit to the offload machine, and `codegraph-worktree.sh`, which
// gives a linked worktree an index cloned from the main checkout's. Each case builds a throwaway
// repository and replaces the external tools (the offload runner, `codegraph`) with fakes.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const offload = path.join(repoRoot, "scripts", "agents", "offload.sh");
const codegraphWorktree = path.join(repoRoot, "scripts", "agents", "codegraph-worktree.sh");

vi.setConfig({ testTimeout: 60_000 });

const scratch: string[] = [];

afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), prefix)));
  scratch.push(dir);
  return dir;
}

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function executable(file: string, body: string): void {
  writeFileSync(file, body);
  chmodSync(file, 0o755);
}

type Run = { status: number | null; stdout: string; stderr: string };

function sh(script: string, cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync("sh", [script, ...args], { cwd, encoding: "utf8", env: { ...process.env, ...env }, timeout: 30_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A checkout whose origin is a local bare repository holding branch `feat/x`. */
function makeCheckout(): { checkout: string; sha: string } {
  const root = tempDir("offload-");
  const origin = path.join(root, "origin.git");
  const checkout = path.join(root, "checkout");
  git(root, "init", "-q", "--bare", "-b", "main", origin);
  git(root, "clone", "-q", origin, checkout);
  writeFileSync(path.join(checkout, "file.txt"), "x\n");
  git(checkout, "add", ".");
  git(checkout, "commit", "-qm", "init");
  git(checkout, "push", "-q", "origin", "HEAD:refs/heads/feat/x");
  return { checkout, sha: git(checkout, "rev-parse", "HEAD") };
}

describe("offload.sh", () => {
  test("refuses usage errors before contacting anything", () => {
    const { checkout } = makeCheckout();
    expect(sh(offload, checkout, []).status).toBe(64);
    expect(sh(offload, checkout, ["feat;rm"]).status).toBe(64);
    expect(sh(offload, checkout, ["feat/x"], { MISH_OFFLOAD_RUNNER: "mish-no-such-runner" }).status).toBe(64);
  });

  test("refuses a branch origin does not have", () => {
    const { checkout } = makeCheckout();
    const bin = tempDir("offload-bin-");
    executable(path.join(bin, "fake-runner"), "#!/bin/sh\nexit 0\n");
    const result = sh(offload, checkout, ["feat/missing"], { MISH_OFFLOAD_RUNNER: path.join(bin, "fake-runner") });
    expect(result.status).toBe(64);
    expect(result.stderr).toContain("push it first");
  });

  test("hands the runner a job pinned to origin's commit and passes its exit code through", () => {
    const { checkout, sha } = makeCheckout();
    const bin = tempDir("offload-bin-");
    const job = path.join(bin, "job.sh");
    const args = path.join(bin, "args.txt");
    executable(path.join(bin, "fake-runner"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\nwhile [ $# -gt 0 ]; do [ "$1" = -f ] && cp "$2" '${job}'; shift; done\nexit 7\n`);
    const command = "echo it's fine";
    const result = sh(offload, checkout, ["feat/x", command], {
      MISH_OFFLOAD_RUNNER: path.join(bin, "fake-runner"), MISH_OFFLOAD_TIMEOUT: "120",
    });
    expect(result.status, result.stderr).toBe(7);
    expect(readFileSync(args, "utf8").split("\n")).toEqual(expect.arrayContaining(["-t", "120", "-f"]));
    const text = readFileSync(job, "utf8");
    expect(spawnSync("sh", ["-n", job]).status).toBe(0);
    expect(text).toContain(`git -C "$R" cat-file -e "${sha}^{commit}"`);
    expect(text).toContain(`--detach "$C" "${sha}"`);
    // The command survives the remote shell's quoting intact.
    const line = text.split("\n").find((entry) => entry.startsWith("sh -c "))!;
    const echoed = spawnSync("sh", ["-c", line.replace(/^sh -c /, "printf '%s' ")], { encoding: "utf8" });
    expect(echoed.stdout).toBe(command);
  });
});

/** Fake `codegraph`: `init -y DIR` writes a SQLite index, `sync DIR` logs; every call is logged. */
function fakeCodegraph(): { bin: string; log: string } {
  const bin = tempDir("codegraph-bin-");
  const log = path.join(bin, "calls.log");
  executable(path.join(bin, "codegraph"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1" in
  init) mkdir -p "$3/.codegraph" && sqlite3 "$3/.codegraph/codegraph.db" "CREATE TABLE nodes(name TEXT); INSERT INTO nodes VALUES ('seeded');" ;;
  sync) [ -s "$2/.codegraph/codegraph.db" ] ;;
esac
`);
  return { bin, log };
}

const hasSqlite = spawnSync("sqlite3", ["-version"]).status === 0;

describe("codegraph-worktree.sh", () => {
  test("skips quietly when codegraph is missing and refuses a non-checkout", () => {
    const root = tempDir("codegraph-");
    git(root, "init", "-q", "-b", "main");
    const bin = tempDir("codegraph-path-");
    for (const tool of ["git", "sh", "dirname", "sed", "cksum", "cut"]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (found) executable(path.join(bin, tool), `#!/bin/sh\nexec ${found} "$@"\n`);
    }
    const skipped = sh(codegraphWorktree, root, [], { PATH: bin });
    expect(skipped.status).toBe(0);
    expect(skipped.stderr).toContain("not installed");
    expect(sh(codegraphWorktree, root, [tempDir("not-a-checkout-")]).status).toBe(64);
  });

  test.skipIf(!hasSqlite)("indexes the main checkout, then clones its index into a worktree and syncs it", () => {
    const root = tempDir("codegraph-");
    const main = path.join(root, "main");
    mkdirSync(main);
    git(main, "init", "-q", "-b", "main");
    writeFileSync(path.join(main, "file.txt"), "x\n");
    git(main, "add", ".");
    git(main, "commit", "-qm", "init");
    const worktree = path.join(root, "wt");
    git(main, "worktree", "add", "-q", "-b", "feature", worktree);
    const { bin, log } = fakeCodegraph();
    const env = { PATH: `${bin}:${process.env.PATH}`, MISH_CG_LOCK_WAIT: "20" };

    const first = sh(codegraphWorktree, main, [], env);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(existsSync(path.join(main, ".codegraph", "mish-ready"))).toBe(true);

    const second = sh(codegraphWorktree, worktree, [], env);
    expect(second.status, second.stdout + second.stderr).toBe(0);
    expect(second.stdout).toContain("index cloned from the seed");
    const cloned = spawnSync("sqlite3", [path.join(worktree, ".codegraph", "codegraph.db"), "SELECT name FROM nodes;"], { encoding: "utf8" });
    expect(cloned.stdout.trim()).toBe("seeded");
    expect(existsSync(path.join(worktree, ".codegraph", "mish-ready"))).toBe(true);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    expect(calls).toEqual([`init -y ${main}`, `sync ${worktree}`]);

    // A ready worktree is a no-op: no further codegraph calls.
    expect(sh(codegraphWorktree, worktree, [], env).status).toBe(0);
    expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
  });
});
