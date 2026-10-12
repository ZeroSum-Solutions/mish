import { shapeAtlas } from '@mish/agency-fast-lane/data';
import { type ReferenceFanoutRequest, type ReferenceSection } from '@mish/contracts';

/** A deterministic suggestion from the existing nine-spine atlas, never generated business facts. */
export function referenceSections(request: ReferenceFanoutRequest) {
  const words = request.brief.toLowerCase().replace(/dentistry/g, 'dentist').replace(/e-commerce/g, 'ecommerce');
  const match = (keyword: string) => words.includes(keyword.toLowerCase());
  const archetypes = shapeAtlas.archetypes.filter(item => !request.spineCode || item.spine === request.spineCode)
    .map(item => ({ item, score: item.keywords.reduce((score, word) => score + Number(match(word)), 0) }))
    .sort((a, b) => b.score - a.score || a.item.id.localeCompare(b.item.id));
  const best = archetypes[0];
  const fallback = /\b(saas|software|platform|product app)\b/u.test(words) ? 'PA'
    : /\b(shop|ecommerce|store|checkout)\b/u.test(words) ? 'CO'
    : /\b(mobile app|dashboard|utility)\b/u.test(words) ? 'TU' : 'TL';
  const spineCode = request.spineCode ?? (best && best.score > 0 ? best.item.spine as NonNullable<ReferenceFanoutRequest['spineCode']> : fallback);
  if (request.sections) return { spineCode, sectionBasis: 'provided' as const, sections: request.sections };
  const spine = shapeAtlas.spines.find(item => item.code === spineCode)!;
  const matched = best && best.score > 0 && best.item.spine === spineCode ? best.item : null;
  const names = ['Hero', ...(matched ? matched.sections : spine.steps).filter(name => name.toLowerCase() !== 'hero').slice(0, 5), matched?.primaryCta ?? spine.ctas[0]!, 'Footer'];
  const normalize = (name: string) => name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const excluded = (request.excludedSections ?? []).map(normalize);
  const sections: ReferenceSection[] = names.filter(name => !excluded.some(drop => {
    const candidate = normalize(name);
    return candidate === drop || (drop.length >= 4 && (candidate.includes(drop) || drop.includes(candidate)));
  })).map((name, index) => ({ id: `section-${index + 1}`, name, purpose: `Suggested ${spine.name} reference pattern; confirm content before building.` }));
  const additions = request.sectionAdditions ?? [];
  const sameRole = (candidate: ReferenceSection, addition: ReferenceSection) => [addition.name, addition.purpose ?? ''].some(name => normalize(name) === normalize(candidate.name));
  const suggested = sections.filter(section => !additions.some(addition => sameRole(section, addition) || addition.id === section.id));
  const leading = suggested.filter(section => section.name === 'Hero');
  const closing = suggested.filter(section => section.name === 'Footer' || section.name === (matched?.primaryCta ?? spine.ctas[0]));
  if (leading.length + closing.length + additions.length > 8) throw new Error('Explicit additions and page anchors exceed eight sections');
  // Only unconfirmed suggestions yield space; never drop an explicit kept section.
  const body = suggested.filter(section => !leading.includes(section) && !closing.includes(section)).slice(0, 8 - leading.length - closing.length - additions.length);
  const combined = [...leading, ...additions, ...body, ...closing];
  if (!combined.length) throw new Error('All suggested sections were excluded; provide the intended sections');
  return { spineCode, sectionBasis: 'suggested' as const, sections: combined };
}
export function mobbinWeight(brief: string, spine: string): number {
  return ['PA', 'CO', 'TU'].includes(spine) || /\b(saas|mobile|ios|ecommerce|e-commerce)\b/iu.test(brief) ? 0.9 : 0.35;
}
/** Preserve subject and section even for a long brief; raw newlines never cross the connector boundary. */
export function sectionQuery(brief: string, section: ReferenceSection): string {
  const clean = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/gu, ' ').trim();
  return `${clean(brief).slice(0, 250)} — ${section.name}: ${clean(section.purpose ?? 'website reference pattern').slice(0, 40)}`.slice(0, 500);
}
