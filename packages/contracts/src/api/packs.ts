// Licensed packs (Licensed Pack plan, Phase 1 item 1): the `mishh-pack@1`
// manifest (`pack.json`) and the DTOs the daemon serves for installed packs.
//
// A pack is a per-machine folder under the daemon data root
// (`<RUNTIME_DATA_DIR>/packs/<id>/`, see the daemon's `packs/registry.ts`)
// holding `pack.json` plus exactly the bytes its `files[]` list names. It is
// not a plugin: its `plugins` content becomes ordinary plugins through a
// content handler, and the other kinds are read through the daemon's pack
// registry.
//
// Consumers (Cult registry and previews, sections, genui, the agency fast
// lane, the first-run hint) must look the pack up at request time, or cache
// by the registry's generation. A pack can be installed or removed while the
// daemon runs, so a value captured at startup goes stale.
//
// This module stays pure: no Node APIs. The daemon hashes
// `canonicalPackManifestJson(manifest)` with sha256 to get a pack's digest.

import { z } from 'zod';

import type { SseTransportEvent } from '../sse/common.js';
import type { PackGithubAccessErrorCode } from './pack-github-access.js';

// ---------------------------------------------------------------- constants

const MIB = 1024 * 1024;

/** Format discriminator. The licence guard (P1-9) keys on it. */
export const PACK_FORMAT = 'mishh-pack@1' as const;
export const PACK_MANIFEST_FILENAME = 'pack.json' as const;

/** Largest pack archive the daemon reads or downloads. */
export const PACK_ARCHIVE_MAX_BYTES = 512 * MIB;
/** Largest total of file bytes in one pack (and of an extracted archive). */
export const PACK_EXTRACTED_MAX_BYTES = 1024 * MIB;
/** Most archive entries, and most `files[]` rows. */
export const PACK_MAX_ENTRIES = 50_000;
/** Largest single file in a pack. */
export const PACK_FILE_MAX_BYTES = 64 * MIB;
/** Largest `pack.json`; refused before it is parsed. */
export const PACK_MANIFEST_MAX_BYTES = 8 * MIB;
export const PACK_MAX_CONTENTS = 64;
export const PACK_MAX_PATH_LENGTH = 512;
export const PACK_MAX_PLUGIN_IDS = 200;

/** Windows device names (CON, PRN, AUX, NUL, COM1-9, LPT1-9), lowercase form. */
const RESERVED_LOWER = '(?:con|prn|aux|nul|com[1-9]|lpt[1-9])';
/** The same names in any letter case, for path segments. */
const RESERVED_ANY_CASE = '(?:[Cc][Oo][Nn]|[Pp][Rr][Nn]|[Aa][Uu][Xx]|[Nn][Uu][Ll]|[Cc][Oo][Mm][1-9]|[Ll][Pp][Tt][1-9])';

/**
 * Ids the HTTP surface uses as fixed path segments under `/api/packs/`
 * (`DELETE /api/packs/github-access` would shadow `DELETE /api/packs/:id`).
 */
export const PACK_RESERVED_IDS = ['github-access'] as const;

/**
 * Pack id: no dots, so it can never name `.staging`, `.trash`, `.receipts` or
 * `.credentials`; never a Windows device name; never a reserved id.
 */
export const PACK_ID_PATTERN = `^(?!${RESERVED_LOWER}$)(?!(?:${PACK_RESERVED_IDS.join('|')})$)[a-z0-9][a-z0-9-]{0,63}$`;
/** `major.minor.patch`, decimal, no leading zeros (`2026.10.7`, never `2026.10.07`). */
export const PACK_VERSION_PATTERN = '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$';
export const PACK_SHA256_PATTERN = '^[0-9a-f]{64}$';
/** Id of a `component-kit` or `cult-catalog` entry. */
export const PACK_CONTENT_ID_PATTERN = `^(?!${RESERVED_LOWER}$)[a-z0-9][a-z0-9-]{0,63}$`;
/**
 * A plugin folder id inside a `plugins` entry (the plugin installer's safe
 * basename), never a Windows device name (with or without an extension) and
 * never ending in a dot.
 */
