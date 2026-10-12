/**
 * G5 round 2 (Grok audit item 1): "Nav labels are zipped to sections by array index in restaurant,
 * docs-hub, community, listings and nonprofit. Replace this with explicit label→section pairing:
 * each nav item carries a section key from a closed set, and its href is that section's anchor,
 * only while that section renders... Add a test per family: each nav label maps to the section it
 * names."
 *
 * The fix (see each family's own `render.ts`) replaced index-zipping with a fixed `NAV_LABELS`
 * map keyed by section id, generating nav purely from `NAV_TARGET_ORDER.filter(renderedIds.has)`
 * — no model-authored nav text, and a label can only ever pair with the section id it is keyed
 * under. This test asserts that pairing holds on the RENDERED page, not just in source: every nav
 * `<a href="#id">label</a>` this fixture actually produces must have `id` in the family's own
 * closed `NAV_TARGET_ORDER` set, and `label` must be exactly `NAV_LABELS[id]` — so an index-zip
 * regression (or a future edit that reintroduces one) fails here immediately.
 *
 * publication uses the identical fixed-map pattern and is included for the same reason, though the
 * audit named only the five families whose original bug was the index-zip.
 *
 * app-shell and marketing-site are out of scope here: their nav never carried a model-authored
 * label. storefront is also out of scope, but NOT for that reason — its featured-product nav link
 * carried a model-writable label until a round-2 Grok audit found it (the anchor always opened the
 * product section regardless of what the label text said); `render.ts`'s `FEATURED_NAV_LABEL`
 * fixes that the same way every other family here does. It stays out of this test because its nav
 * mixes that one fixed label with a separate `NAV_LABELS` map for the up-to-three dynamic entries
 * (storefront's own precedent this file's six families copy), a two-source shape this test's
 * single-NAV_LABELS-export assumption does not model; its own render.test.ts covers it instead
 * ("the header nav is capped at four links total").
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';

const ENTRY = 'index.html';

/** Families whose `render.ts` exports the fixed `NAV_LABELS` / `NAV_TARGET_ORDER` pair this test
 * checks against the rendered page. Every family here shipped the array-index nav bug the Grok
 * audit found, or (docs-hub, publication) was fixed proactively using the same pattern. */
const NAV_FAMILIES = ['restaurant', 'docs-hub', 'community', 'listings', 'nonprofit', 'publication'];

type NavModule = { NAV_LABELS: Record<string, string>; NAV_TARGET_ORDER: readonly string[] };

/** The rendered page HTML-escapes label text; compare against the same escaping rather than
 * reimplementing (or importing) each family's own escape function. */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}

test('each fixed-chrome family nav label maps to exactly the section id it names (G5 round 2)', async () => {
  const failures: string[] = [];

  for (const family of NAV_FAMILIES) {
    const dir = defaultPackageDir(family);
    const renderFile = path.join(dir, 'compiler', 'scripts', 'families', family, 'render.ts');
    const navModule = await import(pathToFileURL(renderFile).href) as Partial<NavModule>;
    const { NAV_LABELS, NAV_TARGET_ORDER } = navModule;
    if (!NAV_LABELS || !NAV_TARGET_ORDER) {
      failures.push(`${family}: render.ts exports no NAV_LABELS/NAV_TARGET_ORDER to check`);
      continue;
    }
    const closedSet = new Set(NAV_TARGET_ORDER);

    const pkg = await loadFamilyPackage(dir, family);
    const { html } = pkg.render(pkg.fixture, ENTRY);

    // Every anchor whose href targets a member of the closed nav-key set, and carries no
    // data-od-id (the fixed-chrome nav pattern: no model-authored text, so no reconcilable slot
    // on the link itself) is a nav link this test must check.
    const navLinks = [...html.matchAll(/<a href="#([a-z0-9-]+)"(?![^>]*data-od-id)[^>]*>([^<]*)<\/a>/g)]
      .filter((match) => closedSet.has(match[1]!));

    if (navLinks.length === 0) failures.push(`${family}: no nav links found in the rendered reference fixture`);

    for (const match of navLinks) {
      const [, target, label] = match;
      if (!closedSet.has(target!)) {
        failures.push(`${family}: nav link href="#${target}" is not in NAV_TARGET_ORDER's closed set`);
        continue;
      }
      const expected = NAV_LABELS[target!];
      if (expected === undefined) {
        failures.push(`${family}: NAV_TARGET_ORDER names ${target} but NAV_LABELS has no entry for it`);
      } else if (label !== escapeHtml(expected)) {
        failures.push(`${family}: nav link href="#${target}" reads "${label}", expected the fixed label "${expected}"`);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
