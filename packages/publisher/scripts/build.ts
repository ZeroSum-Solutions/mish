/**
 * Builds `dist/`:
 *
 * - `dist/index.js`, `dist/node.js` and their declarations, by `tsc -p tsconfig.build.json`.
 * - `dist/families/<family>.js`: one self-contained ESM bundle per bundled family package
 *   (`plugins/_official/examples/agency-<family>/`), holding that family's compiler copy and, as
 *   data, every resource it renders with, its approved roster, reference recipe and schema. A
 *   server imports one and passes its default export to `compile`; nothing is read from disk.
 * - `dist/families/index.js`: `BUNDLED_FAMILIES` and `loadBundledFamily(id)`.
 * - `dist/LICENSE`: the repository's Apache-2.0 text, so a packed tarball carries it.
 * - `dist/NOTICE`: the notices of the third-party code the family bundles redistribute (HyperUI,
 *   MIT), taken from the family packages' own copies.
 *
 * An install context without the family packages or the repository LICENSE (`deploy/Dockerfile`
 * runs `pnpm install` before it copies `plugins/`) gets the code entries only; the daemon there
 * loads families from disk through `@mish/publisher/node` and never imports the bundles.
 *
 * Only packages whose compiler copy ships `resources.ts` are bundled: an older copy would read its
 * own files at render time, which a bundle cannot satisfy.
 *
 *   node --experimental-strip-types scripts/build.ts
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { loadFamilyCompiler } from '../src/node.ts';

const packageRoot = path.resolve(import.meta.dirname, '..');
const repoRoot = path.resolve(packageRoot, '../..');
const examplesDir = path.join(repoRoot, 'plugins/_official/examples');
const dist = path.join(packageRoot, 'dist');
const familiesOut = path.join(dist, 'families');

rmSync(dist, { recursive: true, force: true });
const tsc = spawnSync(process.execPath, [path.join(packageRoot, 'node_modules/typescript/bin/tsc'), '-p', path.join(packageRoot, 'tsconfig.build.json')], { stdio: 'inherit' });
if (tsc.status !== 0) process.exit(tsc.status ?? 1);
mkdirSync(familiesOut, { recursive: true });
const license = path.join(repoRoot, 'LICENSE');
if (existsSync(license)) copyFileSync(license, path.join(dist, 'LICENSE'));
else console.log('publisher: no repository LICENSE in this context; dist/LICENSE skipped');

/** Each compiler function the bundle wires, and the copy's file that exports it. */
const MODULE_FILES: Record<string, string> = {
  renderAgencySite: 'render.ts',
  withCompilerResources: 'resources.ts',
  readFamilyEffectDeclaration: 'effects.ts',
  verifyApprovedAssetBytes: 'assets.ts',
  dishonestLinks: 'sections.ts',
  selfSectionAnchors: 'sections.ts',
};

if (!existsSync(examplesDir)) console.log(`publisher: no ${path.relative(repoRoot, examplesDir)} in this context; family bundles skipped`);
const packages = (existsSync(examplesDir) ? readdirSync(examplesDir, { withFileTypes: true }) : [])
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('agency-'))
  .map((entry) => entry.name)
  .filter((name) => existsSync(path.join(examplesDir, name, 'compiler/scripts/resources.ts')))
  .sort();

/** Third-party notices the bundles must carry: the vendored file, keyed by the catalog path it ships at. */
const VENDORED_NOTICES: Record<string, string> = { 'catalog/hyperui/LICENSE': 'HyperUI component CSS (catalog/hyperui/*.css)' };
const notices = new Map<string, string>();

const families: string[] = [];
for (const name of packages) {
  const family = name.slice('agency-'.length);
  const packageDir = path.join(examplesDir, name);
  const scripts = path.join(packageDir, 'compiler/scripts');
  const { compiler } = await loadFamilyCompiler(packageDir, family);
  for (const notice of Object.keys(VENDORED_NOTICES)) {
    const file = path.join(scripts, notice);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const seen = notices.get(notice);
    if (seen !== undefined && seen !== text) throw new Error(`publisher: ${name} ships a different ${notice} than another family`);
    notices.set(notice, text);
  }
  const names = Object.keys(compiler.modules).sort();
  const imports = names.map((fn) => `import { ${fn} } from ${JSON.stringify(`./${MODULE_FILES[fn]}`)};`).join('\n');
  const data = JSON.stringify({ family, resources: compiler.resources, approvedAssets: compiler.approvedAssets, reference: compiler.reference, schema: compiler.schema });
  const contents = `${imports}
const data = ${data};
const compiler = Object.freeze({ ...data, resources: Object.freeze(data.resources), modules: Object.freeze({ ${names.join(', ')} }) });
export default compiler;
`;
  await build({
    stdin: { contents, resolveDir: scripts, sourcefile: `${name}-publisher-entry.ts`, loader: 'ts' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    outfile: path.join(familiesOut, `${family}.js`),
    logLevel: 'warning',
  });
  writeFileSync(path.join(familiesOut, `${family}.d.ts`), `import type { FamilyCompiler } from '../index.js';\ndeclare const compiler: FamilyCompiler;\nexport default compiler;\n`);
  families.push(family);
}

const cases = families.map((family) => `    case ${JSON.stringify(family)}: return (await import(${JSON.stringify(`./${family}.js`)})).default;`).join('\n');
writeFileSync(path.join(familiesOut, 'index.js'), `// Generated by packages/publisher/scripts/build.ts.
export const BUNDLED_FAMILIES = Object.freeze(${JSON.stringify(families)});
export async function loadBundledFamily(family) {
  switch (family) {
${cases}
    default: throw new Error(\`@mish/publisher/families: no bundled family \${JSON.stringify(family)}\`);
  }
}
`);
writeFileSync(path.join(familiesOut, 'index.d.ts'), `import type { FamilyCompiler } from '../index.js';
export type BundledFamily = ${families.map((family) => JSON.stringify(family)).join(' | ') || 'never'};
export declare const BUNDLED_FAMILIES: readonly BundledFamily[];
export declare function loadBundledFamily(family: string): Promise<FamilyCompiler>;
`);
if (notices.size > 0) {
  const sections = [...notices].map(([notice, text]) => `${VENDORED_NOTICES[notice]}, bundled into dist/families/*.js:\n\n${text.trimEnd()}\n`);
  writeFileSync(path.join(dist, 'NOTICE'), `@mish/publisher redistributes the following third-party code.\n\n${sections.join('\n')}`);
}
console.log(`publisher: built dist/ with ${families.length} bundled families (${families.join(', ')})`);
