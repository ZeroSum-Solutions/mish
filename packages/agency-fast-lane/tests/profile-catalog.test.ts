/**
 * `scripts/profile-catalog.ts`'s pure, exported helpers. The load-bearing property under test is
 * `describeFailure`'s safety: a Jev 4xx can echo request content back (including
 * `state.text`, which may be licence-restricted `original_text` for a catalog-sourced profile),
 * and this script logs and writes failures via `describeFailure` alone — so that function must
 * never be able to carry the response body through, end to end, from a real `createJevProfiler`
 * failure.
 */

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createJevProfiler, ProfileError, type DesignProfile } from '../src/profile.ts';
import {
  CATALOG_PREVIEW_PROJECTION,
  countBy,
  describeFailure,
  hydratePreviewMeta,
  hydratePreviewsFromCatalog,
  inferMotionLevel,
  previewFromMeta,
  qualityTotal,
  rowFromProfile,
  runnerUpSkin,
  topLabels,
} from '../scripts/profile-catalog.ts';
import { loadAtlasData } from './routing-fixture.ts';
import { loadDesignTaxonomy } from '../src/taxonomy.ts';
import type { JsonObject } from '../src/spine.ts';

const { atlas, registry } = await loadAtlasData();
const taxonomy = await loadDesignTaxonomy();

function judgment(choice: string, probabilities: Record<string, number> = { [choice]: 1 }) {
  return { choice, confidence: 1, probabilities };
}

function zeroed(ids: string[]): Record<string, number> {
  return Object.fromEntries(ids.map((id) => [id, 0]));
}

