import type { ObservedBehavior, ProjectDesignContext } from '@mish/contracts';

/**
 * AC-R06.3 default judgment criteria. Each seed is an optional judgment check
 * the R03 reviewer lanes answer with rationale and observable examples. They
 * never decide a mechanical outcome, never require one style, never demand an
 * above-the-fold CTA and never compute a "slop score". A rubric check with the
 * same checkId replaces the seed's wording (accepted project criteria keep
 * user authority); the seed's evidence contract still guides the reviewers.
 *
 * Bump JUDGMENT_SEEDS_VERSION whenever wording, evidence contract or
 * applicability changes: runs freeze it, and an older run then reads outdated.
 */
export const JUDGMENT_SEEDS_VERSION = 'judgment-seeds/1';
export const JUDGMENT_DIMENSIONS = ['hierarchy', 'specificity', 'repetition', 'typography', 'layout', 'motion', 'goal-fit'] as const;
export type JudgmentDimension = typeof JUDGMENT_DIMENSIONS[number] | 'style-direction';

/** What a reviewer must look at and cite for one judgment check. Sent to every reviewer lane with the check. */
export interface JudgmentContract {
  dimension: JudgmentDimension;
  /** Observable things to inspect on the page. */
  lookFor: string[];
  /** Evidence a claim should cite: screenshot ids, or bundle evidence of these kinds. */
  evidence: ('screenshot' | 'accessibility-tree' | 'computed-style' | 'probe' | 'keyboard-trace')[];
  /** How the rationale must be written. */
  rationale: string;
  /** Rules the reviewer must not apply. */
  notARule: string[];
}

export interface SeededJudgment {
  checkId: string;
  dimension: JudgmentDimension;
  required: false;
  severity: 'medium' | 'low';
  /** The question reviewers answer, framed by the declared style direction. */
  criterion: string;
  contract: JudgmentContract;
  /** `always`, or the observed behaviors that make the check applicable. */
  appliesWhen: 'always' | ObservedBehavior[];
}

const RATIONALE = 'Give a rationale that names at least one observable example (an element, a line of text, or a region of a cited screenshot); without one, answer uncertain.';
const NOT_A_RULE = [
  'Do not require one style: judge against the declared direction, not a house look.',
  'Do not require a call to action above the fold.',
  'Do not compute or cite a slop score or any uncalibrated overall quality number.',
];

interface SeedDefinition { dimension: typeof JUDGMENT_DIMENSIONS[number]; question: string; lookFor: string[]; evidence: JudgmentContract['evidence']; appliesWhen: SeededJudgment['appliesWhen']; severity: SeededJudgment['severity'] }

