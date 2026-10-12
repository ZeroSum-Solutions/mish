/**
 * Build the package: dist/index.mjs (the catalog API, JSON inlined) and, per component directory,
 * dist/components/<dir>/{index.js, auto.js, styles.css}. Declarations come from tsc afterwards and
 * dist/data.{js,d.ts} from scripts/copy-dist-data.ts.
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { buildComponent, componentDirs, packageRoot } from './component-bundle.ts';

const distDir = path.join(packageRoot, 'dist');
rmSync(distDir, { force: true, recursive: true });

await build({
  bundle: true,
  entryPoints: [path.join(packageRoot, 'src/index.ts')],
  format: 'esm',
  outfile: path.join(distDir, 'index.mjs'),
  platform: 'neutral',
  target: 'es2022',
  logLevel: 'warning',
});

for (const dir of componentDirs()) {
  const built = await buildComponent(dir);
  const out = path.join(distDir, 'components', dir);
  mkdirSync(out, { recursive: true });
  writeFileSync(path.join(out, 'index.js'), built.esm);
  writeFileSync(path.join(out, 'auto.js'), built.auto);
  writeFileSync(path.join(out, 'styles.css'), built.css);
  console.log(`genui-catalog: built components/${dir} (js ${Buffer.byteLength(built.esm)} B, css ${Buffer.byteLength(built.css)} B)`);
}
