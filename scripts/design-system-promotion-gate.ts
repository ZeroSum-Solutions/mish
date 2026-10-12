/* ─────────────────────────────────────────────────────────────────────────
 * scripts/design-system-promotion-gate.ts
 *
 * Promotion gate for design systems that ship `promotion.json`.
 * Standard: docs/design-systems/QUALITY-STANDARD.md
 * Record schema: design-systems/_schema/promotion.schema.ts
 *
 * Usage:
 *   node --experimental-strip-types scripts/design-system-promotion-gate.ts [id ...] [--json]
 *
 * With no id, the gate checks every design system that has promotion.json.
 * Exit code 1 when any checked record fails the rules for its status.
 * Also registered in `pnpm guard` as "design system promotion records",
 * "no unpromoted design-system references" and "default design system allowed".
 *
 * Status rules:
 *   draft, internal-review  record schema valid; machine results are advisory.
 *   candidate               + every machine criterion passes, and the record's
 *                             machine results match what the gate computes.
 *   promoted                + every criterion is pass or justified na, and at
 *                             least one independent critique of this version
 *                             has verdict pass.
 *   deprecated              record schema valid and deprecation.deprecatedAt set.
 * ─────────────────────────────────────────────────────────────────── */

import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseDesignSystemProjectManifest } from "../design-systems/_schema/manifest.schema.ts";
import {
  PROMOTION_CRITERIA,
  parseDesignSystemPromotionRecord,
  type CriterionResult,
  type DesignSystemPromotionRecord,
} from "../design-systems/_schema/promotion.schema.ts";
import { DEFAULT_DESIGN_SYSTEM_IDS } from "../packages/contracts/src/design-systems/defaults.ts";
import {
  validateComponentsManifestCache,
  validateDesignTokensJson,
  validateTailwindV4Css,
} from "./check-design-system-manifests.ts";
import { evaluateDesignSystemPackageQuality } from "./check-design-system-package-quality.ts";
import { loadPackageFiles, runMachineChecks, type ContrastRow } from "./lib/design-system-promotion/checks.ts";

const repoRoot = path.resolve(import.meta.dirname, "..");
export const DESIGN_SYSTEMS_ROOT = path.join(repoRoot, "design-systems");

export type CriterionRow = {
  readonly id: string;
  readonly title: string;
  readonly check: string;
  readonly recorded: CriterionResult | "missing";
  /** Machine and critique criteria only. */
  readonly computed?: "pass" | "fail" | "pending";
  readonly messages: readonly string[];
};

export type GateResult = {
  readonly id: string;
  readonly version: string | null;
  readonly status: string | null;
  readonly ok: boolean;
  readonly errors: readonly string[];
  readonly criteria: readonly CriterionRow[];
  readonly contrast: readonly ContrastRow[];
};

export async function evaluatePromotion(designSystemRoot: string): Promise<GateResult> {
  const id = path.basename(designSystemRoot);
  const empty = { id, version: null, status: null, ok: false, criteria: [], contrast: [] };

  const recordText = await readText(path.join(designSystemRoot, "promotion.json"));
  if (recordText == null) return { ...empty, errors: ["promotion.json does not exist"] };
  const parsedRecord = parseDesignSystemPromotionRecord(recordText);
  if (!parsedRecord.ok) return { ...empty, errors: parsedRecord.errors.map((error) => `promotion.json: ${error}`) };
  const record = parsedRecord.record;

  const manifestText = await readText(path.join(designSystemRoot, "manifest.json"));
  const parsedManifest = manifestText == null ? null : parseDesignSystemProjectManifest(manifestText);
  if (parsedManifest == null || !parsedManifest.ok) {
    const reason = parsedManifest == null ? ["manifest.json does not exist"] : parsedManifest.errors;
    return { ...empty, version: record.version, status: record.status, errors: reason.map((error) => `manifest.json: ${error}`) };
  }
  const manifest = parsedManifest.manifest;

  const errors: string[] = [];
  if (record.id !== id) errors.push(`promotion.json id "${record.id}" must match folder "${id}"`);
  if (manifest.id !== id) errors.push(`manifest.json id "${manifest.id}" must match folder "${id}"`);
  errors.push(...(await missingEvidence(designSystemRoot, record)));

  const files = await loadPackageFiles(designSystemRoot, manifest, record);
  const packageViolations = await packageContractViolations(designSystemRoot, files);
  const machine = await runMachineChecks(files, record, packageViolations);
  const criteria = criterionRows(record, machine.outcomes);

  errors.push(...statusErrors(record, criteria));
  return { id, version: record.version, status: record.status, ok: errors.length === 0, errors, criteria, contrast: machine.contrast };
}

