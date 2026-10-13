import { execFile } from "node:child_process";

import { existsSync } from "node:fs";

import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { createServer as createHttpsServer } from "node:https";

import { tmpdir } from "node:os";

import { delimiter, dirname, join } from "node:path";

import { fileURLToPath } from "node:url";

import { promisify } from "node:util";

import { expect, it, describe } from "vitest";

import { T } from "@/timeouts";

import { uiP0CiMatrix, uiP0Groups, uiP0SharedFilePartitions, validatePlaywrightSuiteTopology } from "../lib/playwright/suites.ts";

const execFileAsync = promisify(execFile);

const launchEnv = { ...process.env };

const launchPath = launchEnv.PATH ?? launchEnv.Path ?? "";

const nodeBinDir = dirname(process.execPath);

const jqBin = process.platform !== "win32" && existsSync("/usr/bin/jq") ? "/usr/bin/jq" : "jq";

const e2eRoot = dirname(dirname(fileURLToPath(import.meta.url)));

const workspaceRoot = dirname(e2eRoot);

const ciWorkflowPath = join(workspaceRoot, ".github", "workflows", "ci.yml");

const configureCiParallelismActionPath = join(
  workspaceRoot,
  ".github",
  "actions",
  "configure-ci-parallelism",
  "action.yml",
);

const rerunInfraCancelScriptPath = join(workspaceRoot, ".github", "scripts", "rerun_infra_cancel.py");

const handoffScriptPath = join(workspaceRoot, ".github", "scripts", "handoff.py");

const dailyBetaRecoveryScriptPath = join(
  workspaceRoot,
  ".github",
  "scripts",
  "release",
  "resolve-daily-beta-recovery.ts",
);

const releaseStableNotesScriptPath = join(workspaceRoot, ".github", "scripts", "release", "github", "stable-notes.sh");

const releaseStableScriptPath = join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-stable.ts");

const releaseBetaScriptPath = join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-beta.ts");

const packagedPackageJsonPath = join(workspaceRoot, "apps", "packaged", "package.json");

const scopesScriptPath = join(workspaceRoot, ".github", "scripts", "scopes.py");

const runnersScriptPath = join(workspaceRoot, ".github", "scripts", "runners.py");

const feishuCardScriptPath = join(workspaceRoot, "tools", "release", "src", "notifications", "feishu.ts");

const releasePublishMetadataScriptPath = join(
  workspaceRoot,
  "tools",
  "release",
  "src",
  "storage",
  "publish-metadata.ts",
);

const releaseBetaWindowsBuildScriptPath = join(workspaceRoot, "tools", "release", "scripts", "build-platform.ps1");

function workflowFixtureEnv(
  overrides: Record<string, string>,
  executableDir?: string,
): NodeJS.ProcessEnv {
  const childPath = [executableDir, nodeBinDir, launchPath].filter(Boolean).join(delimiter);
  return {
    ...launchEnv,
    ...overrides,
    Path: childPath,
    PATH: childPath,
  };
}

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

function extractWorkflowRunScript(workflow: string, stepName: string): string {
  const marker = `      - name: ${stepName}`;
  const start = workflow.indexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const next = workflow.indexOf("\n      - ", start + marker.length);
  const step = workflow.slice(start, next === -1 ? workflow.length : next);
  const runStart = step.indexOf("        run: |\n");
  expect(runStart).toBeGreaterThanOrEqual(0);
  return step
    .slice(runStart + "        run: |\n".length)
    .split("\n")
    .map((line) => line.replace(/^          /, ""))
    .join("\n")
    .trimEnd();
}

function parseGithubOutput(raw: string): Record<string, string> {
  return Object.fromEntries(
    raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const sep = line.indexOf("=");
        expect(sep).toBeGreaterThan(0);
        return [line.slice(0, sep), line.slice(sep + 1)];
      }),
  );
}

async function gitPatchId(mode: "--stable" | "--verbatim", diff: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["patch-id", mode], { cwd: workspaceRoot, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout.trim().split(/\s+/)[0] ?? "");
    });
    child.stdin?.end(diff);
  });
}

function extractValidateGateJqPrograms(workflow: string): { failures: string; requiredMisses: string } {
  const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");
  // Only the "Check workspace validation jobs" step — later validate steps also use jq.
  const needsCheck = sectionBetween(
    validate,
    "      - name: Check workspace validation jobs",
    "      # A failed workload",
  );
  const programs = [...needsCheck.matchAll(/jq -r '([\s\S]*?)'/g)].map((match) => match[1] ?? "");
  expect(programs).toHaveLength(2);
  return { failures: programs[0] ?? "", requiredMisses: programs[1] ?? "" };
}

function runValidateGateJq(program: string, needs: unknown): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(jqBin, ["-r", program], { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve(stdout.trim());
    });
    child.stdin?.end(JSON.stringify(needs));
  });
}

async function validateGatePasses(workflow: string, needs: unknown): Promise<boolean> {
  const { failures, requiredMisses } = extractValidateGateJqPrograms(workflow);
  const [failureLines, missLines] = await Promise.all([
    runValidateGateJq(failures, needs),
    runValidateGateJq(requiredMisses, needs),
  ]);
  return failureLines === "" && missLines === "";
}

async function runReleaseStableForFailure(env: Record<string, string>): Promise<string> {
  try {
    await execFileAsync(process.execPath, ["--experimental-strip-types", releaseStableScriptPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        GITHUB_REPOSITORY: "ZeroSum-Solutions/mish",
        GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
        MISH_RELEASE_CHANNEL: "stable",
        ...env,
      },
    });
  } catch (error) {
    const failed = error as { stderr?: string; stdout?: string };
    return `${failed.stdout ?? ""}${failed.stderr ?? ""}`;
  }

  throw new Error("release-stable script unexpectedly succeeded");
}

async function readPackagedVersion(): Promise<string> {
  const packageJson = JSON.parse(await readFile(packagedPackageJsonPath, "utf8")) as { version?: unknown };
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("apps/packaged/package.json must define a version");
  }
  return packageJson.version;
}

async function runScopesPrint(eventName: string, eventPayload: unknown, changedFiles: string[] = []): Promise<Record<string, unknown>> {
  const inputMode = (eventPayload as { inputs?: { ci_mode?: string } }).inputs?.ci_mode;
  const context =
    eventName === "workflow_dispatch" && inputMode !== "hot"
      ? "full"
      : eventName === "merge_group" && changedFiles.length === 0
        ? "full"
        : eventName === "merge_group"
          ? "merge-queue"
          : "pr";
  const { stdout } = await execFileAsync("python3", [scopesScriptPath, "plan", "--context", context, "--files", ...changedFiles], {
    cwd: workspaceRoot,
  });
  const value = JSON.parse(stdout) as {
    scopes: Record<string, unknown>;
    enabled: Record<string, boolean>;
  };
  return {
    ...value.scopes,
    run_e2e_vitest: value.enabled.e2e_vitest,
    run_playwright_critical: value.enabled.playwright_critical,
    run_playwright_visual: value.enabled.playwright_visual,
    run_preflight: value.enabled.preflight,
    run_ui_p0: value.enabled.ui_p0,
    run_web_workspace_tests: value.enabled.web_workspace_tests,
    run_windows_tools_pack_payload_tests: value.enabled.windows_tools_pack_payload_tests,
    run_workspace_unit_tests: value.enabled.workspace_unit_tests,
  };
}

async function runRunners(mode?: string): Promise<Record<string, string>> {
  const env = { ...process.env };
  if (mode === undefined) {
    delete env.OD_CI_RUNNER_MODE;
  } else {
    env.OD_CI_RUNNER_MODE = mode;
  }
  delete env.GITHUB_OUTPUT;

  const { stdout } = await execFileAsync("python3", [runnersScriptPath], {
    cwd: workspaceRoot,
    env,
  });
  return Object.fromEntries(
    stdout
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => {
        const separatorIndex = line.indexOf("=");
        expect(separatorIndex).toBeGreaterThan(0);
        return [line.slice(0, separatorIndex), line.slice(separatorIndex + 1)];
      }),
  );
}

function runnerOutput(profiles: Record<string, string>, key: string): string {
  const value = profiles[key];
  if (value === undefined) {
    throw new Error(`Missing runner profile output: ${key}`);
  }
  return value;
}

function runnerDecision(profiles: Record<string, string>): { schema_version: number; mode: string } {
  return JSON.parse(runnerOutput(profiles, "decision")) as { schema_version: number; mode: string };
}

function runnerRunsOn(profiles: Record<string, string>): Record<string, string[]> {
  return JSON.parse(runnerOutput(profiles, "runs_on")) as Record<string, string[]>;
}

async function writeFakeGhBin(binDir: string, releases: unknown[]): Promise<void> {
  const ghPath = join(binDir, "gh");
  const ghCmdPath = join(binDir, "gh.cmd");
  await writeFile(
    ghPath,
    `#!/usr/bin/env node
if (process.argv[2] === "api" && /^repos\\/[^/]+\\/[^/]+\\/releases\\?/.test(process.argv[3] ?? "")) {
  const url = new URL(process.argv[3], "https://api.github.com/");
  const page = url.searchParams.get("page") ?? "1";
  process.stdout.write(JSON.stringify(page === "1" ? ${JSON.stringify(releases)} : []));
  process.exit(0);
}
console.error("unexpected gh invocation: " + process.argv.slice(2).join(" "));
process.exit(1);
`,
  );
  await chmod(ghPath, 0o755);
  await writeFile(ghCmdPath, `@echo off\r\n"${process.execPath}" "%~dp0gh" %*\r\n`);
}

async function renderFeishuBuildCard(env: Record<string, string>): Promise<Record<string, unknown>> {
  let payload: Record<string, unknown> | undefined;
  const server = createServer((request, response) => {
    void (async () => {
      let raw = "";
      for await (const chunk of request) raw += chunk.toString();
      payload = JSON.parse(raw) as Record<string, unknown>;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ code: 0 }));
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Feishu card fixture did not bind to a TCP port");
  }

  try {
    await execFileAsync(process.execPath, ["--experimental-strip-types", feishuCardScriptPath], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        BUILD_STATE: "success",
        CHANNEL_LABEL: "Beta",
        FEISHU_WEBHOOK: `http://127.0.0.1:${address.port}`,
        VERSION: "0.19.0-beta.1",
        ...env,
      },
    });
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error == null ? resolve() : reject(error)));
    });
  }

  if (payload == null) throw new Error("Feishu card fixture received no payload");
  return payload;
}

