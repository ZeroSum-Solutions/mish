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

/**
 * G5 round 3 (Grok audit FIX 4): fervor, maren, wrenfield and halcyon each fixed the same bug
 * class as the five families above — a model-writable nav-item label next to a fixed href — but
 * their nav is a dense, hand-templated header (not the `NAV_TARGET_ORDER.filter(rendered)` +
 * `NAV_LABELS[id]` shape those five share), so this is a second, purpose-built check rather than
 * a reuse of `NAV_FAMILIES` above: each family's own `NAV_LABELS` export is keyed by a short
 * semantic alias (e.g. fervor's `work`), not literally the section id, and there is no shared
 * `NAV_TARGET_ORDER` array to read the closed set from — `ALIAS_TO_TYPE` below is that mapping,
 * one per family, read directly from each render.ts's own nav-building call sites.
 */
const CONTENT_NAV_FAMILIES: ReadonlyArray<{ family: string; aliasToType: Record<string, string> }> = [
  { family: 'fervor', aliasToType: { work: 'work', expertise: 'expertise1', agency: 'manifesto', contact: 'contact' } },
  { family: 'maren', aliasToType: { collection: 'collection', craft: 'craft', ordering: 'ordering', reviews: 'reviews', visit: 'visit' } },
  { family: 'wrenfield', aliasToType: { services: 'services', process: 'process', work: 'featured', reviews: 'reviews' } },
  { family: 'halcyon', aliasToType: { nowShowing: 'nowShowing', collection: 'collection', events: 'events', visit: 'visit', join: 'membership' } },
];

test('each content-based family (fervor/maren/wrenfield/halcyon) nav label maps to exactly the section it names (G5 round 3)', async () => {
  const failures: string[] = [];

  for (const { family, aliasToType } of CONTENT_NAV_FAMILIES) {
    const dir = defaultPackageDir(family);
    const renderFile = path.join(dir, 'compiler', 'scripts', 'families', family, 'render.ts');
    const navModule = await import(pathToFileURL(renderFile).href) as { NAV_LABELS?: Record<string, string> };
    const { NAV_LABELS } = navModule;
    if (!NAV_LABELS) {
      failures.push(`${family}: render.ts exports no NAV_LABELS to check`);
      continue;
    }

    const pkg = await loadFamilyPackage(dir, family);
    const fixture = pkg.fixture as { sections: Array<{ id: string; type: string } | null> };
    const { html } = pkg.render(pkg.fixture, ENTRY);

    for (const [alias, type] of Object.entries(aliasToType)) {
      const label = NAV_LABELS[alias];
      if (label === undefined) {
        failures.push(`${family}: aliasToType names "${alias}" but NAV_LABELS has no entry for it — this test's own mapping is stale`);
        continue;
      }
      const section = fixture.sections.find((s) => s?.type === type);
      if (!section) {
        failures.push(`${family}: no section of type "${type}" in the reference fixture for alias "${alias}"`);
        continue;
      }
      const expectedAnchor = `href="#${section.id}">${escapeHtml(label)}</a>`;
      if (!html.includes(expectedAnchor)) {
        failures.push(`${family}: expected an anchor ${expectedAnchor} (alias "${alias}") in the rendered reference fixture, found none`);
      }
    }
  }

  assert.deepEqual(failures, [], failures.join('\n'));
});
