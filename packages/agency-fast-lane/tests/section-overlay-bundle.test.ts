/** The installed daemon has only relocated esbuild chunks, not the workspace source tree. */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const workspace = path.resolve(import.meta.dirname, '../../..');
// Resolve the workspace daemon dependency through its JS API. This is not the tools-pack lane configuration.
const daemonRequire = createRequire(path.join(workspace, 'apps/daemon/package.json'));
const { build } = daemonRequire('esbuild') as { build: (options: Record<string, unknown>) => Promise<{ metafile: { inputs: Record<string, unknown> } }> };
let temporary: string;
let bundleUrl: string;
let emittedUrl: string;

before(async () => {
  temporary = await mkdtemp(path.join(tmpdir(), 'agency-overlay-relocated-'));
  const mirrored = path.join(temporary, 'workspace');
  const emitted = path.join(mirrored, 'packages/agency-fast-lane/dist');
  await execFileAsync(process.execPath, [
    path.join(workspace, 'packages/agency-fast-lane/node_modules/typescript/lib/tsc.js'),
    '-p', path.join(workspace, 'packages/agency-fast-lane/tsconfig.build.json'), '--outDir', emitted,
  ], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  // Build-time source/dependency access matches the workspace. None is copied into the installed tree.
  await symlink(path.join(workspace, 'plugins'), path.join(mirrored, 'plugins'), 'dir');
  for (const name of ['contracts', 'cult-ui-catalog']) await symlink(path.join(workspace, 'packages', name), path.join(mirrored, 'packages', name), 'dir');
  await symlink(path.join(workspace, 'packages/agency-fast-lane/node_modules'), path.join(emitted, '..', 'node_modules'), 'dir');
  emittedUrl = pathToFileURL(path.join(emitted, 'section-overlay.js')).href;
  const built = path.join(temporary, 'build');
  const entry = path.join(temporary, 'section-overlay.ts');
  await writeFile(entry, [
    `export * from ${JSON.stringify(path.join(emitted, 'section-overlay.js'))};`,
    `export { publicAdapterText, publicSectionEntryId, internalSectionEntryId } from ${JSON.stringify(path.join(emitted, 'cult-public-ids.js'))};`,
  ].join('\n'));
  const bundle = await build({ metafile: true, entryPoints: [entry], bundle: true, platform: 'node', format: 'esm',
    splitting: true, target: 'node24', outdir: built, outExtension: { '.js': '.mjs' },
    chunkNames: 'chunks/[name]-[hash]',
  });
  // Query and plain imports can be separate module instances. Record the real bundler inputs;
  // rendering below must work across that boundary without class identity or shared mutable state.
  const sharedInputs = Object.keys(bundle.metafile.inputs).filter(input => /(?:section-adapter|direction-tokens|directions|html-injection-points)\.ts(?:\?|$)/.test(input)).sort();
  const pluginModule = 'plugins/_official/shared/agency-compiler/scripts/section-adapter.ts';
  const hasPluginModule = (suffix: string) => sharedInputs.some(input => {
    const normalized = input.replaceAll('\\', '/');
    return normalized === pluginModule + suffix || normalized.endsWith('/' + pluginModule + suffix);
  });
  assert.ok(hasPluginModule('?agency-overlay'), 'the query instance is the shared plugin module');
  assert.ok(hasPluginModule(''), 'the plain instance is the shared plugin module, not the Cult shim');
  console.log('overlay bundle module inputs: ' + JSON.stringify(sharedInputs));
  const relocated = path.join(temporary, 'installed/app/prebundled/daemon');
  await cp(built, relocated, { recursive: true });
  await rm(built, { recursive: true });
  bundleUrl = pathToFileURL(path.join(relocated, 'section-overlay.mjs')).href;
});
after(async () => { if (temporary) await rm(temporary, { recursive: true, force: true }); });

async function runRelocated(assertions: string): Promise<void> {
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '--eval', `
    import assert from 'node:assert/strict';
    globalThis.fetch = () => { throw new Error('provider/network calls forbidden in catalogue regression'); };
    const overlay = await import(${JSON.stringify(bundleUrl)});
    ${assertions}
    console.log('relocated catalogue assertions passed');
  `], {
    cwd: temporary,
    env: { PATH: path.dirname(process.execPath), HOME: temporary, TMPDIR: temporary },
    timeout: 20_000, maxBuffer: 1024 * 1024,
  });
  assert.equal(stdout.trim(), 'relocated catalogue assertions passed');
}

