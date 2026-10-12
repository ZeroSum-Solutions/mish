// Pets and prompt templates a pack provides are scanned next to the bundled ones.

import { promises as fsp } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { listCodexPets, readCodexPetSpritesheet } from '../../src/codex-pets.js';
import { listPromptTemplates } from '../../src/media/prompt-templates.js';
import { packResourcePaths, resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore } from '../../src/mish-packs/store.js';
import { cleanupDirs, tempDir, writeFile, writeFixturePack } from './pack-fixture.js';

let dataDir: string;
let previousCodexHome: string | undefined;

beforeEach(() => {
  dataDir = tempDir('mish-data-');
  previousCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = path.join(tempDir('codex-home-'));
});

afterEach(async () => {
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('pack assets', () => {
  it('lists pack pets next to the bundled ones and serves their spritesheet', async () => {
    const store = createMishPackStore({ dataDir, userRoots: { skills: path.join(dataDir, 's'), designSystems: path.join(dataDir, 'd') }, env: {} });
    await store.start();
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { assets: { pets: 'pets', promptTemplates: 'prompts' } } });
    writeFile(source, 'pets/pack-pet/pet.json', JSON.stringify({ displayName: 'Pack Pet' }));
    writeFile(source, 'pets/pack-pet/spritesheet.webp', 'sprite');
    writeFile(source, 'prompts/image/pack-prompt.json', JSON.stringify({
      id: 'pack-prompt', surface: 'image', title: 'Pack prompt', prompt: 'A long enough prompt for the validator to accept it.',
      source: { repo: 'owned/test', license: 'owned' },
    }));
    await store.install(source);

    const bundled = tempDir('bundled-pets-');
    const pets = await listCodexPets({ bundledRoot: bundled, extraBundledRoots: packResourcePaths('pets') });
    expect(pets.pets.map((pet) => pet.id)).toEqual(['pack-pet']);
    expect(pets.pets[0]).toMatchObject({ displayName: 'Pack Pet', bundled: true });
    const sheet = await readCodexPetSpritesheet('pack-pet', { bundledRoot: bundled, extraBundledRoots: packResourcePaths('pets') });
    expect(sheet?.ext).toBe('webp');
    // The id is sanitised, so a path can never climb out of a pet root.
    expect(await readCodexPetSpritesheet('../../etc', { extraBundledRoots: packResourcePaths('pets') })).toBeNull();
    // Without the pack's root the pet is not found.
    expect((await listCodexPets({ bundledRoot: bundled })).pets).toEqual([]);

    const [root] = packResourcePaths('promptTemplates');
    expect((await listPromptTemplates(root!)).map((template) => template.id)).toEqual(['pack-prompt']);
  });
});
