/**
 * The pure parts of the Cult render gate (scripts/render-check.ts). The browser pass itself runs
 * as `pnpm --filter @mish/cult-ui-catalog render-check` (CI: the agency tests job, which
 * installs Chromium) and proves itself on a planted self-test section every run.
 */

import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';

import { PACKAGE_DIR, worstCaseFill } from '../scripts/adapter-check.ts';
import { frozenPackageViolations, layoutFill } from '../scripts/render-check.ts';

type Slot = { name: string; max: number; atom?: 'phone' | 'email' | 'address' | 'plain' };
type Adapter = { id: string; version: string; css: string; text: readonly Slot[]; items?: { name: string; count: number; fields: readonly Slot[] }; render: (fill: unknown) => string };

const REPO_ROOT = resolve(PACKAGE_DIR, '..', '..');
const shared = await import(pathToFileURL(join(REPO_ROOT, 'plugins/_official/shared/agency-compiler/scripts/section-adapter.ts')).href) as {
  validateAdapterFill: (adapter: Adapter, fill: unknown) => Array<{ slot: string; reason: string }>;
};
const { CULT_ADAPTERS } = await import(pathToFileURL(join(PACKAGE_DIR, 'generated', 'index.ts')).href) as { CULT_ADAPTERS: Record<string, () => Promise<Adapter>> };

test('layoutFill: same lengths as the worst case, broken into words, and still a valid fill', async () => {
  for (const load of Object.values(CULT_ADAPTERS)) {
    const adapter = await load();
    const worst = worstCaseFill(adapter as never);
    const layout = layoutFill(adapter);
    assert.deepEqual(shared.validateAdapterFill(adapter, layout), [], adapter.id);
    for (const slot of adapter.text) {
      const value = layout.text[slot.name]!;
      assert.equal(value.length, worst.text[slot.name]!.length, `${adapter.id} ${slot.name}`);
      if (!slot.atom && slot.max > 10) assert.ok(value.includes(' '), `${adapter.id} ${slot.name} wraps`);
    }
    if (adapter.items) assert.equal(layout.items?.[adapter.items.name]?.length, adapter.items.count, adapter.id);
  }
});

test('frozen package: no synchronized agency compiler copy carries or imports a Cult adapter', () => {
  const result = frozenPackageViolations();
  assert.deepEqual(result.violations, []);
  assert.ok(result.syncedDirs >= 3, `checked ${result.syncedDirs} directories`);
  assert.ok(result.generatedBytes > 0);
});

const publicIds = await import(pathToFileURL(join(REPO_ROOT, 'packages/agency-fast-lane/src/cult-public-ids.ts')).href) as {
  publicSectionEntryId: (id: string) => string;
  publicAdapterText: (adapterId: string, text: string) => string;
  applyPublicNames: (entry: { tokens?: Record<string, string>; prose?: Record<string, string> } | undefined, named: string, kind?: 'markup' | 'css') => string;
};
const namesModule = await import(pathToFileURL(join(REPO_ROOT, 'packages/agency-fast-lane/src/cult-adapter-names.ts')).href) as {
  publicAdapterNamesForId: (adapterId: string, text: string, publicId: string) => string;
};

test('published adapters: the public build commits no adapters and renames nothing', async () => {
  assert.deepEqual(Object.keys(CULT_ADAPTERS), []);
  assert.equal(publicIds.publicSectionEntryId('cult:anything'), 'cult:anything');
  assert.equal(publicIds.publicSectionEntryId('hyperui:x'), 'hyperui:x');
  assert.equal(publicIds.publicAdapterText('cult:anything', '<div class="cult-anything"></div>'), '<div class="cult-anything"></div>');
});

test('published adapters: an insertable block carries no internal name once made public', () => {
  // Synthetic adapter: internal name `demo-vite`, public slug `demo-series-vt`.
  const markup = '<div class="cult-demo-vite"><svg><use href="#sym-demo-vite"></use></svg><a href="https://demo-vite.example.org/">x</a></div>';
  const css = '.cult-demo-vite .a{color:var(--role-accent)}';
  const publishedMarkup = namesModule.publicAdapterNamesForId('cult:demo-vite', markup, 'cult:demo-series-vt');
  assert.ok(!publishedMarkup.replace('https://demo-vite.example.org/', '').includes('demo-vite'), publishedMarkup);
  assert.ok(publishedMarkup.includes('cult-demo-series-vt'));
  assert.ok(namesModule.publicAdapterNamesForId('cult:demo-vite', css, 'cult:demo-series-vt').includes('.cult-demo-series-vt .a'));
  assert.ok(publishedMarkup.includes('https://demo-vite.example.org/'), 'external hrefs stay unchanged');
  assert.equal(namesModule.publicAdapterNamesForId('cult:demo-vite', markup, 'cult:demo-vite'), markup, 'an unrenamed block is untouched');
});

test('published adapters: element ids and their references are renamed together', () => {
  const entry = {
    // Keys are the tokens as stage 1 leaves them (the slug already replaced the internal name).
    tokens: { 'demo-series-vt-name': 'name-series-vt', 'demo-series-vt-work-email': 'work-email-series-vt' },
    prose: { 'Visit us on DemoVite': 'Visit us' },
  };
  const named = namesModule.publicAdapterNamesForId('cult:demo-vite',
    '<div class="cult-demo-vite"><label for="demo-vite-name">Name</label><input id="demo-vite-name" aria-label="Visit us on DemoVite">'
    + '<label for="demo-vite-work-email">Work email</label><input id="demo-vite-work-email"></div>', 'cult:demo-series-vt');
  const published = publicIds.applyPublicNames(entry, named);
  const ids = [...published.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  const fors = [...published.matchAll(/\sfor="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(fors.length > 0 && fors.every((target) => ids.includes(target)), 'every label still points at its field');
  assert.ok(ids.includes('name-series-vt') && ids.includes('work-email-series-vt'));
  assert.ok(published.includes('aria-label="Visit us"'));
  // CSS renames the same tokens everywhere, including custom properties.
  assert.equal(publicIds.applyPublicNames(entry, '#demo-series-vt-name{} var(--demo-series-vt-name)', 'css'), '#name-series-vt{} var(--name-series-vt)');
  assert.equal(publicIds.applyPublicNames(undefined, 'same'), 'same');
});
