import { describe, expect, it } from 'vitest';
import { referenceSeedPrompt } from '../../src/components/plugins-home/referenceSeedPrompt';
import { designProfileFixture } from '../fixtures/design-profile';

const PROFILE = designProfileFixture({
  digest: 'seed-digest',
  title: 'Atlas Studio',
  ref: 'https://example.com/atlas-studio',
  spine: 'TL',
  archetype: 'TL.05',
  familyId: 'watson',
  skin: 'Editorial',
  format: 'one-page',
  sections: { hero: 0.95, 'case-studies': 0.8, faq: 0.2 },
  components: { 'primary-cta': 0.9, carousel: 0.49 },
  mechanics: { 'scroll-reveal': 0.7, parallax: 0.1 },
  meta: {
    total_likes: 4211,
    catalogId: 'catalog-9182',
    previewImage: 'https://cdn.example.com/poster.jpg',
    previewVideo: 'https://cdn.example.com/clip.mp4',
  },
});

describe('referenceSeedPrompt', () => {
  it('carries the labels the profile actually chose', () => {
    const prompt = referenceSeedPrompt(PROFILE);
    expect(prompt).toContain('Atlas Studio');
    expect(prompt).toContain('Trust to lead');
    expect(prompt).toContain('Agency, consultancy, or studio');
    // The archetype's own intent rides with its name.
    expect(prompt).toMatch(/Archetype: .+ — .+/);
    expect(prompt).toContain('hero');
    expect(prompt).toContain('case-studies');
    expect(prompt).toContain('primary-cta');
    expect(prompt).toContain('scroll-reveal');
    expect(prompt).toContain('Editorial');
    expect(prompt).toContain('one-page');
    // Style: ground, topology, typography, imagery, density — the axes the
    // brief states.
    expect(prompt).toContain('ground dark');
    expect(prompt).toContain('topology single-column');
    expect(prompt).toContain('typography geometric-sans');
    expect(prompt).toContain('imagery photography');
    expect(prompt).toContain('density airy');
  });

  it('drops every label under the 0.5 probability gate', () => {
    const prompt = referenceSeedPrompt(PROFILE);
    expect(prompt).not.toContain('faq');
    expect(prompt).not.toContain('carousel');
    expect(prompt).not.toContain('parallax');
  });

  it('includes source.ref only when it is a valid http(s) URL', () => {
    expect(referenceSeedPrompt(PROFILE)).toContain('https://example.com/atlas-studio');

    const plainRef = designProfileFixture({ digest: 'd', ref: 'catalog:1234' });
    expect(referenceSeedPrompt(plainRef)).not.toContain('catalog:1234');

    const fileRef = designProfileFixture({ digest: 'd', ref: 'file:///tmp/page.html' });
    expect(referenceSeedPrompt(fileRef)).not.toContain('file:///tmp/page.html');

    const noRef = designProfileFixture({ digest: 'd' });
    expect(referenceSeedPrompt(noRef)).not.toContain('Reference: ');
  });

  it('never carries a meta value', () => {
    const prompt = referenceSeedPrompt(PROFILE);
    for (const value of Object.values(PROFILE.meta ?? {})) {
      expect(prompt, String(value)).not.toContain(String(value));
    }
    expect(prompt).not.toContain('catalog-9182');
    expect(prompt).not.toContain('cdn.example.com');
  });

  it('is pure: the same profile always produces the same brief', () => {
    expect(referenceSeedPrompt(PROFILE)).toBe(referenceSeedPrompt(PROFILE));
  });

  it('says what it can for an unrouted profile', () => {
    const unrouted = designProfileFixture({
      digest: 'unrouted',
      title: 'Loose page',
      spine: 'none',
      archetype: null,
      familyId: null,
    });
    const prompt = referenceSeedPrompt(unrouted);
    expect(prompt).toContain('Loose page');
    expect(prompt).not.toContain('Spine:');
    expect(prompt).not.toContain('Archetype:');
  });
});
