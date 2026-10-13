import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

// Behaviour contract for `scripts/agents/writer-slot.sh`, the admission check that keeps at most
// MISH_MAX_WRITERS checkouts of one clone under an active agent writer. Each case builds a
// throwaway repository with linked worktrees, copies the script into it (the script only
// governs the clone it lives in), and drives it the way agents and Claude Code hooks do.

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const source = path.join(repoRoot, "scripts", "agents", "writer-slot.sh");

const scratch: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

/** A clone with `count` linked worktrees; returns the main checkout, the worktrees and the script. */
function makeClone(count: number): { main: string; worktrees: string[]; script: string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "writer-slot-")));
  scratch.push(root);
  const main = path.join(root, "main");
  mkdirSync(path.join(main, "scripts", "agents"), { recursive: true });
  const script = path.join(main, "scripts", "agents", "writer-slot.sh");
  copyFileSync(source, script);
  git(main, "init", "-q", "-b", "main");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "add", ".");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.com", "commit", "-qm", "init");
  const worktrees = Array.from({ length: count }, (_, i) => {
    const wt = path.join(root, `wt${i}`);
    git(main, "worktree", "add", "-q", "-b", `b${i}`, wt);
    return wt;
  });
  return { main, worktrees, script };
}

type Run = { status: number | null; stdout: string; stderr: string };

function run(script: string, cwd: string, args: string[], input = "", env: NodeJS.ProcessEnv = {}): Run {
  const result = spawnSync("sh", [script, ...args], {
    cwd,
    input,
    encoding: "utf8",
    env: { ...process.env, MISH_MAX_WRITERS: "2", CLAUDE_SESSION_ID: "", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function runAsync(script: string, cwd: string, args: string[]): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn("sh", [script, ...args], { cwd, env: { ...process.env, MISH_MAX_WRITERS: "2" } });
    child.on("exit", (code) => resolve(code));
  });
}

/** A long-lived owner process standing in for an agent session. */
function owner(): ChildProcess {
  const child = spawn("sleep", ["60"]);
  children.push(child);
  return child;
}

function editHook(file: string, session: string): string {
  return JSON.stringify({ session_id: session, cwd: path.dirname(file), tool_input: { file_path: file } });
}

function bashHook(cwd: string, command: string, session: string): string {
  return JSON.stringify({ session_id: session, cwd, tool_input: { command } });
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve) => child.once("exit", resolve));
}

describe("writer-slot: admission", () => {
  test("[P0] admits writers up to MISH_MAX_WRITERS and refuses the next checkout, naming the holders", () => {
    const { worktrees, script } = makeClone(3);
    const [a, b, c] = worktrees as [string, string, string];
    expect(run(script, a,["claim", "--pid", String(owner().pid)]).status).toBe(0);
    expect(run(script, b, ["claim", "--pid", String(owner().pid)]).status).toBe(0);
    const refused = run(script, c, ["claim", "--pid", String(owner().pid)]);
    expect(refused.status).toBe(3);
    expect(refused.stderr).toContain("Writer limit reached: 2 of 2");
    expect(refused.stderr).toContain(a);
    expect(refused.stderr).toContain(b);
  });

  test("[P0] concurrent claims never admit more writers than the limit", async () => {
    const { worktrees, script } = makeClone(6);
    const pids = worktrees.map(() => String(owner().pid));
    const codes = await Promise.all(worktrees.map((wt, i) => runAsync(script, wt, ["claim", "--pid", pids[i]!])));
    expect(codes.filter((code) => code === 0)).toHaveLength(2);
    expect(codes.filter((code) => code === 3)).toHaveLength(4);
  });

  test("MISH_MAX_WRITERS above 3 is clamped to 3", () => {
    const { worktrees, script } = makeClone(4);
    const codes = worktrees.map((wt) => run(script, wt, ["claim", "--pid", String(owner().pid)], "", { MISH_MAX_WRITERS: "9" }).status);
    expect(codes).toEqual([0, 0, 0, 3]);
  });
});

