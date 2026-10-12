import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { listSkills } from '../src/skills.js';
import { captureOdNextSessionSkillPackage } from '../src/strategies/od-next/session-skill-package.js';
import { MAX_PACKAGE_BYTES, materializeFrozenSkillPackage, resolveFrozenSkillBundleBodies } from '../src/strategies/od-next/frozen-skill-package.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const references = [
  { id: 'agency-emmpo', url: 'https://emmpo.changers.studio/', signal: 'nine-section scroll sequence' },
  { id: 'agency-watson', url: 'https://watson.la/', signal: 'inline images embedded in that reading flow' },
  { id: 'agency-cult-heroes', url: 'https://pro.cult-ui.com/docs/hero', signal: 'public code/docs controls were disabled' },
];
const temporaryRoots: string[] = [];
const exec = promisify(execFile);
afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('agency reference studies reach the selected assistant context', () => {
  it('executes the frozen compiler in an isolated directory with separately approved media', async () => {
    const skills = await listSkills([path.join(root, 'skills'), path.join(root, 'design-templates')]);
    const frozen = await captureOdNextSessionSkillPackage({
      metadata: { kind: 'prototype' },
      getLocalPluginBySource: undefined,
      selection: { skillId: 'agency-site', skillIds: references.map(({ id }) => id) },
      listSkillCatalog: async () => skills,
    });
    // Capture is fail-soft: an over-budget selection logs a warning and yields an empty package.
    // Fail here, by name, before anything indexes into the materialized roots.
    expect(
      frozen.selections.map((selection) => selection.canonicalId),
      'only the public Agency Site compiler is captured',
    ).toEqual(['agency-site']);
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-compiler-freeze-'));
    temporaryRoots.push(dir);
    const staged = await materializeFrozenSkillPackage({ frozen, cwd: dir });
    const compilerRoot = path.join(dir, staged[0]!);
    const importFromStdin = exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '-'], { cwd: dir });
    importFromStdin.child.stdin!.end(`const { compose } = await import(${JSON.stringify(pathToFileURL(path.join(compilerRoot, 'scripts/compose.ts')).href)}); console.log(typeof compose);`);
    expect((await importFromStdin).stdout.trim()).toBe('function');
    const assetDir = path.join(dir, 'approved-media');
    await mkdir(assetDir);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN3cAAAAASUVORK5CYII=', 'base64');
    await writeFile(path.join(assetDir, 'service-garden-hero.png'), png);
    const output = path.join(dir, 'candidate');
    const { stdout } = await exec(process.execPath, [
      '--experimental-strip-types', path.join(compilerRoot, 'scripts/compose.ts'),
      '--input', path.join(compilerRoot, 'scripts/fixtures/service.json'),
      '--assets', assetDir, '--out-dir', output, '--entry', 'site-r1.html',
    ], { cwd: dir });
    const result = JSON.parse(stdout);
    expect(await readFile(result.entry, 'utf8')).toContain('data-od-id="site-name"');
    const manifest = JSON.parse(await readFile(result.manifest, 'utf8'));
    expect(manifest.sourceSkillId).toBe('agency-site');
    expect(manifest.supportingFiles).toEqual(['assets/agency-site/r1/service-garden-hero.png']);
    expect(await readFile(path.join(output, manifest.supportingFiles[0]))).toEqual(png);
    expect(frozen.selections.find((selection) => selection.canonicalId === 'agency-site')!.files
      .some((file) => file.path === 'assets/service-garden-hero.png')).toBe(false);
    const primary = frozen.selections.find((selection) => selection.canonicalId === 'agency-site')!;
    expect(primary.files.length).toBeLessThanOrEqual(32);
    expect(primary.files.some((file) => file.path.endsWith('recipe.schema.json'))).toBe(false);
    const catalogFiles = [
      'scripts/catalog-block.ts',
      'scripts/catalog/components/scroll-reveal/styles.css',
      'scripts/catalog/components/scroll-reveal/auto.js',
    ];
    const frozenPaths = primary.files.map((file) => file.path);
    for (const file of catalogFiles) {
      expect(frozenPaths, `the frozen agency-site package must carry ${file}`).toContain(file);
    }
    const packageBytes = frozen.selections.reduce((total, selection) => total + selection.bodyByteLength + selection.files.reduce((sum, file) => sum + file.byteLength, 0), 0);
    expect(
      MAX_PACKAGE_BYTES - packageBytes,
      `frozen package is ${packageBytes} bytes; keep at least 256 KiB under MAX_PACKAGE_BYTES (${MAX_PACKAGE_BYTES})`,
    ).toBeGreaterThanOrEqual(256 * 1024);

  });

  it.each(references)('does not discover or freeze the removed $id study', async ({ id }) => {
    const skills = await listSkills([path.join(root, 'skills'), path.join(root, 'design-templates')]);
    expect(skills.find((skill) => skill.id === id)).toBeUndefined();
    const frozen = await captureOdNextSessionSkillPackage({
      metadata: { kind: 'prototype' },
      getLocalPluginBySource: undefined,
      selection: { skillId: 'agency-site', skillIds: [id] },
      listSkillCatalog: async () => skills,
    });
    expect(frozen.selections.map((selection) => selection.canonicalId)).toEqual(['agency-site']);
    expect(resolveFrozenSkillBundleBodies(frozen)?.skillNames).toEqual(['agency-site']);
  });
});
