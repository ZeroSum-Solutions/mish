import { createHash } from 'node:crypto';
import { FONT_CATEGORIES, FONT_STYLES } from '@mish/contracts';
import googleJson from './google-fonts-snapshot.json' with { type: 'json' };
// The Google Fonts listing is split in two files so each stays under the repository's 1 MiB blob guard.
import googleJsonPart2 from './google-fonts-snapshot-2.json' with { type: 'json' };
import fontshareJson from './fontshare-snapshot.json' with { type: 'json' };
import type { FontCatalogueAxis } from './catalogue.js';

/**
 * AC-R11 preamble discovery listings: pinned, licence-recorded family metadata from
 * Google Fonts (github.com/google/fonts METADATA.pb and licence file at one commit)
 * and Fontshare (its published family list, plus each OFL family's own licence file).
 * Both were fetched once and are committed as data; nothing here touches the network,
 * and no listing carries font bytes, so every listed family is metadata-only.
 */
export type FontListingKind = 'google-fonts' | 'fontshare';
export interface FontListingFamily {
  id: string; family: string; category: typeof FONT_CATEGORIES[number]; designer: string | null; dateAdded: string | null;
  weights: number[]; styles: Array<'normal' | 'italic'>; subsets: string[]; defaultSubset: string; axes: FontCatalogueAxis[];
  /** sha256 of the licence file bytes; `type` is recorded only when that file's text matches the listed licence. */
  licence: { type: string; file: string | null; sha256: string | null; reason: string | null; reservedFontNames: string[]; reservedFontNameClause: string | null };
  /** sha256 of the copyright notice text (newline-joined); `text` is kept when it fits. */
  notice: { text: string | null; sha256: string | null; reason: string | null };
  /** google/fonts only. */
  path?: string; metadataSha256?: string;
  /** Fontshare only. */
  slug?: string; fontshareId?: string; version?: string; listedLicence?: string; listingRecordSha256?: string; publisher?: string | null;
}
export interface FontListing {
  schema: 'od-font-listing/1';
  source: { kind: FontListingKind; repository: string; commit: string | null; retrievedAt: string; retrieval: string; licence: string; notes: string; listingSha256?: string; listingCount?: number };
  skipped: Array<{ path: string; reason: string }>;
  families: FontListingFamily[];
}

