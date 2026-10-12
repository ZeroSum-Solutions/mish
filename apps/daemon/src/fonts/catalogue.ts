import { FONT_CATEGORIES, FONT_SPINE_CODES, FONT_STYLES, FONT_TONES, FONT_TRAITS, FONT_UNICODE_RANGE_MAX_LENGTH, FONT_UNICODE_RANGE_PATTERN } from '@open-design/contracts';
import snapshotJson from './fontsource-snapshot.json' with { type: 'json' };
import { FONT_FILE_LIMIT, isSafeRelativePath } from './local-files.js';

/**
 * AC-R11 curated font catalogue: a pinned, licence-recorded snapshot of Fontsource
 * metadata (fontsource/font-files at one commit; metadata, unicode ranges, package
 * versions and licence digests only) plus Mishh Mashh spine fit judgments and the
 * admitted local files already bundled with the official plugins. Nothing here
 * fetches from the network; the snapshot is data committed with the daemon.
 */
export interface FontCatalogueAxis { tag: string; min: number; max: number; default: number; step?: number }
export interface FontCatalogueLocalFile {
  /** Relative to the bundled-plugins resource root; never absolute, never `..`. */
  path: string; sha256: string; bytes: number; format: 'woff2' | 'woff' | 'ttf' | 'otf'; subset: string;
  style: 'normal' | 'italic'; weight: { min: number; max: number }; axes: FontCatalogueAxis[];
  /** The file's own cmap, measured once at snapshot time, as `U+XXXX[-YYYY]` ranges. */
  cmap: string; notice: { path: string; sha256: string }; provenance: string;
}
export interface FontCatalogueFamily {
  id: string; family: string; category: typeof FONT_CATEGORIES[number]; weights: number[]; styles: Array<'normal' | 'italic'>;
  subsets: string[]; defaultSubset: string; axes: FontCatalogueAxis[]; unicodeRanges: Record<string, string>;
  licence: { type: string; url: string | null; attribution: string | null; upstreamLicenceSha256: string | null; reservedFontNames: string[] };
  source: { packageName: string; packageVersion: string; upstreamVersion: string; lastModified: string; metadataSha256: string; upstream: string | null };
  spineFit: Array<{ spine: typeof FONT_SPINE_CODES[number]; fit: string; counterFit: string }>;
  /** Curated, reasoned traits and brand tones used by AC-R11.3 constraint ranking. */
  traits: Array<{ trait: typeof FONT_TRAITS[number]; reason: string }>;
  tones: Array<typeof FONT_TONES[number]>;
  localFiles: FontCatalogueLocalFile[];
}
export interface FontCatalogue {
  schema: 'od-font-catalogue/1';
  source: { repository: string; commit: string; retrievedAt: string; retrieval: string; licence: string };
  classification: string;
  localBytes: { root: 'bundled-plugins'; measuredWith: string; method: string };
  families: FontCatalogueFamily[];
}

const HEX64 = /^[a-f0-9]{64}$/u;
const RANGE = /^U\+([0-9A-F?]{1,6})(?:-([0-9A-F]{1,6}))?$/u;
const CMAP_MAX_LENGTH = 20000;
class CatalogueError extends Error { constructor(where: string) { super(`Invalid font catalogue: ${where}`); } }
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown, where: string, max = 4000): string => { if (typeof value !== 'string' || !value || value.length > max) throw new CatalogueError(where); return value; };
const nullableStr = (value: unknown, where: string): string | null => value === null ? null : str(value, where);
const num = (value: unknown, where: string): number => { if (typeof value !== 'number' || !Number.isFinite(value)) throw new CatalogueError(where); return value; };
const weight = (value: unknown, where: string): number => { const n = num(value, where); if (!Number.isInteger(n) || n < 1 || n > 1000) throw new CatalogueError(where); return n; };
const list = (value: unknown, where: string): unknown[] => { if (!Array.isArray(value)) throw new CatalogueError(where); return value; };
const oneOf = <T extends string>(value: unknown, options: readonly T[], where: string): T => { if (!options.includes(value as T)) throw new CatalogueError(where); return value as T; };

