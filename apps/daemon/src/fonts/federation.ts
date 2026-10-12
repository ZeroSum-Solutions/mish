import { createHash } from 'node:crypto';
import type { FontCatalogue, FontCatalogueFamily } from './catalogue.js';
import type { FontListing, FontListingFamily } from './listings.js';

/**
 * AC-R11 preamble: one family list from the curated Fontsource snapshot and the pinned
 * Google Fonts and Fontshare listings. A family that several sources list becomes one
 * entry (deduplicated by family identity) that keeps every source's own record, licence
 * digest and notice digest; the curated Fontsource entry stays primary when it exists.
 * A Fontshare family whose licence differs from the matching family stays separate.
 */
export type FontSourceKind = 'fontsource' | 'google-fonts' | 'fontshare';
export type FontEntrySource =
  | { kind: 'fontsource'; commit: string; packageName: string; packageVersion: string; upstreamVersion: string; lastModified: string; metadataSha256: string; upstream: string | null }
  | { kind: 'google-fonts'; commit: string; path: string; metadataSha256: string }
  | { kind: 'fontshare'; retrievedAt: string; slug: string; version: string; listingSha256: string; listingRecordSha256: string };
export interface FontSourceRecordEntry {
  source: FontSourceKind; identity: string; revision: string; url: string | null;
  licenceType: string; licenceSha256: string | null; noticeSha256: string | null; reason: string | null;
  /** True only for a source whose bytes are admitted locally (the curated Fontsource files). */
  admittedLocalFiles: boolean;
}
export interface FontFamilyEntry extends Omit<FontCatalogueFamily, 'source' | 'licence'> {
  source: FontEntrySource;
  licence: FontCatalogueFamily['licence'] & { noticeSha256: string | null; reservedFontNameClause: string | null };
  records: FontSourceRecordEntry[];
  /** Metadata-only discovery family: no curated spine fit and no admitted local file. */
  discoveryOnly: boolean;
  attributionUrl: string;
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
const identityKey = (family: string) => family.normalize('NFC').toLowerCase().replace(/\s+/gu, ' ').trim();
const googleSpecimenUrl = (family: string) => `https://fonts.google.com/specimen/${encodeURIComponent(family).replace(/%20/gu, '+')}`;
const fontshareUrl = (slug: string) => `https://www.fontshare.com/fonts/${encodeURIComponent(slug)}`;
const reasons = (...values: Array<string | null>) => values.filter((value): value is string => !!value).join('; ') || null;

function curatedEntry(family: FontCatalogueFamily, catalogue: FontCatalogue): FontFamilyEntry {
  const noticeSha256 = family.licence.attribution ? sha256(family.licence.attribution) : null;
  const record: FontSourceRecordEntry = {
    source: 'fontsource', identity: `${family.source.packageName}@${family.source.packageVersion}`, revision: catalogue.source.commit,
    url: `https://fontsource.org/fonts/${family.id}`, licenceType: family.licence.type,
    licenceSha256: family.licence.upstreamLicenceSha256, noticeSha256,
    reason: reasons(family.licence.upstreamLicenceSha256 ? null : 'Fontsource names no upstream licence file', noticeSha256 ? null : 'Fontsource names no copyright notice'),
    admittedLocalFiles: family.localFiles.length > 0,
  };
  return {
    ...family,
    source: { kind: 'fontsource', commit: catalogue.source.commit, ...family.source },
    licence: { ...family.licence, noticeSha256, reservedFontNameClause: null },
    records: [record], discoveryOnly: false, attributionUrl: `https://fontsource.org/fonts/${family.id}`,
  };
}

function listingRecord(family: FontListingFamily, listing: FontListing): FontSourceRecordEntry {
  const google = listing.source.kind === 'google-fonts';
  return {
    source: listing.source.kind, identity: google ? family.path! : family.slug!, revision: google ? listing.source.commit! : listing.source.retrievedAt,
    url: google ? googleSpecimenUrl(family.family) : fontshareUrl(family.slug!), licenceType: family.licence.type,
    licenceSha256: family.licence.sha256, noticeSha256: family.notice.sha256, reason: reasons(family.licence.reason, family.notice.reason),
    admittedLocalFiles: false,
  };
}

function listingEntry(family: FontListingFamily, listing: FontListing, id: string): FontFamilyEntry {
  const google = listing.source.kind === 'google-fonts';
  const licenceUrl = google
    ? family.licence.file ? `https://github.com/google/fonts/blob/${listing.source.commit}/${family.path}/${family.licence.file}` : null
    : family.licence.type === 'ITF-FFL' ? 'https://www.fontshare.com/licenses/itf-ffl' : 'https://www.fontshare.com/licenses/sil-ofl';
  return {
    id, family: family.family, category: family.category, weights: family.weights, styles: family.styles, subsets: family.subsets, defaultSubset: family.defaultSubset,
    axes: family.axes, unicodeRanges: {},
    licence: {
      type: family.licence.type, url: licenceUrl, attribution: family.notice.text, upstreamLicenceSha256: family.licence.sha256,
      reservedFontNames: family.licence.reservedFontNames, noticeSha256: family.notice.sha256, reservedFontNameClause: family.licence.reservedFontNameClause,
    },
    source: google
      ? { kind: 'google-fonts', commit: listing.source.commit!, path: family.path!, metadataSha256: family.metadataSha256! }
      : { kind: 'fontshare', retrievedAt: listing.source.retrievedAt, slug: family.slug!, version: family.version!, listingSha256: listing.source.listingSha256!, listingRecordSha256: family.listingRecordSha256! },
    spineFit: [], traits: [], tones: [], localFiles: [],
    records: [listingRecord(family, listing)], discoveryOnly: true,
    attributionUrl: google ? googleSpecimenUrl(family.family) : fontshareUrl(family.slug!),
  };
}

/** Curated families first (in snapshot order), then Google-only, then Fontshare-only families. */
export function federateFontFamilies(catalogue: FontCatalogue, listings: readonly FontListing[]): FontFamilyEntry[] {
  const entries = catalogue.families.map(family => curatedEntry(family, catalogue));
  const byIdentity = new Map(entries.map(entry => [identityKey(entry.family), entry]));
  const ids = new Set(entries.map(entry => entry.id));
  const order: FontListing['source']['kind'][] = ['google-fonts', 'fontshare'];
  for (const kind of order) for (const listing of listings.filter(entry => entry.source.kind === kind)) {
    for (const family of listing.families) {
      const existing = byIdentity.get(identityKey(family.family));
      // Same family identity and the same licence: one entry, one more source record.
      if (existing && existing.licence.type === family.licence.type && !existing.records.some(record => record.source === kind)) {
        existing.records.push(listingRecord(family, listing));
        continue;
      }
      let id = family.id;
      if (ids.has(id)) id = `${kind === 'google-fonts' ? 'google' : 'fontshare'}-${family.id}`.replace(/^fontshare-fontshare-/u, 'fontshare-');
      // Never drop a listed family silently: an unresolvable id is an invalid snapshot.
      if (ids.has(id)) throw new Error(`Font federation: duplicate family id ${id}`);
      const entry = listingEntry(family, listing, id);
      entries.push(entry); ids.add(id);
      if (!existing) byIdentity.set(identityKey(family.family), entry);
    }
  }
  return entries;
}
