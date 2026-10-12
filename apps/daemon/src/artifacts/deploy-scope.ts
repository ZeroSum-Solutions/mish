type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : null;
}

/**
 * Every family whose compiler writes a `closed-assets-v2` publication marker. Eighteen families
 * total, in three groups:
 *   - The seven site families: emmpo, watson, maben, wrenfield, fervor, halcyon, maren.
 *   - Three HyperUI page kinds from the C14 ladder: marketing-site, app-shell, crm-dashboard.
 *     The C14 ladder's own PA and TU briefs can land ONLY on these three — that claim is about
 *     the ladder, not about every family in this set below.
 *   - Eight more HyperUI page kinds added since C14: listings (SM), publication (CS), nonprofit
 *     (MI), restaurant (BA.02), docs-hub (CS.02), community (LM.03), storefront (CO.01) and
 *     practice (TL.01) and guide (CS.01).
 * A marker naming any other family is refused.
 */
export const AGENCY_V2_FAMILIES: ReadonlySet<string> = new Set([
  'emmpo', 'watson', 'maben', 'wrenfield', 'fervor', 'halcyon', 'maren',
  'marketing-site', 'app-shell', 'crm-dashboard',
  'listings', 'publication', 'nonprofit', 'restaurant', 'docs-hub', 'community', 'storefront',
  'practice', 'guide',
]);

/** Agency projects require a persisted manifest even when legacy inference succeeds.
 * This bounds uploaded files; it does not classify the contents of public copy/assets.
 */
export function agencyPublicationScope(manifest: unknown, entry: string, required: boolean): Set<string> | null {
  const value = record(manifest);
  const metadata = record(value?.metadata);
  const marker = record(metadata?.agencySite);
  if (!required && value?.sourceSkillId !== 'agency-site' && metadata?.agencySite === undefined) return null;
  const invalid = () => new Error('Agency Site requires a valid closed-assets publication manifest. Regenerate a new candidate or restore its manifest.');
  const legacy = marker?.publication === 'closed-assets-v1' && marker.rendererVersion === '1.0.0';
  const family = marker?.publication === 'closed-assets-v2' && marker.rendererVersion === '2.0.0'
    && marker.recipeSchemaVersion === 2 && typeof marker.family === 'string' && AGENCY_V2_FAMILIES.has(marker.family)
    && typeof marker.revision === 'string' && new RegExp(`^${marker.family}-r[1-9][0-9]{0,6}$`).test(marker.revision)
    && Number(marker.revision.split('-r')[1]) <= 1_000_000;
  if (!value || !marker || value.sourceSkillId !== 'agency-site' || value.kind !== 'html' || value.renderer !== 'html'
    || value.entry !== entry || !/^[a-z][a-z0-9-]*\.html$/.test(entry)
    || marker.version !== 1 || (!legacy && !family)
    || typeof marker.recipeDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.recipeDigest)
    || typeof marker.revision !== 'string' || marker.revision.length > 40 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(marker.revision)
    || !Array.isArray(value.supportingFiles) || value.supportingFiles.length > 128) throw invalid();
  const scope = new Set<string>([entry]);
  const prefix = `assets/agency-site/${marker.revision}/`;
  for (const file of value.supportingFiles) {
    const suffix = family ? /\.(png|jpe?g|webp|avif|woff2?|mp4)$/ : /\.(png|jpe?g|webp|avif|woff2)$/;
    if (typeof file !== 'string' || !file.startsWith(prefix) || !/^[a-z0-9][a-z0-9-]*\.[a-z0-9]+$/.test(file.slice(prefix.length)) || !suffix.test(file) || scope.has(file)) throw invalid();
    scope.add(file);
  }
  return scope;
}