export const PACK_PLUGIN_ID_PATTERN = `^(?!${RESERVED_LOWER}(?:\\.|$))[a-z0-9](?:[a-z0-9._-]{0,126}[a-z0-9_-])?$`;
export const PACK_SNAPSHOT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$';
// One path segment. Excluded everywhere: `/`, `\`, `:`, C0 and C1 control
// characters, and lone UTF-16 surrogates (the pattern runs with the `u` flag,
// where a valid surrogate pair is one code point). A segment may not end in a
// dot or a space (so `.`, `..` and `...` are out) and may not be a Windows
// device name with or without an extension (`aux`, `AUX.js`).
const SEGMENT_CHAR = String.raw`[^/\\:\u0000-\u001f\u007f-\u009f\ud800-\udfff]`;
const SEGMENT_END = String.raw`[^/\\:\u0000-\u001f\u007f-\u009f\ud800-\udfff. ]`;
const SEGMENT = String.raw`(?!${RESERVED_ANY_CASE}(?:\.[^/]*)?(?:/|$))${SEGMENT_CHAR}*${SEGMENT_END}`;

/**
 * A path relative to the pack root: POSIX `/` separators, no leading `/`, and
 * every segment safe on macOS, Linux and Windows (see SEGMENT above).
 */
export const PACK_RELATIVE_PATH_PATTERN = `^${SEGMENT}(?:/${SEGMENT})*$`;
/** Text with no lone UTF-16 surrogate (well-formed Unicode). */
export const PACK_TEXT_PATTERN = String.raw`^[^\ud800-\udfff]*$`;
/** `pack.json` in any letter case (the Kelvin sign folds to `k`). */
export const PACK_MANIFEST_FILENAME_FOLDED_PATTERN = String.raw`^[Pp][Aa][Cc][Kk\u212a]\.[Jj][Ss][Oo][Nn]$`;

export const PACK_CONTENT_KINDS = ['component-kit', 'cult-catalog', 'genui-overlay', 'plugins'] as const;
export type PackContentKind = (typeof PACK_CONTENT_KINDS)[number];

/** The one schema version each kind accepts in `mishh-pack@1`. Any other version is invalid. */
export const PACK_CONTENT_SCHEMAS = {
  'component-kit': 'od-cult-kit/1',
  'cult-catalog': 'od-cult-pack/1',
  'genui-overlay': 'od-genui-overlay/1',
  plugins: 'od-plugin-dir/1',
} as const satisfies Record<PackContentKind, string>;

/**
 * Where the licensed pack lives by default: `github:owner/repo[@version]`
 * installs git tag `pack@<version>` (no version: the highest `pack@*` tag).
 */
export const DEFAULT_LICENSED_PACK_SOURCE = 'github:ZeroSum-Solutions/mishh-licensed';

// ---------------------------------------------------------------- zod schema

const ID_RE = new RegExp(PACK_ID_PATTERN);
const VERSION_RE = new RegExp(PACK_VERSION_PATTERN);
const SHA256_RE = new RegExp(PACK_SHA256_PATTERN);
const CONTENT_ID_RE = new RegExp(PACK_CONTENT_ID_PATTERN);
const PLUGIN_ID_RE = new RegExp(PACK_PLUGIN_ID_PATTERN);
const SNAPSHOT_ID_RE = new RegExp(PACK_SNAPSHOT_ID_PATTERN);
const RELATIVE_PATH_RE = new RegExp(PACK_RELATIVE_PATH_PATTERN, 'u');
const TEXT_RE = new RegExp(PACK_TEXT_PATTERN, 'u');

/** Length in code points, as JSON Schema `minLength`/`maxLength` count it. */
function codePoints(value: string): number {
  let count = 0;
  for (const _ of value) count++;
  return count;
}

function boundedText(min: number, max: number) {
  return z.string().regex(TEXT_RE, 'must be well-formed Unicode').refine((value) => {
    const length = codePoints(value);
    return length >= min && length <= max;
  }, `must be ${min} to ${max} characters`);
}