describe("packaged smoke workflow", () => {

  it("[P2] keeps packaged smoke outside the main CI gate", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    expect(workflow).not.toContain("packaged_smoke_");
    expect(workflow).not.toContain("Build PR mac artifacts");
    expect(workflow).not.toContain("Build PR windows artifacts");
    expect(workflow).not.toContain("Build PR linux headless artifacts");
    expect(workflow).not.toContain("Smoke PR mac packaged runtime");
    expect(workflow).not.toContain("Smoke PR windows packaged runtime");
    expect(workflow).not.toContain("Smoke PR linux headless packaged runtime");
    expect(workflow).not.toContain("OD_PACKAGED_E2E_");
  });

  it("[P2] runs the independent Windows launcher payload test set", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const job = sectionBetween(workflow, "  windows_tools_pack_payload_tests:", "  web_workspace_tests:");
    const validate = sectionBetween(workflow, "  validate:", "          if [ -n \"$failures\" ]; then");

    expect(job).toContain("fromJSON(needs.runners.outputs.runs_on).windows_tools");
    expect(job).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).windows_tools)");
    expect(job).toContain("fromJSON(needs.plan.outputs.run).windows_tools_pack_payload_tests");
    expect(job).toContain("pnpm --filter @mish/tools-pack exec vitest run tests/launcher/windows/payload.test.ts");
    expect(validate).toContain("windows_tools_pack_payload_tests");
  });

  it("[P2] limits manual blob guard checks to changed files against main", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const blobGuard = sectionBetween(workflow, "  static_gate:", "  preflight:");

    expect(blobGuard).toContain('${{ github.event_name }}" = "workflow_dispatch"');
    expect(blobGuard).toContain("repos/${{ github.repository }}/compare/main...${{ github.sha }}");
    expect(blobGuard).toContain("select(.status != \"removed\") | .filename");
  });

  it("[P1] runs no ci workload on draft PRs and fails the required gate closed", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const trigger = sectionBetween(workflow, "on:", "\npermissions:");
    const draftGate = "github.event_name != 'pull_request' || github.event.pull_request.draft == false";

    expect(trigger).toContain("types: [opened, synchronize, reopened, ready_for_review]");
    expect(trigger).not.toContain("converted_to_draft");
    // ready_for_review shares the PR concurrency group, so it cancels an older run of the PR.
    expect(workflow).toContain("group: ci-${{ github.event_name == 'workflow_dispatch' && github.run_id || github.event.pull_request.number || github.ref }}");

    // Walk every job. A job may run on a draft only if it is the draft-gated root, depends
    // on that root (a skipped need skips it, since its if: does not use always()), or is
    // the required gate, which must fail on a draft rather than skip: GitHub counts a
    // skipped required check as passing.
    const jobsBody = workflow.slice(workflow.indexOf("\njobs:\n") + "\njobs:\n".length);
    const jobBlocks = [...jobsBody.matchAll(/^ {2}([a-z0-9_]+):\n([\s\S]*?)(?=^ {2}[a-z0-9_]+:\n|(?![\s\S]))/gm)];
    const jobs = new Map(jobBlocks.map((match) => [match[1] ?? "", match[2] ?? ""]));
    expect(jobs.size).toBeGreaterThan(10);
    const jobIf = (body: string) => body.match(/^ {4}if: (.*)$/m)?.[1] ?? "";
    const jobNeeds = (body: string): string[] => {
      const inline = body.match(/^ {4}needs: \[(.*)\]$/m);
      if (inline) return (inline[1] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
      const block = body.match(/^ {4}needs:\n((?: {6}- .*\n)+)/m);
      return block ? [...(block[1] ?? "").matchAll(/- ([a-z0-9_]+)/g)].map((match) => match[1] ?? "") : [];
    };

    expect(jobIf(jobs.get("runners") ?? "")).toBe(`\${{ ${draftGate} }}`);
    for (const [name, body] of jobs) {
      if (name === "runners" || name === "validate") continue;
      const condition = jobIf(body);
      expect(jobNeeds(body), `${name} must depend on the draft-gated runners job`).toContain("runners");
      if (condition.includes("always()")) {
        expect(condition, `${name} uses always() and must repeat the draft gate`).toContain(`(${draftGate})`);
      }
    }

    const validate = jobs.get("validate") ?? "";
    expect(jobIf(validate)).toBe("${{ always() }}");
    // Without a runner profile (draft path) the gate still needs somewhere to run.
    expect(validate).toContain("runs-on: ${{ needs.runners.result == 'success' && fromJSON(needs.runners.outputs.runs_on).control || 'ubuntu-24.04' }}");
    const deferStep = sectionBetween(validate, "      - name: Defer validation on draft PRs", "      - name: Check workspace validation jobs");
    expect(deferStep).toContain("if: ${{ github.event_name == 'pull_request' && github.event.pull_request.draft }}");
    expect(deferStep).toContain("exit 1");
  });

  it("[P2] captures merge-queue CI failures in diagnostic artifacts", async () => {
    const ciWorkflow = await readFile(ciWorkflowPath, "utf8");
    const mergePolicy = sectionBetween(ciWorkflow, "  merge_policy:", "  validate:");
    const validate = sectionBetween(ciWorkflow, "  validate:", "  runtime_summary:");

    // The label gate tells the generic diagnostic whether it already captured this ejection.
    expect(mergePolicy).toContain(
      "ejection_notice: ${{ steps.merge_blocking_label_gate.outputs.comment_created }}",
    );
    expect(validate).toContain("LABEL_NOTICE_EMITTED: ${{ needs.merge_policy.outputs.ejection_notice }}");

    // Producer: merge-group only, only after the gate has already failed, unable to change the
    // gate result, and uploaded on the failure path exactly like the label notice.
    expect(validate).toContain("<!-- merge-queue-ci-failure -->");
    expect(validate).toContain("if: ${{ failure() && github.event_name == 'merge_group' }}");
    expect(validate).toContain("continue-on-error: true");
    expect(validate).toContain(
      "if: ${{ failure() && steps.merge_queue_failure_notice.outputs.comment_created == 'true' }}",
    );
    // It sits after validation so the success path is untouched and the gate's own jq
    // programs stay isolated (see extractValidateGateJqPrograms).
    const gateIndex = validate.indexOf("Check workspace validation jobs");
    expect(gateIndex).toBeGreaterThanOrEqual(0);
    expect(gateIndex).toBeLessThan(validate.indexOf("Produce merge-queue failure notice handoff"));

    // Behavior: run the real step script against a stubbed `gh`, then read the handoff it
    // produced through the retained handoff validator.
    const script = extractWorkflowRunScript(ciWorkflow, "Produce merge-queue failure notice handoff");
    const prHead = "4821c4ee".padEnd(40, "0");
    const prBase = "1a7a23d4".padEnd(40, "0");
    const groupHead = "e3051e63".padEnd(40, "0");
    const runId = "32105196624";
    const planRun = JSON.stringify({ static_gate: true, daemon_unit_tests: true, e2e_vitest: false });
    const esc = String.fromCharCode(27);
    const failedShardLog = [
      `2026-08-18T06:05:15.3329113Z ${esc}[31m⎯⎯⎯ Failed Tests 1 ⎯⎯⎯${esc}[39m`,
      `2026-08-18T06:05:15.3330283Z ${esc}[41m${esc}[1m FAIL ${esc}[22m${esc}[49m tests/project-archive.test.ts > buildProjectArchive > exposes a consumable stream with the same archive contents`,
      `2026-08-18T06:05:15.3333182Z ${esc}[31mAssertionError: expected [ Array(6) ] to deeply equal [ 'DESIGN-HANDOFF.md', …(4) ]${esc}[39m`,
      "2026-08-18T06:05:15.3398469Z ##[error]AssertionError: expected [ Array(6) ] to deeply equal [ 'DESIGN-HANDOFF.md', …(4) ]",
      "2026-08-18T06:05:15.4000000Z ##[error]Process completed with exit code 1.",
      "",
    ].join("\n");

    async function runNotice(args: {
      needs: Record<string, unknown>;
      labelNoticeEmitted?: string;
      labels?: string[];
      mergePolicyConclusion?: string;
      // gh >= 2.97 refuses to print a body with terminal escape sequences unless
      // `--allow-escape-sequences` is passed; older gh rejects that flag as unknown.
      ghSupportsEscapeFlag?: boolean;
    }): Promise<{
      stdout: string;
      output: Record<string, string>;
      listed: Array<Record<string, unknown>>;
      body: string;
    }> {
      const dir = await mkdtemp(join(tmpdir(), "od-merge-queue-notice-"));
      const ghPath = join(dir, "gh");
      const outputPath = join(dir, "github-output");
      const runnerTemp = join(dir, "runner-temp");
      await mkdir(runnerTemp);
      await writeFile(outputPath, "");
      const mergePolicyConclusion = args.mergePolicyConclusion ?? "success";
      const fixtures = {
        pull: {
          head: { sha: prHead },
          base: { sha: prBase },
          labels: (args.labels ?? []).map((name) => ({ name })),
        },
        jobs: {
          jobs: [
            {
              id: 101,
              name: "Daemon tests (1/4)",
              conclusion: "failure",
              html_url: `https://github.com/ZeroSum-Solutions/mish/actions/runs/${runId}/job/101`,
              steps: [
                { name: "Checkout", conclusion: "success" },
                { name: "Run daemon test shard", conclusion: "failure" },
              ],
            },
            { id: 102, name: "Daemon tests (2/4)", conclusion: "success", html_url: "", steps: [] },
            {
              id: 103,
              name: "Merge policy",
              conclusion: mergePolicyConclusion,
              html_url: `https://github.com/ZeroSum-Solutions/mish/actions/runs/${runId}/job/103`,
              steps: [{ name: "Block merge while a merge-blocking label is present", conclusion: mergePolicyConclusion }],
            },
            // Replaying a completed run reports the gate itself as failed; it must never be listed.
            { id: 104, name: "Validate workspace", conclusion: "failure", html_url: "", steps: [] },
          ],
        },
        compare: {
          commits: [
            { commit: { message: "fix(daemon): keep daemon as sole writer of run events (#6559)\n\nbody" } },
            { commit: { message: "fix(daemon): list dot-prefixed user content in managed projects (#6214)" } },
          ],
        },
        logs: failedShardLog,
      };
      const supportsEscapeFlag = args.ghSupportsEscapeFlag ?? true;
      await writeFile(
        ghPath,
        `#!/usr/bin/env node
const fixtures = JSON.parse(process.env.FAKE_GH_FIXTURES);
const supportsEscapeFlag = ${supportsEscapeFlag ? "true" : "false"};
const argv = process.argv.slice(2);
const args = argv.join(" ");
const hasEscapeFlag = argv.includes("--allow-escape-sequences");
if (args === "--version") process.stdout.write(supportsEscapeFlag ? "gh version 2.98.0 (fake)\\n" : "gh version 2.87.3 (fake)\\n");
// Real help text is long: a probe that lets grep exit early would SIGPIPE gh and, under
// pipefail, read as "flag unsupported". Pad well past the pipe buffer so that stays red.
else if (args === "api --help") process.stdout.write((supportsEscapeFlag ? "      --allow-escape-sequences   Allow printing terminal escape sequences\\n" : "      --cache duration           Cache the response\\n") + "      --padding\\n".repeat(8192));
else if (hasEscapeFlag && !supportsEscapeFlag) { process.stderr.write("unknown flag: --allow-escape-sequences\\n"); process.exit(1); }
else if (/\\/pulls\\/6214$/.test(args)) process.stdout.write(JSON.stringify(fixtures.pull));
else if (/\\/actions\\/runs\\/${runId}\\/jobs/.test(args)) process.stdout.write(JSON.stringify(fixtures.jobs));
else if (/\\/actions\\/jobs\\/\\d+\\/logs$/.test(args)) {
  // Real gh >= 2.97 behavior for a body full of ANSI codes: nothing on stdout, exit 1.
  if (supportsEscapeFlag && !hasEscapeFlag) { process.stderr.write("the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway\\n"); process.exit(1); }
  process.stdout.write(fixtures.logs);
}
else if (/\\/compare\\//.test(args)) process.stdout.write(JSON.stringify(fixtures.compare));
else { process.stderr.write("unexpected gh call: " + args + "\\n"); process.exit(1); }
`,
      );
      await chmod(ghPath, 0o755);
      try {
        const { stdout } = await execFileAsync("bash", ["-c", script], {
          cwd: workspaceRoot,
          env: workflowFixtureEnv(
            {
              GH_TOKEN: "fake",
              REPO: "ZeroSum-Solutions/mish",
              RUN_ID: runId,
              NEEDS_JSON: JSON.stringify(args.needs),
              MERGE_GROUP_REF: `gh-readonly-queue/main/pr-6214-${prBase}`,
              BASE_SHA: prBase,
              HEAD_SHA: groupHead,
              LABEL_NOTICE_EMITTED: args.labelNoticeEmitted ?? "",
              SELF_JOB_NAME: "Validate workspace",
              GITHUB_OUTPUT: outputPath,
              GITHUB_SERVER_URL: "https://github.com",
              RUNNER_TEMP: runnerTemp,
              FAKE_GH_FIXTURES: JSON.stringify(fixtures),
            },
            dir,
          ),
        });
        const output = parseGithubOutput(await readFile(outputPath, "utf8"));
        let listed: Array<Record<string, unknown>> = [];
        let body = "";
        if (output.comment_path) {
          const { stdout: listStdout } = await execFileAsync(
            "python3",
            [handoffScriptPath, "list", "comment", output.comment_path],
            { cwd: workspaceRoot },
          );
          listed = listStdout
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          body = await readFile(
            join(output.comment_path, "handoff", "comment", "merge-queue-ci-failure-pr-6214", "body.md"),
            "utf8",
          );
        }
        return { stdout, output, listed, body };
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }

    // A failed workload: one notice for the PR heading the group, naming the job, the step,
    // the failing assertion, the run, and the PR batched ahead of it.
    const workloadFailure = await runNotice({
      needs: {
        plan: { result: "success", outputs: { run: planRun } },
        merge_policy: { result: "success", outputs: { ejection_notice: "" } },
        static_gate: { result: "success" },
        daemon_unit_tests: { result: "failure" },
        e2e_vitest: { result: "skipped" },
      },
    });
    expect(workloadFailure.output.comment_created).toBe("true");
    expect(workloadFailure.output.comment_name).toBe("handoff-comment-merge-queue-ci-failure-pr-6214");
    expect(workloadFailure.listed).toHaveLength(1);
    expect(workloadFailure.listed[0]).toMatchObject({
      kind: "comment",
      id: "merge-queue-ci-failure-pr-6214",
      pr_number: 6214,
      head_sha: prHead,
      base_sha: prBase,
      run_id: 32105196624,
      marker: "<!-- merge-queue-ci-failure -->",
    });
    expect(workloadFailure.body).toContain("<!-- merge-queue-ci-failure -->");
    expect(workloadFailure.body).toContain(
      `[run ${runId}](https://github.com/ZeroSum-Solutions/mish/actions/runs/${runId})`,
    );
    expect(workloadFailure.body).toContain(
      `- **Daemon tests (1/4)** — failure at \`Run daemon test shard\` ([job log](https://github.com/ZeroSum-Solutions/mish/actions/runs/${runId}/job/101))`,
    );
    expect(workloadFailure.body).not.toContain("Daemon tests (2/4)");
    expect(workloadFailure.body).not.toContain("Validate workspace");
    expect(workloadFailure.body).toContain(
      "FAIL  tests/project-archive.test.ts > buildProjectArchive > exposes a consumable stream with the same archive contents",
    );
    expect(workloadFailure.body).toContain("AssertionError: expected [ Array(6) ]");
    expect(workloadFailure.body).not.toContain("Process completed with exit code");
    expect(workloadFailure.body).not.toContain(esc);
    expect(workloadFailure.body).toContain("queued ahead of it (#6559)");
    expect(workloadFailure.body).toContain("add the PR back to the merge queue");

    // A label-only ejection is already announced by the gate's notice: no second comment.
    const labelOnly = await runNotice({
      needs: {
        plan: { result: "success", outputs: { run: planRun } },
        merge_policy: { result: "failure", outputs: { ejection_notice: "true" } },
        static_gate: { result: "success" },
        daemon_unit_tests: { result: "success" },
      },
      labelNoticeEmitted: "true",
      labels: ["needs-validation"],
      mergePolicyConclusion: "failure",
    });
    expect(labelOnly.output.comment_created).toBeUndefined();
    expect(labelOnly.stdout).toContain("its own notice covers this ejection");

    // A workload that failed alongside a blocking label is still reported, without repeating
    // the policy job — and the live label alone is enough to recognize the label ejection.
    const labelPlusWorkload = await runNotice({
      needs: {
        plan: { result: "success", outputs: { run: planRun } },
        merge_policy: { result: "failure", outputs: { ejection_notice: "" } },
        static_gate: { result: "success" },
        daemon_unit_tests: { result: "failure" },
      },
      labels: ["needs-maintainer-check"],
      mergePolicyConclusion: "failure",
    });
    expect(labelPlusWorkload.output.comment_created).toBe("true");
    expect(labelPlusWorkload.body).toContain("**Daemon tests (1/4)**");
    expect(labelPlusWorkload.body).not.toContain("Merge policy");

    // A runner whose gh predates the escape-sequence policy must still get the excerpt: the
    // probe finds no flag and the plain fetch is used.
    const olderGh = await runNotice({
      needs: {
        plan: { result: "success", outputs: { run: planRun } },
        merge_policy: { result: "success", outputs: { ejection_notice: "" } },
        daemon_unit_tests: { result: "failure" },
      },
      ghSupportsEscapeFlag: false,
    });
    expect(olderGh.output.comment_created).toBe("true");
    expect(olderGh.body).toContain("FAIL  tests/project-archive.test.ts");
    expect(olderGh.stdout).toContain("gh version 2.87.3 (fake)");
  }, T.medium);
  it("[P2] keeps the backport patch-equivalence gate whitespace-sensitive", async () => {
    const compactDiff = [
      "diff --git a/script.py b/script.py",
      "--- a/script.py",
      "+++ b/script.py",
      "@@ -1 +1 @@",
      "-print(1)",
      "+print(2)",
      "",
    ].join("\n");
    const whitespaceDiff = [
      "diff --git a/script.py b/script.py",
      "--- a/script.py",
      "+++ b/script.py",
      "@@ -1 +1 @@",
      "-print(1)",
      "+ print(2)",
      "",
    ].join("\n");

    const compactStable = await gitPatchId("--stable", compactDiff);
    const whitespaceStable = await gitPatchId("--stable", whitespaceDiff);
    const compactVerbatim = await gitPatchId("--verbatim", compactDiff);
    const whitespaceVerbatim = await gitPatchId("--verbatim", whitespaceDiff);

    expect(compactStable).toBe(whitespaceStable);
    expect(compactVerbatim).not.toBe(whitespaceVerbatim);
  });

  it("[P2] keeps PR and merge queue CI separated by hot/full validation mode", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const plan = sectionBetween(workflow, "  plan:", "  static_gate:");
    const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");

    expect(workflow).toContain("ci_mode:");
    expect(plan).toContain("run: ${{ steps.scopes.outputs.run }}");
    expect(plan).toContain("scopes: ${{ steps.scopes.outputs.scopes }}");
    expect(workflow).toContain("fromJSON(needs.plan.outputs.run).ui_p0");
    expect(validate).toContain("[$run | to_entries[] | select(.value) | .key]");

    await expect(runScopesPrint("workflow_dispatch", { inputs: { ci_mode: "hot" } }, ["apps/web/src/app/page.tsx"])).resolves.toMatchObject({
      ci_mode: "hot",
      run_ui_p0: true,
      run_playwright_critical: false,
    });
    await expect(runScopesPrint("workflow_dispatch", { inputs: { ci_mode: "hot" } }, ["tools/dev/src/index.ts"])).resolves.toMatchObject({
      ci_mode: "hot",
      run_ui_p0: false,
      run_playwright_critical: true,
    });
    await expect(runScopesPrint("workflow_dispatch", { inputs: {} })).resolves.toMatchObject({
      ci_mode: "full",
      ui_p0_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
      run_preflight: true,
    });
    await expect(runScopesPrint("merge_group", {})).resolves.toMatchObject({
      ci_mode: "full",
      ui_p0_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
      run_preflight: true,
    });
    // Docker packaging is not part of core scopes / Validate workspace.
    for (const plan of await Promise.all([
      runScopesPrint("merge_group", {}),
      runScopesPrint("workflow_dispatch", { inputs: {} }),
      runScopesPrint("pull_request", { pull_request: { number: 1 } }, ["apps/web/src/app/page.tsx"]),
    ])) {
      expect(plan).not.toHaveProperty("run_docker_build");
      expect(plan).not.toHaveProperty("docker_validation_required");
    }
  });

  it("[P2] closes packaged-leaf coverage without duplicating the broad E2E lane", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const workspaceUnit = sectionBetween(workflow, "  workspace_unit_tests:", "  daemon_unit_tests:");

    expect(workspaceUnit).toContain(`if [ "\${{ fromJSON(needs.plan.outputs.scopes).tools_pack_tests_required }}" = "true" ]; then
            pnpm --filter @mish/desktop build
            pnpm --filter @mish/desktop test
            pnpm --filter @mish/packaged test
            pnpm --filter @mish/tools-pack test
            if [ "\${{ fromJSON(needs.plan.outputs.run).e2e_vitest }}" != "true" ]; then
              pnpm --filter @mish/e2e test tests/packaged-launcher-update-loop.test.ts
            fi
          fi`);
  });

  it("[P1] runs the complete daemon suite in six required shards", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const daemonTests = sectionBetween(workflow, "  daemon_unit_tests:", "  windows_tools_pack_payload_tests:");
    const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");

    expect(daemonTests).toContain("if: ${{ fromJSON(needs.plan.outputs.run).daemon_unit_tests }}");
    expect(daemonTests).toContain("fail-fast: false");
    expect(daemonTests).toContain("shard: [1, 2, 3, 4, 5, 6]");
    expect(daemonTests).toContain("pnpm --filter @mish/daemon test --shard=${{ matrix.shard }}/6");
    expect(validate).toContain("- daemon_unit_tests");
    expect(validate).toContain("[$run | to_entries[] | select(.value) | .key]");
  });

  it("[P2] skips the critical fallback for pure packaged-leaf changes and stays fail-closed elsewhere", async () => {
    const hot = { inputs: { ci_mode: "hot" } };

    // Playwright never starts the desktop, packaged, or tools-pack
    // entrypoints, so a change confined to those leaf roots keeps its
    // package tests but must not pay the two-job critical fallback.
    for (const file of [
      "apps/desktop/src/main.ts",
      "apps/packaged/src/index.ts",
      "tools/pack/src/win/installer.ts",
    ]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_playwright_critical: false,
        run_ui_p0: false,
        tools_dev_tests_required: true,
        tools_pack_tests_required: true,
        ui_critical_validation_required: false,
        workspace_validation_required: true,
      });
    }

    const mergeGroup = {
      merge_group: {
        base_sha: "1111111111111111111111111111111111111111",
        head_sha: "2222222222222222222222222222222222222222",
      },
    };
    await expect(runScopesPrint("merge_group", mergeGroup, ["apps/desktop/src/main.ts"])).resolves.toMatchObject({
      run_e2e_vitest: false,
      run_playwright_critical: false,
      run_playwright_visual: false,
      run_ui_p0: false,
      run_web_workspace_tests: false,
      run_windows_tools_pack_payload_tests: false,
      tools_dev_tests_required: true,
      tools_pack_tests_required: true,
      windows_tools_pack_payload_tests_required: false,
      workspace_validation_required: true,
    });

    await expect(runScopesPrint("merge_group", mergeGroup, ["tools/pack/src/mac/app.ts"])).resolves.toMatchObject({
      run_windows_tools_pack_payload_tests: false,
      tools_pack_tests_required: true,
      windows_tools_pack_payload_tests_required: false,
    });

    await expect(runScopesPrint("merge_group", mergeGroup, ["tools/pack/src/win/custom-installer.ts"])).resolves.toMatchObject({
      run_windows_tools_pack_payload_tests: true,
      tools_pack_tests_required: true,
      windows_tools_pack_payload_tests_required: true,
    });

    await expect(runScopesPrint("merge_group", mergeGroup, ["packages/launcher-proto/src/index.ts"])).resolves.toMatchObject({
      run_windows_tools_pack_payload_tests: true,
      windows_tools_pack_payload_tests_required: true,
    });

    await expect(runScopesPrint("merge_group", mergeGroup, ["apps/desktop/package.json"])).resolves.toMatchObject({
      run_e2e_vitest: true,
      run_playwright_visual: true,
      run_ui_p0: true,
      run_web_workspace_tests: true,
    });

    // Fail-closed: anything that can reach the Playwright runtime — tools-dev,
    // transitive packages (including the undeclared metatool edge), scripts,
    // runtime resources, or unknown roots — retains the fallback.
    for (const file of [
      "tools/dev/src/index.ts",
      "packages/metatool/src/index.ts",
      "packages/agui-adapter/src/adapter.ts",
      "packages/diagnostics/src/index.ts",
      "packages/plugin-runtime/src/index.ts",
      "packages/registry-protocol/src/index.ts",
      "scripts/guard.ts",
      "mocks/bin/opencode",
      "some-new-root/file.ts",
    ]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_playwright_critical: true,
        ui_critical_validation_required: true,
      });
    }

    // A mixed leaf + runtime change retains the fallback.
    await expect(
      runScopesPrint("workflow_dispatch", hot, ["apps/desktop/src/main.ts", "tools/dev/src/index.ts"]),
    ).resolves.toMatchObject({
      run_playwright_critical: true,
      ui_critical_validation_required: true,
    });

    // Root manifest/lock/workspace files keep enabling P0, which retains the
    // existing critical/P0 mutual exclusion.
    for (const file of ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml"]) {
      await expect(runScopesPrint("workflow_dispatch", hot, [file])).resolves.toMatchObject({
        run_ui_p0: true,
        run_playwright_critical: false,
      });
    }

    // Documentation-only changes stay exempt from both.
    await expect(runScopesPrint("workflow_dispatch", hot, ["docs/spec.md"])).resolves.toMatchObject({
      run_playwright_critical: false,
      ui_critical_validation_required: false,
      workspace_validation_required: false,
    });

    // merge_group/full behavior is unchanged: everything is required and the
    // matrix covers critical, so the fallback stays off.
    await expect(runScopesPrint("merge_group", {})).resolves.toMatchObject({
      ci_mode: "full",
      ui_critical_validation_required: true,
      run_playwright_critical: false,
      run_ui_p0: true,
    });
  }, T.medium);

  it("[P2] keeps Docker packaging off the core Validate workspace gate", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const validate = sectionBetween(workflow, "  validate:", "  runtime_summary:");

    expect(workflow).not.toContain("docker_pr:");
    expect(validate).not.toContain("docker_pr");
    expect(validate).not.toContain("run_docker_build");
    expect(validate).toContain("Check workspace validation jobs");

    const baseRun = {
      static_gate: false,
      preflight: false,
      workspace_unit_tests: false,
      daemon_unit_tests: false,
      windows_tools_pack_payload_tests: false,
      web_workspace_tests: false,
      e2e_vitest: false,
      playwright_critical: false,
      ui_p0: false,
      playwright_visual: false,
    };
    // Core gate only cares about app jobs — unknown packaging keys are ignored.
    await expect(
      validateGatePasses(workflow, {
        plan: { result: "success", outputs: { run: JSON.stringify(baseRun) } },
        merge_policy: { result: "skipped" },
      }),
    ).resolves.toBe(true);

    await expect(
      validateGatePasses(workflow, {
        plan: { result: "success", outputs: { run: JSON.stringify(baseRun) } },
        merge_policy: { result: "success" },
      }),
    ).resolves.toBe(true);

    await expect(
      validateGatePasses(workflow, {
        plan: { result: "success", outputs: { run: JSON.stringify(baseRun) } },
        merge_policy: { result: "failure" },
      }),
    ).resolves.toBe(false);

    const needsWithFailedWeb = {
      plan: { result: "success", outputs: { run: JSON.stringify({ ...baseRun, web_workspace_tests: true }) } },
      web_workspace_tests: { result: "failure" },
    };
    await expect(validateGatePasses(workflow, needsWithFailedWeb)).resolves.toBe(false);
  });

  it("[P2] routes Linux CI through GitHub-hosted runners", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const runners = sectionBetween(workflow, "  runners:", "  plan:");
    const plan = sectionBetween(workflow, "  plan:", "  static_gate:");
    const staticGate = sectionBetween(workflow, "  static_gate:", "  preflight:");
    const workspaceUnitTests = sectionBetween(workflow, "  workspace_unit_tests:", "  daemon_unit_tests:");
    const daemonUnitTests = sectionBetween(workflow, "  daemon_unit_tests:", "  windows_tools_pack_payload_tests:");
    const webWorkspaceTests = sectionBetween(workflow, "  web_workspace_tests:", "  e2e_vitest:");
    const e2eVitest = sectionBetween(workflow, "  e2e_vitest:", "  playwright_critical:");
    const preflight = sectionBetween(workflow, "  preflight:", "  workspace_unit_tests:");
    const uiP0 = sectionBetween(workflow, "  ui_p0:", "  playwright_visual:");
    const visual = sectionBetween(workflow, "  playwright_visual:", "  merge_policy:");

    expect(runners).toContain("runs-on: ubuntu-24.04");
    expect(runners).not.toContain("blacksmith-");
    expect(runners).toContain("runs_on: ${{ steps.runners.outputs.runs_on }}");
    expect(runners).toContain("decision: ${{ steps.runners.outputs.decision }}");
    expect(runners).toContain("python3 .github/scripts/runners.py");
    expect(plan).toContain("needs: [runners]");
    expect(plan).toContain("fromJSON(needs.runners.outputs.runs_on).control");
    expect(staticGate).toContain("needs: [plan, runners]");
    expect(staticGate).toContain("fromJSON(needs.runners.outputs.runs_on).control");
    expect(workspaceUnitTests).toContain("fromJSON(needs.runners.outputs.runs_on).workspace_unit");
    expect(workspaceUnitTests).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).workspace_unit)");
    expect(daemonUnitTests).toContain("fromJSON(needs.runners.outputs.runs_on).workspace_unit");
    expect(daemonUnitTests).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).workspace_unit)");
    expect(webWorkspaceTests).toContain("fromJSON(needs.runners.outputs.runs_on).js_hot");
    expect(webWorkspaceTests).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).js_hot)");
    expect(webWorkspaceTests).not.toContain('"od-persistent-ci"');
    // Pin two-way vitest sharding so a later YAML edit cannot collapse the split or restore the
    // monolithic `pnpm --filter @mish/web test` command while this suite still passes.
    expect(webWorkspaceTests).toContain("fail-fast: false");
    expect(webWorkspaceTests).toContain("shard: [1, 2]");
    expect(webWorkspaceTests).toContain(
      "pnpm --filter @mish/web exec vitest run -c vitest.config.ts --maxWorkers=2 --shard=${{ matrix.shard }}/2",
    );
    expect(e2eVitest).toContain("fromJSON(needs.runners.outputs.runs_on).js_hot");
    expect(e2eVitest).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).js_hot)");
    expect(e2eVitest).not.toContain('"od-persistent-ci"');
    expect(preflight).toContain("fromJSON(needs.runners.outputs.runs_on).general_medium");
    expect(preflight).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).general_medium)");
    expect(uiP0).toContain("fromJSON(needs.runners.outputs.runs_on).ui_p0");
    expect(uiP0).toContain("fromJSON(needs.runners.outputs.runs_on).ui_p0_heavy");
    expect(uiP0).toContain("startsWith(matrix.shard, 'project-collab')");
    expect(uiP0).toContain("matrix.shard == 'project-workspace-design-system'");
    expect(uiP0).toContain(
      "toJSON((startsWith(matrix.shard, 'project-collab') || matrix.shard == 'project-workspace-design-system') && fromJSON(needs.runners.outputs.runs_on).ui_p0_heavy || fromJSON(needs.runners.outputs.runs_on).ui_p0)",
    );
    expect(uiP0).toContain("include: ${{ fromJSON(needs.plan.outputs.ui_p0_matrix) }}");
    expect(uiP0CiMatrix.map((entry) => entry.name)).toEqual([
      "entry-onboarding",
      "entry-settings",
      "project-workspace",
      "project-workspace-editor",
      "project-workspace-design-system",
      "project-collab-health",
      "project-collab",
      "project-runtime",
      "workspace-restoration",
    ]);
    expect(uiP0Groups["project-workspace"].files).toEqual([
      "ui/app.test.ts",
      // Enrolled 2026-09-08: the fork divider's ellipsis is only observable in
      // a real browser at a constrained width, so an unenrolled P1 would ship
      // a witness nothing on the merge path ever executes.
      "ui/fork-note-ellipsis.test.ts",
      "ui/project-management-flows.test.ts",
      "ui/workspace-keyboard-flows.test.ts",
      "ui/workbench-resource-preview.test.ts",
      "ui/workbench-file-intake.test.ts",
    ]);
    expect(uiP0Groups["project-workspace"].workers).toBe(1);
    expect(uiP0Groups["project-workspace-editor"]).toEqual({
      grep: String.raw`\[P0\]`,
      workers: 1,
      files: [
        "ui/app-design-files.test.ts",
        "ui/app-manual-edit.test.ts",
      ],
    });
    expect(uiP0Groups["project-workspace-design-system"]).toEqual({
      grep: String.raw`\[P0\]`,
      workers: 1,
      files: ["ui/workspace-team-design-system-picker.test.ts"],
    });
    expect(uiP0Groups["project-collab-health"]).toEqual({
      grep: String.raw`\[P0\] strict SSE health suppresses authority reads and bounds event storms per account`,
      workers: 1,
      files: ["ui/workspace-multi-client-collab.test.ts"],
    });
    expect(uiP0Groups["project-collab"]).toEqual({
      grep: String.raw`\[P0\](?! strict SSE health suppresses authority reads and bounds event storms per account)`,
      workers: 1,
      files: ["ui/workspace-multi-client-collab.test.ts"],
    });
    expect(uiP0SharedFilePartitions).toEqual({
      "ui/workspace-multi-client-collab.test.ts": ["project-collab-health", "project-collab"],
    });
    expect(uiP0Groups["critical-extras"]).toEqual({
      grep: "@merge-extra",
      workers: 1,
      files: ["ui/app.test.ts"],
    });
    expect(uiP0Groups["workspace-restoration"]).toEqual({
      fullyParallel: true,
      grep: String.raw`\[P0\]`,
      files: ["ui/app-restoration.test.ts", "ui/critical-smoke.test.ts"],
    });
    expect(uiP0Groups["entry-onboarding"].files).toContain("ui/home-hero-rail.test.ts");
    // AC-R02 Home/canvas session model binding journey (W3 box 4) runs on the
    // merge path next to the picker roundtrip it extends.
    expect(uiP0Groups["entry-settings"].files).toContain("ui/workbench-session-model-binding.test.ts");
    expect(workflow).not.toContain("  ui_p0_smoke:");
    expect(uiP0).toContain("run-ui-group critical-extras");
    expect(uiP0).toContain("Preserve project-runtime domain artifact");
    expect(visual).toContain("fromJSON(needs.runners.outputs.runs_on).visual_hot");
    expect(visual).toContain("toJSON(fromJSON(needs.runners.outputs.runs_on).visual_hot)");
    // visual-pr-capture-* is consumed by report.atom.yml; pin retain-on-failure traces so a
    // later YAML edit cannot drop e2e/ui/reports/visual-test-results while the suite still passes.
    expect(visual).toContain(
      "name: visual-pr-capture-${{ github.event.pull_request.number }}-${{ github.run_id }}-${{ matrix.name }}",
    );
    expect(visual).toContain("name: visual-ci-${{ github.run_id }}-${{ matrix.name }}");
    expect(visual).toContain("e2e/ui/reports/visual-test-results");
    // Both PR and manual upload path lists include retain-on-failure diagnostics.
    expect(visual.match(/e2e\/ui\/reports\/visual-test-results/g)?.length).toBe(2);
    expect(workflow).not.toContain("needs.runners.outputs.contabo_control");
    expect(workflow).not.toContain("needs.runners.outputs.hosted_or_blacksmith");
    expect(workflow).not.toContain("needs.runners.outputs.blacksmith_default");
  });

  it("[P2] caps Playwright concurrency independently from build concurrency", async () => {
    const action = await readFile(configureCiParallelismActionPath, "utf8");

    expect(action).toContain('playwright_workers="$workers"');
    expect(action).toContain('if [ "$playwright_workers" -gt 2 ]; then');
    expect(action).toContain("playwright_workers=2");
    expect(action).toContain('echo "OD_PLAYWRIGHT_WORKERS=$playwright_workers"');
    expect(action).toContain('echo "MISH_WORKSPACE_CONCURRENCY=$workers"');
  });

  it("[P1] routes external fork PRs through GitHub-hosted runner profiles", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const runners = sectionBetween(workflow, "  runners:", "  plan:");

    expect(runners).toContain("runs-on: ubuntu-24.04");
    expect(runners).toContain("OD_CI_RUNNER_MODE: economic");
    expect(runners).not.toContain("vars.");
  });

  it("[P1] pins ShellCheck for actionlint across runner profiles", async () => {
    const workflow = await readFile(ciWorkflowPath, "utf8");
    const staticGate = sectionBetween(workflow, "  static_gate:", "  preflight:");

    expect(staticGate).toContain("SHELLCHECK_VERSION: 0.11.0");
    expect(staticGate).toContain("shellcheck_arch=x86_64");
    expect(staticGate).toContain("shellcheck_arch=aarch64");
    expect(staticGate).toContain(
      'koalaman/shellcheck/releases/download/v${SHELLCHECK_VERSION}/shellcheck-v${SHELLCHECK_VERSION}.linux.${shellcheck_arch}.tar.gz',
    );
    expect(staticGate).toContain("sudo install -m 0755 shellcheck /usr/local/bin/shellcheck");
    expect(staticGate).toContain("run: actionlint -color");
  });

  it("[P2] rejects duplicate file assignments across UI P0 shards", () => {
    const files = uiP0Groups["workspace-restoration"].files as unknown as string[];
    files.push("ui/app.test.ts");
    try {
      expect(validatePlaywrightSuiteTopology()).toContain(
        "UI P0 CI matrix covers ui/app.test.ts more than once",
      );
    } finally {
      files.pop();
    }
  });

  it("[P2] accepts only the declared exact shared-file UI P0 partition", () => {
    expect(validatePlaywrightSuiteTopology()).toEqual([]);

    const files = uiP0Groups["workspace-restoration"].files as unknown as string[];
    files.push("ui/workspace-multi-client-collab.test.ts");
    try {
      expect(validatePlaywrightSuiteTopology()).toContain(
        "UI P0 CI matrix partition for ui/workspace-multi-client-collab.test.ts must be exactly project-collab-health, project-collab; received project-collab-health, project-collab, workspace-restoration",
      );
    } finally {
      files.pop();
    }
  });

  it("[P2] resolves CI runner profiles by mode", async () => {
    for (const mode of [undefined, 'default', 'performance', 'economic', 'blacksmith']) {
      const profiles = await runRunners(mode);
      const runsOn = runnerRunsOn(profiles);
      expect(runnerDecision(profiles)).toEqual({
        schema_version: 1, mode: mode === 'default' ? 'default' : 'economic',
      });
      expect(Object.keys(runsOn).sort()).toEqual([
        'control', 'general_medium', 'js_hot', 'ui_hot', 'ui_p0',
        'ui_p0_heavy', 'visual_hot', 'windows_tools', 'workspace_unit',
      ]);
      for (const [runnerClass, labels] of Object.entries(runsOn)) {
        expect(labels).toEqual([runnerClass === 'windows_tools' ? 'windows-latest' : 'ubuntu-24.04']);
      }
    }

    for (const invalidMode of ["Economic", " economic "]) {
      await expect(runRunners(invalidMode)).rejects.toThrow("unknown runner mode");
    }
  });

  it("[P2] rejects the retired AWS runner mode", async () => {
    await expect(runRunners("aws")).rejects.toThrow("unknown runner mode");
  });

  it("[P1] keeps infra-cancel rerun eligibility gates unit-tested", async () => {
    const { stdout, stderr } = await execFileAsync("python3", [rerunInfraCancelScriptPath, "self-check"], {
      cwd: workspaceRoot,
    });
    expect(stderr).toBe("");
    expect(stdout).toContain("rerun_infra_cancel self-check OK");
  });

  it("[P2] retires dedicated betas and preview release entrypoints", () => {
    for (const path of [
      join(workspaceRoot, ".github", "workflows", "release-beta-s.yml"),
      join(workspaceRoot, ".github", "workflows", "release-preview.yml"),
      join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-betas.ts"),
      join(workspaceRoot, "tools", "release", "src", "metadata", "prepare-preview.ts"),
    ]) {
      expect(existsSync(path), path).toBe(false);
    }
  });

  it("[P2] rejects stable release runs without the release version branch", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "main",
      MISH_STABLE_VERSION: "",
    });

    expect(output).toContain("release-stable requires GITHUB_REF_NAME to be release/vX.Y.Z; got main");
  });

  it("[P2] ignores explicit stable version inputs in favor of the release branch gate", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "main",
      MISH_STABLE_VERSION: "0.10.1",
    });

    expect(output).toContain("release-stable requires GITHUB_REF_NAME to be release/vX.Y.Z; got main");
  });

  it("[P2] reads beta metadata.json written with releaseVersion/releaseNumber field names", async () => {
    // The unified publisher refactor (.github/workflow/scripts/release/storage)
    // and the in-flight tools-release rewrite stamp beta/latest/metadata.json
    // with generic releaseVersion/releaseNumber fields instead of the legacy
    // betaVersion/betaNumber. tools-release's daily-beta reader must accept
    // those aliases or the scheduled build dies at metadata time.
    const packagedVersion = JSON.parse(
      await readFile(join(workspaceRoot, "apps", "packaged", "package.json"), "utf8"),
    ).version as string;

    const objects: Record<string, unknown> = {
      "stable/latest/metadata.json": { channel: "stable", stableVersion: "0.0.1" },
      "beta/latest/metadata.json": {
        baseVersion: packagedVersion,
        channel: "beta",
        releaseNumber: 4,
        releaseVersion: `${packagedVersion}-beta.4`,
      },
    };
    const fixture = await startStablePrereleaseMetadataServer(objects);
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-beta-reader-"));
    const outputPath = join(runnerTemp, "outputs.txt");

    try {
      const result = await execFileAsync(process.execPath, ["--experimental-strip-types", releaseBetaScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          GITHUB_OUTPUT: outputPath,
          GITHUB_REF_NAME: "main",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          MISH_BETA_METADATA_URL: `${fixture.origin}/beta/latest/metadata.json`,
          MISH_STABLE_METADATA_URL: `${fixture.origin}/stable/latest/metadata.json`,
        },
        maxBuffer: 1024 * 1024,
      });

      expect(result.stdout).toContain(`[release-beta] beta version: ${packagedVersion}-beta.5`);
      const outputs = await readFile(outputPath, "utf8");
      expect(outputs).toContain(`beta_version=${packagedVersion}-beta.5`);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it.skip("[P1] lets the daily main build recover a shared beta advanced by a feature branch", async () => {
    const packagedVersion = "1.2.3";
    const foreignAheadBaseVersion = "1.3.0";
    const objects: Record<string, unknown> = {
      "beta/latest/metadata.json": {
        baseVersion: foreignAheadBaseVersion,
        channel: "beta",
        github: { branch: "feat/standalone-closure" },
        releaseNumber: 9,
        releaseVersion: `${foreignAheadBaseVersion}-beta.9`,
      },
    };
    const fixture = await startStablePrereleaseMetadataServer(objects);
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-beta-foreign-recovery-"));
    const outputPath = join(runnerTemp, "outputs.txt");
    const baseEnv = {
      ...process.env,
      BUILD_REF: "main",
      GITHUB_OUTPUT: outputPath,
      GITHUB_RUN_NUMBER: "4242",
      NODE_TLS_REJECT_UNAUTHORIZED: "0",
      MISH_BETA_METADATA_URL: `${fixture.origin}/beta/latest/metadata.json`,
      PACKAGED_VERSION: packagedVersion,
    };

    try {
      const recovered = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", dailyBetaRecoveryScriptPath],
        {
          cwd: workspaceRoot,
          env: baseEnv,
          maxBuffer: 1024 * 1024,
        },
      );
      expect(recovered.stdout).toContain(
        "[daily-beta] recovering shared beta from foreign branch feat/standalone-closure",
      );
      const recoveryOutputs = await readFile(outputPath, "utf8");
      expect(recoveryOutputs).toContain("force=true");
      expect(recoveryOutputs).toContain("promote=false");
      expect(recoveryOutputs).toContain(`release_version=${packagedVersion}-beta.4242`);

      await writeFile(outputPath, "", "utf8");
      const featureBuild = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", dailyBetaRecoveryScriptPath],
        {
          cwd: workspaceRoot,
          env: { ...baseEnv, BUILD_REF: "feat/standalone-closure" },
          maxBuffer: 1024 * 1024,
        },
      );
      expect(featureBuild.stdout).toContain("[daily-beta] recovery disabled for non-main ref");
      const featureOutputs = await readFile(outputPath, "utf8");
      expect(featureOutputs).toContain("force=false");
      expect(featureOutputs).toContain("promote=true");
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("[P1] keeps download actions on a beta card with a failed Windows smoke", async () => {
    // notify-daily-feishu.yml is the only lane left that renders through
    // feishu.ts, and it is the one that forwards the two smoke results.
    const payload = await renderFeishuBuildCard({
      MAC_ARM64_SMOKE_RESULT: "success",
      MAC_ARM64_URL: "https://releases.example/mac.dmg",
      WIN_X64_SMOKE_RESULT: "failure",
      WIN_URL: "https://releases.example/windows.exe",
    });
    const card = payload.card as {
      elements: Array<{ actions?: Array<{ url?: string }>; text?: { content?: string } }>;
      header: { template?: string; title?: { content?: string } };
    };

    expect(card.header).toMatchObject({
      template: "orange",
      title: { content: expect.stringContaining("Windows x64 smoke 失败") },
    });
    expect(card.elements.map((element) => element.text?.content).filter(Boolean)).toContain(
      "**Smoke 告警**\n- Windows x64 smoke 失败\n\n产物已继续发布，可通过下方链接下载。",
    );
    expect(card.elements.flatMap((element) => element.actions ?? []).map((action) => action.url)).toEqual([
      "https://releases.example/mac.dmg",
      "https://releases.example/windows.exe",
    ]);
  });

  it("[P1] keeps download actions on a partial beta card without claiming latest promotion", async () => {
    const payload = await renderFeishuBuildCard({
      MAC_ARM64_URL: "https://releases.example/beta-mac.dmg",
      RELEASE_NOTE: "共享 beta/latest 版本高于 main，本次仅发布版本化快照。",
      RELEASE_STATE: "partial",
      VERSION: "0.18.2-beta.4242",
      WIN_URL: "https://releases.example/beta-windows.exe",
    });
    const card = payload.card as {
      elements: Array<{ actions?: Array<{ url?: string }>; text?: { content?: string } }>;
      header: { template?: string; title?: { content?: string } };
    };

    expect(card.header).toMatchObject({
      template: "orange",
      title: { content: expect.stringContaining("未更新 Beta latest") },
    });
    expect(card.elements.map((element) => element.text?.content).filter(Boolean)).toContain(
      "**渠道状态**\n产物已发布并可下载，但未更新 Beta latest。\n\n共享 beta/latest 版本高于 main，本次仅发布版本化快照。",
    );
    expect(card.elements.flatMap((element) => element.actions ?? []).map((action) => action.url)).toEqual([
      "https://releases.example/beta-mac.dmg",
      "https://releases.example/beta-windows.exe",
    ]);
  });

  it("[P2] writes stable release notes from the release public origin variable", async () => {
    for (const [envName, origin] of [
      ["RELEASE_PUBLIC_ORIGIN", "https://releases.mish.invalid/current/"],
      ["CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN", "https://releases.mish.invalid/legacy/"],
    ] as const) {
      const runnerTemp = await mkdtemp(join(tmpdir(), "od-stable-notes-"));
      const outputPath = join(runnerTemp, "github-output.txt");

      try {
        await execFileAsync("bash", [releaseStableNotesScriptPath], {
          cwd: workspaceRoot,
          env: workflowFixtureEnv({
            BRANCH_NAME: "release/v0.13.0",
            CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN: envName === "CLOUDFLARE_R2_RELEASES_PUBLIC_ORIGIN" ? origin : "",
            GITHUB_OUTPUT: outputPath,
            GITHUB_REPOSITORY: "ZeroSum-Solutions/mish",
            GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
            RELEASE_CHANNEL: "stable",
            RELEASE_PUBLIC_ORIGIN: envName === "RELEASE_PUBLIC_ORIGIN" ? origin : "",
            RELEASE_SIGNED: "true",
            RELEASE_VERSION: "0.13.0",
            RUNNER_TEMP: runnerTemp,
            VERSION_TAG: "mish-v0.13.0",
          }),
        });

        const outputs = parseGithubOutput(await readFile(outputPath, "utf8"));
        const notes = await readFile(outputs.notes_file ?? "", "utf8");
        expect(notes).toContain(`R2 metadata: ${origin.replace(/\/+$/, "")}/stable/latest/metadata.json`);
        expect(notes).toContain(`E2E report: ${origin.replace(/\/+$/, "")}/stable/versions/0.13.0/report.zip`);
      } finally {
        await rm(runnerTemp, { force: true, recursive: true });
      }
    }
  });

  it("[P2] validates stable dry-run prerelease metadata from a release branch", async () => {
    const baseVersion = await readPackagedVersion();
    const prereleaseVersion = `${baseVersion}-prerelease.12`;
    const objects: Record<string, unknown> = {};
    const fixture = await startStablePrereleaseMetadataServer(objects);
    objects[`prerelease/versions/${prereleaseVersion}/metadata.json`] = stablePrereleaseMetadataFixture(
      baseVersion,
      prereleaseVersion,
      fixture.origin,
    );
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-stable-dry-run-"));

    try {
      await mkdir(join(runnerTemp, "bin"), { recursive: true });
      await writeFakeGhBin(join(runnerTemp, "bin"), []);
      const result = await execFileAsync(process.execPath, ["--experimental-strip-types", releaseStableScriptPath], {
        cwd: workspaceRoot,
        env: workflowFixtureEnv({
          GITHUB_REF_NAME: `release/v${baseVersion}`,
          GITHUB_REPOSITORY: "ZeroSum-Solutions/mish",
          GITHUB_SHA: "0123456789abcdef0123456789abcdef01234567",
          NODE_TLS_REJECT_UNAUTHORIZED: "0",
          MISH_RELEASE_CHANNEL: "stable",
          MISH_RELEASE_DRY_RUN: "true",
          MISH_RELEASES_PUBLIC_ORIGIN: fixture.origin,
          MISH_GH_NODE_SCRIPT: join(runnerTemp, "bin", "gh"),
          MISH_STABLE_PRERELEASE_VERSION: prereleaseVersion,
        }, join(runnerTemp, "bin")),
      });

      expect(result.stdout).toContain(`[release-stable] validated prerelease: ${prereleaseVersion}`);
      expect(result.stdout).toContain("[release-stable] channel: stable");
      expect(result.stdout).toContain("[release-stable] dry run: true");
      expect(result.stdout).toContain(`[release-stable] version tag: mish-v${baseVersion}`);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("[P2] rejects invalid release dry-run values before remote checks", async () => {
    const output = await runReleaseStableForFailure({
      GITHUB_REF_NAME: "release/v0.10.0",
      MISH_RELEASE_DRY_RUN: "maybe",
      MISH_STABLE_VERSION: "",
    });

    expect(output).toContain("MISH_RELEASE_DRY_RUN must be metadata, prepublish, true, or false");
  });

  it("rejects stale latest platform manifests from a previous beta version", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.3.unsigned/Mish Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "current-sha",
          runAttempt: 2,
          runId: 222222222,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.3.unsigned",
        },
        releaseVersion: "1.2.3-beta.3",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      const result = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", releasePublishMetadataScriptPath],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BASE_VERSION: "1.2.3",
            ENABLE_LINUX_X64: "false",
            ENABLE_MAC_ARM64: "true",
            ENABLE_MAC_X64: "false",
            ENABLE_WIN_X64: "false",
            RELEASE_RUN_ATTEMPT: "2",
            RELEASE_RUN_ID: "222222222",
            RELEASE_COMMIT: "current-sha",
            MAC_ARM64_RESULT: "success",
            RELEASE_CHANNEL: "beta",
            RELEASE_MANIFEST_DIR: platformManifestRoot,
            RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
            RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
            RELEASE_PUBLIC_ORIGIN: "https://releases.mish.invalid",
            RELEASE_SIGNED: "false",
            RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
            RELEASE_STORAGE_BUCKET: fixture.bucket,
            RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
            RELEASE_STORAGE_REGION: "auto",
            RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
            RELEASE_VERSION: "1.2.3-beta.4",
            STATE_SOURCE: "test",
          },
          maxBuffer: 1024 * 1024,
        },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ reason, status: "rejected" as const }),
      );

      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContain(
        "refusing stale mac_arm64 platform manifest for 1.2.3-beta.4: releaseVersion=1.2.3-beta.3",
      );
      expect(fixture.uploadedObjectKeys()).toEqual([]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("rejects stale latest platform manifests from a previous same-version beta workflow run", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/Mish Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "previous-sha",
          runAttempt: 1,
          runId: 111111111,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
        },
        releaseVersion: "1.2.3-beta.4",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      const result = await execFileAsync(
        process.execPath,
        ["--experimental-strip-types", releasePublishMetadataScriptPath],
        {
          cwd: workspaceRoot,
          env: {
            ...process.env,
            BASE_VERSION: "1.2.3",
            ENABLE_LINUX_X64: "false",
            ENABLE_MAC_ARM64: "true",
            ENABLE_MAC_X64: "false",
            ENABLE_WIN_X64: "false",
            RELEASE_RUN_ATTEMPT: "2",
            RELEASE_RUN_ID: "222222222",
            RELEASE_COMMIT: "current-sha",
            MAC_ARM64_RESULT: "success",
            RELEASE_CHANNEL: "beta",
            RELEASE_MANIFEST_DIR: platformManifestRoot,
            RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
            RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
            RELEASE_PUBLIC_ORIGIN: "https://releases.mish.invalid",
            RELEASE_SIGNED: "false",
            RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
            RELEASE_STORAGE_BUCKET: fixture.bucket,
            RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
            RELEASE_STORAGE_REGION: "auto",
            RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
            RELEASE_VERSION: "1.2.3-beta.4",
            STATE_SOURCE: "test",
          },
          maxBuffer: 1024 * 1024,
        },
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (reason: unknown) => ({ reason, status: "rejected" as const }),
      );

      expect(result.status).toBe("rejected");
      expect(String(result.status === "rejected" ? result.reason : "")).toContain(
        "refusing stale mac_arm64 platform manifest for 1.2.3-beta.4: github.runId=111111111",
      );
      expect(fixture.uploadedObjectKeys()).toEqual([]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("accepts same-run latest platform manifests from an older workflow attempt", async () => {
    const fixture = await startReleaseMetadataObjectStore({});
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
        artifacts: {
          dmg: {
            url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/Mish Beta.dmg",
          },
        },
        channel: "beta",
        github: {
          commit: "current-sha",
          runAttempt: 1,
          runId: 222222222,
        },
        legacyPlatformKey: "mac",
        platformKey: "mac_arm64",
        releaseTarget: "mac_arm64",
        r2: {
          versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
        },
        releaseVersion: "1.2.3-beta.4",
        signed: false,
        status: "published",
      },
          null,
          2,
        )}\n`,
      );
      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "false",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          MAC_ARM64_RESULT: "success",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.mish.invalid",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
        },
        maxBuffer: 1024 * 1024,
      });

      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/mac_arm64.json",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("resolves auto asset suffix from target-first win_x64 platform manifests in beta metadata publish", async () => {
    const fixture = await startReleaseMetadataObjectStore({
      "beta/versions/1.2.3-beta.4.unsigned/latest.yml": "versioned updater feed",
    });
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-win-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "win_x64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              installer: {
                url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-win-x64-setup.exe",
              },
            },
            channel: "beta",
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "win",
            feed: {
              name: "latest.yml",
              url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/latest.yml",
            },
            platform: "win",
            platformKey: "win_x64",
            releaseTarget: "win_x64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );

      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "false",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "true",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          RELEASE_ASSET_SUFFIX: "auto",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.mish.invalid",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
          WIN_X64_RESULT: "success",
        },
        maxBuffer: 1024 * 1024,
      });

      const metadata = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "metadata.json"), "utf8"));
      expect(metadata.assetVersionSuffix).toBe(".unsigned");
      expect(metadata.readyTargets).toEqual(["win_x64"]);
      expect(metadata.platforms.win.r2.versionPrefix).toBe("beta/versions/1.2.3-beta.4.unsigned");
      expect(metadata.releaseTargets.win_x64.r2.versionPrefix).toBe("beta/versions/1.2.3-beta.4.unsigned");
      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4.unsigned/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/win_x64.json",
        "beta/latest/latest.yml",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("preserves launcher payload artifacts in beta latest metadata and action outputs", async () => {
    const fixture = await startReleaseMetadataObjectStore({
      "beta/versions/1.2.3-beta.4.unsigned/latest.yml": "versioned updater feed",
    });
    const runnerTemp = await mkdtemp(join(tmpdir(), "od-release-betas-payload-metadata-"));
    const platformManifestRoot = join(runnerTemp, "release-platform-manifests");

    try {
      await mkdir(platformManifestRoot, { recursive: true });
      await writeFile(
        join(platformManifestRoot, "mac_arm64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              dmg: {
                url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-mac-arm64.dmg",
              },
              payload: {
                sha256Url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-mac-arm64-payload.zip.sha256",
                url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-mac-arm64-payload.zip",
              },
            },
            channel: "beta",
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "mac",
            platform: "mac",
            platformKey: "mac_arm64",
            releaseTarget: "mac_arm64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(platformManifestRoot, "win_x64.json"),
        `${JSON.stringify(
          {
            artifacts: {
              installer: {
                url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-win-x64-setup.exe",
              },
              payload: {
                sha256Url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-win-x64-payload.7z.sha256",
                url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/mish-1.2.3-beta.4.unsigned-win-x64-payload.7z",
              },
            },
            channel: "beta",
            feed: {
              name: "latest.yml",
              url: "https://releases.mish.invalid/betas/versions/1.2.3-beta.4.unsigned/latest.yml",
            },
            github: {
              commit: "current-sha",
              runAttempt: 2,
              runId: 222222222,
            },
            legacyPlatformKey: "win",
            platform: "win",
            platformKey: "win_x64",
            releaseTarget: "win_x64",
            releaseVersion: "1.2.3-beta.4",
            r2: {
              versionPrefix: "beta/versions/1.2.3-beta.4.unsigned",
            },
            signed: false,
            status: "published",
          },
          null,
          2,
        )}\n`,
      );

      await execFileAsync(process.execPath, ["--experimental-strip-types", releasePublishMetadataScriptPath], {
        cwd: workspaceRoot,
        env: {
          ...process.env,
          BASE_VERSION: "1.2.3",
          ENABLE_LINUX_X64: "false",
          ENABLE_MAC_ARM64: "true",
          ENABLE_MAC_X64: "false",
          ENABLE_WIN_X64: "true",
          RELEASE_RUN_ATTEMPT: "2",
          RELEASE_RUN_ID: "222222222",
          RELEASE_COMMIT: "current-sha",
          RELEASE_ASSET_SUFFIX: "auto",
          RELEASE_CHANNEL: "beta",
          RELEASE_MANIFEST_DIR: platformManifestRoot,
          RELEASE_METADATA_DIR: join(runnerTemp, "release-metadata"),
          RELEASE_OUTPUTS_PATH: join(runnerTemp, "release-metadata", "outputs.json"),
          RELEASE_PUBLIC_ORIGIN: "https://releases.mish.invalid",
          RELEASE_SIGNED: "false",
          RELEASE_STORAGE_ACCESS_KEY_ID: "test-access-key",
          RELEASE_STORAGE_BUCKET: fixture.bucket,
          RELEASE_STORAGE_ENDPOINT: fixture.endpointUrl,
          RELEASE_STORAGE_REGION: "auto",
          RELEASE_STORAGE_SECRET_ACCESS_KEY: "test-secret-key",
          RELEASE_VERSION: "1.2.3-beta.4",
          STATE_SOURCE: "test",
          MAC_ARM64_RESULT: "success",
          WIN_X64_RESULT: "success",
        },
        maxBuffer: 1024 * 1024,
      });

      const metadata = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "metadata.json"), "utf8")) as {
        platforms: {
          mac: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
          win: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
        };
        releaseTargets: {
          mac_arm64: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
          win_x64: { artifacts?: { payload?: { sha256Url?: string; url?: string } } };
        };
      };
      const outputs = JSON.parse(await readFile(join(runnerTemp, "release-metadata", "outputs.json"), "utf8")) as Record<string, string>;

      expect(metadata.platforms.mac.artifacts?.payload?.url).toContain("mac-arm64-payload.zip");
      expect(metadata.platforms.mac.artifacts?.payload?.sha256Url).toContain("mac-arm64-payload.zip.sha256");
      expect(metadata.platforms.win.artifacts?.payload?.url).toContain("win-x64-payload.7z");
      expect(metadata.platforms.win.artifacts?.payload?.sha256Url).toContain("win-x64-payload.7z.sha256");
      expect(metadata.releaseTargets.mac_arm64.artifacts?.payload?.url).toBe(metadata.platforms.mac.artifacts?.payload?.url);
      expect(metadata.releaseTargets.win_x64.artifacts?.payload?.url).toBe(metadata.platforms.win.artifacts?.payload?.url);
      expect(outputs.mac_arm64_payload_url).toBe(metadata.platforms.mac.artifacts?.payload?.url);
      expect(outputs.win_x64_payload_url).toBe(metadata.platforms.win.artifacts?.payload?.url);
      expect(fixture.uploadedObjectKeys()).toEqual([
        "beta/versions/1.2.3-beta.4.unsigned/metadata.json",
        "beta/latest/metadata.json",
        "beta/latest/platforms/mac_arm64.json",
        "beta/latest/platforms/win_x64.json",
        "beta/latest/latest.yml",
      ]);
    } finally {
      await fixture.close();
      await rm(runnerTemp, { force: true, recursive: true });
    }
  });

  it("resolves the generated Windows update fixture outside the measured build child scope", async () => {
    const winBuildScript = await readFile(releaseBetaWindowsBuildScriptPath, "utf8");

    expect(winBuildScript).toMatch(
      /Measure-Step "tools-pack win build update fixture" \{[\s\S]*?\r?\n    \}\r?\n    \$updateBuild = Get-Content -LiteralPath \$fixtureJsonPath -Raw \| ConvertFrom-Json\r?\n    \$localUpdateArtifactPath = \[string\]\$updateBuild\.installerPath/,
    );
    expect(winBuildScript).toContain('$env:OD_PACKAGED_E2E_WIN_UPDATE_FIXTURE = "tools-serve"');
    expect(winBuildScript).toContain("$env:OD_PACKAGED_E2E_WIN_UPDATE_ARTIFACT_PATH = $localUpdateArtifactPath");
  });
});

async function startStablePrereleaseMetadataServer(objects: Record<string, unknown>): Promise<{
  close: () => Promise<void>;
  origin: string;
}> {
  const server = createHttpsServer(
    {
      cert: stablePrereleaseMetadataCert,
      key: stablePrereleaseMetadataKey,
    },
    (request, response) => {
      const objectKey = decodeURIComponent(new URL(request.url ?? "/", "https://127.0.0.1").pathname.replace(/^\/+/, ""));
      if (request.method !== "GET" || !(objectKey in objects)) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      response.setHeader("content-type", "application/json; charset=utf-8");
      response.end(JSON.stringify(objects[objectKey]));
    },
  );

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("stable prerelease metadata server did not bind to a TCP port");
  }

  return {
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
    origin: `https://127.0.0.1:${address.port}`,
  };
}

