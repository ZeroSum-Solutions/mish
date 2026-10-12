/**
 * A small validator for the subset of JSON Schema (draft 2020-12) that
 * schema/section-catalog.schema.json uses: type, enum, const, pattern, minLength, minItems,
 * required, properties, additionalProperties, items, oneOf, and local `$ref` (`#/$defs/...`). No
 * dependency, so the same check runs in the build script, the tests, and later the daemon.
 *
 * `oneOf` is real JSON Schema `oneOf` semantics — a value must match **exactly one** branch, not
 * merely "at least one" (delta audit #14: a permissive "at least one" reading would silently accept
 * a value that matches two overlapping branches of a future schema edit). This schema's three
 * tagged unions (`spineAffinities`, `preview`, `content`) are mutually exclusive by their `const`
 * discriminant today, so this is currently equivalent to "at least one" for THIS schema — but it is
 * no longer an accident of that fact.
 *
 * Forked from `packages/genui-catalog/src/validate.ts` rather than shared: this package's schema
 * needs `oneOf` (for the three tagged unions above, none of which genui-catalog's schema has), and
 * a shared validator would have to grow a keyword every consumer doesn't use. A keyword outside the
 * supported set throws instead of being skipped silently, so a schema edit that needs more cannot
 * pass unchecked — `if`/`then` were dropped from that set because the schema has never used them;
 * add them back (with an implementation) the day a schema actually needs a conditional.
 */

import schemaJson from '../schema/section-catalog.schema.json' with { type: 'json' };
import { CULT_PRO_RIGHTS, INSERTABLE_V1, type SectionCatalog, type SectionCatalogEntry } from './types.ts';

export type JsonSchema = { [keyword: string]: unknown };
export interface SchemaIssue { path: string; message: string }

export const sectionCatalogSchema: JsonSchema = schemaJson as JsonSchema;

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const', 'pattern',
  'minLength', 'minItems', 'required', 'properties', 'additionalProperties', 'items', 'oneOf',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function typeMatches(expected: string, value: unknown): boolean {
  const actual = typeOf(value);
  return actual === expected || (expected === 'number' && actual === 'integer');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}: only local refs are supported`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) {
    node = isObject(node) ? node[part] : undefined;
  }
  if (!isObject(node)) throw new Error(`Unresolvable $ref ${ref}`);
  return node;
}

/** Every way `value` breaks `schema`; empty when it conforms. */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  root: JsonSchema = schema,
  path = '$',
): SchemaIssue[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${path}`);
  }
  if (typeof schema.$ref === 'string') {
    return validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path);
  }
  if (Array.isArray(schema.oneOf)) {
    const branches = schema.oneOf as JsonSchema[];
    const perBranch = branches.map((branch) => validateAgainstSchema(value, branch, root, path));
    const matching = perBranch.filter((issues) => issues.length === 0).length;
    // True `oneOf`: exactly one branch must match. "At least one" would silently accept a value
    // that matches two overlapping branches — this schema's branches happen to be mutually
    // exclusive by `const` discriminant today, but that must be enforced, not assumed (delta audit
    // #14).
    if (matching === 1) return [];
    if (matching === 0) {
      return [{ path, message: `matches none of ${branches.length} alternatives: ${perBranch.map((issues) => format(issues)).join(' | ')}` }];
    }
    return [{ path, message: `matches ${matching} of ${branches.length} alternatives, expected exactly one (oneOf)` }];
  }
  const issues: SchemaIssue[] = [];
  const fail = (message: string, at = path): void => { issues.push({ path: at, message }); };

  if (typeof schema.type === 'string' && !typeMatches(schema.type, value)) {
    fail(`expected ${schema.type}, got ${typeOf(value)}`);
    return issues;
  }
  if ('const' in schema && value !== schema.const) fail(`expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.includes(value as never)) {
    fail(`expected one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) fail(`shorter than ${schema.minLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
      fail(`does not match ${schema.pattern}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
    if (isObject(schema.items)) {
      value.forEach((item, index) => {
        issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, root, `${path}[${index}]`));
      });
    }
  }
  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) fail(`missing required property "${key}"`);
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childSchema = properties[key];
      if (isObject(childSchema)) {
        issues.push(...validateAgainstSchema(child, childSchema, root, `${path}.${key}`));
      } else if (schema.additionalProperties === false) {
        fail(`unknown property "${key}"`, `${path}.${key}`);
      } else if (isObject(schema.additionalProperties)) {
        issues.push(...validateAgainstSchema(child, schema.additionalProperties, root, `${path}.${key}`));
      }
    }
  }
  return issues;
}