async function packageContractViolations(
  root: string,
  files: Awaited<ReturnType<typeof loadPackageFiles>>,
): Promise<string[]> {
  const { manifest } = files;
  const violations: string[] = [];
  const declared = [
    manifest.files.design,
    manifest.files.tokens,
    manifest.files.designTokens,
    manifest.files.tailwind,
    manifest.files.components,
    manifest.usage,
    manifest.componentsManifest,
    ...(manifest.preview?.pages ?? []).map((page) => page.path),
    ...Object.values(manifest.sourceFiles ?? {}),
  ].filter((file): file is string => file !== undefined);
  for (const file of declared) {
    if (!(await exists(path.join(root, file)))) violations.push(`${file} is declared in manifest.json but does not exist`);
  }
  if (files.designMd != null && files.tokensCss != null) {
    const quality = evaluateDesignSystemPackageQuality({
      id: manifest.id,
      manifest,
      designMd: files.designMd,
      tokensCss: files.tokensCss,
      componentsHtml: files.componentsHtml ?? undefined,
      usageMd: files.usageMd ?? undefined,
    });
    violations.push(...quality.violations);
  }
  const label = "manifest.json";
  await validateDesignTokensJson(violations, label, root, manifest.files.tokens, manifest.files.designTokens, manifest.sourceFiles?.report);
  await validateTailwindV4Css(violations, label, root, manifest.files.tokens, manifest.files.tailwind);
  await validateComponentsManifestCache(violations, label, root, manifest.id, manifest.componentsManifest);
  return violations;
}

async function missingEvidence(root: string, record: DesignSystemPromotionRecord): Promise<string[]> {
  const errors: string[] = [];
  for (const [criterionId, entry] of Object.entries(record.criteria)) {
    for (const evidence of entry.evidence) {
      if (!(await exists(path.join(root, evidence)))) errors.push(`${criterionId} evidence ${evidence} does not exist`);
    }
  }
  for (const critique of record.critiques) {
    if (!(await exists(path.join(root, critique.findings)))) {
      errors.push(`critique ${critique.id} findings ${critique.findings} does not exist`);
    }
  }
  return errors;
}

function criterionRows(
  record: DesignSystemPromotionRecord,
  outcomes: ReadonlyMap<string, { pass: boolean; messages: readonly string[] }>,
): CriterionRow[] {
  return PROMOTION_CRITERIA.map((spec): CriterionRow => {
    const recorded: CriterionRow["recorded"] = record.criteria[spec.id]?.result ?? "missing";
    const base = { id: spec.id, title: spec.title, check: spec.check, recorded };
    if (spec.check === "machine") {
      const result = outcomes.get(spec.id);
      if (result === undefined) return { ...base, computed: "fail", messages: ["no machine check is registered"] };
      return { ...base, computed: result.pass ? "pass" : "fail", messages: result.messages };
    }
    if (spec.check === "critique") {
      const passing = independentCritiquesOfVersion(record, "pass");
      // A recorded failing critique is reported as "fail", not "pending":
      // both keep promotion closed, but only one means nobody has looked.
      const computed = passing.length > 0 ? "pass" : independentCritiquesOfVersion(record, "fail").length > 0 ? "fail" : "pending";
      const messages = passing.length > 0 ? [] : [`no independent critique of version ${record.version} with verdict pass`];
      return { ...base, computed, messages };
    }
    return { ...base, messages: [] };
  });
}

function independentCritiquesOfVersion(
  record: DesignSystemPromotionRecord,
  verdict: DesignSystemPromotionRecord["critiques"][number]["verdict"],
): DesignSystemPromotionRecord["critiques"] {
  const authors = new Set([...record.authors, record.owner].map((name) => name.trim().toLowerCase()));
  return record.critiques.filter(
    (critique) =>
      critique.relationship === "independent" &&
      critique.verdict === verdict &&
      critique.versionReviewed === record.version &&
      !authors.has(critique.reviewer.trim().toLowerCase()),
  );
}

