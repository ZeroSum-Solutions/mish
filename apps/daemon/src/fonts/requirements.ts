import type { FontConstraintReport, FontProfile, ProjectDesignContext, ResourceCandidate } from '@mish/contracts';

/**
 * AC-R11.3: font requirements read from the saved project context. Deterministic
 * keyword rules over the user's own words, each tied to the JSON pointer it came
 * from. Script, legibility and italic needs come only from explicit saved constraints
 * and are requirements; brand tone from the brand/style direction is a preference
 * that refines an already-applied ranking and never applies context on its own (no
 * inference from prose). Nothing here writes the context.
 */
export type FontRequirementKind = 'script' | 'legibility' | 'italic' | 'tone';
export interface FontRequirement { id: string; kind: FontRequirementKind; value: string; source: string; strength: 'required' | 'preferred'; label: string }
export interface FontRequirements { requirements: FontRequirement[]; uninterpreted: Array<{ source: string; message: string }> }

const SCRIPTS: ReadonlyArray<[string, RegExp]> = [
  ['cyrillic', /\b(cyrillic|russian|ukrainian|bulgarian|serbian|kazakh|belarusian)\b/iu],
  ['greek', /\bgreek\b/iu],
  ['vietnamese', /\bvietnamese\b/iu],
  ['latin-ext', /\b(latin[- ]ext(?:ended)?|polish|czech|slovak|turkish|romanian|hungarian|croatian|lithuanian|latvian)\b/iu],
  ['arabic', /\b(arabic|persian|farsi|urdu)\b/iu],
  ['devanagari', /\b(devanagari|hindi|marathi|nepali|sanskrit)\b/iu],
  ['hebrew', /\b(hebrew|yiddish)\b/iu],
  ['georgian', /\bgeorgian\b/iu],
  ['armenian', /\barmenian\b/iu],
  ['thai', /\bthai\b/iu],
  ['japanese', /\bjapanese\b/iu],
  ['korean', /\b(korean|hangul)\b/iu],
  ['chinese-simplified', /\b(chinese|mandarin)\b/iu],
];
const LEGIBILITY = /\b(legib\w*|readab\w*|low[- ]vision|dyslexi\w*|visually impaired|large print|small (?:text|type|sizes?|print)|older (?:adults|patients|readers|users))\b/iu;
const ITALIC = /\bitalics?\b/iu;
const TONES: ReadonlyArray<[string, RegExp]> = [
  ['friendly', /\b(warm|friendly|approachable|playful|welcoming|cheerful|community)\b/iu],
  ['formal', /\b(formal|authoritative|trustworthy|professional|clinical|calm|serious|sober)\b/iu],
  ['technical', /\b(technical|developer|utilitarian|operations|dense|engineering|data)\b/iu],
  ['editorial', /\b(editorial|luxury|premium|elegant|fashion|literary|refined)\b/iu],
  ['civic', /\b(civic|public|nonprofit|non-profit|mission|government|charity)\b/iu],
  ['expressive', /\b(expressive|distinctive|quirky|bold|loud|experimental)\b/iu],
];
const LABEL: Record<FontRequirementKind, (value: string) => string> = {
  script: value => `${value} script support`, legibility: () => 'high legibility at small sizes', italic: () => 'a true italic', tone: value => `${value} tone`,
};

export function fontRequirementsFromContext(context: ProjectDesignContext | null | undefined): FontRequirements {
  const requirements: FontRequirement[] = [];
  const uninterpreted: FontRequirements['uninterpreted'] = [];
  if (!context) return { requirements, uninterpreted };
  const add = (kind: FontRequirementKind, value: string, source: string) => {
    const id = `${kind}:${value}`;
    if (!requirements.some(requirement => requirement.id === id)) requirements.push({ id, kind, value, source, strength: kind === 'tone' ? 'preferred' : 'required', label: LABEL[kind](value) });
  };
  const needs = (text: string, source: string): boolean => {
    let matched = false;
    for (const [script, pattern] of SCRIPTS) if (pattern.test(text)) { add('script', script, source); matched = true; }
    if (LEGIBILITY.test(text)) { add('legibility', 'small-size-legibility', source); matched = true; }
    if (ITALIC.test(text)) { add('italic', 'italic', source); matched = true; }
    return matched;
  };
  context.constraints.forEach((constraint, index) => {
    if (constraint.kind === 'motion') return; // motion has its own exclusion rules
    const source = `/constraints/${index}/value`;
    if (!needs(constraint.value, source)) uninterpreted.push({ source, message: `Constraint ${source} is not read as a font requirement, so it does not rerank fonts.` });
  });
  for (const [field, text] of [['/brandDirection', context.brandDirection], ['/styleDirection', context.styleDirection]] as const) {
    if (!text) continue;
    for (const [tone, pattern] of TONES) if (pattern.test(text)) add('tone', tone, field);
  }
  return { requirements, uninterpreted };
}