describe("writer-slot: ownership", () => {
  test("[P0] a slot frees itself when its owner process exits", async () => {
    const { worktrees, script } = makeClone(3);
    const first = owner();
    expect(run(script, worktrees[0]!, ["claim", "--pid", String(first.pid)]).status).toBe(0);
    expect(run(script, worktrees[1]!, ["claim", "--pid", String(owner().pid)]).status).toBe(0);
    expect(run(script, worktrees[2]!, ["claim", "--pid", String(owner().pid)]).status).toBe(3);
    first.kill("SIGKILL");
    await waitForExit(first);
    expect(run(script, worktrees[2]!, ["claim", "--pid", String(owner().pid)]).status).toBe(0);
  });

  test("[P0] one checkout has one writer: a second session editing it is refused", () => {
    const { worktrees, script } = makeClone(1);
    const file = path.join(worktrees[0]!, "file.ts");
    expect(run(script, worktrees[0]!, ["hook-pre"], editHook(file, "session-a")).status).toBe(0);
    expect(run(script, worktrees[0]!, ["hook-pre"], editHook(file, "session-a")).status).toBe(0);
    const second = run(script, worktrees[0]!, ["hook-pre"], editHook(file, "session-b"));
    expect(second.status).toBe(2);
    expect(second.stderr).toContain("Another agent session is the writer");
  });

  test("[P0] session end releases only that session's slots", () => {
    const { worktrees, script } = makeClone(2);
    const [a, b] = worktrees;
    expect(run(script, a!, ["hook-pre"], editHook(path.join(a!, "x.ts"), "session-a")).status).toBe(0);
    expect(run(script, b!, ["hook-pre"], editHook(path.join(b!, "x.ts"), "session-b")).status).toBe(0);
    run(script, a!, ["hook-end"], JSON.stringify({ session_id: "session-a" }));
    const status = run(script, a!, ["status"]).stdout;
    expect(status).toContain("Writers: 1 of 2");
    expect(status).toContain(b!);
    expect(status).not.toContain(`${a!} (`);
  });

  test("run holds a slot exactly while its command runs", () => {
    const { worktrees, script } = makeClone(1);
    const during = run(script, worktrees[0]!, ["run", "--agent", "codex", "--", "sh", script, "status"]);
    expect(during.status).toBe(0);
    expect(during.stdout).toContain("Writers: 1 of 2");
    expect(during.stdout).toContain("agent codex");
    expect(run(script, worktrees[0]!, ["status"]).stdout).toContain("Writers: 0 of 2");
  });

  test("[P0] release refuses another live session's slot unless forced", () => {
    const { worktrees, script } = makeClone(1);
    expect(run(script, worktrees[0]!, ["claim", "--pid", String(owner().pid)]).status).toBe(0);
    expect(run(script, worktrees[0]!, ["release"]).status).toBe(3);
    expect(run(script, worktrees[0]!, ["status"]).stdout).toContain("Writers: 1 of 2");
    expect(run(script, worktrees[0]!, ["release", "--force"]).status).toBe(0);
    expect(run(script, worktrees[0]!, ["status"]).stdout).toContain("Writers: 0 of 2");
  });

  test("a claim whose owner cannot be fingerprinted falls back to the TTL instead of living forever", () => {
    const { worktrees, script } = makeClone(1);
    expect(run(script, worktrees[0]!, ["claim", "--pid", "999999"]).status).toBe(0);
    expect(run(script, worktrees[0]!, ["status"]).stdout).toContain("Writers: 1 of 2");
    expect(run(script, worktrees[0]!, ["status"], "", { MISH_WRITER_TTL_MIN: "0" }).stdout).toContain("Writers: 0 of 2");
  });

  test("a registry lock left by a dead process is broken", () => {
    const { main, worktrees, script } = makeClone(1);
    const lockDir = path.join(main, ".git", "mish-writers", ".lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(path.join(lockDir, "pid"), "999999\n");
    expect(run(script, worktrees[0]!, ["claim", "--pid", String(owner().pid)]).status).toBe(0);
  });
});

describe("writer-slot: Claude Code hooks", () => {
  test("[P0] edits outside the clone are never blocked, even with every slot taken", () => {
    const { worktrees, script } = makeClone(3);
    run(script, worktrees[0]!, ["claim", "--pid", String(owner().pid)]);
    run(script, worktrees[1]!, ["claim", "--pid", String(owner().pid)]);
    const outside = path.join(tmpdir(), "not-in-the-clone", "notes.md");
    expect(run(script, worktrees[2]!, ["hook-pre"], editHook(outside, "s")).status).toBe(0);
    expect(run(script, worktrees[2]!, ["hook-pre"], editHook(path.join(worktrees[2]!, "a.ts"), "s")).status).toBe(2);
  });

  test("[P0] read-only shell commands pass when full; writing ones need a slot", () => {
    const { worktrees, script } = makeClone(3);
    run(script, worktrees[0]!, ["claim", "--pid", String(owner().pid)]);
    run(script, worktrees[1]!, ["claim", "--pid", String(owner().pid)]);
    const cwd = worktrees[2]!;
    expect(run(script, cwd, ["hook-bash"], bashHook(cwd, "git status && rg foo", "s")).status).toBe(0);
    expect(run(script, cwd, ["hook-bash"], bashHook(cwd, "git commit -m wip", "s")).status).toBe(2);
    expect(run(script, cwd, ["hook-bash"], bashHook(cwd, "sed -i '' s/a/b/ x.ts", "s")).status).toBe(2);
    expect(run(script, cwd, ["hook-bash"], bashHook(cwd, `git -C ${cwd} commit -m wip`, "s")).status).toBe(2);
    expect(run(script, cwd, ["hook-bash"], bashHook(cwd, "echo hi >> /tmp/out.txt", "s")).status).toBe(2);
  });

  test("[P0] hooks of an agent started under `run` use the wrapper's slot", () => {
    const { worktrees, script } = makeClone(1);
    const file = path.join(worktrees[0]!, "a.ts");
    const wrapped = run(script, worktrees[0]!, ["run", "--agent", "claude", "--", "sh", "-c", 'sh "$0" hook-pre', script], editHook(file, "uuid-1"));
    expect(wrapped.status).toBe(0);
  });
});