export const PackRelativePathSchema = z
  .string()
  .regex(RELATIVE_PATH_RE, 'must be a relative POSIX path with no empty, "." or ".." segment')
  .refine((value) => codePoints(value) <= PACK_MAX_PATH_LENGTH, `must be at most ${PACK_MAX_PATH_LENGTH} characters`);

export const PackFileEntrySchema = z
  .object({
    path: PackRelativePathSchema.refine(
      (value) => packPathCollisionKey(value) !== PACK_MANIFEST_FILENAME,
      'pack.json (in any letter case) is not listed in files[]',
    ),
    bytes: z.number().int().min(0).max(PACK_FILE_MAX_BYTES),
    sha256: z.string().regex(SHA256_RE, 'must be 64 lowercase hex characters'),
  })
  .strict();
export type PackFileEntry = z.infer<typeof PackFileEntrySchema>;

const ComponentKitEntrySchema = z
  .object({
    kind: z.literal('component-kit'),
    schema: z.literal(PACK_CONTENT_SCHEMAS['component-kit']),
    id: z.string().regex(CONTENT_ID_RE),
    path: PackRelativePathSchema,
  })
  .strict();

const CultCatalogEntrySchema = z
  .object({
    kind: z.literal('cult-catalog'),
    schema: z.literal(PACK_CONTENT_SCHEMAS['cult-catalog']),
    id: z.string().regex(CONTENT_ID_RE),
    path: PackRelativePathSchema,
    snapshotId: z.string().regex(SNAPSHOT_ID_RE),
  })
  .strict();

const GenuiOverlayEntrySchema = z
  .object({
    kind: z.literal('genui-overlay'),
    schema: z.literal(PACK_CONTENT_SCHEMAS['genui-overlay']),
    path: PackRelativePathSchema,
  })
  .strict();

const PluginsEntrySchema = z
  .object({
    kind: z.literal('plugins'),
    schema: z.literal(PACK_CONTENT_SCHEMAS.plugins),
    path: PackRelativePathSchema,
    ids: z
      .array(z.string().regex(PLUGIN_ID_RE))
      .min(1)
      .max(PACK_MAX_PLUGIN_IDS)
      .refine((ids) => new Set(ids).size === ids.length, 'plugin ids must be unique'),
  })
  .strict();

export const PackContentEntrySchema = z.discriminatedUnion('kind', [
  ComponentKitEntrySchema,
  CultCatalogEntrySchema,
  GenuiOverlayEntrySchema,
  PluginsEntrySchema,
]);
export type PackContentEntry = z.infer<typeof PackContentEntrySchema>;
export type PackContentEntryOf<K extends PackContentKind> = Extract<PackContentEntry, { kind: K }>;

export const PackLicenceSchema = z
  .object({
    scope: boundedText(1, 500),
    holder: boundedText(1, 200).optional(),
    evidence: z.array(boundedText(1, 500)).max(50),
  })
  .strict();

const PackManifestBaseSchema = z
  .object({
    format: z.literal(PACK_FORMAT),
    id: z.string().regex(ID_RE, 'must match ' + PACK_ID_PATTERN),
    version: z
      .string()
      .regex(VERSION_RE, 'must be major.minor.patch with no leading zeros')
      .refine((value) => value.length <= 64, 'must be at most 64 characters'),
    title: boundedText(1, 120),
    licence: PackLicenceSchema,
    contents: z.array(PackContentEntrySchema).min(1).max(PACK_MAX_CONTENTS),
    files: z.array(PackFileEntrySchema).min(1).max(PACK_MAX_ENTRIES),
  })
  .strict();

/**
 * Key two paths collide on: APFS and NTFS are case-insensitive and treat NFC
 * and NFD spellings as one name, so `A.json` could replace a listed `a.json`.
 */
export function packPathCollisionKey(value: string): string {
  return value.normalize('NFC').toLowerCase();
}

/** The content identity two packs (or two entries) may not share. */
export function packContentIdentities(entry: PackContentEntry): string[] {
  switch (entry.kind) {
    case 'component-kit':
    case 'cult-catalog':
      return [`${entry.kind}:${entry.id}`];
    case 'genui-overlay':
      return ['genui-overlay'];
    case 'plugins':
      return entry.ids.map((id) => `plugin:${id}`);
  }
}

