/**
 * C16 output-scope labels: app and dashboard families are static prototypes, and say so in the
 * page and the manifest they export. `outputScopeOf` (the registry's `pageKind`) is the one
 * source: the product surfaces read it at runtime, and the sync materialises it into each packaged
 * compiler's `families/registry.ts`, from which `renderFamily` supplies it to the render. This
 * file checks the materialised rows, the page note and the manifest field all match it.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { loadFamilyRegistry, outputScopeOf, outputScopeOfPageKind } from '../src/atlas.ts';
import { defaultPackageDir, loadFamilyPackage } from '../src/family.ts';

test('outputScopeOfPageKind: site is a site, app and dashboard are static prototypes', () => {
  assert.equal(outputScopeOfPageKind('site'), 'site');
  assert.equal(outputScopeOfPageKind('app'), 'static-prototype');
  assert.equal(outputScopeOfPageKind('dashboard'), 'static-prototype');
});

test('outputScopeOf reads the bundled registry: app-shell and crm-dashboard are static prototypes', async () => {
  const registry = await loadFamilyRegistry();
  assert.equal(outputScopeOf(registry, 'app-shell'), 'static-prototype');
  assert.equal(outputScopeOf(registry, 'crm-dashboard'), 'static-prototype');
  assert.equal(outputScopeOf(registry, 'marketing-site'), 'site');
  assert.equal(outputScopeOf(registry, 'watson'), undefined);
  assert.equal(outputScopeOf(registry, 'no-such-family'), undefined);
  const prototypes = registry.families.filter((entry) => outputScopeOf(registry, entry.family) === 'static-prototype').map((entry) => entry.family);
  assert.deepEqual(prototypes.sort(), ['app-shell', 'crm-dashboard'], 'every app or dashboard family, and nothing else');
});

test('every family export agrees with the registry: the note and the manifest field', async () => {
  const registry = await loadFamilyRegistry();
  for (const { family } of registry.families) {
    const pkg = await loadFamilyPackage(defaultPackageDir(family), family);
    const { html, manifest } = pkg.render(pkg.fixture, `${family}-r1.html`);
    const expected = outputScopeOf(registry, family);
    assert.equal(manifest.metadata.agencySite.outputScope, expected, `${family}: manifest outputScope`);
    const hasNote = /<p role="note"[^>]*data-od-output-scope="static-prototype"/.test(html);
    assert.equal(hasNote, expected === 'static-prototype', `${family}: static-prototype note ${expected === 'static-prototype' ? 'missing' : 'present'}`);
    if (hasNote) assert.match(html, /script-src 'none'/, `${family}: CSP still refuses scripts`);
  }
});

test('every packaged compiler supplies the registry scope: its generated registry row matches outputScopeOf', async () => {
  const registry = await loadFamilyRegistry();
  for (const { family } of registry.families) {
    const rows = path.join(defaultPackageDir(family), 'compiler/scripts/families/registry.ts');
    const { FAMILIES } = (await import(pathToFileURL(rows).href)) as { FAMILIES: Record<string, { outputScope?: string }> };
    assert.equal(FAMILIES[family]?.outputScope, outputScopeOf(registry, family), `${family}: generated registry row outputScope`);
  }
});
