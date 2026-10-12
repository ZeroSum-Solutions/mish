import { build } from 'esbuild';
import { installRecipeScroll } from './gsap-browser-fixture.js';
// @ts-expect-error -- jsdom has no bundled type declarations.
import { JSDOM, VirtualConsole } from 'jsdom';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GSAP_RECIPE_IDS, createGsapRecipeMaterials } from '../../src/workbench/recipes/gsap/index.js';
import type { ReactTargetReceipt } from '../../src/workbench/targets/react/receipt.js';

/**
 * G02 P0 React-target receipt generator (deterministic; no network, no
 * install). It copies the pinned fixture React 18 + TypeScript project,
 * writes the registered GSAP units exactly as apply writes them next to the entry,
 * builds the production client bundle with the pinned esbuild, renders the
 * static preview on the server (no window), hydrates that preview with the
 * production bundle under Strict Mode in jsdom, and records toolchain,
 * build options and output hashes. Regenerate with
 * `OD_UPDATE_G02_RECEIPT=1 pnpm --filter @mish/daemon exec vitest run tests/workbench/g02-react-receipt.test.ts`.
 */
const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const fixtureRoot = join(daemonRoot, 'tests', 'fixtures', 'workbench', 'g02-react-fixture');
export const G02_RECEIPT_DOC_PATH = join(repoRoot, 'docs', 'plans', '2026-10-02-design-workbench', 'evidence', 'implementation-start', 'g02-react-receipt.json');
export const G02_RECEIPT_MODULE_PATH = join(daemonRoot, 'src', 'workbench', 'targets', 'react', 'g02-receipt.ts');
const nodeModules = join(daemonRoot, 'node_modules');
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const posix = (value: string) => value.split('\\').join('/');

/** Production build options, recorded verbatim in the receipt. */
export const G02_CLIENT_BUILD = Object.freeze({
  entryPoints: ['src/main.tsx'], bundle: true, minify: true, format: 'esm', platform: 'browser', target: 'es2020',
  jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, legalComments: 'eof',
} as const);

function filesOf(root: string): { path: string; sha256: string }[] {
  const out: { path: string; sha256: string }[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: posix(relative(root, full)), sha256: sha256(readFileSync(full)) });
    }
  };
  walk(root);
  return out;
}

function installedVersion(name: string): string {
  const require = createRequire(join(daemonRoot, 'package.json'));
  return (JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as { version: string }).version;
}

