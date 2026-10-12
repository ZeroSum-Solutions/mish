/**
 * The PROFILE step's fixed question set: Jev's three question primitives (Choice/Noul/Score, per
 * `docs.typesafe.ai/primitives`) and `buildProfileQuestions`, which builds the same ~105-question
 * set on every call from the atlas, registry, and taxonomy — never from the input text itself.
 * Split out of `profile.ts` (which owns answer validation, `resolveProfile`, and
 * `createJevProfiler`) to keep each file under the package's line-count guideline.
 *
 * Every question's wording says "`text` (or `facts` when given)": when the caller's state
 * carries only `text`, Jev reads `text`; when it also carries `facts` (an HTML upload — see
 * `html-facts.ts`), Jev has both and can weigh the structured signal too. This keeps one
 * deterministic, testable question set instead of branching the request shape on the input kind.
 */

import type { Archetype, FamilyRegistry, ShapeAtlas } from './atlas.ts';
import { DEFAULT_MIN_TRANSFER, familyCriterion, legalSpinesForFamily, SKIN_DESCRIPTIONS, spineCriterion } from './route.ts';
import type { DesignTaxonomy, TaxonomyLabel } from './taxonomy.ts';

export type ChoiceQuestion = { type: 'choice'; instructions: string; criteria: Record<string, string> };
export type NoulQuestion = { type: 'noul'; instructions: string; criteria?: { true: string; false: string } };
export type ScoreQuestion = { type: 'score'; instructions: string; criteria: string[] };
export type ProfileQuestion = ChoiceQuestion | NoulQuestion | ScoreQuestion;

export const STYLE_AXES = ['ground', 'accent', 'typography', 'imagery', 'topology', 'density'] as const;
export type StyleAxis = (typeof STYLE_AXES)[number];

// Reused verbatim from `route.ts`'s own criterion formatting so a route judgment in a profile
// reads identically to one from a `--family auto` router run. `archetypeCriterion` is file-private
// there and duplicated here as a one-line string builder. `familyCriterion` and `spineCriterion`
// are imported from `route.ts` (not duplicated): routing coverage depends on the router and the
// profiler asking Jev in EXACTLY the same words, and the spine criterion now carries the spine's
// archetype examples, which a hand copy would drift from.
function archetypeCriterion(archetype: Archetype): string {
  return `${archetype.name}: ${archetype.intent} Order: ${archetype.steps.join(' → ')}. Sections: ${archetype.sections.join(', ')}. Final action: ${archetype.primaryCta}. Typical: ${archetype.keywords.join(', ')}.`;
}

function noulLabelQuestion(kind: string, label: TaxonomyLabel): NoulQuestion {
  return {
    type: 'noul',
    instructions: `Does the design described by \`text\` (or \`facts\` when given) include this ${kind}: ${label.id.replace(/-/g, ' ')}?`,
    criteria: {
      true: label.definition,
      false: `The design does not include this ${kind}, or what is described does not match the definition.`,
    },
  };
}

/**
 * The fixed set of ~105 questions the design taxonomy asks of any input, built fresh from the
 * atlas, registry, and taxonomy every call — never from the input text itself. `state` (`{text}`
 * or `{text, facts}`) is assembled separately by `createJevProfiler`.
 *
 * `minTransfer` must match the `resolveRoute(..., { minTransfer })` call `resolveProfile` makes
 * for this same profile (default `DEFAULT_MIN_TRANSFER`, same as `resolveRoute`'s own default) —
 * see `buildRouteQuestions`'s docblock in `route.ts` for why. `createJevProfiler` always threads
 * its own `input.minTransfer` through to keep the two in lockstep.
 */
