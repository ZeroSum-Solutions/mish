/**
 * Copies the checked Cult adapters from the private source kit into `generated/`.
 *
 *   node --experimental-strip-types scripts/adapters.ts          write generated/ from the kit
 *   node --experimental-strip-types scripts/adapters.ts --check  write nothing; exit 1 on a failure
 *
 * Run `scripts/import.ts` first: catalog.json decides which rows are insertable (from the kit's
 * `converted/` output), and this script copies exactly those adapters:
 *
 *   generated/adapters/<name>.ts   the kit's converted/<name>/adapter.ts, import path and id rewritten
 *                                  (src/converted.ts `productAdapterSource`)
 *   generated/index.ts             the typed lazy registry `{ 'cult:<name>': () => Promise<SectionAdapter> }`
 *   generated/section-adapter.ts   the one re-export of the shared compiler's adapter contract
 *   generated/previews/<name>.webp converted/<name>/preview.png as WebP, at most 40 KB each
 *
 * `--check` runs scripts/adapter-check.ts. The kit path is CULT_KIT_DIR (default
 * ~/projects/mm-source-kits/cult-ui-pro); without the kit (CI) the kit comparison is skipped and
 * said so, unless CULT_REQUIRE_KIT=1.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { PREVIEW_BYTE_LIMIT, productAdapterSource } from '../src/converted.ts';
import type { CultCatalog } from '../src/types.ts';
import { catalogIssues } from '../src/validate.ts';
import { checkAdapters, indexSource, PACKAGE_DIR, shimSource } from './adapter-check.ts';

const generatedDir = join(PACKAGE_DIR, 'generated');
const kitDir = process.env.CULT_KIT_DIR ?? join(homedir(), 'projects', 'mm-source-kits', 'cult-ui-pro');

type Sharp = (input: string) => { resize: (o: { width: number; withoutEnlargement: boolean }) => { webp: (o: { quality: number; effort: number }) => { toBuffer: () => Promise<Buffer> } } };

function fail(title: string, lines: readonly string[]): never {
  console.error(`${title} (${lines.length})`);
  for (const line of lines.slice(0, 60)) console.error(`  - ${line}`);
  if (lines.length > 60) console.error(`  … ${lines.length - 60} more`);
  process.exit(1);
}

function loadCatalog(): CultCatalog {
  const catalog = JSON.parse(readFileSync(join(PACKAGE_DIR, 'catalog.json'), 'utf8')) as CultCatalog;
  const issues = catalogIssues(catalog);
  if (issues.length > 0) fail('catalog.json is invalid', issues);
  return catalog;
}

function writeIfChanged(path: string, content: string | Buffer): void {
  if (existsSync(path) && readFileSync(path).equals(Buffer.from(content))) return;
  writeFileSync(path, content);
}

/** Smallest acceptable WebP: shrink width, then quality, until it is under the byte limit. */
async function webpPreview(sharp: Sharp, png: string): Promise<Buffer> {
  for (const width of [640, 520, 420]) {
    for (const quality of [62, 50, 40, 30]) {
      const out = await sharp(png).resize({ width, withoutEnlargement: true }).webp({ quality, effort: 6 }).toBuffer();
      if (out.length <= PREVIEW_BYTE_LIMIT) return out;
    }
  }
  throw new Error(`${png}: no WebP rendition fits ${PREVIEW_BYTE_LIMIT} B`);
}

async function runWrite(): Promise<void> {
  if (!existsSync(join(kitDir, 'converted'))) fail('Source kit converter output missing', [join(kitDir, 'converted')]);
  const catalog = loadCatalog();
  const rows = catalog.rows.filter((row) => row.conversion.status === 'insertable');
  const adaptersDir = join(generatedDir, 'adapters');
  const previewsDir = join(generatedDir, 'previews');
  mkdirSync(adaptersDir, { recursive: true });
  mkdirSync(previewsDir, { recursive: true });
  // sharp is a devDependency used only here (never by the check or at runtime).
  const sharp = createRequire(import.meta.url)('sharp') as Sharp;

  const keepAdapters = new Set<string>();
  const keepPreviews = new Set<string>();
  for (const row of rows) {
    const kitAdapter = join(kitDir, 'converted', row.name, 'adapter.ts');
    writeIfChanged(join(adaptersDir, `${row.name}.ts`), productAdapterSource(readFileSync(kitAdapter, 'utf8'), row.name));
    keepAdapters.add(`${row.name}.ts`);
    if (row.previewId !== null) {
      const png = join(kitDir, 'converted', row.name, 'preview.png');
      if (!existsSync(png)) fail('Preview missing in the kit', [png]);
      writeIfChanged(join(previewsDir, row.previewId), await webpPreview(sharp, png));
      keepPreviews.add(row.previewId);
    }
  }
  for (const file of readdirSync(adaptersDir)) if (!keepAdapters.has(file)) rmSync(join(adaptersDir, file));
  for (const file of readdirSync(previewsDir)) if (!keepPreviews.has(file)) rmSync(join(previewsDir, file));
  writeIfChanged(join(generatedDir, 'section-adapter.ts'), shimSource());
  writeIfChanged(join(generatedDir, 'index.ts'), indexSource(rows.map((row) => row.name)));
  console.log(`generated/: ${rows.length} adapters, ${keepPreviews.size} previews`);
  await runCheck(catalog);
}

async function runCheck(catalog = loadCatalog()): Promise<void> {
  const kitPresent = existsSync(join(kitDir, 'converted'));
  if (!kitPresent && process.env.CULT_REQUIRE_KIT === '1') fail('Source kit missing', [kitDir]);
  const result = await checkAdapters({ catalog, generatedDir, kitDir: kitPresent ? kitDir : null });
  if (result.errors.length > 0) fail('Cult adapter check failed', result.errors);
  const largest = [...result.measured].sort((a, b) => b.total - a.total)[0];
  const previews = existsSync(join(generatedDir, 'previews')) ? readdirSync(join(generatedDir, 'previews')) : [];
  const previewBytes = previews.reduce((sum, f) => sum + readFileSync(join(generatedDir, 'previews', f)).length, 0);
  console.log(
    `Cult adapters valid (${result.measured.length} adapters${result.kitCompared ? ', match the source kit' : ''}); `
    + `largest worst-case HTML+CSS ${largest ? `${largest.id} ${largest.total} B (html ${largest.htmlMin}, css ${largest.cssMin})` : 'n/a'}; `
    + `previews ${previews.length} files, ${previewBytes} B`,
  );
  for (const note of result.notes) console.log(note);
}

if (process.argv.includes('--check')) await runCheck();
else await runWrite();
