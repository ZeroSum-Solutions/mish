// @vitest-environment jsdom
//
// A reference without renderable media gets a generated title card, not a
// one-letter tile: the reference's own ground, accent and typography, read
// off the stored profile, with the full title and one caption line.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DesignProfile } from '@mish/contracts';

import { ReferenceCard } from '../../src/components/home-hero/ReferenceCard';
import { designProfileFixture } from '../fixtures/design-profile';

afterEach(cleanup);

const SURFACE = '.home-hero__reference-title';

function renderCard(profile: DesignProfile) {
  render(<ReferenceCard profile={profile} onPick={() => undefined} />);
  return screen.getByTestId('home-hero-design-reference');
}

function surfaceOf(profile: DesignProfile): HTMLElement {
  const surface = renderCard(profile).querySelector<HTMLElement>(SURFACE);
  if (!surface) throw new Error('no title surface rendered');
  return surface;
}

/** The hashed hue one profile (or one digest) paints, with the DOM cleaned up after. */
function hueFor(input: string | DesignProfile): number {
  const profile =
    typeof input === 'string'
      ? designProfileFixture({ digest: input, title: 'Innovation landing', familyId: null })
      : input;
  const hue = Number(surfaceOf(profile).style.getPropertyValue('--reference-hue'));
  cleanup();
  return hue;
}

describe('ReferenceCard title surface', () => {
  it('shows the whole title and the archetype caption instead of one glyph', () => {
    const card = renderCard(
      designProfileFixture({
        digest: 'digest-vortex',
        title: 'Vortex Studio hero',
        spine: 'TL',
        archetype: 'TL.05',
        familyId: null,
      }),
    );

    const surface = card.querySelector(SURFACE)!;
    expect(surface.querySelector('.home-hero__reference-title-text')!.textContent)
      .toBe('Vortex Studio hero');
    expect(surface.querySelector('.home-hero__reference-title-caption')!.textContent)
      .toBe('Agency, consultancy, or studio');
    expect(card.querySelector('.plugins-home__text-surface')).toBeNull();
    expect(card.querySelector('.plugins-home__text-glyph')).toBeNull();
    // Decorative: the button keeps the accessible name.
    expect(surface.getAttribute('aria-hidden')).toBe('true');
  });

  it('falls back to the spine code when the profile has no archetype', () => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: 'digest-spine-only',
        title: 'Mindloop landing',
        spine: 'CO',
        archetype: null,
        familyId: null,
      }),
    );
    expect(surface.querySelector('.home-hero__reference-title-caption')!.textContent).toBe('CO');
  });

  it('writes no caption when there is neither archetype nor spine', () => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: 'digest-bare',
        title: 'Orbis NFT landing',
        spine: 'none',
        archetype: null,
        familyId: null,
      }),
    );
    expect(surface.querySelector('.home-hero__reference-title-caption')).toBeNull();
  });

  it.each([
    ['near-black', 'near-black'],
    ['deep-saturated', 'deep-saturated'],
    ['light-paper', 'light-paper'],
    ['white-grey-template', 'white-grey-template'],
    ['alternating-bands', 'alternating-bands'],
    ['cathedral-dusk', 'near-black'],
    ['', 'near-black'],
  ])('maps ground %s to the %s treatment', (choice, expected) => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: `digest-ground-${choice || 'missing'}`,
        title: 'Innovation landing',
        familyId: null,
        style: { ground: choice },
      }),
    );
    expect(surface.classList.contains(`home-hero__reference-title--ground-${expected}`)).toBe(true);
  });

  it.each([
    ['serif-editorial', 'serif-editorial'],
    ['display-serif-plus-grotesk', 'display-serif-plus-grotesk'],
    ['grotesk-only', 'grotesk-only'],
    ['mono-technical', 'mono-technical'],
    ['expressive-display', 'expressive-display'],
    ['brush-script', 'grotesk-only'],
  ])('maps typography %s to the %s stack', (choice, expected) => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: `digest-type-${choice}`,
        title: 'Portfolio Cosmic hero',
        familyId: null,
        style: { typography: choice },
      }),
    );
    expect(surface.classList.contains(`home-hero__reference-title--type-${expected}`)).toBe(true);
  });

  it.each([
    ['none', 0],
    ['one-held', 1],
    ['two', 2],
    ['scattered', 3],
    ['iridescent', 0],
  ])('draws %s accent choice as %i marks', (choice, marks) => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: `digest-accent-${choice}`,
        title: 'Innovation landing',
        familyId: null,
        style: { accent: choice },
      }),
    );
    expect(surface.querySelectorAll('.home-hero__reference-title-mark')).toHaveLength(marks);
  });

  it('offsets the second and third accent hues from the first', () => {
    const surface = surfaceOf(
      designProfileFixture({
        digest: 'digest-hues',
        title: 'Innovation landing',
        familyId: null,
        style: { accent: 'scattered' },
      }),
    );
    const hues = [...surface.querySelectorAll<HTMLElement>('.home-hero__reference-title-mark')].map(
      (mark) => Number(mark.style.getPropertyValue('--reference-mark-hue')),
    );
    const base = Number(surface.style.getPropertyValue('--reference-hue'));
    expect(hues).toEqual([base, (base + 40) % 360, (base + 80) % 360]);
  });

  // The exact numbers are the contract, not just "they differ": a card that
  // changed colour between releases would be a silent visual regression.
  it('hashes one stable hue per digest', () => {
    expect(hueFor('digest-innovation-landing')).toBe(321);
    expect(hueFor('digest-innovation-landing')).toBe(321);
    expect(hueFor('digest-orbis-nft-landing')).toBe(286);
  });

  it('still draws a card when the stored digest is missing or not a string', () => {
    // A profile is parsed data: the digest is typed, not guaranteed. Both
    // shapes hash as the empty string, so they land on the same fixed hue.
    const missing = designProfileFixture({ digest: '', title: 'Innovation landing', familyId: null });
    Reflect.deleteProperty(missing.source, 'digest');
    expect(hueFor(missing)).toBe(61);

    const wrongType = designProfileFixture({ digest: '', title: 'Innovation landing', familyId: null });
    (wrongType.source as { digest: unknown }).digest = 12345;
    const surface = surfaceOf(wrongType);
    expect(Number(surface.style.getPropertyValue('--reference-hue'))).toBe(61);
    expect(surface.querySelector('.home-hero__reference-title-text')!.textContent)
      .toBe('Innovation landing');
  });

  it('shows the title card when the stored media fails to load', () => {
    const card = renderCard(
      designProfileFixture({
        digest: 'digest-dead-still',
        title: 'Mindloop landing',
        familyId: null,
        meta: { previewImage: 'https://cdn.example.com/gone.jpg' },
      }),
    );
    expect(card.querySelector(SURFACE)).toBeNull();

    fireEvent.error(card.querySelector('img')!);

    const settled = screen.getByTestId('home-hero-design-reference');
    expect(settled.querySelector(SURFACE)).toBeTruthy();
    expect(settled.querySelector('.plugins-home__text-surface')).toBeNull();
    expect(settled.querySelector('img')).toBeNull();
  });
});
