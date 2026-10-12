#!/usr/bin/env node
// Compile the Tailwind utilities actually used by one page kind's vendored HyperUI blocks into a
// single CSS file, so the fast lane can inline it the way families inline `layout.css` (design
// doc §3: "Tailwind is compiled once at vendoring time per page kind ... and the resulting CSS is
// INLINED into the HTML"). Tailwind CLI is pinned to 4.3.3 and run through `npx --yes`, since the
// workspace's own `tailwindcss` (4.3.0, in apps/web) is a different, unrelated pin and this script
// must not add or change any package.json or the lockfile.
//
// THIS IS AN AUTHOR-TIME TOOL, NOT A CI STEP. It fetches @tailwindcss/cli@4.3.3 from the npm
// registry on every invocation (falling back to `pnpm dlx` when `npx` cannot resolve the
// registry-installed `tailwindcss` package against a scratch input file — see the fallback
// below), so it needs network reach and cannot run in CI. The output, css/<kind>.css, is
// committed to the repo; CI never regenerates it. CI's only check on this output is that the
// committed file exists and satisfies its size/content assertions — that check is disk-only and
// lives in `scripts/vendor-hyperui.ts --check` (see pagekinds.json cross-check there), wired into
// the Preflight job in .github/workflows/ci.yml. Re-run this script by hand and commit the result
// whenever a page kind's block list in pagekinds.json changes, when a family's render.ts starts
// emitting a new utility class, or when bumping
// TAILWIND_CLI_VERSION below (keep it in sync with the same constant in vendor-hyperui.ts, which
// records it in manifest.json for anyone reading the committed output).
//
// Usage:
//   node --experimental-strip-types scripts/build-ui-kit-css.ts               # every page kind
//   node --experimental-strip-types scripts/build-ui-kit-css.ts crm-dashboard # one page kind
//   node --experimental-strip-types scripts/build-ui-kit-css.ts --preview     # css/preview.css, every block

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TAILWIND_CLI_VERSION = '4.3.3';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), '..');
const kitRoot = path.join(repoRoot, 'plugins/_official/shared/ui-kits/hyperui');
const cssRoot = path.join(kitRoot, 'css');
const examplesRoot = path.join(repoRoot, 'plugins/_official/examples');

/**
 * The render.ts of the family that owns a page kind (`agency-<kind>/.../families/<kind>/`), or
 * null when no package owns the kind. The family template wraps the vendored blocks in its own
 * layout markup (page container, wrapping rows, truncated labels, sr-only text), so its utilities
 * must be compiled too: scanning only the blocks left those classes with no rule, and the page
 * overflowed at 375 px. Every class the rendered page emits is checked against this output by the
 * family's render.test.ts.
 */
function familyRenderSource(kind: string): string | null {
  const renderPath = path.join(examplesRoot, `agency-${kind}`, 'compiler/scripts/families', kind, 'render.ts');
  return existsSync(renderPath) ? renderPath : null;
}

interface PageKinds {
  [kind: string]: string[];
}

function readPageKinds(): PageKinds {
  const pageKindsPath = path.join(kitRoot, 'pagekinds.json');
  if (!existsSync(pageKindsPath)) {
    throw new Error(`missing ${pageKindsPath}`);
  }
  return JSON.parse(readFileSync(pageKindsPath, 'utf8')) as PageKinds;
}

