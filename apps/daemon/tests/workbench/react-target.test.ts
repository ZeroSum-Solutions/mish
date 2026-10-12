import { describe, expect, it } from 'vitest';
import { checkReactTarget, detectProjectTarget } from '../../src/workbench/targets/react/detect.js';

/**
 * G02 React target adapter (`react-source/v1`): the project's own manifest
 * decides whether a React unit may land. A non-React project gets a typed
 * refusal naming what was detected; nothing is converted silently and no
 * ProjectKind is mapped to React by guess.
 */
/** The project's installed react and react-dom (Sol B5/6: admission reads these, not the declared range). */
const installedAt = (version: string) => {
  const resolved = { state: 'resolved' as const, version, major: Number(version.split('.')[0]) };
  return { installed: { react: resolved, reactDom: resolved } };
};

describe('G02 react-source/v1 target detection', () => {
  it('detects the project framework, React major, TypeScript and style runtime from package.json', () => {
    const vite = detectProjectTarget({ dependencies: { react: '^18.3.1', 'react-dom': '^18.3.1' }, devDependencies: { vite: '7.3.3', typescript: '5.9.3', tailwindcss: '^4.1.0' } });
    expect(vite).toMatchObject({ framework: 'react', reactMajor: 18, reactDomMajor: 18, typescript: true, styleRuntime: 'tailwind4' });
    expect(vite.dependencyDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(detectProjectTarget({ dependencies: { next: '16.0.0', react: '19.1.0', 'react-dom': '19.1.0' } })).toMatchObject({ framework: 'next', reactMajor: 19 });
    expect(detectProjectTarget({ dependencies: { vue: '^3.5.0' } })).toMatchObject({ framework: 'vue', reactMajor: null });
    expect(detectProjectTarget({ dependencies: { svelte: '^5.0.0' } })).toMatchObject({ framework: 'svelte', reactMajor: null });
    expect(detectProjectTarget({ dependencies: { '@angular/core': '^20.0.0' } })).toMatchObject({ framework: 'angular' });
    expect(detectProjectTarget({ dependencies: { preact: '^10.0.0' } })).toMatchObject({ framework: 'preact', reactMajor: null });
    expect(detectProjectTarget({ dependencies: { 'styled-components': '^6.1.0', react: '18.3.1', 'react-dom': '18.3.1' } })).toMatchObject({ styleRuntime: 'styled-components' });
    expect(detectProjectTarget(null)).toMatchObject({ framework: 'none', reactMajor: null, typescript: false });
  });

  it('admits a React 17+ project with react-dom and refuses every other target with a typed reason', () => {
    expect(checkReactTarget({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' }, devDependencies: { typescript: '5.9.3' } }, installedAt('18.3.1'))).toMatchObject({ ok: true, profile: { framework: 'react', reactMajor: 18 } });
    expect(checkReactTarget({ dependencies: { next: '16.0.0', react: '19.1.0', 'react-dom': '19.1.0', typescript: '5.9.3' } }, installedAt('19.1.0'))).toMatchObject({ ok: true });
    expect(checkReactTarget(null)).toMatchObject({ ok: false, reason: 'package-manifest-missing' });
    expect(checkReactTarget({ dependencies: { vue: '^3.5.0' } })).toMatchObject({ ok: false, reason: 'target-not-react', profile: { framework: 'vue' } });
    expect(checkReactTarget({ dependencies: { preact: '^10.0.0' } })).toMatchObject({ ok: false, reason: 'target-not-react', profile: { framework: 'preact' } });
    expect(checkReactTarget({ dependencies: { react: '^16.14.0', 'react-dom': '^16.14.0' } })).toMatchObject({ ok: false, reason: 'react-version-unsupported', profile: { reactMajor: 16 } });
    expect(checkReactTarget({ dependencies: { react: 'latest', 'react-dom': 'latest' } })).toMatchObject({ ok: false, reason: 'react-version-unreadable' });
    expect(checkReactTarget({ dependencies: { react: '18.3.1', typescript: '5.9.3' } })).toMatchObject({ ok: false, reason: 'react-dom-missing' });
    for (const result of [checkReactTarget(null), checkReactTarget({ dependencies: { vue: '^3.5.0' } })]) {
      expect(result.ok ? '' : result.message).toMatch(/nothing was (converted|written)/u);
    }
  });

  it('fails closed on ambiguous runtimes, mismatched react-dom, compound ranges and missing TypeScript (W2)', () => {
    const react = { react: '18.3.1', 'react-dom': '18.3.1', typescript: '5.9.3' };
    for (const other of [{ vue: '^3.5.0' }, { svelte: '^5.0.0' }, { 'solid-js': '^1.9.0' }, { preact: '^10.0.0' }, { '@angular/core': '^20.0.0' }]) {
      expect(checkReactTarget({ dependencies: { ...react, ...other } })).toMatchObject({ ok: false, reason: 'target-ambiguous' });
    }
    expect(checkReactTarget({ dependencies: { ...react, 'react-dom': '19.1.0' } })).toMatchObject({ ok: false, reason: 'react-dom-mismatch' });
    // Compound ranges are not read as a release line: they stay refused (fail closed), documented in ADOPTION.md.
    expect(checkReactTarget({ dependencies: { ...react, react: '>=17 <19' } })).toMatchObject({ ok: false, reason: 'react-version-unreadable' });
    expect(checkReactTarget({ dependencies: { ...react, react: '17 || 18' } })).toMatchObject({ ok: false, reason: 'react-version-unreadable' });
    // The unit is TSX; a JavaScript-only project is refused rather than given a file it cannot compile.
    expect(checkReactTarget({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } }, installedAt('18.3.1'))).toMatchObject({ ok: false, reason: 'typescript-missing' });
    expect(checkReactTarget({ dependencies: { react: '18.3.1', 'react-dom': '18.3.1' } }, { tsconfig: true, ...installedAt('18.3.1') })).toMatchObject({ ok: true, profile: { typescript: true } });
    expect(checkReactTarget({ dependencies: react }, installedAt('18.3.1'))).toMatchObject({ ok: true });
  });

  it('Sol B5/6 BLOCK: the resolved installed react and react-dom majors decide; a declared range never stands in for them', () => {
    const resolved = (version: string) => ({ state: 'resolved' as const, version, major: Number(version.split('.')[0]) });
    const manifest = { dependencies: { react: '>=18.0.0', 'react-dom': '>=18.0.0', typescript: '5.9.3' } };
    expect(checkReactTarget(manifest, { installed: { react: resolved('19.1.0'), reactDom: resolved('19.1.0') } })).toMatchObject({ ok: true, profile: { reactMajor: 19, reactDomMajor: 19 } });
    expect(checkReactTarget(manifest)).toMatchObject({ ok: false, reason: 'react-version-unresolved' });
    expect(checkReactTarget(manifest, { installed: { react: { state: 'absent' }, reactDom: resolved('18.3.1') } })).toMatchObject({ ok: false, reason: 'react-version-unresolved' });
    expect(checkReactTarget(manifest, { installed: { react: { state: 'unreadable', reason: 'escapes-project' }, reactDom: resolved('18.3.1') } })).toMatchObject({ ok: false, reason: 'react-version-unresolved' });
    expect(checkReactTarget(manifest, { installed: { react: resolved('19.1.0'), reactDom: resolved('18.3.1') } })).toMatchObject({ ok: false, reason: 'react-dom-mismatch' });
    expect(checkReactTarget(manifest, { installed: { react: resolved('16.14.0'), reactDom: resolved('16.14.0') } })).toMatchObject({ ok: false, reason: 'react-version-unsupported', profile: { reactMajor: 16 } });
  });
});
