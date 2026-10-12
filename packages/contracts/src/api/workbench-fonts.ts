import { z } from 'zod';
import { resourceRefSchema } from './workbench-resource-ref.js';

/**
 * AC-R11 font profile carried by `fonts` resource results, plus the R11.2 check
 * DTOs shared by `POST /api/workbench/fonts/check` and `od workbench font-check`.
 * Additive only: older clients ignore the optional `fontProfile` field.
 */
export const FONT_SPINE_CODES = ['TL', 'PA', 'CO', 'SM', 'CS', 'LM', 'BA', 'TU', 'MI'] as const;
export const FONT_STYLES = ['normal', 'italic'] as const;
export const FONT_CATEGORIES = ['sans-serif', 'serif', 'display', 'handwriting', 'monospace', 'other'] as const;
/** Curated Mishh Mashh judgments, each with its reason; never source claims. */
export const FONT_TRAITS = ['small-size-legibility'] as const;
export const FONT_TONES = ['friendly', 'formal', 'technical', 'editorial', 'civic', 'expressive'] as const;
export const FONT_REQUIREMENT_KINDS = ['script', 'legibility', 'italic', 'tone'] as const;
const text = z.string().min(1);
const hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const weight = z.number().int().min(1).max(1000);
const sameOriginPath = z.string().regex(/^\/(?![/\\])[^\s\\]*$/u, 'Expected a same-origin path');
const unique = <T>(values: readonly T[]) => new Set(values).size === values.length;
const grant = z.enum(['permitted', 'unknown', 'blocked']);
/** One unicode-range grammar for the contract and the daemon catalogue: uppercase hex, bounded length. */
export const FONT_UNICODE_RANGE_PATTERN = /^U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?(?:,\s*U\+[0-9A-F?]{1,6}(?:-[0-9A-F]{1,6})?)*$/u;
export const FONT_UNICODE_RANGE_MAX_LENGTH = 4000;

