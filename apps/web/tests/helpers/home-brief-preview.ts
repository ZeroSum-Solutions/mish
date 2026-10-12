import type { DesignBriefPreview } from '@mish/contracts';
const field = (value: string | null) => ({ value, basis: 'assumed' as const });
export const homeBriefPreview: DesignBriefPreview = {
  schema: 'design-brief/1', originalText: 'A bakery site',
  audience: field('Neighbours'), purpose: field('Show the menu'), conversion: field(null),
  sections: [{ name: 'Hero', purpose: null, basis: 'assumed' }],
  design: { typography: field('Serif'), color: field('Warm neutrals'), spacing: field('Generous'), layout: field('Single column'), motion: field('None') },
  responsive: field('Stack on phones'), accessibility: field('AA contrast'), implementationConstraints: [],
  intent: { styleDirections: [], targetRuntime: null }, resourceRefs: [], references: [], referenceChanges: [],
  assumptions: ['Opening hours were not given'], questions: [], userEditedPaths: [], rendererVersion: 'design-brief-renderer/1',
};
