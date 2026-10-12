/**
 * esbuild helpers shared by scripts/build.ts (writes dist/components/<dir>/) and
 * scripts/build-catalog.ts (measures the minified bytes it records in catalog.json).
 *
 * A component must have no dependency: every bundled input must come from inside this package
 * and never from node_modules, which is how "no React, GSAP or three.js" is enforced.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { build, transform, type Plugin } from 'esbuild';

export const packageRoot = path.resolve(import.meta.dirname, '..');
export const componentsDir = path.join(packageRoot, 'components');

export interface BuiltComponent {
  /** ESM module: `export { id, mount, autoInit, ... }`. */
  esm: string;
  /** Classic script that mounts every `[data-genui="<id>"]` once the DOM is ready; safe to inline. */
  auto: string;
  /** Minified styles.css. */
  css: string;
}

/** Every component directory, including `_template`. */
export function componentDirs(): string[] {
  if (!existsSync(componentsDir)) return [];
  return readdirSync(componentsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(componentsDir, entry.name, 'index.ts')))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Is this resolve request a package import (the thing the no-dependency rule forbids)?
 *
 * The entry point itself is never one, and neither is a relative or absolute path. Absolute is
 * checked with both path flavours: on Windows esbuild hands the plugin the entry as `C:\...`,
 * which the `^[^./]` pre-filter lets through, so a POSIX-only check would reject the component's
 * own index.ts. Every bare specifier (`react`, `gsap`, `node:fs`, `@scope/pkg`) stays forbidden.
 */
export function isPackageImport(specifier: string, kind: string): boolean {
  if (kind === 'entry-point') return false;
  if (/^\.\.?(?:[/\\]|$)/.test(specifier)) return false;
  return !(path.posix.isAbsolute(specifier) || path.win32.isAbsolute(specifier));
}

const noDependencies: Plugin = {
  name: 'genui-no-dependencies',
  setup(pluginBuild) {
    pluginBuild.onResolve({ filter: /^[^./]/ }, (args) => {
      if (!isPackageImport(args.path, args.kind)) return undefined;
      const importer = args.importer ? path.relative(packageRoot, args.importer) : '<stdin>';
      return {
        errors: [{ text: `components may not import packages ("${args.path}" from ${importer}): no React, GSAP, three.js or any other dependency` }],
      };
    });
  },
};

async function bundle(dir: string, format: 'esm' | 'iife', contents?: string): Promise<string> {
  const componentDir = path.join(componentsDir, dir);
  const result = await build({
    ...(contents === undefined
      ? { entryPoints: [path.join(componentDir, 'index.ts')] }
      : { stdin: { contents, loader: 'ts', resolveDir: componentDir, sourcefile: `${dir}/auto.ts` } }),
    bundle: true,
    format,
    minify: true,
    legalComments: 'none',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
    plugins: [noDependencies],
  });
  const file = result.outputFiles[0];
  if (!file) throw new Error(`esbuild produced no output for ${dir}`);
  return file.text;
}

const AUTO_ENTRY = [
  "import { autoInit } from './index.ts';",
  'const run = () => { autoInit(document); };',
  "if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run, { once: true });",
  'else run();',
].join('\n');

function minifyCss(dir: string): Promise<string> {
  const cssSource = readFileSync(path.join(componentsDir, dir, 'styles.css'), 'utf8');
  return transform(cssSource, { loader: 'css', minify: true, target: 'chrome111' }).then((out) => out.code);
}

export async function buildComponent(dir: string): Promise<BuiltComponent> {
  const [esm, auto, css] = await Promise.all([bundle(dir, 'esm'), bundle(dir, 'iife', AUTO_ENTRY), minifyCss(dir)]);
  return { esm, auto, css };
}

/**
 * The bytes catalog.json records: the minified ESM bundle and the minified CSS. Builds only those
 * two (not the auto-mount IIFE), since `build-catalog --check` measures every ported component.
 */
export async function measureComponent(dir: string): Promise<{ js: number; css: number }> {
  const [esm, css] = await Promise.all([bundle(dir, 'esm'), minifyCss(dir)]);
  return { js: Buffer.byteLength(esm), css: Buffer.byteLength(css) };
}
