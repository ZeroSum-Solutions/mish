import { createRequire } from 'node:module';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type * as TypeScript from 'typescript';

/**
 * The project type-check profile the React95 units are proved against: the
 * settings a current React + TypeScript project uses (Next.js forces
 * `isolatedModules`; Vite templates add `verbatimModuleSyntax`), strict mode,
 * DOM types only (no `@types/node`) and the pinned `@types/react` 18 and
 * `@types/styled-components` 5 packages. Recorded verbatim in the receipt.
 */
export const REACT95_TYPECHECK_PROFILE = Object.freeze({
  strict: true, noEmit: true, isolatedModules: true, verbatimModuleSyntax: true, skipLibCheck: true,
  jsx: 'react-jsx', module: 'esnext', moduleResolution: 'bundler', target: 'es2020', lib: ['es2020', 'dom'], types: [] as string[],
});

const daemonRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(daemonRoot, 'package.json'));
const ts = require('typescript') as typeof TypeScript;

export interface TypecheckDiagnostic { file: string | null; start: number | null; code: number; message: string }

/** Type-checks `entries` (relative to `dir`) with the profile; packages resolve from the daemon's pinned node_modules. */
export function typecheckUnit(dir: string, entries: readonly string[]): TypecheckDiagnostic[] {
  const modules = join(daemonRoot, 'node_modules');
  const options: TypeScript.CompilerOptions = {
    strict: true, noEmit: true, isolatedModules: true, verbatimModuleSyntax: true, skipLibCheck: true,
    jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target: ts.ScriptTarget.ES2020,
    lib: ['lib.es2020.d.ts', 'lib.dom.d.ts'], types: [], typeRoots: [join(modules, '@types')],
    // The project's own node_modules stand-in: typings first, then the packages.
    baseUrl: dir, paths: { '*': [`${modules}/@types/*`, `${modules}/*`] },
  };
  const program = ts.createProgram(entries.map(entry => join(dir, entry)), options);
  return ts.getPreEmitDiagnostics(program).map(diagnostic => ({
    file: diagnostic.file ? diagnostic.file.fileName.slice(dir.length + 1).split('\\').join('/') : null,
    start: diagnostic.start ?? null,
    code: diagnostic.code,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
  }));
}

export const typescriptVersion = () => ts.version;