function fixtureProfile(overrides: Partial<DesignProfile> = {}): DesignProfile {
  const base: DesignProfile = {
    schema: 'design-profile/1',
    taxonomy: taxonomy.version,
    model: 'jev-1.13.0',
    at: '2026-09-19T00:00:00.000Z',
    ms: 100,
    calls: 1,
    source: { kind: 'prompt', id: 'x', title: 'X', chars: 10, digest: 'digest-x' },
    route: {
      spine: judgment('TL'),
      skin: judgment('Cinematic and immersive', { 'Cinematic and immersive': 0.9, Editorial: 0.05, Luxury: 0.05 }),
      format: judgment('Landing page'),
      action: judgment('contact'),
      family: judgment('ownedsite'),
      resolved: { archetypeId: 'TL.04', familyId: 'ownedsite', basis: 'exact', transfer: 3 },
    },
    sections: zeroed(taxonomy.sections.map((s) => s.id)),
    components: zeroed(taxonomy.components.map((c) => c.id)),
    mechanics: zeroed(taxonomy.mechanics.map((m) => m.id)),
    depth: zeroed(taxonomy.depth.map((d) => d.id)),
    style: {
      ground: judgment('near-black'),
      accent: judgment('one-held'),
      typography: judgment('grotesk-only'),
      imagery: judgment('photography'),
      topology: judgment('centered-object-on-void'),
      density: judgment('airy'),
    },
    quality: Object.fromEntries(taxonomy.quality.map((q) => [q.id, { score: 2, legend: q.levels[2]!, confidence: 0.8 }])),
    truthRisk: 0.1,
  };
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// describeFailure: never leaks Jev's response body, end to end through a real failure
// ---------------------------------------------------------------------------

type Captured = { body: JsonObject };

test('describeFailure: a real createJevProfiler failure whose body echoes state.text never surfaces the sentinel', async () => {
  const sentinel = 'SENTINEL-CATALOG-ORIGINAL-TEXT-DO-NOT-LEAK-42';
  const fetchImpl = (async (_input, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as JsonObject;
    const state = body.state as JsonObject;
    // Simulate a Jev 4xx that echoes the request's own state back in its error body.
    return new Response(`invalid request: ${JSON.stringify(state)}`, { status: 400 });
  }) as typeof fetch;
  const profiler = createJevProfiler({ apiKey: 'k', fetchImpl });

  let caught: unknown;
  try {
    await profiler.profile({ text: sentinel, atlas, registry, taxonomy, source: { kind: 'prompt', id: 'catalog-entry-7' } });
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof ProfileError, 'the profiler throws ProfileError on a 4xx');

  const described = describeFailure('catalog-entry-7', caught, 2);
  assert.ok(!described.includes(sentinel), `describeFailure output must not contain the sentinel: ${described}`);
  assert.equal(described, 'catalog-entry-7: jev 400 (after 2 attempt(s))');
});

test('describeFailure: a non-Error value still formats without throwing', () => {
  assert.equal(describeFailure('x', 'plain string failure', 1), 'x: plain string failure (after 1 attempt(s))');
});

// ---------------------------------------------------------------------------
// Other report helpers: light correctness coverage
// ---------------------------------------------------------------------------

test('rowFromProfile: reconstructs the report row fields from source/meta alone (the --from-profiles path)', () => {
  const profile = fixtureProfile({
    source: { kind: 'prompt', id: 'p1', title: 'Prompt One', chars: 5, digest: 'd' },
    meta: { total_likes: 305, catalog_action: 'signup', motion_level: 'motion-led', slot: 'full-page' },
  });
  const row = rowFromProfile(profile);
  assert.deepEqual(row, { id: 'p1', title: 'Prompt One', total_likes: 305, action: 'signup', motion_level: 'motion-led', slot: 'full-page' });
});

test('rowFromProfile: missing meta fields fall back to null/0/empty rather than throwing', () => {
  const profile = fixtureProfile({ source: { kind: 'prompt', chars: 5, digest: 'd' } });
  const row = rowFromProfile(profile);
  assert.deepEqual(row, { id: '(unknown)', title: '', total_likes: 0, action: null, motion_level: null, slot: null });
});

test('inferMotionLevel: a component-3d profile infers webgl-3d regardless of mechanics', () => {
  const profile = fixtureProfile({ components: { ...zeroed(taxonomy.components.map((c) => c.id)), '3d-canvas-webgl': 0.9 } });
  assert.equal(inferMotionLevel(profile), 'webgl-3d');
});

test('inferMotionLevel: static-only mechanic infers static', () => {
  const profile = fixtureProfile({ mechanics: { ...zeroed(taxonomy.mechanics.map((m) => m.id)), 'static-only': 0.95 } });
  assert.equal(inferMotionLevel(profile), 'static');
});

test('inferMotionLevel: a strong active mechanic (parallax) infers motion-led', () => {
  const profile = fixtureProfile({ mechanics: { ...zeroed(taxonomy.mechanics.map((m) => m.id)), parallax: 0.8 } });
  assert.equal(inferMotionLevel(profile), 'motion-led');
});

test('inferMotionLevel: no mechanics at all infers static', () => {
  assert.equal(inferMotionLevel(fixtureProfile()), 'static');
});

test('topLabels: filters at the given threshold and sorts by descending probability', () => {
  const record = { a: 0.9, b: 0.5, c: 0.71, d: 0.3 };
  assert.equal(topLabels(record, 0.7), 'a, c');
});

test('topLabels: no labels clear the threshold returns "(none)"', () => {
  assert.equal(topLabels({ a: 0.1 }, 0.7), '(none)');
});

test('qualityTotal: sums every quality dimension\'s score', () => {
  const profile = fixtureProfile({ quality: Object.fromEntries(taxonomy.quality.map((q) => [q.id, { score: 3, legend: q.levels[3]!, confidence: 0.5 }])) });
  assert.equal(qualityTotal(profile), taxonomy.quality.length * 3);
});

test('previewFromMeta: returns the stored preview path, or "(none)" when absent', () => {
  assert.equal(previewFromMeta(fixtureProfile({ meta: { preview: 'media/image/x.png' } })), 'media/image/x.png');
  assert.equal(previewFromMeta(fixtureProfile()), '(none)');
});

test('runnerUpSkin: the second-highest probability option, excluding the chosen one', () => {
  const skin = judgment('Cinematic and immersive', { 'Cinematic and immersive': 0.9, Editorial: 0.07, Luxury: 0.03 });
  assert.equal(runnerUpSkin(skin), 'Editorial (0.07)');
});

test('runnerUpSkin: no other options returns "(none)"', () => {
  assert.equal(runnerUpSkin(judgment('Cinematic and immersive', { 'Cinematic and immersive': 1 })), '(none)');
});

test('countBy: counts items by a key function', () => {
  const counts = countBy(['a', 'b', 'a', 'c', 'a'], (x) => x);
  assert.equal(counts.get('a'), 3);
  assert.equal(counts.get('b'), 1);
  assert.equal(counts.get('c'), 1);
});

// ---------------------------------------------------------------------------
// --hydrate-previews-from-catalog: meta only, and never the licence-restricted text
// ---------------------------------------------------------------------------

/** Everything a profile carries except `meta` — the half the hydration must leave alone. */
function withoutMeta(profile: DesignProfile): Omit<DesignProfile, 'meta'> {
  const { meta: _meta, ...rest } = profile;
  return rest;
}

const PREVIEW_ROW = { id: 'urban-jungle-hero', image_preview_url: 'https://cdn.test/urban.jpg', video_preview_url: 'https://cdn.test/urban.mp4' };

/**
 * Copies everything the two streams are asked to write while `run` is running, and still writes
 * it through, so the test runner's own output is not swallowed. Used to prove the hydration's
 * console output carries no catalog text.
 */
type Writable = { write: (...args: unknown[]) => boolean };

async function captureOutput<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const chunks: string[] = [];
  const streams = [process.stdout, process.stderr] as unknown as Writable[];
  const originals = streams.map((stream) => stream.write);
  streams.forEach((stream, at) => {
    const original = originals[at]!;
    stream.write = (...args: unknown[]) => {
      chunks.push(String(args[0]));
      return original.apply(stream, args);
    };
  });
  try {
    return { result: await run(), output: chunks.join('') };
  } finally {
    streams.forEach((stream, at) => {
      stream.write = originals[at]!;
    });
  }
}