function statusErrors(record: DesignSystemPromotionRecord, rows: readonly CriterionRow[]): string[] {
  const errors: string[] = [];
  if (record.status === "draft" || record.status === "internal-review") return errors;
  if (record.status === "deprecated") {
    if (record.deprecation.deprecatedAt === undefined) errors.push("status deprecated requires deprecation.deprecatedAt");
    return errors;
  }

  for (const row of rows.filter((candidate) => candidate.check === "machine")) {
    if (row.computed !== "pass") errors.push(`${row.id} ${row.title}: machine check fails (${row.messages.length} finding(s))`);
    if (row.recorded !== row.computed) {
      errors.push(`${row.id}: promotion.json records "${row.recorded}" but the gate computes "${row.computed}"; update the record`);
    }
  }
  const critique = rows.find((row) => row.check === "critique");
  if (critique !== undefined && critique.recorded === "pass" && critique.computed !== "pass") {
    errors.push(`${critique.id}: promotion.json records "pass" but no independent passing critique of ${record.version} exists`);
  }
  if (record.status === "candidate") return errors;

  for (const row of rows) {
    if (row.recorded !== "pass" && row.recorded !== "na") {
      errors.push(`${row.id} ${row.title}: status promoted needs pass or justified na, found "${row.recorded}"`);
    }
  }
  if (critique?.computed !== "pass") {
    errors.push(`status promoted needs at least one independent critique of ${record.version} with verdict pass`);
  }
  return errors;
}

export function formatGateReport(result: GateResult): string {
  const lines = [`Design-system promotion gate: ${result.id}@${result.version ?? "?"} (status: ${result.status ?? "?"})`];
  for (const row of result.criteria) {
    const computed = row.computed === undefined ? "" : ` computed=${row.computed}`;
    lines.push(`  ${row.id} [${row.check.padEnd(8)}] recorded=${row.recorded.padEnd(7)}${computed.padEnd(18)} ${row.title}`);
    for (const message of row.messages.slice(0, 8)) lines.push(`      - ${message}`);
    if (row.messages.length > 8) lines.push(`      - … ${row.messages.length - 8} more`);
  }
  for (const mode of ["light", "dark"] as const) {
    const rows = result.contrast.filter((row) => row.mode === mode);
    if (rows.length === 0) continue;
    const passing = rows.filter((row) => row.pass).length;
    const lowest = rows.filter((row) => row.ratio != null).sort((a, b) => (a.ratio ?? 0) - (b.ratio ?? 0))[0];
    const lowestText = lowest === undefined ? "" : `; lowest ${lowest.fg} on ${lowest.bg} ${lowest.ratio}:1 (${lowest.kind})`;
    lines.push(`  Contrast ${mode}: ${passing}/${rows.length} pairs pass${lowestText}`);
  }
  const machine = result.criteria.filter((row) => row.check === "machine");
  const human = result.criteria.filter((row) => row.check === "human");
  lines.push(
    `  Summary: machine ${machine.filter((row) => row.computed === "pass").length}/${machine.length} pass; ` +
      `human ${human.filter((row) => row.recorded === "pass" || row.recorded === "na").length}/${human.length} attested; ` +
      `critique ${result.criteria.find((row) => row.check === "critique")?.computed ?? "pending"}`,
  );
  for (const error of result.errors) lines.push(`  ERROR ${error}`);
  lines.push(`  Result: ${result.ok ? "PASS" : "FAIL"} for status ${result.status ?? "unknown"}`);
  return lines.join("\n");
}

export async function discoverPromotionRoots(designSystemsRoot = DESIGN_SYSTEMS_ROOT): Promise<string[]> {
  const entries = await readdir(designSystemsRoot, { withFileTypes: true });
  const roots: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const root = path.join(designSystemsRoot, entry.name);
    if (await exists(path.join(root, "promotion.json"))) roots.push(root);
  }
  return roots.sort((a, b) => a.localeCompare(b));
}

