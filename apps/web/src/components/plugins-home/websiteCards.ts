// What the Home strip shows under the Prototype chip: websites, and only
// websites.
//
// Two sources, kept apart as a discriminated union rather than flattened into
// one synthetic record — a family IS an installed generator plugin, a
// reference IS a stored design-index profile, and the click paths differ:
//
//   - `family`    a bundled Agency Site generator (`od.context.skills[].ref ===
//                 'agency-site'`), annotated from the family registry by the
//                 family slug in its manifest name `example-agency-<family>`.
//   - `reference` a design-index profile: labels, probabilities and a digest,
//                 plus preview media the catalog hydrated into `meta`.
//
// Every other bundled example (Meeting notes, Pricing page, Velar, …) is
// excluded here and nowhere else: it stays installed, stays in the Plugins
// view, and still appears under its own non-Prototype chip.

import { familyRegistry, shapeAtlas } from '@open-design/agency-fast-lane/data';
import { isPublicPreviewUrl } from '@open-design/agency-fast-lane/preview-url';
import type { DesignProfile, InstalledPluginRecord } from '@open-design/contracts';

/** Skill ref every Agency Site family generator declares. */
export const AGENCY_SITE_SKILL_REF = 'agency-site';
/** Manifest-name prefix the family slug follows: `example-agency-watson`. */
export const AGENCY_PLUGIN_NAME_PREFIX = 'example-agency-';
/** The routed-spine value a profile carries when Jev found no spine at all. */
export const SPINE_NONE = 'none';

export type WebsiteCard =
  | {
      kind: 'family';
      record: InstalledPluginRecord;
      /** Registry spine code, or `none` for a family the registry does not know. */
      spine: string;
      /** Registry archetype id (`TL.05`), empty for an unregistered family. */
      archetype: string;
      /** Registry skin, empty for an unregistered family. */
      skin: string;
    }
  | { kind: 'reference'; profile: DesignProfile };

export function isAgencySitePlugin(record: InstalledPluginRecord): boolean {
  return (
    record.manifest?.od?.context?.skills?.some((skill) => skill.ref === AGENCY_SITE_SKILL_REF) ===
    true
  );
}

/**
 * The family slug a generator plugin names, or null when its id does not follow
 * the `example-agency-<family>` convention the registry is keyed on.
 */
export function agencyFamilySlug(record: InstalledPluginRecord): string | null {
  const name = record.manifest?.name ?? record.id;
  if (typeof name !== 'string' || !name.startsWith(AGENCY_PLUGIN_NAME_PREFIX)) return null;
  const slug = name.slice(AGENCY_PLUGIN_NAME_PREFIX.length);
  return slug.length > 0 ? slug : null;
}

export function familyRegistryEntry(family: string | null) {
  if (!family) return null;
  return familyRegistry.families.find((entry) => entry.family === family) ?? null;
}

/** Registry families, in the registry's own order — the Design index facet list. */
export function registryFamilyIds(): string[] {
  return familyRegistry.families.map((entry) => entry.family);
}

/** Atlas spines in atlas order — the Design index's spine facet. */
export function atlasSpineOptions(): Array<{ code: string; name: string }> {
  return shapeAtlas.spines.map((spine) => ({ code: spine.code, name: spine.name }));
}

/**
 * Atlas archetypes, narrowed to one spine when a spine is selected. An
 * archetype belongs to exactly one spine, so an unnarrowed list would offer
 * combinations that can never match a stored profile.
 */
export function atlasArchetypeOptions(spineCode: string | null): Array<{ id: string; name: string }> {
  return shapeAtlas.archetypes
    .filter((archetype) => !spineCode || archetype.spine === spineCode)
    .map((archetype) => ({ id: archetype.id, name: archetype.name }));
}

export function spineNameForCode(code: string): string | null {
  return shapeAtlas.spines.find((spine) => spine.code === code)?.name ?? null;
}

export function archetypeNameForId(id: string): string | null {
  return shapeAtlas.archetypes.find((archetype) => archetype.id === id)?.name ?? null;
}

export function archetypeIntentForId(id: string): string | null {
  return shapeAtlas.archetypes.find((archetype) => archetype.id === id)?.intent ?? null;
}

/**
 * `TL · Agency, consultancy, or studio · Editorial` beneath a family card's
 * title: spine code, archetype name, skin. Null for an unregistered family,
 * which has nothing to say.
 */
export function familyCardLine(card: Extract<WebsiteCard, { kind: 'family' }>): string | null {
  if (card.spine === SPINE_NONE || !card.archetype) return null;
  const parts = [card.spine, archetypeNameForId(card.archetype) ?? card.archetype];
  if (card.skin) parts.push(card.skin);
  return parts.join(' · ');
}

/** The spine a card belongs to: `none` means "only visible under All". */
export function websiteCardSpine(card: WebsiteCard): string {
  return card.kind === 'family' ? card.spine : referenceSpineCode(card.profile);
}