test('hydratePreviewMeta: a profile with no catalog row is returned exactly as it was', () => {
  const profile = fixtureProfile({ meta: { total_likes: 7 } });
  assert.strictEqual(hydratePreviewMeta(profile, undefined), profile);
});

test('hydratePreviewMeta: an empty catalog column clears a previously hydrated URL', () => {
  const profile = fixtureProfile({ meta: { previewImage: 'https://cdn.test/old.jpg', total_likes: 7 } });
  const hydrated = hydratePreviewMeta(profile, { id: 'x', image_preview_url: '', video_preview_url: null });
  assert.deepStrictEqual(hydrated.meta, { total_likes: 7, catalogId: 'x' });
});

test('hydratePreviewMeta: a catalog value that is not a public preview URL is cleared, not written', () => {
  const profile = fixtureProfile({ meta: { previewImage: 'https://cdn.test/old.jpg', total_likes: 7 } });
  const hydrated = hydratePreviewMeta(profile, {
    id: 'x',
    image_preview_url: 'http://cdn.test/insecure.jpg',
    video_preview_url: 'media/relative.mp4',
  });
  assert.deepStrictEqual(hydrated.meta, { total_likes: 7, catalogId: 'x' });
});

// ---------------------------------------------------------------------------
// The hydration SELECT: the forbidden columns are never named, let alone read
// ---------------------------------------------------------------------------

test('the hydration projection names exactly the three permitted columns', () => {
  assert.equal(CATALOG_PREVIEW_PROJECTION, 'id, image_preview_url, video_preview_url');
  // Pinned as a list too, so a `SELECT *` or a fourth column cannot slip in past the string.
  assert.deepStrictEqual(
    CATALOG_PREVIEW_PROJECTION.split(',').map((column) => column.trim()),
    ['id', 'image_preview_url', 'video_preview_url'],
  );
});

