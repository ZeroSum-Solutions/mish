import { mkdir, readFile, writeFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { renderAgencySite } from './render.ts';
import { readApprovedAsset, readRegularFile } from './assets.ts';

export async function compose(input: string, assetsDir: string, outDir: string, entry: string, assetManifest?: string) {
  const raw = await readRegularFile(input, 64 * 1024);
  const approved = assetManifest ? JSON.parse((await readRegularFile(assetManifest, 64 * 1024)).toString('utf8')) : undefined;
  const result = renderAgencySite(JSON.parse(raw.toString('utf8')), entry, approved);
  const assetRoot = await realpath(assetsDir);
  const assets = 'approvedAssets' in result ? await Promise.all(result.approvedAssets.map(async (asset) => ({ file: asset.destination, bytes: await readApprovedAsset(assetsDir, asset) }))) : await Promise.all(result.manifest.supportingFiles.map(async (file) => {
    const source = path.join(assetRoot, path.basename(file));
    const stat = await lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 10 * 1024 * 1024) throw new Error(`Asset must be a regular raster file under 10 MB: ${file}`);
    return { file, bytes: await readFile(source) };
  }));
  // Exclusive directory creation refuses every existing candidate, including edited HTML.
  // Validate/read before reserving it. A write failure leaves a partial new directory
  // for inspection; the caller must choose another directory, never overwrite it.
  await mkdir(outDir);
  for (const asset of assets) {
    await mkdir(path.dirname(path.join(outDir, asset.file)), { recursive: true });
    await writeFile(path.join(outDir, asset.file), asset.bytes, { flag: 'wx' });
  }
  await writeFile(path.join(outDir, `${entry}.artifact.json`), `${JSON.stringify(result.manifest, null, 2)}\n`, { flag: 'wx' });
  await writeFile(path.join(outDir, entry), result.html, { flag: 'wx' });
  return { entry: path.join(outDir, entry), manifest: path.join(outDir, `${entry}.artifact.json`), supportingFiles: result.manifest.supportingFiles };
}

const entryPath = process.argv[1] ? await realpath(process.argv[1]).catch(() => undefined) : undefined;
if (entryPath && import.meta.url === pathToFileURL(entryPath).href) {
  try {
    const { values } = parseArgs({ options: { input: { type: 'string' }, assets: { type: 'string' }, 'asset-manifest': { type: 'string' }, 'out-dir': { type: 'string' }, entry: { type: 'string' } } });
    if (!values.input || !values.assets || !values['out-dir'] || !values.entry) throw new Error('Usage: compose.ts --input recipe.json --assets approved-assets --asset-manifest approved-assets.json --out-dir NEW-directory --entry site-r1.html (asset manifest required for schemaVersion 2)');
    console.log(JSON.stringify(await compose(values.input, values.assets, values['out-dir'], values.entry, values['asset-manifest'])));
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