/** Rules the schema cannot express: id uniqueness, and how sourceKind constrains the rest of an entry. */
export function sectionCatalogPolicyIssues(catalog: SectionCatalog): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  catalog.entries.forEach((entry, index) => {
    const at = `$.entries[${index}]`;
    if (seen.has(entry.id)) issues.push({ path: `${at}.id`, message: `duplicate id "${entry.id}"` });
    seen.add(entry.id);

    if (entry.sourceKind === 'hyperui' && entry.content.kind !== 'vendored-block') {
      issues.push({ path: `${at}.content.kind`, message: `sourceKind "hyperui" requires content.kind "vendored-block", got "${entry.content.kind}"` });
    }
    if (entry.sourceKind === 'motionsites-prompt') {
      if (entry.content.kind !== 'motion-prompt') {
        issues.push({ path: `${at}.content.kind`, message: `sourceKind "motionsites-prompt" requires content.kind "motion-prompt", got "${entry.content.kind}"` });
      }
      if (entry.rights.decision !== 'metadata-only') {
        issues.push({ path: `${at}.rights.decision`, message: `sourceKind "motionsites-prompt" requires rights.decision "metadata-only"` });
      }
      if (entry.rights.license !== 'proprietary') {
        issues.push({ path: `${at}.rights.license`, message: `sourceKind "motionsites-prompt" requires rights.license "proprietary"` });
      }
      if (entry.preview.kind !== 'external-link') {
        issues.push({ path: `${at}.preview.kind`, message: `sourceKind "motionsites-prompt" requires preview.kind "external-link" (never a locally hosted copy of the source's preview) — see docs/legal/LICENSE-COMPLIANCE.md` });
      }
      if (entry.access !== 'free-account' && entry.access !== 'paid-account') {
        issues.push({ path: `${at}.access`, message: `sourceKind "motionsites-prompt" requires access "free-account" or "paid-account", got "${entry.access}"` });
      }
    }
    if (entry.sourceKind === 'local-corpus') {
      // Owner-authored content bundled with the daemon (src/local-corpus.ts) — the opposite rights
      // posture from `motionsites-prompt` above: `bundle`/`project-specific`/`local` because the
      // daemon owns this content outright, never `metadata-only`/`proprietary`/an account tier.
      if (entry.content.kind !== 'local-prompt') {
        issues.push({ path: `${at}.content.kind`, message: `sourceKind "local-corpus" requires content.kind "local-prompt", got "${entry.content.kind}"` });
      }
      if (entry.rights.decision !== 'bundle') {
        issues.push({ path: `${at}.rights.decision`, message: `sourceKind "local-corpus" requires rights.decision "bundle"` });
      }
      if (entry.rights.license !== 'project-specific') {
        issues.push({ path: `${at}.rights.license`, message: `sourceKind "local-corpus" requires rights.license "project-specific"` });
      }
      if (entry.access !== 'local') {
        issues.push({ path: `${at}.access`, message: `sourceKind "local-corpus" requires access "local", got "${entry.access}"` });
      }
      if (entry.availability !== 'reference-only') {
        issues.push({ path: `${at}.availability`, message: `sourceKind "local-corpus" requires availability "reference-only" (a design prompt, not an adapter)` });
      }
    }
    if (entry.sourceKind === 'family-section') {
      if (entry.content.kind !== 'family-section') {
        issues.push({ path: `${at}.content.kind`, message: `sourceKind "family-section" requires content.kind "family-section", got "${entry.content.kind}"` });
      }
      if (entry.rights.decision !== 'same-family-only') {
        issues.push({ path: `${at}.rights.decision`, message: `sourceKind "family-section" requires rights.decision "same-family-only"` });
      }
      if (entry.availability !== 'reference-only') {
        issues.push({ path: `${at}.availability`, message: `sourceKind "family-section" requires availability "reference-only" (v1: family sections are selectable only through their own family's keep/drop controls, never cross-family)` });
      }
      if (entry.spineAffinities === 'any') {
        issues.push({ path: `${at}.spineAffinities`, message: `sourceKind "family-section" may not carry spineAffinities "any" — its rights.decision "same-family-only" means it is never a cross-family candidate, so "any" would let a spine-filtered picker surface it as one anyway (scope it to the owning spine, or "unclassified")` });
      }
    }
    if (entry.sourceKind === 'cult-pro') {
      // Licensed Cult UI Pro metadata (docs/legal/cult-ui-pro-rights.md). The rights triple is
      // fixed: a different licence, decision or evidence path means the row did not come from the
      // recorded owner decision. `local` because the licence is held, not an account tier.
      if (entry.content.kind !== 'cult-item') {
        issues.push({ path: `${at}.content.kind`, message: `sourceKind "cult-pro" requires content.kind "cult-item", got "${entry.content.kind}"` });
      }
      if (
        entry.rights.license !== CULT_PRO_RIGHTS.license
        || entry.rights.decision !== CULT_PRO_RIGHTS.decision
        || entry.rights.evidence !== CULT_PRO_RIGHTS.evidence
      ) {
        issues.push({ path: `${at}.rights`, message: `sourceKind "cult-pro" requires rights ${JSON.stringify(CULT_PRO_RIGHTS)}` });
      }
      if (entry.access !== 'local') {
        issues.push({ path: `${at}.access`, message: `sourceKind "cult-pro" requires access "local", got "${entry.access}"` });
      }
      if (entry.content.kind === 'cult-item' && entry.content.provenance.cultId !== entry.id) {
        issues.push({ path: `${at}.content.provenance.cultId`, message: `"${entry.content.provenance.cultId}" must equal the entry id "${entry.id}"` });
      }
      // A Cult entry is insertable exactly when it names its checked adapter, and that adapter's id
      // is the entry id (the overlay stamps it as `data-od-selected-section`).
      if (entry.content.kind === 'cult-item') {
        const adapterId = entry.content.adapterId;
        if (adapterId !== undefined && adapterId !== entry.id) {
          issues.push({ path: `${at}.content.adapterId`, message: `"${adapterId}" must equal the entry id "${entry.id}"` });
        }
        if ((adapterId !== undefined) !== (entry.availability === 'insertable')) {
          issues.push({ path: `${at}.availability`, message: 'a cult-pro entry is "insertable" exactly when content.adapterId names its checked adapter' });
        }
        if (entry.availability === 'insertable' && entry.sectionKind === 'page-composition') {
          issues.push({ path: `${at}.availability`, message: 'a whole Cult page is never insertable as one section' });
        }
      }
    } else if (entry.rights.license === 'licensed') {
      issues.push({ path: `${at}.rights.license`, message: `rights.license "licensed" is reserved for sourceKind "cult-pro" (the recorded Cult UI Pro licence), not a ${entry.sourceKind} entry` });
    }
    if (entry.content.kind === 'cult-item' && entry.sourceKind !== 'cult-pro') {
      issues.push({ path: `${at}.content.kind`, message: `content.kind "cult-item" requires sourceKind "cult-pro", got "${entry.sourceKind}"` });
    }
    if (
      entry.sectionKind === 'page-composition'
      && entry.sourceKind !== 'motionsites-prompt'
      && entry.sourceKind !== 'local-corpus'
      && entry.sourceKind !== 'cult-pro'
    ) {
      issues.push({ path: `${at}.sectionKind`, message: `"page-composition" only describes a whole landing page (a MotionSites prompt, a local-corpus "full-page" row, or a Cult UI Pro page), not a ${entry.sourceKind} entry` });
    }
    if (entry.availability === 'insertable' && entry.content.kind !== 'vendored-block' && entry.content.kind !== 'cult-item') {
      issues.push({ path: `${at}.availability`, message: `"insertable" requires content.kind "vendored-block" (a reviewed HyperUI adapter) or "cult-item" (a checked Cult adapter)` });
    }
  });
  return issues;
}

