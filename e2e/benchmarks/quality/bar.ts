import { isDeepStrictEqual } from 'node:util';
import type { Grade, Rubric } from './types.ts';

export type CriterionId = 'artDirection' | 'imagery' | 'typography' | 'layout' | 'briefFidelity' | 'craft' | 'responsive' | 'accessibility';
export type EligibilityId = 'horizontal-overflow' | 'resource-hygiene' | 'conversion' | 'placeholder-content' | 'factual-imagery' | 'invented-fact' | 'keyboard-access' | 'required-evidence';
export interface EligibilityResult {
  id: EligibilityId;
  outcome: 'pass' | 'fail' | 'inconclusive';
  evidence: string[];
  reason?: string;
}
interface Cap {
  id: string;
  maxGrade: Grade;
  criterion: CriterionId | 'any' | 'eligibility';
  below?: number;
  reason: string;
}
interface AgencyBar extends Rubric {
  question: string;
  criteria: Array<Rubric['criteria'][number] & { id: CriterionId; weight: number; notes: string[] }>;
  eligibility: Array<{ id: EligibilityId; description: string }>;
  bands: Array<{ grade: Grade; minimum: number }>;
  caps: Cap[];
  scoringRules: string[];
  reportPolicy: string;
  acceptancePolicy: string;
  freezePolicy: string;
}

