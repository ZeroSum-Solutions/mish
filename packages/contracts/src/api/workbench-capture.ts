import { z } from 'zod';
import type { ProjectKind } from './projects.js';
import { operationRightSchema } from './workbench-source-admission.js';

// R14 capture records (AC-R14.1) and reusable-unit save (AC-R14.3).
// Stored server records and request shapes only: parsing proves shape, never
// authority, rights or that bytes exist. The daemon computes ids, hashes,
// timestamps, capture permission and rights status; clients cannot set them.

const text = (max: number) => z.string().min(1).max(max).refine(value => value === value.trim() && !/[\p{Cc}]/u.test(value), 'Expected trimmed text without control characters');
const note = (max: number) => z.string().min(1).max(max).refine(value => !/[\p{Cc}]/u.test(value.replace(/[\n\t]/gu, '')), 'Control characters are not allowed');
const projectId = text(200);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/u);
const timestamp = z.string().datetime({ offset: false });
const dimension = z.number().int().min(1).max(16_384);
const coordinate = z.number().int().min(0).max(16_384);
const unique = (values: readonly string[]) => new Set(values).size === values.length;
/** A normalized project-relative path: no absolute, drive, backslash, empty, `.` or `..` segment. */
export const workbenchRelativePathSchema = z.string().min(1).max(1000).refine(value =>
  !/[\p{Cc}\p{Cf}\\]/u.test(value) && !value.startsWith('/') && !/^[A-Za-z]:/u.test(value)
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), 'Expected a normalized project-relative path');

export const WORKBENCH_CAPTURE_ID_PATTERN = /^cap_[A-Za-z0-9_-]{16,64}$/u;
export const WORKBENCH_UNIT_ID_PATTERN = /^unit_[A-Za-z0-9_-]{16,64}$/u;
/** Inclusive upper bound for one captured image. */
export const WORKBENCH_CAPTURE_MAX_BYTES = 25 * 1024 * 1024;
/** Raster formats only. SVG and HTML are scriptable and never accepted as a capture. */
export const WORKBENCH_CAPTURE_MEDIA_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
/** Metadata travels in this request header as base64url JSON; bytes travel as the raw body. */
export const WORKBENCH_CAPTURE_METADATA_HEADER = 'x-od-capture-metadata';
export const WORKBENCH_CAPTURE_METADATA_MAX_BYTES = 8 * 1024;
export const WORKBENCH_UNIT_LIMITS = { maxFiles: 64, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 } as const;

/**
 * native-page / native-region: desktop browser canvas compositor capture.
 * upload / paste: a screenshot the user supplied. screen-share: browser
 * getDisplayMedia after the user granted permission for that one frame.
 */
export const WORKBENCH_CAPTURE_MODES = ['native-page', 'native-region', 'upload', 'paste', 'screen-share'] as const;
export type WorkbenchCaptureMode = (typeof WORKBENCH_CAPTURE_MODES)[number];

export const WORKBENCH_RIGHTS_BASES = ['model-authored', 'user-owned', 'licensed', 'captured-third-party'] as const;
export const WORKBENCH_RIGHTS_STATUSES = ['redistributable', 'incorporation-only', 'private-use-only', 'reference-only', 'unknown'] as const;
export type WorkbenchRightsStatus = (typeof WORKBENCH_RIGHTS_STATUSES)[number];
/**
 * Where a user declaration was written: the web app, `od`, or raw HTTP. A label
 * from request metadata, not authentication; agent tool-token requests are refused.
 */
export const WORKBENCH_DECLARATION_SURFACES = ['web', 'cli', 'http'] as const;
export type WorkbenchDeclarationSurface = (typeof WORKBENCH_DECLARATION_SURFACES)[number];

/**
 * A user declaration, recorded as such; it is not imported license evidence and
 * it never sets `rights.status` directly. `scope.paths` limits it to listed
 * unit files; without a scope it covers every included file.
 */
