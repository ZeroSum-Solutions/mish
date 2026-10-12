/** Reviewed copy edits shared by source exports and converted layout previews. */
import refinementsJson from '@open-design/cult-ui-catalog/catalog-copy-refinements.json' with { type: 'json' };

type Replacement = { item: string; slot: string; from: string; to: string };
const refinements = refinementsJson as { replacements: Replacement[] };

export function cultRefinedSlot(item: string, slot: string, original: string): string {
  return refinements.replacements.find((entry) => entry.item === item && entry.slot === slot && entry.from === original)?.to ?? original;
}

/** Exact literals only, after registry checksum verification. New copy contains no code syntax. */
export function cultRefinedSourceCopy(source: string, item: string): string {
  let result = source;
  for (const { item: owner, from, to } of refinements.replacements) {
    if (owner === item) result = result.split(from).join(to);
  }
  if (item === 'marketing-cta-animated') result = result.replace('text="Experience"', 'text="Make the idea"').replace('text="the future"', 'text="real."');
  return result;
}
