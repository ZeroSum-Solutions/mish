import { z } from 'zod';

/**
 * Mish packs: a private packet (a folder or a .zip) that restores content and connections the
 * public repository does not carry. The packet holds `mish-pack.json` at its root and every
 * resource it provides next to it. Nothing in the public repository names the content: a pack
 * declares paths, the daemon overlays them onto its existing loaders.
 *
 * This is separate from the licensed-pack format in `./packs.ts` (`mishh-pack@1`, which verifies
 * a per-file digest list). A Mish pack is a trusted team packet: it is bounded and path-checked,
 * but it carries no per-file digests and no licence evidence.
 */

export const MISH_PACK_MANIFEST_FILENAME = 'mish-pack.json';
export const MISH_PACK_SCHEMA_VERSION = 1;
export const MISH_PACK_ID_PATTERN = '^[a-z0-9][a-z0-9-]{0,62}$';

const GIB = 1024 * 1024 * 1024;

/**
 * Archive and extraction budgets. They hold while bytes are written, not afterwards. A team packet
 * that carries saved projects runs to several gigabytes, so a .zip is read as a stream (never
 * loaded whole) and every file is written as it is read.
 */
export const MISH_PACK_LIMITS = Object.freeze({
  archiveMaxBytes: 12 * GIB,
  extractedMaxBytes: 24 * GIB,
  maxEntries: 200_000,
  fileMaxBytes: 2 * GIB,
  manifestMaxBytes: 256 * 1024,
});

/**
 * Environment keys a pack may set, and the variable each one becomes in the daemon process. A pack
 * never sets anything else. A value already present in the daemon environment always wins.
 * `kind` decides validation: `url` is an https URL (or http on loopback), `json-urls` is an
 * object of profile name to such URL, `profile` is a short name.
 */
export const MISH_PACK_ENV_ALLOWLIST = {
  MISH_AMR_CONSOLE_URL: { target: 'MISH_AMR_CONSOLE_URL', kind: 'url' },
  MISH_AMR_ANALYTICS_URL: { target: 'MISH_AMR_ANALYTICS_URL', kind: 'url' },
  MISH_AMR_PROFILE: { target: 'MISH_AMR_PROFILE', kind: 'profile' },
  MISH_VELA_WEB_URL: { target: 'OD_VELA_WEB_URL', kind: 'url' },
  MISH_VELA_WEB_URLS: { target: 'OD_VELA_WEB_URLS', kind: 'json-urls' },
  MISH_STYLE_PREVIEW_ORIGIN: { target: 'MISH_STYLE_PREVIEW_ORIGIN', kind: 'url' },
} as const satisfies Record<string, { target: string; kind: 'url' | 'json-urls' | 'profile' }>;
export type MishPackEnvKey = keyof typeof MISH_PACK_ENV_ALLOWLIST;

