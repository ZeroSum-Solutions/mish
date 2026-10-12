import { RESOURCE_SOURCE_IDS, type ResourceResult } from '@open-design/contracts';

type SourceId = ResourceResult['ref']['sourceId'];
/** Sources with their own translated heading, in display order. */
export const NAMED_RESOURCE_GROUPS = ['plugins', 'genui', 'sections', 'shadcn', 'design-systems', 'project-tokens', 'brief-derived-tokens', 'design-md'] as const;
type NamedGroup = typeof NAMED_RESOURCE_GROUPS[number];

export interface ResourceGroup { sourceId: SourceId; named: NamedGroup | null; results: ResourceResult[] }

/** One group per source present in the results, so no federated source is ever
 * dropped from the list: named sources first, then every other source in the
 * contract's roster order. The order is stable across pages and queries. */
export function groupResourcesBySource(results: readonly ResourceResult[]): ResourceGroup[] {
  const order: readonly SourceId[] = [...NAMED_RESOURCE_GROUPS, ...RESOURCE_SOURCE_IDS.filter(id => !(NAMED_RESOURCE_GROUPS as readonly SourceId[]).includes(id))];
  return order.flatMap(sourceId => {
    const members = results.filter(resource => resource.ref.sourceId === sourceId);
    if (!members.length) return [];
    const named = (NAMED_RESOURCE_GROUPS as readonly SourceId[]).includes(sourceId) ? sourceId as NamedGroup : null;
    return [{ sourceId, named, results: members }];
  });
}
