import type { InstalledPluginRecord } from '@open-design/contracts';

const INTERNAL_BUNDLED_SCENARIOS = new Set([
  'od-media-generation',
  'od-new-generation',
  // Code migration and tune collaboration stay installed for automation and
  // CLI use, but they are pipelines rather than tools a person picks directly.
  'od-code-migration',
  'od-tune-collab',
]);

/**
 * Keep implementation-only catalog records out of user-facing plugin pickers.
 * They remain installed because creation flows and scenario pipelines depend
 * on them, but they are not tools a person can meaningfully select directly.
 */
export function isUserFacingPluginOption(record: InstalledPluginRecord): boolean {
  const od = (record.manifest?.od ?? {}) as Record<string, unknown>;
  if (od.hidden === true) return false;
  if (od.kind === 'atom') return false;
  if (od.mode === 'design-system') return false;
  if (record.sourceKind === 'bundled' && INTERNAL_BUNDLED_SCENARIOS.has(record.id)) {
    return false;
  }
  return true;
}
