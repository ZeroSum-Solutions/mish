import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import type http from 'node:http';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { load } from 'cheerio';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { reconcileAgencyRecipe } from '../src/artifacts/agency-recipe.js';
import { startServer } from '../src/server.js';
import type { CreateProjectResponse, ProjectFileResponse, ProjectFileVersionsResponse, ReconcileAgencyRecipeResponse } from '@open-design/contracts';

const templatesRoot = fileURLToPath(new URL('../../../design-templates/', import.meta.url));
const roots: string[] = [];
const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function setup() {
  const projectRoot = await mkdtemp(path.join(os.tmpdir(), 'agency-recipe-')); roots.push(projectRoot);
  const renderer = await import(/* @vite-ignore */ pathToFileURL(path.join(templatesRoot, 'agency-site/scripts/render.ts')).href);
  const recipe = JSON.parse(await readFile(path.join(templatesRoot, 'agency-site/scripts/families/watson/reference.fixture.json'), 'utf8'));
  const ids = [...new Set<string>([...Object.values(recipe.brand.fonts) as string[], ...recipe.sections.flatMap((s: { assets: Record<string, string> }) => Object.values(s.assets))])];
  const fonts = new Set(Object.values(recipe.brand.fonts));
  const roster = { version: 1, assets: ids.map((id, i) => ({ id, file: `asset-${i}.${fonts.has(id) ? 'woff2' : 'jpg'}`, kind: fonts.has(id) ? 'font' : 'image' })) };
  const result = renderer.renderAgencySite(recipe, 'site.html', roster);
  await mkdir(path.join(projectRoot, 'assets/agency-site/watson-r1'), { recursive: true });
  for (const item of roster.assets) {
    const bytes = item.kind === 'font' ? Buffer.alloc(48) : Buffer.from([0xff, 0xd8, 0xff, 0xe0, roster.assets.indexOf(item)]);
    if (item.kind === 'font') { bytes.write('wOF2'); bytes.writeUInt32BE(bytes.length, 8); }
    await writeFile(path.join(projectRoot, 'assets/agency-site/watson-r1', item.file), bytes);
  }
  await writeFile(path.join(projectRoot, 'recipe.json'), JSON.stringify(recipe));
  await writeFile(path.join(projectRoot, 'approved.json'), JSON.stringify(roster));
  await writeFile(path.join(projectRoot, 'site.html'), result.html);
  await writeFile(path.join(projectRoot, 'site.html.artifact.json'), JSON.stringify(result.manifest));
  const options = { projectRoot, templatesRoot, entry: 'site.html', skillId: 'agency-site', baseSource: result.html as string, baseVersionDigest: digest(result.html), request: { baseRecipeFile: 'recipe.json', approvedAssetManifestFile: 'approved.json', baseVersionId: 'original-version', expectedSourceDigest: digest(result.html) } };
  const save = async (html: string) => { await writeFile(path.join(projectRoot, 'site.html'), html); options.request.expectedSourceDigest = digest(html); };
  return { options, recipe, roster, original: result.html as string, manifest: result.manifest, save, renderer };
}