export const rightsDeclarationSchema = z.object({
  basis: z.enum(WORKBENCH_RIGHTS_BASES),
  evidenceRefs: z.array(text(500)).max(20).refine(unique, 'Duplicate evidence reference'),
  notices: z.array(note(1000)).max(20),
  privateUseAttestation: note(500).optional(),
  scope: z.object({
    assetIds: z.array(text(200)).max(100).refine(unique).optional(),
    paths: z.array(workbenchRelativePathSchema).max(WORKBENCH_UNIT_LIMITS.maxFiles).refine(unique).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.basis === 'licensed' && value.evidenceRefs.length === 0) ctx.addIssue({ code: 'custom', path: ['evidenceRefs'], message: 'A licensed source needs at least one evidence reference' });
});
export type RightsDeclaration = z.infer<typeof rightsDeclarationSchema>;

const viewportSchema = z.object({ width: dimension, height: dimension, deviceScaleFactor: z.number().min(0.25).max(8) }).strict();
const frameSchema = z.object({ width: dimension, height: dimension }).strict();
const regionSchema = z.object({ x: coordinate, y: coordinate, width: dimension, height: dimension }).strict();

/**
 * Client metadata for one capture. There is deliberately no URL-to-fetch field:
 * the daemon stores bytes the user's own host or file supplied and never
 * scrapes a page. `sourceUrl` is provenance only and is redacted on save.
 */
export const captureImportMetadataSchema = z.object({
  projectId,
  captureMode: z.enum(WORKBENCH_CAPTURE_MODES),
  sourceUrl: z.string().min(1).max(4096).nullable().optional(),
  sourceTitle: text(300).nullable().optional(),
  /** The browser viewport in CSS pixels (native) or the shared frame (screen-share). Unknown for upload/paste. */
  viewport: viewportSchema.nullable().optional(),
  /** Pixel size of the whole frame before any crop. */
  frame: frameSchema,
  /** Crop rectangle in frame pixels; absent means the whole frame was saved. */
  region: regionSchema.nullable().optional(),
  rightsDeclaration: rightsDeclarationSchema.optional(),
  parentCaptureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN).nullable().optional(),
}).strict().superRefine((value, ctx) => {
  const native = value.captureMode === 'native-page' || value.captureMode === 'native-region';
  if (native && !value.viewport) ctx.addIssue({ code: 'custom', path: ['viewport'], message: 'Desktop canvas captures record their viewport' });
  if (value.captureMode === 'native-region' && !value.region) ctx.addIssue({ code: 'custom', path: ['region'], message: 'A region capture records its region' });
  if (value.captureMode === 'native-page' && value.region) ctx.addIssue({ code: 'custom', path: ['region'], message: 'A page capture has no region' });
  if (value.region && (value.region.x + value.region.width > value.frame.width || value.region.y + value.region.height > value.frame.height)) {
    ctx.addIssue({ code: 'custom', path: ['region'], message: 'The region must lie inside the captured frame' });
  }
});
export type CaptureImportMetadata = z.infer<typeof captureImportMetadataSchema>;

export const captureRecordSchema = z.object({
  schema: z.literal('workbench-capture/1'),
  id: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN),
  /** Library image asset that holds the immutable bytes. */
  assetId: text(200),
  projectId,
  captureMode: z.enum(WORKBENCH_CAPTURE_MODES),
  /** http(s) origin and path only: credentials, query and fragment are never stored. */
  sourceUrl: z.string().max(2048).nullable(),
  sourceUrlRedacted: z.boolean(),
  sourceTitle: z.string().max(300).nullable(),
  viewport: viewportSchema.nullable(),
  frame: frameSchema,
  region: regionSchema.nullable(),
  image: z.object({ mediaType: z.enum(WORKBENCH_CAPTURE_MEDIA_TYPES), width: dimension, height: dimension, bytes: z.number().int().min(1).max(WORKBENCH_CAPTURE_MAX_BYTES) }).strict(),
  contentHash: sha256,
  /** Server-derived from the capture mode: what authorized taking these pixels. */
  capturePermission: z.enum(['desktop-host-user-action', 'user-supplied-file', 'browser-display-media']),
  /** A screenshot is evidence, never permission to copy the captured source. */
  rightsDeclaration: rightsDeclarationSchema.nullable(),
  /** Set exactly when a declaration is present. */
  rightsDeclaredVia: z.enum(WORKBENCH_DECLARATION_SURFACES).nullable(),
  parentCaptureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN).nullable(),
  createdAt: timestamp,
}).strict();
export type CaptureRecord = z.infer<typeof captureRecordSchema>;

