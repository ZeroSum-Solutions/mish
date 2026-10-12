/**
 * A dependency-free validator for the JSON Schema subset schema/cult-ui-catalog.schema.json uses:
 * type (a name or a list), enum, const, pattern, minLength, minimum, minItems, required,
 * properties, additionalProperties, items, oneOf (exactly one branch) and local `$ref`.
 * String and number keywords apply only to values of that type, so `type: ["string", "null"]`
 * works. A keyword outside the set throws, so a schema edit that needs more cannot pass unchecked.
 * Forked in spirit from packages/section-catalog/src/validate.ts.
 */

export type JsonSchema = { [keyword: string]: unknown };
export interface SchemaIssue { path: string; message: string }

const SUPPORTED = new Set([
  '$schema', '$id', '$defs', '$ref', 'title', 'description', 'type', 'enum', 'const', 'pattern',
  'minLength', 'minimum', 'minItems', 'required', 'properties', 'additionalProperties', 'items', 'oneOf',
]);

function typeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  return typeof value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(ref: string, root: JsonSchema): JsonSchema {
  if (!ref.startsWith('#/')) throw new Error(`Unsupported $ref ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split('/')) node = isObject(node) ? node[part] : undefined;
  if (!isObject(node)) throw new Error(`Unresolvable $ref ${ref}`);
  return node;
}

function typeIssue(schema: JsonSchema, value: unknown, path: string): SchemaIssue | null {
  if (schema.type === undefined) return null;
  const expected = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
  const actual = typeOf(value);
  const ok = expected.some((t) => t === actual || (t === 'number' && actual === 'integer'));
  return ok ? null : { path, message: `expected ${expected.join('|')}, got ${actual}` };
}

function scalarIssues(schema: JsonSchema, value: unknown, path: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if ('const' in schema && value !== schema.const) issues.push({ path, message: `expected ${JSON.stringify(schema.const)}` });
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    issues.push({ path, message: `${JSON.stringify(value)} is not one of the closed values` });
  }
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) issues.push({ path, message: 'too short' });
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      issues.push({ path, message: `does not match ${schema.pattern}` });
    }
  }
  if (typeof value === 'number' && typeof schema.minimum === 'number' && value < schema.minimum) {
    issues.push({ path, message: `below ${schema.minimum}` });
  }
  return issues;
}

function containerIssues(schema: JsonSchema, value: unknown, root: JsonSchema, path: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) issues.push({ path, message: 'too few items' });
    if (isObject(schema.items)) {
      value.forEach((item, i) => issues.push(...validateAgainstSchema(item, schema.items as JsonSchema, root, `${path}[${i}]`)));
    }
  }
  if (isObject(value)) {
    const props = isObject(schema.properties) ? schema.properties : {};
    for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(key in value)) issues.push({ path, message: `missing required ${key}` });
    }
    for (const [key, child] of Object.entries(value)) {
      const sub = props[key];
      if (isObject(sub)) issues.push(...validateAgainstSchema(child, sub, root, `${path}.${key}`));
      else if (schema.additionalProperties === false) issues.push({ path, message: `unexpected property ${key}` });
    }
  }
  return issues;
}

export function validateAgainstSchema(value: unknown, schema: JsonSchema, root: JsonSchema = schema, path = '$'): SchemaIssue[] {
  for (const keyword of Object.keys(schema)) {
    if (!SUPPORTED.has(keyword)) throw new Error(`Unsupported JSON Schema keyword "${keyword}" at ${path}`);
  }
  if (typeof schema.$ref === 'string') return validateAgainstSchema(value, resolveRef(schema.$ref, root), root, path);
  if (Array.isArray(schema.oneOf)) {
    const matching = (schema.oneOf as JsonSchema[]).filter((b) => validateAgainstSchema(value, b, root, path).length === 0);
    return matching.length === 1 ? [] : [{ path, message: `matches ${matching.length} oneOf branches, expected exactly 1` }];
  }
  const type = typeIssue(schema, value, path);
  if (type) return [type];
  return [...scalarIssues(schema, value, path), ...containerIssues(schema, value, root, path)];
}
