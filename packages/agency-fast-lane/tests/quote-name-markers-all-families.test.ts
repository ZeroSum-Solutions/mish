/**
 * G5 round 2 (Grok audit item 3): "Add a registry-driven test that finds every quote-like or
 * name-like slot across all families and asserts it carries a marker." A quote a family renders
 * as a customer's own words needs `x-verify: 'quote'` so the faithfulness gate checks it against
 * the brief; a name attributed to that quote needs `x-atom: 'person-name'` so an invented name
 * never ships silently (it must be nullable — a review with no named author renders with no name,
 * never a name the model made up). This test finds both kinds of slot structurally, from the
 * schema itself, not from a hand-maintained list of "family X has a quote at path Y" that could
 * drift the moment a family's schema changes shape.
 *
 * Detection: a "quote-like" slot is any schema property whose own key matches /quote|testimonial/i
 * (a plain string field, since the schema always models a quote as one). A quote slot's carrying
 * object is then searched for a "name-like" sibling — any property in the SAME `properties` object
 * matching /name|byline|author|attribution/i — and asserted to carry `x-atom: 'person-name'`. This
 * is deliberately narrower than "every field named *name*" (which would also catch `brand.name`,
 * a pricing tier's plan name, a menu item's name, a room's name — none of them a person): scoping
 * the name-like search to a quote's own siblings is what tells apart "the person who said this
 * quote" from every other kind of name a recipe schema carries.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyRegistry } from '../src/atlas.ts';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';

type JsonObject = Record<string, unknown>;

const QUOTE_LIKE = /quote|testimonial/i;
const NAME_LIKE = /name|byline|author|attribution/i;

/** True when `node` itself, or any branch of its `oneOf`, carries `key: value`. Nullable atoms
 * are frequently modeled as `oneOf: [{type: 'null'}, {..., x-atom: 'person-name'}]`. */
function carriesMarker(node: unknown, key: string, value: string): boolean {
  if (typeof node !== 'object' || node === null) return false;
  const obj = node as JsonObject;
  if (obj[key] === value) return true;
  const oneOf = obj.oneOf;
  if (Array.isArray(oneOf)) return oneOf.some((branch) => carriesMarker(branch, key, value));
  return false;
}

function walk(node: unknown, path: string, failures: string[], family: string): void {
  if (Array.isArray(node)) {
    node.forEach((entry, index) => walk(entry, `${path}[${index}]`, failures, family));
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  const obj = node as JsonObject;

  const properties = obj.properties;
  if (properties && typeof properties === 'object') {
    const propNames = Object.keys(properties as JsonObject);
    for (const propName of propNames) {
      const propSchema = (properties as JsonObject)[propName];
      const propPath = `${path}/properties/${propName}`;

      if (QUOTE_LIKE.test(propName)) {
        if (!carriesMarker(propSchema, 'x-verify', 'quote')) {
          failures.push(`${family}: ${propPath} looks like a quote but carries no x-verify: 'quote'`);
        }
        // Search this quote's own siblings for the name attributed to it.
        for (const siblingName of propNames) {
          if (siblingName === propName || !NAME_LIKE.test(siblingName)) continue;
          const siblingSchema = (properties as JsonObject)[siblingName];
          if (!carriesMarker(siblingSchema, 'x-atom', 'person-name')) {
            failures.push(`${family}: ${path}/properties/${siblingName} sits beside quote-like ${propName} but carries no x-atom: 'person-name'`);
          }
        }
      }
      walk(propSchema, propPath, failures, family);
    }
  }

  for (const key of ['$defs', 'items', 'prefixItems', 'oneOf', 'anyOf']) {
    if (key in obj) walk(obj[key], `${path}/${key}`, failures, family);
  }
}

test('every quote-like and its attributed name-like slot, across every registered family, carries its shared gate marker (G5 round 2)', async () => {
  const registry = await loadFamilyRegistry();
  const registryIds = new Set(registry.families.map((entry) => entry.family));
  assert.ok(registryIds.size > 0, 'the registry names at least one family');

  const failures: string[] = [];
  for (const family of registryIds) {
    const pkg = await loadFamilyPackage(defaultPackageDir(family), family);
    walk(pkg.schema, '', failures, family);
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