export const PackManifestSchema = PackManifestBaseSchema.superRefine((manifest, ctx) => {
  // Every listed path and every parent folder, by collision key, with the
  // spelling first seen. Two spellings of one key collide on a
  // case-insensitive volume, whether they are files or folders.
  let total = 0;
  const exact = new Set<string>();
  const spellings = new Map<string, string>();
  const fileKeys = new Set<string>();
  const issue = (index: number, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['files', index, 'path'], message });
  };
  manifest.files.forEach((file, index) => {
    total += file.bytes;
    if (exact.has(file.path)) {
      issue(index, 'duplicate path');
      return;
    }
    exact.add(file.path);
    const segments = file.path.split('/');
    for (let i = 1; i < segments.length; i++) {
      const folder = segments.slice(0, i).join('/');
      const key = packPathCollisionKey(folder);
      if (fileKeys.has(key)) {
        issue(index, 'a parent directory of this path is also listed as a file');
        return;
      }
      const seen = spellings.get(key);
      if (seen !== undefined && seen !== folder) {
        issue(index, 'path differs from another listed path only by case or Unicode normalisation');
        return;
      }
      spellings.set(key, folder);
    }
    const key = packPathCollisionKey(file.path);
    if (spellings.has(key)) {
      issue(
        index,
        fileKeys.has(key)
          ? 'path differs from another listed path only by case or Unicode normalisation'
          : 'a parent directory of this path is also listed as a file',
      );
      return;
    }
    spellings.set(key, file.path);
    fileKeys.add(key);
  });
  if (total > PACK_EXTRACTED_MAX_BYTES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `files[] total more than ${PACK_EXTRACTED_MAX_BYTES} bytes`,
    });
  }

  const identities = new Set<string>();
  manifest.contents.forEach((entry, index) => {
    if (!packContentPathCovered(entry.path, manifest.files)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['contents', index, 'path'],
        message: 'content path is not a listed file or a directory of one',
      });
    }
    for (const identity of packContentIdentities(entry)) {
      if (identities.has(identity)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contents', index],
          message: `content ${identity} is provided twice`,
        });
      }
      identities.add(identity);
    }
  });
});
export type PackManifest = z.infer<typeof PackManifestSchema>;

/** True when `contentPath` is a listed file or a directory holding at least one listed file. */
export function packContentPathCovered(contentPath: string, files: readonly PackFileEntry[]): boolean {
  const prefix = `${contentPath}/`;
  return files.some((file) => file.path === contentPath || file.path.startsWith(prefix));
}

/** The listed files under a content entry's path (the file itself when the path is a file). */
export function packFilesUnder(contentPath: string, files: readonly PackFileEntry[]): PackFileEntry[] {
  const prefix = `${contentPath}/`;
  return files.filter((file) => file.path === contentPath || file.path.startsWith(prefix));
}

export type ParsePackManifestResult = { ok: true; manifest: PackManifest } | { ok: false; issues: string[] };

const MAX_REPORTED_ISSUES = 20;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f-\u009f]/g;

/** Parse an already JSON-decoded `pack.json` value. Never throws. */
export function parsePackManifest(value: unknown): ParsePackManifestResult {
  const result = PackManifestSchema.safeParse(value);
  if (result.success) return { ok: true, manifest: result.data };
  const issues = result.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => {
    const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    // Never echo a key from the input: zod's text for unknown keys quotes them.
    const message = issue.code === z.ZodIssueCode.unrecognized_keys ? 'unknown field' : issue.message;
    return `${where}: ${message}`.replace(CONTROL_CHARS_RE, '');
  });
  return { ok: false, issues: issues.length > 0 ? issues : ['(root): invalid manifest'] };
}

// ---------------------------------------------------------------- helpers

/** Compare two `PACK_VERSION_PATTERN` versions: -1, 0 or 1. Any size of integer. */
export function comparePackVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = a.split('.');
  const pb = b.split('.');
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? '0';
    const y = pb[i] ?? '0';
    // No leading zeros, so a longer numeral is a larger number.
    if (x.length !== y.length) return x.length > y.length ? 1 : -1;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] !== undefined) out[key] = sortKeysDeep(record[key]);
    }
    return out;
  }
  return value;
}