test('relocated split bundle resolves every composable Cult and HyperUI adapter without source files', async () => {
  // Read the independent authoring inventory outside the bundle so registry truncation cannot pass.
  const catalog = JSON.parse(await readFile(path.join(workspace, 'packages/cult-ui-catalog/catalog.json'), 'utf8')) as {
    rows: Array<{ id: string; conversion: { status: string } }>;
  };
  const expectedCultIds = catalog.rows.filter(row => row.conversion.status === 'insertable').map(row => row.id).sort();
  assert.ok(expectedCultIds.length > 0, 'the authoring inventory contains insertable Cult rows');
  assert.equal(new Set(expectedCultIds).size, expectedCultIds.length, 'the inventory ids are unique');
  await runRelocated(`
    const ids = await overlay.listSectionAdapterIds();
    const expectedCultIds = ${JSON.stringify(expectedCultIds)};
    const expectedHyperUIIds = ['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1'];
    assert.deepEqual(ids.filter(id => id.startsWith('cult:')).sort(), expectedCultIds, 'every independently inventoried Cult row survives bundling');
    assert.deepEqual(ids.filter(id => !id.startsWith('cult:')).sort(), expectedHyperUIIds.slice().sort(), 'exactly the three supported HyperUI adapters survive bundling');
    assert.equal(ids.length, expectedCultIds.length + 3, 'the bundled registry is complete without extra or duplicate rows');
    for (const id of ['hyperui:marketing/ctas/1', 'hyperui:marketing/feature-grids/1', 'hyperui:marketing/sections/1', 'cult:marketing-hero-large-image']) {
      assert.ok(ids.includes(id), id);
      assert.equal((await overlay.resolveSectionAdapter(id)).id, id);
    }
    const composable = await overlay.listComposableAdapterIds();
    assert.ok(composable.includes('cult:marketing-hero-large-image'));
    assert.ok(ids.includes('cult:marketing-footer-apple'), 'the refused row still exists');
    assert.equal(overlay.composeRefusalFor(await overlay.resolveSectionAdapter('cult:marketing-footer-apple')), 'fixed-link-name');
    assert.ok(!composable.includes('cult:marketing-footer-apple'), 'vendor-link refusal remains enforced');
    await assert.rejects(() => overlay.resolveSectionAdapter('cult:not-a-reviewed-adapter'), overlay.SectionSelectionRefusedError);
    for (const id of composable) assert.equal(overlay.composeRefusalFor(await overlay.resolveSectionAdapter(id)), undefined, id);
  `);
});

// Catalogue witnesses below intentionally pin current vendor refusals, public slug and text rewriting.
// Catalogue changes must retain equivalent positive and refusal witnesses.
test('relocated split bundle loads all authored design directions and renders scoped role tokens', async () => {
  await runRelocated(`
    const ids = (await overlay.listDesignDirections()).map(d => d.id).sort();
    assert.deepEqual(ids, ['brutalist-experimental', 'editorial-monocle', 'human-approachable', 'modern-minimal', 'tech-utility']);
    const direction = await overlay.resolveDesignDirection('modern-minimal');
    const adapter = await overlay.resolveSectionAdapter('hyperui:marketing/ctas/1');
    const fill = { text: Object.fromEntries(adapter.text.map(slot => [slot.name, 'Own <x>'])) };
    const kit = await overlay.overlayRenderKit();
    const html = kit.renderSectionAdapter(adapter, fill);
    const css = kit.directionScopeCss('[data-owned-section]', direction) + kit.directionBaseCss('[data-owned-section]');
    assert.match(css, /data-owned-section/);
    assert.match(css, /--role-background/);
    assert.ok(!html.includes('Own <x>'), 'adapter text stays escaped');
    assert.ok(html.includes('Own &lt;x&gt;'), 'escaped text stays present');
    const cult = await overlay.resolveSectionAdapter('cult:marketing-hero-large-image');
    const cultFill = { text: Object.fromEntries(cult.text.map(slot => [slot.name, 'Own <x>'])) };
    const renderedCult = kit.renderSectionAdapter(cult, cultFill);
    assert.equal(renderedCult, cult.render(cultFill), 'Cult adapter from the registry renders through the overlay renderer');
    assert.throws(() => kit.renderSectionAdapter(cult, { text: {} }), error =>
      error.name === 'AdapterFillRejectedError' && error.errors.some(issue => issue.slot === cult.text[0].name),
      'invalid Cult fill is refused across module instances without instanceof');
    const published = overlay.publicAdapterText(cult.id, renderedCult);
    assert.ok(published.includes('Own &lt;x&gt;'), 'published text stays present and escaped');
    assert.ok(!published.includes('Own <x>'));
    const publicId = overlay.publicSectionEntryId(cult.id);
    assert.notEqual(publicId, cult.id, 'published Cult identity uses the reviewed slug map');
    assert.equal(overlay.internalSectionEntryId(publicId), cult.id);
    assert.equal((await overlay.resolveSectionAdapter(publicId)).id, cult.id);
    const branded = '<label for="footer-vite-email" aria-label="Visit us on Discord">Owned</label><input id="footer-vite-email">';
    const scrubbed = overlay.publicAdapterText('cult:marketing-footer-vite', branded);
    assert.ok(!scrubbed.includes('footer-vite-email'));
    assert.ok(!scrubbed.includes('Discord'));
    assert.ok(scrubbed.includes('Visit us on a third-party service'), 'scrubbed prose remains present');
    const target = /for="([^"]+)"/.exec(scrubbed)[1];
    assert.ok(scrubbed.includes('id="' + target + '"'), 'rewritten references remain paired');
  `);
});

