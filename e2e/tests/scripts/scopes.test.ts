import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, test } from "vitest";

import { uiP0CiMatrix, visualCiMatrix } from "../../lib/playwright/suites.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const script = path.join(repoRoot, ".github/scripts/scopes.py");

type Plan = {
  scopes: Record<string, boolean | string>;
  enabled: Record<string, boolean>;
  matrices: { ui_p0: unknown[]; visual: unknown[] };
  trace: {
    escalations: unknown[];
    ruleHits: Record<string, number>;
    uiP0Shadow: { mode: string; matrix: Array<{ name: string }> };
  };
};

function plan(context: "pr" | "merge-queue" | "full", files: string[] = []): Plan {
  return JSON.parse(execFileSync("python3", [script, "plan", "--context", context, "--files", ...files], {
    cwd: repoRoot,
    encoding: "utf8",
  })) as Plan;
}

describe("workflow scope planner", () => {
  test("keeps the JSON matrices aligned with the business-owned suite topology", () => {
    expect(plan("full").matrices).toEqual({ ui_p0: uiP0CiMatrix, visual: visualCiMatrix });
  });

  test("owns configuration validation without a downstream guard registry", () => {
    expect(execFileSync("python3", [script, "validate"], { cwd: repoRoot, encoding: "utf8" }))
      .toContain("scope configuration is valid");

    const temporaryRoot = mkdtempSync(path.join(tmpdir(), "scope-contract-"));
    try {
      const config = JSON.parse(readFileSync(path.join(repoRoot, ".github/config/scopes.json"), "utf8")) as {
        matrices: { ui_p0: Array<{ name: string; shard: string }> };
      };
      config.matrices.ui_p0.push({ ...config.matrices.ui_p0[0]! });
      const configPath = path.join(temporaryRoot, "scopes.json");
      writeFileSync(configPath, JSON.stringify(config));
      const failed = spawnSync("python3", [script, "--config", configPath, "validate"], {
        cwd: repoRoot,
        encoding: "utf8",
      });
      expect(failed.status).toBe(2);
      expect(failed.stderr).toContain("scopes.matrices.ui_p0 contains duplicate names");
    } finally {
      rmSync(temporaryRoot, { force: true, recursive: true });
    }
  });

  test("routes representative PR changes without importing the workspace", () => {
    expect(plan("pr", ["apps/web/src/App.tsx"])).toMatchObject({
      scopes: { web_tests_required: true, ui_p0_validation_required: true, visual_validation_required: true },
      enabled: { web_workspace_tests: true, e2e_vitest: true, ui_p0: true, playwright_visual: true },
    });
    expect(plan("pr", ["apps/desktop/src/main.ts"])).toMatchObject({
      scopes: { tools_dev_tests_required: true, tools_pack_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: false, ui_p0: false, playwright_critical: false },
    });
    expect(plan("pr", ["tools/pack/src/win/payload.ts"])).toMatchObject({
      scopes: { tools_pack_tests_required: true, windows_tools_pack_payload_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: true, ui_p0: false, playwright_critical: false },
    });
    expect(plan("pr", ["tools/pack/src/launcher/layout.ts"])).toMatchObject({
      scopes: { tools_pack_tests_required: true, windows_tools_pack_payload_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: true },
    });
    expect(plan("pr", ["tools/pack/src/mac/payload.ts"])).toMatchObject({
      scopes: { tools_pack_tests_required: true, windows_tools_pack_payload_tests_required: false },
      enabled: { windows_tools_pack_payload_tests: false },
    });
    expect(plan("pr", ["tools/pack/src/future-root-helper.ts"])).toMatchObject({
      scopes: { tools_pack_tests_required: true, windows_tools_pack_payload_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: true },
      trace: { ruleHits: { "tools-pack-root-source-fallback": 1 } },
    });
    expect(plan("pr", ["packages/launcher-proto/src/index.ts"])).toMatchObject({
      scopes: { windows_tools_pack_payload_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: true },
    });
    expect(plan("pr", ["pnpm-lock.yaml"])).toMatchObject({
      scopes: { windows_tools_pack_payload_tests_required: true },
      enabled: { windows_tools_pack_payload_tests: true },
    });
    expect(plan("pr", ["docs/spec.md"])).toMatchObject({
      scopes: { workspace_validation_required: false },
      enabled: { preflight: true, workspace_unit_tests: true, ui_p0: false },
    });
  });

  test("routes design-templates/ changes to the render tests workload, and nothing else does", () => {
    expect(plan("pr", ["design-templates/agency-site/scripts/families/watson/render.ts"])).toMatchObject({
      scopes: { render_tests_required: true },
      enabled: { render_tests: true },
    });
    expect(plan("pr", ["design-templates/onboarding-deck/slides/intro.ts"])).toMatchObject({
      scopes: { render_tests_required: true },
      enabled: { render_tests: true },
    });
    // daemon_tests_required alone (e.g. a plain apps/daemon/ change) must NOT
    // fire render_tests -- it is a distinct, narrower effect than the
    // runtime-content rule's daemon/web pair, so unrelated daemon changes
    // don't pay for a job that validates design-templates output.
    expect(plan("pr", ["apps/daemon/src/server.ts"])).toMatchObject({
      scopes: { daemon_tests_required: true, render_tests_required: false },
      enabled: { daemon_unit_tests: true, render_tests: false },
    });
  });

  test("routes the fast lane and the agency family packages to the agency tests workload", () => {
    for (const file of [
      "packages/agency-fast-lane/src/run.ts",
      "plugins/_official/examples/agency-wrenfield/compiler/scripts/families/wrenfield/render.ts",
      "plugins/_official/shared/agency-compiler/scripts/sections.ts",
      "scripts/sync-agency-compiler.ts",
    ]) {
      expect(plan("pr", [file])).toMatchObject({
        scopes: { agency_tests_required: true },
        enabled: { agency_tests: true },
      });
    }
    expect(plan("pr", ["apps/daemon/src/server.ts"])).toMatchObject({
      scopes: { agency_tests_required: false },
      enabled: { agency_tests: false },
    });
  });

  test("routes the section catalog and the Cult inventory to daemon tests, and the Cult inventory to workspace checks and the agency tests", () => {
    // The daemon's GET /api/sections imports packages/section-catalog/catalog.json.
    expect(plan("pr", ["packages/section-catalog/catalog.json"])).toMatchObject({
      scopes: { daemon_tests_required: true, workspace_validation_required: true },
      enabled: { daemon_unit_tests: true, workspace_unit_tests: true, static_gate: true },
      trace: { escalations: [] },
    });
    // The Cult inventory is read by section-catalog's build script, and its generated adapters by the
    // fast lane's overlay: its own check and tests (workspace unit tests, static gate),
    // section-catalog's --check, and the agency tests job (overlay tests and the Cult render check).
    // The daemon's AC-R13.1 component-ledger gate reads catalog.json too (component-ledger-gate
    // rule), so only that file adds the daemon unit tests.
    for (const [file, daemon] of [["packages/cult-ui-catalog/catalog.json", true], ["packages/cult-ui-catalog/generated/adapters/marketing-cta-vite.ts", false]] as const) {
      expect(plan("pr", [file]), file).toMatchObject({
        scopes: { daemon_tests_required: daemon, web_tests_required: false, ui_critical_validation_required: false, workspace_validation_required: true, agency_tests_required: true },
        enabled: { daemon_unit_tests: daemon, e2e_vitest: false, playwright_critical: false, workspace_unit_tests: true, static_gate: true, agency_tests: true },
        trace: { escalations: [] },
      });
    }
  });

  test("routes the component-ledger inputs to the daemon unit tests that hold the AC-R13.1 gate", () => {
    // apps/daemon/tests/workbench/component-ledger.test.ts derives the ledger from the 21st.dev
    // rows and originals in packages/21st-catalog, the Cult inventory in packages/cult-ui-catalog
    // and the vendored HyperUI blocks; a change there must run it so a new, removed or changed
    // component cannot bypass the ledger.
    for (const file of [
      "packages/21st-catalog/generated/21st-originals.json",
      "packages/21st-catalog/generated/21st-items.json",
      "packages/cult-ui-catalog/catalog.json",
      "plugins/_official/shared/ui-kits/hyperui/blocks/marketing/ctas/1.html",
      "plugins/_official/shared/ui-kits/hyperui/manifest.json",
    ]) {
      const decision = plan("pr", [file]);
      expect(decision, file).toMatchObject({
        scopes: { daemon_tests_required: true, web_tests_required: false },
        enabled: { daemon_unit_tests: true, e2e_vitest: false },
        trace: { escalations: [] },
      });
      expect(decision.trace.ruleHits["component-ledger-gate"], file).toBe(1);
    }
    // A sibling ui-kit is outside the ledger's inputs and keeps its fallback coverage only.
    expect(plan("pr", ["plugins/_official/shared/ui-kits/other-kit/blocks/a.html"])).toMatchObject({
      scopes: { daemon_tests_required: false, workspace_validation_required: true, ui_critical_validation_required: true },
      enabled: { daemon_unit_tests: false },
    });
  });

  test("unions the component-ledger route with the other effects of a mixed change set", () => {
    const decision = plan("pr", [
      "plugins/_official/shared/ui-kits/hyperui/blocks/marketing/ctas/1.html",
      "docs/architecture.md",
      "apps/web/src/App.tsx",
    ]);
    expect(decision).toMatchObject({
      scopes: { daemon_tests_required: true, web_tests_required: true, workspace_validation_required: true },
      enabled: { daemon_unit_tests: true, e2e_vitest: true, workspace_unit_tests: true },
      trace: { escalations: [] },
    });
    expect(decision.trace.ruleHits).toMatchObject({ "component-ledger-gate": 1, "web-sources": 1, "certain-exempt-surface": 1 });
  });

  test("routes the 21st.dev catalog to daemon tests and workspace checks; the Cult inventory keeps its route", () => {
    // The daemon's /api/21st routes read packages/21st-catalog/generated/ at run time; the
    // package's own check and tests run in the workspace jobs.
    for (const file of ["packages/21st-catalog/generated/21st-items.json", "packages/21st-catalog/originals/base.css"]) {
      expect(plan("pr", [file])).toMatchObject({
        scopes: { daemon_tests_required: true, web_tests_required: false, ui_critical_validation_required: false, workspace_validation_required: true, agency_tests_required: false },
        enabled: { daemon_unit_tests: true, e2e_vitest: false, playwright_critical: false, workspace_unit_tests: true, static_gate: true, agency_tests: false },
        trace: { escalations: [] },
      });
    }
    // The Cult inventory keeps its workspace and agency route; its catalog.json is also a
    // component-ledger input (the licensed-pack cohort), so it runs the daemon unit tests too.
    const cult = plan("pr", ["packages/cult-ui-catalog/catalog.json"]);
    expect(cult).toMatchObject({
      scopes: { daemon_tests_required: true, workspace_validation_required: true, agency_tests_required: true },
      enabled: { daemon_unit_tests: true, workspace_unit_tests: true, static_gate: true, agency_tests: true },
      trace: { escalations: [] },
    });
    expect(cult.trace.ruleHits).toMatchObject({ "cult-ui-catalog-sources": 1, "component-ledger-gate": 1 });
    // Other Cult inventory files are not ledger inputs and keep the workspace route only.
    expect(plan("pr", ["packages/cult-ui-catalog/generated/thumbnails.json"])).toMatchObject({
      scopes: { daemon_tests_required: false, workspace_validation_required: true, agency_tests_required: true },
      enabled: { daemon_unit_tests: false, workspace_unit_tests: true, static_gate: true, agency_tests: true },
      trace: { escalations: [] },
    });
  });

  test("routes canonical DSH installer sources to E2E Vitest", () => {
    expect(plan("pr", ["tools/release/resources/dsh-bootstrap/install-dsh.sh"])).toMatchObject({
      scopes: { web_tests_required: true },
      enabled: { e2e_vitest: true },
    });
    expect(plan("pr", ["tools/release/resources/dsh-bootstrap/install-dsh.ps1"])).toMatchObject({
      scopes: { web_tests_required: true },
      enabled: { e2e_vitest: true },
    });
  });

  test("runs planner contract tests for CI control-plane changes", () => {
    const controlPlaneFiles = [
      ".github/config/scopes.json",
      ".github/config/convergence.json",
      ".github/config/runners.json",
      ".github/scripts/scopes.py",
      ".github/scripts/convergence.py",
      ".github/scripts/runners.py",
      ".github/scripts/handoff.py",
      ".github/scripts/lib/config.py",
      ".github/scripts/lib/github.py",
      ".github/scripts/lib/r2.py",
      ".github/workflows/convergence.atom.yml",
    ];
    for (const file of controlPlaneFiles) {
      expect(plan("pr", [file]), file).toMatchObject({
        scopes: { web_tests_required: true, workspace_validation_required: true },
        enabled: { e2e_vitest: true, workspace_unit_tests: true },
        trace: { escalations: [] },
      });
    }
  });

  test("keeps Terminal exact sources on the independent release validation line", () => {
    for (const file of [
      "apps/closure/src/index.ts",
      "packages/standalone/src/store.ts",
      "shells/terminal/src/cli.ts",
      ".github/scripts/pack.py",
      ".github/scripts/release.py",
      ".github/workflows/convergence-exact.atom.yml",
      ".github/workflows/release-exact.yml",
    ]) {
      const prPlan = plan("pr", [file]);
      expect(prPlan, file).toMatchObject({
        scopes: { workspace_validation_required: false },
        enabled: { workspace_unit_tests: true },
        trace: { escalations: [] },
      });
      expect(prPlan.enabled, file).not.toHaveProperty("terminal_scene");

      expect(plan("merge-queue", [file]), file).toMatchObject({
        scopes: { workspace_validation_required: false },
        enabled: { workspace_unit_tests: false },
        trace: { escalations: [] },
      });
    }
  });

  test("directly owns promoted merge-queue routing", () => {
    expect(plan("merge-queue", ["docs/spec.md"])).toMatchObject({
      enabled: { preflight: true, workspace_unit_tests: false, e2e_vitest: false },
      trace: { escalations: [] },
    });
    expect(plan("merge-queue", ["apps/daemon/src/server.ts"])).toMatchObject({
      enabled: { daemon_unit_tests: true, e2e_vitest: true, ui_p0: true, web_workspace_tests: false },
      trace: { escalations: [] },
    });
    expect(plan("merge-queue", ["apps/desktop/src/main.ts"])).toMatchObject({
      enabled: { windows_tools_pack_payload_tests: false, workspace_unit_tests: true, e2e_vitest: false },
      trace: { escalations: [] },
    });
    expect(plan("merge-queue", ["tools/pack/src/win/custom-installer.ts"])).toMatchObject({
      enabled: { windows_tools_pack_payload_tests: true, workspace_unit_tests: true, e2e_vitest: false },
      trace: { escalations: [] },
    });
    const medium = plan("merge-queue", ["apps/web/src/App.tsx"]);
    expect(medium.trace.escalations).toHaveLength(1);
    expect(Object.values(medium.scopes).filter((value) => typeof value === "boolean")).not.toContain(false);

    const unknown = plan("merge-queue", ["some-new-root/file.ts"]);
    expect(unknown).toMatchObject({ enabled: { windows_tools_pack_payload_tests: true } });
    expect(unknown.trace.escalations).toHaveLength(1);
  });

  test("keeps the Windows payload workload in forced-full plans", () => {
    expect(plan("full")).toMatchObject({ enabled: { windows_tools_pack_payload_tests: true } });
  });

  test("preserves the six-shard runtime-definition shadow candidate", () => {
    const candidate = plan("pr", ["apps/daemon/src/runtimes/defs/codex.ts"]);
    expect(candidate.trace.uiP0Shadow.mode).toBe("candidate");
    expect(candidate.trace.uiP0Shadow.matrix.map((entry) => entry.name)).toEqual([
      "entry-onboarding", "entry-settings", "project-workspace", "project-collab-health", "project-collab",
      "project-runtime",
    ]);
    expect(plan("pr", ["apps/daemon/src/server.ts"]).trace.uiP0Shadow.mode).toBe("full-fallback");
  });

  test("configuration remains a Linux workflow-control contract", () => {
    const workflow = readFileSync(path.join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    expect(workflow).toContain("python3 .github/scripts/scopes.py github-output");
    expect(workflow).not.toContain("scripts/scopes.ts");
    const windowsPayload = workflow.slice(
      workflow.indexOf("  windows_tools_pack_payload_tests:"),
      workflow.indexOf("  web_workspace_tests:"),
    );
    expect(windowsPayload).not.toMatch(/\.github\/scripts\/(?:scopes|convergence|runners)\.py/);
    expect(workflow).not.toContain("  terminal_scene:");
  });
});