/**
 * The canonical text a pack's digest is the sha256 of: the whole parsed
 * manifest with object keys sorted and `files[]` sorted by path. Formatting
 * and `files[]` order do not change it; any field value does, so one
 * (id, version) names exactly one manifest and one byte set.
 */
export function canonicalPackManifestJson(manifest: PackManifest): string {
  const files = [...manifest.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return JSON.stringify(sortKeysDeep({ ...manifest, files }));
}

/**
 * The `source` and `resolvedSource` a plugin registered from a pack carries:
 * `pack:<packId>@<version>`. The daemon's `plugins` content handler writes
 * it and removes rows by the `pack:<packId>@` prefix; `od plugin list` and
 * the web plugin details read it to name the pack.
 */
export const PACK_PLUGIN_SOURCE_PREFIX = 'pack:' as const;

export function packPluginSource(packId: string, version: string): string {
  return `${PACK_PLUGIN_SOURCE_PREFIX}${packId}@${version}`;
}

/** The pack a plugin source names, or `null` when it is not a pack source. */
export function parsePackPluginSource(value: unknown): { packId: string; version: string } | null {
  if (typeof value !== 'string' || !value.startsWith(PACK_PLUGIN_SOURCE_PREFIX)) return null;
  const rest = value.slice(PACK_PLUGIN_SOURCE_PREFIX.length);
  const at = rest.indexOf('@');
  if (at < 0) return null;
  const packId = rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (!ID_RE.test(packId) || !VERSION_RE.test(version) || version.length > 64) return null;
  return { packId, version };
}

/** How the install surfaces read a `PackInstallRequest.source` string. */
export function classifyPackSource(source: string): 'github' | 'path' | null {
  if (source.startsWith('github:')) return 'github';
  if (source.startsWith('/') || /^[A-Za-z]:[\\/]/.test(source)) return 'path';
  return null;
}

// ---------------------------------------------------------------- DTOs

export type InstalledPackStatus = 'ready' | 'degraded' | 'damaged';

export interface InstalledPackContentSummary {
  kind: PackContentKind;
  /** `component-kit` / `cult-catalog` id. */
  id?: string;
  /** Plugin ids for `plugins`; listed files for the other kinds. */
  count?: number;
}

export interface InstalledPackSummary {
  id: string;
  /** `''` when a damaged pack has neither a readable manifest nor a receipt. */
  version: string;
  title: string;
  licenceScope: string;
  contents: InstalledPackContentSummary[];
  /**
   * `ready`: verified and every content handler succeeded. `degraded`: bytes
   * installed, a content handler failed (a re-install repairs it). `damaged`:
   * `pack.json` or the receipt is missing, unreadable or does not match.
   */
  status: InstalledPackStatus;
  /** Fixed text naming why a pack is degraded or damaged. Never a path. */
  problem?: string;
  /** sha256 hex of `canonicalPackManifestJson`; `''` when unknown. */
  digest: string;
  /** `github:owner/repo[@version]`, `local:<file name>` or `folder:<folder name>`. */
  source: string;
  installedAt: string;
}

export interface PackListResponse {
  packs: InstalledPackSummary[];
}

export interface PackInstallRequest {
  /** `github:owner/repo[@version]`, or an absolute path to a `.tgz`/`.tar.gz` file or a pack folder. */
  source: string;
  /** Replace the same version with other bytes, or a newer version with an older one. */
  force?: boolean;
  /**
   * Required for every local source; ignored for `github:`. Missing or
   * mismatched fails closed (`DIGEST_REQUIRED` / `INTEGRITY_MISMATCH`), with
   * no override (owner decisions, 2026-10-07):
   * - a `.tgz`/`.tar.gz`: sha256 hex of the archive file, here or in a
   *   `<file>.sha256` sidecar beside it;
   * - a folder: sha256 hex of its canonical `pack.json`
   *   (`canonicalPackManifestJson`, the digest P1-7's `write-manifest.ts`
   *   prints and the receipt records). No sidecar for folders.
   * The CLI passes it as `--sha256`, the web form as a field.
   */
  sha256?: string;
}

export const PACK_INSTALL_PHASES = ['resolving', 'downloading', 'extracting', 'verifying', 'activating'] as const;
export type PackInstallPhase = (typeof PACK_INSTALL_PHASES)[number];

export type PackInstallOutcome = 'installed' | 'upgraded' | 'unchanged';

export const PACK_INSTALL_ERROR_CODES = [
  'BAD_REQUEST',
  'SOURCE_UNSUPPORTED',
  'FETCH_FAILED',
  'AUTH_REQUIRED',
  'DIGEST_REQUIRED',
  'INVALID_ARCHIVE',
  'INVALID_MANIFEST',
  'INTEGRITY_MISMATCH',
  'TOO_LARGE',
  'VERSION_CONFLICT',
  'CONTENT_CONFLICT',
  'INSTALL_IN_PROGRESS',
  /** An upgrade could not unregister content the new version drops; the old version stays. */
  'RETRACT_FAILED',
  'CANCELLED',
  'INTERNAL_ERROR',
] as const;
export type PackInstallErrorCode = (typeof PACK_INSTALL_ERROR_CODES)[number];

export const PACK_REMOVE_ERROR_CODES = [
  'BAD_REQUEST',
  'PACK_NOT_FOUND',
  'INSTALL_IN_PROGRESS',
  'RETRACT_FAILED',
  'INTERNAL_ERROR',
] as const;
export type PackRemoveErrorCode = (typeof PACK_REMOVE_ERROR_CODES)[number];

export interface PackInstallProgressPayload {
  phase: PackInstallPhase;
  bytes?: number;
  totalBytes?: number;
}

export interface PackInstallSuccessPayload {
  outcome: PackInstallOutcome;
  pack: InstalledPackSummary;
  warnings: string[];
}

export interface PackInstallErrorPayload {
  code: PackInstallErrorCode;
  /** A fixed template: never a URL, a token or an absolute path. */
  message: string;
  warnings: string[];
}

export type PackInstallEvent =
  | SseTransportEvent<'progress', PackInstallProgressPayload>
  | SseTransportEvent<'success', PackInstallSuccessPayload>
  | SseTransportEvent<'error', PackInstallErrorPayload>;

export interface PackRemoveResponse {
  ok: true;
  id: string;
  removedVersion: string;
}

// ---------------------------------------------------------------- HTTP surface (P1-2)
//
// `GET /api/packs`, `POST /api/packs/install`, `DELETE /api/packs/:id` and the
// GitHub-access routes (`pack-github-access.ts`). The web section and `od pack`
// read these shapes; both re-read `GET /api/packs` after an install or removal
// instead of patching local state from the success event.

/**
 * `multipart/form-data` fields of `POST /api/packs/install` (the web "Install
 * from file"). An upload has no sidecar, so `sha256` is the archive digest and
 * is required (owner decision, 2026-10-07).
 */
export const PACK_INSTALL_FORM_FIELDS = { archive: 'archive', force: 'force', sha256: 'sha256' } as const;

/** Every code a `/api/packs*` error body or install `error` event carries. */
export type PackApiErrorCode = PackInstallErrorCode | PackRemoveErrorCode | PackGithubAccessErrorCode | 'FORBIDDEN';

/**
 * The error body of every `/api/packs*` route: the daemon's usual
 * `{ error: { code, message } }` envelope, with pack codes. `message` is a
 * fixed template: never a URL, a token or an absolute path.
 */
export interface PackApiErrorResponse {
  error: { code: PackApiErrorCode; message: string };
}

/**
 * One fixed English message per code. The daemon falls back to it when a
 * message fails its safety check, and `od pack` prints it; the web UI shows
 * its own localized copy per code and never the daemon's text.
 */
export const PACK_ERROR_MESSAGES: Record<PackApiErrorCode, string> = {
  BAD_REQUEST: 'The pack request is not valid.',
  SOURCE_UNSUPPORTED: 'GitHub pack sources are not available in this build.',
  FETCH_FAILED: 'The pack could not be downloaded from GitHub. Try again later.',
  AUTH_REQUIRED:
    'The configured GitHub access cannot read the pack repository. Add a fine-grained token with read access to that repository only (Settings → Licensed packs, or od pack auth set --stdin).',
  DIGEST_REQUIRED:
    'A local pack needs its sha256: give it with the install, or put a .sha256 file beside the archive. A folder needs the digest of its pack.json. od pack digest prints either one.',
  INVALID_ARCHIVE: 'The file is not a valid pack archive.',
  INVALID_MANIFEST: 'The pack.json in this pack is not valid.',
  INTEGRITY_MISMATCH: 'The pack does not match its expected sha256, so nothing was installed.',
  TOO_LARGE: 'The pack is larger than the size limit.',
  VERSION_CONFLICT: 'A different or newer version of this pack is installed. Install again with force to replace it.',
  CONTENT_CONFLICT: 'Another installed pack already provides this content.',
  INSTALL_IN_PROGRESS: 'Another pack install or removal is running. Try again when it finishes.',
  RETRACT_FAILED: 'The pack content could not be unregistered, so the pack is still installed.',
  CANCELLED: 'The pack install was cancelled.',
  INTERNAL_ERROR: 'The pack operation failed because of an internal error.',
  PACK_NOT_FOUND: 'That pack is not installed.',
  INVALID_TOKEN_FORMAT:
    'That is not a GitHub token. Paste a fine-grained token (github_pat_…) or a classic token (ghp_…).',
  CREDENTIAL_STORE_UNSAFE: 'The pack credential folder is not private to this user, so the token was not saved.',
  CREDENTIAL_STORE_FAILED: "The token could not be saved to the daemon's credential store.",
  FORBIDDEN: 'Pack changes are accepted only from this computer.',
};

export function isPackApiErrorCode(value: unknown): value is PackApiErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PACK_ERROR_MESSAGES, value);
}