test('relocated split bundle retains the shared HTML tokenizer for real section anchors', async () => {
  await runRelocated(`
    const html = '<script>const fake = "<main><section id=owned></section></main>";</script><div data-fake="<main>"></div><main><div data-fake-close="</main>"></div><section id="owned"><p>Owned</p></section><footer></footer></main>';
    assert.ok(html.indexOf('data-fake-close=') < html.indexOf('<section id="owned">'), 'fake close precedes the owned section');
    const offset = await overlay.resolveAnchorOffset(html, ['owned'], { mode: 'append', afterSectionId: 'owned' });
    assert.equal(offset, html.indexOf('<footer>'));
  `);
});

test('the adapter gate and public-name generator bootstrap with public names absent', async () => {
  const cloned = path.join(temporary, 'generator-workspace/packages');
  const catalog = path.join(cloned, 'cult-ui-catalog');
  const fastLane = path.join(cloned, 'agency-fast-lane');
  await mkdir(cloned, { recursive: true });
  await symlink(path.join(workspace, 'plugins'), path.join(cloned, '..', 'plugins'), 'dir');
  await symlink(path.join(workspace, 'scripts'), path.join(cloned, '..', 'scripts'), 'dir');
  for (const name of ['scripts', 'src', 'schema', 'generated']) await cp(path.join(workspace, 'packages/cult-ui-catalog', name), path.join(catalog, name), { recursive: true });
  for (const name of ['package.json', 'catalog.json']) await cp(path.join(workspace, 'packages/cult-ui-catalog', name), path.join(catalog, name));
  await cp(path.join(workspace, 'packages/agency-fast-lane/src'), path.join(fastLane, 'src'), { recursive: true });
  await cp(path.join(workspace, 'packages/agency-fast-lane/package.json'), path.join(fastLane, 'package.json'));
  await symlink(path.join(workspace, 'packages/cult-ui-catalog/node_modules'), path.join(catalog, 'node_modules'), 'dir');
  await mkdir(path.join(fastLane, 'node_modules/@open-design'), { recursive: true });
  await symlink(catalog, path.join(fastLane, 'node_modules/@open-design/cult-ui-catalog'), 'dir');
  await rm(path.join(catalog, 'generated/public-names.json'));
  // The first adapters-script step must load and validate the real generated registry before
  // public-names.ts recreates the missing output. No private source kit is required for this gate.
  const adapterScript = path.join(catalog, 'scripts/adapters.ts');
  const adapterCheck = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    globalThis.fetch = () => { throw new Error('provider/network calls forbidden in adapter bootstrap regression'); };
    process.argv.push('--check');
    await import(${JSON.stringify(pathToFileURL(adapterScript).href)});
  `], { cwd: catalog, env: { PATH: path.dirname(process.execPath), HOME: temporary, TMPDIR: temporary }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.match(adapterCheck.stdout, /Cult adapters valid/);
  await assert.rejects(() => readFile(path.join(catalog, 'generated/public-names.json')), { code: 'ENOENT' });
  const script = path.join(catalog, 'scripts/public-names.ts');
  const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
    globalThis.fetch = () => { throw new Error('provider/network calls forbidden in generator regression'); };
    process.argv[1] = ${JSON.stringify(script)};
    await import(${JSON.stringify(pathToFileURL(script).href)});
  `], { cwd: catalog, env: { PATH: path.dirname(process.execPath), HOME: temporary, TMPDIR: temporary }, timeout: 30_000, maxBuffer: 1024 * 1024 });
  assert.match(stdout, /generated\/public-names\.json:/);
  assert.equal(await readFile(path.join(catalog, 'generated/public-names.json'), 'utf8'), await readFile(path.join(workspace, 'packages/cult-ui-catalog/generated/public-names.json'), 'utf8'));
});

test('Node 24 loads the source and emitted cross-package specifiers directly', async () => {
  for (const url of [pathToFileURL(path.join(workspace, 'packages/agency-fast-lane/src/section-overlay.ts')).href, emittedUrl]) {
    const { stdout } = await execFileAsync(process.execPath, ['--experimental-strip-types', '--input-type=module', '--eval', `
      import assert from 'node:assert/strict';
      globalThis.fetch = () => { throw new Error('provider/network calls forbidden in direct import regression'); };
      const overlay = await import(${JSON.stringify(url)});
      assert.equal((await overlay.resolveSectionAdapter('cult:marketing-hero-large-image')).id, 'cult:marketing-hero-large-image');
      assert.equal((await overlay.listDesignDirections()).length, 5);
      assert.equal((await overlay.resolveSectionAdapter('hyperui:marketing/ctas/1')).id, 'hyperui:marketing/ctas/1');
      console.log('direct imports passed');
    `], { cwd: temporary, env: { PATH: path.dirname(process.execPath), HOME: temporary, TMPDIR: temporary }, timeout: 20_000, maxBuffer: 1024 * 1024 });
    assert.equal(stdout.trim(), 'direct imports passed');
  }
});