/** The release candidate. All anchors, weights, bands and caps live here. */
export const AGENCY_BAR: AgencyBar = {
  "version": "agency-bar/2.0.0-rc1",
  "status": "approved",
  "question": "Would we show this to a paying client as our first draft, and would the client say \"this studio understands us\"?",
  "criteria": [
    {
      "id": "artDirection",
      "name": "Art direction fit and distinctiveness",
      "weight": 2,
      "anchors": {
        "1": "Generic template. Swap the logo and it fits any business in the category.",
        "2": "Tidy, but only kit defaults. No point of view.",
        "3": "A direction exists but shows in one or two places, or unevenly across pages.",
        "4": "A clear concept, statable in one sentence from the brief, carried by type, colour, shape, imagery and copy tone on all pages. At least one memorable moment.",
        "5": "Distinctive and confident. Several details reinforce the concept. It could sit in a studio portfolio."
      },
      "notes": []
    },
    {
      "id": "imagery",
      "name": "Imagery: present, honest, on-brand, purposeful",
      "weight": 2,
      "anchors": {
        "1": "Stand-in boxes, hatched or grey rectangles, empty slots, or invented factual imagery (for example a made-up clinic interior presented as the real one).",
        "2": "Some real imagery, but main slots are placeholders; or generic off-brief stock; or decorative art standing in for required factual photographs.",
        "3": "Every main slot is filled or honestly shown as \"needs client photo\". Right subject, mixed treatment or visible artefacts.",
        "4": "Slots match subject and mood with one consistent treatment, no artefacts at delivery size, alt text describes the content, factual versus illustrative use is clear.",
        "5": "Imagery carries the art direction. Treatment and crops are intentional and work at narrow widths."
      },
      "notes": [
        "Rights: images come from approved lanes (section 3.5) or brand-owned assets. Hot-linked images are an eligibility failure."
      ]
    },
    {
      "id": "typography",
      "name": "Type: hierarchy, readability, fit to the declared design",
      "weight": 1.5,
      "anchors": {
        "1": "Fonts fail to load, sizes are indistinct, or text is hard to read.",
        "2": "Usable but flat: little hierarchy or poor fit to the declared design.",
        "3": "Consistent roles and readable, but safe rather than chosen.",
        "4": "Hierarchy, spacing and line length (about 45 to 80 characters) suit the content and the declared design. Requested faces and weights actually load.",
        "5": "Type is a design element: scale contrast, a signature treatment, clean at narrow widths."
      },
      "notes": [
        "Evidence, not pass conditions: family count, hero-to-body ratio. One well-used family can score 5."
      ]
    },
    {
      "id": "layout",
      "name": "Composition fit to content and direction",
      "weight": 1.5,
      "anchors": {
        "1": "Every section uses the same pattern with no reason.",
        "2": "Repetition without purpose, filler sections, or composition that fights the content.",
        "3": "Composition fits the content but rhythm is mechanical.",
        "4": "Deliberate density and emphasis changes. Any repetition is intentional. Inner pages share the system but are composed for their job.",
        "5": "Editorial composition. Scale, whitespace and overlap are tools. Compact pages are fine when the content is compact."
      },
      "notes": [
        "No fixed layout count, grid count or full-bleed requirement."
      ]
    },
    {
      "id": "briefFidelity",
      "name": "Copy specificity and truthfulness",
      "weight": 1,
      "anchors": {
        "1": "Invented real-looking facts (reviews, awards, statistics, names, prices), lorem ipsum, or copy that fits any business.",
        "2": "No invented facts, but generic language or visible raw brackets.",
        "3": "Follows the brief and names the real service and offer. Gaps use a designed \"to be confirmed\" state.",
        "4": "Specific, in a distinctive voice. Claims come from the brief only. CTAs are specific. Unsupported sections were dropped, not filled.",
        "5": "Copy and design work together. Zero invented facts. Missing facts never break the layout."
      },
      "notes": []
    },
    {
      "id": "craft",
      "name": "Interaction and finish",
      "weight": 1,
      "anchors": {
        "1": "Visible defects: misalignment, clipped text, broken states.",
        "2": "Clean but default states only.",
        "3": "Consistent hover, focus and active states.",
        "4": "Designed states everywhere. Any motion is purposeful, honours reduced-motion and causes no layout shift.",
        "5": "Detail expresses the concept, with or without motion."
      },
      "notes": [
        "Motion is optional. A static design can earn A."
      ]
    },
    {
      "id": "responsive",
      "name": "Mobile and narrow-width quality",
      "weight": 1,
      "anchors": {
        "1": "Content is unreadable or unusable at 320 to 390.",
        "2": "Works, but cramped or unbalanced. Navigation is awkward.",
        "3": "Reads well, tap targets about 44 px, layout collapses sensibly.",
        "4": "Designed for narrow widths: type scale adjusted, images re-cropped without losing content, the primary action is reachable, sticky elements do not hide content.",
        "5": "The narrow page is its own composition with no loss of concept; holds at zoom."
      },
      "notes": [
        "Overflow is an eligibility failure (2.1), reported here too."
      ]
    },
    {
      "id": "accessibility",
      "name": "Accessibility and technical hygiene",
      "weight": 1,
      "anchors": {
        "1": "Fails AA contrast on body text, no landmarks, no names on controls.",
        "2": "Landmarks and labels exist, but secondary text fails contrast or focus styles are missing.",
        "3": "AA for body and controls, visible focus, one h1 per page, sensible heading order.",
        "4": "Keyboard-operable menus and forms, skip link, sized images, home-page image weight within budget.",
        "5": "Also metadata, clear form errors, fast first paint."
      },
      "notes": []
    }
  ],
  "eligibility": [
    {
      "id": "horizontal-overflow",
      "description": "Horizontal overflow at any captured width (320, 375, 390, 768, 1440)."
    },
    {
      "id": "resource-hygiene",
      "description": "Console errors on load, remote requests, broken local resources, broken internal links."
    },
    {
      "id": "conversion",
      "description": "Declared conversion does not work: the primary action has no resolvable destination, or the demo form claims something that did not happen."
    },
    {
      "id": "placeholder-content",
      "description": "Placeholder or stand-in content, or raw bracket text, in the hero, services and CTA zones (client-draft mode)."
    },
    {
      "id": "factual-imagery",
      "description": "Required factual imagery missing and not shown as an honest missing state."
    },
    {
      "id": "invented-fact",
      "description": "An invented fact (checked against the case's omitted-facts list)."
    },
    {
      "id": "keyboard-access",
      "description": "Keyboard trap, or primary controls unreachable by keyboard."
    },
    {
      "id": "required-evidence",
      "description": "Required evidence missing or unread. This is \"inconclusive\", never a pass."
    }
  ],
  "grades": {
    "A": "A reviewer would recommend showing it as is.",
    "B": "After one short art-director round.",
    "C": "A competent template that needs a design pass.",
    "D": "Rebuild the visual layer.",
    "E": "Below D and above F; retained for harness compatibility.",
    "F": "Unusable."
  },
  "bands": [
    {
      "grade": "A",
      "minimum": 4.2
    },
    {
      "grade": "B",
      "minimum": 3.5
    },
    {
      "grade": "C",
      "minimum": 2.5
    },
    {
      "grade": "D",
      "minimum": 1.8
    },
    {
      "grade": "E",
      "minimum": 1.4
    },
    {
      "grade": "F",
      "minimum": 1
    }
  ],
  "caps": [
    {
      "id": "art-direction-minimum",
      "maxGrade": "B",
      "criterion": "artDirection",
      "below": 4,
      "reason": "A needs C1 of at least 4."
    },
    {
      "id": "imagery-minimum",
      "maxGrade": "B",
      "criterion": "imagery",
      "below": 4,
      "reason": "A needs C2 of at least 4."
    },
    {
      "id": "criterion-minimum",
      "maxGrade": "B",
      "criterion": "any",
      "below": 3,
      "reason": "A needs no criterion below 3."
    },
    {
      "id": "invented-fact",
      "maxGrade": "D",
      "criterion": "briefFidelity",
      "below": 2,
      "reason": "C5 = 1 (an invented fact) caps at D."
    },
    {
      "id": "missing-imagery",
      "maxGrade": "C",
      "criterion": "imagery",
      "below": 2,
      "reason": "C2 = 1 caps at C."
    },
    {
      "id": "eligibility",
      "maxGrade": "B",
      "criterion": "eligibility",
      "reason": "Any Layer 1 failure: no recommended A. Missing evidence is inconclusive."
    }
  ],
  "scoringRules": [
    "Whole numbers 1 to 5. Between two anchors give the lower score.",
    "Score what is on screen at the captured widths, not what the code intends.",
    "Cite a screenshot region or a measured fact for every score.",
    "A 4 or 5 on art direction or imagery names the specific thing that earns it.",
    "Facts override the judge (Layer 1).",
    "Do not require multiple font families, a number of layouts, or animation. Judge typography, composition and interaction against the accepted direction."
  ],
  "reportPolicy": "Every report prints the recommended letter or \"ineligible\", M, the eight scores with spread, reviewer disagreement, eligibility failures and caps. Uncertainty unavailable from a single sample stays explicitly unavailable.",
  "acceptancePolicy": "The letter never changes outcome, never accepts a draft and never clears a required judgment.",
  "freezePolicy": "The bar freezes at the end of QT-4. No baseline is taken before then. After that, any change to anchors, weights, bands or caps bumps the version, forces re-calibration and needs a new baseline."
};