describe('guarded Agency Site recipe reconciliation', () => {
  it('reconciles the live Watson picture/text shape, retaining stale asset hints without trusting them', async () => {
    const s = await setup(), $ = load(s.original);
    $('[data-od-id="watson-footer:awardCaption"]').text('Saved by a designer');
    const src = $('img[data-od-id="watson-statement:topSecond"]').attr('src')!;
    $('[data-od-id="watson-footer:awardDesktop"]').attr({ src, alt: 'Local image replacement test' });
    $('[data-od-id="watson-footer:awardMobile"]').attr('srcset', src);
    await s.save($.html());
    const before = await readdir(s.options.projectRoot);
    const result = await reconcileAgencyRecipe(s.options);
    expect(result.regenerationSafe).toBe(true);
    if (!result.regenerationSafe) throw new Error(JSON.stringify(result.conflicts));
    const footer = result.recipe.sections.find((section) => section.type === 'footer')!;
    expect(footer.content.awardCaption).toBe('Saved by a designer');
    expect(footer.content.awardAlt).toBe('Local image replacement test');
    expect(footer.assets.awardDesktop).toBe('watson-inline-top-02');
    expect(footer.assets.awardMobile).toBe('watson-inline-top-02');
    expect(await readdir(s.options.projectRoot)).toEqual(before);
    expect(await readFile(path.join(s.options.projectRoot, 'site.html'), 'utf8')).toBe($.html());
    expect(JSON.parse(await readFile(path.join(s.options.projectRoot, 'recipe.json'), 'utf8'))).toEqual(s.recipe);
    const next = structuredClone(result.recipe); next.revision = 2;
    next.sections.find((section) => section.type === 'hero')!.content.location = 'New model revision';
    const rendered = s.renderer.renderAgencySite(next, 'site-r2.html', result.approvedAssetManifest);
    expect(rendered.html).toContain('Saved by a designer');
    expect(rendered.html).toContain('Local image replacement test');
    expect(rendered.html).toContain('New model revision');
    // A restored source is reconciled afresh, not from an accumulated edit log.
    await s.save(s.original);
    const restored = await reconcileAgencyRecipe(s.options);
    expect(restored.regenerationSafe).toBe(true);
    if (restored.regenerationSafe) { expect(restored.changes).toEqual([]); expect(restored.recipe).toEqual(s.recipe); }
  });

  it('reconciles a page built with an effect plan against the same plan, and refuses a forged one', async () => {
    const s = await setup();
    // The build's own render: the same recipe, decorated by the shared compiler's effect plan.
    const withEffect = s.renderer.renderAgencySite(s.recipe, 'site.html', s.roster, { effects: { effects: [{ placement: 'section-reveal', componentId: 'scroll-reveal', source: 'jev' }] } });
    expect(withEffect.effects?.applied.map((entry: { componentId: string }) => entry.componentId)).toEqual(['scroll-reveal']);
    expect(withEffect.html).not.toBe(s.original);
    const $ = load(withEffect.html);
    $('[data-od-id="watson-footer:awardCaption"]').text('Saved over an effect');
    await s.save($.html());
    const options = { ...s.options, baseSource: withEffect.html as string, baseVersionDigest: digest(withEffect.html) };
    const result = await reconcileAgencyRecipe(options);
    if (!result.regenerationSafe) throw new Error(JSON.stringify(result.conflicts));
    expect(result.recipe.sections.find((section) => section.type === 'footer')?.content.awardCaption).toBe('Saved over an effect');

    // A component the family does not allow at that host cannot be smuggled in as a "saved plan".
    const forged = load(s.original);
    forged('[data-od-id="watson-footer:network"]').attr('data-genui', 'split-text');
    const forgedHtml = forged.html();
    await s.save(forgedHtml);
    const refused = await reconcileAgencyRecipe({ ...s.options, baseSource: forgedHtml, baseVersionDigest: digest(forgedHtml) });
    expect(refused.regenerationSafe).toBe(false);
    expect(refused.conflicts[0]?.code).toBe('baseline-render-mismatch');
    // Nor an id outside every allowlist (and the reserved sentinel): the replayed `repair` source
    // grants nothing — the compiler skips it `not-allowed` and the render cannot match.
    for (const id of ['no-such-component', 'none']) {
      const outside = load(s.original);
      outside('[data-od-id="watson-footer:network"]').attr('data-genui', id);
      await s.save(outside.html());
      const result = await reconcileAgencyRecipe({ ...s.options, baseSource: outside.html(), baseVersionDigest: digest(outside.html()) });
      expect(result.regenerationSafe, id).toBe(false);
      expect(result.conflicts[0]?.code, id).toBe('baseline-render-mismatch');
    }
  });

  it.each(['style', 'delete', 'nested', 'derived-link', 'shared-alt', 'duplicate-target'])('rejects unsupported %s without returning recipe data', async (attack) => {
    const s = await setup(), $ = load(s.original);
    if (attack === 'style') $('body').attr('style', 'color:red');
    if (attack === 'delete') $('[data-od-id="watson-footer:awardCaption"]').remove();
    if (attack === 'nested') $('[data-od-id="watson-footer:awardCaption"]').html('<b>Changed</b>');
    if (attack === 'derived-link') $('[data-od-id="watson-footer:businessEmail"]').text('new@example.com');
    if (attack === 'shared-alt') $('[data-od-id="watson-statement:topFirst"]').attr('alt', 'Only one image');
    if (attack === 'duplicate-target') $('body').append('<span data-od-id="watson-footer:awardCaption">Duplicate</span>');
    await s.save($.html());
    const result = await reconcileAgencyRecipe(s.options);
    expect(result.regenerationSafe).toBe(false);
    expect(result.conflicts.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('recipe');
  });
  it('rejects the arbitrary-baseline attack even when its digest is internally consistent', async () => {
    const s = await setup();
    const edited = s.original.replace('New Business', 'Saved custom label');
    await s.save(edited);
    s.options.baseSource = edited; s.options.baseVersionDigest = digest(edited);
    const result = await reconcileAgencyRecipe(s.options);
    expect(result.regenerationSafe).toBe(false);
    expect(result.conflicts[0]?.code).toBe('baseline-render-mismatch');
  });
  it.each(['source', 'recipe', 'version', 'family', 'project'])('rejects wrong %s anchor', async (attack) => {
    const s = await setup();
    if (attack === 'source') s.options.request.expectedSourceDigest = '0'.repeat(64);
    if (attack === 'version') s.options.baseVersionDigest = '0'.repeat(64);
    if (attack === 'project') s.options.skillId = 'other';
    if (attack === 'recipe') { s.recipe.brand.name = 'SWAN'; await writeFile(path.join(s.options.projectRoot, 'recipe.json'), JSON.stringify(s.recipe)); }
    if (attack === 'family') { s.manifest.metadata.agencySite.family = 'emmpo'; s.manifest.metadata.agencySite.revision = 'emmpo-r1'; s.manifest.supportingFiles = s.manifest.supportingFiles.map((p: string) => p.replace('watson-r1', 'emmpo-r1')); await writeFile(path.join(s.options.projectRoot, 'site.html.artifact.json'), JSON.stringify(s.manifest)); }
    expect((await reconcileAgencyRecipe(s.options)).regenerationSafe).toBe(false);
  });
  it('promotes only a saved declared new raster into a daemon-created approved ID', async () => {
    const s = await setup(), $ = load(s.original), name = 'assets/agency-site/watson-r1/image-new.jpg';
    await writeFile(path.join(s.options.projectRoot, name), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 72]));
    $('[data-od-id="watson-footer:awardDesktop"]').attr('src', name);
    $('[data-od-id="watson-footer:awardMobile"]').attr('srcset', name);
    await s.save($.html());
    expect((await reconcileAgencyRecipe(s.options)).regenerationSafe).toBe(false);
    s.manifest.supportingFiles.push(name);
    await writeFile(path.join(s.options.projectRoot, 'site.html.artifact.json'), JSON.stringify(s.manifest));
    const result = await reconcileAgencyRecipe(s.options);
    expect(result.regenerationSafe).toBe(true);
    if (!result.regenerationSafe) throw new Error(JSON.stringify(result.conflicts));
    expect(result.promotedAssets).toHaveLength(1);
    expect(result.promotedAssets[0]?.id).toMatch(/^manual-image-[a-f0-9]{64}$/);
    expect(result.assetSources.some((asset) => asset.sourcePath === name)).toBe(true);
  });
  it.each(['traversal', 'symlink'])('rejects %s input paths', async (attack) => {
    const s = await setup();
    if (attack === 'traversal') s.options.request.baseRecipeFile = '../recipe.json';
    else { await symlink(path.join(s.options.projectRoot, 'recipe.json'), path.join(s.options.projectRoot, 'linked.json')); s.options.request.baseRecipeFile = 'linked.json'; }
    expect((await reconcileAgencyRecipe(s.options)).regenerationSafe).toBe(false);
  });
  it.each(['remote', 'cross-revision', 'asset-symlink', 'asset-hash', 'disguised-raster'])('rejects %s assets', async (attack) => {
    const s = await setup(), $ = load(s.original);
    const image = s.roster.assets.find((asset) => asset.id === 'watson-footer-desktop')!;
    const file = path.join(s.options.projectRoot, 'assets/agency-site/watson-r1', image.file);
    if (attack === 'remote') $('[data-od-id="watson-footer:awardDesktop"]').attr('src', 'https://example.com/private.jpg');
    if (attack === 'cross-revision') $('[data-od-id="watson-footer:awardDesktop"]').attr('src', `assets/agency-site/watson-r2/${image.file}`);
    if (attack === 'asset-symlink') { await rm(file); await symlink(path.join(s.options.projectRoot, 'recipe.json'), file); }
    if (attack === 'asset-hash') { Object.assign(image, { sha256: '0'.repeat(64) }); await writeFile(path.join(s.options.projectRoot, 'approved.json'), JSON.stringify(s.roster)); }
    if (attack === 'disguised-raster') await writeFile(file, '<script>untrusted()</script>');
    await s.save($.html());
    const result = await reconcileAgencyRecipe(s.options);
    expect(result.regenerationSafe).toBe(false);
    expect(result).not.toHaveProperty('approvedAssetManifest');
  });
});

