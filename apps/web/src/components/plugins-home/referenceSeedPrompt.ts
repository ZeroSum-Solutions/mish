// The brief a stored design reference seeds into the composer.
//
// Built from the profile's LABELS only — the vocabulary the design taxonomy
// and the Website Shape Atlas define — never from the source text that was
// profiled. A catalog prompt's own wording is not ours to store, show or
// replay (standing rule); what survives profiling is which sections,
// components, mechanics and style choices the page uses, and that is exactly
// what a new build needs.
//
// Pure and deterministic: same profile in, same brief out. `meta` is not read
// at all — likes, catalog ids and preview URLs are card furniture, not part of
// the brief. The only URL that may appear is `source.ref`, and only when it is
// a well-formed http(s) address.

import type { DesignProfile, DesignStyleAxis } from '@mish/contracts';
import {
  archetypeIntentForId,
  archetypeNameForId,
  referenceArchetypeId,
  referenceSpineCode,
  referenceTitle,
  SPINE_NONE,
  spineNameForCode,
} from './websiteCards';

/** A label counts as present at or above this probability. */
export const REFERENCE_SEED_MIN_PROBABILITY = 0.5;

/** The style axes the brief carries, in the order it states them. */
const SEED_STYLE_AXES: readonly DesignStyleAxis[] = [
  'ground',
  'topology',
  'typography',
  'imagery',
  'density',
];

/**
 * Labels at or above `min`, strongest first; equal probabilities keep a stable
 * alphabetical order so the same profile always renders the same brief.
 */
function presentLabels(labels: Record<string, number> | undefined): string[] {
  if (!labels) return [];
  return Object.entries(labels)
    .filter(([, probability]) => Number.isFinite(probability) && probability >= REFERENCE_SEED_MIN_PROBABILITY)
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([label]) => label);
}

function choice(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && value !== SPINE_NONE ? value : null;
}

/** `source.ref` when it is a usable http(s) URL, otherwise null. */
export function referenceSourceUrl(profile: DesignProfile): string | null {
  const ref = profile.source?.ref;
  if (typeof ref !== 'string' || ref.length === 0) return null;
  try {
    const url = new URL(ref);
    return url.protocol === 'http:' || url.protocol === 'https:' ? ref : null;
  } catch {
    return null;
  }
}

export function referenceSeedPrompt(profile: DesignProfile): string {
  const lines: string[] = [];
  const title = referenceTitle(profile);
  lines.push(title ? `Build a website in the shape of "${title}".` : 'Build a website in this shape.');

  const spineCode = referenceSpineCode(profile);
  const spineName = spineCode === SPINE_NONE ? null : spineNameForCode(spineCode);
  if (spineName) lines.push(`Spine: ${spineName} (${spineCode}).`);

  const archetypeId = referenceArchetypeId(profile);
  if (archetypeId) {
    const name = archetypeNameForId(archetypeId) ?? archetypeId;
    const intent = archetypeIntentForId(archetypeId);
    lines.push(intent ? `Archetype: ${name} — ${intent}` : `Archetype: ${name}.`);
  }

  const sections = presentLabels(profile.sections);
  if (sections.length > 0) lines.push(`Sections: ${sections.join(', ')}.`);
  const components = presentLabels(profile.components);
  if (components.length > 0) lines.push(`Components: ${components.join(', ')}.`);
  const mechanics = presentLabels(profile.mechanics);
  if (mechanics.length > 0) lines.push(`Mechanics: ${mechanics.join(', ')}.`);

  const style = SEED_STYLE_AXES
    .map((axis) => {
      const value = choice(profile.style?.[axis]?.choice);
      return value ? `${axis} ${value}` : null;
    })
    .filter((entry): entry is string => entry !== null);
  if (style.length > 0) lines.push(`Style: ${style.join(', ')}.`);

  const skin = choice(profile.route?.skin?.choice);
  if (skin) lines.push(`Skin: ${skin}.`);
  const format = choice(profile.route?.format?.choice);
  if (format) lines.push(`Format: ${format}.`);

  const url = referenceSourceUrl(profile);
  if (url) lines.push(`Reference: ${url}`);

  return lines.join('\n');
}