export function buildProfileQuestions(
  atlas: ShapeAtlas,
  registry: FamilyRegistry,
  taxonomy: DesignTaxonomy,
  minTransfer: number = DEFAULT_MIN_TRANSFER,
): Record<string, ProfileQuestion> {
  const archetypesById = new Map(atlas.archetypes.map((archetype) => [archetype.id, archetype]));
  const questions: Record<string, ProfileQuestion> = {};

  const spineCriteria: Record<string, string> = {};
  for (const spine of atlas.spines) spineCriteria[spine.code] = spineCriterion(spine, atlas.archetypes);
  spineCriteria.none = '`text` (or `facts` when given) does not describe a website, or gives too little to place it on any spine.';
  questions.spine = {
    type: 'choice',
    instructions: 'Which website spine (decision sequence) best fits the site `text` (or `facts` when given) describes? Judge by what the visitor must decide and by the final action, not by industry words alone.',
    criteria: spineCriteria,
  };

  for (const spine of atlas.spines) {
    const criteria: Record<string, string> = {};
    for (const archetype of atlas.archetypes) {
      if (archetype.spine === spine.code) criteria[archetype.id] = archetypeCriterion(archetype);
    }
    criteria.none = 'No archetype of this spine fits.';
    questions[`archetype_${spine.code}`] = {
      type: 'choice',
      instructions: `Assume \`text\` (or \`facts\` when given) describes a ${spine.name} site (${spine.intent}). Which archetype fits it best?`,
      criteria,
    };
  }

  const familyCriteria: Record<string, string> = {};
  for (const entry of registry.families) {
    familyCriteria[entry.family] = familyCriterion(entry, archetypesById, legalSpinesForFamily(entry, atlas, minTransfer));
  }
  familyCriteria.none = 'No bundled family fits this input.';
  questions.family = {
    type: 'choice',
    instructions:
      "Which bundled family package best fits the business and website `text` (or `facts` when given) describes? First rule out any family whose criterion lists decision sequences that do not include the input's own decision sequence (what the visitor must decide, and their final action — the same thing the spine question judges) — that family cannot be routed to, however similar its visuals or business type look. Among the families left, judge business type, page purpose and visual register.",
    criteria: familyCriteria,
  };

  const skinCriteria: Record<string, string> = {};
  for (const skin of atlas.skins) skinCriteria[skin] = SKIN_DESCRIPTIONS[skin] ?? skin;
  skinCriteria.unspecified = '`text` (or `facts` when given) gives no visual direction.';
  questions.skin = {
    type: 'choice',
    instructions: 'Which visual skin does `text` (or `facts` when given) ask for or imply, from its tone, brand words and audience?',
    criteria: skinCriteria,
  };

  const formatCriteria: Record<string, string> = {};
  for (const format of atlas.formats) formatCriteria[format.name] = format.summary;
  formatCriteria.unspecified = '`text` (or `facts` when given) gives no cross-cutting format signal.';
  questions.format = {
    type: 'choice',
    instructions: 'Which cross-cutting format best describes the page `text` (or `facts` when given) is asking for?',
    criteria: formatCriteria,
  };

  const actionCriteria: Record<string, string> = {};
  for (const action of taxonomy.action) actionCriteria[action.id] = action.definition;
  questions.action = {
    type: 'choice',
    instructions: 'Which call to action does `text` (or `facts` when given) most directly ask the visitor to take?',
    criteria: actionCriteria,
  };

  for (const label of taxonomy.sections) questions[`section_${label.id}`] = noulLabelQuestion('page-level section', label);
  for (const label of taxonomy.components) questions[`component_${label.id}`] = noulLabelQuestion('component', label);
  for (const label of taxonomy.mechanics) questions[`mechanic_${label.id}`] = noulLabelQuestion('motion mechanic', label);
  for (const label of taxonomy.depth) questions[`depth_${label.id}`] = noulLabelQuestion('depth cue', label);

  for (const axis of STYLE_AXES) {
    const options = taxonomy.style[axis];
    const criteria: Record<string, string> = {};
    for (const option of options) criteria[option.id] = option.definition;
    criteria.unspecified = `\`text\` (or \`facts\` when given) gives no clear ${axis} direction.`;
    questions[`style_${axis}`] = {
      type: 'choice',
      instructions: `Which ${axis} best matches what \`text\` (or \`facts\` when given) describes or implies?`,
      criteria,
    };
  }

  for (const dimension of taxonomy.quality) {
    questions[`quality_${dimension.id}`] = {
      type: 'score',
      instructions: `Rate ${dimension.id.replace(/-/g, ' ')} (rubric ${dimension.rubric}) as read from \`text\` (or \`facts\` when given) alone — the spec's stated intent, not a rendered result.`,
      criteria: dimension.levels,
    };
  }

  questions.truth_risk = {
    type: 'noul',
    instructions: taxonomy.truthRisk.instructions,
    criteria: { true: taxonomy.truthRisk.criteriaTrue, false: taxonomy.truthRisk.criteriaFalse },
  };

  return questions;
}