export const fontAxisSchema = z.object({
  tag: z.string().regex(/^[A-Za-z0-9]{4}$/u), min: z.number().finite(), max: z.number().finite(), default: z.number().finite(),
}).strict().refine(axis => axis.min <= axis.default && axis.default <= axis.max, 'Axis default must lie within its range');
export const fontSpineFitSchema = z.object({ spine: z.enum(FONT_SPINE_CODES), fit: text.max(400), counterFit: text.max(400) }).strict();
export const fontLicenceSchema = z.object({
  /** Upstream SPDX-style licence id, or `unknown`. */
  type: text.max(80), recognised: z.boolean(),
  attribution: z.string().max(2000).nullable(), url: z.string().max(500).nullable(),
  upstreamLicenceSha256: hex64.nullable(), reservedFontNames: z.array(text.max(120)).max(16),
  commercialUse: grant, webEmbedding: grant, redistribution: grant,
  /** Plain-language modification/subsetting rule (Reserved Font Name review, upstream subsets only). */
  modification: text.max(500),
  /** sha256 of the primary source's copyright notice text; null when that source names none. */
  noticeSha256: hex64.nullable().optional(),
}).strict();
export const fontLocalFileSchema = z.object({
  sha256: hex64, bytes: z.number().int().positive(), format: z.enum(['woff2', 'woff', 'ttf', 'otf']),
  subset: text.max(64),
  /** The upstream subset's declared unicode-range, for @font-face/FontFace descriptors. */
  unicodeRange: z.string().max(FONT_UNICODE_RANGE_MAX_LENGTH).regex(FONT_UNICODE_RANGE_PATTERN),
  style: z.enum(FONT_STYLES), weight: z.object({ min: weight, max: weight }).strict().refine(range => range.min <= range.max),
  axes: z.array(fontAxisSchema).max(16),
  state: z.enum(['available', 'unavailable']), reason: z.string().max(200).nullable(), url: sameOriginPath.optional(),
  notice: z.object({ sha256: hex64, state: z.enum(['available', 'unavailable']), url: sameOriginPath.optional() }).strict(),
  provenance: text.max(500),
}).strict().superRefine((file, ctx) => {
  if (file.state === 'available' && (!file.url || file.reason !== null)) ctx.addIssue({ code: 'custom', message: 'An available local file names its same-origin URL and no reason' });
  if (file.state === 'unavailable' && (file.url || !file.reason)) ctx.addIssue({ code: 'custom', message: 'An unavailable local file has a reason and no URL' });
});
export const FONT_SOURCE_KINDS = ['fontsource', 'google-fonts', 'fontshare'] as const;
const sha40 = z.string().regex(/^[a-f0-9]{40}$/u);
const httpsUrl = z.string().max(500).regex(/^https:\/\/[^\s/\\?#]+[^\s\\]*$/u);
export const fontPrimarySourceSchema = z.discriminatedUnion('metadata', [
  z.object({
    metadata: z.literal('fontsource/font-files'), commit: sha40,
    packageName: text.max(214), packageVersion: text.max(64), upstreamVersion: text.max(64), lastModified: text.max(32), metadataSha256: hex64,
  }).strict(),
  /** github.com/google/fonts at a pinned commit: the family's METADATA.pb and licence file. */
  z.object({ metadata: z.literal('google/fonts'), commit: sha40, path: text.max(200), metadataSha256: hex64 }).strict(),
  /** The published Fontshare family list, fetched once and pinned by digest. */
  z.object({ metadata: z.literal('fontshare'), retrievedAt: text.max(32), slug: text.max(120), version: text.max(64), listingSha256: hex64, listingRecordSha256: hex64 }).strict(),
]);
/**
 * One pinned source's record of a family. Digests are sha256: `licenceSha256` of the
 * source's licence file bytes, `noticeSha256` of its copyright notice text. A missing
 * digest always carries a reason. `localFile` says whether that source's bytes are
 * admitted locally; metadata-only sources say `none` (no local file admitted).
 */
export const fontSourceRecordSchema = z.object({
  source: z.enum(FONT_SOURCE_KINDS), identity: text.max(214), revision: text.max(64), url: httpsUrl.nullable(),
  licenceType: text.max(80), licenceSha256: hex64.nullable(), noticeSha256: hex64.nullable(), reason: z.string().max(300).nullable(),
  localFile: z.enum(['admitted', 'none']),
}).strict().superRefine((record, ctx) => {
  if ((record.licenceSha256 === null || record.noticeSha256 === null) && !record.reason) ctx.addIssue({ code: 'custom', message: 'A missing licence or notice digest names its reason' });
});
export const FONT_KIT_ROOTS = ['bundled-plugins', 'design-templates', 'design-systems'] as const;
/** How a kit's own files load the family today. */
export const FONT_KIT_LOADING = ['local-font-face', 'google-fonts-css', 'fontshare-css', 'other-remote', 'none'] as const;
export const FONT_KIT_STATES = ['mapped', 'undeclared'] as const;
/** Why a declared family has no admitted local bytes to map to. */
export const FONT_KIT_REASONS = ['no-admitted-local-file', 'rights-restricted', 'licence-unknown', 'kit-bytes-not-admitted', 'system-font', 'not-in-catalogue'] as const;
export const fontKitDeclarationSchema = z.object({
  root: z.enum(FONT_KIT_ROOTS), kit: text.max(200),
  /** The family name exactly as the kit declares it (first spelling seen). */
  family: text.max(200),
  files: z.array(text.max(500)).min(1).max(20), fileCount: z.number().int().positive(),
  loading: z.array(z.enum(FONT_KIT_LOADING)).min(1).max(FONT_KIT_LOADING.length).refine(unique),
  remoteHosts: z.array(text.max(200)).max(10),
  state: z.enum(FONT_KIT_STATES), reason: z.enum(FONT_KIT_REASONS).nullable(), message: text.max(500),
  /** The fonts-source item this family resolves to by identity or by admitted bytes; never a substitute. */
  catalogueItemId: z.string().max(100).nullable(),
  admittedFiles: z.array(hex64).max(64),
  /** For a kit that self-hosts the family: whether its own bytes are admitted bytes. */
  kitBytesAdmitted: z.boolean().nullable(),
}).strict().superRefine((entry, ctx) => {
  if (entry.state === 'mapped' && (entry.reason !== null || !entry.admittedFiles.length || !entry.catalogueItemId)) ctx.addIssue({ code: 'custom', message: 'A mapped family names its catalogue item and admitted files, and no reason' });
  if (entry.state === 'undeclared' && (entry.reason === null || entry.admittedFiles.length)) ctx.addIssue({ code: 'custom', message: 'An undeclared family names its reason and maps to no admitted file' });
});
export const fontProfileSchema = z.object({
  schema: z.literal('font-profile/1'),
  family: text.max(200), category: z.enum(FONT_CATEGORIES),
  weights: z.array(weight).min(1).max(20).refine(unique), styles: z.array(z.enum(FONT_STYLES)).min(1).max(2).refine(unique),
  subsets: z.array(text.max(64)).min(1).max(200).refine(unique), defaultSubset: text.max(64), axes: z.array(fontAxisSchema).max(16),
  licence: fontLicenceSchema,
  /** The primary source of this family's metadata; every source that lists it is in `sources`. */
  source: fontPrimarySourceSchema,
  /** Curated fit per project-purpose spine; never a mandatory or exclusive pick. */
  spineFit: z.array(fontSpineFitSchema).max(9).refine(fits => unique(fits.map(fit => fit.spine)), 'Duplicate spine'),
  localFiles: z.array(fontLocalFileSchema).max(64),
  /** AC-R11.3 constraint matching: curated traits and brand tones. */
  traits: z.array(z.object({ trait: z.enum(FONT_TRAITS), reason: text.max(400) }).strict()).max(FONT_TRAITS.length).optional(),
  tones: z.array(z.enum(FONT_TONES)).max(FONT_TONES.length).refine(unique).optional(),
  /** AC-R11 preamble: every pinned source that lists this family, deduplicated by family identity. */
  sources: z.array(fontSourceRecordSchema).min(1).max(FONT_SOURCE_KINDS.length).refine(records => unique(records.map(record => record.source)), 'Duplicate source').optional(),
  /** AC-R11 preamble: bundled kits and examples that declare this family, and what they map to. */
  kitDeclarations: z.array(fontKitDeclarationSchema).max(200).optional(),
}).strict();
export type FontProfile = z.infer<typeof fontProfileSchema>;
export type FontSourceRecord = z.infer<typeof fontSourceRecordSchema>;
export type FontKitDeclaration = z.infer<typeof fontKitDeclarationSchema>;
/** One line naming a family's primary metadata source and its pinned revision. */
export function describeFontSource(source: FontProfile['source']): string {
  if (source.metadata === 'fontsource/font-files') return `${source.packageName}@${source.packageVersion} · ${source.upstreamVersion} · ${source.metadata}@${source.commit.slice(0, 7)}`;
  if (source.metadata === 'google/fonts') return `${source.path} · ${source.metadata}@${source.commit.slice(0, 7)}`;
  return `fontshare/${source.slug}@${source.version} · ${source.metadata} listing ${source.retrievedAt}`;
}
/**
 * AC-R11 preamble search-level report: every font family a bundled kit or example
 * declares, mapped to admitted local bytes where they exist and otherwise flagged as
 * undeclared with a named reason. No family is ever substituted by another.
 */
export const fontKitInventorySchema = z.object({
  schema: z.literal('font-kit-inventory/1'),
  scanned: z.object({
    roots: z.array(z.enum(FONT_KIT_ROOTS)).max(FONT_KIT_ROOTS.length), kits: z.number().int().nonnegative(), files: z.number().int().nonnegative(),
    /** True when a bound (file count or size) stopped the scan early. */
    truncated: z.boolean(),
  }).strict(),
  declarations: z.array(fontKitDeclarationSchema).max(4000),
  counts: z.object({
    mapped: z.number().int().nonnegative(), undeclared: z.number().int().nonnegative(),
    byReason: z.object(Object.fromEntries(FONT_KIT_REASONS.map(reason => [reason, z.number().int().nonnegative()])) as Record<typeof FONT_KIT_REASONS[number], z.ZodNumber>).strict(),
  }).strict(),
}).strict();
export type FontKitInventory = z.infer<typeof fontKitInventorySchema>;
/**
 * AC-R11.3 search-level report of the saved project constraints that rerank fonts:
 * every interpreted requirement with how many fonts meet it (zero is stated, never
 * hidden), and every non-motion constraint that is not a font requirement.
 */
export const fontConstraintReportSchema = z.object({
  requirements: z.array(z.object({
    id: text.max(120), kind: z.enum(FONT_REQUIREMENT_KINDS), value: text.max(80),
    /** JSON pointer into the saved project context, e.g. /constraints/0/value. */
    source: text.max(256), strength: z.enum(['required', 'preferred']),
    satisfiedCount: z.number().int().nonnegative(), message: text.max(500),
  }).strict()).max(40),
  uninterpreted: z.array(z.object({ source: text.max(256), message: text.max(500) }).strict()).max(40),
  fontsConsidered: z.number().int().nonnegative(), fontsMeetingAllRequired: z.number().int().nonnegative(),
}).strict();
export type FontConstraintReport = z.infer<typeof fontConstraintReportSchema>;
export type FontLocalFile = z.infer<typeof fontLocalFileSchema>;

const glyphSchema = z.object({ char: z.string().min(1).max(8), codepoint: z.string().regex(/^U\+[0-9A-F]{4,6}$/u) }).strict();
const localState = z.enum(['available', 'missing', 'no-local-file']);
export const fontCheckRequestSchema = z.object({
  refKey: text.max(20000), projectId: text.max(200).optional(),
  text: z.string().max(2000).default(''),
  weights: z.array(weight).max(9).optional(), styles: z.array(z.enum(FONT_STYLES)).max(2).optional(),
  subsets: z.array(text.max(64)).max(32).optional(),
}).strict();
export const fontCheckResponseSchema = z.object({
  schema: z.literal('font-check/1'), ref: resourceRefSchema, refKey: text, family: text,
  glyphs: z.object({
    checked: z.number().int().nonnegative(),
    /** Against the upstream subsets' declared unicode-range (metadata, not the font's cmap). */
    declared: z.object({
      missing: z.array(glyphSchema).max(100), missingCount: z.number().int().nonnegative(),
      /** `no-declared-ranges` when the source publishes no unicode-range metadata (nothing was checked). */
      state: z.enum(['checked', 'no-declared-ranges']).optional(),
    }).strict(),
    /** Against the cmap of the admitted local files, measured when the snapshot was made. */
    local: z.object({ state: z.enum(['checked', 'no-local-file']), missing: z.array(glyphSchema).max(100), missingCount: z.number().int().nonnegative() }).strict(),
  }).strict(),
  weights: z.array(z.object({ weight, declared: z.boolean(), local: localState }).strict()).max(9),
  styles: z.array(z.object({ style: z.enum(FONT_STYLES), declared: z.boolean(), local: localState }).strict()).max(2),
  subsets: z.array(z.object({ subset: text, declared: z.boolean(), local: localState }).strict()).max(32),
  fallback: z.object({ stack: text, glyphsRenderedByFallback: z.number().int().nonnegative() }).strict(),
  licence: fontLicenceSchema,
  /** Script-free specimen of the local files; null when no local file is available. */
  specimenUrl: sameOriginPath.nullable(),
  passed: z.boolean(), notes: z.array(text.max(500)).max(20),
}).strict();
export type FontCheckRequest = z.input<typeof fontCheckRequestSchema>;
export type FontCheckResponse = z.infer<typeof fontCheckResponseSchema>;
export function parseFontCheckRequest(input: unknown): z.infer<typeof fontCheckRequestSchema> { return fontCheckRequestSchema.parse(input); }
export function parseFontCheckResponse(input: unknown): FontCheckResponse { return fontCheckResponseSchema.parse(input); }
