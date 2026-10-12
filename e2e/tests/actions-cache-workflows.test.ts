import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const setupWorkspaceAction = new URL("../../.github/actions/setup-workspace/action.yml", import.meta.url);
const setupPlaywrightAction = new URL("../../.github/actions/setup-playwright/action.yml", import.meta.url);
const ciWorkflow = new URL("../../.github/workflows/ci.yml", import.meta.url);

function sectionBetween(content: string, start: string, end: string): string {
  const startIndex = content.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = content.indexOf(end, startIndex + start.length);
  expect(endIndex).toBeGreaterThan(startIndex);
  return content.slice(startIndex, endIndex);
}

describe("GitHub Actions cache workflows", () => {
  it("[P1] builds the daemon during workspace setup without repeating it in CI prebuilds", async () => {
    const [action, workflow, manifest, postinstall] = await Promise.all([
      readFile(setupWorkspaceAction, "utf8"),
      readFile(ciWorkflow, "utf8"),
      readFile(new URL("../../package.json", import.meta.url), "utf8"),
      readFile(new URL("../../scripts/postinstall.mjs", import.meta.url), "utf8"),
    ]);
    const install = sectionBetween(action, "- name: Install dependencies", "- name: Save pnpm store");
    expect(install).toContain("pnpm install --frozen-lockfile --ignore-scripts=false");
    expect(JSON.parse(manifest).scripts.postinstall).toBe("node ./scripts/postinstall.mjs");
    expect(postinstall.match(/const buildTargets = \[([\s\S]*?)\];/)?.[1]).toContain('"apps/daemon"');

    const jobs = workflow.split(/(?=^  [\w]+:\s*$)/m);
    const prebuildJobs = jobs.filter((job) => job.includes("- name: Prebuild workspace type declarations"));
    expect(prebuildJobs.map((job) => job.match(/^  ([\w]+):/m)?.[1])).toEqual([
      "preflight", "e2e_vitest", "playwright_critical", "ui_p0", "playwright_visual",
    ]);
    for (const job of prebuildJobs) {
      const prebuild = sectionBetween(job, "- name: Prebuild workspace type declarations", "\n      - name:");
      expect(job).toContain("uses: ./.github/actions/setup-workspace");
      expect(job.indexOf("uses: ./.github/actions/setup-workspace")).toBeLessThan(
        job.indexOf("- name: Prebuild workspace type declarations"),
      );
      expect(job).not.toContain("pnpm --filter @mish/daemon build");
      expect(prebuild).toContain("pnpm --filter @mish/desktop build");
      expect(prebuild).toContain("pnpm --filter @mish/web build:sidecar");
    }
  });

  it("[P1] uses preseeded Playwright only for a ready self-hosted runner image", async () => {
    const action = await readFile(setupPlaywrightAction, "utf8");

    expect(action).toContain("*'\"mish-runners-'*");
    expect(action).toContain("PLAYWRIGHT_BROWSERS_PATH");
    expect(action).toContain("steps.preinstalled-playwright.outputs.enabled == 'true'");
    expect(action).toContain("steps.preinstalled-playwright.outputs.enabled != 'true'");
    expect(action).toContain('pnpm -C "$package_dir" exec playwright install chromium');
    expect(action).toContain("run: ${{ inputs.install-command }}");
  });

  it("[P1] installs hosted browser dependencies without a retired provider mirror", async () => {
    const action = await readFile(setupPlaywrightAction, "utf8");
    expect(action).not.toContain('blacksmith-');
    expect(action).not.toContain('blacksmith-ubuntu-mirrors.txt');
    expect(action).toContain('run: ${{ inputs.install-command }}');
    const workflow = await readFile(ciWorkflow, "utf8");
    for (const setup of workflow.split("uses: ./.github/actions/setup-playwright").slice(1)) {
      expect(setup.slice(0, setup.indexOf("\n      - name:"))).toContain("runner-labels:");
    }
  });

  it("[P1] keeps pnpm cache writes on explicit trusted main seed jobs", async () => {
    const action = await readFile(setupWorkspaceAction, "utf8");

    expect(action).toContain("save-pnpm-cache:");
    expect(action).toContain("default: 'false'");
    expect(action).toContain("uses: actions/cache/restore@v5");
    expect(action).toContain("uses: actions/cache/save@v5");
    expect(action).not.toContain("uses: actions/cache@v5");
    expect(action.indexOf("uses: actions/cache/restore@v5")).toBeLessThan(
      action.indexOf("run: pnpm install --frozen-lockfile"),
    );
    expect(action.indexOf("run: pnpm install --frozen-lockfile")).toBeLessThan(
      action.indexOf("uses: actions/cache/save@v5"),
    );

    // Non-persistent branch: pin a stable home store before `pnpm store path`
    // so actions/cache version hashes match across hosted and self-hosted ARC fleets.
    const detectStep = sectionBetween(
      action,
      "- name: Detect persistent pnpm store",
      "- name: Setup pnpm",
    );
    // Isolate the else arm by its home-store pin (not "else"/"fi", which match
    // substrings like npm_config).
    const homeStoreIndex = detectStep.indexOf('store_dir="$HOME/.pnpm-store"');
    expect(homeStoreIndex).toBeGreaterThanOrEqual(0);
    const nonPersistentBranch = detectStep.slice(homeStoreIndex);
    expect(nonPersistentBranch).toContain('echo "NPM_CONFIG_STORE_DIR=$store_dir"');
    expect(nonPersistentBranch).toContain('echo "npm_config_store_dir=$store_dir"');
    expect(nonPersistentBranch).toContain('echo "enabled=false"');
    expect(action.indexOf('store_dir="$HOME/.pnpm-store"')).toBeLessThan(
      action.indexOf('run: echo "path=$(pnpm store path --silent)"'),
    );

    const restoreStep = sectionBetween(
      action,
      "- name: Restore pnpm store",
      "- name: Install dependencies",
    );
    expect(restoreStep).toContain("restore-keys: |");
    expect(restoreStep).toContain("pnpm-store-${{ runner.os }}-");

    const saveStep = action.slice(action.indexOf("- name: Save pnpm store"));
    expect(saveStep).toContain("inputs.save-pnpm-cache == 'true'");
    expect(saveStep).toContain("steps.persistent-pnpm-store.outputs.enabled != 'true'");
    expect(saveStep).toContain("steps.pnpm-cache-restore.outputs.cache-hit != 'true'");
    expect(saveStep).toContain("github.ref == 'refs/heads/main'");
    expect(saveStep).toContain("github.event_name == 'push'");
    expect(saveStep).toContain("github.event_name == 'workflow_dispatch'");
    expect(saveStep).toContain("github.event_name == 'schedule'");
  });

  // The pnpm store cache is written only from main: `ci.yml` runs on every push to main,
  // so its unconditional Linux preflight job and the Windows payload job are the seeds.
  // The action's own save condition still refuses pull_request and merge_group events.
  it("[P1] seeds the Linux and Windows pnpm caches from ci.yml pushes to main", async () => {
    const workflow = await readFile(ciWorkflow, "utf8");
    expect(workflow).toMatch(/^  push:\n    branches: \[main\]$/m);

    const jobs = workflow.split(/(?=^  [\w]+:\s*$)/m);
    const seedJobs = jobs.filter((job) => job.includes("save-pnpm-cache: 'true'"));
    expect(seedJobs.map((job) => job.match(/^  ([\w]+):/m)?.[1])).toEqual([
      "preflight", "windows_tools_pack_payload_tests",
    ]);
    for (const job of seedJobs) {
      const setup = sectionBetween(job, "uses: ./.github/actions/setup-workspace", "\n      - name:");
      expect(setup).toContain("save-pnpm-cache: 'true'");
    }
    expect(sectionBetween(workflow, "  preflight:", "  workspace_unit_tests:")).toContain(".general_medium");
    expect(sectionBetween(workflow, "  windows_tools_pack_payload_tests:", "  web_workspace_tests:")).toContain(".windows_tools");
  });
});
