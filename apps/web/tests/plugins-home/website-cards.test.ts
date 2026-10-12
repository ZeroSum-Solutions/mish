import { describe, expect, it } from 'vitest';
import type { InstalledPluginRecord } from '@open-design/contracts';
import {
  buildWebsiteCards,
  familyCardLine,
  familyPluginRecord,
  isVideoMediaUrl,
  referenceMedia,
  websiteCardsForSpine,
} from '../../src/components/plugins-home/websiteCards';
import { designProfileFixture } from '../fixtures/design-profile';

function agencyPlugin(family: string, title: string): InstalledPluginRecord {
  return {
    id: `example-agency-${family}`,
    title,
    manifest: {
      name: `example-agency-${family}`,
      od: {
        mode: 'prototype',
        context: { skills: [{ ref: 'agency-site' }, { path: './SKILL.md' }] },
      },
      tags: ['example', 'prototype'],
    },
  } as unknown as InstalledPluginRecord;
}

function bundledExample(id: string, title: string): InstalledPluginRecord {
  return {
    id,
    title,
    manifest: {
      name: id,
      od: { mode: 'prototype', context: { skills: [{ path: './SKILL.md' }] } },
      tags: ['example', 'prototype'],
    },
  } as unknown as InstalledPluginRecord;
}

const PLUGINS = [
  bundledExample('example-pricing-page', 'Pricing Page'),
  agencyPlugin('watson', 'Watson Trust to Lead'),
  bundledExample('example-meeting-notes', 'Meeting Notes'),
  agencyPlugin('maren', 'Maren Maker Studio'),
  bundledExample('example-velar-luxury-real-estate', 'Velar'),
];

const REFERENCES = [
  designProfileFixture({ digest: 'ref-tl', spine: 'TL', familyId: 'watson', meta: { total_likes: 10 } }),
  designProfileFixture({ digest: 'ref-co', spine: 'CO', familyId: null, meta: { total_likes: 99 } }),
  designProfileFixture({ digest: 'ref-none', spine: 'none', archetype: null, familyId: null }),
];

describe('buildWebsiteCards', () => {
  it('keeps only the website cards: the agency families and the stored profiles', () => {
    const cards = buildWebsiteCards(PLUGINS, REFERENCES);
    const familyIds = cards
      .filter((card) => card.kind === 'family')
      .map((card) => (card.kind === 'family' ? card.record.id : ''));
    expect(familyIds).toEqual(['example-agency-watson', 'example-agency-maren']);
    // Every other bundled example is excluded here, and only here: nothing is
    // uninstalled and nothing is hidden.
    for (const excluded of ['example-pricing-page', 'example-meeting-notes', 'example-velar-luxury-real-estate']) {
      expect(familyIds, excluded).not.toContain(excluded);
    }
    expect(cards.filter((card) => card.kind === 'reference')).toHaveLength(3);
  });

  it('annotates a family card from the registry', () => {
    const cards = buildWebsiteCards(PLUGINS, []);
    const watson = cards.find((card) => card.kind === 'family' && card.record.id === 'example-agency-watson');
    expect(watson).toMatchObject({ kind: 'family', spine: 'TL', archetype: 'TL.05', skin: 'Editorial' });
    const maren = cards.find((card) => card.kind === 'family' && card.record.id === 'example-agency-maren');
    expect(maren).toMatchObject({ kind: 'family', spine: 'TL', archetype: 'TL.06' });
  });

  it('orders family cards first, then references by likes, title and digest', () => {
    const tie = [
      designProfileFixture({ digest: 'b-digest', title: 'Same title', spine: 'TL' }),
      designProfileFixture({ digest: 'a-digest', title: 'Same title', spine: 'TL' }),
      designProfileFixture({ digest: 'c-digest', title: 'Another', spine: 'TL', meta: { total_likes: 'many' } }),
    ];
    const cards = buildWebsiteCards([agencyPlugin('watson', 'Watson')], tie);
    expect(cards[0]?.kind).toBe('family');
    const digests = cards
      .filter((card) => card.kind === 'reference')
      .map((card) => (card.kind === 'reference' ? card.profile.source.digest : ''));
    // A non-numeric `total_likes` counts as 0, so title then digest decide.
    expect(digests).toEqual(['c-digest', 'a-digest', 'b-digest']);
  });
});

