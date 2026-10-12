/**
 * The pure parts of the Cult render gate (scripts/render-check.ts). The browser pass itself runs
 * as `pnpm --filter @open-design/cult-ui-catalog render-check` (CI: the agency tests job, which
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
};

test('published adapters: no insertable Cult block carries its internal name once made public', async () => {
  let renamed = 0;
  for (const load of Object.values(CULT_ADAPTERS)) {
    const adapter = await load();
    const publicId = publicIds.publicSectionEntryId(adapter.id);
    if (publicId === adapter.id) continue;
    renamed += 1;
    const name = adapter.id.slice('cult:'.length);
    // Markup (worst-case and layout fills) and CSS, exactly as the fast lane publishes them.
    for (const [what, text] of [
      ['markup', adapter.render(worstCaseFill(adapter as never))],
      ['layout markup', adapter.render(layoutFill(adapter))],
      ['css', adapter.css],
    ] as const) {
      const published = publicIds.publicAdapterText(adapter.id, text);
      const at = published.indexOf(name);
      assert.equal(at, -1, `${adapter.id} ${what} still names ${name}: …${published.slice(Math.max(0, at - 40), at + name.length + 20)}…`);
    }
  }
  assert.ok(renamed > 40, `${renamed} adapters have a public id that differs from their internal one`);
});

test('published adapters: element ids and their references are renamed together', async () => {
  // marketing-contact-vite, the only row whose ids carried its own name, is not insertable since yield-5
  // (x86 ink overlap); its converted label/field markup keeps the shape under test.
  const published = publicIds.publicAdapterText('cult:marketing-contact-vite',
    '<div class="cult-marketing-contact-vite"><label for="marketing-contact-vite-name">Name</label><input id="marketing-contact-vite-name">'
    + '<label for="marketing-contact-vite-work-email">Work email</label><input id="marketing-contact-vite-work-email"></div>');
  const ids = [...published.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]!);
  const fors = [...published.matchAll(/\sfor="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(fors.length > 0 && fors.every((target) => ids.includes(target)), 'every label still points at its field');
  assert.ok(ids.some((id) => id.startsWith('contact-series-vt-')));
});