export const captureViewSchema = z.object({
  capture: captureRecordSchema,
  /** False when the library bytes were deleted later; the record itself never changes. */
  bytesAvailable: z.boolean(),
  imageUrl: z.string().regex(/^\/api\/workbench\/captures\/cap_[A-Za-z0-9_-]+\/image\?projectId=[^\s]+$/u),
}).strict();
export type CaptureView = z.infer<typeof captureViewSchema>;
export const captureListSchema = z.object({ projectId, captures: z.array(captureViewSchema).max(100), nextCursor: z.string().max(200).nullable() }).strict();
export type CaptureList = z.infer<typeof captureListSchema>;

// ---------------------------------------------------------------------------
// Reusable units (AC-R14.3)
// ---------------------------------------------------------------------------

export const WORKBENCH_UNIT_KINDS = ['component', 'block', 'section', 'page'] as const;
/** Every current ProjectKind receives the standalone html-artifact/v1 placement; inline embedding is not claimed. */
export const WORKBENCH_UNIT_STANDALONE_TARGET_KINDS = ['prototype', 'deck', 'template', 'other', 'brand', 'image', 'video', 'audio'] as const satisfies readonly ProjectKind[];
// A newly introduced project kind must join standalone insertion support.
const allStandaloneKinds: Record<ProjectKind, true> = Object.fromEntries(WORKBENCH_UNIT_STANDALONE_TARGET_KINDS.map(kind => [kind, true])) as Record<typeof WORKBENCH_UNIT_STANDALONE_TARGET_KINDS[number], true>;
void allStandaloneKinds;
const rootSelector = text(300);
const unitName = text(120);
const actionSchema = z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), purpose: text(300), selector: text(300) }).strict();

const unitSourceSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('project'), projectId,
    /** The HTML document the unit opens with; defaults to the only HTML file listed. */
    entry: workbenchRelativePathSchema.optional(),
    paths: z.array(workbenchRelativePathSchema).min(1).max(WORKBENCH_UNIT_LIMITS.maxFiles).refine(unique, 'Duplicate path'),
    rootSelector,
    /** SHA-256 the user reviewed for each listed path (from a plan); required to save, and any change returns 409. */
    expectedHashes: z.record(workbenchRelativePathSchema, sha256).optional(),
  }).strict(),
  z.object({ kind: z.literal('draft'), draftId: text(200), revision: z.number().int().min(1), rootSelector }).strict(),
]);

export const unitSaveRequestSchema = z.object({
  source: unitSourceSchema,
  kind: z.enum(WORKBENCH_UNIT_KINDS),
  name: unitName,
  rightsDeclaration: rightsDeclarationSchema.optional(),
  /** Capture this unit was reconstructed from, recorded as lineage only. */
  captureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN).optional(),
  /** Listed files the user chose to leave out; every exclusion the plan proposes must be acknowledged here. */
  excludePaths: z.array(workbenchRelativePathSchema).max(WORKBENCH_UNIT_LIMITS.maxFiles).refine(unique).optional(),
  actions: z.array(actionSchema).max(20).optional(),
}).strict().superRefine((value, ctx) => {
  if (value.source.kind !== 'project') return;
  const listed = new Set(value.source.paths);
  const hashes = value.source.expectedHashes;
  if (hashes) {
    for (const path of Object.keys(hashes)) if (!listed.has(path)) ctx.addIssue({ code: 'custom', path: ['source', 'expectedHashes', path], message: 'Hash given for an unlisted path' });
    for (const path of value.source.paths) if (!(path in hashes)) ctx.addIssue({ code: 'custom', path: ['source', 'expectedHashes'], message: `Missing expected hash for ${path}` });
  }
  if (value.source.entry && !listed.has(value.source.entry)) ctx.addIssue({ code: 'custom', path: ['source', 'entry'], message: 'The entry must be one of the listed paths' });
  for (const path of value.excludePaths ?? []) if (!listed.has(path)) ctx.addIssue({ code: 'custom', path: ['excludePaths'], message: `Excluded path is not listed: ${path}` });
  if (new Set((value.actions ?? []).map(action => action.id)).size !== (value.actions ?? []).length) ctx.addIssue({ code: 'custom', path: ['actions'], message: 'Duplicate action id' });
});
export type UnitSaveRequest = z.infer<typeof unitSaveRequestSchema>;

