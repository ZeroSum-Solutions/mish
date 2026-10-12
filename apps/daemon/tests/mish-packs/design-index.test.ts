// Mish packs: design-index profiles a pack carries are served next to the person's own index, read
// in place, never written into it, and gone again when the pack is removed. Fixtures are invented.

import { promises as fsp, readFileSync } from 'node:fs';
import path from 'node:path';

import type { DesignJudgment, DesignProfile } from '@mish/contracts';
import { loadDesignTaxonomy } from '@mish/agency-fast-lane/taxonomy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDesignIndexStore } from '../../src/design-index-store.js';
import { packDesignIndexProfiles, resetMishPacksForTests } from '../../src/mish-packs/overlay.js';
import { createMishPackStore, type MishPackStore } from '../../src/mish-packs/store.js';
import { cleanupDirs, tempDir, writeFile, writeFixturePack } from './pack-fixture.js';

const taxonomy = await loadDesignTaxonomy();

function judgment(choice: string): DesignJudgment {
  return { choice, confidence: 0.9, probabilities: { [choice]: 0.9 } };
}

function profile(digest: string, title: string, at = '2026-09-01T00:00:00.000Z'): DesignProfile {
  return {
    schema: 'design-profile/1',
    taxonomy: '1.0',
    model: 'jev-1.13.0',
    at,
    ms: 620,
    calls: 1,
    source: { kind: 'prompt', id: digest, title, chars: 12, digest },
    route: { spine: judgment('TL'), skin: judgment('Editorial'), format: judgment('Landing page'), action: judgment('contact'), family: judgment('none'), resolved: {} },
    sections: { hero: 0.9 },
    components: {},
    mechanics: {},
    depth: {},
    style: {
      ground: judgment('near-black'), accent: judgment('unspecified'), typography: judgment('unspecified'),
      imagery: judgment('unspecified'), topology: judgment('bento-grid'), density: judgment('unspecified'),
    },
    quality: { 'focal-discipline': { score: 3, legend: 'good', confidence: 0.8 } },
    truthRisk: 0.1,
  };
}

let dataDir: string;
let store: MishPackStore;

beforeEach(async () => {
  dataDir = tempDir('mish-data-');
  store = createMishPackStore({ dataDir, userRoots: { skills: path.join(dataDir, 'skills'), designSystems: path.join(dataDir, 'ds') }, env: {} });
  await store.start();
});

afterEach(async () => {
  resetMishPacksForTests();
  await Promise.all(cleanupDirs.splice(0).map((dir) => fsp.rm(dir, { recursive: true, force: true })));
});

describe('design index profiles from a pack', () => {
  it('are listed, found and read next to the person\'s own, and never written into their file', async () => {
    const indexFile = path.join(dataDir, 'design-index', 'index.json');
    const index = createDesignIndexStore(indexFile, { extraProfiles: packDesignIndexProfiles });
    await fsp.mkdir(path.dirname(indexFile), { recursive: true });
    await index.add(profile('d-mine', 'Mine', '2026-09-03T00:00:00.000Z'));
    expect((await index.list(10)).total).toBe(1);

    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { designIndex: 'design-index' } });
    writeFile(source, 'design-index/index.json', JSON.stringify({
      schema: 'design-index/1',
      profiles: [profile('d-pack-1', 'Pack one'), profile('d-pack-2', 'Pack two', '2026-09-02T00:00:00.000Z'), profile('d-mine', 'Duplicate of mine')],
    }));
    const { pack } = await store.install(source);
    expect(pack.provides).toEqual(expect.arrayContaining([{ resource: 'designIndex', items: null }]));

    const listed = await index.list(10);
    expect(listed.total).toBe(3);
    expect(listed.profiles.map((entry) => entry.source.digest)).toEqual(['d-mine', 'd-pack-2', 'd-pack-1']);
    // The person's own profile wins over a pack profile with the same digest.
    expect((await index.get('d-mine'))?.source.title).toBe('Mine');
    expect((await index.get('d-pack-1'))?.source.title).toBe('Pack one');
    const found = await index.find({ sections: ['hero'] }, taxonomy, 10);
    expect(found.total).toBe(3);

    // A pack profile cannot be removed through the index, and is never copied into its file.
    expect(await index.remove('d-pack-1')).toEqual({ removed: false, total: 1 });
    await index.add(profile('d-new', 'New'));
    const onDisk = JSON.parse(readFileSync(indexFile, 'utf8')) as { profiles: Array<{ source: { digest: string } }> };
    expect(onDisk.profiles.map((entry) => entry.source.digest).sort()).toEqual(['d-mine', 'd-new']);

    await store.remove('team-kit');
    expect(packDesignIndexProfiles()).toEqual([]);
    expect((await index.list(10)).profiles.map((entry) => entry.source.digest).sort()).toEqual(['d-mine', 'd-new']);
  });

  it('refuses a pack whose design index folder has no index.json', async () => {
    const source = tempDir('mish-src-');
    writeFixturePack(source, { provides: { designIndex: 'design-index' } });
    writeFile(source, 'design-index/readme.txt', 'no index here');
    await expect(store.install(source)).rejects.toMatchObject({ code: 'MISSING_RESOURCE' });
  });
});
