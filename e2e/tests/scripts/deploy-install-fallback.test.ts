import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "vitest";
import assert from "node:assert/strict";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const sandboxes: string[] = [];

afterEach(() => {
  for (const dir of sandboxes.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// A copy of deploy/ (scripts + compose files + Dockerfile) in a scratch
// directory, with stub `docker` and `curl` on PATH. The stub `docker compose
// pull` fails the way it does today, when no registry carries the image, and
// every compose invocation is logged so the test can see what the script ran.
function sandbox(): { deployDir: string; log: string; env: NodeJS.ProcessEnv } {
  const root = mkdtempSync(path.join(os.tmpdir(), "mish-deploy-"));
  sandboxes.push(root);
  const deployDir = path.join(root, "deploy");
  mkdirSync(path.join(deployDir, "scripts"), { recursive: true });
  for (const file of ["docker-compose.yml", "Dockerfile"]) {
    copyFileSync(path.join(repoRoot, "deploy", file), path.join(deployDir, file));
  }
  for (const file of ["install.sh", "update.sh"]) {
    copyFileSync(path.join(repoRoot, "deploy/scripts", file), path.join(deployDir, "scripts", file));
  }
  // The build context is the checkout root (docker-compose.yml: context ..).
  writeFileSync(path.join(root, "package.json"), "{}\n");

  const bin = path.join(root, "bin");
  mkdirSync(bin);
  const log = path.join(root, "compose.log");
  writeFileSync(
    path.join(bin, "docker"),
    `#!/usr/bin/env bash
case "$1" in
  compose)
    shift
    args=()
    while [ $# -gt 0 ]; do
      case "$1" in -f) shift 2 ;; *) args+=("$1"); shift ;; esac
    done
    echo "\${args[*]}" >> ${JSON.stringify(log)}
    case "\${args[0]}" in
      version) echo "2.29.0" ;;
      pull) echo "manifest unknown" >&2; exit 1 ;;
    esac
    exit 0 ;;
  ps) exit 0 ;;
  *) exit 0 ;;
esac
`,
  );
  writeFileSync(path.join(bin, "curl"), "#!/usr/bin/env bash\nprintf 200\n");
  for (const stub of ["docker", "curl"]) chmodSync(path.join(bin, stub), 0o755);

  return { deployDir, log, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } };
}

function composeCalls(log: string): string[] {
  return readFileSync(log, "utf8").trim().split("\n");
}

test("install.sh builds the image locally when the pull fails", () => {
  const { deployDir, log, env } = sandbox();
  const result = spawnSync(
    "bash",
    [path.join(deployDir, "scripts/install.sh"), "--non-interactive", "--no-systemd", "--port", "47456"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = composeCalls(log);
  assert.ok(calls.includes("pull"), calls.join("\n"));
  assert.ok(calls.includes("up -d --build"), calls.join("\n"));
  assert.ok(!calls.includes("up -d --no-build"), calls.join("\n"));
});

test("install.sh --build skips the pull and builds locally", () => {
  const { deployDir, log, env } = sandbox();
  const result = spawnSync(
    "bash",
    [path.join(deployDir, "scripts/install.sh"), "--non-interactive", "--no-systemd", "--port", "47457", "--build"],
    { env, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  const calls = composeCalls(log);
  assert.ok(!calls.includes("pull"), calls.join("\n"));
  assert.ok(calls.includes("up -d --build"), calls.join("\n"));
});

test("update.sh rebuilds locally when the pull fails", () => {
  const { deployDir, log, env } = sandbox();
  const result = spawnSync("bash", [path.join(deployDir, "scripts/update.sh"), "--non-interactive"], {
    env,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const calls = composeCalls(log);
  assert.ok(calls.includes("pull"), calls.join("\n"));
  assert.ok(calls.includes("up -d --build"), calls.join("\n"));
});