const fileRole = z.enum(['entry', 'style', 'script', 'markup', 'asset', 'notice']);
const dependencySchema = z.object({
  name: text(300),
  /** Exact version parsed from a pinned URL, or `unpinned`; saving never installs it. */
  version: text(100),
  license: text(100),
  required: z.boolean(),
  source: z.enum(['remote-url', 'bare-import']),
  url: z.string().max(2048).nullable(),
  referencedFrom: workbenchRelativePathSchema,
}).strict();
const excludedFileSchema = z.object({
  path: workbenchRelativePathSchema, sha256,
  reason: z.enum(['captured-third-party', 'user-excluded']),
}).strict();
const blockerSchema = z.object({
  code: z.enum(['root-not-found', 'entry-missing', 'closure-incomplete', 'unpinned-dependency', 'secret-detected', 'exclusion-unacknowledged', 'rights-blocked', 'entry-excluded']),
  message: text(500),
  paths: z.array(workbenchRelativePathSchema).max(WORKBENCH_UNIT_LIMITS.maxFiles * 4),
}).strict();
const rightsSchema = z.object({
  status: z.enum(WORKBENCH_RIGHTS_STATUSES),
  basis: z.enum(WORKBENCH_RIGHTS_BASES).nullable(),
  evidenceRefs: z.array(text(500)).max(20),
  notices: z.array(note(1000)).max(20),
  privateUseAttestation: note(500).optional(),
  /** Per-file outcome; the aggregate is their most restrictive status. */
  files: z.array(z.object({ path: workbenchRelativePathSchema, basis: z.enum(WORKBENCH_RIGHTS_BASES).nullable(), status: z.enum(WORKBENCH_RIGHTS_STATUSES) }).strict()).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  /** Recorded as a user declaration through an authenticated request, never inferred by a model. */
  declaredBy: z.enum(['user-request', 'none']),
  declaredVia: z.enum(WORKBENCH_DECLARATION_SURFACES).nullable(),
}).strict();

/** Plan of a save: what would be stored, excluded or blocked. Nothing is written. */
export const unitSavePlanSchema = z.object({
  schema: z.literal('reusable-unit-plan/1'),
  format: z.literal('html-css-js'),
  entry: workbenchRelativePathSchema.nullable(),
  rootSelector,
  rootFound: z.boolean(),
  /** Suggested roots (segmentation is a suggestion, never a decision). */
  rootCandidates: z.array(rootSelector).max(40),
  files: z.array(z.object({ path: workbenchRelativePathSchema, sha256, bytes: z.number().int().min(0), mediaType: text(200), role: fileRole, included: z.boolean() }).strict()).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  excludedFiles: z.array(excludedFileSchema).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  /** Local files the entry references that are not listed. */
  missingReferences: z.array(workbenchRelativePathSchema).max(400),
  dependencies: z.array(dependencySchema).max(100),
  capabilities: z.array(z.enum(['script', 'network', 'form', 'animation', 'webgl'])).max(5),
  rights: rightsSchema,
  operationRights: z.array(operationRightSchema).max(10),
  blockers: z.array(blockerSchema).max(50),
  warnings: z.array(text(500)).max(50),
}).strict();
export type UnitSavePlan = z.infer<typeof unitSavePlanSchema>;

