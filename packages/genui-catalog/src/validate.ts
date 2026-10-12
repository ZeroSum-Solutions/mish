/**
 * A small validator for the subset of JSON Schema (draft 2020-12) that schema/catalog.schema.json
 * uses: type, enum, const, pattern, minLength, minimum, required, properties,
 * additionalProperties, items, if/then and local `$ref` (`#/$defs/...`). No dependency, so the
 * same check runs in the build scripts, the tests, the daemon and the browser.
 *
 * A keyword outside that subset throws instead of being skipped silently, so a schema edit that
 * needs more cannot pass unchecked.
 */

import schemaJson from '../schema/catalog.schema.json' with { type: 'json' };
import { BUDGET, type Catalog, type ComponentMeta } from './types.ts';

export type JsonSchema = { [keyword: string]: unknown };
export interface SchemaIssue { path: string; message: string }

export const catalogSchema: JsonSchema = schemaJson as JsonSchema;

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const', 'pattern',
  'minLength', 'minimum', 'required', 'properties', 'additionalProperties', 'items', 'if', 'then',
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
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    fail(`less than ${schema.minimum}`);
  }
  if (Array.isArray(value) && isObject(schema.items)) {
    value.forEach((item, index) => {
      issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, root, `${path}[${index}]`));
    });
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
  if (isObject(schema.if) && isObject(schema.then)) {
    if (validateAgainstSchema(value, schema.if, root, path).length === 0) {
      issues.push(...validateAgainstSchema(value, schema.then, root, path));
    }
  }
  return issues;
}

/** Rules the schema cannot express: unique ids, and what a ported entry may be. */
export function catalogPolicyIssues(catalog: Catalog): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const seen = new Set<string>();
  catalog.components.forEach((entry, index) => {
    const at = `$.components[${index}]`;
    if (seen.has(entry.id)) issues.push({ path: `${at}.id`, message: `duplicate id "${entry.id}"` });
    seen.add(entry.id);
    if (entry.status !== 'ported') return;
    if (entry.licenceDecision === 'cut') issues.push({ path: at, message: `"${entry.id}" is ported but its licenceDecision is cut` });
    for (const field of ['entry', 'css', 'demo'] as const) {
      const file = entry[field];
      if (file && !file.startsWith(`components/${entry.id}/`)) {
        issues.push({ path: `${at}.${field}`, message: `${file} is not under components/${entry.id}/` });
      }
    }
    if (entry.bytes && entry.bytes.js > BUDGET.js) issues.push({ path: `${at}.bytes.js`, message: `${entry.bytes.js} B of JS exceeds the ${BUDGET.js} B budget` });
    if (entry.bytes && entry.bytes.css > BUDGET.css) issues.push({ path: `${at}.bytes.css`, message: `${entry.bytes.css} B of CSS exceeds the ${BUDGET.css} B budget` });
  });
  return issues;
}

function format(issues: SchemaIssue[]): string {
  return issues.map((issue) => `${issue.path}: ${issue.message}`).join('\n');
}

/** Schema and policy issues of a catalog document. */
export function catalogIssues(value: unknown): SchemaIssue[] {
  const issues = validateAgainstSchema(value, catalogSchema);
  return issues.length > 0 ? issues : catalogPolicyIssues(value as Catalog);
}

/** Returns `value` typed as a Catalog, or throws listing every issue. */
export function validateCatalog(value: unknown): Catalog {
  const issues = catalogIssues(value);
  if (issues.length > 0) throw new Error(`Invalid genui catalog:\n${format(issues)}`);
  return value as Catalog;
}

/** Returns `value` typed as a ComponentMeta, or throws listing every issue. */
export function validateComponentMeta(value: unknown, label = 'meta.json'): ComponentMeta {
  const issues = validateAgainstSchema(value, { $ref: '#/$defs/componentMeta' }, catalogSchema);
  if (issues.length > 0) throw new Error(`Invalid ${label}:\n${format(issues)}`);
  return value as ComponentMeta;
}