function stablePrereleaseMetadataFixture(baseVersion: string, prereleaseVersion: string, publicOrigin: string): Record<string, unknown> {
  const versionPrefix = `prerelease/versions/${prereleaseVersion}`;
  const versionUrl = `${publicOrigin}/${versionPrefix}`;
  const artifact = (name: string) => ({
    sha256Url: `${versionUrl}/${name}.sha256`,
    url: `${versionUrl}/${name}`,
  });

  return {
    baseVersion,
    channel: "prerelease",
    github: {
      branch: `release/v${baseVersion}`,
      commit: "0123456789abcdef0123456789abcdef01234567",
      repository: "ZeroSum-Solutions/mish",
      workflow: "release-prerelease",
    },
    prereleaseNumber: 12,
    prereleaseVersion,
    platforms: {
      mac: {
        arch: "arm64",
        artifacts: {
          dmg: artifact("Mish.dmg"),
          zip: artifact("Mish-mac-arm64.zip"),
        },
        enabled: true,
        signed: true,
      },
      macIntel: {
        arch: "x64",
        artifacts: {
          dmg: artifact("Mish Intel.dmg"),
          zip: artifact("Mish-mac-x64.zip"),
        },
        enabled: true,
        signed: true,
      },
      win: {
        arch: "x64",
        artifacts: {
          installer: artifact("Mish Setup.exe"),
        },
        enabled: true,
      },
    },
    r2: {
      report: {
        type: "zip",
        url: `${versionUrl}/report.zip`,
      },
      reportZipUrl: `${versionUrl}/report.zip`,
      versionMetadataUrl: `${versionUrl}/metadata.json`,
      versionPrefix,
    },
    releaseVersion: prereleaseVersion,
    signed: true,
  };
}