export function referenceSpineCode(profile: DesignProfile): string {
  const choice = profile.route?.spine?.choice;
  return typeof choice === 'string' && choice.length > 0 ? choice : SPINE_NONE;
}

export function referenceArchetypeId(profile: DesignProfile): string | null {
  const choice = profile.route?.archetype?.choice;
  return typeof choice === 'string' && choice !== SPINE_NONE && choice.length > 0 ? choice : null;
}

/** The family the router resolved for this reference, or null when unrouted. */
export function referenceFamilyId(profile: DesignProfile): string | null {
  const id = profile.route?.resolved?.familyId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function referenceTitle(profile: DesignProfile): string {
  return profile.source?.title || profile.source?.id || '';
}

/**
 * `meta.total_likes` as a sort key. Anything non-finite — missing, a string, a
 * boolean — counts as 0 rather than poisoning the comparison with NaN.
 */
export function referenceLikes(profile: DesignProfile): number {
  const raw = profile.meta?.total_likes;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
}

/**
 * The installed generator for a routed family, or null when that family has no
 * plugin installed. The reference click binds the plugin only on an exact
 * match; a near miss leaves the composer's current binding alone.
 */
export function familyPluginRecord(
  plugins: InstalledPluginRecord[],
  family: string | null,
): InstalledPluginRecord | null {
  if (!family) return null;
  const wanted = `${AGENCY_PLUGIN_NAME_PREFIX}${family}`;
  return (
    plugins.find(
      (record) => isAgencySitePlugin(record) && (record.manifest?.name ?? record.id) === wanted,
    ) ?? null
  );
}

/**
 * Family cards first (registry order), then references by likes descending,
 * then title, then digest — a total order, so the strip never reshuffles
 * between renders of the same data.
 */
export function buildWebsiteCards(
  plugins: InstalledPluginRecord[],
  profiles: DesignProfile[],
): WebsiteCard[] {
  const families: Array<{ card: WebsiteCard; rank: number; title: string }> = [];
  for (const record of plugins) {
    if (!isAgencySitePlugin(record)) continue;
    const slug = agencyFamilySlug(record);
    const entry = familyRegistryEntry(slug);
    const rank = entry
      ? familyRegistry.families.findIndex((item) => item.family === entry.family)
      : Number.MAX_SAFE_INTEGER;
    families.push({
      card: {
        kind: 'family',
        record,
        spine: entry?.spine ?? SPINE_NONE,
        archetype: entry?.archetype ?? '',
        skin: entry?.skin ?? '',
      },
      rank,
      title: record.title || record.id,
    });
  }
  families.sort((a, b) => (a.rank !== b.rank ? a.rank - b.rank : a.title.localeCompare(b.title)));

  const references = [...profiles].sort((a, b) => {
    const likes = referenceLikes(b) - referenceLikes(a);
    if (likes !== 0) return likes;
    const title = referenceTitle(a).localeCompare(referenceTitle(b));
    if (title !== 0) return title;
    return (a.source?.digest ?? '').localeCompare(b.source?.digest ?? '');
  });

  return [
    ...families.map((item) => item.card),
    ...references.map((profile): WebsiteCard => ({ kind: 'reference', profile })),
  ];
}

/**
 * The cards one tab shows. `null` is the All tab — every website card. A card
 * whose spine is `none` has no tab of its own and appears under All only.
 */
export function websiteCardsForSpine(cards: WebsiteCard[], spineCode: string | null): WebsiteCard[] {
  if (spineCode === null) return cards;
  return cards.filter((card) => websiteCardSpine(card) === spineCode);
}

export type ReferenceMedia =
  | { kind: 'video'; videoUrl: string; poster: string | null }
  | { kind: 'image'; poster: string }
  | null;

const VIDEO_PATH_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.m4v']);

/** The daemon's own rule (https only, length cap, parseable): a hydrated index file skips the daemon parser, so the card builder checks again. */
function httpsMediaUrl(value: unknown): string | null {
  return isPublicPreviewUrl(value) ? value : null;
}

/**
 * Whether a preview URL points at a clip, decided on the URL's PATHNAME — a
 * query string (`?token=…mp4`) or a fragment must not make a still image look
 * like a video, which a bare `endsWith` on the whole URL would allow.
 */
export function isVideoMediaUrl(value: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return false;
  }
  const dot = pathname.lastIndexOf('.');
  if (dot < 0) return false;
  return VIDEO_PATH_EXTENSIONS.has(pathname.slice(dot).toLowerCase());
}

/**
 * The media a reference card renders: a clip when the stored video URL's path
 * says so, otherwise whichever preview URL exists as a still, otherwise
 * nothing — five of the catalog's profiles have no public preview at all and
 * render as text cards.
 */
export function referenceMedia(profile: DesignProfile): ReferenceMedia {
  const video = httpsMediaUrl(profile.meta?.previewVideo);
  const image = httpsMediaUrl(profile.meta?.previewImage);
  if (video && isVideoMediaUrl(video)) return { kind: 'video', videoUrl: video, poster: image };
  const still = video ?? image;
  return still ? { kind: 'image', poster: still } : null;
}
