/**
 * `DesignIndex`: read/write, `addProfile` (dedupe by digest — re-adding an unchanged profile
 * replaces, not duplicates), and `findProfiles` (single and combined filters, `--min`, ranking,
 * unknown-label validation against the taxonomy).
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  addProfile,
  emptyDesignIndex,
  findProfiles,
  loadDesignIndex,
  saveDesignIndex,
  type DesignIndex,
  type FindQuery,
} from '../src/design-index.ts';
import type { DesignProfile } from '../src/profile.ts';
import { loadDesignTaxonomy } from '../src/taxonomy.ts';

const taxonomy = await loadDesignTaxonomy();

function zeroed<T extends string>(ids: readonly T[]): Record<T, number> {
  return Object.fromEntries(ids.map((id) => [id, 0])) as Record<T, number>;
}

function judgment(choice: string, probabilities: Record<string, number> = { [choice]: 1 }) {
  return { choice, confidence: 1, probabilities };
}

/** A minimal, schema-complete profile fixture, with the given overrides layered on top. */
function fixtureProfile(overrides: Partial<DesignProfile> & { id: string }): DesignProfile {
  const { id, ...rest } = overrides;
  const sectionIds = taxonomy.sections.map((s) => s.id);
  const componentIds = taxonomy.components.map((c) => c.id);
  const mechanicIds = taxonomy.mechanics.map((m) => m.id);
  const depthIds = taxonomy.depth.map((d) => d.id);
  const base: DesignProfile = {
    schema: 'design-profile/1',
    taxonomy: taxonomy.version,
    model: 'jev-1.13.0',
    at: '2026-09-19T00:00:00.000Z',
    ms: 100,
    calls: 1,
    source: { kind: 'prompt', id, title: `Title for ${id}`, chars: 100, digest: `digest-${id}` },
    route: {
      spine: judgment('TL'),
      archetype: judgment('TL.04'),
      skin: judgment('Minimal and quiet'),
      format: judgment('Landing page'),
      action: judgment('contact'),
      family: judgment('ownedsite'),
      resolved: { archetypeId: 'TL.04', familyId: 'ownedsite', basis: 'exact', transfer: 3 },
    },
    sections: zeroed(sectionIds),
    components: zeroed(componentIds),
    mechanics: zeroed(mechanicIds),
    depth: zeroed(depthIds),
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
  return { ...base, ...rest };
}

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'design-index-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// read / write / addProfile
// ---------------------------------------------------------------------------

test('emptyDesignIndex has the schema and no profiles', () => {
  const index = emptyDesignIndex();
  assert.equal(index.schema, 'design-index/1');
  assert.deepEqual(index.profiles, []);
});

test('addProfile appends a new profile, keyed by its digest', () => {
  const index = emptyDesignIndex();
  const profile = fixtureProfile({ id: 'a' });
  const next = addProfile(index, profile);
  assert.equal(next.profiles.length, 1);
  assert.equal(next.profiles[0]!.source.id, 'a');
  assert.equal(index.profiles.length, 0, 'addProfile does not mutate its input');
});

test('addProfile replaces, not duplicates, when the digest is unchanged', () => {
  let index = emptyDesignIndex();
  index = addProfile(index, fixtureProfile({ id: 'a', truthRisk: 0.1 }));
  index = addProfile(index, fixtureProfile({ id: 'a', truthRisk: 0.9 }));
  assert.equal(index.profiles.length, 1);
  assert.equal(index.profiles[0]!.truthRisk, 0.9, 're-adding replaces with the newer profile');
});

test('addProfile keeps two profiles with different digests, even with the same source id', () => {
  let index = emptyDesignIndex();
  index = addProfile(index, fixtureProfile({ id: 'a', source: { ...fixtureProfile({ id: 'a' }).source, digest: 'digest-1' } }));
  index = addProfile(index, fixtureProfile({ id: 'a', source: { ...fixtureProfile({ id: 'a' }).source, digest: 'digest-2' } }));
  assert.equal(index.profiles.length, 2);
});

test('saveDesignIndex writes JSON that loadDesignIndex reads back byte-identical in content', async () => {
  await withTempDir(async (dir) => {
    const file = path.join(dir, 'design-index.json');
    let index = emptyDesignIndex();
    index = addProfile(index, fixtureProfile({ id: 'a' }));
    index = addProfile(index, fixtureProfile({ id: 'b' }));
    await saveDesignIndex(file, index);
    const loaded = await loadDesignIndex(file);
    assert.deepEqual(loaded, index);
    const raw = await readFile(file, 'utf8');
    assert.ok(raw.endsWith('\n'), 'the file ends with a trailing newline');
  });
});

test('loadDesignIndex on a missing file returns an empty index rather than throwing', async () => {
  await withTempDir(async (dir) => {
    const loaded = await loadDesignIndex(path.join(dir, 'does-not-exist.json'));
    assert.deepEqual(loaded, emptyDesignIndex());
  });
});

// ---------------------------------------------------------------------------
// findProfiles
// ---------------------------------------------------------------------------

function pricingHeavy(id: string, likes: number): DesignProfile {
  const profile = fixtureProfile({ id, meta: { total_likes: likes } });
  return {
    ...profile,
    sections: { ...profile.sections, pricing: 0.9, hero: 0.95 },
    components: { ...profile.components, 'marquee-ticker': 0.8 },
    mechanics: { ...profile.mechanics, 'velocity-linked': 0.7 },
    style: { ...profile.style, ground: judgment('near-black'), topology: judgment('centered-object-on-void') },
    route: { ...profile.route, skin: judgment('Technical and utilitarian') },
  };
}

function plain(id: string, likes: number): DesignProfile {
  const profile = fixtureProfile({ id, meta: { total_likes: likes } });
  return { ...profile, sections: { ...profile.sections, hero: 0.4 } };
}

test('findProfiles: a single section filter at the default --min 0.5', () => {
  const index: DesignIndex = { schema: 'design-index/1', profiles: [pricingHeavy('rich', 500), plain('poor', 10)] };
  const results = findProfiles(index.profiles, { sections: ['pricing'] }, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['rich']);
});

test('findProfiles: combined section + component + mechanic filters, all must clear --min', () => {
  const index: DesignIndex = { schema: 'design-index/1', profiles: [pricingHeavy('rich', 500), plain('poor', 10)] };
  const results = findProfiles(index.profiles, { sections: ['pricing'], components: ['marquee-ticker'], mechanics: ['velocity-linked'] }, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['rich']);
});

test('findProfiles: --min raises or lowers the bar', () => {
  const index: DesignIndex = { schema: 'design-index/1', profiles: [pricingHeavy('rich', 500)] };
  assert.equal(findProfiles(index.profiles, { sections: ['pricing'], min: 0.95 }, taxonomy).length, 0, '0.9 < 0.95');
  assert.equal(findProfiles(index.profiles, { sections: ['pricing'], min: 0.5 }, taxonomy).length, 1);
});

test('findProfiles: a Choice filter (skin) matches the chosen option', () => {
  const index: DesignIndex = { schema: 'design-index/1', profiles: [pricingHeavy('rich', 500), plain('poor', 10)] };
  const results = findProfiles(index.profiles, { skin: 'Technical and utilitarian' }, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['rich']);
});

test('findProfiles: results rank by the product of matched probabilities, then by meta.total_likes', () => {
  const index: DesignIndex = {
    schema: 'design-index/1',
    profiles: [
      { ...pricingHeavy('low-likes', 5), sections: { ...pricingHeavy('x', 0).sections, pricing: 0.9 } },
      { ...pricingHeavy('high-likes', 900), sections: { ...pricingHeavy('x', 0).sections, pricing: 0.9 } },
    ],
  };
  const results = findProfiles(index.profiles, { sections: ['pricing'] }, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['high-likes', 'low-likes'], 'equal probability product, higher likes first');
});

test('findProfiles: ranks a higher matched-probability product above a lower one regardless of likes', () => {
  const index: DesignIndex = {
    schema: 'design-index/1',
    profiles: [
      { ...pricingHeavy('lower-prob', 900), sections: { ...pricingHeavy('x', 0).sections, pricing: 0.6 } },
      { ...pricingHeavy('higher-prob', 5), sections: { ...pricingHeavy('x', 0).sections, pricing: 0.95 } },
    ],
  };
  const results = findProfiles(index.profiles, { sections: ['pricing'] }, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['higher-prob', 'lower-prob']);
});

test('findProfiles: --text matches a substring of the source title, case-insensitively', () => {
  const index: DesignIndex = {
    schema: 'design-index/1',
    profiles: [fixtureProfile({ id: 'a', source: { ...fixtureProfile({ id: 'a' }).source, title: 'Riverbend Dental' } })],
  };
  assert.equal(findProfiles(index.profiles, { text: 'riverbend' }, taxonomy).length, 1);
  assert.equal(findProfiles(index.profiles, { text: 'nomatch' }, taxonomy).length, 0);
});

test('findProfiles: --archetype, --family, --format, --action, and a style axis (--typography) combine and discriminate', () => {
  const matching = fixtureProfile({ id: 'match' });
  const different = {
    ...fixtureProfile({ id: 'different' }),
    route: {
      ...fixtureProfile({ id: 'different' }).route,
      archetype: judgment('BA.03'),
      family: judgment('ownedinstitution'),
      format: judgment('Authority site'),
      action: judgment('donate'),
    },
    style: { ...fixtureProfile({ id: 'different' }).style, typography: judgment('mono-technical') },
  };
  const index: DesignIndex = { schema: 'design-index/1', profiles: [matching, different] };
  const query: FindQuery = { archetype: 'TL.04', family: 'ownedsite', format: 'Landing page', action: 'contact', typography: 'grotesk-only' };
  const results = findProfiles(index.profiles, query, taxonomy);
  assert.deepEqual(results.map((p) => p.source.id), ['match']);
});

test('findProfiles: --limit caps the result count', () => {
  const index: DesignIndex = {
    schema: 'design-index/1',
    profiles: [pricingHeavy('a', 1), pricingHeavy('b', 2), pricingHeavy('c', 3)],
  };
  const results = findProfiles(index.profiles, { sections: ['pricing'], limit: 2 }, taxonomy);
  assert.equal(results.length, 2);
});

test('findProfiles: no matches returns an empty array, not an error', () => {
  const index: DesignIndex = { schema: 'design-index/1', profiles: [plain('poor', 10)] };
  const results = findProfiles(index.profiles, { sections: ['pricing'] }, taxonomy);
  assert.deepEqual(results, []);
});

test('findProfiles: an unknown section label throws, listing the valid ids', () => {
  const query: FindQuery = { sections: ['not-a-real-section'] };
  assert.throws(() => findProfiles([], query, taxonomy), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /not-a-real-section/);
    assert.match(error.message, /navigation/, 'lists a valid section id');
    return true;
  });
});

test('findProfiles: an unknown style axis value throws, listing the valid options', () => {
  assert.throws(() => findProfiles([], { ground: 'not-a-real-ground' }, taxonomy), /near-black/);
});