test('--hydrate-previews-from-catalog: writes the preview URLs into meta and touches nothing else', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-catalog-hydrate-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    await mkdir(profilesDir);

    const withUrls = fixtureProfile({
      source: { kind: 'prompt', id: 'urban-jungle-hero', title: 'Urban Jungle', chars: 10, digest: 'digest-urban' },
      meta: { total_likes: 91, preview: 'assets/urban.png' },
    });
    const withoutUrls = fixtureProfile({
      source: { kind: 'prompt', id: 'vortex-studio-hero', title: 'Vortex Studio', chars: 10, digest: 'digest-vortex' },
      meta: { total_likes: 40 },
    });

    const indexFile = path.join(root, 'design-index.json');
    await writeFile(indexFile, `${JSON.stringify({ schema: 'design-index/1', profiles: [withUrls, withoutUrls] }, null, 2)}\n`);
    for (const profile of [withUrls, withoutUrls]) {
      await writeFile(path.join(profilesDir, `${profile.source.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);
    }

    // A catalog of the shape this mode reads, including the two text columns it must never touch.
    const sentinel = 'SENTINEL-ORIGINAL-TEXT-DO-NOT-LEAK-17';
    const catalogDb = path.join(root, 'catalog.db');
    const db = new DatabaseSync(catalogDb);
    db.exec('CREATE TABLE prompts (id TEXT PRIMARY KEY, image_preview_url TEXT, video_preview_url TEXT, original_text TEXT, our_text TEXT)');
    const insert = db.prepare('INSERT INTO prompts (id, image_preview_url, video_preview_url, original_text, our_text) VALUES (?, ?, ?, ?, ?)');
    insert.run(PREVIEW_ROW.id, PREVIEW_ROW.image_preview_url, PREVIEW_ROW.video_preview_url, sentinel, sentinel);
    insert.run('vortex-studio-hero', '', null, sentinel, sentinel);
    db.close();

    const { result: counts, output } = await captureOutput(() => hydratePreviewsFromCatalog(indexFile, catalogDb));
    assert.deepStrictEqual(counts, { profiles: 2, previewImage: 1, previewVideo: 1, neither: 1, rejected: 0, unmatched: [] });
    // Not merely absent from the files: the run's own stdout/stderr never carried it either.
    assert.ok(!output.includes(sentinel), 'the hydration must never print the catalog text');

    const rewrittenIndex = await readFile(indexFile, 'utf8');
    const index = JSON.parse(rewrittenIndex) as { profiles: DesignProfile[] };
    assert.deepStrictEqual(index.profiles.map((profile) => profile.source.id), ['urban-jungle-hero', 'vortex-studio-hero']);

    const [hydrated, unhydrated] = index.profiles as [DesignProfile, DesignProfile];
    assert.deepStrictEqual(hydrated.meta, {
      total_likes: 91,
      preview: 'assets/urban.png',
      previewImage: PREVIEW_ROW.image_preview_url,
      previewVideo: PREVIEW_ROW.video_preview_url,
      catalogId: 'urban-jungle-hero',
    });
    // The row with no URLs gains the catalog id and nothing else.
    assert.deepStrictEqual(unhydrated.meta, { total_likes: 40, catalogId: 'vortex-studio-hero' });

    // The git-diff-style check: outside `meta`, both profiles are the objects they were.
    assert.deepStrictEqual(withoutMeta(hydrated), withoutMeta(withUrls));
    assert.deepStrictEqual(withoutMeta(unhydrated), withoutMeta(withoutUrls));

    // The per-profile files carry the same profiles, and no catalog text reached either output.
    for (const profile of index.profiles) {
      const onDisk = await readFile(path.join(profilesDir, `${profile.source.id}.json`), 'utf8');
      assert.deepStrictEqual(JSON.parse(onDisk), profile);
      assert.ok(!onDisk.includes(sentinel), 'a profile file must never carry the catalog text');
    }
    assert.ok(!rewrittenIndex.includes(sentinel), 'the index must never carry the catalog text');

    // Running it again is a no-op: the mode is a function of the profile and its catalog row.
    await hydratePreviewsFromCatalog(indexFile, catalogDb);
    assert.equal(await readFile(indexFile, 'utf8'), rewrittenIndex);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('--hydrate-previews-from-catalog: an http: catalog URL is not written, and is counted as rejected', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'profile-catalog-hydrate-http-'));
  try {
    const profilesDir = path.join(root, 'profiles');
    await mkdir(profilesDir);

    const profile = fixtureProfile({
      source: { kind: 'prompt', id: 'insecure-hero', title: 'Insecure', chars: 10, digest: 'digest-insecure' },
      meta: { total_likes: 12 },
    });
    const indexFile = path.join(root, 'design-index.json');
    await writeFile(indexFile, `${JSON.stringify({ schema: 'design-index/1', profiles: [profile] }, null, 2)}\n`);
    await writeFile(path.join(profilesDir, `${profile.source.id}.json`), `${JSON.stringify(profile, null, 2)}\n`);

    const catalogDb = path.join(root, 'catalog.db');
    const db = new DatabaseSync(catalogDb);
    db.exec('CREATE TABLE prompts (id TEXT PRIMARY KEY, image_preview_url TEXT, video_preview_url TEXT, original_text TEXT, our_text TEXT)');
    db.prepare('INSERT INTO prompts (id, image_preview_url, video_preview_url, original_text, our_text) VALUES (?, ?, ?, ?, ?)')
      // An http: image and a relative video: the daemon parser refuses both, so hydration must too.
      .run('insecure-hero', 'http://cdn.test/insecure.jpg', 'media/relative.mp4', 'x', 'x');
    db.close();

    const counts = await hydratePreviewsFromCatalog(indexFile, catalogDb);
    assert.deepStrictEqual(counts, { profiles: 1, previewImage: 0, previewVideo: 0, neither: 1, rejected: 2, unmatched: [] });

    const written = await readFile(indexFile, 'utf8');
    assert.ok(!written.includes('http://cdn.test/insecure.jpg'), 'an http: URL must never be written into the index');
    assert.ok(!written.includes('media/relative.mp4'), 'a relative URL must never be written into the index');
    const [hydrated] = (JSON.parse(written) as { profiles: DesignProfile[] }).profiles as [DesignProfile];
    assert.deepStrictEqual(hydrated.meta, { total_likes: 12, catalogId: 'insecure-hero' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
