import { describe, expect, test } from "vitest";

import { collectSetupReport, type ReportFetch } from "../../../scripts/team-setup-report.ts";

// Behaviour contract for the post-start report `scripts/team-setup.sh` prints: each optional key a
// teammate may want is shown present or missing with the Settings place or env var that fixes it,
// and each draft or expected-but-absent design kit gets one fix line. Nothing here may fail setup.

const DAEMON = "http://127.0.0.1:7456";

type Routes = Record<string, unknown>;

function fakeFetch(routes: Routes): ReportFetch {
  return async (url: string) => {
    const pathAndQuery = url.slice(DAEMON.length);
    if (!(pathAndQuery in routes)) return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    const body = routes[pathAndQuery];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
}

const NOTHING_CONFIGURED: Routes = {
  "/api/agency/config": { configured: false, source: "none", models: { deepseek: { configured: false, source: "none" } } },
  "/api/deploy/config?providerId=vercel-self": { providerId: "vercel-self", configured: false },
  "/api/mcp/servers": { servers: [] },
  "/api/design-systems": { designSystems: [{ id: "neutral-product", title: "Neutral Product", source: "built-in", status: "published" }] },
};

function line(lines: string[], label: string): string {
  const found = lines.find((entry) => entry.includes(label));
  if (found == null) throw new Error(`no report line for ${label}:\n${lines.join("\n")}`);
  return found;
}

describe("team-setup report: optional keys", () => {
  test("[P0] reports each key as missing with the Settings place and env var that fixes it", async () => {
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: {}, fetch: fakeFetch(NOTHING_CONFIGURED) });
    const jev = line(report.lines, "Jev (TypeSafe)");
    expect(jev).toMatch(/missing/);
    expect(jev).toMatch(/Settings → Media providers/);
    expect(jev).toMatch(/TYPESAFE_API_KEY/);
    const deepseek = line(report.lines, "DeepSeek");
    expect(deepseek).toMatch(/missing/);
    expect(deepseek).toMatch(/DEEPSEEK_API_KEY/);
    const cerebras = line(report.lines, "Cerebras");
    expect(cerebras).toMatch(/missing/);
    expect(cerebras).toMatch(/CEREBRAS_API_KEY/);
    expect(cerebras).toMatch(/alternative to DeepSeek/);
    const vercel = line(report.lines, "Vercel token");
    expect(vercel).toMatch(/missing/);
    expect(vercel).toMatch(/Settings/);
    const mobbin = line(report.lines, "Mobbin");
    expect(mobbin).toMatch(/missing/);
    expect(mobbin).toMatch(/External MCP/);
  });

  test("[P0] reports configured keys as present with their source, and never prints a key value", async () => {
    const routes: Routes = {
      ...NOTHING_CONFIGURED,
      "/api/agency/config": { configured: true, source: "env", models: { deepseek: { configured: true, source: "stored" }, cerebras: { configured: true, source: "env" } } },
      "/api/deploy/config?providerId=vercel-self": { providerId: "vercel-self", configured: true, tokenMask: "vcp_…9f2a" },
      "/api/mcp/servers": { servers: [{ id: "mobbin", label: "Mobbin", url: "https://mcp.mobbin.com/mcp" }] },
    };
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: { TYPESAFE_API_KEY: "sk-secret-value" }, fetch: fakeFetch(routes) });
    expect(line(report.lines, "Jev (TypeSafe)")).toMatch(/present \(env\)/);
    expect(line(report.lines, "DeepSeek")).toMatch(/present \(stored\)/);
    expect(line(report.lines, "Cerebras")).toMatch(/present \(env\)/);
    expect(line(report.lines, "Vercel token")).toMatch(/present/);
    expect(line(report.lines, "Mobbin")).toMatch(/present/);
    expect(report.lines.join("\n")).not.toContain("sk-secret-value");
    expect(report.lines.join("\n")).not.toContain("9f2a");
  });

  test("[P0] an unreachable daemon is reported, not thrown", async () => {
    const routes: Routes = { ...NOTHING_CONFIGURED, "/api/agency/config": new Error("ECONNREFUSED") };
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: {}, fetch: fakeFetch(routes) });
    expect(line(report.lines, "Jev (TypeSafe)")).toMatch(/unknown/);
  });
});

describe("team-setup report: design kits", () => {
  test("[P0] a draft kit is reported with the one-line publish command", async () => {
    const routes: Routes = {
      ...NOTHING_CONFIGURED,
      "/api/design-systems": {
        designSystems: [
          { id: "neutral-product", title: "Neutral Product", source: "built-in", status: "published" },
          { id: "user:atlas-dental", title: "Atlas Dental", source: "user", status: "draft" },
        ],
      },
    };
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: {}, fetch: fakeFetch(routes) });
    const draft = line(report.lines, "user:atlas-dental");
    expect(draft).toMatch(/draft/);
    expect(draft).toContain(`curl -X PATCH ${DAEMON}/api/design-systems/user:atlas-dental`);
    expect(draft).toContain(`'{"status":"published"}'`);
  });

  test("[P0] an expected kit that is not installed is reported with the install command", async () => {
    const report = await collectSetupReport({
      daemonUrl: DAEMON,
      env: { OD_SETUP_EXPECTED_KITS: "atlas-dental, neutral-product" },
      fetch: fakeFetch(NOTHING_CONFIGURED),
    });
    const absent = line(report.lines, "atlas-dental");
    expect(absent).toMatch(/not installed/);
    expect(absent).toContain("od design-systems import-local");
    expect(report.lines.some((entry) => entry.includes("neutral-product") && /not installed/.test(entry))).toBe(false);
  });

  test("[P1] an expected kit installed as published is reported ready", async () => {
    const routes: Routes = {
      ...NOTHING_CONFIGURED,
      "/api/design-systems": { designSystems: [{ id: "user:atlas-dental", title: "Atlas Dental", source: "user", status: "published" }] },
    };
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: { OD_SETUP_EXPECTED_KITS: "atlas-dental" }, fetch: fakeFetch(routes) });
    expect(line(report.lines, "atlas-dental")).toMatch(/ready/);
  });
});

describe("team-setup report: Apply status", () => {
  test("[P1] with --adoption it prints the daemon's executor state and every gate that keeps it closed", async () => {
    const routes: Routes = {
      ...NOTHING_CONFIGURED,
      "/api/workbench/adoption/status": {
        status: { executor: "closed", placementMode: "ordinary-uncoordinated", gates: ["ordinary-mode", "adoption-opt-in-labs-off"] },
      },
    };
    const report = await collectSetupReport({ daemonUrl: DAEMON, env: {}, fetch: fakeFetch(routes), adoption: true });
    const apply = line(report.lines, "Apply");
    expect(apply).toMatch(/closed/);
    expect(apply).toContain("ordinary-mode");
    expect(apply).toContain("adoption-opt-in-labs-off");
  });
});