export const InstalledPackSummarySchema = z.object({
  id: z.string(),
  version: z.string(),
  title: z.string(),
  licenceScope: z.string(),
  contents: z.array(
    z.object({
      kind: z.enum(PACK_CONTENT_KINDS),
      id: z.string().optional(),
      count: z.number().int().min(0).optional(),
    }),
  ),
  status: z.enum(['ready', 'degraded', 'damaged']),
  problem: z.string().optional(),
  digest: z.string(),
  source: z.string(),
  installedAt: z.string(),
});

export const PackListResponseSchema = z.object({ packs: z.array(InstalledPackSummarySchema) });

/** Parse a `GET /api/packs` body; `null` when it is not one. */
export function parsePackListResponse(value: unknown): PackListResponse | null {
  const result = PackListResponseSchema.safeParse(value);
  return result.success ? (result.data as PackListResponse) : null;
}

/** Read a pack error body (`{ error: { code, message } }`); `null` when it is not one. */
export function parsePackApiError(value: unknown): { code: PackApiErrorCode; message: string } | null {
  if (!value || typeof value !== 'object') return null;
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== 'object') return null;
  const { code, message } = error as { code?: unknown; message?: unknown };
  if (!isPackApiErrorCode(code)) return null;
  return { code, message: typeof message === 'string' ? message : PACK_ERROR_MESSAGES[code] };
}

