/**
 * Consumer: the packed tarball installs into an unrelated project (as a server in another repository would take it)
 * and compiles there from its bundles alone, to the golden bytes.
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { PACKAGE_ROOT } from './helpers.ts';

const goldens = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'tests/golden/pages.json'), 'utf8')) as Record<string, { digest: string }>;
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

test('consumer: the packed package installs offline and compiles in another project', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mish-publisher-consumer-'));
  try {
    const packDir = path.join(dir, 'pack');
    const project = path.join(dir, 'project');
    mkdirSync(packDir);
    mkdirSync(project);
    execFileSync(npm, ['pack', '--silent', '--pack-destination', packDir], { cwd: PACKAGE_ROOT, stdio: 'pipe' });
    const [tarball] = readdirSync(packDir);
    assert.ok(tarball?.endsWith('.tgz'));
    writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'consumer', private: true, type: 'module' }));
    execFileSync(npm, ['install', '--offline', '--no-audit', '--no-fund', '--silent', path.join(packDir, tarball!)], { cwd: project, stdio: 'pipe' });
    const installed = JSON.parse(readFileSync(path.join(project, 'node_modules/@mish/publisher/package.json'), 'utf8')) as { files: string[] };
    assert.deepEqual(installed.files, ['dist', 'README.md']);
    const shipped = path.join(project, 'node_modules/@mish/publisher/dist');
    assert.match(readFileSync(path.join(shipped, 'LICENSE'), 'utf8'), /Apache License/);
    assert.match(readFileSync(path.join(shipped, 'NOTICE'), 'utf8'), /HyperUI[^]*Copyright \(c\) Mark Mead[^]*Permission is hereby granted/);
    writeFileSync(path.join(project, 'consume.mjs'), `
import { compile } from '@mish/publisher';
import { BUNDLED_FAMILIES, loadBundledFamily } from '@mish/publisher/families';
import practice from '@mish/publisher/families/practice';
const result = await compile({ compiler: practice, spec: { recipe: practice.reference } });
const restaurant = await loadBundledFamily('restaurant');
const second = await compile({ compiler: restaurant, spec: { recipe: restaurant.reference } });
console.log(JSON.stringify({ families: BUNDLED_FAMILIES.length, practice: result.digest, restaurant: second.digest }));
`);
    const out = JSON.parse(execFileSync(process.execPath, ['consume.mjs'], { cwd: project, encoding: 'utf8' }).trim()) as Record<string, unknown>;
    assert.deepEqual(out, { families: 12, practice: goldens.practice!.digest, restaurant: goldens.restaurant!.digest });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
