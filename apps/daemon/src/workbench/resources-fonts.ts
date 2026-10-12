import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { FontKitInventory, FontProfile, ResourceCandidate, ResourceSourceSnapshot } from '@open-design/contracts';
import { bundledFontCatalogue, validateFontCatalogue, type FontCatalogue, type FontCatalogueLocalFile } from '../fonts/catalogue.js';
import { federateFontFamilies, type FontEntrySource, type FontFamilyEntry } from '../fonts/federation.js';
import { buildFontKitInventory } from '../fonts/kit-inventory.js';
import { scanKitFonts, type FontKitRoot, type KitFontScan } from '../fonts/kit-scan.js';
import { fontLicenceProfile, fontOperationGrants, fontRights, type FontRights } from '../fonts/licence.js';
import { bundledFontListings, validateFontListing, type FontListing } from '../fonts/listings.js';
import { FONT_CONTENT_TYPES, FONT_FILE_LIMIT, FONT_NOTICE_LIMIT, readVerifiedFile, type VerifiedRead } from '../fonts/local-files.js';
import { DISCOVERY_LISTING_STYLE_TAG } from './context-ranking.js';
import type { ResourceSourceAdapter } from './resources.js';

/**
 * AC-R11 / AC-R04.2 `fonts` source: the curated Fontsource snapshot plus the pinned
 * Google Fonts and Fontshare listings (deduplicated by family identity, every source's
 * licence and notice digests kept), federated with per-font rights, weights/styles/
 * subsets/axes and spine fit, plus the admitted local files under the bundled-plugins
 * resource root (never the daemon data root). Listing-only families are metadata-only:
 * no local file is admitted for them. Readiness is at most `unverified`: per-item
 * acceptance evidence does not exist, so nothing here is `usable` or adoptable. A
 * missing, tampered, oversized or escaping local file degrades the source with a named
 * reason instead of disappearing. With kit roots, the bundled kits' declared families
 * are inventoried and mapped to admitted bytes or flagged (AC-R11 preamble).
 */
export const FONT_FILE_ROUTE = '/api/workbench/fonts/files';
export const FONT_NOTICE_ROUTE = '/api/workbench/fonts/notices';
const SPINE_SLUGS: Record<string, string> = {
  TL: 'trust-to-lead', PA: 'product-adoption', CO: 'commerce', SM: 'search-and-match', CS: 'content-subscription',
  LM: 'learning-membership', BA: 'booking-attendance', TU: 'task-utility', MI: 'mission-impact',
};
const REASONS = ['font-file-unreadable', 'font-file-size-mismatch', 'font-file-magic-mismatch', 'font-file-digest-mismatch', 'font-notice-unreadable', 'font-notice-size-mismatch', 'font-notice-digest-mismatch'] as const;
type Reason = typeof REASONS[number];
type FileRead = { state: 'available' } | { state: 'unavailable'; reason: string };
const SHA = /^[a-f0-9]{64}$/u;
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const reasonOf = (kind: 'file' | 'notice', read: VerifiedRead): FileRead => read.state === 'available' ? { state: 'available' } : { state: 'unavailable', reason: `font-${kind}-${read.reason}` };

export type FontFileResponse = { state: 'available'; bytes: Buffer; contentType: string } | { state: 'unavailable'; reason: string };
export type FontNoticeResponse = { state: 'available'; text: string } | { state: 'unavailable'; reason: string };
export interface FontsResourceSource extends ResourceSourceAdapter {
  family(itemId: string): FontFamilyEntry | undefined;
  readFile(sha256: string): Promise<FontFileResponse>;
  readNotice(sha256: string): Promise<FontNoticeResponse>;
  /** The kit/example font inventory joined with these items; null without kit roots. */
  fontKitInventory(items: readonly ResourceCandidate[]): Promise<FontKitInventory | null>;
}
const SOURCE_LABEL: Record<FontEntrySource['kind'], string> = { fontsource: 'Fontsource', 'google-fonts': 'Google Fonts', fontshare: 'Fontshare' };
function profileSource(source: FontEntrySource): FontProfile['source'] {
  if (source.kind === 'fontsource') return { metadata: 'fontsource/font-files', commit: source.commit, packageName: source.packageName, packageVersion: source.packageVersion, upstreamVersion: source.upstreamVersion, lastModified: source.lastModified, metadataSha256: source.metadataSha256 };
  if (source.kind === 'google-fonts') return { metadata: 'google/fonts', commit: source.commit, path: source.path, metadataSha256: source.metadataSha256 };
  return { metadata: 'fontshare', retrievedAt: source.retrievedAt, slug: source.slug, version: source.version, listingSha256: source.listingSha256, listingRecordSha256: source.listingRecordSha256 };
}
function attributionTitle(family: FontFamilyEntry): string {
  const source = family.source;
  if (source.kind === 'fontsource') return `${family.family} · ${source.packageName}@${source.packageVersion}`;
  if (source.kind === 'google-fonts') return `${family.family} · google/fonts ${source.path}`;
  return `${family.family} · Fontshare ${source.slug}`;
}