/**
 * True when a ready or degraded pack provides `kind` (and `id`, when given).
 * Damaged packs provide nothing. For P1-4's tabs and P1-6's first-run hint.
 */
export function packProvides(
  packs: readonly InstalledPackSummary[],
  kind: PackContentKind,
  id?: string,
): boolean {
  return packs.some(
    (pack) =>
      pack.status !== 'damaged' &&
      pack.contents.some((entry) => entry.kind === kind && (id === undefined || entry.id === id)),
  );
}

// ---------------------------------------------------------------- JSON Schema

const RELATIVE_PATH_JSON = {
  type: 'string',
  maxLength: PACK_MAX_PATH_LENGTH,
  pattern: PACK_RELATIVE_PATH_PATTERN,
} as const;

/**
 * `pack.json` as a JSON Schema (draft 2020-12), committed as a literal so a
 * pack repository can vendor it (P1-7 pins it by sha256). It encodes every
 * per-field rule of `PackManifestSchema`. It cannot encode the cross-field
 * rules, which only `parsePackManifest` enforces: unique paths, paths or
 * parent folders that collide by case or Unicode normalisation (beyond the
 * ASCII `pack.json` check), a file listed under a listed
 * file, the `PACK_EXTRACTED_MAX_BYTES` total, content paths covered by
 * `files[]`, and each content identity provided once. A pack that passes this
 * schema can still be refused by the daemon; run `parsePackManifest` too.
 * Patterns are ECMA-262 with the `u` flag (Ajv's default), which the
 * lone-surrogate exclusions rely on.
 */