const HEX64 = /^[a-f0-9]{64}$/u;
class ListingError extends Error { constructor(where: string) { super(`Invalid font listing: ${where}`); } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, where: string, max = 4000): string => { if (typeof value !== 'string' || !value || value.length > max) throw new ListingError(where); return value; };
const nullable = (value: unknown, where: string, max = 4000): string | null => value === null || value === undefined ? null : str(value, where, max);
const digest = (value: unknown, where: string): string | null => { const result = nullable(value, where, 64); if (result !== null && !HEX64.test(result)) throw new ListingError(where); return result; };
const num = (value: unknown, where: string): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new ListingError(where); return value; };
const list = (value: unknown, where: string, max: number): unknown[] => { if (!Array.isArray(value) || value.length > max) throw new ListingError(where); return value; };
const oneOf = <T extends string>(value: unknown, options: readonly T[], where: string): T => { if (!options.includes(value as T)) throw new ListingError(where); return value as T; };
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function family(value: unknown, kind: FontListingKind, where: string): FontListingFamily {
  if (!isRecord(value) || !isRecord(value.licence) || !isRecord(value.notice)) throw new ListingError(where);
  const id = str(value.id, `${where}.id`, 100);
  if (!/^[a-z0-9][a-z0-9-]*$/u.test(id)) throw new ListingError(`${where}.id`);
  const weights = list(value.weights, `${where}.weights`, 20).map((entry, index) => { const n = num(entry, `${where}.weights.${index}`); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new ListingError(`${where}.weights`); return n; });
  const subsets = list(value.subsets, `${where}.subsets`, 200).map((entry, index) => str(entry, `${where}.subsets.${index}`, 64));
  const axes = list(value.axes, `${where}.axes`, 16).map((entry, index) => {
    if (!isRecord(entry)) throw new ListingError(`${where}.axes.${index}`);
    const axis = { tag: str(entry.tag, `${where}.axes.${index}.tag`, 4), min: num(entry.min, where), max: num(entry.max, where), default: num(entry.default, where) };
    if (!/^[A-Za-z0-9]{4}$/u.test(axis.tag) || axis.min > axis.default || axis.default > axis.max) throw new ListingError(`${where}.axes.${index}`);
    return axis;
  });
  const licence = value.licence; const notice = value.notice;
  const result: FontListingFamily = {
    id, family: str(value.family, `${where}.family`, 200), category: oneOf(value.category, FONT_CATEGORIES, `${where}.category`),
    designer: nullable(value.designer, `${where}.designer`, 500), dateAdded: nullable(value.dateAdded, `${where}.dateAdded`, 32),
    weights, styles: list(value.styles, `${where}.styles`, 2).map((entry, index) => oneOf(entry, FONT_STYLES, `${where}.styles.${index}`)),
    subsets, defaultSubset: str(value.defaultSubset, `${where}.defaultSubset`, 64), axes,
    licence: {
      type: str(licence.type, `${where}.licence.type`, 80), file: nullable(licence.file, `${where}.licence.file`, 100), sha256: digest(licence.sha256, `${where}.licence.sha256`),
      reason: nullable(licence.reason, `${where}.licence.reason`, 300),
      reservedFontNames: list(licence.reservedFontNames, `${where}.licence.reservedFontNames`, 16).map((entry, index) => str(entry, `${where}.licence.reservedFontNames.${index}`, 120)),
      reservedFontNameClause: nullable(licence.reservedFontNameClause, `${where}.licence.reservedFontNameClause`, 200),
    },
    notice: { text: nullable(notice.text, `${where}.notice.text`, 2000), sha256: digest(notice.sha256, `${where}.notice.sha256`), reason: nullable(notice.reason, `${where}.notice.reason`, 300) },
  };
  if (!weights.length || !result.styles.length || !subsets.includes(result.defaultSubset)) throw new ListingError(where);
  // Every absent digest names its reason; a kept notice text must hash to its recorded digest.
  if ((result.licence.sha256 === null && !result.licence.reason) || (result.notice.sha256 === null && !result.notice.reason)) throw new ListingError(`${where} digest without reason`);
  if (result.notice.text !== null && result.notice.sha256 !== sha256(result.notice.text)) throw new ListingError(`${where}.notice digest`);
  if (result.licence.type === 'unknown' && !result.licence.reason) throw new ListingError(`${where}.licence.reason`);
  if (kind === 'google-fonts') {
    result.path = str(value.path, `${where}.path`, 200);
    if (!/^(ofl|apache|ufl)\/[a-z0-9_-]+$/u.test(result.path)) throw new ListingError(`${where}.path`);
    result.metadataSha256 = str(value.metadataSha256, `${where}.metadataSha256`, 64);
    if (!HEX64.test(result.metadataSha256)) throw new ListingError(`${where}.metadataSha256`);
  } else {
    result.slug = str(value.slug, `${where}.slug`, 120);
    if (!/^[A-Za-z0-9-]+$/u.test(result.slug)) throw new ListingError(`${where}.slug`);
    result.fontshareId = str(value.fontshareId, `${where}.fontshareId`, 64);
    result.version = str(value.version, `${where}.version`, 64);
    result.listedLicence = str(value.listedLicence, `${where}.listedLicence`, 32);
    result.publisher = nullable(value.publisher, `${where}.publisher`, 200);
    result.listingRecordSha256 = str(value.listingRecordSha256, `${where}.listingRecordSha256`, 64);
    if (!HEX64.test(result.listingRecordSha256)) throw new ListingError(`${where}.listingRecordSha256`);
    // A family is OFL here only when its own licence file says so; FFL originals stay restricted.
    if (result.listedLicence !== 'sil_ofl' && result.licence.type !== 'ITF-FFL') throw new ListingError(`${where}.licence.type`);
    if (result.licence.type === 'OFL-1.1' && (result.listedLicence !== 'sil_ofl' || result.licence.sha256 === null)) throw new ListingError(`${where}.licence.type`);
  }
  return result;
}

/** Validates an untrusted listing value (a committed snapshot or a test fixture). */
export function validateFontListing(value: unknown): FontListing {
  if (!isRecord(value) || value.schema !== 'od-font-listing/1' || !isRecord(value.source)) throw new ListingError('envelope');
  const kind = oneOf(value.source.kind, ['google-fonts', 'fontshare'] as const, 'source.kind');
  const commit = nullable(value.source.commit, 'source.commit', 40);
  if (kind === 'google-fonts' ? !commit || !/^[a-f0-9]{40}$/u.test(commit) : commit !== null) throw new ListingError('source.commit');
  const source: FontListing['source'] = {
    kind, repository: str(value.source.repository, 'source.repository', 200), commit, retrievedAt: str(value.source.retrievedAt, 'source.retrievedAt', 32),
    retrieval: str(value.source.retrieval, 'source.retrieval'), licence: str(value.source.licence, 'source.licence'), notes: str(value.source.notes, 'source.notes'),
  };
  if (kind === 'fontshare') {
    source.listingSha256 = str(value.source.listingSha256, 'source.listingSha256', 64);
    if (!HEX64.test(source.listingSha256)) throw new ListingError('source.listingSha256');
    source.listingCount = num(value.source.listingCount, 'source.listingCount');
  }
  const skipped = list(value.skipped, 'skipped', 1000).map((entry, index) => {
    if (!isRecord(entry)) throw new ListingError(`skipped.${index}`);
    return { path: str(entry.path, `skipped.${index}.path`, 200), reason: str(entry.reason, `skipped.${index}.reason`, 300) };
  });
  const families = list(value.families, 'families', 5000).map((entry, index) => family(entry, kind, `families.${index}`));
  if (new Set(families.map(entry => entry.id)).size !== families.length) throw new ListingError('duplicate family id');
  return { schema: 'od-font-listing/1', source, skipped, families };
}

let bundled: FontListing[] | null = null;
/** The committed Google Fonts and Fontshare listings, validated once. Copy before editing. */
export function bundledFontListings(): FontListing[] {
  bundled ??= [validateFontListing({ ...googleJson, families: [...googleJson.families, ...googleJsonPart2.families] } as unknown), validateFontListing(fontshareJson as unknown)];
  return bundled;
}