describe('native Agency Site reconciliation API and compiled CLI', () => {
  let server: http.Server, base: string;
  beforeAll(async () => { const started = await startServer({ port: 0, returnServer: true }) as { url: string; server: http.Server }; base = started.url; server = started.server; });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const post = (url: string, body: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  it('uses saved version authority, returns conflicts in the CLI, and loads bundled TS through plain Node 24', async () => {
    const s = await setup();
    const created = await post('/api/projects', { id: randomUUID(), name: 'Recipe reconciliation isolated test', skillId: 'agency-site' });
    expect(created.ok).toBe(true);
    const id = (await created.json() as CreateProjectResponse).project.id;
    for (const item of s.roster.assets) {
      const name = `assets/agency-site/watson-r1/${item.file}`;
      expect((await post(`/api/projects/${id}/files`, { name, content: (await readFile(path.join(s.options.projectRoot, name))).toString('base64'), encoding: 'base64' })).ok).toBe(true);
    }
    for (const name of ['recipe.json', 'approved.json']) expect((await post(`/api/projects/${id}/files`, { name, content: await readFile(path.join(s.options.projectRoot, name), 'utf8') })).ok).toBe(true);
    const first = await post(`/api/projects/${id}/files`, { name: 'site.html', content: s.original, artifactManifest: s.manifest, versionSource: 'manual' });
    expect(first.ok).toBe(true);
    const originalVersion = (await first.json() as ProjectFileResponse).version!.id;
    const $ = load(s.original); $('[data-od-id="watson-footer:awardCaption"]').text('Native saved caption');
    const edited = $.html();
    const second = await post(`/api/projects/${id}/files`, { name: 'site.html', content: edited, versionSource: 'manual', parentVersionId: originalVersion });
    expect(second.ok).toBe(true);
    const editedVersion = (await second.json() as ProjectFileResponse).version!.id;
    const request = { ...s.options.request, baseVersionId: originalVersion, expectedSourceDigest: digest(edited) };
    const url = `/api/projects/${id}/files/site.html/agency-recipe/reconcile`;
    const result = await post(url, request);
    expect(result.status).toBe(200);
    const body = await result.json() as ReconcileAgencyRecipeResponse;
    expect(body.regenerationSafe).toBe(true);
    if (!body.regenerationSafe) throw new Error(JSON.stringify(body));
    expect(body.recipe.sections.find((section) => section.type === 'footer')?.content.awardCaption).toBe('Native saved caption');
    const attack = await post(url, { ...request, baseVersionId: editedVersion });
    expect(attack.status).toBe(409);
    expect((await attack.json() as ReconcileAgencyRecipeResponse).conflicts[0]?.code).toBe('baseline-render-mismatch');
    expect((await fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example' }, body: JSON.stringify(request) })).status).toBe(403);
    const args = ['files', 'reconcile-agency-recipe', id, 'site.html', '--base-recipe', 'recipe.json', '--asset-manifest', 'approved.json', '--base-version', originalVersion, '--expected-source-digest', request.expectedSourceDigest, '--daemon-url', base, '--json'];
    const cli = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args]);
    expect((JSON.parse(cli.stdout) as ReconcileAgencyRecipeResponse).regenerationSafe).toBe(true);
    await expect(promisify(execFile)(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), ...args.map((arg) => arg === originalVersion ? editedVersion : arg)])).rejects.toMatchObject({ code: 1 });
    // Package-shaped resources have no package.json/tsx loader. Native Node must execute the full service there.
    const packagedTemplates = path.join(s.options.projectRoot, 'packaged-resources/design-templates');
    for (const relative of ['assets.ts', 'sections.ts', 'catalog-block.ts', 'catalog/components/scroll-reveal/styles.css', 'catalog/components/scroll-reveal/auto.js', ...['render.ts', 'contract.ts', 'slots.ts', 'browser-source.ts', 'layout.css', 'motion.css'].map((name) => `families/watson/${name}`)]) {
      const destination = path.join(packagedTemplates, 'agency-site/scripts', relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await writeFile(destination, await readFile(path.join(templatesRoot, 'agency-site/scripts', relative)));
    }
    const runtimeModule = pathToFileURL(fileURLToPath(new URL('../dist/artifacts/agency-recipe.js', import.meta.url))).href;
    const nodeProof = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(runtimeModule)}); const r=await m.reconcileAgencyRecipe(${JSON.stringify({ ...s.options, templatesRoot: packagedTemplates })}); console.log(JSON.stringify({safe:r.regenerationSafe,conflicts:r.conflicts}));`]);
    expect(JSON.parse(nodeProof.stdout)).toEqual({ safe: true, conflicts: [] });
    expect(await (await fetch(`${base}/api/projects/${id}/files/site.html`)).text()).toBe(edited);
    const history = await (await fetch(`${base}/api/projects/${id}/files/site.html/versions`)).json() as ProjectFileVersionsResponse;
    expect(history.versions).toHaveLength(2);
    expect(history.versions.find((version) => version.current)?.id).toBe(editedVersion);
  });
});