export const packManifestJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://github.com/ZeroSum-Solutions/mish/schemas/mishh-pack-1.json',
  title: 'mishh-pack@1 manifest (pack.json)',
  type: 'object',
  additionalProperties: false,
  required: ['format', 'id', 'version', 'title', 'licence', 'contents', 'files'],
  properties: {
    format: { const: PACK_FORMAT },
    id: { type: 'string', pattern: PACK_ID_PATTERN },
    version: { type: 'string', maxLength: 64, pattern: PACK_VERSION_PATTERN },
    title: { type: 'string', minLength: 1, maxLength: 120, pattern: PACK_TEXT_PATTERN },
    licence: {
      type: 'object',
      additionalProperties: false,
      required: ['scope', 'evidence'],
      properties: {
        scope: { type: 'string', minLength: 1, maxLength: 500, pattern: PACK_TEXT_PATTERN },
        holder: { type: 'string', minLength: 1, maxLength: 200, pattern: PACK_TEXT_PATTERN },
        evidence: {
          type: 'array',
          maxItems: 50,
          items: { type: 'string', minLength: 1, maxLength: 500, pattern: PACK_TEXT_PATTERN },
        },
      },
    },
    contents: {
      type: 'array',
      minItems: 1,
      maxItems: PACK_MAX_CONTENTS,
      items: {
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'schema', 'id', 'path'],
            properties: {
              kind: { const: 'component-kit' },
              schema: { const: PACK_CONTENT_SCHEMAS['component-kit'] },
              id: { type: 'string', pattern: PACK_CONTENT_ID_PATTERN },
              path: RELATIVE_PATH_JSON,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'schema', 'id', 'path', 'snapshotId'],
            properties: {
              kind: { const: 'cult-catalog' },
              schema: { const: PACK_CONTENT_SCHEMAS['cult-catalog'] },
              id: { type: 'string', pattern: PACK_CONTENT_ID_PATTERN },
              path: RELATIVE_PATH_JSON,
              snapshotId: { type: 'string', pattern: PACK_SNAPSHOT_ID_PATTERN },
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'schema', 'path'],
            properties: {
              kind: { const: 'genui-overlay' },
              schema: { const: PACK_CONTENT_SCHEMAS['genui-overlay'] },
              path: RELATIVE_PATH_JSON,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['kind', 'schema', 'path', 'ids'],
            properties: {
              kind: { const: 'plugins' },
              schema: { const: PACK_CONTENT_SCHEMAS.plugins },
              path: RELATIVE_PATH_JSON,
              ids: {
                type: 'array',
                minItems: 1,
                maxItems: PACK_MAX_PLUGIN_IDS,
                uniqueItems: true,
                items: { type: 'string', pattern: PACK_PLUGIN_ID_PATTERN },
              },
            },
          },
        ],
      },
    },
    files: {
      type: 'array',
      minItems: 1,
      maxItems: PACK_MAX_ENTRIES,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'bytes', 'sha256'],
        properties: {
          path: { ...RELATIVE_PATH_JSON, not: { pattern: PACK_MANIFEST_FILENAME_FOLDED_PATTERN } },
          bytes: { type: 'integer', minimum: 0, maximum: PACK_FILE_MAX_BYTES },
          sha256: { type: 'string', pattern: PACK_SHA256_PATTERN },
        },
      },
    },
  },
} as const;
