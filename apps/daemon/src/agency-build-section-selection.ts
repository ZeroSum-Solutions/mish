/**
 * Shape validation for `AgencySectionSelectionInput` (`sol-design.md` §2/§3), shared by
 * `agency-build-store.ts` (so a hand-edited or older-schema persisted record cannot round-trip a
 * malformed selection back out to a later `/fork`) and `routes/agency-build.ts` (the actual
 * request-time validation, which layers the catalog/direction EXISTENCE check this module cannot
 * do — it has no catalog or direction list, only the fixed shape: `entryId`, `placement`,
 * `directionId`).
 */

import type { AgencySectionSelectionInput } from '@mish/contracts';

/** `undefined` when `value` is not a well-formed `AgencySectionSelectionInput`, else the
 * narrowed, field-picked value (never a passthrough of extra keys `value` may carry). */
export function parseSectionSelectionShape(value: unknown): AgencySectionSelectionInput | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.entryId !== 'string' || v.entryId.length === 0) return undefined;
  if (typeof v.directionId !== 'string' || v.directionId.length === 0) return undefined;
  const placement = v.placement;
  if (typeof placement !== 'object' || placement === null || Array.isArray(placement)) return undefined;
  const p = placement as Record<string, unknown>;
  if (p.mode === 'append' && typeof p.afterSectionId === 'string' && p.afterSectionId.length > 0) {
    return { entryId: v.entryId, directionId: v.directionId, placement: { mode: 'append', afterSectionId: p.afterSectionId } };
  }
  if (p.mode === 'replace-optional' && typeof p.targetSectionId === 'string' && p.targetSectionId.length > 0) {
    return { entryId: v.entryId, directionId: v.directionId, placement: { mode: 'replace-optional', targetSectionId: p.targetSectionId } };
  }
  return undefined;
}
