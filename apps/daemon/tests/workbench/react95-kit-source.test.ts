import { describe, expect, it } from 'vitest';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { React95Kit } from '../../src/workbench/kits/react95/kit-types.js';
import { applyEdits, react95UnitFiles, unitPathOf } from '../../src/workbench/kits/react95/unit.js';
import { REACT95_TYPECHECK_PROFILE, typecheckUnit } from './react95-typecheck.js';
import {
  REACT95_COMMIT, REACT95_KIT_DOC_PATH, REACT95_TEMPLATE_FILES, buildReact95Kit, gitBlobId, importClosure, kitTemplatePath, materializeReact95Unit,
  react95KitEvidence, writeReact95Kit,
} from './react95-kit-build.js';

/**
 * AC-R17.1: the exact requested fork and its notices, a frozen shipped
 * inventory, dependency pins and the first two templates. The kit module is
 * generated once from the archive of `react95-io/React95@871d5335…` (no
 * network in this test); here every recorded byte is re-verified.
 */
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const loadKit = async (): Promise<React95Kit> => (await import('../../src/workbench/kits/react95/kit.generated.js')).REACT95_KIT;

describe('AC-R17.1 React95 exact source, notices and frozen inventory', () => {
  it('regenerates from the archive only when one is supplied, and the committed module equals that regeneration', async () => {
    const archive = process.env.OD_REACT95_UPSTREAM_ARCHIVE;
    if (!archive) return;
    const fresh = await buildReact95Kit(archive);
    expect(await buildReact95Kit(archive)).toEqual(fresh);
    if (process.env.OD_UPDATE_REACT95_KIT === '1') writeReact95Kit(fresh);
    expect(await loadKit()).toEqual(fresh);
  }, 600_000);

  it('pins the exact requested repository and commit, never the repository the upstream manifest links', async () => {
    const kit = await loadKit();
    expect(kit.source).toMatchObject({
      repository: 'https://github.com/react95-io/React95', commit: REACT95_COMMIT,
      archive: { url: `https://codeload.github.com/react95-io/React95/tar.gz/${REACT95_COMMIT}`, paxCommit: REACT95_COMMIT },
      packageName: 'react95', packageVersion: '0.0.0-development', manifestLicense: 'MIT',
      peerDependencies: { react: '>= 16.8.0', 'react-dom': '>= 16.8.0', 'styled-components': '>= 5.3.3' },
    });
    expect(kit.source.archive.sha256).toMatch(/^[a-f0-9]{64}$/u);
    // The upstream manifest names arturbien/React95; that is recorded as a fact, not adopted as the source.
    expect(kit.source.manifestRepository).toContain('arturbien/React95');
    expect(kit.source.repository).not.toContain('arturbien');
  });

  it('every vendored and notice text matches its recorded git blob id and SHA-256, and only text is vendored', async () => {
    const kit = await loadKit();
    for (const file of [...kit.vendored, kit.notices.code, ...kit.notices.fonts.flatMap(font => [font.licence, font.readme])]) {
      const bytes = Buffer.from(file.text, 'utf8');
      expect({ path: file.path, sha256: sha256(bytes), gitBlob: gitBlobId(bytes), bytes: bytes.length }).toEqual({ path: file.path, sha256: file.sha256, gitBlob: file.gitBlob, bytes: file.bytes });
    }
    // Font and image binaries are inventoried with their digests but never vendored.
    expect(kit.vendored.every(file => /\.(?:tsx?)$/u.test(file.path))).toBe(true);
    expect(kit.inventory.fonts.map(file => file.path)).toEqual(expect.arrayContaining([
      'src/assets/fonts/dist/ms_sans_serif.woff2', 'src/assets/fonts/dist/ms_sans_serif_bold.woff2',
      'src/assets/fonts/src/ms-sans-serif/MS Sans Serif.ttf', 'src/assets/fonts/src/ms-sans-serif-bold/MS Sans Serif Bold.ttf',
    ]));
    // Each vendored source file is the same file the inventory froze.
    const inventoried = new Map([...kit.inventory.components.flatMap(c => c.files), ...kit.inventory.shared, ...kit.inventory.themes].map(file => [file.path, file]));
    for (const file of kit.vendored.filter(entry => entry.path !== 'src/index.ts')) {
      const { text: _text, ...identity } = file;
      expect(inventoried.get(file.path)).toEqual(identity);
    }
  });

  it('records code MIT and the bundled font CC BY-SA 3.0 terms separately, verbatim from the source', async () => {
    const kit = await loadKit();
    expect(kit.notices.code.path).toBe('LICENSE');
    expect(kit.notices.code.text).toMatch(/^MIT License/u);
    expect(kit.notices.code.text).toContain('Permission is hereby granted, free of charge');
    expect(kit.notices.fonts.map(font => font.family)).toEqual(['MS Sans Serif', 'MS Sans Serif Bold']);
    for (const font of kit.notices.fonts) {
      expect(font.licence.text).toContain('Creative Commons Attribution Share Alike');
      expect(font.licence.text).toContain('http://creativecommons.org/licenses/by-sa/3.0/');
      expect(font.licence.text).toContain('“lou”');
      expect(font.readme.text.length).toBeGreaterThan(0);
      expect(font.files.length).toBe(1);
      // The code licence is never presented as the font's licence.
      expect(font.licence.text).not.toMatch(/\bMIT\b/u);
    }
  });

  it('freezes one inventory row per exported component (current and deprecated), each with its shipped files', async () => {
    const kit = await loadKit();
    const index = kit.vendored.find(file => file.path === 'src/index.ts')!.text;
    const exported = [...index.matchAll(/^export \* from '\.\/([^']+)';$/gmu)].map(match => `./${match[1]}`);
    expect(kit.inventory.components.map(component => component.exportPath)).toEqual(exported);
    expect(kit.inventory.components).toHaveLength(40);
    expect(kit.inventory.components.filter(component => component.legacy)).toHaveLength(12);
    expect(new Set(kit.inventory.components.map(component => component.id)).size).toBe(40);
    expect(kit.inventory.components.find(component => component.id === 'window')!.files.map(file => file.path)).toEqual(['src/Window/Window.tsx', 'src/Window/WindowContent.tsx', 'src/Window/WindowHeader.tsx']);
    expect(kit.inventory.themes.map(file => file.path)).toEqual(expect.arrayContaining(['src/common/themes/original.ts', 'src/common/themes/highContrast.ts']));
    // Nothing that is only a story or a test is part of the shipped inventory.
    const paths = [...kit.inventory.components.flatMap(c => c.files), ...kit.inventory.shared].map(file => file.path);
    expect(paths.some(path => /\.(?:stories|spec)\.|__snapshots__/u.test(path))).toBe(false);
  });

  it('embeds the two authored templates byte for byte, each with the exact upstream closure it imports', async () => {
    const kit = await loadKit();
    expect(kit.templates.map(template => [template.id, template.file])).toEqual(REACT95_TEMPLATE_FILES.map(template => [template.id, template.file]));
    for (const template of kit.templates) {
      const authored = readFileSync(kitTemplatePath(template.file), 'utf8');
      expect(template.text).toBe(authored);
      expect(template.sha256).toBe(sha256(authored));
      expect(template.closure).toEqual(expect.arrayContaining(['src/common/themes/original.ts', 'src/common/themes/highContrast.ts']));
      for (const path of template.closure) expect(kit.vendored.some(file => file.path === path)).toBe(true);
    }
    expect(kit.templates.find(t => t.id === 'window-app')!.closure).toEqual(expect.arrayContaining(['src/Window/Window.tsx', 'src/MenuList/MenuList.tsx', 'src/AppBar/AppBar.tsx']));
    expect(kit.templates.find(t => t.id === 'settings-form')!.closure).toEqual(expect.arrayContaining(['src/Checkbox/Checkbox.tsx', 'src/Radio/Radio.tsx', 'src/GroupBox/GroupBox.tsx', 'src/TextInput/TextInput.tsx']));
  });

  it('the vendored closure is complete: each template bundles from vendored bytes alone (pinned packages external) and carries its type-only imports', async () => {
    const kit = await loadKit();
    for (const template of kit.templates) {
      const dir = mkdtempSync(join(tmpdir(), 'react95-closure-'));
      try {
        materializeReact95Unit(kit, dir, [template.id]);
        const result = await build({
          entryPoints: [template.file], absWorkingDir: dir, bundle: true, write: false, metafile: true, logLevel: 'silent', format: 'esm', jsx: 'automatic',
          external: ['react', 'react/*', 'react-dom', 'react-dom/*', 'styled-components'], outdir: 'out',
        });
        const toUpstream = new Map(template.closure.map(path => [unitPathOf(path), path]));
        const used = Object.keys(result.metafile!.inputs).filter(path => path.startsWith('react95.')).map(path => toUpstream.get(path));
        // The bundler's runtime inputs are inside the closure; the closure adds only type-only imports a type checker needs.
        for (const path of used) expect(template.closure).toContain(path);
        const full = importClosure(dir, [template.file]).filter(path => path.startsWith('react95.')).map(path => toUpstream.get(path));
        expect(full.sort()).toEqual([...template.closure].sort());
        expect(template.closure).toEqual(expect.arrayContaining(['src/types.ts', 'src/common/themes/types.ts']));
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  });

  it('declares every edit to upstream bytes; each resolves a named diagnostic, and each unit type-checks under the project profile', async () => {
    const kit = await loadKit();
    expect(REACT95_TYPECHECK_PROFILE).toMatchObject({ strict: true, isolatedModules: true, verbatimModuleSyntax: true, types: [] });
    expect(kit.adapters.map(adapter => adapter.file)).toEqual(['React95Theme.d.ts']);
    expect(kit.adapters[0]!.text).toBe(readFileSync(kitTemplatePath('React95Theme.d.ts'), 'utf8'));
    expect(kit.patches.length).toBeGreaterThan(0);
    for (const patch of kit.patches) {
      const upstream = kit.vendored.find(file => file.path === patch.path)!;
      expect(patch.upstreamSha256).toBe(upstream.sha256);
      expect(patch.patchedSha256).toBe(sha256(applyEdits(upstream.text, patch.edits)));
      expect(patch.reasons.length).toBeGreaterThan(0);
      expect(patch.reasons.every(reason => ['flat-layout', 'TS1205', 'TS1484', 'TS2591'].includes(reason))).toBe(true);
      // Only a flat-layout import specifier, an inline `type` modifier, or the Buffer global read from globalThis: no behavior change.
      for (const edit of patch.edits) {
        const removed = upstream.text.slice(edit.at, edit.at + edit.deleteCount);
        if (edit.deleteCount === 0) expect(edit.insert).toBe('type ');
        else if (removed === 'Buffer') expect(edit.insert).toMatch(/^\(globalThis as unknown as .*\)\.Buffer$/u);
        else {
          expect(removed).toMatch(/^\.{1,2}(?:\/|$)/u);
          expect(edit.insert).toMatch(/^\.\/react95\.[A-Za-z0-9.]+$/u);
          expect(upstream.text.slice(edit.at - 1, edit.at)).toMatch(/['"]/u);
        }
      }
    }
    expect(kit.patches.some(patch => patch.reasons.includes('TS1205'))).toBe(true);
    for (const template of kit.templates) {
      const dir = mkdtempSync(join(tmpdir(), 'react95-typecheck-'));
      try {
        materializeReact95Unit(kit, dir, [template.id]);
        expect(typecheckUnit(dir, [template.file, 'React95Theme.d.ts'])).toEqual([]);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
    // A unit never carries a font or image file, and always carries the upstream code licence.
    const unit = react95UnitFiles(kit, 'window-app')!;
    expect(unit.some(file => /\.(?:woff2?|ttf|png|psd)$/u.test(file.path))).toBe(false);
    expect(unit.find(file => file.path === 'react95.LICENSE')).toMatchObject({ role: 'asset', upstream: { path: 'LICENSE', patched: false } });
    // The unit is flat: the adoption executor writes into one existing directory.
    expect(unit.every(file => !file.path.includes('/'))).toBe(true);
  });

  it('the evidence copy carries every identity and digest, without the file texts', async () => {
    const kit = await loadKit();
    const committed: unknown = JSON.parse(readFileSync(REACT95_KIT_DOC_PATH, 'utf8'));
    expect(committed).toEqual(react95KitEvidence(kit));
    expect(JSON.stringify(committed)).not.toContain('Permission is hereby granted');
  });
});
