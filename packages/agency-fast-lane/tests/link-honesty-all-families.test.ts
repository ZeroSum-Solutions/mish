/**
 * G5 (link honesty in every bundled family): `dishonestLinks` is a family-agnostic structural
 * check on rendered HTML (`sections.ts`'s docblock) enforcing exactly three rules — every
 * `<a href>` is either an in-page anchor of a section that actually renders, a real destination
 * (`http(s):`, `mailto:`, `tel:` with content after the scheme), or absent. `run.ts` used to gate
 * this check behind an allowlist (`LINK_HONESTY_FAMILIES`) while several families still shipped
 * `href="#"` placeholder chrome; that allowlist is gone (see `run.ts`'s `mergeLinkHonesty`), so
 * this test is the thing that keeps the promise "it runs live for every bundled family" true: it
 * renders every family's own committed reference fixture and asserts zero offending hrefs.
 *
 * "Covered" (per G5's task text) means every family id the registry knows about was actually
 * exercised here, not just that a check exists in the abstract — so this test loads the
 * committed family registry itself and diffs its ids against the ones it rendered, rather than
 * hand-listing family names that could silently drift out of sync with the registry.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { loadFamilyRegistry } from '../src/atlas.ts';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';
import { selfSectionAnchors } from '../../../plugins/_official/shared/agency-compiler/scripts/sections.ts';

const ENTRY = 'index.html';

test('dishonestLinks runs live for every registered family, and every registered family is covered', async () => {
  const registry = await loadFamilyRegistry();
  const registryIds = new Set(registry.families.map((entry) => entry.family));
  assert.ok(registryIds.size > 0, 'the registry names at least one family');

  const tested = new Set<string>();
  const failures: string[] = [];

  for (const family of registryIds) {
    const pkg = await loadFamilyPackage(defaultPackageDir(family), family);
    tested.add(pkg.family);

    // Requirement 1: the check must actually be wired for this family, not merely importable.
    if (!pkg.checkLinkHonesty) {
      failures.push(`${family}: compiler copy exposes no checkLinkHonesty (dishonestLinks) at all`);
      continue;
    }

    const { html } = pkg.render(pkg.fixture, ENTRY);

    // Requirement 2, all three rules in one call: dishonestLinks(html) returns every href that is
    // not an anchor of a rendered section, not a real http(s)/mailto/tel destination with content
    // after the scheme, and not a bare drop — i.e. every "#", scheme-only, or invented-path href.
    const dishonest = pkg.checkLinkHonesty(html);
    if (dishonest.length > 0) failures.push(`${family}: dishonest link(s) on its own reference fixture: ${dishonest.join(', ')}`);

    // Belt-and-braces literal greps for the three named failure shapes, independent of
    // dishonestLinks's own implementation, so a bug in dishonestLinks itself cannot hide a real
    // `href="#"` from this test.
    const bareHash = [...html.matchAll(/href="#"/g)].length;
    if (bareHash > 0) failures.push(`${family}: ${bareHash} bare href="#" placeholder(s)`);
    const schemeOnly = [...html.matchAll(/href="(https?:|mailto:|tel:)"/gi)].length;
    if (schemeOnly > 0) failures.push(`${family}: ${schemeOnly} scheme-only href(s)`);

    // Belt-and-braces, independent of pkg.checkLinkHonesty's own composition: no CTA's href may
    // target its own containing section (G5 round 2 / Grok audit item 6) — an existing id is not
    // the same as an honest link; a self-section anchor is a dead button that only scrolls to the
    // top of the block the visitor is already reading.
    const selfAnchors = selfSectionAnchors(html);
    if (selfAnchors.length > 0) failures.push(`${family}: self-section anchor(s): ${selfAnchors.join(', ')}`);
  }

  assert.deepEqual([...tested].sort(), [...registryIds].sort(), 'every family in the registry was rendered and checked');
  assert.deepEqual(failures, [], failures.join('\n'));
});