/** `U+0000-00FF,U+0131` → sorted, disjoint inclusive ranges. A `?` wildcard covers 0–F. */
export function parseUnicodeRanges(value: string): Array<[number, number]> {
  const ranges = value.split(',').map(part => part.trim()).filter(Boolean).map(part => {
    const match = RANGE.exec(part);
    if (!match) throw new CatalogueError(`unicode range ${part.slice(0, 40)}`);
    const start = parseInt(match[1]!.replace(/\?/g, '0'), 16);
    const end = match[2] ? parseInt(match[2], 16) : parseInt(match[1]!.replace(/\?/g, 'F'), 16);
    if (end < start || end > 0x10ffff) throw new CatalogueError(`unicode range ${part.slice(0, 40)}`);
    return [start, end] as [number, number];
  });
  const union: Array<[number, number]> = [];
  // Subsets may overlap or nest (for example Latin and symbols). Binary search
  // needs disjoint ranges so a narrower subset cannot hide an earlier range.
  for (const [start, end] of ranges.sort((a, b) => a[0] - b[0])) {
    const previous = union[union.length - 1];
    if (previous && start <= previous[1] + 1) previous[1] = Math.max(previous[1], end);
    else union.push([start, end]);
  }
  return union;
}
export function rangesContain(ranges: ReadonlyArray<readonly [number, number]>, codepoint: number): boolean {
  let low = 0; let high = ranges.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1; const [start, end] = ranges[mid]!;
    if (codepoint < start) high = mid - 1; else if (codepoint > end) low = mid + 1; else return true;
  }
  return false;
}
function axis(value: unknown, where: string): FontCatalogueAxis {
  if (!isRecord(value)) throw new CatalogueError(where);
  const result: FontCatalogueAxis = { tag: str(value.tag, `${where}.tag`, 4), min: num(value.min, where), max: num(value.max, where), default: num(value.default, where) };
  if (!/^[A-Za-z]{4}$/.test(result.tag) || result.min > result.default || result.default > result.max) throw new CatalogueError(where);
  if (value.step !== undefined) result.step = num(value.step, where);
  return result;
}
function localFile(value: unknown, where: string): FontCatalogueLocalFile {
  if (!isRecord(value) || !isRecord(value.weight) || !isRecord(value.notice)) throw new CatalogueError(where);
  const file: FontCatalogueLocalFile = {
    path: str(value.path, `${where}.path`, 500), sha256: str(value.sha256, `${where}.sha256`, 64), bytes: num(value.bytes, `${where}.bytes`),
    format: oneOf(value.format, ['woff2', 'woff', 'ttf', 'otf'] as const, `${where}.format`), subset: str(value.subset, `${where}.subset`, 64),
    style: oneOf(value.style, FONT_STYLES, `${where}.style`), weight: { min: weight(value.weight.min, where), max: weight(value.weight.max, where) },
    axes: list(value.axes, `${where}.axes`).map((entry, index) => axis(entry, `${where}.axes.${index}`)),
    cmap: str(value.cmap, `${where}.cmap`, CMAP_MAX_LENGTH),
    notice: { path: str(value.notice.path, `${where}.notice.path`, 500), sha256: str(value.notice.sha256, `${where}.notice.sha256`, 64) },
    provenance: str(value.provenance, `${where}.provenance`, 500),
  };
  if (!isSafeRelativePath(file.path) || !isSafeRelativePath(file.notice.path)) throw new CatalogueError(`${where}.path`);
  if (!HEX64.test(file.sha256) || !HEX64.test(file.notice.sha256)) throw new CatalogueError(`${where}.sha256`);
  if (!Number.isInteger(file.bytes) || file.bytes <= 0 || file.bytes > FONT_FILE_LIMIT || file.weight.min > file.weight.max) throw new CatalogueError(`${where}.bytes`);
  if (!FONT_UNICODE_RANGE_PATTERN.test(file.cmap)) throw new CatalogueError(`${where}.cmap`);
  parseUnicodeRanges(file.cmap);
  return file;
}
function family(value: unknown, where: string): FontCatalogueFamily {
  if (!isRecord(value) || !isRecord(value.licence) || !isRecord(value.source) || !isRecord(value.unicodeRanges)) throw new CatalogueError(where);
  const id = str(value.id, `${where}.id`, 100);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new CatalogueError(`${where}.id`);
  const subsets = list(value.subsets, `${where}.subsets`).map((entry, index) => str(entry, `${where}.subsets.${index}`, 64));
  const unicodeRanges: Record<string, string> = {};
  for (const [subset, range] of Object.entries(value.unicodeRanges)) {
    // The same grammar and bound as the contract's unicodeRange, so no valid catalogue entry
    // can produce a profile the contract rejects (and silently drops) downstream.
    unicodeRanges[subset] = str(range, `${where}.unicodeRanges.${subset}`, FONT_UNICODE_RANGE_MAX_LENGTH);
    if (!FONT_UNICODE_RANGE_PATTERN.test(unicodeRanges[subset]!)) throw new CatalogueError(`${where}.unicodeRanges.${subset}`);
    parseUnicodeRanges(unicodeRanges[subset]!);
  }
  const licence = value.licence; const source = value.source;
  const upstreamLicenceSha256 = licence.upstreamLicenceSha256 === null ? null : str(licence.upstreamLicenceSha256, `${where}.licence.upstreamLicenceSha256`, 64);
  if (upstreamLicenceSha256 !== null && !HEX64.test(upstreamLicenceSha256)) throw new CatalogueError(`${where}.licence.upstreamLicenceSha256`);
  const result: FontCatalogueFamily = {
    id, family: str(value.family, `${where}.family`, 200), category: oneOf(value.category, FONT_CATEGORIES, `${where}.category`),
    weights: list(value.weights, `${where}.weights`).map((entry, index) => weight(entry, `${where}.weights.${index}`)),
    styles: list(value.styles, `${where}.styles`).map((entry, index) => oneOf(entry, FONT_STYLES, `${where}.styles.${index}`)),
    subsets, defaultSubset: str(value.defaultSubset, `${where}.defaultSubset`, 64),
    axes: list(value.axes, `${where}.axes`).map((entry, index) => axis(entry, `${where}.axes.${index}`)), unicodeRanges,
    licence: {
      type: str(licence.type, `${where}.licence.type`, 80), url: nullableStr(licence.url, `${where}.licence.url`), attribution: nullableStr(licence.attribution, `${where}.licence.attribution`),
      upstreamLicenceSha256, reservedFontNames: list(licence.reservedFontNames, `${where}.licence.reservedFontNames`).map((entry, index) => str(entry, `${where}.licence.reservedFontNames.${index}`, 120)),
    },
    source: {
      packageName: str(source.packageName, `${where}.source.packageName`, 214), packageVersion: str(source.packageVersion, `${where}.source.packageVersion`, 64),
      upstreamVersion: str(source.upstreamVersion, `${where}.source.upstreamVersion`, 64), lastModified: str(source.lastModified, `${where}.source.lastModified`, 32),
      metadataSha256: str(source.metadataSha256, `${where}.source.metadataSha256`, 64), upstream: nullableStr(source.upstream, `${where}.source.upstream`),
    },
    spineFit: list(value.spineFit, `${where}.spineFit`).map((entry, index) => {
      if (!isRecord(entry)) throw new CatalogueError(`${where}.spineFit.${index}`);
      return { spine: oneOf(entry.spine, FONT_SPINE_CODES, `${where}.spineFit.${index}.spine`), fit: str(entry.fit, `${where}.spineFit.${index}.fit`, 400), counterFit: str(entry.counterFit, `${where}.spineFit.${index}.counterFit`, 400) };
    }),
    traits: list(value.traits ?? [], `${where}.traits`).map((entry, index) => {
      if (!isRecord(entry)) throw new CatalogueError(`${where}.traits.${index}`);
      return { trait: oneOf(entry.trait, FONT_TRAITS, `${where}.traits.${index}.trait`), reason: str(entry.reason, `${where}.traits.${index}.reason`, 400) };
    }),
    tones: list(value.tones ?? [], `${where}.tones`).map((entry, index) => oneOf(entry, FONT_TONES, `${where}.tones.${index}`)),
    localFiles: list(value.localFiles, `${where}.localFiles`).map((entry, index) => localFile(entry, `${where}.localFiles.${index}`)),
  };
  if (new Set(result.traits.map(entry => entry.trait)).size !== result.traits.length || new Set(result.tones).size !== result.tones.length) throw new CatalogueError(`${where}.traits`);
  if (!HEX64.test(result.source.metadataSha256) || !result.weights.length || !result.styles.length || !subsets.includes(result.defaultSubset)) throw new CatalogueError(where);
  if (new Set(result.spineFit.map(fit => fit.spine)).size !== result.spineFit.length) throw new CatalogueError(`${where}.spineFit`);
  // A Reserved Font Name binds the family that uses it; a shared notice must not leak it to another family.
  if (result.licence.reservedFontNames.some(name => !result.family.includes(name))) throw new CatalogueError(`${where}.licence.reservedFontNames`);
  for (const file of result.localFiles) if (!subsets.includes(file.subset) || !unicodeRanges[file.subset]) throw new CatalogueError(`${where}.localFiles subset`);
  return result;
}
/** Validates an untrusted catalogue value (the committed snapshot or a test fixture). */
export function validateFontCatalogue(value: unknown): FontCatalogue {
  if (!isRecord(value) || value.schema !== 'od-font-catalogue/1' || !isRecord(value.source) || !isRecord(value.localBytes)) throw new CatalogueError('envelope');
  const commit = str(value.source.commit, 'source.commit', 40);
  if (!/^[a-f0-9]{40}$/.test(commit) || value.localBytes.root !== 'bundled-plugins') throw new CatalogueError('source');
  const families = list(value.families, 'families').map((entry, index) => family(entry, `families.${index}`));
  if (new Set(families.map(entry => entry.id)).size !== families.length) throw new CatalogueError('duplicate family id');
  return {
    schema: 'od-font-catalogue/1',
    source: { repository: str(value.source.repository, 'source.repository', 200), commit, retrievedAt: str(value.source.retrievedAt, 'source.retrievedAt', 32), retrieval: str(value.source.retrieval, 'source.retrieval'), licence: str(value.source.licence, 'source.licence') },
    classification: str(value.classification, 'classification'),
    localBytes: { root: 'bundled-plugins', measuredWith: str(value.localBytes.measuredWith, 'localBytes.measuredWith', 200), method: str(value.localBytes.method, 'localBytes.method') },
    families,
  };
}
let bundled: FontCatalogue | null = null;
/** The committed snapshot, validated once. Callers receive the shared frozen-in-practice value; copy before editing. */
export function bundledFontCatalogue(): FontCatalogue {
  bundled ??= validateFontCatalogue(snapshotJson as unknown);
  return bundled;
}