/** Only the published contract is supported; version aliases and silent edits fail closed. */
export function validateAgencyBar(rubric: Rubric): AgencyBar {
  if (rubric.version !== AGENCY_BAR.version) throw new Error(`Unsupported rubric version: ${rubric.version}`);
  if (!isDeepStrictEqual(rubric, AGENCY_BAR)) throw new Error('Altered rubric contract; use the published agency bar');
  return rubric as AgencyBar;
}

export function bandForMean(mean: number, rubric: AgencyBar = AGENCY_BAR): Grade {
  if (!Number.isFinite(mean) || mean < 1 || mean > 5) throw new Error('Mean score must be between 1 and 5');
  return rubric.bands.find(band => mean >= band.minimum)!.grade;
}

/** Mechanical eligibility does not depend on the judgment or its rubric. */
export function assessEligibility(eligibility: readonly EligibilityResult[]) {
  const seen = new Set<EligibilityId>();
  for (const result of eligibility) {
    if (!AGENCY_BAR.eligibility.some(item => item.id === result.id) || seen.has(result.id)
      || !['pass', 'fail', 'inconclusive'].includes(result.outcome)
      || !Array.isArray(result.evidence) || result.evidence.some(item => typeof item !== 'string' || !item.trim())) throw new Error('Invalid or duplicate eligibility result');
    seen.add(result.id);
  }
  const reasons = AGENCY_BAR.eligibility.flatMap(check => {
    const result = eligibility.find(item => item.id === check.id);
    const outcome = !result || !result.evidence.length || check.id === 'required-evidence' && result.outcome === 'fail' ? 'inconclusive' : result.outcome;
    if (outcome === 'pass') return [];
    return [{ id: check.id, outcome, evidence: result?.evidence ?? [], reason: result?.reason?.trim() || (!result || !result.evidence.length ? 'Required evidence missing or unread.' : check.description) }];
  });
  const eligibilityOutcome = reasons.some(item => item.outcome === 'fail') ? 'fail' : reasons.length ? 'inconclusive' : 'pass';
  return { eligibilityOutcome, reasons };
}

