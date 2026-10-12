/* ─────────────────────────────────────────────────────────────────────────
 * design-systems/_schema/promotion.schema.ts
 *
 * Contract for `design-systems/<id>/promotion.json`, the promotion record
 * of one design system. The record is a sibling of `manifest.json` on
 * purpose: the v1 project manifest rejects unknown keys, and promotion
 * state (lifecycle, criteria results, critiques, changelog) changes on a
 * different cadence from discovery metadata.
 *
 * The human-readable standard is `docs/design-systems/QUALITY-STANDARD.md`.
 * The executable gate is `scripts/design-system-promotion-gate.ts`.
 * `PROMOTION_CRITERIA` below is the single list both of them use; keep
 * the standard's numbered criteria in the same order with the same ids.
 *
 * This module is pure TypeScript: no filesystem, no process access.
 * ─────────────────────────────────────────────────────────────────── */

export const DESIGN_SYSTEM_PROMOTION_SCHEMA_VERSION = "od-design-system-promotion/v1" as const;

export const PROMOTION_STATUSES = ["draft", "internal-review", "candidate", "promoted", "deprecated"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

export const CRITERION_RESULTS = ["pass", "fail", "na", "pending"] as const;
export type CriterionResult = (typeof CRITERION_RESULTS)[number];

export const CRITIQUE_VERDICTS = ["pass", "pass-with-fixes", "fail"] as const;
export type CritiqueVerdict = (typeof CRITIQUE_VERDICTS)[number];

/** `machine`: the gate computes the result. `human`: a named person or agent attests it. `critique`: derived from critique records. */
export type CriterionCheck = "machine" | "human" | "critique";

export type PromotionCriterionSpec = {
  readonly id: string;
  readonly title: string;
  readonly check: CriterionCheck;
};

/** The name the gate writes into `checkedBy` for machine criteria. */
export const GATE_CHECKER = "promotion-gate" as const;

export const PROMOTION_CRITERIA: readonly PromotionCriterionSpec[] = [
  { id: "DSP-01", title: "Reference lock, provenance, and original rationale", check: "human" },
  { id: "DSP-02", title: "Complete semantic tokens", check: "machine" },
  { id: "DSP-03", title: "Light and dark modes", check: "machine" },
  { id: "DSP-04", title: "Foundation rules documented", check: "machine" },
  { id: "DSP-05", title: "Primitives, components, patterns, and states", check: "machine" },
  { id: "DSP-06", title: "Responsive layouts at 360, 768, and 1280", check: "machine" },
  { id: "DSP-07", title: "Touch and keyboard operation", check: "human" },
  { id: "DSP-08", title: "Reduced motion", check: "machine" },
  { id: "DSP-09", title: "Realistic content", check: "machine" },
  { id: "DSP-10", title: "Localization stress", check: "human" },
  { id: "DSP-11", title: "Contrast evidence (WCAG 2.2 AA)", check: "machine" },
  { id: "DSP-12", title: "Focus behavior", check: "machine" },
  { id: "DSP-13", title: "Screen-reader semantics", check: "human" },
  { id: "DSP-14", title: "Design-tool to code mapping", check: "human" },
  { id: "DSP-15", title: "Representative specimens", check: "machine" },
  { id: "DSP-16", title: "Visual-regression fixtures", check: "machine" },
  { id: "DSP-17", title: "Package contract and implementation checks", check: "machine" },
  { id: "DSP-18", title: "Documentation", check: "machine" },
  { id: "DSP-19", title: "Changelog, ownership, and deprecation policy", check: "machine" },
  { id: "DSP-20", title: "Independent design critique", check: "critique" },
  { id: "DSP-21", title: "Clean-consumer verification", check: "machine" },
];

export const SPECIMEN_KINDS = ["website", "app", "document", "campaign"] as const;
export type SpecimenKind = (typeof SPECIMEN_KINDS)[number];

export const FIXTURE_WIDTHS = [360, 1280] as const;
export const FIXTURE_THEMES = ["light", "dark"] as const;
export type FixtureTheme = (typeof FIXTURE_THEMES)[number];

export type ContrastKind = "text" | "large-text" | "ui";

export type ContrastPair = {
  readonly fg: string;
  readonly bg: string;
  readonly kind: ContrastKind;
};

export const CONTRAST_MINIMUMS: Readonly<Record<ContrastKind, number>> = {
  text: 4.5,
  "large-text": 3,
  ui: 3,
};

/**
 * Pairs every promoted system must pass in every mode. A record can add
 * more pairs through `contrast.pairs`; it cannot remove these.
 */
export const REQUIRED_CONTRAST_PAIRS: readonly ContrastPair[] = [
  { fg: "--fg", bg: "--bg", kind: "text" },
  { fg: "--fg", bg: "--surface", kind: "text" },
  { fg: "--fg", bg: "--surface-warm", kind: "text" },
  { fg: "--fg-2", bg: "--bg", kind: "text" },
  { fg: "--fg-2", bg: "--surface", kind: "text" },
  { fg: "--muted", bg: "--bg", kind: "text" },
  { fg: "--muted", bg: "--surface", kind: "text" },
  { fg: "--muted", bg: "--surface-warm", kind: "text" },
  { fg: "--meta", bg: "--bg", kind: "text" },
  { fg: "--meta", bg: "--surface", kind: "text" },
  { fg: "--accent", bg: "--bg", kind: "text" },
  { fg: "--accent", bg: "--surface", kind: "text" },
  { fg: "--accent-on", bg: "--accent", kind: "text" },
  { fg: "--accent-on", bg: "--accent-hover", kind: "text" },
  { fg: "--accent-on", bg: "--accent-active", kind: "text" },
  { fg: "--success", bg: "--surface", kind: "text" },
  { fg: "--warn", bg: "--surface", kind: "text" },
  { fg: "--danger", bg: "--surface", kind: "text" },
];

export type CriterionRecord = {
  readonly result: CriterionResult;
  /** `promotion-gate` for machine criteria; a person or agent name otherwise. */
  readonly checkedBy: string;
  /** YYYY-MM-DD. */
  readonly date: string;
  /** Paths relative to the design-system folder. */
  readonly evidence: readonly string[];
  readonly note?: string;
  /** Required when result is `na`. */
  readonly justification?: string;
};

export type CritiqueRecord = {
  readonly id: string;
  readonly reviewer: string;
  /** Must be `independent` to count toward promotion. */
  readonly relationship: "independent" | "author" | "owner";
  readonly date: string;
  readonly versionReviewed: string;
  readonly verdict: CritiqueVerdict;
  readonly scope: readonly string[];
  /** Path relative to the design-system folder. */
  readonly findings: string;
};

export type ChangelogEntry = {
  readonly version: string;
  readonly date: string;
  readonly summary: string;
};

export type VisualFixture = {
  readonly path: string;
  readonly page: string;
  readonly width: number;
  readonly theme: FixtureTheme;
};

export type DesignSystemPromotionRecord = {
  readonly schemaVersion: typeof DESIGN_SYSTEM_PROMOTION_SCHEMA_VERSION;
  readonly id: string;
  readonly version: string;
  readonly status: PromotionStatus;
  readonly owner: string;
  readonly authors: readonly string[];
  readonly specimens: Readonly<Record<SpecimenKind, string>>;
  readonly contrast: { readonly pairs: readonly ContrastPair[] };
  readonly visualRegression: { readonly fixtures: readonly VisualFixture[] };
  readonly criteria: Readonly<Record<string, CriterionRecord>>;
  readonly critiques: readonly CritiqueRecord[];
  readonly changelog: readonly ChangelogEntry[];
  readonly deprecation: {
    readonly policy: string;
    readonly deprecatedAt?: string;
    readonly replacedBy?: string;
  };
};

export type PromotionRecordValidationResult =
  | { readonly ok: true; readonly record: DesignSystemPromotionRecord }
  | { readonly ok: false; readonly errors: readonly string[] };

const TOP_LEVEL_KEYS = new Set([
  "schemaVersion",
  "id",
  "version",
  "status",
  "owner",
  "authors",
  "specimens",
  "contrast",
  "visualRegression",
  "criteria",
  "critiques",
  "changelog",
  "deprecation",
]);
const CRITERION_KEYS = new Set(["result", "checkedBy", "date", "evidence", "note", "justification"]);
const CRITIQUE_KEYS = new Set(["id", "reviewer", "relationship", "date", "versionReviewed", "verdict", "scope", "findings"]);
const CHANGELOG_KEYS = new Set(["version", "date", "summary"]);
const FIXTURE_KEYS = new Set(["path", "page", "width", "theme"]);
const PAIR_KEYS = new Set(["fg", "bg", "kind"]);
const DEPRECATION_KEYS = new Set(["policy", "deprecatedAt", "replacedBy"]);

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TOKEN = /^--[a-z0-9-]+$/;

export function parseDesignSystemPromotionRecord(raw: string): PromotionRecordValidationResult {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { ok: false, errors: [`promotion.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  return validateDesignSystemPromotionRecord(value);
}

export function validateDesignSystemPromotionRecord(value: unknown): PromotionRecordValidationResult {
  const errors: string[] = [];
  if (!isRecord(value)) return { ok: false, errors: ["promotion record must be a JSON object"] };

  rejectUnknownKeys(errors, "$", value, TOP_LEVEL_KEYS);
  if (value.schemaVersion !== DESIGN_SYSTEM_PROMOTION_SCHEMA_VERSION) {
    errors.push(`$.schemaVersion must be ${JSON.stringify(DESIGN_SYSTEM_PROMOTION_SCHEMA_VERSION)}`);
  }
  expectPattern(errors, "$.id", value.id, SLUG, "a lowercase slug");
  expectPattern(errors, "$.version", value.version, SEMVER, "a semver version");
  expectOneOf(errors, "$.status", value.status, PROMOTION_STATUSES);
  expectNonEmptyString(errors, "$.owner", value.owner);
  expectStringArray(errors, "$.authors", value.authors, { nonEmpty: true });

  validateSpecimens(errors, value.specimens);
  validateContrast(errors, value.contrast);
  validateVisualRegression(errors, value.visualRegression);
  validateCriteria(errors, value.criteria);
  validateCritiques(errors, value.critiques);
  validateChangelog(errors, value.changelog);
  validateDeprecation(errors, value.deprecation);

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, record: value as DesignSystemPromotionRecord };
}

function validateSpecimens(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("$.specimens must be an object");
    return;
  }
  rejectUnknownKeys(errors, "$.specimens", value, new Set(SPECIMEN_KINDS));
  for (const kind of SPECIMEN_KINDS) expectSafeRelativePath(errors, `$.specimens.${kind}`, value[kind]);
}

function validateContrast(errors: string[], value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.pairs)) {
    errors.push("$.contrast.pairs must be an array");
    return;
  }
  rejectUnknownKeys(errors, "$.contrast", value, new Set(["pairs"]));
  value.pairs.forEach((pair, index) => {
    const label = `$.contrast.pairs[${index}]`;
    if (!isRecord(pair)) {
      errors.push(`${label} must be an object`);
      return;
    }
    rejectUnknownKeys(errors, label, pair, PAIR_KEYS);
    expectPattern(errors, `${label}.fg`, pair.fg, TOKEN, "a custom property name");
    expectPattern(errors, `${label}.bg`, pair.bg, TOKEN, "a custom property name");
    expectOneOf(errors, `${label}.kind`, pair.kind, ["text", "large-text", "ui"] as const);
  });
}

function validateVisualRegression(errors: string[], value: unknown): void {
  if (!isRecord(value) || !Array.isArray(value.fixtures)) {
    errors.push("$.visualRegression.fixtures must be an array");
    return;
  }
  rejectUnknownKeys(errors, "$.visualRegression", value, new Set(["fixtures"]));
  value.fixtures.forEach((fixture, index) => {
    const label = `$.visualRegression.fixtures[${index}]`;
    if (!isRecord(fixture)) {
      errors.push(`${label} must be an object`);
      return;
    }
    rejectUnknownKeys(errors, label, fixture, FIXTURE_KEYS);
    expectSafeRelativePath(errors, `${label}.path`, fixture.path);
    expectSafeRelativePath(errors, `${label}.page`, fixture.page);
    if (typeof fixture.width !== "number" || !Number.isInteger(fixture.width) || fixture.width <= 0) {
      errors.push(`${label}.width must be a positive integer`);
    }
    expectOneOf(errors, `${label}.theme`, fixture.theme, FIXTURE_THEMES);
  });
}

function validateCriteria(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("$.criteria must be an object");
    return;
  }
  const known = new Set(PROMOTION_CRITERIA.map((criterion) => criterion.id));
  for (const key of Object.keys(value)) {
    if (!known.has(key)) errors.push(`$.criteria.${key} is not a known criterion id`);
  }
  for (const spec of PROMOTION_CRITERIA) {
    const label = `$.criteria.${spec.id}`;
    const entry = value[spec.id];
    if (!isRecord(entry)) {
      errors.push(`${label} is required`);
      continue;
    }
    rejectUnknownKeys(errors, label, entry, CRITERION_KEYS);
    expectOneOf(errors, `${label}.result`, entry.result, CRITERION_RESULTS);
    expectNonEmptyString(errors, `${label}.checkedBy`, entry.checkedBy);
    expectPattern(errors, `${label}.date`, entry.date, DATE, "a YYYY-MM-DD date");
    expectStringArray(errors, `${label}.evidence`, entry.evidence, { nonEmpty: false });
    if (Array.isArray(entry.evidence)) {
      entry.evidence.forEach((item, index) => expectSafeRelativePath(errors, `${label}.evidence[${index}]`, item));
    }
    if (entry.note !== undefined) expectNonEmptyString(errors, `${label}.note`, entry.note);
    if (entry.result === "na") expectNonEmptyString(errors, `${label}.justification`, entry.justification);
    if (spec.check === "machine" && entry.checkedBy !== GATE_CHECKER) {
      errors.push(`${label}.checkedBy must be "${GATE_CHECKER}" because ${spec.id} is machine-checked`);
    }
    if (spec.check !== "machine" && entry.checkedBy === GATE_CHECKER && entry.result !== "pending") {
      errors.push(`${label} is ${spec.check}-attested; "${GATE_CHECKER}" cannot attest it`);
    }
    if (spec.check !== "machine" && (entry.result === "pass" || entry.result === "fail")) {
      if (!Array.isArray(entry.evidence) || entry.evidence.length === 0) {
        errors.push(`${label}.evidence must name at least one file when a ${spec.check} result is ${String(entry.result)}`);
      }
    }
  }
}

function validateCritiques(errors: string[], value: unknown): void {
  if (!Array.isArray(value)) {
    errors.push("$.critiques must be an array");
    return;
  }
  value.forEach((critique, index) => {
    const label = `$.critiques[${index}]`;
    if (!isRecord(critique)) {
      errors.push(`${label} must be an object`);
      return;
    }
    rejectUnknownKeys(errors, label, critique, CRITIQUE_KEYS);
    expectNonEmptyString(errors, `${label}.id`, critique.id);
    expectNonEmptyString(errors, `${label}.reviewer`, critique.reviewer);
    expectOneOf(errors, `${label}.relationship`, critique.relationship, ["independent", "author", "owner"] as const);
    expectPattern(errors, `${label}.date`, critique.date, DATE, "a YYYY-MM-DD date");
    expectPattern(errors, `${label}.versionReviewed`, critique.versionReviewed, SEMVER, "a semver version");
    expectOneOf(errors, `${label}.verdict`, critique.verdict, CRITIQUE_VERDICTS);
    expectStringArray(errors, `${label}.scope`, critique.scope, { nonEmpty: true });
    expectSafeRelativePath(errors, `${label}.findings`, critique.findings);
  });
}

function validateChangelog(errors: string[], value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push("$.changelog must be a non-empty array");
    return;
  }
  value.forEach((entry, index) => {
    const label = `$.changelog[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${label} must be an object`);
      return;
    }
    rejectUnknownKeys(errors, label, entry, CHANGELOG_KEYS);
    expectPattern(errors, `${label}.version`, entry.version, SEMVER, "a semver version");
    expectPattern(errors, `${label}.date`, entry.date, DATE, "a YYYY-MM-DD date");
    expectNonEmptyString(errors, `${label}.summary`, entry.summary);
  });
}

function validateDeprecation(errors: string[], value: unknown): void {
  if (!isRecord(value)) {
    errors.push("$.deprecation must be an object");
    return;
  }
  rejectUnknownKeys(errors, "$.deprecation", value, DEPRECATION_KEYS);
  expectNonEmptyString(errors, "$.deprecation.policy", value.policy);
  if (value.deprecatedAt !== undefined) {
    expectPattern(errors, "$.deprecation.deprecatedAt", value.deprecatedAt, DATE, "a YYYY-MM-DD date");
  }
  if (value.replacedBy !== undefined) expectPattern(errors, "$.deprecation.replacedBy", value.replacedBy, SLUG, "a design-system id");
}

function rejectUnknownKeys(errors: string[], label: string, value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not part of the promotion record schema`);
  }
}

function expectNonEmptyString(errors: string[], label: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) errors.push(`${label} must be a non-empty string`);
}

function expectPattern(errors: string[], label: string, value: unknown, pattern: RegExp, description: string): void {
  if (typeof value !== "string" || !pattern.test(value)) errors.push(`${label} must be ${description}`);
}

function expectOneOf(errors: string[], label: string, value: unknown, allowed: readonly string[]): void {
  if (typeof value !== "string" || !allowed.includes(value)) errors.push(`${label} must be one of ${allowed.join(", ")}`);
}

function expectStringArray(errors: string[], label: string, value: unknown, options: { nonEmpty: boolean }): void {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim().length > 0)) {
    errors.push(`${label} must be an array of non-empty strings`);
    return;
  }
  if (options.nonEmpty && value.length === 0) errors.push(`${label} must not be empty`);
}

function expectSafeRelativePath(errors: string[], label: string, value: unknown): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    errors.push(`${label} must be a non-empty relative path`);
    return;
  }
  if (value.startsWith("/") || value.includes("\\") || /^[A-Za-z]:/.test(value)) {
    errors.push(`${label} must be a safe relative path`);
    return;
  }
  if (value.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    errors.push(`${label} must be a safe relative path without empty, "." or ".." segments`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