const SEGMENT = String.raw`[A-Za-z0-9_@+=,~ ()\[\]-][A-Za-z0-9._@+=,~ ()\[\]-]{0,127}`;
const RELATIVE_PATH_RE = new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`, 'u');

/**
 * True when `value` is a safe path relative to the pack root: POSIX separators, no leading `/`,
 * no `.` or `..` segment, no drive letter, no backslash, no control character, no trailing dot or
 * space on a segment.
 */
export function isSafeMishPackPath(value: string): boolean {
  if (value.length === 0 || value.length > 512) return false;
  if (!RELATIVE_PATH_RE.test(value)) return false;
  for (const segment of value.split('/')) {
    if (segment === '.' || segment === '..') return false;
    if (/[. ]$/u.test(segment)) return false;
    if (/^[A-Za-z]:/u.test(segment)) return false;
  }
  return true;
}

const relativePath = z.string().refine(isSafeMishPackPath, 'must be a safe relative path inside the pack');

const SERVER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/u;
/** `${NAME}` placeholder: the user sets NAME in their own environment; the pack never holds the value. */
const ENV_REF = /\$\{([A-Za-z_][A-Za-z0-9_]{0,63})\}/gu;
const SECRET_SHAPES = [/\bsk-[A-Za-z0-9_-]{16,}/u, /\bgh[pousr]_[A-Za-z0-9]{20,}/u, /\bxox[abprs]-[A-Za-z0-9-]{10,}/u, /\beyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}\./u, /\bAKIA[0-9A-Z]{16}\b/u];

/** Environment variable names referenced by `${NAME}` placeholders in `value`. */
export function mishPackEnvRefs(value: string): string[] {
  return [...value.matchAll(ENV_REF)].map((match) => match[1]!);
}

/**
 * A value in an MCP server's `env`, `headers` or `args`. It is either plain config (a flag, a
 * public URL, a header name) or built from `${NAME}` placeholders. A literal that looks like a
 * credential is refused, so a pack cannot carry one by accident.
 */
const mcpValue = z.string().max(2048).superRefine((value, ctx) => {
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) ctx.addIssue({ code: 'custom', message: 'contains a control character' });
  const stripped = value.replace(ENV_REF, '');
  if (SECRET_SHAPES.some((shape) => shape.test(stripped))) ctx.addIssue({ code: 'custom', message: 'looks like a literal credential; reference an environment variable as ${NAME}' });
});

/** Query names that carry a credential, compared after lowercasing and dropping `-` and `_`. */
const SECRET_QUERY_NAME = /(?:key|token|secret|passw(?:or)?d|pwd|credential|signature)|^(?:auth|sig)$/u;

function decodeUrlPart(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function looksLikeSecret(value: string): boolean {
  const stripped = value.replace(ENV_REF, '');
  return SECRET_SHAPES.some((shape) => shape.test(stripped));
}

/**
 * Why an MCP server URL carries a credential, or null. Query names are decoded and normalised
 * (`api-key`, `API_KEY` and `apikey` are one name); a credential-like name with a literal value is
 * refused, and every query value, path segment, the user info and the fragment are checked against
 * the credential shapes.
 */
function mcpUrlCredentialProblem(url: URL): string | null {
  for (const [name, value] of url.searchParams) {
    const normalized = name.toLowerCase().replace(/[-_]/gu, '');
    if (value !== '' && value.replace(ENV_REF, '') !== '' && SECRET_QUERY_NAME.test(normalized)) return 'the url cannot carry a credential in its query';
    if (looksLikeSecret(name) || looksLikeSecret(value)) return 'the url cannot carry a credential in its query';
  }
  const parts = [...url.pathname.split('/'), url.username, url.password, url.hash.slice(1)].map(decodeUrlPart);
  if (parts.some(looksLikeSecret)) return 'the url looks like it carries a literal credential';
  return null;
}

const mcpServerSchema = z.object({
  id: z.string().regex(SERVER_ID),
  label: z.string().min(1).max(120).optional(),
  templateId: z.string().min(1).max(120).optional(),
  transport: z.enum(['stdio', 'sse', 'http']),
  enabled: z.boolean().default(true),
  authMode: z.enum(['none', 'oauth']).optional(),
  command: z.string().min(1).max(512).optional(),
  args: z.array(mcpValue).max(64).optional(),
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u), mcpValue).optional(),
  url: z.string().max(2048).optional(),
  headers: z.record(z.string().min(1).max(128), mcpValue).optional(),
}).strict().superRefine((server, ctx) => {
  if (server.transport === 'stdio') {
    if (!server.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'a stdio server needs a command' });
    if (server.url) ctx.addIssue({ code: 'custom', path: ['url'], message: 'a stdio server takes no url' });
    return;
  }
  if (!server.url) {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'an http or sse server needs a url' });
    return;
  }
  if (server.command) ctx.addIssue({ code: 'custom', path: ['command'], message: 'an http or sse server takes no command' });
  if (server.url.includes('${')) ctx.addIssue({ code: 'custom', path: ['url'], message: 'the url cannot hold a placeholder' });
  try {
    const parsed = new URL(server.url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') ctx.addIssue({ code: 'custom', path: ['url'], message: 'the url must be http or https' });
    if (parsed.username || parsed.password) ctx.addIssue({ code: 'custom', path: ['url'], message: 'the url cannot carry credentials' });
    const problem = mcpUrlCredentialProblem(parsed);
    if (problem) ctx.addIssue({ code: 'custom', path: ['url'], message: problem });
  } catch {
    ctx.addIssue({ code: 'custom', path: ['url'], message: 'the url is not valid' });
  }
});
export type MishPackMcpServer = z.infer<typeof mcpServerSchema>;

const catalogsSchema = z.object({
  /** Folder: `manifest.json`, `registry/`, `converted/`, `previews/` (the licensed component kit). */
  cultKit: relativePath.optional(),
  /** Folder: `catalog.json` plus optional `slugs.json`, `public-names.json`, `thumbnails.json`, `catalog-curation.json`, `catalog-copy-refinements.json`, `thumbnails/`. */
  cultCatalog: relativePath.optional(),
  /** File: a prebuilt ES module that exports `CULT_ADAPTERS` (a record of lazy adapter loaders). */
  cultAdapters: relativePath.optional(),
  /** Folder: `overlay.json` (`{ entries: [...] }`) and `demos/<id>.html`. */
  genui: relativePath.optional(),
  /** File: a section catalogue (`{ entries: [...] }`) merged into the bundled one. */
  sections: relativePath.optional(),
  /** Folder: `21st-thumbnails.json` and the image files it names. */
  twentyFirst: relativePath.optional(),
}).strict();

const assetsSchema = z.object({
  /** Folder of `<id>/` pet packages, scanned next to the bundled pets. */
  pets: relativePath.optional(),
  /** Folder with `image/` and `video/` prompt-template JSON, merged into the template list. */
  promptTemplates: relativePath.optional(),
  /** Folder of style-picker preview images, served under `/api/mish-packs/assets/style-catalog/v1/`. */
  styleCatalog: relativePath.optional(),
}).strict();

export const mishPackManifestSchema = z.object({
  schemaVersion: z.literal(MISH_PACK_SCHEMA_VERSION),
  id: z.string().regex(new RegExp(MISH_PACK_ID_PATTERN)),
  name: z.string().min(1).max(120),
  version: z.string().min(1).max(64).regex(/^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u),
  description: z.string().max(1000).optional(),
  provides: z.object({
    catalogs: catalogsSchema.optional(),
    /** Folder of design-system packages. Each child folder is copied into the user design-systems root. */
    designSystems: relativePath.optional(),
    /** Folder of skill packages (each child holds a `SKILL.md`), copied into the user skills root. */
    skills: relativePath.optional(),
    /** Folder of study design-system packages, copied into the user design-systems root. */
    studies: relativePath.optional(),
    assets: assetsSchema.optional(),
    /**
     * Folder of saved projects: `projects.json` (the project rows, see `mishPackProjectsFileSchema`)
     * and one `<id>/` folder per row. Each is copied into the projects folder under its own id; an
     * id the person already has is left alone.
     */
    projects: relativePath.optional(),
    /** Folder with `index.json` (`design-index/1`): stored design profiles, read next to the person's own. */
    designIndex: relativePath.optional(),
    /** Allow-listed environment keys (see `MISH_PACK_ENV_ALLOWLIST`). */
    env: z.record(z.string(), z.string().max(4096)).optional(),
    mcpServers: z.array(mcpServerSchema).max(64).optional(),
  }).strict().default({}),
}).strict().superRefine((manifest, ctx) => {
  const ids = new Set<string>();
  for (const [index, server] of (manifest.provides.mcpServers ?? []).entries()) {
    if (ids.has(server.id)) ctx.addIssue({ code: 'custom', path: ['provides', 'mcpServers', index, 'id'], message: 'duplicate server id' });
    ids.add(server.id);
  }
  for (const [key, value] of Object.entries(manifest.provides.env ?? {})) {
    const problem = mishPackEnvProblem(key, value);
    if (problem) ctx.addIssue({ code: 'custom', path: ['provides', 'env', key], message: problem });
  }
});
export type MishPackManifest = z.infer<typeof mishPackManifestSchema>;

function isUrlValue(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password) return false;
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** Why `key=value` is not an allowed pack environment entry, or null when it is allowed. */
export function mishPackEnvProblem(key: string, value: string): string | null {
  if (!Object.hasOwn(MISH_PACK_ENV_ALLOWLIST, key)) return `${key} is not an environment key a pack may set`;
  const { kind } = MISH_PACK_ENV_ALLOWLIST[key as MishPackEnvKey];
  if (kind === 'url') return isUrlValue(value) ? null : `${key} must be an https URL (or http on loopback) with no credentials`;
  if (kind === 'profile') return /^[a-z][a-z0-9-]{0,31}$/u.test(value) ? null : `${key} must be a short lowercase name`;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return `${key} must be a JSON object`;
    for (const entry of Object.values(parsed)) {
      if (typeof entry !== 'string' || !isUrlValue(entry)) return `${key} must map names to https URLs`;
    }
    return null;
  } catch {
    return `${key} must be a JSON object`;
  }
}

export type MishPackErrorCode =
  | 'INVALID_MANIFEST'
  | 'INVALID_ARCHIVE'
  | 'UNSAFE_PATH'
  | 'MISSING_RESOURCE'
  | 'TOO_LARGE'
  | 'NOT_FOUND'
  | 'SOURCE_NOT_FOUND'
  | 'BUSY'
  | 'READ_ONLY'
  | 'INTERNAL_ERROR';

export type MishPackResourceKey =
  | 'cultKit'
  | 'cultCatalog'
  | 'cultAdapters'
  | 'genui'
  | 'sections'
  | 'twentyFirst'
  | 'designSystems'
  | 'skills'
  | 'studies'
  | 'pets'
  | 'promptTemplates'
  | 'styleCatalog'
  | 'projects'
  | 'designIndex';

export interface MishPackProvided {
  resource: MishPackResourceKey;
  /** Child folders copied into a user root (design systems, skills, studies, projects); null for the others. */
  items: number | null;
}

/** File inside the `projects` folder that lists the project rows. */
export const MISH_PACK_PROJECTS_FILENAME = 'projects.json';
export const MISH_PACK_PROJECTS_SCHEMA = 'mish-pack-projects/1';

/** A project id as the daemon accepts it, which is also a folder name the pack may carry. */
export const MISH_PACK_PROJECT_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$';

const projectRowSchema = z.object({
  id: z.string().regex(new RegExp(MISH_PACK_PROJECT_ID_PATTERN, 'u')),
  name: z.string().min(1).max(1000),
  skillId: z.string().max(256).nullable().optional(),
  designSystemId: z.string().max(256).nullable().optional(),
  pendingPrompt: z.string().max(1_000_000).nullable().optional(),
  /** The project's metadata object. A pack may not point a project at a folder outside it (`baseDir`). */
  metadata: z.record(z.string(), z.unknown()).nullable().optional(),
  customInstructions: z.string().max(5000).nullable().optional(),
  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
}).strict();
export type MishPackProjectRow = z.infer<typeof projectRowSchema>;

/** `projects/projects.json`: one row per project folder the pack carries. Ids are unique. */
export const mishPackProjectsFileSchema = z.object({
  schema: z.literal(MISH_PACK_PROJECTS_SCHEMA),
  projects: z.array(projectRowSchema).max(20_000),
}).strict().superRefine((file, ctx) => {
  const ids = new Set<string>();
  for (const [index, row] of file.projects.entries()) {
    if (ids.has(row.id.toLowerCase())) ctx.addIssue({ code: 'custom', path: ['projects', index, 'id'], message: 'duplicate project id' });
    ids.add(row.id.toLowerCase());
  }
});
export type MishPackProjectsFile = z.infer<typeof mishPackProjectsFileSchema>;

export interface MishPackSummary {
  id: string;
  name: string;
  version: string;
  description: string | null;
  /** `installed` lives in the data directory and can be removed; `external` comes from MISH_PACKS_DIR. */
  origin: 'installed' | 'external';
  provides: MishPackProvided[];
  envKeys: string[];
  mcpServerIds: string[];
  /** Variable names the pack's MCP servers read from the user's environment, with whether each is set. */
  requiredEnv: Array<{ name: string; set: boolean }>;
  installedAt: string | null;
  warnings: string[];
}

export interface MishPacksListResponse {
  packs: MishPackSummary[];
  /** Folder the daemon installs into, for display. */
  installDir: string;
  /** Extra read-only folder named by MISH_PACKS_DIR, when set. */
  externalDir: string | null;
}

export interface MishPackInstallRequest {
  /** Absolute path of a pack folder or a .zip file on the machine that runs the daemon. */
  source: string;
}

export interface MishPackInstallResponse {
  pack: MishPackSummary;
  replaced: boolean;
}

export interface MishPackRemoveResponse {
  removed: string;
  /**
   * Ids of the saved projects the pack had imported. A pack never deletes a project: they stay in
   * the project list as the person's own. Absent when the pack imported none.
   */
  keptProjects?: string[];
}

export interface MishPackRuntimeResponse {
  /** Path on the daemon that serves a pack's style previews, or null. */
  styleCatalogPath: string | null;
  /** Absolute origin from MISH_STYLE_PREVIEW_ORIGIN (a pack's `env` or the person's own), or null. It wins over the path. */
  styleCatalogOrigin: string | null;
}

export interface MishPackErrorBody {
  error: { code: MishPackErrorCode; message: string };
}

export function parseMishPackManifest(raw: unknown): MishPackManifest {
  return mishPackManifestSchema.parse(raw);
}
