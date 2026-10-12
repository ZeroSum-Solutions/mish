import type { CaptureFact } from '../../benchmarks/quality/types.ts';
export function missingProbeEvidence(id: string): Pick<CaptureFact, 'id' | 'sections' | 'sectionEvidence' | 'conversion' | 'forms' | 'keyboard' | 'motion' | 'resources'> {
  const missing = { status: 'missing' as const, reason: 'Synthetic unit fixture has no browser probe' };
  return { id, sections: [], sectionEvidence: missing, conversion: missing, forms: missing, keyboard: missing, motion: missing, resources: missing };
}