async function startReleaseMetadataObjectStore(objects: Record<string, unknown>): Promise<{
  bucket: string;
  close: () => Promise<void>;
  endpointUrl: string;
  uploadedObjectKeys: () => string[];
}> {
  const bucket = "release-bucket";
  const uploadedObjectKeys: string[] = [];
  const server = createServer((request, response) => {
    void handleReleaseMetadataObjectStoreRequest(request, response, bucket, objects, uploadedObjectKeys);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("release metadata object store did not bind to a TCP port");
  }

  return {
    bucket,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error == null ? resolve() : reject(error)));
      }),
    endpointUrl: `http://127.0.0.1:${address.port}`,
    uploadedObjectKeys: () => [...uploadedObjectKeys],
  };
}

async function handleReleaseMetadataObjectStoreRequest(
  request: IncomingMessage,
  response: ServerResponse,
  bucket: string,
  objects: Record<string, unknown>,
  uploadedObjectKeys: string[],
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
  const bucketPrefix = `/${bucket}/`;
  if (!path.startsWith(bucketPrefix)) {
    response.statusCode = 404;
    response.end("not found");
    return;
  }

  const objectKey = decodeURIComponent(path.slice(bucketPrefix.length));
  if (request.method === "GET") {
    if (!(objectKey in objects)) {
      response.statusCode = 404;
      response.end("not found");
      return;
    }
    const body = JSON.stringify(objects[objectKey]);
    response.setHeader("content-type", "application/json; charset=utf-8");
    response.end(body);
    return;
  }

  if (request.method === "PUT") {
    uploadedObjectKeys.push(objectKey);
    for await (const _chunk of request) {
      // Drain the request body so the client can complete cleanly.
    }
    response.statusCode = 200;
    response.end("ok");
    return;
  }

  response.statusCode = 405;
  response.end("method not allowed");
}

