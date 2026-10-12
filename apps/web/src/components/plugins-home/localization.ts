import {
  resolveLocalizedText,
  type InstalledPluginRecord,
  type LocalizedText,
} from '@mish/contracts';

export function localizePluginTitle(locale: string, record: InstalledPluginRecord): string {
  const value = resolveLocalizedText(localizedText(record.manifest?.title_i18n), locale) || record.title;
  return record.sourceKind === 'bundled' ? brandOfficialPluginText(value) : value;
}

export function localizePluginDescription(locale: string, record: InstalledPluginRecord): string {
  const value = resolveLocalizedText(localizedText(record.manifest?.description_i18n), locale)
    || record.manifest?.description
    || '';
  return record.sourceKind === 'bundled' ? brandOfficialPluginText(value) : value;
}

/** Rebrand copy supplied by the retained upstream official registry at the UI
 * boundary. Protocol names, manifests and install sources stay unchanged. */
export function brandOfficialPluginText(value: string): string {
  return value
    .replace(/\bZeroSum-Solutions\/mish\b/gi, 'Mishh Mashh')
    .replace(/\b(?:www\.)?mish\.(?:ai|invalid)\b/gi, 'Mishh Mashh')
    .replace(/@?(?:MishHQ|Mish-ai)\b/gi, 'Mishh Mashh')
    .replace(/\ban\s+Open(?:\s+Claude)?[\s-]*Design\b/gi, 'a Mishh Mashh')
    .replace(/\bOpen(?:\s+Claude)?[\s-]*Design\b/gi, 'Mishh Mashh')
    // The upstream name was renamed to the bare "Mish" in official copy.
    .replace(/\ban\s+Mish\b(?![\w-])/g, 'a Mishh Mashh')
    .replace(/\bMish\b(?![\w-])/g, 'Mishh Mashh');
}

export function localizedText(value: unknown): LocalizedText | undefined {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) return undefined;
  if (!entries.every(([, text]) => typeof text === 'string')) return undefined;
  return Object.fromEntries(entries) as Record<string, string>;
}
