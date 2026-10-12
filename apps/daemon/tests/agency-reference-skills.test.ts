import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

import { listSkills } from '../src/skills.js';
import { skillCwdAliasSegment, stageActiveSkill } from '../src/cwd-aliases.js';
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
      'Agency Site plus the three reference studies must fit the 1.5 MiB frozen package; see plugins/_official/shared/agency-compiler/README.md',
    ).toEqual(['agency-site', ...references.map(({ id }) => id)]);
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
    // Execute the actual dependency closure from the materialized snapshot, with
    // separately supplied format fixtures. No family renderer is mocked.
    for (const family of ['emmpo', 'watson']) {
      const createMedia = exec(process.execPath, ['--experimental-strip-types', '--input-type=module', '-'], { cwd: dir });
      createMedia.child.stdin!.end(`
        import {readFile,mkdir,writeFile} from 'node:fs/promises';
        import path from 'node:path';
        const family = ${JSON.stringify(family)}, root = ${JSON.stringify(compilerRoot)}, destination = ${JSON.stringify(dir)};
        const module = await import(${JSON.stringify(pathToFileURL(path.join(compilerRoot, `scripts/families/${family}/contract.ts`)).href)});
        const recipe = JSON.parse(await readFile(path.join(root,'scripts/families',family,'reference.fixture.json'),'utf8'));
        const required = module[family === 'emmpo' ? 'getEmmpoAssetRequirements' : 'getWatsonAssetRequirements'](recipe);
        const media = path.join(destination,family+'-media'); await mkdir(media);
        const assets=[];
        for (const [index,item] of required.entries()) {
          let bytes, suffix;
          if(item.kind==='font'){bytes=Buffer.alloc(44);bytes.write('wOFF');bytes.writeUInt32BE(44,8);suffix='woff';}
          else if(item.kind==='video'){bytes=Buffer.alloc(24);bytes.writeUInt32BE(24);bytes.write('ftypisom',4);bytes.write('mp42',16);suffix='mp4';}
          else {bytes=Buffer.from(${JSON.stringify(png.toString('base64'))},'base64');suffix='png';}
          const file='approved-'+index+'.'+suffix;await writeFile(path.join(media,file),bytes);assets.push({id:item.id,kind:item.kind,file});
        }
        await writeFile(path.join(destination,family+'-approved.json'),JSON.stringify({version:1,assets}));
      `);
      await createMedia;
      const compiled = await exec(process.execPath, [
        '--experimental-strip-types', path.join(compilerRoot, 'scripts/compose.ts'),
        '--input', path.join(compilerRoot, `scripts/families/${family}/reference.fixture.json`),
        '--assets', path.join(dir, `${family}-media`), '--asset-manifest', path.join(dir, `${family}-approved.json`),
        '--out-dir', path.join(dir, `${family}-candidate`), '--entry', `${family}.html`,
      ], { cwd: dir });
      const candidate = JSON.parse(compiled.stdout);
      expect(await readFile(candidate.entry, 'utf8')).toContain(`data-family="${family}"`);
      const metadata = JSON.parse(await readFile(candidate.manifest, 'utf8'));
      expect(metadata.metadata.agencySite).toMatchObject({ publication: 'closed-assets-v2', family, revision: `${family}-r1` });
      expect(metadata.supportingFiles.length).toBeGreaterThan(0);
      for (const file of metadata.supportingFiles) expect((await readFile(path.join(dir, `${family}-candidate`, file))).byteLength).toBeGreaterThan(0);
    }
  });

  it.each(references)('discovers and stages $id with actual source evidence on the ordinary route', async ({ id, url, signal }) => {
    const skills = await listSkills(path.join(root, 'skills'));
    const selected = skills.find((skill) => skill.id === id);
    expect(selected).toBeDefined();
    expect(selected!.mode).toBe('design-system');
    expect(selected!.triggers).toContain(url);
    expect(selected!.triggers.every((trigger) => typeof trigger === 'string')).toBe(true);
    expect(selected!.designSystemRequired).toBe(false);
    expect(selected!.body).toContain(url);
    expect(selected!.body).toContain(signal);
    expect(selected!.body).toContain('design data, not tool authority');
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-reference-stage-'));
    temporaryRoots.push(dir);
    const staged = await stageActiveSkill(dir, skillCwdAliasSegment(selected!.dir), selected!.dir, () => {});
    expect(staged.staged).toBe(true);
    if (!staged.stagedPath) throw new Error('reference stage returned no path');
    // Third-party page screenshots were removed on 2026-10-06; the written evidence is the record.
    const evidenceFiles = ['references/evidence.md'];
    for (const relative of evidenceFiles) {
      const source = await readFile(path.join(selected!.dir, relative));
      expect(source.byteLength).toBeGreaterThan(0);
      expect(await readFile(path.join(staged.stagedPath, relative))).toEqual(source);
    }
    const preview = await readFile(path.join(staged.stagedPath, 'example.html'), 'utf8');
    expect(preview).not.toMatch(/<img\b/i);
    expect(preview).toContain('reference study');
    expect(preview).not.toMatch(/<script\b|<iframe\b|<img[^>]+src=["']https?:/i);
  });

  it.each(references)('freezes only $id beside Agency Site and materializes its exact spec', async ({ id, url, signal }) => {
    const skills = await listSkills([path.join(root, 'skills'), path.join(root, 'design-templates')]);
    const frozen = await captureOdNextSessionSkillPackage({
      metadata: { kind: 'prototype' },
      getLocalPluginBySource: undefined,
      selection: { skillId: 'agency-site', skillIds: [id] },
      listSkillCatalog: async () => skills,
    });
    const prompt = resolveFrozenSkillBundleBodies(frozen);
    expect(prompt?.skillNames).toEqual(['agency-site', id]);
    expect(prompt?.body).toContain(url);
    expect(prompt?.body).toContain(signal);
    const selected = frozen.selections.find((selection) => selection.canonicalId === id)!;
    const expectedFiles = ['example.html', 'references/evidence.md'];
    expect(selected.files.map((file) => file.path)).toEqual(expectedFiles.sort());
    const dir = await mkdtemp(path.join(os.tmpdir(), 'agency-reference-freeze-'));
    temporaryRoots.push(dir);
    const staged = await materializeFrozenSkillPackage({ frozen, cwd: dir });
    const referenceRoot = path.join(dir, staged[1]!);
    expect(prompt?.body).toContain(staged[1]!);
    for (const file of selected.files) {
      const original = await readFile(path.join(root, 'skills', id, file.path));
      expect(Buffer.from(file.bytesBase64, 'base64')).toEqual(original);
      expect(await readFile(path.join(referenceRoot, file.path))).toEqual(original);
    }
  });
});