async function discoverDesignSystemIds(designSystemsRoot: string): Promise<string[]> {
  const entries = await readdir(designSystemsRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("_"))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * Design-system ids with no `promotion.json` next to their `manifest.json`.
 * Every bundled design system must carry a record, so a deleted
 * `promotion.json` cannot silently drop a system from promotion enforcement.
 * (The five brand-derived systems that were once exempt were removed on
 * 2026-09-23; there is no exemption list any more.)
 */
export async function findDesignSystemsMissingPromotionRecord(designSystemsRoot = DESIGN_SYSTEMS_ROOT): Promise<string[]> {
  const missing: string[] = [];
  for (const id of await discoverDesignSystemIds(designSystemsRoot)) {
    if (!(await exists(path.join(designSystemsRoot, id, "promotion.json")))) missing.push(id);
  }
  return missing;
}

/** `pnpm guard` entry: every promotion record must pass the rules for its status. */
export async function checkDesignSystemPromotionRecords(): Promise<boolean> {
  const missing = await findDesignSystemsMissingPromotionRecord();
  if (missing.length > 0) {
    console.error(
      `${missing.length} design system(s) have no promotion.json: ${missing.join(", ")}. ` +
        "Every bundled design system must carry a promotion record.",
    );
    return false;
  }

  const results = await Promise.all((await discoverPromotionRoots()).map((root) => evaluatePromotion(root)));
  if (results.length === 0) {
    console.error("No design system has a promotion.json record.");
    return false;
  }
  const failed = results.filter((result) => !result.ok);
  for (const result of failed) console.error(formatGateReport(result));
  if (failed.length > 0) return false;
  const summary = results.map((result) => `${result.id}@${result.version} ${result.status}`).join(", ") || "none";
  console.log(`Design system promotion records passed: ${results.length} record(s) (${summary}).`);
  return true;
}

/*
 * ── Finding 7: candidate systems stay selectable, but no bundled example or
 * template may treat a non-promoted design system as its own. See
 * docs/design-systems/QUALITY-STANDARD.md "Candidate selectability" and
 * docs/plans/2026-09-22-design-system-wave-0.md "Decisions".
 */

export const DESIGN_TEMPLATES_ROOT = path.join(repoRoot, "design-templates");
export const OFFICIAL_EXAMPLES_ROOT = path.join(repoRoot, "plugins", "_official", "examples");

export type UnpromotedDesignSystemReference = {
  /** Path relative to the repo root. */
  readonly file: string;
  readonly designSystemId: string;
  /** `null` when the id names no design system at all (typo, or never existed). */
  readonly status: string | null;
};

/** Every `{ "designSystem": { "ref": "<id>", ... } }` object anywhere in a parsed JSON value. */
function collectDesignSystemRefs(value: unknown, refs: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectDesignSystemRefs(item, refs);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (key === "designSystem" && nested !== null && typeof nested === "object") {
      const ref = (nested as Record<string, unknown>).ref;
      if (typeof ref === "string") refs.add(ref);
    }
    collectDesignSystemRefs(nested, refs);
  }
}

async function walkJsonFiles(root: string): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
    if (entries == null) return;
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
    }
  }
  await walk(root);
  return found;
}

async function promotionStatus(designSystemsRoot: string, id: string): Promise<string | null> {
  const text = await readText(path.join(designSystemsRoot, id, "promotion.json"));
  if (text == null) return null;
  try {
    const parsed = JSON.parse(text) as { status?: unknown };
    return typeof parsed.status === "string" ? parsed.status : null;
  } catch {
    return null;
  }
}

/**
 * A bundled example or template ships as an "official asset" — it must not
 * reference (`context.designSystem.ref`) a design system that is anything
 * other than `promoted`. Candidate systems stay selectable for interactive
 * generation so their human sign-offs can be completed in real use; they
 * must not also feed an example or template output. (Code defaults have
 * their own rule: see `findUnallowedDefaultDesignSystems`.)
 */