/** Pure advisory roll-up. Only cited, complete eligibility can recommend a letter. */
export function rollUp(scores: Record<string, number>, eligibility: readonly EligibilityResult[], suppliedRubric: Rubric = AGENCY_BAR, aggregate = false) {
  const rubric = validateAgencyBar(suppliedRubric);
  if (Object.keys(scores).length !== rubric.criteria.length) throw new Error('Incomplete or extra criterion scores');
  let weighted = 0;
  let totalWeight = 0;
  for (const criterion of rubric.criteria) {
    const value = scores[criterion.id];
    if ((!aggregate && !Number.isInteger(value)) || !Number.isFinite(value) || value! < 1 || value! > 5) throw new Error(`Score ${criterion.id} must be a whole number from 1 to 5`);
    weighted += criterion.weight * value!;
    totalWeight += criterion.weight;
  }
  const { eligibilityOutcome, reasons } = assessEligibility(eligibility);
  const M = weighted / totalWeight;
  const band = bandForMean(M, rubric);
  const caps = rubric.caps.filter(cap => {
    if (cap.criterion === 'eligibility') return eligibilityOutcome !== 'pass';
    if (cap.criterion === 'any') return rubric.criteria.some(item => scores[item.id]! < cap.below!);
    return scores[cap.criterion]! < cap.below!;
  }).map(({ id, maxGrade, reason }) => ({ id, maxGrade, reason }));
  const order = rubric.bands.map(item => item.grade);
  const cappedBand = caps.reduce((grade, cap) => order.indexOf(cap.maxGrade) > order.indexOf(grade) ? cap.maxGrade : grade, band);
  return { M, band, cappedBand, caps, eligibilityOutcome, recommendedGrade: eligibilityOutcome === 'pass' ? cappedBand : 'ineligible' as const, reasons };
}

export function renderAgencyBarMarkdown(): string {
  const lines = ['# Agency quality bar', '', `> **Release candidate ${AGENCY_BAR.version}. ${AGENCY_BAR.freezePolicy}**`, '',
    'Generated from `e2e/benchmarks/quality/bar.ts`. Run `pnpm --filter @mish/e2e bar:docs` to regenerate.', '', AGENCY_BAR.question, '',
    '## Layer 1: eligibility', '', 'Mechanical facts decide eligibility. Failures stay visible with evidence. Missing or unread evidence is inconclusive.', '',
    ...AGENCY_BAR.eligibility.map(item => `- **${item.id}**: ${item.description}`), '',
    '## Layer 2: advisory quality', '', 'Judge against the accepted direction. A restrained single-family design, a short page or a static page can earn A.', '',
    ...AGENCY_BAR.scoringRules.map(rule => `- ${rule}`), '',
    '| ID | Criterion | Weight |', '|---|---|---|', ...AGENCY_BAR.criteria.map(item => `| ${item.id} | ${item.name} | ${item.weight.toFixed(1)} |`), '',
    `Total weight: ${AGENCY_BAR.criteria.reduce((sum, item) => sum + item.weight, 0).toFixed(1)}.`, '',
    ...AGENCY_BAR.criteria.flatMap(item => [`### ${item.name}`, '', ...Object.entries(item.anchors).map(([score, anchor]) => `- ${score}: ${anchor}`), ...item.notes.map(note => `- ${note}`), '']),
    '## Advisory roll-up', '', 'M = sum(weight × score) / total weight.', '',
    ...AGENCY_BAR.bands.map(item => `- ${item.grade}: ${item.grade === 'F' ? 'below the E band' : `from ${item.minimum}`}. ${AGENCY_BAR.grades[item.grade]}`), '',
    'The lowest cap wins:', '', ...AGENCY_BAR.caps.map(cap => `- ${cap.reason}`), '',
    AGENCY_BAR.reportPolicy, '', AGENCY_BAR.acceptancePolicy, '',
    'The mechanical gate trips only on confirmed mechanical regressions and missing or stale evidence. Quality scores, disagreement and uncertainty are advisory. Passing checks never accepts or deploys a site.', '',
    '## Machine-readable rubric', '', '```json', JSON.stringify(AGENCY_BAR, null, 2), '```', ''];
  return lines.join('\n');
}
