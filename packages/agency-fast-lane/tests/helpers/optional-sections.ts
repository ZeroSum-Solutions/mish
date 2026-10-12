/**
 * Render checks for a dropped optional section, shared by every family's drop test.
 *
 * `renderDropped(pkg, id)` puts `null` in the section's slot of the package's reference recipe
 * (see `plugins/_official/shared/agency-compiler/scripts/sections.ts`), renders it through the
 * package's own compiler — the contract runs first, so a refused drop throws here — and checks
 * what a drop must leave behind: no element, edit target or in-page link for the section, every
 * other section still present, none of its own assets requested, and no new dangling in-page
 * anchor. Some families already route by hash anchors that point at no element (watson's
 * `#watson-ui-route-*`, maben's `#projects`), so the last check compares against the full render
 * rather than demanding none at all.
 */

import assert from 'node:assert/strict';
import type { FamilyPackage, RenderResult } from '../../src/family.ts';
import { isObject, type Json, type JsonObject } from '../../src/spine.ts';

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `id="…"` in the page. */
export function elementIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!));
}

/** Every in-page `href="#…"` target that no element carries as its id. */
export function danglingAnchors(html: string): Set<string> {
  const ids = elementIds(html);
  return new Set([...html.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]!).filter((target) => !ids.has(target)));
}

/** Whether the page still names the section: as an element id, an edit target, or a link. */
export function mentionsSection(html: string, id: string): boolean {
  const quoted = escapeRegex(id);
  return new RegExp(`(?:\\sid|data-od-id)="${quoted}(?:"|:|--)|href="#${quoted}"`).test(html);
}

/** Every asset id a section references, anywhere under an `assets` key. */
export function assetIdsOf(value: Json | undefined, inAssets = false, out = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    if (inAssets) out.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => assetIdsOf(item, inAssets, out));
  } else if (isObject(value)) {
    for (const [key, child] of Object.entries(value)) assetIdsOf(child, inAssets || key === 'assets', out);
  }
  return out;
}

export function sectionsOf(recipe: JsonObject): Json[] {
  assert.ok(Array.isArray(recipe.sections), 'recipe has a sections array');
  return recipe.sections;
}

export function sectionIndex(recipe: JsonObject, id: string): number {
  const index = sectionsOf(recipe).findIndex((section) => isObject(section) && section.id === id);
  assert.ok(index >= 0, `the reference recipe has a section ${id}`);
  return index;
}

export type DroppedRender = { full: RenderResult; dropped: RenderResult; recipe: JsonObject };

/** Renders the package's reference recipe with `id` dropped, and checks the drop left nothing. */
export function renderDropped(pkg: FamilyPackage, id: string, entry = `${pkg.family}-r1.html`): DroppedRender {
  const full = pkg.render(structuredClone(pkg.fixture), entry);
  const recipe = structuredClone(pkg.fixture);
  const index = sectionIndex(recipe, id);
  const section = sectionsOf(recipe)[index];
  sectionsOf(recipe)[index] = null;
  const dropped = pkg.render(recipe, entry);

  assert.ok(mentionsSection(full.html, id), `${pkg.family}: the full page renders ${id}`);
  assert.ok(!mentionsSection(dropped.html, id), `${pkg.family}: no element, edit target or link for ${id}`);
  for (const other of sectionsOf(recipe)) {
    if (isObject(other) && typeof other.id === 'string') {
      assert.ok(mentionsSection(dropped.html, other.id), `${pkg.family}: ${other.id} still renders`);
    }
  }

  // Assets only the dropped section used are no longer requested; assets it shares stay.
  const elsewhere = assetIdsOf(recipe as Json);
  const own = [...assetIdsOf(section)].filter((asset) => !elsewhere.has(asset));
  const requested = new Set(dropped.approvedAssets.map((asset) => asset.id));
  for (const asset of own) assert.ok(!requested.has(asset), `${pkg.family}: asset ${asset} of ${id} is not requested`);
  for (const asset of requested) assert.ok(full.approvedAssets.some((candidate) => candidate.id === asset), `${pkg.family}: ${asset} was requested by the full page too`);

  const before = danglingAnchors(full.html);
  const introduced = [...danglingAnchors(dropped.html)].filter((target) => !before.has(target));
  assert.deepEqual(introduced, [], `${pkg.family}: dropping ${id} left no new dangling in-page link`);
  return { full, dropped, recipe };
}
