// The cover a reference card draws for itself when there is no media to show.
//
// Five of the catalog's profiles carry no public preview at all, and a dead
// URL leaves a sixth kind of card in the same state. The old fallback was one
// large letter on a tile, which says nothing about the reference. This surface
// is generated from the profile's own style judgments instead — ground, accent
// and typography — so a preview-less card still reads as that reference's
// design language rather than as a placeholder.
//
// Everything here is CSS: no fetch, no canvas, no web font. The class carries
// the ground and typography treatment; the one value CSS cannot name — a hue
// that is stable per reference — rides in as a custom property hashed from the
// profile digest.

import type { CSSProperties } from 'react';
import type { DesignProfile } from '@open-design/contracts';
import {
  archetypeNameForId,
  referenceArchetypeId,
  referenceSpineCode,
  SPINE_NONE,
} from '../plugins-home/websiteCards';

/** Taxonomy ground labels this surface has a treatment for. */
const GROUND_IDS = [
  'near-black',
  'deep-saturated',
  'light-paper',
  'white-grey-template',
  'alternating-bands',
] as const;
export type ReferenceGroundId = (typeof GROUND_IDS)[number];

/**
 * The treatment for a ground the taxonomy has since grown, or a profile that
 * stored none: the dark neutral, which is the catalog's most common ground and
 * the one that sits most quietly next to media tiles.
 */
const DEFAULT_GROUND: ReferenceGroundId = 'near-black';

/** Taxonomy typography labels this surface has a font stack for. */
const TYPOGRAPHY_IDS = [
  'serif-editorial',
  'display-serif-plus-grotesk',
  'grotesk-only',
  'mono-technical',
  'expressive-display',
] as const;
export type ReferenceTypographyId = (typeof TYPOGRAPHY_IDS)[number];

/** An unknown typography reads as the app's own sans stack. */
const DEFAULT_TYPOGRAPHY: ReferenceTypographyId = 'grotesk-only';

/** How many accent marks each taxonomy accent label draws. */
const ACCENT_MARK_COUNTS: Record<string, number> = {
  none: 0,
  'one-held': 1,
  two: 2,
  scattered: 3,
};

/** Degrees between the first accent hue and the second, and the second and the third. */
const ACCENT_HUE_STEP = 40;

function styleChoice(profile: DesignProfile, axis: 'ground' | 'accent' | 'typography'): string {
  const choice = profile.style?.[axis]?.choice;
  return typeof choice === 'string' ? choice : '';
}

export function referenceGroundId(profile: DesignProfile): ReferenceGroundId {
  const choice = styleChoice(profile, 'ground');
  return GROUND_IDS.find((id) => id === choice) ?? DEFAULT_GROUND;
}

export function referenceTypographyId(profile: DesignProfile): ReferenceTypographyId {
  const choice = styleChoice(profile, 'typography');
  return TYPOGRAPHY_IDS.find((id) => id === choice) ?? DEFAULT_TYPOGRAPHY;
}

/** 0 to 3 marks. An accent label this surface does not know draws none. */
export function referenceAccentMarkCount(profile: DesignProfile): number {
  return ACCENT_MARK_COUNTS[styleChoice(profile, 'accent')] ?? 0;
}

/**
 * One hue per reference, hashed (FNV-1a) from the digest rather than picked at
 * random: the same reference paints the same card on every render, in every
 * session, and two references rarely share a hue.
 *
 * A stored profile is parsed data, so the digest is typed but not guaranteed:
 * anything that is not a string hashes as the empty string and lands on one
 * fixed hue rather than throwing inside a render.
 */
export function referenceHue(digest: unknown): number {
  const source = typeof digest === 'string' ? digest : '';
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * The one small line under the title: what the reference IS, in the atlas's
 * own words. The archetype name when the atlas knows the id, else the routed
 * spine code, else nothing — an unrouted reference says nothing rather than
 * captioning itself with an internal identifier.
 */
export function referenceCaption(profile: DesignProfile): string | null {
  const archetypeId = referenceArchetypeId(profile);
  const name = archetypeId ? archetypeNameForId(archetypeId) : null;
  if (name) return name;
  const spine = referenceSpineCode(profile);
  return spine === SPINE_NONE ? null : spine;
}

interface Props {
  profile: DesignProfile;
  /** The reference's title, already resolved by the card (with its fallback). */
  title: string;
}

export function ReferenceTitleSurface({ profile, title }: Props) {
  const ground = referenceGroundId(profile);
  const typography = referenceTypographyId(profile);
  const hue = referenceHue(profile.source?.digest);
  const marks = referenceAccentMarkCount(profile);
  const caption = referenceCaption(profile);

  return (
    <div
      // Both ids are allowlisted taxonomy labels returned by
      // referenceGroundId / referenceTypographyId, never the profile's raw
      // choice string, so neither can invent a class name.
      className={[
        'home-hero__reference-title',
        `home-hero__reference-title--ground-${ground}`,
        `home-hero__reference-title--type-${typography}`,
      ].join(' ')}
      style={{ '--reference-hue': hue } as CSSProperties}
      aria-hidden
    >
      {marks > 0 ? (
        <span className="home-hero__reference-title-marks">
          {Array.from({ length: marks }, (_, index) => (
            <span
              key={index}
              className="home-hero__reference-title-mark"
              style={
                {
                  '--reference-mark-hue': (hue + index * ACCENT_HUE_STEP) % 360,
                } as CSSProperties
              }
            />
          ))}
        </span>
      ) : null}
      <span className="home-hero__reference-title-body">
        <span className="home-hero__reference-title-text">{title}</span>
        {caption ? <span className="home-hero__reference-title-caption">{caption}</span> : null}
      </span>
    </div>
  );
}
