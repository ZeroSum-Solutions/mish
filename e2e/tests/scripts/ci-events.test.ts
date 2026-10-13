import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parse } from "yaml";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const workflowText = readFileSync(path.join(root, ".github/workflows/ci.yml"), "utf8");
const workflow = parse(workflowText) as {
  jobs: Record<string, { steps: Array<{ name: string; run?: string }> }>;
};

function planEvent(eventName: string, event: unknown, response: string, failApi = false) {
  const scratch = mkdtempSync(path.join(tmpdir(), "mish-ci-event-"));
  try {
    const eventPath = path.join(scratch, "event.json");
    const output = path.join(scratch, "output");
    const calls = path.join(scratch, "calls.json");
    const gh = path.join(scratch, "gh.cjs");
    writeFileSync(eventPath, JSON.stringify(event));
    writeFileSync(gh, 'require("node:fs").writeFileSync(' + JSON.stringify(calls) +
      ', JSON.stringify(process.argv.slice(2)));process.stdout.write(' +
      JSON.stringify(response) + ');process.exit(' + (failApi ? 1 : 0) + ');\n');
    const step = workflow.jobs.plan!.steps.find((step) => step.name === "Resolve validation scopes")!;
    expect(step.run).toBe('python3 .github/scripts/scopes.py github-output --output "$RUNNER_TEMP/scope-plan.json"');
    const result = spawnSync("bash", ["-c", step.run!], {
      cwd: root, encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GITHUB_EVENT_NAME: eventName, GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "ZeroSum-Solutions/mish", GITHUB_SHA: "a".repeat(40),
        GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(scratch, "summary"),
        RUNNER_TEMP: scratch, MISH_GH_NODE_SCRIPT: gh,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const plan = JSON.parse(readFileSync(path.join(scratch, "scope-plan.json"), "utf8")) as {
      enabled: Record<string, boolean>; scopes: Record<string, boolean | string>;
      matrices: { ui_p0: unknown[]; visual: unknown[] };
      trace: { threshold: string; filesResolved: boolean };
    };
    const emitted = Object.fromEntries(readFileSync(output, "utf8").trim().split("\n").map((line) => {
      const separator = line.indexOf("=");
      return [line.slice(0, separator), JSON.parse(line.slice(separator + 1))];
    }));
    expect(emitted).toEqual({ run: plan.enabled, scopes: plan.scopes, ui_p0_matrix: plan.matrices.ui_p0, visual_matrix: plan.matrices.visual });
    return { plan, calls: existsSync(calls) ? JSON.parse(readFileSync(calls, "utf8")) as string[] : [] };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function gate(needs: Record<string, unknown>) {
  const step = workflow.jobs.validate!.steps.find((step) => step.name === "Check workspace validation jobs")!;
  return spawnSync("bash", ["-c", step.run!], {
    cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, NEEDS_JSON: JSON.stringify(needs) },
  });
}

const cases = [
  { name: "PR", eventName: "pull_request", event: { pull_request: { number: 42, draft: false } }, response: "README.md\n", threshold: "medium", endpoint: "pulls/42/files" },
  { name: "manual full", eventName: "workflow_dispatch", event: { inputs: { ci_mode: "full" } }, response: "", threshold: "none", endpoint: "" },
  { name: "manual hot", eventName: "workflow_dispatch", event: { inputs: { ci_mode: "hot" } }, response: "apps/web/src/app/page.tsx\n", threshold: "medium", endpoint: "compare/main..." + "a".repeat(40) },
  { name: "merge group", eventName: "merge_group", event: { merge_group: { base_sha: "b".repeat(40), head_sha: "a".repeat(40) } }, response: JSON.stringify({ files: [{ filename: "docs/architecture.md" }] }), threshold: "certain", endpoint: "compare/" + "b".repeat(40) + "..." + "a".repeat(40) },
];

describe("public CI planning and gate", () => {
  test("keeps one read-only CI workflow with hosted runners and no storage reuse", () => {
    expect(readdirSync(path.join(root, ".github/workflows")).sort()).toEqual(["cache-seed.yml", "ci.yml", "release-mac.yml"]);
    expect(workflowText).toContain("merge_group:");
    expect(workflowText).toContain("run: $" + "{{ steps.scopes.outputs.run }}");
    expect(workflowText).not.toMatch(/secrets\.|vars\.|pull_request_target|self-hosted|convergence|WORKLOAD_RESULTS/);
    const release = readFileSync(path.join(root, ".github/workflows/release-mac.yml"), "utf8");
    expect(release).not.toMatch(/secrets\.|vars\.|pull_request(_target)?:|self-hosted/);
    expect(release).toMatch(/^permissions:\n  contents: read$/m);
    const seed = readFileSync(path.join(root, ".github/workflows/cache-seed.yml"), "utf8");
    expect(seed).not.toMatch(/secrets\.|vars\.|pull_request(_target)?:|self-hosted/);
    expect(seed).toMatch(/^permissions:\n  contents: read$/m);
    expect(seed).toContain("save-pnpm-cache: 'true'");
    for (const name of readdirSync(path.join(root, ".github/config")).filter((name) => name.endsWith(".json"))) {
      const config = readFileSync(path.join(root, ".github/config", name), "utf8");
      for (const match of config.matchAll(/"(\.github\/workflows\/[^"\n]+)"/g)) {
        expect(existsSync(path.join(root, match[1]!)), name + ": " + match[1]).toBe(true);
      }
    }
  });

  test.each(cases)("plans $name without repository secrets or variables and accepts successful validation", (item) => {
    const { plan, calls } = planEvent(item.eventName, item.event, item.response);
    expect(plan.trace.threshold).toBe(item.threshold);
    if (item.endpoint) expect(calls).toContain("repos/ZeroSum-Solutions/mish/" + item.endpoint);
    else expect(calls).toEqual([]);
    const needs: Record<string, unknown> = {
      plan: { result: "success", outputs: { run: JSON.stringify(plan.enabled) } },
      runners: { result: "success" },
      merge_policy: { result: item.eventName === "merge_group" ? "success" : "skipped" },
      ...Object.fromEntries(Object.entries(plan.enabled).map(([name, enabled]) => [name, { result: enabled ? "success" : "skipped" }])),
    };
    expect(gate(needs).status).toBe(0);
    for (const result of ["failure", "cancelled", "skipped"]) {
      const rejected = gate({ ...needs, static_gate: { result } });
      expect(rejected.status, rejected.stdout).toBe(1);
    }
    const missing = { ...needs };
    delete missing.static_gate;
    expect(gate(missing).status).toBe(1);
    expect(gate({ ...needs, plan: { result: "failure" } }).status).toBe(1);
  });

  test.each([undefined, null, "", "{invalid", "[]", "{}", "null", '{"static_gate":true}'])(
    "rejects missing, malformed, or incomplete workload output (%j)",
    (run) => {
      const { plan } = planEvent("workflow_dispatch", { inputs: { ci_mode: "full" } }, "");
      const needs = {
        runners: { result: "success" },
        merge_policy: { result: "skipped" },
        ...Object.fromEntries(Object.keys(plan.enabled).map((name) => [name, { result: "success" }])),
      };
      expect(gate({ ...needs, plan: { result: "success", outputs: { run: JSON.stringify(plan.enabled) } } }).status).toBe(0);
      const result = gate({ ...needs, plan: { result: "success", outputs: run === undefined ? {} : { run } } });
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("Invalid workload plan");
    },
  );

  test("rejects non-boolean workload flags", () => {
    const { plan } = planEvent("workflow_dispatch", { inputs: { ci_mode: "full" } }, "");
    const needs = {
      plan: { result: "success", outputs: { run: JSON.stringify({ ...plan.enabled, preflight: "true" }) } },
      runners: { result: "success" },
      merge_policy: { result: "skipped" },
      ...Object.fromEntries(Object.keys(plan.enabled).map((name) => [name, { result: "success" }])),
    };
    const result = gate(needs);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("Invalid workload plan");
  });

  test.each([false, true])("keeps full fallback for empty or failed merge-group resolution (%s)", (failApi) => {
    const item = cases[3]!;
    const { plan } = planEvent(item.eventName, item.event, JSON.stringify({ files: [] }), failApi);
    expect(plan.trace.filesResolved).toBe(false);
    expect(plan.trace.threshold).toBe("none");
    expect(plan.enabled).toMatchObject({ daemon_unit_tests: true, ui_p0: true, e2e_vitest: true, windows_tools_pack_payload_tests: true });
  });
});