function runTailwindCli(args: string[]): void {
  try {
    execFileSync('npx', ['--yes', `@tailwindcss/cli@${TAILWIND_CLI_VERSION}`, ...args], {
      cwd: repoRoot,
      stdio: 'inherit',
    });
    return;
  } catch (npxError) {
    console.warn(
      `build-ui-kit-css: npx could not run @tailwindcss/cli@${TAILWIND_CLI_VERSION} (${
        npxError instanceof Error ? npxError.message : String(npxError)
      }); falling back to pnpm dlx.`,
    );
  }
  execFileSync('pnpm', ['dlx', `@tailwindcss/cli@${TAILWIND_CLI_VERSION}`, ...args], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
}

function buildPageKindCss(kind: string, blockIds: string[]): void {
  const blockPaths = blockIds.map((id) => path.join(kitRoot, 'blocks', `${id}.html`));
  const missing = blockPaths.filter((p) => !existsSync(p));
  if (missing.length > 0) {
    throw new Error(`page kind "${kind}" references missing block file(s): ${missing.join(', ')}`);
  }

  const workDir = mkdtempSync(path.join(tmpdir(), 'ui-kit-css-'));
  try {
    const inputCssPath = path.join(workDir, 'input.css');
    // `@tailwindcss/cli` 4.3.3 has no `--content` flag (its own `--help` does not list one); a
    // `--content <path>` argument is silently ignored, and with plain `@import "tailwindcss";`
    // the CLI falls back to its automatic content-detection heuristic rooted at `--cwd` (here,
    // the repo root), which scans every vendored block for every page kind and produces the same
    // kitchen-sink output regardless of which kind is being built. `source(none)` disables that
    // automatic detection, and one `@source "<absolute path>";` per block is what actually scopes
    // the scan to this kind's own blocks (plus the owning family's render.ts, see
    // familyRenderSource).
    const renderSource = familyRenderSource(kind);
    const inputCss = [
      '@import "tailwindcss" source(none);',
      ...blockPaths.map((blockPath) => `@source "${blockPath}";`),
      ...(renderSource ? [`@source "${renderSource}";`] : []),
      '',
    ].join('\n');
    writeFileSync(inputCssPath, inputCss);
    const outputCssPath = path.join(workDir, 'output.css');

    const args = ['-i', inputCssPath, '-o', outputCssPath, '--minify'];
    runTailwindCli(args);

    if (!existsSync(outputCssPath)) {
      throw new Error(`Tailwind CLI did not produce ${outputCssPath} for page kind "${kind}"`);
    }

    mkdirSync(cssRoot, { recursive: true });
    const finalCss = readFileSync(outputCssPath, 'utf8');
    writeFileSync(path.join(cssRoot, `${kind}.css`), finalCss);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * The Enlarge preview stylesheet (AC-R07 "compiled HTML section" adapter): every vendored block's
 * utilities in one file, so the daemon can serve any single block as a self-contained preview
 * document with no Tailwind runtime and no CDN. The first line records which block bytes it was
 * compiled from (`blocks-sha256`); the daemon refuses to serve previews from a stale file.
 */
export const PREVIEW_CSS_FILE = 'preview.css';
export function previewBlocksDigest(blocks: ReadonlyArray<{ id: string; sha256: string }>): string {
  const lines = blocks.map((block) => `${block.id}:${block.sha256}`).sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function buildPreviewCss(): void {
  const manifest = JSON.parse(readFileSync(path.join(kitRoot, 'manifest.json'), 'utf8')) as { blocks: Array<{ id: string; file: string }> };
  const blocks = manifest.blocks.map((block) => ({
    id: block.id,
    path: path.join(kitRoot, block.file),
    sha256: createHash('sha256').update(readFileSync(path.join(kitRoot, block.file))).digest('hex'),
  }));
  const workDir = mkdtempSync(path.join(tmpdir(), 'ui-kit-css-'));
  try {
    const inputCssPath = path.join(workDir, 'input.css');
    writeFileSync(inputCssPath, ['@import "tailwindcss" source(none);', ...blocks.map((block) => `@source "${block.path}";`), ''].join('\n'));
    const outputCssPath = path.join(workDir, 'output.css');
    runTailwindCli(['-i', inputCssPath, '-o', outputCssPath, '--minify']);
    const css = readFileSync(outputCssPath, 'utf8');
    mkdirSync(cssRoot, { recursive: true });
    writeFileSync(path.join(cssRoot, PREVIEW_CSS_FILE), `/* od:hyperui-preview blocks-sha256=${previewBlocksDigest(blocks)} tailwindcss=${TAILWIND_CLI_VERSION} */\n${css}`);
    console.log(`build-ui-kit-css: wrote css/${PREVIEW_CSS_FILE} (${css.length} bytes, ${blocks.length} blocks).`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function main(): void {
  if (process.argv.includes('--preview')) {
    buildPreviewCss();
    return;
  }
  const requested = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const pageKinds = readPageKinds();
  const kinds = requested.length > 0 ? requested : Object.keys(pageKinds);

  for (const kind of kinds) {
    const blockIds = pageKinds[kind];
    if (!blockIds) {
      throw new Error(`unknown page kind "${kind}"; known: ${Object.keys(pageKinds).join(', ')}`);
    }
    buildPageKindCss(kind, blockIds);
    const bytes = readFileSync(path.join(cssRoot, `${kind}.css`), 'utf8').length;
    console.log(`build-ui-kit-css: wrote css/${kind}.css (${bytes} bytes, ${blockIds.length} blocks).`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
