/**
 * The package's compiled output (`npm run build`) is what the daemon imports: the CLI and these
 * tests run from source with `--experimental-strip-types`, so nothing else here would notice a
 * `dist` that fails to emit, misses a module, or loses the JSON data files.
 *
 * Runs the real build (tsc + `scripts/copy-dist-data.ts`) into the package's own `dist`, then
 * imports the three modules the daemon's design-index routes need and calls
 * `loadDesignTaxonomy()` with no argument — the path built from `import.meta.dirname`, which
 * resolves inside `dist` only when the data copy ran.
 *
 * `dist/data.js` gets its own parity check. It is what the packaged daemon imports instead of the
 * file loaders (`import.meta.dirname` points inside the esbuild prebundle there, where the JSON
 * directories do not exist), so it has to carry byte-for-byte the same three objects the checked-in
 * JSON does. A generator that silently emitted stale or partial data would otherwise only show up
 * as a wrong routing answer in a packaged build.
 */

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const packageRoot = path.resolve(import.meta.dirname, '..');
const tsc = path.join(packageRoot, 'node_modules/typescript/lib/tsc.js');
const distUrl = (file: string) => `file://${path.join(packageRoot, 'dist', file)}`;

test('the built dist is importable and carries the taxonomy and atlas data', async () => {
  await execFileAsync(process.execPath, [tsc, '-p', 'tsconfig.build.json'], { cwd: packageRoot });
  await execFileAsync(process.execPath, ['--experimental-strip-types', 'scripts/copy-dist-data.ts'], { cwd: packageRoot });

  const route = await import(distUrl('route.js'));
  assert.equal(typeof route.createJevRouter, 'function');
  assert.equal(typeof route.resolveRoute, 'function');

  // The daemon's build job imports this one; it is the newest subpath in `exports`, so it is also
  // the one most likely to be missing from a `dist` whose export map and build fell out of step.
  const build = await import(distUrl('build.js'));
  assert.equal(typeof build.buildSite, 'function');
  assert.equal(typeof build.routeBuild, 'function');

  // `./family` is exported for the daemon's build job: its `prepare` callback loads the routed
  // family's package the same way the CLI does, and the CLI's own copy is not reachable from
  // outside this package.
  const family = await import(distUrl('family.js'));
  assert.equal(typeof family.loadFamilyPackage, 'function');
  assert.equal(typeof family.defaultPackageDir, 'function');

  const designIndex = await import(distUrl('design-index.js'));
  for (const name of ['loadDesignIndex', 'saveDesignIndex', 'addProfile', 'findProfiles']) {
    assert.equal(typeof designIndex[name], 'function', `dist/design-index.js is missing ${name}`);
  }

  const taxonomy = await import(distUrl('taxonomy.js'));
  const loaded = await taxonomy.loadDesignTaxonomy();
  assert.equal(loaded.version, '1.0');

  const atlas = await import(distUrl('atlas.js'));
  const { atlas: shapeAtlas, registry } = await atlas.loadAtlasData();
  assert.ok(shapeAtlas.spines.length > 0);
  assert.ok(registry.families.length > 0);
});

test('dist/data.js carries exactly the checked-in JSON, so the packaged daemon reads the same atlas', async () => {
  // Depends on the build the test above runs; `node --test` executes a file's tests in order.
  const data = await import(distUrl('data.js'));

  const readJson = async (file: string) =>
    JSON.parse(await readFile(path.join(packageRoot, 'src', file), 'utf8')) as unknown;

  assert.deepEqual(data.shapeAtlas, await readJson('atlas/shape-atlas.json'));
  assert.deepEqual(data.familyRegistry, await readJson('atlas/family-registry.json'));
  assert.deepEqual(data.designTaxonomy, await readJson('taxonomy/design-taxonomy.json'));

  // And the same objects the file loaders produce, since the generator runs them to validate.
  const atlas = await import(distUrl('atlas.js'));
  const taxonomy = await import(distUrl('taxonomy.js'));
  const loaded = await atlas.loadAtlasData();
  assert.deepEqual(data.shapeAtlas, loaded.atlas);
  assert.deepEqual(data.familyRegistry, loaded.registry);
  assert.deepEqual(data.designTaxonomy, await taxonomy.loadDesignTaxonomy());

  // The validators must accept the generated objects: the daemon skips them at boot precisely
  // because the build already ran them.
  atlas.validateShapeAtlas(data.shapeAtlas);
  atlas.validateFamilyRegistry(data.familyRegistry, data.shapeAtlas);
  taxonomy.validateDesignTaxonomy(data.designTaxonomy);
});
