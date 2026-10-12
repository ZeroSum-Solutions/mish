import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { buildCatalog } from '../src/build.ts';
import { catalogDrift } from '../src/drift.ts';
import { readKit } from '../src/kit.ts';
import { BLOCK_BEGIN, BLOCK_END, renderSnapshotBlock, spliceSnapshotBlock } from '../src/rights-doc.ts';
import { writeFixtureKit } from './helpers/fixture-kit.ts';

const HERO_FILE = 'registry/sections/hero-alpha/page.tsx';

type ItemJson = { files: Array<{ path: string; content: string }> };

function editItem(dir: string, name: string, edit: (item: ItemJson) => void): void {
  const path = join(dir, 'registry', `${name}.json`);
  const item = JSON.parse(readFileSync(path, 'utf8')) as ItemJson;
  edit(item);
  writeFileSync(path, JSON.stringify(item));
}

test('an unchanged kit shows no drift', () => {
  const dir = writeFixtureKit();
  assert.deepEqual(catalogDrift(buildCatalog(readKit(dir), {}), buildCatalog(readKit(dir), {})), []);
});

test('a changed file hash is reported as drift', () => {
  const dir = writeFixtureKit();
  const committed = buildCatalog(readKit(dir), {});
  editItem(dir, 'hero-alpha', (item) => { item.files[0]!.content += '// changed\n'; });
  rmSync(join(dir, 'src', 'hero-alpha'), { recursive: true });
  const drift = catalogDrift(committed, buildCatalog(readKit(dir), {}));
  assert.ok(drift.includes(`cult:hero-alpha: changed hash for ${HERO_FILE}`), drift.join('\n'));
  assert.ok(drift.some((d) => d.startsWith('snapshot.digest')));
});

test('a newly fetched item is drift until re-imported', () => {
  const dir = writeFixtureKit();
  const committed = buildCatalog(readKit(dir), {});
  const item = {
    name: 'button-epsilon',
    files: [{ path: 'registry/components/button-epsilon.tsx', type: 'registry:ui', target: 'x', content: 'export const B = 1;\n' }],
  };
  writeFileSync(join(dir, 'registry', 'button-epsilon.json'), JSON.stringify(item));
  const drift = catalogDrift(committed, buildCatalog(readKit(dir), {}));
  assert.ok(drift.includes('cult:button-epsilon: newly fetched (was pending-fetch in the committed snapshot)'), drift.join('\n'));
  assert.ok(!drift.some((d) => d.includes('button-epsilon') && d.includes('hash')), drift.join('\n'));
  assert.ok(drift.some((d) => d.startsWith('snapshot.fetchedItems')));
});

test('a materialized copy that disagrees with the registry item is a fatal kit issue', () => {
  const dir = writeFixtureKit();
  writeFileSync(join(dir, 'src', 'hero-alpha', HERO_FILE), 'tampered');
  assert.ok(readKit(dir).issues.some((i) => i.includes('changed hash')));
});

test('an item whose file list differs from the index is a fatal kit issue', () => {
  const dir = writeFixtureKit();
  editItem(dir, 'hero-alpha', (item) => { item.files = []; });
  assert.ok(readKit(dir).issues.some((i) => i.includes('file list differs')));
});

test('a path that climbs out of the kit is refused', () => {
  const dir = writeFixtureKit();
  const indexPath = join(dir, 'registry', 'index.json');
  writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace(HERO_FILE, '../../outside.txt'));
  assert.throws(() => readKit(dir), /unsafe path/);
});

test('the rights doc block is spliced between its markers', () => {
  const snapshot = buildCatalog(readKit(writeFixtureKit()), {}).snapshot;
  const doc = `# Doc\n\n${BLOCK_BEGIN}\nold\n${BLOCK_END}\n\nafter\n`;
  const next = spliceSnapshotBlock(doc, snapshot);
  assert.ok(next.includes(renderSnapshotBlock(snapshot)));
  assert.ok(next.endsWith('\n\nafter\n'));
  assert.ok(!next.includes('old'));
  assert.throws(() => spliceSnapshotBlock('# no markers', snapshot), /markers/);
});