export async function buildG02ReactReceipt(): Promise<ReactTargetReceipt> {
  const work = mkdtempSync(join(tmpdir(), 'g02-react-receipt-'));
  try {
    const fixtureFiles = filesOf(fixtureRoot);
    cpSync(fixtureRoot, work, { recursive: true });
    const materials = createGsapRecipeMaterials();
    const units: ReactTargetReceipt['units'] = [];
    for (const recipe of GSAP_RECIPE_IDS) {
      const material = (await materials.materialize(`${recipe}-react`))!;
      const unit = material.files[0]!;
      writeFileSync(join(work, 'src', unit.path), unit.bytes);
      units.push({ recipe, path: `src/${unit.path}`, sha256: sha256(unit.bytes) });
    }
    const pins = JSON.parse(readFileSync(join(fixtureRoot, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; devDependencies: Record<string, string> };
    const toolchain: ReactTargetReceipt['toolchain'] = {
      esbuild: installedVersion('esbuild'), react: installedVersion('react'), 'react-dom': installedVersion('react-dom'),
      gsap: installedVersion('gsap'), '@gsap/react': installedVersion('@gsap/react'),
    };
    for (const [name, version] of Object.entries(toolchain)) {
      const pinned = pins.dependencies[name] ?? pins.devDependencies[name];
      if (pinned !== version) throw new Error(`Fixture pins ${name}@${pinned} but the workspace resolves ${version}`);
    }

    const client = await build({ ...G02_CLIENT_BUILD, entryPoints: [...G02_CLIENT_BUILD.entryPoints], absWorkingDir: work, nodePaths: [nodeModules], write: false, logLevel: 'silent' });
    const bundle = client.outputFiles[0]!.text;
    if (bundle.includes(work)) throw new Error('Production bundle embeds the build directory');
    const server = await build({
      entryPoints: ['src/server.tsx'], absWorkingDir: work, nodePaths: [nodeModules], bundle: true, write: false, platform: 'node', format: 'cjs',
      target: 'node20', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent',
    });
    const module = { exports: {} as { renderPreview?: () => string } };
    new Function('module', 'exports', 'require', server.outputFiles[0]!.text)(module, module.exports, createRequire(join(daemonRoot, 'package.json')));
    const ssr = module.exports.renderPreview!();
    const preview = `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><title>G02 React target receipt</title></head><body><div id="root">${ssr}</div><script type="module" src="./app.js"></script></body></html>\n`;

    // Hydrate the static preview with the production bundle under Strict Mode.
    const errors: string[] = [];
    const virtualConsole = new VirtualConsole();
    virtualConsole.on('error', (...args: unknown[]) => errors.push(args.map(String).join(' ')));
    virtualConsole.on('jsdomError', (error: Error) => errors.push(error.message));
    const dom = new JSDOM(preview.replace('<script type="module" src="./app.js"></script>', ''), { runScripts: 'outside-only', pretendToBeVisual: true, url: 'http://localhost/', virtualConsole });
    installRecipeScroll(dom.window);
    dom.window.matchMedia = (media: string) => ({ media, matches: !/reduce\)/u.test(media), onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false });
    dom.window.addEventListener('error', (event: { message: string }) => errors.push(event.message));
    dom.window.eval(bundle);
    await new Promise(done => setTimeout(done, 50));
    const document = dom.window.document;
    const roots = document.querySelectorAll('[data-od-gsap]').length;
    const motionStarted = [...document.querySelectorAll('[data-od-animate]')].some((element: { getAttribute(name: string): string | null }) => (element.getAttribute('style') ?? '') !== '');
    dom.window.close();

    return {
      schema: 'g02-react-receipt/1', adapter: 'react-source/v1', sources: ['gsap'],
      toolchainResolution: 'Resolved from apps/daemon node_modules as installed from the workspace pnpm-lock.yaml (exact pins); no network install at build time. The fixture package.json pins must equal the resolved versions or the build refuses.',
      status: errors.length === 0 && roots === GSAP_RECIPE_IDS.length && motionStarted && ssr.includes('data-od-gsap') ? 'passed' : 'failed',
      fixture: { path: posix(relative(repoRoot, fixtureRoot)), files: fixtureFiles },
      toolchain,
      build: { tool: 'esbuild', options: { ...G02_CLIENT_BUILD, entryPoints: [...G02_CLIENT_BUILD.entryPoints] }, generator: 'apps/daemon/tests/workbench/g02-react-receipt-build.ts buildG02ReactReceipt()' },
      units,
      outputs: {
        productionBundle: { path: 'dist/app.js', sha256: sha256(bundle), bytes: Buffer.byteLength(bundle) },
        staticPreview: { path: 'dist/index.html', sha256: sha256(preview), bytes: Buffer.byteLength(preview) },
      },
      checks: { ssrWithoutWindow: ssr.includes('data-od-gsap'), strictModeHydration: true, hydrationErrors: errors.length, mountedRoots: roots, motionStarted },
    };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** Writes the receipt to the evidence path and the daemon's generated mirror of it. */
export function writeG02ReactReceipt(receipt: ReactTargetReceipt): void {
  const json = `${JSON.stringify(receipt, null, 2)}\n`;
  writeFileSync(G02_RECEIPT_DOC_PATH, json);
  writeFileSync(G02_RECEIPT_MODULE_PATH, [
    '// Generated by apps/daemon/tests/workbench/g02-react-receipt-build.ts; do not edit.',
    '// Mirrors docs/plans/2026-10-02-design-workbench/evidence/implementation-start/g02-react-receipt.json.',
    "import type { ReactTargetReceipt } from './receipt.js';",
    '',
    `export const G02_REACT_RECEIPT: ReactTargetReceipt | null = ${JSON.stringify(receipt, null, 2)};`,
    '',
  ].join('\n'));
}