export const reusableUnitManifestSchema = z.object({
  schema: z.literal('reusable-unit/1'),
  unitId: z.string().regex(WORKBENCH_UNIT_ID_PATTERN),
  revision: z.number().int().min(1),
  name: unitName,
  kind: z.enum(WORKBENCH_UNIT_KINDS),
  format: z.enum(['html-css-js', 'react-tsx']),
  entry: workbenchRelativePathSchema,
  rootSelector,
  /** Editable source files (HTML/CSS/JS) copied out of the project at save time. */
  files: z.array(z.object({ path: workbenchRelativePathSchema, assetId: text(200), sha256, mediaType: text(200), role: fileRole }).strict()).min(1).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  /** Binary assets (images, fonts, media) the unit carries with permitted rights. */
  assets: z.array(z.object({ path: workbenchRelativePathSchema, assetId: text(200), sha256, role: text(40) }).strict()).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  excludedFiles: z.array(excludedFileSchema).max(WORKBENCH_UNIT_LIMITS.maxFiles),
  dependencies: z.array(dependencySchema).max(100),
  tokens: z.array(z.object({ name: z.string().regex(/^--[A-Za-z0-9_-]{1,100}$/u), fallback: z.string().max(200) }).strict()).max(200),
  capabilities: z.array(z.enum(['script', 'network', 'form', 'animation', 'webgl'])).max(5),
  compatibility: z.object({ targetKinds: z.array(z.enum(WORKBENCH_UNIT_STANDALONE_TARGET_KINDS)).max(8), adapterVersion: z.literal('html-artifact/v1'), inlineAdapters: z.array(text(80)).max(10) }).strict(),
  /** Declared actions; insertion places files and leaves action verification to the actual preview. */
  actions: z.array(z.object({ id: z.string().regex(/^[a-z][a-z0-9-]{0,62}$/u), purpose: text(300), selector: text(300), verificationProbeId: z.string().max(120).nullable() }).strict()).max(20),
  provenance: z.object({
    captureAssetId: z.string().max(200).optional(),
    captureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN).optional(),
    draftRevisionId: z.string().max(200).optional(),
    projectId: projectId.optional(),
    projectSourceHashes: z.record(workbenchRelativePathSchema, sha256).optional(),
    sources: z.array(text(500)).max(20),
  }).strict(),
  operationRights: z.array(operationRightSchema).max(10),
  rights: rightsSchema,
  thumbnail: z.discriminatedUnion('source', [
    z.object({ source: z.literal('rendered'), assetId: text(200), sha256, width: dimension, height: dimension }).strict(),
    z.object({ source: z.literal('capture'), captureId: z.string().regex(WORKBENCH_CAPTURE_ID_PATTERN), assetId: text(200) }).strict(),
    z.object({ source: z.literal('unavailable'), reason: text(500) }).strict(),
  ]),
  previewArtifactId: z.string().max(200).nullable(),
  verificationBundleId: z.string().max(200).nullable(),
  principalId: text(300),
  createdAt: timestamp,
}).strict().superRefine((value, ctx) => {
  if (!value.provenance.draftRevisionId && !value.provenance.projectSourceHashes) ctx.addIssue({ code: 'custom', path: ['provenance'], message: 'A unit records a draft revision or project source hashes' });
  if (!value.files.some(file => file.path === value.entry)) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'The entry must be a stored file' });
});
export type ReusableUnitManifest = z.infer<typeof reusableUnitManifestSchema>;
export const unitListSchema = z.object({ units: z.array(reusableUnitManifestSchema).max(200) }).strict();
export type UnitList = z.infer<typeof unitListSchema>;

export function parseCaptureImportMetadata(input: unknown): CaptureImportMetadata { return captureImportMetadataSchema.parse(input); }
export function parseCaptureRecord(input: unknown): CaptureRecord { return captureRecordSchema.parse(input); }
export function parseCaptureView(input: unknown): CaptureView { return captureViewSchema.parse(input); }
export function parseCaptureList(input: unknown): CaptureList { return captureListSchema.parse(input); }
export function parseUnitSaveRequest(input: unknown): UnitSaveRequest { return unitSaveRequestSchema.parse(input); }
export function parseUnitSavePlan(input: unknown): UnitSavePlan { return unitSavePlanSchema.parse(input); }
export function parseReusableUnitManifest(input: unknown): ReusableUnitManifest { return reusableUnitManifestSchema.parse(input); }
export function parseUnitList(input: unknown): UnitList { return unitListSchema.parse(input); }

/** UTF-8 JSON → base64url, for the capture metadata header. Pure; no Buffer or btoa dependency. */
export function encodeCaptureMetadataHeader(metadata: CaptureImportMetadata): string {
  const bytes = new TextEncoder().encode(JSON.stringify(metadata));
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i]!, b = bytes[i + 1], c = bytes[i + 2];
    out += alphabet[a >> 2]! + alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) out += alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)]!;
    if (c !== undefined) out += alphabet[c & 63]!;
  }
  return out;
}
