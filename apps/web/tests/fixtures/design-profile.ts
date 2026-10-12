// A minimal, valid `DesignProfile` for web-side tests.
//
// The daemon's parser owns the real shape; this builder exists so a Home or
// Design index test can say the one thing it cares about (a spine, a family, a
// preview URL) without restating twenty fields that never vary.

import type { DesignJudgment, DesignProfile, DesignStyleAxis } from '@mish/contracts';

export function judgment(choice: string, confidence = 0.9): DesignJudgment {
  return { choice, confidence, probabilities: { [choice]: confidence } };
}

function style(overrides?: Partial<Record<DesignStyleAxis, string>>): Record<DesignStyleAxis, DesignJudgment> {
  const base: Record<DesignStyleAxis, string> = {
    ground: 'dark',
    accent: 'warm',
    typography: 'geometric-sans',
    imagery: 'photography',
    topology: 'single-column',
    density: 'airy',
  };
  return Object.fromEntries(
    Object.entries({ ...base, ...overrides }).map(([axis, choice]) => [axis, judgment(choice)]),
  ) as Record<DesignStyleAxis, DesignJudgment>;
}

export interface ProfileFixtureInput {
  digest: string;
  title?: string;
  ref?: string;
  spine?: string;
  archetype?: string | null;
  familyId?: string | null;
  skin?: string;
  format?: string;
  sections?: Record<string, number>;
  components?: Record<string, number>;
  mechanics?: Record<string, number>;
  meta?: Record<string, string | number | boolean>;
  /** Style-axis choices to override, for cards that read the profile's own design language. */
  style?: Partial<Record<DesignStyleAxis, string>>;
}

export function designProfileFixture(input: ProfileFixtureInput): DesignProfile {
  const archetype = input.archetype === undefined ? 'TL.05' : input.archetype;
  return {
    schema: 'design-profile/1',
    taxonomy: 'design-taxonomy/1',
    model: 'test-model',
    at: '2026-09-19T00:00:00.000Z',
    ms: 1,
    calls: 1,
    source: {
      kind: 'prompt',
      id: input.digest,
      ...(input.title === undefined ? { title: `Profile ${input.digest}` } : { title: input.title }),
      ...(input.ref ? { ref: input.ref } : {}),
      chars: 120,
      digest: input.digest,
    },
    route: {
      spine: judgment(input.spine ?? 'TL'),
      ...(archetype ? { archetype: judgment(archetype) } : {}),
      skin: judgment(input.skin ?? 'Editorial'),
      format: judgment(input.format ?? 'one-page'),
      action: judgment('book'),
      family: judgment(input.familyId ?? 'none'),
      resolved: {
        ...(archetype ? { archetypeId: archetype } : {}),
        ...(input.familyId ? { familyId: input.familyId } : {}),
      },
    },
    sections: input.sections ?? { hero: 0.95, footer: 0.6, faq: 0.2 },
    components: input.components ?? { 'primary-cta': 0.9, carousel: 0.1 },
    mechanics: input.mechanics ?? { 'scroll-reveal': 0.8, parallax: 0.3 },
    depth: { flat: 0.7 },
    style: style(input.style),
    quality: { craft: { score: 4, legend: 'good', confidence: 0.8 } },
    truthRisk: 0.1,
    ...(input.meta ? { meta: input.meta } : {}),
  };
}