const SEEDS: readonly SeedDefinition[] = [
  {
    dimension: 'hierarchy', severity: 'medium', appliesWhen: 'always', evidence: ['screenshot', 'accessibility-tree'],
    question: 'Does the visual and structural hierarchy make the most important content and the primary action easy to find, in a sensible reading order?',
    lookFor: ['relative size, weight and placement of the headings', 'whether the primary action stands apart from secondary actions', 'whether the heading outline matches the visual order'],
  },
  {
    dimension: 'specificity', severity: 'medium', appliesWhen: 'always', evidence: ['screenshot', 'accessibility-tree'],
    question: 'Is the copy and imagery specific to this project, audience and offer, rather than generic filler that could sit on any site?',
    lookFor: ['headlines and button labels that name the real offer', 'placeholder or stock phrasing', 'imagery that shows the actual product, place or people'],
  },
  {
    dimension: 'repetition', severity: 'low', appliesWhen: 'always', evidence: ['screenshot', 'accessibility-tree'],
    question: 'Are sections, cards, phrases and decorations varied where the content differs, without repeating the same pattern or message with no new information?',
    lookFor: ['consecutive sections with the same layout and no new information', 'repeated phrases or claims', 'decorative motifs reused without purpose'],
  },
  {
    dimension: 'typography', severity: 'medium', appliesWhen: 'always', evidence: ['screenshot', 'computed-style'],
    question: 'Is the type deliberate and readable: a coherent scale, comfortable line length and spacing, and font choices that serve the content at every captured width?',
    lookFor: ['size steps between heading levels and body text', 'line length and line height of body copy', 'number of typefaces and weights in use'],
  },
  {
    dimension: 'layout', severity: 'medium', appliesWhen: 'always', evidence: ['screenshot', 'probe'],
    question: 'Does the layout use a consistent grid and spacing rhythm, group related content, and hold together at every captured width?',
    lookFor: ['alignment to a shared grid', 'consistent gaps between related and unrelated groups', 'how sections reflow between the narrow and wide screenshots'],
  },
  {
    dimension: 'motion', severity: 'low', appliesWhen: ['animation'], evidence: ['probe', 'screenshot'],
    question: 'Does the motion on the page serve a purpose (feedback, orientation or emphasis), stay brief, and leave content readable and usable without it?',
    lookFor: ['what each animation draws attention to', 'whether content is readable before the animation ends', 'whether anything moves continuously without a way to stop it'],
  },
  {
    dimension: 'goal-fit', severity: 'medium', appliesWhen: 'always', evidence: ['screenshot', 'accessibility-tree'],
    question: 'Does the page serve the declared purpose, audience and conversion: can the intended visitor understand the offer and take the intended next step?',
    lookFor: ['whether the declared primary conversion is present and clearly labelled', 'whether the content answers what the intended audience needs before acting', 'anything that distracts from the declared goal'],
  },
];

function direction(context: ProjectDesignContext | null): string | null {
  const value = context?.styleDirection ?? context?.brandDirection ?? null;
  return value && value.trim() ? value.trim() : null;
}

/** AC-R06 retro exception: the declared direction frames the question; a deliberate period look is not a defect. */
function framed(question: string, declared: string | null): string {
  if (!declared) return `${question} No style direction is declared, so judge clarity and fit, not taste.`;
  return `${question} Judge against the declared style direction "${declared}". A deliberate retro, period or unconventional look that matches that direction is not a defect; required functionality and accessibility still apply.`;
}

/**
 * The seeded judgment checks for one project context: the seven dimensions,
 * plus a style-direction check when the context declares a style (AC-R03
 * preamble: Opus/Jev judge the intended look against that goal).
 */
export function seedJudgmentChecks(context: ProjectDesignContext | null): SeededJudgment[] {
  const declared = direction(context);
  const seeds: SeededJudgment[] = SEEDS.map(seed => ({
    checkId: `judgment.${seed.dimension}`, dimension: seed.dimension, required: false, severity: seed.severity,
    criterion: framed(seed.question, declared), appliesWhen: seed.appliesWhen,
    contract: { dimension: seed.dimension, lookFor: seed.lookFor, evidence: seed.evidence, rationale: RATIONALE, notARule: NOT_A_RULE },
  }));
  const style = context?.styleDirection?.trim();
  if (style) seeds.push({
    checkId: 'judgment.style-direction', dimension: 'style-direction', required: false, severity: 'medium', appliesWhen: 'always',
    criterion: `Does the page read as an intentional realization of the declared style direction "${style}", consistently across sections and widths? Matching that direction (including a retro or period look) is the goal, not a defect; required functionality and accessibility still apply.`,
    contract: {
      dimension: 'style-direction', evidence: ['screenshot', 'computed-style'], rationale: RATIONALE, notARule: NOT_A_RULE,
      lookFor: ['the visual traits the declared direction implies, and whether they appear', 'sections that break from the direction', 'whether the style is applied deliberately rather than as scattered decoration'],
    },
  });
  return seeds;
}

/** The seed contract for a checkId, so a rubric check that replaces a seed keeps its evidence guidance. */
export function seedContract(checkId: string, context: ProjectDesignContext | null): SeededJudgment | null {
  return seedJudgmentChecks(context).find(seed => seed.checkId === checkId) ?? null;
}
