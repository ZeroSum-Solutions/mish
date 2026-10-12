// generated/21st-items.json (scripts/twenty-first.ts): the hand-picked 21st.dev library (PRD
// Addendum 3 / G13). Shape and rights invariants, plus the generator's --check behavior around a
// missing vs. a present-but-broken kit (the kit-comparison-against-the-real-kit mode is exercised
// by `pnpm run 21st -- --check` in CI, not here — the private kit is not committed).

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import twentyFirstJson from '../generated/21st-items.json' with { type: 'json' };

interface Row {
  id: string;
  slug: string;
  name: string;
  author: string;
  authorProfileUrl: string;
  itemUrl: string;
  rights: 'mit' | 'reference-only';
  licenseLabel: string | null;
  licenseUrl: string | null;
  licenseNotice: string | null;
  copyable: boolean;
}

const catalog = twentyFirstJson as unknown as { schema: string; source: { profile: string; itemCount: number }; rows: Row[] };

const PKG_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(PKG_DIR, 'scripts', 'twenty-first.ts');

function runCheck(kitDir: string | undefined): { status: number; output: string } {
  try {
    const output = execFileSync(process.execPath, ['--experimental-strip-types', SCRIPT, '--check'], {
      cwd: PKG_DIR,
      env: { ...process.env, TWENTYFIRST_KIT_DIR: kitDir ?? '' },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { status: 0, output };
  } catch (err) {
    const failed = err as { status?: number; stdout?: string; stderr?: string };
    return { status: failed.status ?? 1, output: `${failed.stdout ?? ''}${failed.stderr ?? ''}` };
  }
}

test('schema and row count', () => {
  assert.equal(catalog.schema, '21st-catalog/1');
  assert.equal(catalog.rows.length, 22);
  assert.equal(catalog.source.itemCount, 22);
  assert.equal(catalog.source.profile, 'https://21st.dev/@example');
});

test('every row has a unique 21st: id and a well-formed 21st.dev URL', () => {
  const seen = new Set<string>();
  for (const row of catalog.rows) {
    assert.ok(!seen.has(row.id), `duplicate id ${row.id}`);
    seen.add(row.id);
    assert.match(row.id, /^21st:[a-z0-9-]+$/);
    assert.equal(row.slug, row.id.slice('21st:'.length));
    assert.match(row.itemUrl, /^https:\/\/21st\.dev\//);
    assert.match(row.authorProfileUrl, /^https:\/\/21st\.dev\/@/);
  }
});

test('rights split: 2 mit, 20 reference-only, per Devin\'s licence call', () => {
  const mit = catalog.rows.filter((row) => row.rights === 'mit');
  const referenceOnly = catalog.rows.filter((row) => row.rights === 'reference-only');
  assert.equal(mit.length, 2);
  assert.equal(referenceOnly.length, 20);
  assert.deepEqual(mit.map((row) => row.name).sort(), ['Glassmorphism Listen App', 'Glassmorphism Portfolio']);
});

test('copyable mirrors rights exactly; a mit row carries the real upstream MIT notice, not the kit\'s research note', () => {
  for (const row of catalog.rows) {
    assert.equal(row.copyable, row.rights === 'mit', row.id);
    if (row.rights === 'mit') {
      assert.match(row.licenseLabel!, /^MIT © /, `${row.id} needs a "MIT © <holder>" label`);
      assert.match(row.licenseUrl!, /^https:\/\/github\.com\//, `${row.id} needs an upstream licence URL`);
      assert.match(row.licenseNotice!, /^MIT License\n/, `${row.id} needs the full upstream MIT text`);
      assert.match(row.licenseNotice!, /Copyright \(c\) \d{4} /, `${row.id} needs a copyright line`);
      assert.match(row.licenseNotice!, /Permission is hereby granted/, `${row.id} needs the MIT permission text`);
      // The kit's internal research note ("site_license", "via GitHub API", "not diffed") must
      // never leak into the notice a person copies.
      assert.ok(!/site_license|via GitHub API|not diffed/i.test(row.licenseNotice!), `${row.id} notice leaks kit research text`);
    } else {
      assert.equal(row.licenseLabel, null, `${row.id} (reference-only) must not carry a licence label`);
      assert.equal(row.licenseUrl, null, `${row.id} (reference-only) must not carry a licence URL`);
      assert.equal(row.licenseNotice, null, `${row.id} (reference-only) must not carry a licence notice`);
    }
  }
});

test('no row carries an install/copy action or an api_key value anywhere: round 2 withheld the install command entirely', () => {
  for (const row of catalog.rows) {
    assert.ok(!('externalInstallCommand' in row), `${row.id} must not carry an install command`);
    const text = JSON.stringify(row);
    assert.ok(!/api_key/i.test(text), `${row.id} must not mention api_key at all`);
    assert.ok(!/npx shadcn/i.test(text), `${row.id} must not carry a shadcn install line`);
  }
});

test('rows carry metadata only: no file content, no registry/source fields', () => {
  const text = JSON.stringify(catalog);
  assert.ok(!/"files"\s*:/.test(text));
  assert.ok(!/"content"\s*:/.test(text));
  assert.ok(!/registryDependencies/.test(text));
});

test('--check: a MISSING kit directory is OK (shape-only, matches CI)', () => {
  const result = runCheck('/no/such/kit/directory/at/all');
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /shape OK/);
});

test('--check: a kit directory that EXISTS but has no manifest.json FAILS (exit 1), never silently treated as "no kit"', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twenty-first-broken-kit-'));
  try {
    const result = runCheck(dir);
    assert.equal(result.status, 1);
    assert.match(result.output, /manifest\.json could not be read or parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--check: a present but unparseable manifest.json FAILS (exit 1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'twenty-first-bad-manifest-'));
  try {
    writeFileSync(join(dir, 'manifest.json'), '{ this is not json');
    const result = runCheck(dir);
    assert.equal(result.status, 1);
    assert.match(result.output, /manifest\.json could not be read or parsed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