const SOURCE_NAMES: Record<FontProfile['source']['metadata'], string> = { 'fontsource/font-files': 'Fontsource', 'google/fonts': 'Google Fonts', fontshare: 'Fontshare' };
/** Whether a font meets one requirement, with the evidence shown to the user either way. */
export function fontMeetsRequirement(profile: FontProfile, requirement: FontRequirement): { met: boolean; evidence: string } {
  const sourceName = SOURCE_NAMES[profile.source.metadata];
  switch (requirement.kind) {
    case 'script': return profile.subsets.includes(requirement.value)
      ? { met: true, evidence: `declares the ${requirement.value} subset` } : { met: false, evidence: `no ${requirement.value} subset in the ${sourceName} metadata` };
    case 'legibility': {
      const trait = profile.traits?.find(entry => entry.trait === 'small-size-legibility');
      return trait ? { met: true, evidence: trait.reason } : { met: false, evidence: 'no curated small-size legibility trait' };
    }
    case 'italic': return profile.styles.includes('italic') ? { met: true, evidence: 'declares an italic style' } : { met: false, evidence: `no italic style in the ${sourceName} metadata` };
    case 'tone': return profile.tones?.includes(requirement.value as never)
      ? { met: true, evidence: `curated tone ${requirement.value}` } : { met: false, evidence: `curated tones are ${profile.tones?.length ? profile.tones.join(', ') : 'not recorded'}` };
  }
}

/** Score and reasons a font earns from the saved requirements. Explicit needs outrank spine fit. */
export const FONT_REQUIRED_WEIGHT = 40;
export const FONT_PREFERRED_WEIGHT = 6;
export function fontRequirementFit(item: ResourceCandidate, requirements: readonly FontRequirement[]): { score: number; reasons: string[] } {
  if (!item.fontProfile || !requirements.length) return { score: 0, reasons: [] };
  let score = 0; const reasons: string[] = [];
  for (const requirement of requirements) {
    const { met, evidence } = fontMeetsRequirement(item.fontProfile, requirement);
    if (met) score += requirement.strength === 'required' ? FONT_REQUIRED_WEIGHT : FONT_PREFERRED_WEIGHT;
    reasons.push(`${met ? 'Meets' : 'Counter-fit for'} project constraint ${requirement.source}: ${requirement.label} (${evidence})`);
  }
  return { score, reasons };
}

/** The search-level report: every requirement with its match count (zero is stated), plus unread constraints. */
export function fontConstraintReport(fonts: readonly ResourceCandidate[], read: FontRequirements): FontConstraintReport | undefined {
  if (!fonts.length || (!read.requirements.length && !read.uninterpreted.length)) return undefined;
  const meets = (item: ResourceCandidate, requirement: FontRequirement) => !!item.fontProfile && fontMeetsRequirement(item.fontProfile, requirement).met;
  const required = read.requirements.filter(requirement => requirement.strength === 'required');
  return {
    requirements: read.requirements.map(requirement => {
      const satisfiedCount = fonts.filter(item => meets(item, requirement)).length;
      return {
        id: requirement.id, kind: requirement.kind, value: requirement.value, source: requirement.source, strength: requirement.strength, satisfiedCount,
        message: satisfiedCount
          ? `${satisfiedCount} of ${fonts.length} fonts meet ${requirement.label} (${requirement.source}).`
          : `No catalogued font meets ${requirement.label} ${requirement.strength === 'required' ? 'required' : 'preferred'} by ${requirement.source}; the other fit signals still rank the fonts.`,
      };
    }),
    uninterpreted: read.uninterpreted,
    fontsConsidered: fonts.length,
    fontsMeetingAllRequired: fonts.filter(item => required.every(requirement => meets(item, requirement))).length,
  };
}