describe('websiteCardsForSpine', () => {
  const cards = buildWebsiteCards(PLUGINS, REFERENCES);

  it('shows every website card under All', () => {
    expect(websiteCardsForSpine(cards, null)).toHaveLength(5);
  });

  it('shows a spine tab only the cards on that spine', () => {
    const tl = websiteCardsForSpine(cards, 'TL');
    expect(tl).toHaveLength(3);
    expect(tl.some((card) => card.kind === 'family' && card.record.id === 'example-agency-watson')).toBe(true);
    expect(tl.some((card) => card.kind === 'family' && card.record.id === 'example-agency-maren')).toBe(true);
    expect(tl.some((card) => card.kind === 'reference' && card.profile.source.digest === 'ref-tl')).toBe(true);

    const co = websiteCardsForSpine(cards, 'CO');
    expect(co.map((card) => (card.kind === 'family' ? card.record.id : card.profile.source.digest)))
      .toEqual(['ref-co']);

    expect(websiteCardsForSpine(cards, 'MI')).toEqual([]);
  });

  it('keeps an unrouted-spine reference under All only', () => {
    const everywhere = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'];
    for (const spine of everywhere) {
      const shown = websiteCardsForSpine(cards, spine);
      expect(shown.some((card) => card.kind === 'reference' && card.profile.source.digest === 'ref-none'), spine)
        .toBe(false);
    }
    expect(websiteCardsForSpine(cards, null)
      .some((card) => card.kind === 'reference' && card.profile.source.digest === 'ref-none')).toBe(true);
  });
});

describe('familyPluginRecord', () => {
  it('matches only the exact installed generator for a routed family', () => {
    expect(familyPluginRecord(PLUGINS, 'watson')?.id).toBe('example-agency-watson');
    expect(familyPluginRecord(PLUGINS, 'halcyon')).toBeNull();
    expect(familyPluginRecord(PLUGINS, null)).toBeNull();
    // A plugin that merely carries the name is not a family generator.
    const impostor = bundledExample('example-agency-watson', 'Not a family');
    expect(familyPluginRecord([impostor], 'watson')).toBeNull();
  });
});

describe('referenceMedia', () => {
  it('decides the media kind from the URL pathname, not the whole URL', () => {
    expect(isVideoMediaUrl('https://cdn.example.com/clip.mp4')).toBe(true);
    expect(isVideoMediaUrl('https://cdn.example.com/clip.mp4?token=abc')).toBe(true);
    // A query or fragment that merely ENDS in .mp4 is a still image.
    expect(isVideoMediaUrl('https://cdn.example.com/poster.png?src=clip.mp4')).toBe(false);
    expect(isVideoMediaUrl('https://cdn.example.com/poster.png#clip.mp4')).toBe(false);
    expect(isVideoMediaUrl('not a url')).toBe(false);
  });

  it('prefers the clip, falls back to the still, and has nothing for the five preview-less profiles', () => {
    const clip = referenceMedia(designProfileFixture({
      digest: 'v',
      meta: {
        previewVideo: 'https://cdn.example.com/clip.mp4?token=abc',
        previewImage: 'https://cdn.example.com/poster.jpg',
      },
    }));
    expect(clip).toEqual({
      kind: 'video',
      videoUrl: 'https://cdn.example.com/clip.mp4?token=abc',
      poster: 'https://cdn.example.com/poster.jpg',
    });

    const still = referenceMedia(designProfileFixture({
      digest: 'i',
      meta: { previewImage: 'https://cdn.example.com/poster.jpg' },
    }));
    expect(still).toEqual({ kind: 'image', poster: 'https://cdn.example.com/poster.jpg' });

    // innovation-landing, mindloop-landing, orbis-nft-landing,
    // portfolio-cosmic-hero and vortex-studio-hero have no public preview.
    expect(referenceMedia(designProfileFixture({ digest: 'none' }))).toBeNull();
    // A non-https scheme is not media we will load.
    expect(referenceMedia(designProfileFixture({
      digest: 'bad',
      meta: { previewImage: 'file:///etc/passwd' },
    }))).toBeNull();
  });
});

describe('familyCardLine', () => {
  function familyCard(family: string) {
    const card = buildWebsiteCards([agencyPlugin(family, family)], []).find(
      (item) => item.kind === 'family',
    );
    if (!card || card.kind !== 'family') throw new Error(`no family card for ${family}`);
    return card;
  }

  it('reads spine, archetype name and skin from the registry', () => {
    expect(familyCardLine(familyCard('fervor'))).toBe(
      'TL · Agency, consultancy, or studio · Cinematic and immersive',
    );
    expect(familyCardLine(familyCard('watson'))).toBe(
      'TL · Agency, consultancy, or studio · Editorial',
    );
  });

  it('is null for a family the registry does not know', () => {
    expect(familyCardLine(familyCard('nobody'))).toBeNull();
  });
});

describe('referenceMedia protocol rule', () => {
  it('refuses an http preview so the card falls back to text', () => {
    const profile = designProfileFixture({
      digest: 'digest-http',
      meta: { previewImage: 'http://cdn.example.com/still.png', previewVideo: 'http://cdn.example.com/clip.mp4' },
    });
    expect(referenceMedia(profile)).toBeNull();
  });

  it('keeps an https preview', () => {
    const profile = designProfileFixture({
      digest: 'digest-https',
      meta: { previewImage: 'https://cdn.example.com/still.png' },
    });
    expect(referenceMedia(profile)).toEqual({ kind: 'image', poster: 'https://cdn.example.com/still.png' });
  });
});