function fallbackWeightDistance(file: FontCatalogueLocalFile): number {
  return file.weight.min <= 400 && 400 <= file.weight.max ? 0 : Math.min(Math.abs(file.weight.min - 400), Math.abs(file.weight.max - 400));
}
const RIGHTS_ORDER: Record<FontRights, number> = { permitted: 0, unknown: 1, restricted: 2 };
function candidate(family: FontFamilyEntry, files: Map<string, FileRead>, notices: Map<string, FileRead>, fileRights: ReadonlyMap<string, FontRights>): ResourceCandidate {
  const rights = fontRights(family.licence.type);
  const localFiles: FontProfile['localFiles'] = family.localFiles.map(file => {
    // Bytes shared with another family carry the most restrictive rights among them.
    const read = rights === 'restricted' || fileRights.get(file.sha256) === 'restricted' ? { state: 'unavailable' as const, reason: 'rights-blocked' } : files.get(file.sha256) ?? { state: 'unavailable' as const, reason: 'font-file-unreadable' };
    const notice = notices.get(`${file.notice.path}\0${file.notice.sha256}`) ?? { state: 'unavailable' as const, reason: 'font-notice-unreadable' };
    return {
      sha256: file.sha256, bytes: file.bytes, format: file.format, subset: file.subset, unicodeRange: family.unicodeRanges[file.subset]!,
      style: file.style, weight: file.weight, axes: file.axes.map(({ tag, min, max, default: value }) => ({ tag, min, max, default: value })),
      ...(read.state === 'available' ? { state: 'available' as const, reason: null, url: `${FONT_FILE_ROUTE}/${file.sha256}` } : { state: 'unavailable' as const, reason: read.reason }),
      notice: notice.state === 'available' ? { sha256: file.notice.sha256, state: 'available' as const, url: `${FONT_NOTICE_ROUTE}/${file.notice.sha256}` } : { sha256: file.notice.sha256, state: 'unavailable' as const },
      provenance: file.provenance,
    };
  });
  const profile: FontProfile = {
    schema: 'font-profile/1', family: family.family, category: family.category, weights: family.weights, styles: family.styles,
    subsets: family.subsets, defaultSubset: family.defaultSubset, axes: family.axes.map(({ tag, min, max, default: value }) => ({ tag, min, max, default: value })),
    licence: fontLicenceProfile(family),
    source: profileSource(family.source),
    spineFit: family.spineFit, localFiles, traits: family.traits, tones: family.tones,
    sources: family.records.map(record => ({
      source: record.source, identity: record.identity, revision: record.revision, url: record.url, licenceType: record.licenceType,
      licenceSha256: record.licenceSha256, noticeSha256: record.noticeSha256, reason: record.reason, localFile: record.admittedLocalFiles ? 'admitted' as const : 'none' as const,
    })),
  };
  const available = family.localFiles.filter(file => localFiles.find(entry => entry.sha256 === file.sha256)?.state === 'available');
  const primary = [...available].sort((a, b) => Number(b.subset === family.defaultSubset) - Number(a.subset === family.defaultSubset) || Number(a.style !== 'normal') - Number(b.style !== 'normal') || fallbackWeightDistance(a) - fallbackWeightDistance(b))[0];
  // One revision fences the item: catalogue entry plus the current state of every local byte.
  const revision = `sha256:${sha256(JSON.stringify([family, localFiles.map(file => [file.sha256, file.state, file.reason, file.notice.state])]))}`;
  const tags = [
    family.category, ...family.subsets.map(subset => `script:${subset}`), ...family.weights.map(value => `weight:${value}`),
    ...family.axes.map(axis => `axis:${axis.tag}`), ...(family.axes.length ? ['variable'] : []), ...(family.styles.includes('italic') ? ['italic'] : []),
    `licence:${family.licence.type}`, ...family.spineFit.flatMap(fit => [`spine:${fit.spine}`, SPINE_SLUGS[fit.spine]!]),
    ...family.traits.map(entry => entry.trait), ...family.tones.map(tone => `tone:${tone}`),
    ...family.records.map(record => `source:${record.source}`),
    available.length ? 'local-bytes' : 'metadata-only',
    // A listing-only family is found by name, script, weight or axis, never by an empty query.
    ...(family.discoveryOnly ? [DISCOVERY_LISTING_STYLE_TAG] : []),
  ];
  return {
    ref: { sourceType: 'font', sourceId: 'fonts', itemId: family.id, revisionOrDigest: revision },
    title: family.family, category: 'font',
    readiness: rights === 'restricted' ? 'unavailable' : rights === 'unknown' ? 'reference-only' : 'unverified',
    ...(rights === 'restricted' ? { availabilityReason: 'rights-blocked' as const } : {}),
    compatibility: available.length
      ? { nativeFormat: primary!.format, targets: ['html', 'css'], state: 'unverified', reason: 'Local bytes are digest-pinned; per-project adoption evidence is pending' }
      : { nativeFormat: `${family.source.kind}-metadata`, targets: [], state: 'unverified', reason: `No local file admitted; only pinned ${SOURCE_LABEL[family.source.kind]} metadata is available` },
    rightsStatus: rights, fitReasons: [],
    previewCapability: rights === 'restricted'
      ? { available: false, kind: 'none', reason: 'rights-blocked' }
      : primary ? { available: true, kind: 'reference', url: `${FONT_FILE_ROUTE}/${primary.sha256}`, reason: null } : { available: false, kind: 'none', reason: 'no-local-font-file' },
    adoptionCapability: { available: false, reason: 'adapter-missing' },
    sourceAttribution: { title: attributionTitle(family), url: family.attributionUrl },
    implementationOrigin: `${family.source.kind}-metadata`, styleTags: [...new Set(tags)],
    spineAffinities: family.spineFit.length ? family.spineFit.map(fit => fit.spine) : 'unclassified',
    operationGrants: fontOperationGrants(family),
    admissionStage: rights === 'unknown' ? 'reference-only' : 'discovered',
    needDecision: 'not-assessed', needReason: 'Project need is not assessed by catalogue discovery',
    fontProfile: profile,
  };
}

