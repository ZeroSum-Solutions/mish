// Post-start report for `scripts/team-setup.sh`: which optional keys and design kits a teammate
// still has to provide. It reads the running daemon over its public HTTP API only, never prints a
// key value, and never fails setup — a missing key or kit is a line to act on, not an error.
//
//   pnpm exec tsx scripts/team-setup-report.ts --daemon-url <url> [--adoption]
//
import { pathToFileURL } from "node:url";

// OD_SETUP_EXPECTED_KITS (optional, comma-separated design-system ids) names kits the team expects
// to be installed; each one that is absent gets an install line.

export type ReportResponse = { ok: boolean; status: number; json: () => Promise<unknown> };
export type ReportFetch = (url: string, init?: { signal?: AbortSignal }) => Promise<ReportResponse>;

export interface SetupReportInput {
  daemonUrl: string;
  env: Readonly<Record<string, string | undefined>>;
  fetch: ReportFetch;
  /** Also report the adoption executor ("Apply") state and its closing gates. */
  adoption?: boolean;
}

export interface SetupReport {
  lines: string[];
}

type Json = Record<string, unknown>;

const UNREACHABLE = Symbol("unreachable");

function asRecord(value: unknown): Json | null {
  return value != null && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

async function readJson(input: SetupReportInput, pathAndQuery: string): Promise<Json | typeof UNREACHABLE> {
  try {
    const response = await input.fetch(`${input.daemonUrl}${pathAndQuery}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return UNREACHABLE;
    return asRecord(await response.json()) ?? UNREACHABLE;
  } catch {
    return UNREACHABLE;
  }
}

function keyLine(label: string, state: "present" | "missing" | "unknown", detail: string): string {
  return `optional key  ${label}: ${state}${detail}`;
}

function sourceSuffix(source: unknown): string {
  return typeof source === "string" && source.length > 0 && source !== "none" ? ` (${source})` : "";
}

async function keyLines(input: SetupReportInput): Promise<string[]> {
  const lines: string[] = [];
  const agency = await readJson(input, "/api/agency/config");
  const jevFix = " — fix: Settings → Media providers → Jev (TypeSafe), or TYPESAFE_API_KEY in .env.local";
  const deepseekFix = " — fix: Settings → Media providers → DeepSeek (fast lane), or DEEPSEEK_API_KEY in .env.local (one fast-lane key is enough)";
  const cerebrasFix = " — fix: Settings → Media providers → Cerebras (fast lane), or CEREBRAS_API_KEY in .env.local (alternative to DeepSeek)";
  if (agency === UNREACHABLE) {
    lines.push(keyLine("Jev (TypeSafe)", "unknown", ` (daemon did not answer)${jevFix}`));
    lines.push(keyLine("DeepSeek", "unknown", ` (daemon did not answer)${deepseekFix}`));
    lines.push(keyLine("Cerebras", "unknown", ` (daemon did not answer)${cerebrasFix}`));
  } else {
    lines.push(agency.configured === true
      ? keyLine("Jev (TypeSafe)", "present", sourceSuffix(agency.source))
      : keyLine("Jev (TypeSafe)", "missing", jevFix));
    // The fast lane fills pages with DeepSeek or Cerebras; either one is enough.
    const models = asRecord(agency.models);
    for (const [label, provider, fix] of [["DeepSeek", "deepseek", deepseekFix], ["Cerebras", "cerebras", cerebrasFix]] as const) {
      const model = asRecord(models?.[provider]);
      lines.push(model?.configured === true
        ? keyLine(label, "present", sourceSuffix(model.source))
        : keyLine(label, "missing", fix));
    }
  }

  const vercel = await readJson(input, "/api/deploy/config?providerId=vercel-self");
  const vercelFix = " — fix: Settings → Share → Vercel (paste a token and team), or Share → Vercel in any project";
  if (vercel === UNREACHABLE) lines.push(keyLine("Vercel token", "unknown", ` (daemon did not answer)${vercelFix}`));
  else lines.push(vercel.configured === true ? keyLine("Vercel token", "present", "") : keyLine("Vercel token", "missing", vercelFix));

  const mcp = await readJson(input, "/api/mcp/servers");
  const mobbinFix = " — fix: Settings → External MCP → add the Mobbin server (optional; reference screens only)";
  if (mcp === UNREACHABLE) {
    lines.push(keyLine("Mobbin binding", "unknown", ` (daemon did not answer)${mobbinFix}`));
  } else {
    const servers = Array.isArray(mcp.servers) ? mcp.servers : [];
    const bound = servers.some((server) => {
      const record = asRecord(server);
      return record != null && ["id", "name", "label", "url"].some((field) => /mobbin/i.test(String(record[field] ?? "")));
    });
    lines.push(bound ? keyLine("Mobbin binding", "present", "") : keyLine("Mobbin binding", "missing", mobbinFix));
  }
  return lines;
}

function expectedKitIds(env: SetupReportInput["env"]): string[] {
  return (env.OD_SETUP_EXPECTED_KITS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** A kit named `atlas-dental` in the expected list matches an installed `user:atlas-dental`. */
function sameKit(installedId: string, expectedId: string): boolean {
  return installedId === expectedId || installedId === `user:${expectedId}` || `user:${installedId}` === expectedId;
}

async function kitLines(input: SetupReportInput): Promise<string[]> {
  const listing = await readJson(input, "/api/design-systems");
  if (listing === UNREACHABLE) return ["design kits: unknown (daemon did not answer) — check later with: od design-systems list"];
  const systems = (Array.isArray(listing.designSystems) ? listing.designSystems : [])
    .map(asRecord)
    .filter((system): system is Json => system != null && typeof system.id === "string");

  const lines: string[] = [];
  for (const system of systems) {
    if (system.status !== "draft") continue;
    const id = String(system.id);
    lines.push(
      `design kit  ${id} (${String(system.title ?? id)}): installed as draft, so generation will not use it — fix: ` +
        `curl -X PATCH ${input.daemonUrl}/api/design-systems/${id} -H 'content-type: application/json' -d '{"status":"published"}'`,
    );
  }
  for (const expected of expectedKitIds(input.env)) {
    const installed = systems.find((system) => sameKit(String(system.id), expected));
    if (installed == null) {
      lines.push(`design kit  ${expected}: not installed — fix: od design-systems import-local <path-to-${expected}-kit>`);
    } else if (installed.status !== "draft") {
      lines.push(`design kit  ${expected}: ready (${String(installed.id)})`);
    }
  }
  if (lines.length === 0) lines.push("design kits: no draft kits; set OD_SETUP_EXPECTED_KITS to check for the team's kits");
  return lines;
}

async function adoptionLines(input: SetupReportInput): Promise<string[]> {
  const body = await readJson(input, "/api/workbench/adoption/status");
  if (body === UNREACHABLE) return ["Apply: unknown (daemon did not answer) — check with: od workbench adoption status --json"];
  const status = asRecord(body.status) ?? {};
  const gates = Array.isArray(status.gates) ? status.gates.map(String) : [];
  const executor = String(status.executor ?? "unknown");
  if (executor === "open") return ["Apply: executor open"];
  return [`Apply: executor ${executor}; gates still closing it: ${gates.length > 0 ? gates.join(", ") : "none reported"}`];
}

export async function collectSetupReport(input: SetupReportInput): Promise<SetupReport> {
  const lines = [...(await keyLines(input)), ...(await kitLines(input))];
  if (input.adoption === true) lines.push(...(await adoptionLines(input)));
  return { lines };
}

function parseArgs(argv: readonly string[]): { daemonUrl: string | null; adoption: boolean } {
  let daemonUrl: string | null = null;
  let adoption = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--daemon-url") daemonUrl = argv[++index] ?? null;
    else if (arg === "--adoption") adoption = true;
  }
  return { daemonUrl: daemonUrl?.replace(/\/+$/, "") ?? null, adoption };
}

async function main(): Promise<void> {
  const { daemonUrl, adoption } = parseArgs(process.argv.slice(2));
  if (daemonUrl == null) {
    process.stdout.write("Setup report skipped: no daemon URL.\n");
    return;
  }
  const report = await collectSetupReport({
    daemonUrl,
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    adoption,
  });
  process.stdout.write(`\nOptional keys and design kits (none of these blocks setup):\n`);
  for (const line of report.lines) process.stdout.write(`  ${line}\n`);
}

if (process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    // The report is advisory: say what went wrong and let setup finish.
    process.stdout.write(`Setup report unavailable: ${error instanceof Error ? error.message : String(error)}\n`);
  });
}
