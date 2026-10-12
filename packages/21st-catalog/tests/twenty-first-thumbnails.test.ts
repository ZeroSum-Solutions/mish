// generated/21st-thumbnails.json (scripts/twenty-first-thumbnails.ts, G12 Addendum 4): the
// preview image 21st.dev itself publishes for each `rights: "mit"` hand-picked library row,
// fetched once from its own CDN (cdn.21st.dev) and re-encoded — never the item's own source.
// Committing (and same-origin serving) that image still redistributes the upstream screenshot, so
// a `reference-only` row never gets one — `twenty1stMayShipLocalImage` (@mish/contracts) is
// the one shared rule this file and e2e/scripts/catalog-thumbnails.ts both gate on. Shape,
// provenance and byte-budget invariants against the committed manifest and images; the fetch path
// itself needs the kit and the network, so it is exercised by `pnpm run 21st-thumbnails`, not here.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { twenty1stMayShipLocalImage } from '@mish/contracts';
import twentyFirstJson from '../generated/21st-items.json' with { type: 'json' };
import thumbnailsJson from '../generated/21st-thumbnails.json' with { type: 'json' };

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PKG_DIR, 'scripts', 'twenty-first-thumbnails.ts');
const IMAGES_DIR = join(PKG_DIR, 'generated', '21st-thumbnails');

interface Row { id: string; rights: 'mit' | 'reference-only' }
const catalog = twentyFirstJson as unknown as { rows: Row[] };
const manifest = thumbnailsJson as unknown as {
  schema: string;
  byteLimit: number;
  items: Record<string, { file: string; bytes: number; sourceUrl: string; kitFile: string; fetchedAt: string }>;
};

function runCheck(): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT, '--check'], {
      cwd: PKG_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

test('the committed manifest has one image entry per mit row, and none for a reference-only row', () => {
  const eligibleIds = new Set(catalog.rows.filter((r) => twenty1stMayShipLocalImage(r.rights)).map((r) => r.id));
  const ineligibleIds = new Set(catalog.rows.filter((r) => !twenty1stMayShipLocalImage(r.rights)).map((r) => r.id));
  const entryIds = new Set(Object.keys(manifest.items));
  assert.deepEqual([...entryIds].sort(), [...eligibleIds].sort());
  for (const id of ineligibleIds) assert.ok(!entryIds.has(id), `${id}: reference-only row must not carry a local 21st-thumbnails entry`);
});

test('every entry\'s sourceUrl is 21st.dev\'s own published CDN, never a Mishh-served or third-party URL', () => {
  for (const [id, entry] of Object.entries(manifest.items)) {
    assert.match(entry.sourceUrl, /^https:\/\/cdn\.21st\.dev\//, `${id}: sourceUrl`);
    assert.match(entry.kitFile, /^registry\//, `${id}: kitFile must point at a kit registry file`);
  }
});

// The fetched 21st.dev screenshots are not redistributed in the public repository: the manifest
// keeps each entry's provenance, and an entry whose image is absent is "not shipped" (the daemon
// answers 404 and the card shows its no-preview placeholder). An image that IS present must match.
test('every image present on disk matches its recorded byte size and stays under the shared thumbnail budget', () => {
  for (const [id, entry] of Object.entries(manifest.items)) {
    assert.ok(entry.bytes <= manifest.byteLimit, `${id}: ${entry.bytes} B exceeds the ${manifest.byteLimit} B limit`);
    const file = join(IMAGES_DIR, entry.file);
    if (existsSync(file)) assert.equal(statSync(file).size, entry.bytes, `${id}: recorded size drifted from the file on disk`);
  }
});

test('--check passes offline against the committed manifest and counts the images it ships', () => {
  const { status, output } = runCheck();
  assert.equal(status, 0, output);
  const shipped = Object.values(manifest.items).filter((entry) => existsSync(join(IMAGES_DIR, entry.file))).length;
  assert.match(output, new RegExp(`21st-thumbnails\\.json: ${Object.keys(manifest.items).length} entries, ${shipped} images shipped`));
});