function format(issues: SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/** Schema and policy issues of a section catalog document. */
export function sectionCatalogIssues(value: unknown): SchemaIssue[] {
  const issues = validateAgainstSchema(value, sectionCatalogSchema);
  return issues.length > 0 ? issues : sectionCatalogPolicyIssues(value as SectionCatalog);
}

/** Returns `value` typed as a SectionCatalog, or throws listing every issue. */
export function validateSectionCatalog(value: unknown): SectionCatalog {
  const issues = sectionCatalogIssues(value);
  if (issues.length > 0) throw new Error(`Invalid section catalog:\n${format(issues)}`);
  return value as SectionCatalog;
}

/** Returns `value` typed as a SectionCatalogEntry, or throws listing every issue. */
export function validateSectionCatalogEntry(value: unknown, label = 'entry'): SectionCatalogEntry {
  const issues = validateAgainstSchema(value, { $ref: '#/$defs/entry' }, sectionCatalogSchema);
  if (issues.length > 0) throw new Error(`Invalid ${label}:\n${format(issues)}`);
  return value as SectionCatalogEntry;
}

/**
 * The rule phase B's own gate calls once it lands adapters: every `availability: 'insertable'`
 * entry must carry a `content.adapterId`. Not part of `sectionCatalogIssues`/`catalogIssues` —
 * v1's three insertable HyperUI entries (`INSERTABLE_V1`) ship without one, so wiring this into
 * this package's own `--check` would fail today. Phase B imports this directly once it assigns
 * adapters, instead of leaving a comment to come back to.
 */
export function missingInsertableAdapters(catalog: SectionCatalog): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  catalog.entries.forEach((entry, index) => {
    if (entry.availability !== 'insertable') return;
    if (entry.content.kind !== 'vendored-block' && entry.content.kind !== 'cult-item') return; // already reported by sectionCatalogPolicyIssues
    if (!entry.content.adapterId) {
      issues.push({ path: `$.entries[${index}].content.adapterId`, message: `"${entry.id}" is insertable but has no adapterId` });
    }
  });
  return issues;
}

/** True when `blockId` is one of the three HyperUI blocks v1 marks insertable. */
export function isInsertableV1(blockId: string): boolean {
  return INSERTABLE_V1.includes(blockId);
}
