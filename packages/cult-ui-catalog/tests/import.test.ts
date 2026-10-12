import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCatalog } from '../src/build.ts';
import { canonicalJson } from '../src/canonical.ts';
import { readKit } from '../src/kit.ts';
import { catalogIssues } from '../src/validate.ts';
import { writeFixtureKit } from './helpers/fixture-kit.ts';

function rowsByName(dir: string) {
  const catalog = buildCatalog(readKit(dir), {});
  return { catalog, rows: new Map(catalog.rows.map((r) => [r.name, r])) };
}

test('every index item becomes one valid row; unfetched items are pending-fetch', () => {
  const { catalog, rows } = rowsByName(writeFixtureKit());
  assert.deepEqual(catalogIssues(catalog), []);
  assert.equal(catalog.rows.length, 7);
  assert.equal(catalog.snapshot.fetchedItems, 4);
  assert.equal(catalog.snapshot.pendingItems, 3);
  const pending = rows.get('button-epsilon')!;
  assert.equal(pending.conversion.status, 'pending-fetch');
  assert.equal(pending.source.files[0]!.sha256, null);
  assert.equal(pending.requirements, null);
});

test('classification follows the ruling rules', () => {
  const { rows } = rowsByName(writeFixtureKit());
  const hero = rows.get('hero-alpha')!;
  assert.equal(hero.id, 'cult:hero-alpha');
  assert.equal(hero.assetKind, 'section');
  assert.equal(hero.taxonomy.sectionKind, 'hero');
  assert.deepEqual(hero.taxonomy.style, { density: 'airy' });
  assert.deepEqual(hero.spineAffinities, ['PA']);
  assert.deepEqual(hero.runtimeFeatures, ['motion']);
  assert.deepEqual(hero.requirements, { assetHosts: ['img.example.org'], images: true, interactions: ['click'] });
  assert.equal(hero.conversion.status, 'unconverted');
  assert.deepEqual(hero.rights, { license: 'licensed', decision: 'bundle', evidence: 'docs/legal/cult-ui-pro-rights.md' });

  const pricing = rows.get('pricing-beta')!;
  assert.equal(pricing.taxonomy.sectionKind, 'plan-comparison');
  assert.deepEqual(pricing.taxonomy.components, ['toggle-switch']);
  assert.deepEqual(pricing.spineAffinities, ['CO']);

  const cta = rows.get('cta-gamma')!;
  assert.equal(cta.taxonomy.sectionKind, 'cta-band');
  assert.equal(cta.conversion.status, 'adapter-needed');
  assert.match(cta.conversion.reason ?? '', /canvas/);
  assert.deepEqual(cta.spineAffinities, [], 'four intents do not discriminate');

  const chat = rows.get('chat-delta')!;
  assert.equal(chat.assetKind, 'app');
  assert.equal(chat.conversion.status, 'app-only');
  assert.deepEqual(chat.runtimeFeatures, ['ai-sdk', 'api-routes', 'env-secrets', 'server-actions']);
  assert.deepEqual(chat.spineAffinities, [], 'app rows are not routed by spine');

  assert.equal(rows.get('button-epsilon')!.assetKind, 'primitive');
  assert.equal(rows.get('button-epsilon-demo')!.demoOf, 'cult:button-epsilon');
  const page = rows.get('page-zeta')!;
  assert.equal(page.assetKind, 'page');
  assert.equal(page.taxonomy.sectionKind, 'page-composition');
});

test('output is deterministic and carries hashes, never source content', () => {
  const dir = writeFixtureKit();
  const a = canonicalJson(buildCatalog(readKit(dir), {}));
  const b = canonicalJson(buildCatalog(readKit(dir), {}));
  assert.equal(a, b);
  assert.ok(!a.includes('export default function'), 'catalog must not contain source text');
  const content = readFileSync(join(dir, 'src', 'hero-alpha', 'registry/sections/hero-alpha/page.tsx'));
  const file = JSON.parse(a).rows.find((r: { name: string }) => r.name === 'hero-alpha').source.files[0];
  assert.equal(file.sha256, createHash('sha256').update(content).digest('hex'));
  assert.equal(file.bytes, content.length);
});

test('snapshot digest is sha256 over sorted "<name> <sha256>" lines', () => {
  const dir = writeFixtureKit();
  const lines = ['chat-delta', 'cta-gamma', 'hero-alpha', 'pricing-beta']
    .map((n) => `${n} ${createHash('sha256').update(readFileSync(join(dir, 'registry', `${n}.json`))).digest('hex')}\n`)
    .join('');
  const catalog = buildCatalog(readKit(dir), {});
  assert.equal(catalog.snapshot.digest, createHash('sha256').update(lines).digest('hex'));
  assert.equal(catalog.snapshot.id, `cult-ui-pro@${catalog.snapshot.digest.slice(0, 16)}`);
});

test('a truncated item file is pending-fetch with a warning, not a crash', () => {
  const kit = readKit(writeFixtureKit({ broken: true }));
  assert.equal(kit.pending.get('broken-eta'), 'registry item file is incomplete or not JSON');
  assert.equal(kit.issues.length, 0);
  assert.ok(kit.warnings.some((w) => w.includes('broken-eta')));
});