export async function findUnpromotedDesignSystemReferences(
  roots: readonly string[] = [DESIGN_TEMPLATES_ROOT, OFFICIAL_EXAMPLES_ROOT],
  designSystemsRoot = DESIGN_SYSTEMS_ROOT,
): Promise<UnpromotedDesignSystemReference[]> {
  const violations: UnpromotedDesignSystemReference[] = [];
  const statusCache = new Map<string, string | null>();
  for (const root of roots) {
    for (const file of await walkJsonFiles(root)) {
      const text = await readText(file);
      if (text == null) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue;
      }
      const refs = new Set<string>();
      collectDesignSystemRefs(parsed, refs);
      for (const id of refs) {
        if (!statusCache.has(id)) statusCache.set(id, await promotionStatus(designSystemsRoot, id));
        const status = statusCache.get(id) ?? null;
        if (status !== "promoted") violations.push({ file: path.relative(repoRoot, file), designSystemId: id, status });
      }
    }
  }
  return violations;
}

/** `pnpm guard` entry: no bundled example or template may reference a non-promoted design system. */
export async function checkNoUnpromotedDesignSystemReferences(): Promise<boolean> {
  const violations = await findUnpromotedDesignSystemReferences();
  if (violations.length === 0) {
    console.log("No bundled example or template references a design system that is not promoted.");
    return true;
  }
  console.error("Bundled examples/templates must reference only promoted design systems:");
  for (const violation of violations) {
    console.error(`  ${violation.file} -> ${violation.designSystemId} (status: ${violation.status ?? "no promotion.json"})`);
  }
  return false;
}

/*
 * ── Default design system in code. Every code default reads
 * `DEFAULT_DESIGN_SYSTEM_IDS` (packages/contracts/src/design-systems/defaults.ts).
 * A default must be `promoted`. While no bundled system is promoted, a
 * `candidate` system may be the default: today that is `neutral-product`,
 * the only bundled system. The exception ends when the first system is
 * promoted. See QUALITY-STANDARD.md "Default design system".
 */

export type UnallowedDefaultDesignSystem = {
  readonly designSystemId: string;
  /** `null` when the id names no design system with a promotion record. */
  readonly status: string | null;
};

export async function findUnallowedDefaultDesignSystems(
  defaultIds: readonly string[] = DEFAULT_DESIGN_SYSTEM_IDS,
  designSystemsRoot = DESIGN_SYSTEMS_ROOT,
): Promise<UnallowedDefaultDesignSystem[]> {
  const statuses = await Promise.all(
    (await discoverDesignSystemIds(designSystemsRoot)).map((id) => promotionStatus(designSystemsRoot, id)),
  );
  const anyPromoted = statuses.includes("promoted");
  const violations: UnallowedDefaultDesignSystem[] = [];
  for (const id of defaultIds) {
    const status = await promotionStatus(designSystemsRoot, id);
    const allowed = status === "promoted" || (!anyPromoted && status === "candidate");
    if (!allowed) violations.push({ designSystemId: id, status });
  }
  return violations;
}

/** `pnpm guard` entry: every design-system default in code names an allowed system. */
export async function checkDefaultDesignSystems(): Promise<boolean> {
  const violations = await findUnallowedDefaultDesignSystems();
  if (violations.length === 0) {
    console.log(`Default design system(s) allowed: ${DEFAULT_DESIGN_SYSTEM_IDS.join(", ")}.`);
    return true;
  }
  console.error(
    "A design-system default in code must be promoted, or a candidate while no system is promoted " +
      "(packages/contracts/src/design-systems/defaults.ts):",
  );
  for (const violation of violations) {
    console.error(`  ${violation.designSystemId} (status: ${violation.status ?? "no promotion.json"})`);
  }
  return false;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return null;
  }
}

async function main(argv: readonly string[]): Promise<number> {
  const json = argv.includes("--json");
  const ids = argv.filter((arg) => !arg.startsWith("--"));
  const roots = ids.length > 0 ? ids.map((id) => path.join(DESIGN_SYSTEMS_ROOT, id)) : await discoverPromotionRoots();
  if (roots.length === 0) {
    console.error("No design system has a promotion.json record.");
    return 1;
  }
  const results = await Promise.all(roots.map((root) => evaluatePromotion(root)));
  if (json) {
    console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
  } else {
    console.log(results.map(formatGateReport).join("\n\n"));
  }
  return results.every((result) => result.ok) ? 0 : 1;
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