const stablePrereleaseMetadataKey = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC1hoV1GwxqTYdO
Zs0pY5hnp8BtTwdF6dWsXoFWYw9IPpBTmyNeleRcLtrht/oc5oRS05tC97qmb5eL
RigyXUmwrpt/VjJ7ursDa3qGnljkqVxqBkRAUdXBMCVPkMogKWvJy/S61Vthvf7K
K5HhofwcuPPvRBdhdZgtw/7nZY49HYutd7wP/U7iqCYBMpWr0I29jSs1S2xY9fH8
ih/exDGe3PHm8yQao4pHUUFVXoAI5w6tYsmNep6b+5NYPHnHSaXd7h5gaF+nIJE4
78jgRQHKjQ2iNf/53/o/d5SAMb/9lZ7stNT8RIFOJUz1IP8Zsz3VKwAvXKXZDObr
0MS4JrPdAgMBAAECggEATcF0HD/8VvKjsU0ut3pud4QvVINEGcn6mY2XuFHRY4BN
IUr0YRkyytvVLVe5vrRtXO9Ac/Sakp19XA6uvDgijxiUCfz5ve80GVhqEQz2BeiX
6eCKTsTfG5QMf2MFebZUcgm36Gno7VrNr3rvT6erzv/YmZZgr4IIMB5i62qgfYOY
ABSg6b223RSVeZXNvWxovKycBUUa26lrzRu5jpuexjAccmgbiE86exhzW7FK2zjZ
XH8rOxSDJ49+ipPOGsJ+rZMdtvHq6BO/QU4O9IkBLNuHAIbr/WcjBgnAPskQTrOM
i3vWqPNVw3tPjBWCOtzy0UllG0L5Sxnx5cceFvL9HwKBgQDieIaM89In+VETI+x4
aUmQXxVcisZR0FWQytl+XbWe4T1zxEj4fFjd/phgv0M60599/mwCCGrImxKM8cnb
mjxv2FX+or9+2IFpaSOi+Qj6/IxcTTWoMU0t4AQjOgbRf3iBpVz6JysnKKpqqukT
GGOnzGWz0gFmDAqKm0zkGy7czwKBgQDNMb6hrSGobMRlCndgx//w/SdDq/IqAbIS
QyAvYgNuOXV3J4sD2Z1TwYxZM2Oq5rhOPfZr8SnqM7d+LknLPiGMKV7z6vL/BOu8
ZB5+EmMZwqNmSOMaFZM+77OC/zxDCznqTm4N5vDdg+6SByCtuyCm+Jraj0PtHtkD
krdWqBfHkwKBgDpTzluZJGQ1OyNR2kJ843xycL7/4uoJXTBIflGkcvVzj280e5K7
++tY+gfY2sjY3jgGAe1YG6CFB/cTAukzRSONNUC6y9Uwj8wFTy9XMm/qAYB4RjyG
Thllm8sy07S7Pt8tJtAqrFuOhq2oTRUk7+20n/D7Qm705PYj317UfXJTAoGABdYM
XfzWoDu3ukf57T7DAM+ydjJFyPwTXIGcQLzA7DmmJaVyRsHBv8gZfdAAXbQCOfd5
MsjBMHAYH/ahEq7JtXrXwIhGMQqqycjvNRbAytLGYvpfuzYx4fBfYrJvvFhtZUSl
zK9s2mAOQQkC3O4dl6IqhVzdybi+42Mg484UHxECgYEAht1ef0Gc6RKZpmqttlZJ
1G4lsR1Aws3dintACs8lza5aaufrY07gF8z3rkW6tPGEWfol3CYOT2U5UiUw+iKG
F/Pa3L5wCxuRKKWx0ip0PFhDPrpWfVCm2CLlUlZLEjpmF2iUZgmkaScjYqG8R16a
C8cywTs1ku5aYIaN8YcAigI=
-----END PRIVATE KEY-----`;

const stablePrereleaseMetadataCert = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUbNGmwcWmZP5tw6gm8s2RXzWJv+IwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJMTI3LjAuMC4xMB4XDTI2MDYwODA0MDczNVoXDTI2MDYw
OTA0MDczNVowFDESMBAGA1UEAwwJMTI3LjAuMC4xMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEAtYaFdRsMak2HTmbNKWOYZ6fAbU8HRenVrF6BVmMPSD6Q
U5sjXpXkXC7a4bf6HOaEUtObQve6pm+Xi0YoMl1JsK6bf1Yye7q7A2t6hp5Y5Klc
agZEQFHVwTAlT5DKIClrycv0utVbYb3+yiuR4aH8HLjz70QXYXWYLcP+52WOPR2L
rXe8D/1O4qgmATKVq9CNvY0rNUtsWPXx/Iof3sQxntzx5vMkGqOKR1FBVV6ACOcO
rWLJjXqem/uTWDx5x0ml3e4eYGhfpyCROO/I4EUByo0NojX/+d/6P3eUgDG//ZWe
7LTU/ESBTiVM9SD/GbM91SsAL1yl2Qzm69DEuCaz3QIDAQABo1MwUTAdBgNVHQ4E
FgQU8Z0Oy/q8fAqp9005cn2sW4K6oB4wHwYDVR0jBBgwFoAU8Z0Oy/q8fAqp9005
cn2sW4K6oB4wDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAlJTb
7zi4FKJqYuXZ9YWmV96Ri+vBcNfO2dwKBxFtJXm0Ai2Q4ruutuFPYwY6UYGTN5gC
HJ0/WxuPK5ftAE6UU+Mghu0dJlH+gWmOq5cDyhYdnEi8R6z5AsPtPEYlkkIvhUO1
k1BtCP0h4Kh8fuaILGuXQNOaKizIWF2lEEHfCmvKhgOF6dKWs38zdetFQCLRIaHg
ZyGlUhPCUbKdTiBJuCGaDKzeEAlC8dsar2zjg9CVue7w3CaamQpjnV0d2IHJiVAH
QONQvdtLnZ6GeNPe06oBrq7R9SL5/tkqgSq8lCrDE6jFZnfXNMdDmZY3wTcFcdyG
yW/DsIUs5ZzcHza5rw==
-----END CERTIFICATE-----`;
