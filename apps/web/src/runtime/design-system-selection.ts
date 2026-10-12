import { isApprovedDesignSystem } from '@open-design/contracts';
import type { DesignSystemSummary } from '@open-design/contracts';

/** Project selectors share one readiness rule; the library also displays drafts. */
export function isSelectableDesignSystem(
  system: Pick<DesignSystemSummary, 'title' | 'status' | 'source' | 'isEditable' | 'approval'>,
): boolean {
  if (!isApprovedDesignSystem(system)) return false;
  if (!(system.title ?? '').trim()) return false;
  const personal = system.source === 'user' || system.isEditable === true;
  return (system.status ?? (personal ? 'draft' : 'published')) === 'published';
}
