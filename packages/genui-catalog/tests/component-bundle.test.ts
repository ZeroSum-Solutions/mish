import { describe, expect, it } from 'vitest';
import { buildComponent, isPackageImport } from '../scripts/component-bundle.ts';

// The no-dependency guard classifies each resolve request esbuild hands the plugin. Windows CI
// failed because the entry arrived as `C:\...\index.ts`, matched the `^[^./]` pre-filter and was
// read as a bare package import. These cases pin both platforms' shapes.
describe('isPackageImport', () => {
  it('rejects bare package specifiers', () => {
    for (const specifier of ['react', 'gsap', 'three/addons/x.js', '@scope/pkg', 'node:fs', 'fs']) {
      expect(isPackageImport(specifier, 'import-statement'), specifier).toBe(true);
    }
  });

  it('allows relative and POSIX absolute paths', () => {
    for (const specifier of ['./index.ts', '../_helpers.ts', '/repo/packages/genui-catalog/components/x/index.ts']) {
      expect(isPackageImport(specifier, 'import-statement'), specifier).toBe(false);
    }
  });

  it('allows a Windows absolute path, including the entry point with an empty importer', () => {
    const entry = 'C:\\runner\\_work\\repo\\packages\\genui-catalog\\components\\_template\\index.ts';
    expect(isPackageImport(entry, 'entry-point')).toBe(false);
    expect(isPackageImport(entry, 'import-statement')).toBe(false);
    expect(isPackageImport('D:/repo/components/x/index.ts', 'import-statement')).toBe(false);
    expect(isPackageImport('.\\sibling.ts', 'import-statement')).toBe(false);
  });

  it('never treats the entry point as a package import', () => {
    expect(isPackageImport('index.ts', 'entry-point')).toBe(false);
  });
});

describe('buildComponent', () => {
  it('bundles the template component through the guard', async () => {
    const built = await buildComponent('_template');
    expect(built.esm.length).toBeGreaterThan(0);
    expect(built.auto.length).toBeGreaterThan(0);
  });
});