/**
 * `listings` defaults to the committed Google Fonts and Fontshare snapshots (pass `[]` for
 * the curated catalogue alone). `kitRoots` names the bundled resource roots whose kits and
 * examples are inventoried; without it there is no kit inventory.
 */
export function createFontsResourceSource(deps: { root: string; catalogue?: FontCatalogue; listings?: readonly FontListing[]; kitRoots?: readonly FontKitRoot[] }): FontsResourceSource {
  const catalogue = deps.catalogue ? validateFontCatalogue(deps.catalogue) : bundledFontCatalogue();
  const listings = deps.listings ? deps.listings.map(listing => validateFontListing(listing)) : bundledFontListings();
  const families = federateFontFamilies(catalogue, listings);
  const byId = new Map(families.map(family => [family.id, family]));
  const byFile = new Map<string, { family: FontFamilyEntry; file: FontCatalogueLocalFile }>();
  const byNotice = new Map<string, string>();
  const fileRights = new Map<string, FontRights>();
  // A listing-only family (no local file, no curated fit) has a candidate that never changes: build it once.
  const staticCandidates = new Map<string, ResourceCandidate>();
  const fontshareFamilies = new Map(listings.filter(listing => listing.source.kind === 'fontshare').flatMap(listing => listing.families.map(family => [family.slug!.toLowerCase(), family.family] as const)));
  let kitScan: Promise<KitFontScan> | null = null;
  const kitRoots = deps.kitRoots ?? [];
  const kits = () => (kitScan ??= scanKitFonts(kitRoots, { fontshareFamilies }));
  for (const family of families) for (const file of family.localFiles) {
    const rights = fontRights(family.licence.type);
    if (RIGHTS_ORDER[rights] >= RIGHTS_ORDER[fileRights.get(file.sha256) ?? 'permitted']) fileRights.set(file.sha256, rights);
    if (!byFile.has(file.sha256)) byFile.set(file.sha256, { family, file });
    if (!byNotice.has(file.notice.sha256)) byNotice.set(file.notice.sha256, file.notice.path);
  }
  const rootReal = async () => { try { return await realpath(deps.root); } catch { return null; } };
  return {
    sourceId: 'fonts',
    family: itemId => byId.get(itemId),
    async list(): Promise<ResourceSourceSnapshot> {
      const root = await rootReal();
      const tally = new Map<Reason, number>();
      const note = (read: FileRead) => { if (read.state === 'unavailable') tally.set(read.reason as Reason, (tally.get(read.reason as Reason) ?? 0) + 1); };
      const files = new Map<string, FileRead>();
      const notices = new Map<string, FileRead>();
      for (const family of families) for (const file of family.localFiles) {
        if (fontRights(family.licence.type) === 'restricted' || fileRights.get(file.sha256) === 'restricted') continue;
        if (!files.has(file.sha256)) {
          const read = root ? reasonOf('file', await readVerifiedFile(root, file.path, { sha256: file.sha256, bytes: file.bytes, format: file.format }, FONT_FILE_LIMIT)) : { state: 'unavailable' as const, reason: 'font-file-unreadable' };
          files.set(file.sha256, read); note(read);
        }
        const noticeKey = `${file.notice.path}\0${file.notice.sha256}`;
        if (!notices.has(noticeKey)) {
          const read = root ? reasonOf('notice', await readVerifiedFile(root, file.notice.path, { sha256: file.notice.sha256 }, FONT_NOTICE_LIMIT)) : { state: 'unavailable' as const, reason: 'font-notice-unreadable' };
          notices.set(noticeKey, read); note(read);
        }
      }
      const built = families.map(family => {
        // Only listing-only families are shared (and frozen): curated entries are rebuilt each time.
        if (!family.discoveryOnly) return candidate(family, files, notices, fileRights);
        let cached = staticCandidates.get(family.id);
        if (!cached) { cached = deepFreeze(candidate(family, files, notices, fileRights)); staticCandidates.set(family.id, cached); }
        return cached;
      });
      const items = kitRoots.length ? withKitDeclarations(built, buildFontKitInventory(await kits(), built)) : built;
      const reason = REASONS.flatMap(key => tally.has(key) ? [`${key}:${tally.get(key)}`] : []).join('; ') || null;
      const listingDigest = sha256(JSON.stringify(items.map(item => [item.ref.itemId, item.ref.revisionOrDigest])));
      return { items, status: { sourceId: 'fonts', state: reason ? 'degraded' : 'searched', reason, itemCount: items.length, listingDigest } };
    },
    async readFile(digest) {
      const entry = SHA.test(digest) ? byFile.get(digest) : undefined;
      if (!entry) return { state: 'unavailable', reason: 'font-file-unknown' };
      if (fileRights.get(digest) === 'restricted') return { state: 'unavailable', reason: 'rights-blocked' };
      const root = await rootReal();
      if (!root) return { state: 'unavailable', reason: 'font-file-unreadable' };
      const read = await readVerifiedFile(root, entry.file.path, { sha256: entry.file.sha256, bytes: entry.file.bytes, format: entry.file.format }, FONT_FILE_LIMIT);
      return read.state === 'available' ? { state: 'available', bytes: read.bytes, contentType: FONT_CONTENT_TYPES[entry.file.format] } : { state: 'unavailable', reason: `font-file-${read.reason}` };
    },
    async readNotice(digest) {
      const relative = SHA.test(digest) ? byNotice.get(digest) : undefined;
      if (!relative) return { state: 'unavailable', reason: 'font-notice-unknown' };
      const root = await rootReal();
      if (!root) return { state: 'unavailable', reason: 'font-notice-unreadable' };
      const read = await readVerifiedFile(root, relative, { sha256: digest }, FONT_NOTICE_LIMIT);
      return read.state === 'available' ? { state: 'available', text: read.bytes.toString('utf8') } : { state: 'unavailable', reason: `font-notice-${read.reason}` };
    },
    async fontKitInventory(items) {
      return kitRoots.length ? buildFontKitInventory(await kits(), items) : null;
    },
  };
}

/** A listing candidate is shared across searches; freezing it makes that sharing safe. */
function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

/** Each family's own kit declarations on its profile (never another family's). */
function withKitDeclarations(items: ResourceCandidate[], inventory: FontKitInventory): ResourceCandidate[] {
  const byItem = new Map<string, FontKitInventory['declarations']>();
  for (const declaration of inventory.declarations) if (declaration.catalogueItemId) {
    const list = byItem.get(declaration.catalogueItemId) ?? [];
    if (list.length < 200) list.push(declaration);
    byItem.set(declaration.catalogueItemId, list);
  }
  return items.map(item => {
    const declarations = byItem.get(item.ref.itemId);
    return declarations && item.fontProfile ? { ...item, fontProfile: { ...item.fontProfile, kitDeclarations: declarations } } : item;
  });
}
