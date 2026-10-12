import { describe, expect, it } from 'vitest';
import { inspectTwenty1stLocalImports } from '../src/services/twenty1st-local-import-closure.js';

const file = (path: string, content: string) => ({ path, content });
const config = file('gallery/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));

describe('private 21st local import closure', () => {
  it('accepts commented tsconfig with trailing commas without changing alias checks', () => {
    const commented = file('tsconfig.json', `{
      // A normal TypeScript configuration
      "compilerOptions": { "baseUrl": ".", "paths": { "@/*": ["./*",], }, },
    }`);
    const importer = file('demo.ts', "import x from '@/ui';");
    expect(inspectTwenty1stLocalImports([commented, importer, file('ui.ts', 'export default 1;')]))
      .toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([commented, importer])).toEqual({ status: 'missing', missing: [
      { importer: 'demo.ts', specifier: '@/ui', resolvedCandidate: 'ui' },
    ] });
  });

  it.each(['{"compilerOptions": {', '{"compilerOptions": {"baseUrl": "."}} garbage'])
    ('rejects malformed tsconfig despite tolerant JSONC parsing: %s', content => {
      expect(inspectTwenty1stLocalImports([file('tsconfig.json', content), file('demo.ts', 'export default 1;')]))
        .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
    });

  it('fails closed for deeply nested invalid config instead of crashing the catalog', () => {
    const content = '['.repeat(20_000) + '1' + ']'.repeat(20_000);
    expect(inspectTwenty1stLocalImports([file('tsconfig.json', content)]))
      .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
  });

  it.each(['.cts', '.cjs', '/index.cts', '/index.cjs'])('finds saved CJS-family targets ending in %s', extension => {
    expect(inspectTwenty1stLocalImports([
      file('demo.ts', "export * from './helper';"), file(`helper${extension}`, 'export const x = 1;'),
    ])).toEqual({ status: 'resolved' });
  });

  it('checks literal CommonJS imports inside a saved CJS target', () => {
    const importer = file('demo.ts', "import helper from './helper';");
    const helper = file('helper.cjs', "module.exports = require('./nested');");
    expect(inspectTwenty1stLocalImports([importer, helper])).toEqual({ status: 'missing', missing: [
      { importer: 'helper.cjs', specifier: './nested', resolvedCandidate: 'nested' },
    ] });
    expect(inspectTwenty1stLocalImports([importer, helper, file('nested.cjs', 'module.exports = 1;')]))
      .toEqual({ status: 'resolved' });
  });

  it.each(["require(name)", "const load = require; load('./missing')", "module[name]('./missing')",
    "globalThis.require('./missing')", "globalThis['require']('./missing')",
    "const load = globalThis['require']; load('./missing')", "helper.require('./missing')",
    "helper?.require('./missing')", "globalThis[`require`]('./missing')",
    "globalThis['req'+'uire']('./missing')", "const { require: load } = globalThis; load('./missing')",
    "const { ['req'+'uire']: load } = globalThis; load('./missing')",
    "const key = 'require'; globalThis[key]('./missing')", "helper[key]('./missing')",
    "const key = 'require'; const load = globalThis[key]; load('./missing')"])
    ('keeps dynamic or aliased CommonJS loaders unverified: %s', content => {
      expect(inspectTwenty1stLocalImports([file('demo.cjs', content)]))
        .toEqual({ status: 'unverified', reason: 'dynamic-local-import' });
    });

  it.each(["require.resolve('./missing')", "require['resolve']('./missing')", "module.require('./missing')", "module['require']('./missing')", "module[`require`]('./missing')", "module['req'+'uire']('./missing')", "import helper = require('./missing');"])
    ('checks supported literal loader syntax: %s', content => {
      expect(inspectTwenty1stLocalImports([file('demo.cts', content)])).toEqual({ status: 'missing', missing: [
        { importer: 'demo.cts', specifier: './missing', resolvedCandidate: 'missing' },
      ] });
    });

  it('checks CommonJS package imports with the same explicit declaration rules', () => {
    const files = [file('tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}'),
      file('demo.cjs', "module.exports = require('react');")];
    expect(inspectTwenty1stLocalImports(files)).toEqual({ status: 'unverified', reason: 'ambiguous-baseurl-import' });
    expect(inspectTwenty1stLocalImports([...files, file('package.json', '{"dependencies":{"react":"*"}}')]))
      .toEqual({ status: 'resolved' });
  });

  it.each([
    "import { createRequire as makeLoader } from 'node:module'; const load = makeLoader(import.meta.url); load('./missing');",
    "const makeLoader = require('node:module')['createRequire']; const load = makeLoader(__filename); load('./missing');",
    "const { 'createRequire': makeLoader } = require('node:module'); const load = makeLoader(__filename); load('./missing');",
    "const makeLoader = require('node:module')[`createRequire`]; const load = makeLoader(__filename); load('./missing');",
  ])('keeps unsupported loader factories unverified: %s', content => {
    expect(inspectTwenty1stLocalImports([file('demo.ts', content)]))
      .toEqual({ status: 'unverified', reason: 'dynamic-local-import' });
  });

  it('keeps ordinary computed reads and statically named non-loader calls resolved', () => {
    expect(inspectTwenty1stLocalImports([file('demo.ts', 'const item = items[index]; api[`render`](); api["ren"+"der"]();')]))
      .toEqual({ status: 'resolved' });
  });

  it.each([
    'module.exports = module.filename;',
    'const entry = require.main; const filename = module.filename;',
    'if (require.main === module) console.log(module.filename);',
    'if (require.main == module) console.log(module.filename);',
    'if (typeof require === "function" && typeof module === "object") console.log(module.id);',
    'const { filename, id } = module; const { main } = require;',
  ])('allows non-loading CommonJS metadata: %s', content => {
    expect(inspectTwenty1stLocalImports([file('demo.cjs', content)]))
      .toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([file('demo.cjs', `${content}\nrequire('./missing');`)]))
      .toEqual({ status: 'missing', missing: [{importer:'demo.cjs',specifier:'./missing',resolvedCandidate:'missing'}] });
  });

  it('does not treat inherited object names as CommonJS bindings', () => {
    expect(inspectTwenty1stLocalImports([file('demo.ts', 'const { filename } = constructor; constructor.filename; toString.main;')]))
      .toEqual({ status: 'resolved' });
  });

  it.each([
    "const load = require.resolve; load('./missing');",
    "const load = module.require; load('./missing');",
    "const { require: load } = require.main; load('./missing');",
    "require.main.require('./missing');",
    "const main = require.main; main.require('./missing');",
  ])('keeps loaders reached alongside metadata unverified: %s', content => {
    expect(inspectTwenty1stLocalImports([file('demo.cjs', content)]))
      .toEqual({ status: 'unverified', reason: 'dynamic-local-import' });
  });

  it('excludes declared external packages after checking baseUrl-local files', () => {
    expect(inspectTwenty1stLocalImports([
      file('tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}'),
      file('package.json', JSON.stringify({ dependencies: { react: '*', '@scope/icons': '*' }, peerDependencies: { 'react-dom': '*' } })),
      file('demo.ts', "import React from 'react'; import Icon from '@scope/icons/add'; import Client from 'react-dom/client';"),
    ])).toEqual({ status: 'resolved' });
  });

  it('excludes Node builtins with baseUrl while keeping undeclared imports ambiguous', () => {
    const base = file('tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}');
    expect(inspectTwenty1stLocalImports([base, file('demo.ts', "import fs from 'node:fs'; import path from 'path';")]))
      .toEqual({ status: 'resolved' });
    for (const manifest of ['{', '{"dependencies":{"react":null}}']) {
      expect(inspectTwenty1stLocalImports([base, file('package.json', manifest), file('demo.ts', "import React from 'react';")]))
        .toEqual({ status: 'unverified', reason: 'ambiguous-baseurl-import' });
    }
  });

  it('uses ancestor dependency declarations but not manifests in unrelated trees', () => {
    const root = file('package.json', '{"dependencies":{"react":"*"}}');
    const importer = file('nested/demo.ts', "import React from 'react';");
    const base = file('nested/tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}');
    expect(inspectTwenty1stLocalImports([root, base, importer])).toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([file('other/package.json', root.content), base, importer]))
      .toEqual({ status: 'unverified', reason: 'ambiguous-baseurl-import' });
  });

  it('does not excuse missing explicit local aliases using external dependency declarations', () => {
    expect(inspectTwenty1stLocalImports([
      file('tsconfig.json', '{"compilerOptions":{"baseUrl":".","paths":{"react":["./local-react"]}}}'),
      file('package.json', '{"dependencies":{"react":"*"}}'),
      file('demo.ts', "import React from 'react';"),
    ])).toEqual({ status: 'missing', missing: [
      { importer: 'demo.ts', specifier: 'react', resolvedCandidate: 'local-react' },
    ] });
  });

  it('does not hide a missing dependency of a saved baseUrl package shadow', () => {
    expect(inspectTwenty1stLocalImports([
      file('tsconfig.json', '{"compilerOptions":{"baseUrl":"."}}'),
      file('package.json', '{"dependencies":{"react":"*"}}'),
      file('demo.ts', "import React from 'react';"),
      file('react.ts', "export * from './missing';"),
    ])).toEqual({ status: 'missing', missing: [
      { importer: 'react.ts', specifier: './missing', resolvedCandidate: 'missing' },
    ] });
  });

  it('finds the retained Dashboard separator omission without changing byte verification', () => {
    expect(inspectTwenty1stLocalImports([config, file('gallery/components/twentyfirst/dashboard/demo.tsx',
      'import { Separator } from "@/components/ui/separator"; export const Demo = () => <Separator />;')]))
      .toEqual({ status: 'missing', missing: [{ importer: 'gallery/components/twentyfirst/dashboard/demo.tsx', specifier: '@/components/ui/separator', resolvedCandidate: 'gallery/components/ui/separator' }] });
  });

  it('accepts exact alias, relative, export, index, and literal dynamic imports and ignores comments', () => {
    const files = [config,
      file('gallery/components/demo.tsx', `// import x from './ghost'\nimport x from '@/components/ui/separator';
        export { y } from './shared'; export * from './nested';
        const z = import('./lazy');`),
      file('gallery/components/ui/separator.tsx', 'export default 1'),
      file('gallery/components/shared.ts', 'export const y = 2'),
      file('gallery/components/nested/index.ts', 'export const n = 3'),
      file('gallery/components/lazy.js', 'export default 4')];
    expect(inspectTwenty1stLocalImports(files)).toEqual({ status: 'resolved' });
  });

  it('keeps bare packages outside the local check when the nearest config has no baseUrl', () => {
    expect(inspectTwenty1stLocalImports([
      file('tsconfig.json', JSON.stringify({ compilerOptions: {} })),
      file('demo.tsx', "import React from 'react'; export default React;"),
    ])).toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([
      file('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } })),
      file('nested/tsconfig.json', JSON.stringify({ compilerOptions: {} })),
      file('nested/demo.tsx', "import React from 'react'; export default React;"),
    ])).toEqual({ status: 'resolved' });
  });

  it('checks baseUrl-only local targets and fails closed when an absent target could be a package', () => {
    const baseUrlConfig = file('gallery/tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.' } }));
    const importer = file('gallery/components/demo.tsx', "import Separator from 'components/ui/separator'; export default Separator;");
    expect(inspectTwenty1stLocalImports([baseUrlConfig, importer, file('gallery/components/ui/separator.tsx', 'export default 1')]))
      .toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([baseUrlConfig, importer]))
      .toEqual({ status: 'unverified', reason: 'ambiguous-baseurl-import' });
  });

  it('fails closed for parser errors, dynamic imports, and paths escaping the bundle', () => {
    expect(inspectTwenty1stLocalImports([file('demo.tsx', 'import {')])).toEqual({ status: 'unverified', reason: 'parse-error' });
    expect(inspectTwenty1stLocalImports([file('demo.tsx', 'import(`./${name}`)')])).toEqual({ status: 'unverified', reason: 'dynamic-local-import' });
    expect(inspectTwenty1stLocalImports([file('demo.tsx', "import '../outside'")])).toEqual({ status: 'unverified', reason: 'unsafe-local-path' });
  });
  it('keeps exact case and emits sorted, deduplicated missing details', () => {
    expect(inspectTwenty1stLocalImports([
      file('components/demo.tsx', "import './z'; import './a'; import './z'; import './card';"),
      file('components/Card.tsx', 'export default 1'),
    ])).toEqual({ status: 'missing', missing: [
      { importer: 'components/demo.tsx', specifier: './a', resolvedCandidate: 'components/a' },
      { importer: 'components/demo.tsx', specifier: './card', resolvedCandidate: 'components/card' },
      { importer: 'components/demo.tsx', specifier: './z', resolvedCandidate: 'components/z' },
    ] });
  });
  it('applies aliases only inside their tsconfig tree and does not guess inherited config', () => {
    const rootConfig = file('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }));
    expect(inspectTwenty1stLocalImports([rootConfig, file('demo.tsx', "import x from '@/ui/separator'"), file('ui/separator.tsx', 'export default 1')]))
      .toEqual({ status: 'resolved' });
    expect(inspectTwenty1stLocalImports([config, file('outside.tsx', "import x from '@/components/ui/separator'"), file('gallery/components/ui/separator.tsx', 'export default 1')]))
      .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
    expect(inspectTwenty1stLocalImports([file('gallery/tsconfig.json', JSON.stringify({ extends: '../base.json' })), file('gallery/demo.tsx', "import x from '@/missing'" )]))
      .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
    expect(inspectTwenty1stLocalImports([file('tsconfig.json', JSON.stringify({compilerOptions:{paths:{'@/*':['/outside/*']}}})),file('demo.tsx',"import x from '@/ui'")]))
      .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
    expect(inspectTwenty1stLocalImports([rootConfig, file('nested/tsconfig.json', '{}'), file('nested/demo.tsx', "import x from '@/ui/separator'"), file('ui/separator.tsx', 'export default 1')]))
      .toEqual({ status: 'unverified', reason: 'invalid-tsconfig' });
  });

  it('uses the most specific matching paths pattern even when a broader target exists', () => {
    const rootConfig = file('tsconfig.json', JSON.stringify({ compilerOptions: { baseUrl: '.', paths: {
      '@/*': ['./*'],
      '@/components/ui/*': ['./vendor/ui/*'],
    } } }));
    expect(inspectTwenty1stLocalImports([
      rootConfig,
      file('demo.tsx', "import Separator from '@/components/ui/separator'; export default Separator;"),
      file('components/ui/separator.tsx', 'export default 1'),
    ])).toEqual({ status: 'missing', missing: [{
      importer: 'demo.tsx', specifier: '@/components/ui/separator', resolvedCandidate: 'vendor/ui/separator',
    }] });
  });

  it('uses the nested tsconfig owner even when its path and root have equal character length', () => {
    const rootConfig = file('tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./root/*'] } } }));
    const nestedConfig = file('a/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@/*': ['./nested/*'] } } }));
    expect(inspectTwenty1stLocalImports([
      rootConfig, nestedConfig,
      file('a/demo.tsx', "import X from '@/ui'; export default X;"),
      file('root/ui.ts', 'export default 1'),
    ])).toEqual({ status: 'missing', missing: [{
      importer: 'a/demo.tsx', specifier: '@/ui', resolvedCandidate: 'a/nested/ui',
    }] });
  });
});
