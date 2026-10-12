import fs from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hash as blake3Hash } from 'blake3-wasm';
import { readProjectFile, validateProjectPath } from './projects.js';
import { assertInsertedUnitPublicationRights, PublicationRightsError } from './workbench/units/publication-rights.js';
import { load as loadHtml } from 'cheerio';
import { cssPublicationReferences, fallbackCssPublicationReferences, fallbackScriptPublicationReferences, rewriteCssPublicationReferences, rewriteScriptPublicationReferences, rewriteSrcsetPublicationReferences, scriptPublicationReferences, srcsetPublicationReferences } from './deploy/reference-parser.js';
import { findRealTagOffset, HTML_TAG_PATTERNS } from '@mish/contracts/runtime/html-injection-points';
import { agencyPublicationScope } from './artifacts/deploy-scope.js';
import { confirmAnonymousPageGet, pageMarkerFromFiles, parsePageMarker, type PageMarker } from './deploy/public-page-probe.js';
import { bindVercelSite, bindVercelStableAlias, verifyVercelStoredAlias, type VercelBinding } from './deploy/vercel-site.js';
import type { DeploymentAccess, DeploymentLinkStatus, DeployPublicAccessOutcome, DeployPreflightWarning } from '@mish/contracts';

export const VERCEL_PROVIDER_ID = 'vercel-self';
export const CLOUDFLARE_PAGES_PROVIDER_ID = 'cloudflare-pages';
export const SAVED_TOKEN_MASK = 'saved-vercel-token';
export const SAVED_CLOUDFLARE_TOKEN_MASK = 'saved-cloudflare-token';

type JsonObject = Record<string, any>;
type DeployProviderId = typeof VERCEL_PROVIDER_ID | typeof CLOUDFLARE_PAGES_PROVIDER_ID;
type DeployErrorDetails = JsonObject | string | undefined;
type DeployConfig = {
  token: string;
  teamId?: string | undefined;
  teamSlug?: string | undefined;
  accountId?: string | undefined;
  projectName?: string | undefined;
  cloudflarePages?: CloudflarePagesConfigHints | undefined;
};
type CloudflarePagesConfigHints = {
  lastZoneId?: string;
  lastZoneName?: string;
  lastDomainPrefix?: string;
};
type DeployFile = { file: string; data: Buffer | Uint8Array | string; contentType?: string; sourcePath?: string };
type DeployFilePlan = { entryPath: string; html: string; files: DeployFile[]; missing: string[]; invalid: string[]; warnings: DeployPreflightWarning[] };
type PublicationReference = { ref: string; base: string; sourcePath: string; optional?: boolean };
type DeployOptions = {
  metadata?: unknown;
  hookScriptUrl?: string;
  providerId?: DeployProviderId;
  requireAgencySiteScope?: boolean;
};
type CloudflarePagesDeploySelection = { zoneId: string; zoneName: string; domainPrefix: string; hostname: string };
type CloudflareDnsRecord = JsonObject & { id?: string; type?: string; name?: string; content?: string; comment?: string };
type DeployLinkStatus = DeploymentLinkStatus;
export type { DeploymentAccess };
export { confirmAnonymousPageGet, pageMarkerFromFiles, pageMarkerFromHtml, parsePageMarker } from './deploy/public-page-probe.js';
export type { PageMarker } from './deploy/public-page-probe.js';
type DeploymentUrlCheck = { reachable: boolean; status?: DeployLinkStatus; statusCode?: number; statusMessage?: string };
type MaybeJsonObject = JsonObject | null | undefined;

const PUBLIC_LINK_READY_SENTENCE = 'Public link is ready.';
const LINK_ACCESS_UNKNOWN_SENTENCE =
  'The site answered, but deployment protection could not be checked, so it is not confirmed public.';
const LINK_ACCESS_PROTECTED_SENTENCE =
  "The site answered, but the project's deployment protection is on, so the link is not public.";

/**
 * The one sentence a deploy or a link re-check reports for a link that
 * answered. "Public link is ready." is said ONLY for `access === 'public'` —
 * a reachable URL on its own proves nothing about who else can open it. A
 * link that did not answer keeps the caller's own, more specific sentence
 * (`fallback`), because that one explains why.
 */
export function deployLinkSentence({ access, status, fallback }: { access: DeploymentAccess; status: string; fallback?: string }): string {
  if (status !== 'ready') return fallback || 'The link is not reachable yet.';
  if (access === 'public') return PUBLIC_LINK_READY_SENTENCE;
  if (access === 'protected') return LINK_ACCESS_PROTECTED_SENTENCE;
  return LINK_ACCESS_UNKNOWN_SENTENCE;
}

/**
 * `public` needs both confirmations: a settings read with protection off and
 * an anonymous GET that reached the deployed page itself (`pageConfirmed`,
 * from `confirmAnonymousPageGet`). A status code alone never makes a link
 * public: a HEAD 200 or a redirect proves only that the host answered.
 *
 * `protected` has one rule, shared with `vercelUnprobedLinkStatus`: it is
 * reported only for a CONFIRMED wall, and there are exactly two
 * confirmations: a settings read with a protection on, or a probe that
 * observed the wall (`linkStatus === 'protected'`). A probe-observed wall
 * counts with or without a settings read. Anything else that is not proven
 * public, including a settings read or write that failed, is `unknown`.
 *
 * Order matters. Confirmed settings speak first: protection read ON is
 * `protected` whatever the probe saw. Without a confirmed read, the only
 * thing the probe can prove is a wall (`protected`), never openness, so an
 * unread project is `unknown` even on a 200. Only a confirmed-off read plus a
 * confirmed page is `public`.
 */
export function vercelLinkAccess({ protection, linkStatus, pageConfirmed }: {
  protection?: { checked: boolean; sso: string | null; password: boolean } | undefined;
  linkStatus?: string | undefined;
  pageConfirmed?: boolean | undefined;
}): DeploymentAccess {
  const probeHitWall = linkStatus === 'protected';
  if (!protection?.checked) return probeHitWall ? 'protected' : 'unknown';
  if (protection.sso || protection.password) return 'protected';
  if (probeHitWall) return 'protected';
  return linkStatus === 'ready' && pageConfirmed === true ? 'public' : 'unknown';
}

/**
 * `vercelLinkAccess` with the page check it needs: the anonymous GET is sent
 * only when the settings read off and the link answered, and its answer is
 * the only way to `public`.
 */
export async function resolveVercelLinkAccess(
  { protection, linkStatus, url, marker }: {
    protection?: VercelProjectProtection | undefined;
    linkStatus?: string | undefined;
    url: unknown;
    marker: PageMarker | null | undefined;
  },
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {},
): Promise<DeploymentAccess> {
  const settingsOpen = protection?.checked === true && !protection.sso && !protection.password && linkStatus === 'ready';
  const pageConfirmed = settingsOpen
    ? await confirmAnonymousPageGet(normalizeDeploymentUrl(url), { timeoutMs, marker })
    : false;
  return vercelLinkAccess({ protection, linkStatus, pageConfirmed });
}

/**
 * The link status for a Vercel answer that is not a probe result. It follows
 * the one `protected` rule of `vercelLinkAccess` (a confirmed wall: settings
 * read ON, or a probe-observed wall) by mapping that function's answer:
 * `protected` stays `protected`, everything else is `unknown`. On these paths
 * no probe ran, so in practice only a settings read with a protection on
 * yields `protected`; a failure to read or change them is `unknown`, never a
 * claimed wall.
 */
function vercelUnprobedLinkStatus(access: DeploymentAccess): DeployLinkStatus {
  return access === 'protected' ? 'protected' : 'unknown';
}

function isErrnoException(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

function errorMessage(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

const VERCEL_API = 'https://api.vercel.com';
const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const CLOUDFLARE_API_PAGE_SIZE = 100;
const CLOUDFLARE_API_MAX_PAGES = 100;
export const CLOUDFLARE_PAGES_ASSET_UPLOAD_MAX_FILES = 100;
export const CLOUDFLARE_PAGES_ASSET_UPLOAD_MAX_BODY_BYTES = 75 * 1024 * 1024;
export const CLOUDFLARE_PAGES_ASSET_MAX_BYTES = 25 * 1024 * 1024;
const VERCEL_PROTECTED_MESSAGE =
  'Deployment is protected by Vercel. Disable Deployment Protection or use a custom domain to make this link public.';
// Vercel's Security Checkpoint (bot mitigation) answers with
// `x-vercel-mitigated: challenge`. What one request met, and what the whole
// probe window met: the second says what to do about it, because a person with
// a browser passes the checkpoint the daemon's anonymous request cannot.
const VERCEL_CHALLENGE_MESSAGE = "Vercel's Security Checkpoint challenged the request.";
const VERCEL_CHALLENGED_LINK_MESSAGE =
  "Vercel's Security Checkpoint is challenging visitors. Open the link in a browser.";
// Same budget as the URL probe's default (checkDeploymentUrl's timeoutMs) —
// the project-settings read is a single small GET, not a poll loop.
const VERCEL_PROTECTION_CHECK_TIMEOUT_MS = 8_000;

export class DeployError extends Error {
  status: number;
  details: DeployErrorDetails;
  code?: string | undefined;

  constructor(message: string, status = 400, details: DeployErrorDetails = undefined, code?: string) {
    super(message);
    this.name = 'DeployError';
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

/** Malformed URL encoding is recoverable; traversal and scope violations are not. */
class MalformedPublicationPathError extends DeployError {
  constructor() {
    super('Invalid publication path.', 400, undefined, 'INVALID_PUBLICATION_PATH');
  }
}

function invalidEncodingWarning(ref: string, sourcePath: string): DeployPreflightWarning {
  return { code: 'invalid-reference', path: sourcePath, url: ref, message: `Skipped reference with malformed URL encoding: ${ref}` };
}

let daemonDeployDataDir: string | undefined;

/** Called by daemon composition with its resolved data root. */
export function configureDeployDataDir(dataDir: string): void {
  daemonDeployDataDir = dataDir;
}

export function deployConfigPath(providerId: DeployProviderId = VERCEL_PROVIDER_ID) {
  const base = process.env.OD_USER_STATE_DIR || daemonDeployDataDir || path.join(os.homedir(), '.mish');
  return path.join(base, providerId === CLOUDFLARE_PAGES_PROVIDER_ID ? 'cloudflare-pages.json' : 'vercel.json');
}

export async function readVercelConfig(): Promise<DeployConfig> {
  try {
    const raw = await readFile(deployConfigPath(VERCEL_PROVIDER_ID), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      teamId: typeof parsed.teamId === 'string' ? parsed.teamId : '',
      teamSlug: typeof parsed.teamSlug === 'string' ? parsed.teamSlug : '',
    };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { token: '', teamId: '', teamSlug: '' };
    throw err;
  }
}

export async function readCloudflarePagesConfig(): Promise<DeployConfig> {
  try {
    const raw = await readFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), 'utf8');
    const parsed = JSON.parse(raw);
    return {
      token: typeof parsed.token === 'string' ? parsed.token : '',
      accountId: typeof parsed.accountId === 'string' ? parsed.accountId : '',
      projectName: typeof parsed.projectName === 'string' ? parsed.projectName : '',
      cloudflarePages: normalizeCloudflarePagesConfigHints(parsed.cloudflarePages),
    };
  } catch (err) {
    if (isErrnoException(err) && err.code === 'ENOENT') return { token: '', accountId: '', projectName: '', cloudflarePages: {} };
    throw err;
  }
}

export async function writeVercelConfig(input: Partial<DeployConfig>) {
  const current = await readVercelConfig();
  const tokenInput = typeof input?.token === 'string' ? input.token.trim() : '';
  const next = {
    token:
      tokenInput && tokenInput !== SAVED_TOKEN_MASK
        ? tokenInput
        : current.token,
    teamId: typeof input?.teamId === 'string' ? input.teamId.trim() : current.teamId,
    teamSlug:
      typeof input?.teamSlug === 'string' ? input.teamSlug.trim() : current.teamSlug,
  };
  await writeDeployConfigFile(deployConfigPath(VERCEL_PROVIDER_ID), next);
  return publicDeployConfig(next);
}

export async function writeCloudflarePagesConfig(input: Partial<DeployConfig>) {
  const current = await readCloudflarePagesConfig();
  const tokenInput = typeof input?.token === 'string' ? input.token.trim() : '';
  const cloudflarePages = normalizeCloudflarePagesConfigHints(input?.cloudflarePages, current.cloudflarePages);
  const next: DeployConfig = {
    token:
      tokenInput && tokenInput !== SAVED_CLOUDFLARE_TOKEN_MASK
        ? tokenInput
        : current.token,
    accountId: typeof input?.accountId === 'string' ? input.accountId.trim() : current.accountId,
    // Legacy installs may already have a saved Cloudflare Pages projectName.
    // New writes intentionally stop treating it as user configuration: the
    // deploy route derives a Pages project name from the current OD project,
    // mirroring Vercel's automatic `od-${projectId}` deployment name.
    projectName: '',
  };
  if (Object.keys(cloudflarePages).length > 0) next.cloudflarePages = cloudflarePages;
  if (!next.token) throw new DeployError('Cloudflare API token is required.', 400, undefined, 'CF_TOKEN_REQUIRED');
  if (!next.accountId) throw new DeployError('Cloudflare account ID is required.', 400, undefined, 'CF_ACCOUNT_ID_REQUIRED');
  await writeDeployConfigFile(deployConfigPath(CLOUDFLARE_PAGES_PROVIDER_ID), next);
  return publicCloudflarePagesConfig(next);
}

async function writeDeployConfigFile(file: string, config: DeployConfig) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on filesystems that do not support chmod.
  }
}

export function publicDeployConfig(config: Partial<DeployConfig>) {
  return {
    providerId: VERCEL_PROVIDER_ID,
    configured: Boolean(config?.token),
    tokenMask: config?.token ? SAVED_TOKEN_MASK : '',
    teamId: config?.teamId || '',
    teamSlug: config?.teamSlug || '',
    target: 'preview',
  };
}

export function publicCloudflarePagesConfig(config: Partial<DeployConfig>) {
  const cloudflarePages = normalizeCloudflarePagesConfigHints(config?.cloudflarePages);
  const body: JsonObject = {
    providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
    configured: Boolean(config?.token && config?.accountId),
    tokenMask: config?.token ? SAVED_CLOUDFLARE_TOKEN_MASK : '',
    teamId: '',
    teamSlug: '',
    accountId: config?.accountId || '',
    projectName: config?.projectName || '',
    target: 'preview',
  };
  if (Object.keys(cloudflarePages).length > 0) body.cloudflarePages = cloudflarePages;
  return body;
}

export async function readDeployConfig(providerId: DeployProviderId = VERCEL_PROVIDER_ID) {
  if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID) return readCloudflarePagesConfig();
  return readVercelConfig();
}

export async function writeDeployConfig(providerId: DeployProviderId = VERCEL_PROVIDER_ID, input: Partial<DeployConfig> = {}) {
  if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID) return writeCloudflarePagesConfig(input);
  return writeVercelConfig(input);
}

export function publicDeployConfigForProvider(providerId: DeployProviderId = VERCEL_PROVIDER_ID, config: Partial<DeployConfig> = {}) {
  if (providerId === CLOUDFLARE_PAGES_PROVIDER_ID) return publicCloudflarePagesConfig(config);
  return publicDeployConfig(config);
}

export function isDeployProviderId(value: unknown): value is DeployProviderId {
  return value === VERCEL_PROVIDER_ID || value === CLOUDFLARE_PAGES_PROVIDER_ID;
}

function normalizeCloudflarePagesConfigHints(input: unknown, fallback: CloudflarePagesConfigHints = {}): CloudflarePagesConfigHints {
  const hasSource = Boolean(input && typeof input === 'object');
  const source = (hasSource ? input : {}) as CloudflarePagesConfigHints;
  const prior = (!hasSource && fallback && typeof fallback === 'object' ? fallback : {}) as CloudflarePagesConfigHints;
  const lastZoneId =
    typeof source.lastZoneId === 'string'
      ? source.lastZoneId.trim()
      : typeof prior.lastZoneId === 'string'
        ? prior.lastZoneId.trim()
        : '';
  const lastZoneName =
    typeof source.lastZoneName === 'string'
      ? normalizeCloudflareZoneName(source.lastZoneName)
      : typeof prior.lastZoneName === 'string'
        ? normalizeCloudflareZoneName(prior.lastZoneName)
        : '';
  const lastDomainPrefix =
    typeof source.lastDomainPrefix === 'string'
      ? normalizeCloudflareDomainPrefix(source.lastDomainPrefix)
      : typeof prior.lastDomainPrefix === 'string'
        ? normalizeCloudflareDomainPrefix(prior.lastDomainPrefix)
        : '';
  return {
    ...(lastZoneId ? { lastZoneId } : {}),
    ...(lastZoneName ? { lastZoneName } : {}),
    ...(lastDomainPrefix ? { lastDomainPrefix } : {}),
  };
}

export async function buildDeployFilePlan(projectsRoot: string, projectId: string, entryName: string, options: DeployOptions = {}): Promise<DeployFilePlan> {
  try {
    return await collectPublicationFilePlan(projectsRoot, projectId, entryName, options);
  } catch (error) {
    if (error instanceof PublicationRightsError) {
      throw new DeployError(error.message, 403, undefined, error.code);
    }
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'CssSyntaxError')) {
      throw new DeployError('Could not parse publication references.', 400, undefined, 'INVALID_PUBLICATION_REFERENCES');
    }
    throw error;
  }
}

/**
 * Publication invariant, shared by preflight and every deployment provider:
 * publish only the selected HTML and its transitive local reference closure.
 * Directory membership and artifact supportingFiles are never publication consent.
 * There is no implicit whole-project fallback or public explicit-include option.
 * HTML (including linked pages), CSS, fonts, scripts and media resolve within
 * the project through symlink-aware reads. Refuse parent segments before
 * normalization, including URL-encoded traversal. Agency scope can only narrow
 * the closure. Missing required assets and unsafe paths prevent upload.
 * Missing navigation, parser fallbacks and malformed encoding produce warnings.
 */
async function collectPublicationFilePlan(projectsRoot: string, projectId: string, entryName: string, options: DeployOptions): Promise<DeployFilePlan> {
  const entryPath = validateProjectPath(entryName);
  if (!/\.html?$/i.test(entryPath)) {
    throw new DeployError('Only HTML files can be deployed.', 400, undefined, 'NOT_HTML');
  }

  const entry = await readProjectFile(projectsRoot, projectId, entryPath, options.metadata);
  const publicationSourcePaths = new Set([entryPath, entry.name]);
  let publicationScope: Set<string> | null;
  try {
    publicationScope = agencyPublicationScope(entry.artifactManifest, entryPath, options.requireAgencySiteScope === true);
    if (publicationScope && entry.name !== entryPath) throw new Error('Agency Site entry cannot be a symlink alias.');
  } catch (error) {
    throw new DeployError(errorMessage(error, 'Invalid Agency Site publication scope.'), 400, undefined, 'INVALID_PUBLICATION_SCOPE');
  }
  const html = entry.buffer.toString('utf8');
  const deployHtml = injectDeployHookScript(
    rewriteEntryHtmlReferences(html, path.posix.dirname(entryPath)),
    options.hookScriptUrl ?? process.env.OD_DEPLOY_HOOK_SCRIPT_URL,
  );
  const files = new Map<string, DeployFile>();
  files.set('index.html', {
    file: 'index.html',
    data: Buffer.from(deployHtml, 'utf8'),
    contentType: entry.mime,
    sourcePath: entryPath,
  });

  const visited = new Set<string>([entryPath]);
  const missing: string[] = [];
  const invalid: string[] = [];
  const warnings: DeployPreflightWarning[] = [];
  const pending = publicationReferencesForHtml(html, entryPath, 0, warnings);

  while (pending.length > 0) {
    const item = pending.shift();
    if (!item) break;
    let safePath;
    try {
      const resolved = resolveReferencedPath(item.ref, item.base);
      if (!resolved) continue;
      if (resolved === '.' && item.optional) continue; // Home navigation names the deployed entry, not a disk file.
      safePath = validateProjectPath(resolved);
    } catch (error) {
      if (error instanceof MalformedPublicationPathError) warnings.push(invalidEncodingWarning(item.ref, item.sourcePath));
      else invalid.push(item.ref);
      continue;
    }
    if (publicationScope && !item.optional && (!publicationScope.has(safePath) || /(?:^|\/)\.\.(?:\/|$)|\\/.test(item.ref))) {
      invalid.push(item.ref);
      continue;
    }
    if (safePath === entryPath) {
      // A self-reference needs the original URL as well when a nested or
      // differently named entry has been mapped to provider-root index.html.
      if (safePath !== 'index.html') files.set(safePath, { file: safePath, data: entry.buffer, contentType: entry.mime, sourcePath: safePath });
      continue;
    }
    if (visited.has(safePath)) continue;
    // Never overwrite the chosen entry with a different root index.html.
    if (safePath === 'index.html' && !item.optional) {
      invalid.push(item.ref);
      continue;
    }
    let projectFile;
    try {
      projectFile = await readProjectFile(projectsRoot, projectId, safePath, options.metadata);
      if (publicationScope && projectFile.name !== safePath) throw new Error('Scoped assets cannot be symlink aliases.');
    } catch (err) {
      if (isErrnoException(err) && err.code === 'ENOENT') {
        if (item.optional) warnings.push({ code: 'broken-reference', path: safePath, message: `Skipped missing navigation target: ${safePath}` });
        else missing.push(safePath);
        continue;
      }
      if (item.optional && isErrnoException(err) && (err.code === 'ENOTDIR' || err.code === 'EISDIR')) {
        warnings.push({ code: 'broken-reference', path: safePath, message: `Skipped navigation target that is not a file: ${safePath}` });
        continue;
      }
      invalid.push(safePath);
      continue;
    }
    if (safePath === 'index.html' || (publicationScope && !publicationScope.has(safePath))) {
      invalid.push(item.ref);
      continue;
    }
    visited.add(safePath);
    publicationSourcePaths.add(safePath);
    publicationSourcePaths.add(projectFile.name);

    files.set(safePath, {
      file: safePath,
      data: projectFile.buffer,
      contentType: projectFile.mime,
      sourcePath: safePath,
    });

    if (/\.css$/i.test(safePath)) {
      const cssBase = path.posix.dirname(safePath);
      for (const ref of collectParsedReferences(projectFile.buffer.toString('utf8'), safePath, 'css', warnings)) {
        pending.push({ ref, base: cssBase, sourcePath: safePath });
      }
    } else if (/\.(?:html?|svg)$/i.test(safePath)) {
      const page = projectFile.buffer.toString('utf8');
      pending.push(...publicationReferencesForHtml(page, safePath, 0, warnings));
    } else if (/\.(?:m?js|cjs)$/i.test(safePath)) {
      for (const ref of collectParsedReferences(projectFile.buffer.toString('utf8'), safePath, 'js', warnings)) {
        pending.push({ ref, base: path.posix.dirname(safePath), sourcePath: safePath });
      }
    }
  }

  if (publicationScope && (missing.length || invalid.length)) {
    throw new DeployError('Agency Site contains missing or out-of-scope public assets.', 400, { missing, invalid }, 'INVALID_PUBLICATION_SCOPE');
  }

  await assertInsertedUnitPublicationRights(publicationSourcePaths, (name) =>
    readProjectFile(projectsRoot, projectId, name, options.metadata));

  return {
    entryPath,
    html,
    files: Array.from(files.values()),
    missing,
    invalid,
    warnings,
  };
}

export async function prepareDeployPublication(projectsRoot: string, projectId: string, entryName: string, options: DeployOptions = {}) {
  const plan = await buildDeployFilePlan(projectsRoot, projectId, entryName, options);
  if (plan.missing.length || plan.invalid.length) {
    const parts = [];
    if (plan.missing.length) parts.push(`missing: ${plan.missing.join(', ')}`);
    if (plan.invalid.length) parts.push(`invalid: ${plan.invalid.join(', ')}`);
    throw new DeployError(`Could not deploy referenced files (${parts.join('; ')}).`, 400, {
      missing: plan.missing,
      invalid: plan.invalid,
    }, 'MISSING_REFERENCES');
  }
  return { files: plan.files, warnings: plan.warnings };
}

export async function buildDeployFileSet(projectsRoot: string, projectId: string, entryName: string, options: DeployOptions = {}) {
  return (await prepareDeployPublication(projectsRoot, projectId, entryName, options)).files;
}

function collectParsedReferences(source: string, sourcePath: string, kind: 'css' | 'js', warnings: DeployPreflightWarning[]): string[] {
  try {
    return kind === 'css' ? cssPublicationReferences(source) : scriptPublicationReferences(source);
  } catch (error) {
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.name === 'CssSyntaxError')) throw error;
    warnings.push({ code: 'reference-scan-fallback', path: sourcePath, message: `Could not parse ${sourcePath}; used the regex reference scan and kept the file in the publication.` });
    return kind === 'css' ? fallbackCssPublicationReferences(source) : fallbackScriptPublicationReferences(source);
  }
}

const VERCEL_FILE_UPLOAD_CONCURRENCY = 8;

export function vercelFileDigest(data: Buffer | Uint8Array | string) {
  return createHash('sha1').update(Buffer.from(data)).digest('hex');
}

// Vercel's deployment request used to carry every file inline as base64, which the API caps
// at 10 MB per request; an agency site with its photography (Emmpo: 87 files, 24.9 MB) could
// never deploy. Files now go up one at a time through the file-upload API, keyed by SHA-1, and
// the deployment request only references those digests.
async function uploadVercelFiles(config: DeployConfig, files: DeployFile[]) {
  const entries = files.map((f) => {
    const data = Buffer.from(f.data);
    return { file: f.file, data, sha: vercelFileDigest(data), size: data.length };
  });
  const pending = new Map<string, { data: Buffer; size: number }>();
  for (const entry of entries) if (!pending.has(entry.sha)) pending.set(entry.sha, entry);
  const queue = Array.from(pending.entries());
  // The first failed upload stops the pool: in-flight requests are aborted and the queue is
  // left alone, so a rate-limit cascade does not keep spending the token on a deploy that
  // has already failed. Promise.all surfaces that first error; the aborted siblings' errors
  // are handled by the same Promise.all and never escape.
  const controller = new AbortController();
  const uploadNext = async () => {
    for (let next = queue.shift(); next && !controller.signal.aborted; next = queue.shift()) {
      const [sha, { data }] = next;
      try {
        const resp = await fetch(`${VERCEL_API}/v2/files${vercelTeamQuery(config)}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.token}`,
            'Content-Type': 'application/octet-stream',
            'x-vercel-digest': sha,
          },
          body: data,
          signal: controller.signal,
        });
        if (!resp.ok) throw vercelError(await readVercelJson(resp), resp.status);
        await resp.arrayBuffer();
      } catch (error) {
        controller.abort();
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(VERCEL_FILE_UPLOAD_CONCURRENCY, queue.length) }, uploadNext));
  return entries.map(({ file, sha, size }) => ({ file, sha, size }));
}

export async function deployToVercel({ config, files, projectId, projectName, priorMetadata, onBinding, publicAccess = false }: { config: DeployConfig; files: DeployFile[]; projectId: string; projectName?: string | undefined; priorMetadata?: JsonObject; onBinding?: (binding: VercelBinding) => void; publicAccess?: boolean }) {
  if (!config?.token) {
    throw new DeployError('Vercel token is required.', 400, undefined, 'VERCEL_TOKEN_REQUIRED');
  }

  const binding = await bindVercelSite(config, projectId, projectName, priorMetadata);
  onBinding?.(binding);
  config = { ...config, ...(binding.vercelTeamId ? { teamId: binding.vercelTeamId } : {}) };
  const uploaded = await uploadVercelFiles(config, files);
  const createResp = await fetch(`${VERCEL_API}/v13/deployments${vercelTeamQuery(config)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      name: binding.vercelProjectName,
      project: binding.vercelProjectId,
      files: uploaded,
      projectSettings: { framework: null },
    }),
  });

  const created = await readVercelJson(createResp);
  if (!createResp.ok) {
    if (createResp.status === 409 || created.error?.code === 'project_name_taken') {
      const { vercelSiteNameSuggestion } = await import('@mish/contracts');
      throw new DeployError('The Vercel site name is taken.', 409, { suggestion: vercelSiteNameSuggestion(binding.vercelProjectName, '2') }, 'VERCEL_NAME_TAKEN');
    }
    throw vercelError(created, createResp.status);
  }

  const deploymentId = created.id || created.uid;
  const initialUrl = deploymentUrl(created);
  const ready = deploymentId
    ? await pollVercelDeployment(config, deploymentId)
    : created;
  if (ready?.readyState === 'ERROR') {
    throw new DeployError(ready?.error?.message || 'Vercel deployment failed.', 502, ready, 'VERCEL_DEPLOY_FAILED');
  }

  if (!deploymentId || String(created.projectId || ready?.projectId || '') !== binding.vercelProjectId ||
    (ready?.projectId && ready.projectId !== binding.vercelProjectId) || (ready?.id && ready.id !== deploymentId)) {
    throw new DeployError('Vercel returned a deployment for a different project.', 502, undefined, 'VERCEL_IDENTITY_MISMATCH');
  }
  const vercel = await bindVercelStableAlias(config, binding, String(deploymentId), deploymentUrl(ready) || initialUrl, [...(Array.isArray(ready?.alias) ? ready.alias : []), ...(Array.isArray(created.alias) ? created.alias : [])]);
  const probeUrls = [vercel.stableUrl!];
  const siteMetadata = { ...binding, vercel };
  // What the uploaded entry page looks like, so the anonymous GET can prove
  // it reached THIS page and not a wall; kept for Retry in provider metadata.
  const pageMarker = pageMarkerFromFiles(files);

  // The account's "Vercel Authentication" setting (ssoProtection on the
  // od-* project) walls off every preview with an SSO login even though the
  // deployment itself succeeded — every hosted preview needed this turned
  // off by hand before it was shareable, and the daemon never said so. Ask
  // the project directly instead of inferring it from the URL probe: a
  // confirmed answer skips the probe and reports honestly; an unreadable
  // one (403, network) falls back to the probe and says the check failed.
  const vercelProjectId = String(created.projectId || ready?.projectId || '');

  // "Make preview public": the same wall, answered instead of only reported.
  // Only an explicit `publicAccess` request writes anything, and only to the
  // provider project this daemon created and bound to this OD project — the project id
  // comes from the deployment response, never from a caller-supplied URL, and
  // makeVercelPreviewPublic refuses unless the project's own name is the name
  // this OD project owns. Any refusal keeps the honest `protected`
  // result rather than a link the recipient cannot open.
  const publicAccessResult = publicAccess
    ? await makeVercelPreviewPublic(config, vercelProjectId, binding.vercelProjectName, binding.vercelAccountId)
    : null;
  if (publicAccessResult && publicAccessResult.outcome !== 'ready') {
    const access = vercelLinkAccess({ protection: publicAccessResult.protection });
    return {
      providerId: VERCEL_PROVIDER_ID,
      url: probeUrls[0] || initialUrl,
      deploymentId,
      target: 'preview',
      // `protected` only for a confirmed wall; a read or write that failed
      // proves nothing about the link.
      status: vercelUnprobedLinkStatus(access),
      statusMessage: publicAccessResult.message,
      access,
      publicAccess: true,
      publicAccessOutcome: publicAccessResult.outcome,
      // The Vercel project id is kept so "Retry link" can re-verify this exact
      // project later without trusting anything the client sends. Provider
      // metadata never reaches the client (publicDeployment strips it).
      vercel,
      providerMetadata: { ...siteMetadata, ...vercelPublicProviderMetadata(vercelProjectId, publicAccessResult.protection, pageMarker) },
    };
  }

  // A successful unprotect already re-read the project, so reuse that
  // confirmed answer instead of spending a third GET on the same question.
  const protection = publicAccessResult?.protection
    ?? await readVercelProjectProtection(config, vercelProjectId);

  if (protection.checked && (protection.sso || protection.password)) {
    return {
      providerId: VERCEL_PROVIDER_ID,
      url: probeUrls[0] || initialUrl,
      deploymentId,
      target: 'preview',
      status: 'protected' as DeployLinkStatus,
      statusMessage: vercelProtectionStatusMessage(protection),
      access: 'protected' as DeploymentAccess,
      ...(publicAccessResult ? { publicAccess: true } : {}),
      vercel,
      providerMetadata: { ...siteMetadata, ...vercelPublicProviderMetadata(vercelProjectId, protection, pageMarker) },
    };
  }

  // With protection confirmed off, a wall is Vercel's edge catching up rather
  // than a refusal, so the probe tolerates it for a bounded window instead of
  // failing on the first answer (see VERCEL_PUBLIC_ACCESS_PROBE_GRACE_MS).
  const link = await waitForReachableDeploymentUrl(probeUrls, {
    providerLabel: 'Vercel',
    ...(publicAccessResult
      ? {
          protectedGraceMs: VERCEL_PUBLIC_ACCESS_PROBE_GRACE_MS,
          confirmations: VERCEL_PUBLIC_ACCESS_PROBE_CONFIRMATIONS,
        }
      : {}),
  });
  const protectionUnknown = !protection.checked && link.status !== 'protected';
  const access = await resolveVercelLinkAccess({
    protection,
    linkStatus: link.status,
    url: link.url || deploymentUrl(ready) || initialUrl,
    marker: pageMarker,
  });

  return {
    providerId: VERCEL_PROVIDER_ID,
    url: link.url || deploymentUrl(ready) || initialUrl,
    deploymentId,
    target: 'preview',
    status: link.status,
    // A preview whose protection this deploy just cleared, yet which still
    // answers with a login wall for the whole window, is not the generic
    // "turn protection off" case — that step already succeeded. A link that
    // answered gets the access sentence: an unread project is never "ready".
    statusMessage: publicAccessResult && link.status === 'protected'
      ? VERCEL_PUBLIC_ACCESS_MESSAGES['auth-wall']
      : link.status === 'ready'
        ? deployLinkSentence({ access, status: link.status })
        : protectionUnknown
          ? `${link.statusMessage} ${VERCEL_PROTECTION_UNKNOWN_NOTE}`
          : link.statusMessage,
    access,
    reachableAt: link.reachableAt,
    ...(publicAccessResult
      ? { publicAccess: true, publicAccessOutcome: publicAccessOutcomeForLink(link.status, access) }
      : {}),
    vercel,
    providerMetadata: { ...siteMetadata, ...vercelPublicProviderMetadata(vercelProjectId, protection.checked ? protection : undefined, pageMarker) },
  };
}

/**
 * Provider-private facts about a Vercel deployment: the protection this daemon
 * last observed, and the project id it observed it on. Never leaves the daemon
 * — `publicDeployment` strips `providerMetadata` from every response — but the
 * id is what lets "Retry link" re-verify the same project without taking a
 * target from the client. Returns `undefined` when there is nothing to record,
 * which `upsertDeployment` reads as "keep what is stored".
 */
function vercelPublicProviderMetadata(
  vercelProjectId: string,
  protection?: VercelProjectProtection,
  pageMarker?: PageMarker | null,
): JsonObject | undefined {
  const body: JsonObject = {
    ...(protection ? { protection: { sso: protection.sso, password: protection.password } } : {}),
    ...(vercelProjectId ? { vercelProjectId } : {}),
    ...(pageMarker ? { pageMarker } : {}),
  };
  return Object.keys(body).length > 0 ? body : undefined;
}

type VercelProjectProtection = { checked: boolean; sso: string | null; password: boolean };

const VERCEL_PROTECTION_UNKNOWN_NOTE =
  "Deployment protection could not be checked; verify the Vercel project's Deployment Protection settings before sharing this link.";

// Reads the account-level Deployment Protection settings straight from the
// project (GET /v9/projects/:id), since a walled preview and an unprotected
// one otherwise look identical to the deploy call itself. Never throws: a
// missing projectId, a non-2xx response (403 on a token without project
// read access), or a network failure all resolve to `checked: false` so the
// caller can fall back to the URL probe instead of failing the deploy.
async function readVercelProjectProtection(config: DeployConfig, projectId: string, identity?: { name: string; accountId: string }): Promise<VercelProjectProtection> {
  if (!projectId) return { checked: false, sso: null, password: false };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), VERCEL_PROTECTION_CHECK_TIMEOUT_MS);
  try {
    const resp = await fetch(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}${vercelTeamQuery(config)}`, {
      headers: { Authorization: `Bearer ${config.token}` },
      signal: controller.signal,
    });
    if (!resp.ok) return { checked: false, sso: null, password: false };
    const json = await readVercelJson(resp);
    if (identity && (json.name !== identity.name || json.accountId !== identity.accountId)) return { checked: false, sso: null, password: false };
    return vercelProtectionFromProject(json, projectId);
  } catch {
    // Network failure OR the timeout above aborting the request — both mean
    // "could not check", same as a non-2xx response.
    return { checked: false, sso: null, password: false };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * How long a preview may keep answering with Vercel's authentication wall
 * AFTER the protection settings have been read back clear. A live deploy
 * returned `protected` 3.2s after a PATCH that had worked — the edge simply
 * had not caught up, and one second later the same URL answered 200. Below
 * this budget a wall means "not yet"; above it, it means the change did not
 * take. The overall reachability budget is unchanged, so a preview that is
 * merely still building keeps its existing `link-delayed` semantics.
 */
const VERCEL_PUBLIC_ACCESS_PROBE_GRACE_MS = 30_000;

/**
 * How many consecutive anonymous successes are needed before a preview is
 * called public. A live deploy answered `ready` and then served the SSO wall
 * 0.4s later, with the project's protection provably off: for several seconds
 * after the change Vercel's edge answers inconsistently in BOTH directions, so
 * one success is no more conclusive than one wall.
 */
const VERCEL_PUBLIC_ACCESS_PROBE_CONFIRMATIONS = 2;

type VercelPublicAccessResult = {
  outcome: DeployPublicAccessOutcome;
  message: string;
  protection?: VercelProjectProtection;
};

const VERCEL_PUBLIC_ACCESS_MESSAGES: Record<DeployPublicAccessOutcome, string> = {
  'ready': deployLinkSentence({ access: 'public', status: 'ready' }),
  'pending':
    'Deployment protection is off, but the preview is not reachable yet. Use Retry link in a moment to confirm it is public.',
  'no-project':
    'Vercel did not say which project this deployment belongs to, so deployment protection was left on.',
  'read-failed':
    "Could not read the Vercel project's settings, so deployment protection was left on. Turn it off under the project's Deployment Protection settings to make this preview public.",
  'name-mismatch':
    'Refused to change deployment protection: the Vercel project behind this deployment is not the one this project generates. Nothing was changed.',
  'patch-transport':
    "Could not reach Vercel to turn deployment protection off, so it is unknown whether the change was applied. Check the project's Deployment Protection settings before sharing this link.",
  'patch-rejected':
    'Vercel refused to turn deployment protection off for this project. The preview stays behind its protection wall.',
  'verify-failed':
    "Vercel accepted the change, but its result could not be read back, so it is unconfirmed. Check the project's Deployment Protection settings before sharing this link.",
  'still-protected':
    "Vercel accepted the change, but the project reads as still protected. The preview stays behind Vercel's protection wall.",
  'auth-wall':
    "Deployment protection reads as off, but the preview kept answering with an authentication wall. Check the Vercel project's Deployment Protection settings before sharing this link.",
  'challenged': VERCEL_CHALLENGED_LINK_MESSAGE,
};

function vercelPublicAccessResult(
  outcome: DeployPublicAccessOutcome,
  extra: { detail?: string; protection?: VercelProjectProtection } = {},
): VercelPublicAccessResult {
  const base = VERCEL_PUBLIC_ACCESS_MESSAGES[outcome];
  return {
    outcome,
    message: extra.detail ? `${base} (${extra.detail})` : base,
    ...(extra.protection ? { protection: extra.protection } : {}),
  };
}

/**
 * Turns Vercel Authentication and password protection off on ONE generated
 * `od-*` project, and proves it: the project is read first and the write is
 * refused unless its own name is exactly the name this OD project generates,
 * so a deployment pointing at somebody else's project can never be rewritten.
 * The setting is then re-read, because a 200 on the PATCH is Vercel accepting
 * the request, not the wall being down.
 *
 * Never throws, and never reports `ready` for anything it could not confirm.
 * Each way this can fail gets its own outcome, because "could not read the
 * project", "could not deliver the write", "the write was refused" and "the
 * write was accepted but unverifiable" call for different things from the
 * user — and only the first two leave the protection provably untouched.
 */
async function makeVercelPreviewPublic(
  config: DeployConfig,
  projectId: string,
  expectedName: string,
  expectedAccountId?: string,
): Promise<VercelPublicAccessResult> {
  if (!projectId) return vercelPublicAccessResult('no-project');

  const identity = await readVercelProjectForPublicAccess(config, projectId, expectedName, expectedAccountId);
  if (identity) return identity;

  const patched = await vercelProjectRequest(config, projectId, {
    ssoProtection: null,
    passwordProtection: null,
  });
  if (!patched.ok) {
    // A transport failure has no HTTP status; formatting one as `HTTP 0` would
    // invent a provider response that never arrived.
    return patched.transportError
      ? vercelPublicAccessResult('patch-transport')
      : vercelPublicAccessResult('patch-rejected', { detail: `HTTP ${patched.status}` });
  }

  const reread = await vercelProjectRequest(config, projectId);
  if (!reread.ok) return vercelPublicAccessResult('verify-failed');
  const protection = vercelProtectionFromProject(reread.json, projectId);
  // A 200 that is not a readable copy of this project verifies nothing.
  if (!protection.checked) return vercelPublicAccessResult('verify-failed');
  if (protection.sso || protection.password) {
    return vercelPublicAccessResult('still-protected', { protection });
  }
  return vercelPublicAccessResult('ready', { protection });
}

/**
 * Reads the project and checks it is the one this OD project owns.
 * Returns a failure result, or `null` when the project is confirmed ours.
 */
async function readVercelProjectForPublicAccess(
  config: DeployConfig,
  projectId: string,
  expectedName: string,
  expectedAccountId?: string,
): Promise<VercelPublicAccessResult | null> {
  const project = await vercelProjectRequest(config, projectId);
  if (!project.ok) return vercelPublicAccessResult('read-failed');
  // Deliberately does NOT echo the name Vercel returned: the identity that
  // matters is the one this daemon derives from its own project id, and an
  // upstream name has no business in a user-facing message.
  if (String(project.json?.name || '') !== expectedName || String(project.json?.id || '') !== projectId || (expectedAccountId && project.json?.accountId !== expectedAccountId)) {
    return vercelPublicAccessResult('name-mismatch');
  }
  return null;
}

/**
 * Re-confirms an existing public-access deployment without changing anything:
 * read the project, check it is ours, require both protections clear, then
 * probe the preview with the same bounded tolerance the deploy path uses. The
 * "Retry link" button runs this, so a user who hit the edge's catch-up window
 * gets their answer without paying for a redeploy.
 */
export async function recheckVercelPublicAccessLink(input: {
  odProjectId: string;
  vercelProjectId: string;
  url: unknown;
  pageMarker?: unknown;
  priorMetadata?: JsonObject;
  deploymentId?: string;
}): Promise<{ status: DeployLinkStatus; url: string; statusMessage: string; outcome: DeployPublicAccessOutcome; access: DeploymentAccess; reachableAt?: number }> {
  const config = await readVercelConfig();
  const expectedName = input.priorMetadata?.vercelProjectName || vercelProjectNameForProject(input.odProjectId);
  const url = normalizeDeploymentUrl(input.url);
  const marker = parsePageMarker(input.pageMarker);
  const failed = (result: VercelPublicAccessResult) => {
    const access = vercelLinkAccess({ protection: result.protection });
    // A failed read is `unknown`; only a confirmed protection is `protected`.
    return { status: vercelUnprobedLinkStatus(access), url, statusMessage: result.message, outcome: result.outcome, access };
  };

  if (!config?.token) return failed(vercelPublicAccessResult('read-failed'));
  if (!input.vercelProjectId) return failed(vercelPublicAccessResult('no-project'));

  if (input.priorMetadata?.vercelAccountId && input.deploymentId) {
    try { await verifyVercelStoredAlias(config, input.priorMetadata, input.deploymentId, url); }
    catch { return failed(vercelPublicAccessResult('verify-failed')); }
  }
  const identity = await readVercelProjectForPublicAccess(config, input.vercelProjectId, expectedName, input.priorMetadata?.vercelAccountId);
  if (identity) return failed(identity);
  const reread = await vercelProjectRequest(config, input.vercelProjectId);
  if (!reread.ok) return failed(vercelPublicAccessResult('verify-failed'));
  const protection = vercelProtectionFromProject(reread.json, input.vercelProjectId);
  if (!protection.checked) return failed(vercelPublicAccessResult('verify-failed'));
  if (protection.sso || protection.password) {
    return failed(vercelPublicAccessResult('still-protected', { protection }));
  }

  const link = await waitForReachableDeploymentUrl([url], {
    providerLabel: 'Vercel',
    protectedGraceMs: VERCEL_PUBLIC_ACCESS_PROBE_GRACE_MS,
    confirmations: VERCEL_PUBLIC_ACCESS_PROBE_CONFIRMATIONS,
  });
  const access = await resolveVercelLinkAccess({ protection, linkStatus: link.status, url: link.url || url, marker });
  const outcome = publicAccessOutcomeForLink(link.status, access);
  if (outcome === 'ready') {
    return {
      status: 'ready',
      url: link.url || url,
      statusMessage: deployLinkSentence({ access, status: 'ready' }),
      outcome,
      access,
      ...(link.reachableAt ? { reachableAt: link.reachableAt } : {}),
    };
  }
  if (outcome === 'auth-wall') {
    return { status: 'protected', url: link.url || url, statusMessage: VERCEL_PUBLIC_ACCESS_MESSAGES['auth-wall'], outcome, access };
  }
  if (outcome === 'challenged') {
    return { status: 'challenged', url: link.url || url, statusMessage: VERCEL_PUBLIC_ACCESS_MESSAGES.challenged, outcome, access };
  }
  // Answered, but only with a redirect: reachable, not confirmed public.
  if (link.status === 'ready') {
    return {
      status: 'ready',
      url: link.url || url,
      statusMessage: deployLinkSentence({ access, status: 'ready' }),
      outcome,
      access,
      ...(link.reachableAt ? { reachableAt: link.reachableAt } : {}),
    };
  }
  return { status: link.status as DeployLinkStatus, url: link.url || url, statusMessage: VERCEL_PUBLIC_ACCESS_MESSAGES.pending, outcome, access };
}

/**
 * "Retry link" for a Vercel deployment made WITHOUT "Make preview public".
 * Read-only: re-reads the project's Deployment Protection (GET only — this
 * never changes a setting) and probes the URL once, so the answer carries an
 * honest `access` instead of calling any 200 or redirect "public". The Vercel
 * project id comes from the stored record's provider metadata, never from the
 * client. A missing id, token or unreadable project leaves `access` unknown.
 */
export async function recheckVercelLink(input: {
  priorMetadata?: JsonObject;
  deploymentId?: string;
  vercelProjectId: string;
  url: unknown;
  pageMarker?: unknown;
}): Promise<{ status: DeployLinkStatus; url: string; statusMessage: string; access: DeploymentAccess; reachableAt?: number }> {
  const url = normalizeDeploymentUrl(input.url);
  const config = await readVercelConfig();
  if (input.priorMetadata?.vercelAccountId && input.deploymentId) {
    try {
      await verifyVercelStoredAlias(config, input.priorMetadata, input.deploymentId, url);
    } catch {
      return { status: 'unknown', url, statusMessage: 'The saved Vercel identity or alias could not be verified for this deployment.', access: 'unknown' };
    }
  }
  const protection: VercelProjectProtection = config?.token && input.vercelProjectId
    ? await readVercelProjectProtection(config, input.vercelProjectId, input.priorMetadata?.vercelAccountId ? { name: input.priorMetadata.vercelProjectName, accountId: input.priorMetadata.vercelAccountId } : undefined)
    : VERCEL_PROTECTION_UNCHECKED;
  const result = await checkDeploymentUrl(url);
  const linkStatus: DeployLinkStatus = result.reachable ? 'ready' : (result.status || 'link-delayed');
  const access = await resolveVercelLinkAccess({ protection, linkStatus, url, marker: parsePageMarker(input.pageMarker) });
  const statusMessage = linkStatus === 'ready'
    ? deployLinkSentence({ access, status: linkStatus })
    : protection.checked && (protection.sso || protection.password)
      ? vercelProtectionStatusMessage(protection)
      : result.statusMessage || 'Vercel is still preparing the public link.';
  return {
    status: linkStatus,
    url,
    statusMessage,
    access,
    ...(result.reachable ? { reachableAt: Date.now() } : {}),
  };
}

/**
 * The one place a probe result becomes a public-access outcome. `ready` is
 * defined by the contract as anonymous reachability CONFIRMED, so a link that
 * is merely not up yet is `pending` — reporting it as `ready` would say the
 * preview had been proven public when nothing had reached it.
 */
function publicAccessOutcomeForLink(linkStatus: string, access?: DeploymentAccess): DeployPublicAccessOutcome {
  // A redirect-only answer is reachable but not proof of public access.
  if (linkStatus === 'ready') return access === undefined || access === 'public' ? 'ready' : 'pending';
  if (linkStatus === 'protected') return 'auth-wall';
  // A checkpoint is neither reachable nor a wall, and it is not "not up yet"
  // either: reporting it as `pending` would tell the user to wait for a link
  // that only ever needs a browser.
  if (linkStatus === 'challenged') return 'challenged';
  return 'pending';
}

/**
 * One `GET`/`PATCH` against `/v9/projects/:id`, team-scoped like every other
 * Vercel call here. Resolves rather than throws so each caller decides what an
 * unreachable provider means; `body` present makes it the PATCH.
 * `transportError` separates "the provider said no" from "the request never
 * arrived", which are different facts about the project's state.
 */
async function vercelProjectRequest(
  config: DeployConfig,
  projectId: string,
  body?: JsonObject,
): Promise<{ ok: boolean; status: number; json: JsonObject | null; transportError: boolean }> {
  const controller = new AbortController();
  // The timeout covers the WHOLE exchange, headers and body alike. Clearing
  // it once headers arrived left `resp.json()` unguarded, so a 2xx that
  // stalls its body hung the deploy — or Retry — for as long as the socket
  // stayed open.
  const timer = setTimeout(() => controller.abort(), VERCEL_PROTECTION_CHECK_TIMEOUT_MS);
  try {
    let resp: Response;
    try {
      resp = await fetch(`${VERCEL_API}/v9/projects/${encodeURIComponent(projectId)}${vercelTeamQuery(config)}`, {
        method: body ? 'PATCH' : 'GET',
        headers: {
          Authorization: `Bearer ${config.token}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch {
      // Only this much is a transport failure: the request never completed, so
      // nothing is known about the project's state. Reading the body is a
      // separate question and must not be folded in here — a 204 or a
      // non-JSON 2xx would otherwise be reported as "Vercel was unreachable"
      // for a write that landed.
      return { ok: false, status: 0, json: null, transportError: true };
    }
    if (!resp.ok) {
      await discardResponseBody(resp);
      return { ok: false, status: resp.status, json: null, transportError: false };
    }
    // A successful PATCH needs no body: the verification GET that follows is
    // what establishes the project's state.
    if (body) {
      await discardResponseBody(resp);
      return { ok: true, status: resp.status, json: null, transportError: false };
    }
    try {
      return { ok: true, status: resp.status, json: await resp.json() as JsonObject, transportError: false };
    } catch {
      // A 2xx whose body cannot be read — unparsable, or abandoned by the
      // timeout above — tells us nothing about the settings. The provider
      // answered, though, so this is not a transport failure: the caller
      // reports it as an unreadable/unverifiable project, not an unreachable
      // one.
      return { ok: false, status: resp.status, json: null, transportError: false };
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Releases a response body the caller will never read. Leaving it undrained
 * holds the connection open until the socket times out, which is wasteful for
 * a PATCH acknowledgement and an error envelope alike.
 */
async function discardResponseBody(resp: Response) {
  try {
    await resp.body?.cancel();
  } catch {
    // Already consumed, already cancelled, or a response shape without a
    // stream. Nothing to release, and nothing the caller needs to know.
  }
}

const VERCEL_PROTECTION_UNCHECKED: VercelProjectProtection = { checked: false, sso: null, password: false };

/**
 * Turns a project read into protection settings, but only when the body is
 * provably the project that was asked for: a JSON object whose `id` (or
 * `name`, which Vercel also accepts in the path) matches, with each
 * protection field either absent/null or the object Vercel documents. A 200
 * carrying `null`, `{}`, another project, or a field of the wrong type says
 * nothing about THIS project's settings, so it is `checked: false` — never
 * "protection off".
 */
function vercelProtectionFromProject(json: unknown, projectId: string): VercelProjectProtection {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return VERCEL_PROTECTION_UNCHECKED;
  const project = json as JsonObject;
  const identity = [project.id, project.name].filter((value): value is string => typeof value === 'string' && value !== '');
  if (!projectId || !identity.includes(projectId)) return VERCEL_PROTECTION_UNCHECKED;
  const sso = project.ssoProtection;
  const password = project.passwordProtection;
  const isSetting = (value: unknown) => value === undefined || value === null || (typeof value === 'object' && !Array.isArray(value));
  if (!isSetting(sso) || !isSetting(password)) return VERCEL_PROTECTION_UNCHECKED;
  let ssoType: string | null = null;
  if (sso) {
    const deploymentType = (sso as JsonObject).deploymentType;
    // An SSO object without a readable deployment type is still a wall, but
    // an unreadable one: report it as unknown rather than guess.
    if (typeof deploymentType !== 'string' || !deploymentType) return VERCEL_PROTECTION_UNCHECKED;
    ssoType = deploymentType;
  }
  return { checked: true, sso: ssoType, password: Boolean(password) };
}

function vercelProtectionStatusMessage(protection: VercelProjectProtection): string {
  if (protection.sso) {
    return `Preview is behind Vercel Authentication (project setting: ${protection.sso}). Turn it off under the Vercel project's Deployment Protection settings, or share it with team members only.`;
  }
  return "Preview is behind a password set in the Vercel project's Deployment Protection settings. Turn it off there, or share the password with reviewers.";
}

export async function listCloudflarePagesZones(config: DeployConfig) {
  if (!config?.token) throw new DeployError('Cloudflare API token is required.', 400, undefined, 'CF_TOKEN_REQUIRED');
  if (!config?.accountId) throw new DeployError('Cloudflare account ID is required.', 400, undefined, 'CF_ACCOUNT_ID_REQUIRED');
  const accountId = config.accountId;
  const zones = await fetchCloudflarePaginatedResult(
    config,
    (page, perPage) => {
      const params = new URLSearchParams({
        'account.id': accountId,
        status: 'active',
        type: 'full',
        page: String(page),
        per_page: String(perPage),
      });
      return `${CLOUDFLARE_API}/zones?${params.toString()}`;
    },
    'Cloudflare zones lookup failed.',
  );
  return {
    zones: zones
      .map((zone) => ({
        id: typeof zone?.id === 'string' ? zone.id : '',
        name: normalizeCloudflareZoneName(zone?.name),
        status: typeof zone?.status === 'string' ? zone.status : undefined,
        type: typeof zone?.type === 'string' ? zone.type : undefined,
      }))
      .filter((zone) => zone.id && zone.name),
    cloudflarePages: normalizeCloudflarePagesConfigHints(config?.cloudflarePages),
  };
}

export async function deployToCloudflarePages(input: { config: DeployConfig; files: DeployFile[]; projectId?: string; cloudflarePages?: unknown; priorMetadata?: JsonObject | undefined; target?: 'preview' | 'production' }) {
  const {
    config,
    files,
    projectId = '',
    cloudflarePages = undefined,
    priorMetadata = undefined,
    target = 'production',
  } = input || {};
  if (!config?.token) throw new DeployError('Cloudflare API token is required.', 400, undefined, 'CF_TOKEN_REQUIRED');
  if (!config?.accountId) throw new DeployError('Cloudflare account ID is required.', 400, undefined, 'CF_ACCOUNT_ID_REQUIRED');
  if (!config?.projectName) throw new DeployError('Cloudflare Pages project name could not be generated.', 400, undefined, 'CF_PROJECT_NAME_UNRESOLVED');

  const customDomainSelection = await validateCloudflarePagesDeploySelection(
    config,
    normalizeCloudflarePagesDeploySelection(cloudflarePages),
  );

  await ensureCloudflarePagesProject(config);

  const uploadToken = await getCloudflarePagesUploadToken(config);
  await uploadCloudflarePagesAssets(uploadToken, files);

  const form = new FormData();
  const manifest: Record<string, string> = {};
  for (const file of files) {
    manifest[`/${file.file}`] = cloudflarePagesAssetHash(file);
  }
  form.append('manifest', JSON.stringify(manifest));
  const deployBranch = target === 'preview' ? 'preview' : 'main';
  form.append('branch', deployBranch);

  const deployResp = await fetch(cloudflarePagesProjectUrl(config, 'deployments'), {
    method: 'POST',
    headers: cloudflareHeaders(config),
    body: form,
  });
  const deployed = await readCloudflareJson(deployResp);
  if (!deployResp.ok || deployed?.success === false) {
    throw cloudflareError(deployed, deployResp.status, 'Cloudflare Pages deployment failed.');
  }

  const deployment = deployed?.result ?? deployed;
  const pageMarker = pageMarkerFromFiles(input.files);
  const productionUrl = cloudflarePagesProductionUrl(config);
  const urlCandidates = target === 'preview'
    ? (deployment?.url ? [deployment.url] : [])
    : (productionUrl ? [productionUrl] : [deployment?.url]);
  const link = await waitForReachableDeploymentUrl(
    urlCandidates,
    { providerLabel: 'Cloudflare Pages' },
  );
  const pagesDevUrl = target === 'preview'
    ? (link.url || deploymentUrl(deployment) || productionUrl)
    : (productionUrl || link.url || deploymentUrl(deployment));
  const pagesDevStatus = normalizeDeploymentLinkStatus(link.status);
  // Public only when the probe anonymously reached a final 2xx on pages.dev;
  // a redirect (Cloudflare Access login included) is followed, not trusted.
  const pagesDevAccess = await resolveCloudflarePagesAccess({
    url: link.url || pagesDevUrl,
    linkStatus: pagesDevStatus,
    marker: pageMarker,
  });
  const pagesDev = {
    url: pagesDevUrl,
    status: pagesDevStatus,
    statusMessage: deployLinkSentence({ access: pagesDevAccess, status: pagesDevStatus, fallback: link.statusMessage }),
    access: pagesDevAccess,
    reachableAt: link.reachableAt,
  };
  const customDomain = customDomainSelection
    ? await setupCloudflarePagesCustomDomain({
        config,
        projectId,
        selection: customDomainSelection,
        pagesDevUrl,
        priorMetadata,
        pageMarker,
      })
    : undefined;
  const cloudflarePagesInfo = {
    projectName: config.projectName,
    pagesDev,
    ...(customDomain ? { customDomain } : {}),
  };
  const aggregate = aggregateCloudflarePagesStatus(pagesDev, customDomain);

  return {
    providerId: CLOUDFLARE_PAGES_PROVIDER_ID,
    url: pagesDevUrl,
    deploymentId: deployment?.id,
    target,
    status: aggregate.status,
    statusMessage: aggregate.statusMessage,
    access: pagesDevAccess,
    reachableAt: link.reachableAt,
    cloudflarePages: cloudflarePagesInfo,
    providerMetadata: cloudflarePagesProviderMetadata(config.projectName, cloudflarePagesInfo, { projectId, pageMarker }),
  };
}

/**
 * The access of a Cloudflare Pages link (pages.dev or a custom domain) the
 * probe called `ready`. The probe's HEAD or bare redirect proves only that
 * the host answered, so the answer is `public` only after an anonymous GET
 * reached the deployed page itself (see `confirmAnonymousPageGet`). Anything
 * unresolved, or a record with no page marker to match, stays `unknown`.
 */
export async function resolveCloudflarePagesAccess(
  { url, linkStatus, marker }: { url: unknown; linkStatus: unknown; marker: PageMarker | null | undefined },
  { timeoutMs = 8_000 }: { timeoutMs?: number } = {},
): Promise<DeploymentAccess> {
  if (linkStatus !== 'ready') return 'unknown';
  return await confirmAnonymousPageGet(normalizeDeploymentUrl(url), { timeoutMs, marker }) ? 'public' : 'unknown';
}

function normalizeDeploymentLinkStatus(status: unknown): DeployLinkStatus {
  return status === 'ready' || status === 'protected' || status === 'challenged' || status === 'failed' || status === 'unknown'
    ? status
    : 'link-delayed';
}

function normalizeCloudflarePagesDeploySelection(input: unknown): CloudflarePagesDeploySelection | null {
  if (!input || typeof input !== 'object') return null;
  const source = input as JsonObject;
  const rawZoneId = typeof source.zoneId === 'string' ? source.zoneId.trim() : '';
  const rawZoneName = typeof source.zoneName === 'string' ? source.zoneName.trim() : '';
  const rawPrefix = typeof source.domainPrefix === 'string' ? source.domainPrefix.trim() : '';
  if (!rawZoneId && !rawZoneName && !rawPrefix) return null;
  const zoneName = normalizeCloudflareZoneName(rawZoneName);
  const domainPrefix = normalizeCloudflareDomainPrefix(rawPrefix);
  if (!rawZoneId) throw new DeployError('Cloudflare zone is required for a custom domain.', 400, undefined, 'CF_ZONE_REQUIRED');
  if (!zoneName || !isValidCloudflareZoneName(zoneName)) {
    throw new DeployError('Select a valid Cloudflare domain for the custom domain.', 400, undefined, 'CF_ZONE_INVALID');
  }
  if (!domainPrefix) {
    throw new DeployError('Enter a valid subdomain prefix, for example "demo".', 400, undefined, 'CF_SUBDOMAIN_INVALID');
  }
  return {
    zoneId: rawZoneId,
    zoneName,
    domainPrefix,
    hostname: `${domainPrefix}.${zoneName}`,
  };
}

async function validateCloudflarePagesDeploySelection(config: DeployConfig, selection: CloudflarePagesDeploySelection | null): Promise<CloudflarePagesDeploySelection | null> {
  if (!selection) return null;
  const resp = await fetch(`${CLOUDFLARE_API}/zones/${encodeURIComponent(selection.zoneId)}`, {
    headers: cloudflareHeaders(config),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare zone lookup failed.');
  }
  const zone = json?.result ?? json;
  const zoneName = normalizeCloudflareZoneName(zone?.name);
  if (!zoneName || zoneName !== selection.zoneName) {
    throw new DeployError('Cloudflare zone selection no longer matches the selected domain.', 400, {
      errorCode: 'cloudflare_zone_mismatch',
    }, 'CF_ZONE_MISMATCH');
  }
  if (zone?.status && zone.status !== 'active') {
    throw new DeployError('Cloudflare custom domains require an active zone.', 400, {
      errorCode: 'cloudflare_zone_inactive',
    }, 'CF_ZONE_INACTIVE');
  }
  if (zone?.type && zone.type !== 'full') {
    throw new DeployError('Cloudflare custom domains require a full DNS zone.', 400, {
      errorCode: 'cloudflare_zone_not_full',
    }, 'CF_ZONE_PARTIAL');
  }
  return { ...selection, zoneName };
}

async function setupCloudflarePagesCustomDomain({ config, projectId, selection, pagesDevUrl, priorMetadata, pageMarker }: { config: DeployConfig; projectId: string; selection: CloudflarePagesDeploySelection; pagesDevUrl: string; priorMetadata?: JsonObject | undefined; pageMarker: PageMarker | null }) {
  if (!config.projectName) throw new DeployError('Cloudflare Pages project name could not be generated.', 400, undefined, 'CF_PROJECT_NAME_UNRESOLVED');
  const pagesTarget = normalizeHostname(hostnameFromUrl(pagesDevUrl) || `${config.projectName}.pages.dev`);
  const marker = cloudflarePagesDnsMarker(projectId, config.projectName, pagesTarget);
  const base = {
    hostname: selection.hostname,
    url: `https://${selection.hostname}`,
    zoneId: selection.zoneId,
    zoneName: selection.zoneName,
    domainPrefix: selection.domainPrefix,
  };

  let dns;
  try {
    dns = await ensureCloudflarePagesCnameRecord({
      config,
      selection,
      target: pagesTarget,
      marker,
      priorMetadata,
    });
  } catch (err) {
    const details = err instanceof DeployError && err.details && typeof err.details === 'object'
      ? err.details
      : {};
    return {
      ...base,
      status: details.errorCode === 'cloudflare_dns_record_conflict' ? 'conflict' : 'failed',
      statusMessage: errorMessage(err, 'Cloudflare DNS record setup failed.'),
      errorCode: details.errorCode || 'cloudflare_dns_record_failed',
      errorMessage: errorMessage(err, 'Cloudflare DNS record setup failed.'),
      dnsStatus: details.dnsStatus || (details.errorCode === 'cloudflare_dns_record_conflict' ? 'conflict' : 'failed'),
      dnsRecordId: details.dnsRecordId,
      dnsOwnership: details.dnsOwnership || 'external',
      domainStatus: 'skipped',
    };
  }

  let domain;
  try {
    domain = await ensureCloudflarePagesDomain(config, selection.hostname);
  } catch (err) {
    const details = err instanceof DeployError && err.details && typeof err.details === 'object'
      ? err.details
      : {};
    return {
      ...base,
      status: details.errorCode === 'cloudflare_domain_already_bound' ? 'conflict' : 'failed',
      statusMessage: errorMessage(err, 'Cloudflare Pages custom domain setup failed.'),
      errorCode: details.errorCode || 'cloudflare_domain_setup_failed',
      errorMessage: errorMessage(err, 'Cloudflare Pages custom domain setup failed.'),
      dnsStatus: dns.dnsStatus,
      dnsRecordId: dns.dnsRecordId,
      dnsOwnership: dns.dnsOwnership,
      domainStatus: details.domainStatus || 'failed',
    };
  }

  const domainStatus = normalizeCloudflarePagesDomainStatus(domain?.status);
  const customLink = domainStatus === 'active'
    ? await checkDeploymentUrl(base.url)
    : null;
  const ready = domainStatus === 'active' && customLink?.reachable;
  const failed = domainStatus === 'failed';
  // The custom domain is its own URL with its own answer: pages.dev being
  // public says nothing about a hostname an Access policy may cover.
  const access: DeploymentAccess = ready
    ? await resolveCloudflarePagesAccess({ url: base.url, linkStatus: 'ready', marker: pageMarker })
    : 'unknown';
  return {
    ...base,
    status: ready ? 'ready' : failed ? 'failed' : 'pending',
    access,
    statusMessage: ready
      ? 'Custom domain is ready.'
      : failed
        ? 'Cloudflare Pages reported a custom-domain error.'
        : customLink?.statusMessage || 'Custom domain is being verified by Cloudflare Pages.',
    errorCode: failed ? 'cloudflare_domain_setup_failed' : undefined,
    dnsStatus: dns.dnsStatus,
    dnsRecordId: dns.dnsRecordId,
    dnsOwnership: dns.dnsOwnership,
    domainStatus,
    pagesDomainStatus: typeof domain?.status === 'string' ? domain.status : undefined,
    validationData: domain?.validation_data,
    verificationData: domain?.verification_data,
  };
}

async function ensureCloudflarePagesCnameRecord({ config, selection, target, marker, priorMetadata }: { config: DeployConfig; selection: CloudflarePagesDeploySelection; target: string; marker: string; priorMetadata?: JsonObject | undefined }) {
  const records = await listCloudflareDnsRecords(config, selection.zoneId, selection.hostname);
  const targetHost = normalizeHostname(target);
  const exact = findExactCloudflarePagesCname(records, selection, targetHost);
  if (exact) {
    return cloudflarePagesCnameReuseResult(exact, marker);
  }

  const conflicting = findCloudflarePagesHostnameRecord(records, selection);
  if (conflicting) {
    if (canPatchCloudflarePagesCname(conflicting, selection, marker, priorMetadata)) {
      const conflictingId = conflicting.id;
      if (!conflictingId) throw new DeployError('Cloudflare DNS record id is missing.', 502, undefined, 'CF_DNS_RECORD_MISSING');
      const patched = await patchCloudflareDnsRecord(config, selection.zoneId, conflictingId, {
        type: 'CNAME',
        name: selection.hostname,
        content: targetHost,
        proxied: true,
        ttl: 1,
        comment: marker,
      });
      return {
        dnsStatus: 'patched',
        dnsRecordId: patched?.id || conflictingId,
        dnsOwnership: 'marked',
        marker,
      };
    }
    throw cloudflarePagesDnsConflictError(selection, conflicting);
  }

  try {
    const created = await createCloudflareDnsRecord(config, selection.zoneId, {
      type: 'CNAME',
      name: selection.hostname,
      content: targetHost,
      proxied: true,
      ttl: 1,
      comment: marker,
    });
    return {
      dnsStatus: 'created',
      dnsRecordId: created?.id,
      dnsOwnership: 'marked',
      marker,
    };
  } catch (err) {
    const racedRecord = await maybeReuseCloudflarePagesCnameAfterDuplicate({
      err,
      config,
      selection,
      targetHost,
      marker,
    });
    if (racedRecord) return racedRecord;
    if (!(err instanceof DeployError) || !isCloudflareCommentError(err.details || err.message)) throw err;
    try {
      const created = await createCloudflareDnsRecord(config, selection.zoneId, {
        type: 'CNAME',
        name: selection.hostname,
        content: targetHost,
        proxied: true,
        ttl: 1,
      });
      return {
        dnsStatus: 'created',
        dnsRecordId: created?.id,
        dnsOwnership: 'unmarked',
        marker,
      };
    } catch (retryErr) {
      const racedRetryRecord = await maybeReuseCloudflarePagesCnameAfterDuplicate({
        err: retryErr,
        config,
        selection,
        targetHost,
        marker,
      });
      if (racedRetryRecord) return racedRetryRecord;
      throw retryErr;
    }
  }
}

function findExactCloudflarePagesCname(records: CloudflareDnsRecord[], selection: CloudflarePagesDeploySelection, targetHost: string) {
  return records.find((record) => (
    String(record?.type || '').toUpperCase() === 'CNAME' &&
    normalizeHostname(record?.name) === selection.hostname &&
    normalizeHostname(record?.content) === targetHost
  ));
}

function findCloudflarePagesHostnameRecord(records: CloudflareDnsRecord[], selection: CloudflarePagesDeploySelection) {
  return records.find((record) => normalizeHostname(record?.name) === selection.hostname);
}

function cloudflarePagesCnameReuseResult(record: CloudflareDnsRecord, marker: string) {
  return {
    dnsStatus: 'reused',
    dnsRecordId: typeof record.id === 'string' ? record.id : undefined,
    dnsOwnership: record.comment === marker ? 'marked' : 'unmarked',
    marker,
  };
}

function cloudflarePagesDnsConflictError(selection: CloudflarePagesDeploySelection, conflicting: CloudflareDnsRecord) {
  return new DeployError(
    `Cloudflare DNS already has a different record for ${selection.hostname}.`,
    409,
    {
      errorCode: 'cloudflare_dns_record_conflict',
      dnsStatus: 'conflict',
      dnsRecordId: conflicting.id,
      dnsOwnership: 'external',
    },
    'CF_DNS_RECORD_CONFLICT',
  );
}

async function maybeReuseCloudflarePagesCnameAfterDuplicate({ err, config, selection, targetHost, marker }: { err: unknown; config: DeployConfig; selection: CloudflarePagesDeploySelection; targetHost: string; marker: string }) {
  if (!(err instanceof DeployError) || !isCloudflareAlreadyExists(err.details || err.message)) return null;
  const racedRecords = await listCloudflareDnsRecords(config, selection.zoneId, selection.hostname);
  const exact = findExactCloudflarePagesCname(racedRecords, selection, targetHost);
  if (exact) return cloudflarePagesCnameReuseResult(exact, marker);
  const conflicting = findCloudflarePagesHostnameRecord(racedRecords, selection);
  if (conflicting) throw cloudflarePagesDnsConflictError(selection, conflicting);
  throw err;
}

async function listCloudflareDnsRecords(config: DeployConfig, zoneId: string, hostname: string): Promise<CloudflareDnsRecord[]> {
  const params = new URLSearchParams({
    name: hostname,
    per_page: '100',
  });
  const resp = await fetch(`${cloudflareZoneDnsRecordsUrl(zoneId)}?${params.toString()}`, {
    headers: cloudflareHeaders(config),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare DNS record lookup failed.');
  }
  return Array.isArray(json?.result) ? json.result : [];
}

async function createCloudflareDnsRecord(config: DeployConfig, zoneId: string, body: JsonObject) {
  const resp = await fetch(cloudflareZoneDnsRecordsUrl(zoneId), {
    method: 'POST',
    headers: cloudflareHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare DNS record creation failed.');
  }
  return json?.result ?? json;
}

async function patchCloudflareDnsRecord(config: DeployConfig, zoneId: string, dnsRecordId: string, body: JsonObject) {
  const resp = await fetch(`${cloudflareZoneDnsRecordsUrl(zoneId)}/${encodeURIComponent(dnsRecordId)}`, {
    method: 'PATCH',
    headers: cloudflareHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify(body),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare DNS record update failed.');
  }
  return json?.result ?? json;
}

function canPatchCloudflarePagesCname(record: CloudflareDnsRecord, selection: CloudflarePagesDeploySelection, marker: string, priorMetadata?: JsonObject) {
  const prior = priorMetadata?.cloudflarePagesCustomDomain;
  return (
    record &&
    String(record.type || '').toUpperCase() === 'CNAME' &&
    typeof record.id === 'string' &&
    record.id &&
    record.id === prior?.dnsRecordId &&
    normalizeHostname(record.name) === selection.hostname &&
    record.comment === marker &&
    prior?.marker === marker
  );
}

async function ensureCloudflarePagesDomain(config: DeployConfig, hostname: string) {
  const existing = await findCloudflarePagesDomain(config, hostname);
  if (existing) return existing;

  const resp = await fetch(cloudflarePagesProjectUrl(config, 'domains'), {
    method: 'POST',
    headers: cloudflareHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ name: hostname }),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    if (isCloudflareAlreadyExists(json)) {
      const retry = await findCloudflarePagesDomain(config, hostname);
      if (retry) return retry;
      throw new DeployError(
        `Cloudflare Pages says ${hostname} is already bound to another project.`,
        409,
        {
          errorCode: 'cloudflare_domain_already_bound',
          domainStatus: 'conflict',
        },
        'CF_DOMAIN_ALREADY_BOUND',
      );
    }
    throw cloudflareError(json, resp.status, 'Cloudflare Pages custom domain setup failed.');
  }
  return json?.result ?? json;
}

async function findCloudflarePagesDomain(config: DeployConfig, hostname: string) {
  const normalizedHostname = normalizeHostname(hostname);
  if (!normalizedHostname) return null;
  const resp = await fetch(cloudflarePagesProjectDomainUrl(config, normalizedHostname), {
    headers: cloudflareHeaders(config),
  });
  const json = await readCloudflareJson(resp);
  if (resp.status === 404) return null;
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare Pages custom domain lookup failed.');
  }
  const domain = json?.result ?? json;
  return normalizeHostname(domain?.name) === normalizedHostname ? domain : null;
}

export async function readCloudflarePagesDomain(config: DeployConfig, hostname: string) {
  if (!config?.token) throw new DeployError('Cloudflare API token is required.', 400, undefined, 'CF_TOKEN_REQUIRED');
  if (!config?.accountId) throw new DeployError('Cloudflare account ID is required.', 400, undefined, 'CF_ACCOUNT_ID_REQUIRED');
  if (!config?.projectName) throw new DeployError('Cloudflare Pages project name could not be generated.', 400, undefined, 'CF_PROJECT_NAME_UNRESOLVED');
  return findCloudflarePagesDomain(config, hostname);
}

function normalizeCloudflarePagesDomainStatus(status: unknown) {
  const value = String(status || '').toLowerCase();
  if (value === 'active') return 'active';
  if (value === 'error' || value === 'blocked' || value === 'deactivated') return 'failed';
  return 'pending';
}

export function aggregateCloudflarePagesStatus(pagesDev: JsonObject, customDomain?: JsonObject) {
  if (!customDomain) {
    return {
      status: pagesDev.status,
      statusMessage: pagesDev.statusMessage,
    };
  }
  if (customDomain.status === 'ready') {
    return {
      status: pagesDev.status === 'ready' ? 'ready' : 'link-delayed',
      statusMessage: pagesDev.status === 'ready'
        ? 'Cloudflare Pages and custom domain are ready.'
        : pagesDev.statusMessage || 'Cloudflare Pages is still preparing its pages.dev link.',
    };
  }
  if (customDomain.status === 'pending') {
    return {
      status: 'link-delayed',
      statusMessage: customDomain.statusMessage || 'Custom domain is still being prepared.',
    };
  }
  const customFailureMessage = customDomain.errorMessage || customDomain.statusMessage || 'Custom domain setup failed.';
  return {
    status: pagesDev.status,
    statusMessage: pagesDev.status === 'ready'
      ? `pages.dev is ready. ${customFailureMessage}`
      : pagesDev.statusMessage || customFailureMessage,
  };
}

function cloudflarePagesProviderMetadata(projectName: string, cloudflarePagesInfo: JsonObject, { projectId = '', pageMarker = null }: { projectId?: string; pageMarker?: PageMarker | null } = {}) {
  const custom = cloudflarePagesInfo?.customDomain;
  return {
    cloudflarePagesProjectName: projectName,
    cloudflarePages: cloudflarePagesInfo,
    ...(pageMarker ? { pageMarker } : {}),
    ...(custom ? {
      cloudflarePagesCustomDomain: {
        projectId,
        pagesProjectName: projectName,
        hostname: custom.hostname,
        zoneId: custom.zoneId,
        zoneName: custom.zoneName,
        domainPrefix: custom.domainPrefix,
        marker: cloudflarePagesDnsMarker(projectId, projectName, hostnameFromUrl(cloudflarePagesInfo.pagesDev?.url)),
        dnsRecordId: custom.dnsRecordId,
        dnsOwnership: custom.dnsOwnership,
      },
    } : {}),
  };
}

async function ensureCloudflarePagesProject(config: DeployConfig) {
  const getResp = await fetch(cloudflarePagesProjectUrl(config), {
    headers: cloudflareHeaders(config),
  });
  const found = await readCloudflareJson(getResp);
  if (getResp.ok && found?.success !== false) return found?.result ?? found;
  if (getResp.status !== 404) {
    throw cloudflareError(found, getResp.status, 'Cloudflare Pages project lookup failed.');
  }

  const createResp = await fetch(cloudflareAccountPagesProjectsUrl(config), {
    method: 'POST',
    headers: cloudflareHeaders(config, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      name: config.projectName,
      production_branch: 'main',
    }),
  });
  const created = await readCloudflareJson(createResp);
  if (!createResp.ok || created?.success === false) {
    if (isCloudflarePagesProjectAlreadyExists(created)) {
      const retryResp = await fetch(cloudflarePagesProjectUrl(config), {
        headers: cloudflareHeaders(config),
      });
      const retryFound = await readCloudflareJson(retryResp);
      if (retryResp.ok && retryFound?.success !== false) {
        return retryFound?.result ?? retryFound;
      }
    }
    throw cloudflareError(created, createResp.status, 'Cloudflare Pages project creation failed.');
  }
  return created?.result ?? created;
}

function isCloudflarePagesProjectAlreadyExists(body: unknown) {
  const text = JSON.stringify(body || {}).toLowerCase();
  return (
    text.includes('already exists') ||
    text.includes('already exist') ||
    text.includes('project exists') ||
    text.includes('project name is taken') ||
    text.includes('duplicate')
  );
}

async function getCloudflarePagesUploadToken(config: DeployConfig): Promise<string> {
  const tokenResp = await fetch(cloudflarePagesProjectUrl(config, 'upload-token'), {
    headers: cloudflareHeaders(config),
  });
  const tokenBody = await readCloudflareJson(tokenResp);
  const jwt = tokenBody?.result?.jwt || tokenBody?.jwt;
  if (!tokenResp.ok || tokenBody?.success === false || !jwt) {
    throw cloudflareError(tokenBody, tokenResp.status, 'Cloudflare Pages upload token request failed.');
  }
  return jwt;
}

async function uploadCloudflarePagesAssets(uploadToken: string, files: DeployFile[]) {
  const uniqueFiles = new Map<string, { hash: string; data: Buffer; contentType: string }>();
  for (const file of files) {
    const data = Buffer.from(file.data);
    if (data.length > CLOUDFLARE_PAGES_ASSET_MAX_BYTES) {
      throw new DeployError(
        `Cloudflare Pages assets must be ${formatMib(CLOUDFLARE_PAGES_ASSET_MAX_BYTES)} or smaller: ${file.file} is ${formatMib(data.length)}.`,
        400,
        undefined,
        'CF_ASSET_TOO_LARGE',
      );
    }
    const hash = cloudflarePagesAssetHash({ ...file, data });
    if (!uniqueFiles.has(hash)) {
      uniqueFiles.set(hash, {
        hash,
        data,
        contentType: file.contentType || 'application/octet-stream',
      });
    }
  }
  const hashes = Array.from(uniqueFiles.keys());
  const missing = await cloudflarePagesMissingAssetHashes(uploadToken, hashes);
  if (missing.length > 0) {
    const missingFiles = missing.map((hash) => {
      const file = uniqueFiles.get(hash);
      if (!file) throw new DeployError(`Cloudflare reported an unknown asset hash: ${hash}`, 502, undefined, 'CF_UNKNOWN_ASSET_HASH');
      return {
        ...file,
        hash,
      };
    });

    for (const batch of chunkCloudflarePagesAssetUploads(missingFiles)) {
      const payload = batch.map((file) => ({
        key: file.hash,
        value: file.data.toString('base64'),
        metadata: {
          contentType: file.contentType,
        },
        base64: true,
      }));
      const uploadResp = await fetch(`${CLOUDFLARE_API}/pages/assets/upload`, {
        method: 'POST',
        headers: cloudflareAssetHeaders(uploadToken, { 'Content-Type': 'application/json' }),
        body: JSON.stringify(payload),
      });
      const uploaded = await readCloudflareJson(uploadResp);
      if (!uploadResp.ok || uploaded?.success === false) {
        throw cloudflareError(uploaded, uploadResp.status, 'Cloudflare Pages asset upload failed.');
      }
    }
  }

  const upsertResp = await fetch(`${CLOUDFLARE_API}/pages/assets/upsert-hashes`, {
    method: 'POST',
    headers: cloudflareAssetHeaders(uploadToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ hashes }),
  });
  const upserted = await readCloudflareJson(upsertResp);
  if (!upsertResp.ok || upserted?.success === false) {
    throw cloudflareError(upserted, upsertResp.status, 'Cloudflare Pages asset hash update failed.');
  }
}

export function chunkCloudflarePagesAssetUploads(
  files: { hash: string; data: Buffer | Uint8Array | string; contentType?: string }[],
  {
    maxFiles = CLOUDFLARE_PAGES_ASSET_UPLOAD_MAX_FILES,
    maxBytes = CLOUDFLARE_PAGES_ASSET_UPLOAD_MAX_BODY_BYTES,
  } = {},
) {
  const chunks: typeof files[] = [];
  let current: typeof files = [];
  let currentBytes = 2; // JSON array brackets.

  for (const file of files) {
    const nextBytes = estimateCloudflarePagesAssetUploadPayloadBytes(file);
    const wouldExceedCount = current.length >= maxFiles;
    const wouldExceedBytes = current.length > 0 && currentBytes + nextBytes > maxBytes;
    if (wouldExceedCount || wouldExceedBytes) {
      chunks.push(current);
      current = [];
      currentBytes = 2;
    }
    current.push(file);
    currentBytes += nextBytes;
  }

  if (current.length > 0) chunks.push(current);
  return chunks;
}

function estimateCloudflarePagesAssetUploadPayloadBytes(file: { hash?: string; data?: Buffer | Uint8Array | string; contentType?: string }) {
  const data = Buffer.from(file?.data ?? '');
  const encodedBytes = Math.ceil(data.length / 3) * 4;
  const contentTypeBytes = Buffer.byteLength(file?.contentType || 'application/octet-stream');
  const hashBytes = Buffer.byteLength(file?.hash || '');
  // Conservative JSON/object overhead for `key`, `value`, `metadata`, and commas.
  return encodedBytes + contentTypeBytes + hashBytes + 128;
}

async function cloudflarePagesMissingAssetHashes(uploadToken: string, hashes: string[]): Promise<string[]> {
  const resp = await fetch(`${CLOUDFLARE_API}/pages/assets/check-missing`, {
    method: 'POST',
    headers: cloudflareAssetHeaders(uploadToken, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ hashes }),
  });
  const json = await readCloudflareJson(resp);
  if (!resp.ok || json?.success === false) {
    throw cloudflareError(json, resp.status, 'Cloudflare Pages asset lookup failed.');
  }
  const result = json?.result ?? json;
  return Array.isArray(result) ? result : Array.isArray(result?.hashes) ? result.hashes : hashes;
}

export function cloudflarePagesAssetHash(file: Pick<DeployFile, 'file' | 'data'>) {
  const data = Buffer.from(file.data);
  const extension = path.posix.extname(file.file).slice(1);
  return blake3Hash(`${data.toString('base64')}${extension}`).toString('hex').slice(0, 32);
}

function resourceAttributes(tagName: string, attributes: Map<string, string>): string[] {
  const attrs: string[] = [];
  const scriptType = (attributes.get('type') ?? '').trim().toLowerCase().split(';')[0] ?? '';
  const executableScript = scriptType === '' || scriptType === 'module' || /^(?:application|text)\/(?:x-)?(?:java|ecma)script$|^text\/(?:javascript1\.[0-5]|jscript|livescript)$/.test(scriptType);
  if (['img', 'iframe', 'audio', 'video', 'source', 'track', 'embed'].includes(tagName)
    || (tagName === 'script' && executableScript)
    || (tagName === 'input' && attributes.get('type')?.trim().toLowerCase() === 'image')) attrs.push('src');
  if (tagName === 'video') attrs.push('poster');
  if (tagName === 'object') attrs.push('data');
  if (tagName === 'image' || tagName === 'use') attrs.push('xlink:href');
  return attrs;
}

/** A document base changes every relative URL, including inline CSS and root-relative paths. */
function publicationHtmlBase(html: string, documentPath: string, warnings: DeployPreflightWarning[]): string | null {
  const documentBase = path.posix.dirname(documentPath);
  const href = loadHtml(html)('base[href]').first().attr('href');
  if (!href) return documentBase;
  if (isExternalUrl(href)) return null;
  let resolved;
  try { resolved = resolveReferencedPath(href, documentBase); }
  catch (error) {
    if (!(error instanceof MalformedPublicationPathError)) throw error;
    warnings.push(invalidEncodingWarning(href, documentPath));
    return documentBase;
  }
  if (!resolved) return documentBase;
  return href.split(/[?#]/)[0]?.endsWith('/') ? resolved.replace(/\/$/, '') || '.' : path.posix.dirname(resolved);
}

export function extractHtmlReferences(html: string) {
  return htmlPublicationReferences(html).map((item) => item.ref);
}

function htmlPublicationReferences(html: string): { ref: string; optional?: boolean }[] {
  const refs: { ref: string; optional?: boolean }[] = [];
  const document = loadHtml(html);
  for (const tag of document('*').toArray()) {
    if (!('attribs' in tag) || !('name' in tag)) continue;
    const attrs = new Map(Object.entries(tag.attribs));
    const parentName = document(tag).parent().get(0);
    const mediaParent = parentName && 'name' in parentName && (parentName.name === 'video' || parentName.name === 'audio');
    const pictureParent = parentName && 'name' in parentName && parentName.name === 'picture';
    for (const name of resourceAttributes(tag.name, attrs)) {
      if (tag.name === 'iframe' && name === 'src' && attrs.has('srcdoc')) continue;
      if ((tag.name === 'source' || tag.name === 'track') && name === 'src' && !mediaParent) continue;
      const value = attrs.get(name);
      if (value) refs.push({ ref: value });
    }
    const href = attrs.get('href');
    if (href && shouldCollectHref(tag.name, attrs)) refs.push({ ref: href, optional: tag.name === 'a' || tag.name === 'area' });
    const imagePreload = tag.name === 'link' && attrs.get('as')?.toLowerCase() === 'image' && (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).includes('preload');
    const srcset = tag.name === 'img' || (tag.name === 'source' && pictureParent) ? attrs.get('srcset') : imagePreload ? attrs.get('imagesrcset') : undefined;
    if (srcset) refs.push(...srcsetPublicationReferences(srcset).map((ref) => ({ ref })));
  }
  return refs;
}

function publicationReferencesForHtml(html: string, documentPath: string, depth = 0, warnings: DeployPreflightWarning[] = []): PublicationReference[] {
  if (depth > 32) throw new SyntaxError('Publication HTML nesting is too deep.');
  const base = publicationHtmlBase(html, documentPath, warnings);
  if (base === null) return [];
  const refs = htmlPublicationReferences(html).map((item) => ({ ...item, base, sourcePath: documentPath }));
  for (const ref of inlinePublicationReferences(html, documentPath, warnings)) refs.push({ ref, base, sourcePath: documentPath });
  const document = loadHtml(html);
  for (const iframe of document('iframe[srcdoc]').toArray()) {
    const srcdoc = document(iframe).attr('srcdoc') ?? '';
    refs.push(...publicationReferencesForHtml(srcdoc, path.posix.join(base, 'srcdoc.html'), depth + 1, warnings));
  }
  return refs;
}

// Inline `<style>`, `style=""` and `<script type="module">` sources go through the same
// parse-or-fallback path as external .css/.js files: a syntax error in one inline block
// degrades to the regex scan with a `reference-scan-fallback` warning instead of failing
// the whole publication.
function inlinePublicationReferences(html: string, documentPath: string, warnings: DeployPreflightWarning[]): string[] {
  const document = loadHtml(html);
  const refs: string[] = [];
  const fallbacksBefore = warnings.length;
  for (const block of document('style').toArray()) refs.push(...collectParsedReferences(document(block).text(), documentPath, 'css', warnings));
  for (const tag of document('[style]').toArray()) {
    const style = document(tag).attr('style');
    if (style) refs.push(...collectParsedReferences(style, documentPath, 'css', warnings));
  }
  for (const script of document('script').toArray()) {
    const tag = document(script);
    if (tag.attr('type')?.trim().toLowerCase() === 'module' && !tag.attr('src')) refs.push(...collectParsedReferences(tag.text(), documentPath, 'js', warnings));
  }
  // An entry outside the project root is moved to the deploy root, and its references are
  // rewritten. Inline code that does not parse is published unchanged rather than rewritten
  // by guesswork, so say plainly that its relative references may not resolve.
  if (warnings.length > fallbacksBefore && path.posix.dirname(documentPath) !== '.') {
    warnings.push({ code: 'inline-reference-not-relocated', path: documentPath, message: `Inline CSS or module code in ${documentPath} could not be parsed, so its relative references were not relocated to the site root; fix the code or use root-relative paths.` });
  }
  return refs;
}

function extractInlineModuleReferences(html: string): string[] {
  const document = loadHtml(html);
  return document('script').toArray().flatMap((script) => {
    const tag = document(script);
    return tag.attr('type')?.trim().toLowerCase() === 'module' && !tag.attr('src') ? scriptPublicationReferences(tag.text()) : [];
  });
}

export function extractCssReferences(css: string) {
  return cssPublicationReferences(css);
}

// Collect url() / @import references from inline `<style>` blocks and
// `style="..."` attributes. These bypass the external-stylesheet path
// (link rel=stylesheet -> .css file -> extractCssReferences) but still
// pull in real assets, e.g. background images and @font-face sources.
//
// Style-like text that lives inside `<script>` string literals or HTML
// comments is intentionally skipped, mirroring how extractHtmlReferences
// treats those raw-text regions.
export function extractInlineCssReferences(html: string) {
  const refs: string[] = [];
  const document = loadHtml(html);
  for (const block of document('style').toArray()) refs.push(...extractCssReferences(document(block).text()));
  for (const tag of document('[style]').toArray()) {
    const style = document(tag).attr('style');
    if (style) refs.push(...extractCssReferences(style));
  }

  return refs;
}

// Rewrite url() / @import references inside a CSS string so that paths
// resolved relative to `baseDir` survive the entry-HTML being moved to
// the deploy root. Mirrors `rewriteHtmlReference` for HTML attributes.
// Uses the same declaration/token rules as `extractCssReferences`.
// Inline CSS or module source that does not parse is published unchanged: the publication
// scan already fell back to the regex scan and warned (`reference-scan-fallback`, plus
// `inline-reference-not-relocated` for a moved entry), and a rewrite must not turn that
// warning into a failed deploy or guess at a rewrite that could change page content.
function rewriteOrKeepUnparsable(source: string, rewrite: () => string): string {
  try {
    return rewrite();
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && error.name === 'CssSyntaxError')) return source;
    throw error;
  }
}

export function rewriteCssReferences(css: string, baseDir: string) {
  return rewriteCssPublicationReferences(css, (ref) => rewriteHtmlReference(ref, baseDir));
}

export function resolveReferencedPath(raw: unknown, baseDir: string) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return null;
  if (trimmed.startsWith('//')) return null;
  const withoutHash = trimmed.split('#')[0] ?? '';
  const withoutQuery = withoutHash.split('?')[0] ?? '';
  if (!withoutQuery) return null;
  let decoded;
  try { decoded = decodeURIComponent(withoutQuery); }
  catch (error) {
    if (error instanceof URIError) throw new MalformedPublicationPathError();
    throw error;
  }
  if (/\\|\0|(?:^|\/)\.\.(?:\/|$)/.test(decoded)) throw new DeployError('Invalid publication path.', 400, undefined, 'INVALID_PUBLICATION_PATH');
  const local = decoded.startsWith('/') ? decoded.slice(1) : decoded;
  if (local === '' || local === './' || local === '.') return decoded.startsWith('/') ? '.' : baseDir || '.';
  validateProjectPath(local.replace(/^\.\//, ''));
  return path.posix.normalize(decoded.startsWith('/') ? local : path.posix.join(baseDir || '.', local));
}

export function rewriteEntryHtmlReferences(html: string, baseDir: string) {
  const source = String(html);
  const baseHref = loadHtml(html)('base[href]').first().attr('href');
  if (baseHref) {
    // Preserve the document's own URL model. Only relocate a local base when
    // the entry is moved to index.html; its relative resource URLs stay intact.
    if (isExternalUrl(baseHref)) return source;
    let resolvedBase;
    try { resolvedBase = resolveReferencedPath(baseHref, baseDir); }
    catch (error) {
      if (!(error instanceof MalformedPublicationPathError)) throw error;
      const document = loadHtml(html);
      document('base[href]').remove();
      return rewriteEntryHtmlReferences(document.html(), baseDir);
    }
    if (resolvedBase) {
      const trailingSlash = baseHref.split(/[?#]/)[0]?.endsWith('/') ? '/' : '';
      const basePath = resolvedBase.replace(/\/$/, '') || '.';
      const document = loadHtml(html);
      document('base[href]').first().attr('href', `/${basePath === '.' ? '' : encodePublicationUrlPath(basePath)}${basePath === '.' ? '' : trailingSlash}${referenceSuffix(baseHref)}`);
      return document.html();
    }
  }
  // Compute raw-text ranges against the input first so the style-block
  // pre-pass can skip `<style>...</style>` text that lives inside a
  // `<script>` string literal or an HTML comment. Without this gate, a
  // template like `const tpl = '<style>...url("foo")...</style>'` would
  // get mutated, changing runtime JS behavior.
  const scriptRanges = htmlRawTextRanges(source);
  const modulesRewritten = source.replace(
    /(<script\b((?:[^"'<>]|"[^"]*"|'[^']*')*)>)([\s\S]*?)(<\/script\s*>)/gi,
    (full, openTag, rawAttrs, content, closeTag, offset) => {
      const attrs = parseHtmlAttributes(rawAttrs);
      if (isOffsetInRanges(offset, scriptRanges) || attrs.has('src') || attrs.get('type')?.trim().toLowerCase() !== 'module') return full;
      return `${openTag}${rewriteOrKeepUnparsable(content, () => rewriteScriptPublicationReferences(content, (ref) => {
        const relocated = rewriteHtmlReference(ref, baseDir);
        return relocated === ref ? ref : `/${relocated}`;
      }))}${closeTag}`;
    },
  );
  const inputRawTextRanges = htmlRawTextRanges(modulesRewritten);
  const styleRewritten = modulesRewritten.replace(
    /(<style\b[^<>]*>)([\s\S]*?)(<\/style\s*>)/gi,
    (full, openTag, content, closeTag, offset) => {
      if (isOffsetInRanges(offset, inputRawTextRanges)) return full;
      return `${openTag}${rewriteOrKeepUnparsable(content, () => rewriteCssReferences(content, baseDir))}${closeTag}`;
    },
  );
  // Re-derive raw-text ranges against the post-style HTML: rewriting can
  // shift offsets, and the tag-attribute pass below skips raw-text
  // regions by absolute offset. Two scans are intentional, deploy is
  // not a hot path and the cost is linear in document size.
  const rawTextRanges = htmlRawTextRanges(styleRewritten);
  return styleRewritten.replace(/<([A-Za-z][A-Za-z0-9:-]*)((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g, (tag, rawName, rawAttrs, offset) => {
    if (isOffsetInRanges(offset, rawTextRanges)) return tag;
    const tagName = String(rawName).toLowerCase();
    const attrs = parseHtmlAttributes(rawAttrs);
    return `<${rawName}${rewriteHtmlAttributes(rawAttrs, tagName, attrs, baseDir)}>`;
  });
}

// Soft thresholds chosen against Vercel's v13 deployment shape and
// typical first-paint budgets. Per-asset is a usability hint, not a
// hard cap; bundle is a margin against Vercel's 100MB request body
// (each file is base64-encoded which adds ~33%, so 75MiB pre-encoded
// is the safer ceiling).
export const DEPLOY_PREFLIGHT_LARGE_ASSET_BYTES = 4 * 1024 * 1024;
export const DEPLOY_PREFLIGHT_LARGE_BUNDLE_BYTES = 75 * 1024 * 1024;
export const DEPLOY_PREFLIGHT_LARGE_HTML_BYTES = 1 * 1024 * 1024;

function isExternalUrl(value: unknown) {
  if (typeof value !== 'string') return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(trimmed)) return true;
  if (trimmed.startsWith('//')) return true;
  return false;
}

function pushUnique(list: { warnings: JsonObject[]; seen: Set<string> }, warning: JsonObject) {
  const key = `${warning.code}:${warning.path ?? ''}:${warning.url ?? ''}`;
  if (list.seen.has(key)) return;
  list.seen.add(key);
  list.warnings.push(warning);
}

// Walk the entry HTML once to gather signals that affect deployment
// quality without touching the network. Returns a structured warning
// list the UI can render verbatim.
//
// `entryPath` is used as the warning `path` for HTML-level findings so
// the UI can deep-link from a warning into the source file the author
// is actually editing. `files` carries deploy-relative paths (the entry
// HTML is always renamed to `index.html`) so per-asset warnings live in
// the deploy namespace.
/**
 * @param {{
 *   entryPath: string,
 *   html: string,
 *   files: any[],
 *   missing?: any[],
 *   invalid?: any[]
 * }} input
 * @returns {{ warnings: any[], totalBytes: number, totalFiles: number }}
 */
export function analyzeDeployPlan(input: {
  entryPath: string;
  html: string;
  files: DeployFile[];
  missing?: string[];
  invalid?: string[];
}): { warnings: JsonObject[]; totalBytes: number; totalFiles: number } {
  const { entryPath, html, files } = input;
  const missing = input.missing ?? [];
  const invalid = input.invalid ?? [];
  const acc: { warnings: JsonObject[]; seen: Set<string> } = { warnings: [], seen: new Set() };

  for (const ref of missing) {
    pushUnique(acc, {
      code: 'broken-reference',
      path: ref,
      message: `Referenced file is missing on disk: ${ref}`,
    });
  }
  for (const ref of invalid) {
    pushUnique(acc, {
      code: 'invalid-reference',
      path: ref,
      message: `Reference is not a valid project path: ${ref}`,
    });
  }

  let totalBytes = 0;
  let entrySize = 0;
  for (const f of files || []) {
    const size = f.data?.length ?? 0;
    totalBytes += size;
    if (f.file === 'index.html') entrySize = size;
    if (size > DEPLOY_PREFLIGHT_LARGE_ASSET_BYTES && f.file !== 'index.html') {
      pushUnique(acc, {
        code: 'large-asset',
        path: f.file,
        size,
        message: `Asset is ${formatMib(size)}, larger than ${formatMib(DEPLOY_PREFLIGHT_LARGE_ASSET_BYTES)}; consider compressing or hosting on a CDN.`,
      });
    }
  }

  if (entrySize > DEPLOY_PREFLIGHT_LARGE_HTML_BYTES) {
    pushUnique(acc, {
      // Report against the source entry path so the UI can deep-link
      // back to the file the author edits, not the deploy-renamed
      // `index.html` which does not exist in the project tree.
      code: 'large-html',
      path: entryPath,
      size: entrySize,
      message: `Entry HTML is ${formatMib(entrySize)}; large HTML inflates time-to-first-paint.`,
    });
  }
  if (totalBytes > DEPLOY_PREFLIGHT_LARGE_BUNDLE_BYTES) {
    pushUnique(acc, {
      code: 'large-bundle',
      size: totalBytes,
      message: `Bundle is ${formatMib(totalBytes)}; every file uploads to Vercel separately, so a bundle this large deploys slowly.`,
    });
  }

  const source = String(html ?? '');
  // Anchor to the document prolog so a `<!doctype html>` substring that
  // happens to live inside a `<script>` template literal or a comment
  // is not treated as a real declaration. Per HTML5, the prolog may
  // begin with an optional BOM, then any number of HTML comments and
  // whitespace, then the doctype. Built via `new RegExp` so the BOM
  // appears as an explicit U+FEFF escape rather than a literal
  // zero-width character in the regex source. The comment body is
  // tempered (`(?:[^-]|-(?!->))*`) rather than a lazy `[\s\S]*?` so each
  // comment matches deterministically — a lazy body inside the outer `*`
  // backtracks 2^n ways on a comment-only prolog with no doctype (ReDoS).
  if (!new RegExp('^\\uFEFF?\\s*(?:<!--(?:[^-]|-(?!->))*-->\\s*)*<!doctype\\s+html', 'i').test(source)) {
    pushUnique(acc, {
      code: 'no-doctype',
      path: entryPath,
      message: 'Entry HTML is missing `<!DOCTYPE html>`; browsers may render in quirks mode.',
    });
  }

  let hasViewport = false;
  for (const tag of parseHtmlTags(source)) {
    const attrs = parseHtmlAttributes(tag.attrs);
    if (
      tag.name === 'meta' &&
      String(attrs.get('name') || '').toLowerCase() === 'viewport'
    ) {
      hasViewport = true;
    }
    if (tag.name === 'script') {
      const src = attrs.get('src');
      if (isExternalUrl(src)) {
        pushUnique(acc, {
          code: 'external-script',
          path: entryPath,
          url: src,
          message: `External script will not be vendored into the deploy: ${src}`,
        });
      }
    }
    if (tag.name === 'link') {
      const rel = String(attrs.get('rel') || '').toLowerCase();
      const href = attrs.get('href');
      if (rel.split(/\s+/).includes('stylesheet') && isExternalUrl(href)) {
        pushUnique(acc, {
          code: 'external-stylesheet',
          path: entryPath,
          url: href,
          message: `External stylesheet will not be vendored into the deploy: ${href}`,
        });
      }
    }
  }
  if (!hasViewport) {
    pushUnique(acc, {
      code: 'no-viewport',
      path: entryPath,
      message: 'Entry HTML is missing `<meta name="viewport">`; mobile rendering will be off.',
    });
  }

  return { warnings: acc.warnings, totalBytes, totalFiles: (files || []).length };
}

function formatMib(bytes: number) {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

// One-shot orchestrator: build the file plan, run the analyzer, and
// return the typed preflight payload exposed by the daemon.
export async function prepareDeployPreflight(projectsRoot: string, projectId: string, entryName: string, options: DeployOptions = {}) {
  const plan = await buildDeployFilePlan(projectsRoot, projectId, entryName, options);
  const { warnings, totalBytes, totalFiles } = analyzeDeployPlan(plan);
  return {
    providerId: options.providerId || VERCEL_PROVIDER_ID,
    entry: plan.entryPath,
    files: plan.files.map((f) => ({
      path: f.file,
      size: f.data?.length ?? 0,
      mime: f.contentType || 'application/octet-stream',
      sourcePath: f.sourcePath,
    })),
    totalFiles,
    totalBytes,
    warnings: [...plan.warnings, ...warnings],
  };
}

export function injectDeployHookScript(html: string, scriptUrl: unknown) {
  const normalized = normalizeDeployHookScriptUrl(scriptUrl);
  if (!normalized) return html;

  const tag =
    `<script src="${escapeHtmlAttribute(normalized)}" defer ` +
    'data-mish-deploy-hook="true" data-closeable="true"></script>';
  // The document's own `</body>`, not one an author wrote into a script string:
  // splicing there would end their script with this tag's `</script>` and leak
  // the rest of it onto the deployed page (upstream #7410).
  const bodyClose = findRealTagOffset(html, HTML_TAG_PATTERNS.bodyClose);
  if (bodyClose >= 0) return `${html.slice(0, bodyClose)}${tag}${html.slice(bodyClose)}`;
  return `${html}${tag}`;
}

export function normalizeDeployHookScriptUrl(raw: unknown) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed) return '';
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return '';
    return url.toString();
  } catch {
    return '';
  }
}

function escapeHtmlAttribute(value: unknown) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function rewriteSrcset(raw: string, baseDir: string) {
  return rewriteSrcsetPublicationReferences(raw, (ref) => rewriteHtmlReference(ref, baseDir));
}

function parseHtmlTags(html: string) {
  const tags: { name: string; attrs: string }[] = [];
  const rawTextRanges = htmlRawTextRanges(html);
  const tagRe = /<([A-Za-z][A-Za-z0-9:-]*)((?:[^"'<>]|"[^"]*"|'[^']*')*)>/g;
  let match;
  while ((match = tagRe.exec(String(html)))) {
    if (isOffsetInRanges(match.index, rawTextRanges)) continue;
    tags.push({
      name: String(match[1]).toLowerCase(),
      attrs: match[2] || '',
    });
  }
  return tags;
}

function htmlRawTextRanges(html: string) {
  const source = String(html);
  const ranges: [number, number][] = [];

  const commentRe = /<!--[\s\S]*?-->/g;
  let match;
  while ((match = commentRe.exec(source))) {
    ranges.push([match.index, match.index + match[0].length]);
  }

  const rawTagRe = /<(script|style)\b[^<>]*>/gi;
  while ((match = rawTagRe.exec(source))) {
    const tagName = String(match[1]).toLowerCase();
    const contentStart = match.index + match[0].length;
    const closeRe = new RegExp(`</${tagName}\\s*>`, 'gi');
    closeRe.lastIndex = contentStart;
    const close = closeRe.exec(source);
    const contentEnd = close ? close.index : source.length;
    if (contentEnd > contentStart) ranges.push([contentStart, contentEnd]);
    rawTagRe.lastIndex = close ? close.index + close[0].length : source.length;
  }

  return ranges;
}

function isOffsetInRanges(offset: number, ranges: [number, number][]) {
  return ranges.some(([start, end]) => offset >= start && offset < end);
}

function parseHtmlAttributes(rawAttrs: string) {
  const node = loadHtml(`<i ${rawAttrs}></i>`)('i').get(0);
  return new Map<string, string>(node && 'attribs' in node ? Object.entries(node.attribs) : []);
}

function rewriteHtmlAttributes(rawAttrs: string, tagName: string, attrs: Map<string, string>, baseDir: string) {
  const shouldRewriteHref = shouldCollectHref(tagName, attrs);
  return String(rawAttrs).replace(
    /([^\s"'<>/=]+)(\s*=\s*)("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/g,
    (full, rawName, equals, rawValue, doubleQuoted, singleQuoted, unquoted) => {
      const name = String(rawName).toLowerCase();
      if (
        !resourceAttributes(tagName, attrs).includes(name) &&
        !(name === 'srcset' && (tagName === 'img' || tagName === 'source')) &&
        !(name === 'imagesrcset' && tagName === 'link') &&
        !(name === 'srcdoc' && tagName === 'iframe') &&
        name !== 'href' &&
        name !== 'style'
      ) {
        return full;
      }
      if (name === 'href' && !shouldRewriteHref) return full;

      const value = loadHtml(`<i data-ref=${rawValue}></i>`)('i').attr('data-ref') ?? '';
      let nextValue;
      if (name === 'srcdoc') nextValue = rewriteEntryHtmlReferences(value, baseDir);
      else if (name === 'srcset' || name === 'imagesrcset') nextValue = rewriteSrcset(value, baseDir);
      else if (name === 'style') nextValue = rewriteOrKeepUnparsable(value, () => rewriteCssReferences(value, baseDir));
      else nextValue = rewriteHtmlReference(value, baseDir);
      const escaped = escapeHtmlAttribute(nextValue);
      if (doubleQuoted !== undefined) return `${rawName}${equals}"${escaped}"`;
      const singleEscaped = escaped.replace(/'/g, '&#39;');
      if (singleQuoted !== undefined) return `${rawName}${equals}'${singleEscaped}'`;
      return /[\s`=']/.test(escaped) ? `${rawName}${equals}"${escaped}"` : `${rawName}${equals}${escaped}`;
    },
  );
}

function shouldCollectHref(tagName: string, attrs: Map<string, string>) {
  if (tagName === 'link') {
    return (attrs.get('rel') ?? '').toLowerCase().split(/\s+/).some((rel) => ['stylesheet', 'icon', 'apple-touch-icon', 'manifest', 'preload', 'modulepreload', 'prefetch'].includes(rel));
  }
  if (tagName === 'image' || tagName === 'use') return true;
  return tagName === 'a' || tagName === 'area';
}

function rewriteHtmlReference(raw: string, baseDir: string) {
  if (typeof raw !== 'string') return raw;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('#')) return raw;
  let resolved;
  try { resolved = resolveReferencedPath(raw, baseDir); }
  catch { return raw; } // The collector reports the invalid ref; rewriting cannot conceal it.
  if (!resolved) return raw;
  const suffix = referenceSuffix(trimmed);
  return `${encodePublicationUrlPath(resolved)}${suffix.replace(/[<>"'`\s()]/g, (char) => encodeURIComponent(char).replace(/[!'()*]/g, (literal) => `%${literal.charCodeAt(0).toString(16).toUpperCase()}`))}`;
}

function encodePublicationUrlPath(filePath: string): string {
  return filePath.split('/').map((segment) => encodeURIComponent(segment).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');
}

function referenceSuffix(raw: string) {
  const queryIdx = raw.indexOf('?');
  const hashIdx = raw.indexOf('#');
  const suffixIdx =
    queryIdx === -1 ? hashIdx : hashIdx === -1 ? queryIdx : Math.min(queryIdx, hashIdx);
  return suffixIdx === -1 ? '' : raw.slice(suffixIdx);
}

async function pollVercelDeployment(config: DeployConfig, id: string) {
  let last: JsonObject | null = null;
  for (let i = 0; i < 30; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, i < 5 ? 1000 : 2000));
    const resp = await fetch(
      `${VERCEL_API}/v13/deployments/${encodeURIComponent(id)}${vercelTeamQuery(config)}`,
      { headers: { Authorization: `Bearer ${config.token}` } },
    );
    const json = await readVercelJson(resp);
    if (!resp.ok) throw vercelError(json, resp.status);
    last = json;
    if (json.readyState === 'READY' || json.readyState === 'ERROR') return json;
  }
  return last;
}

export async function waitForReachableDeploymentUrl(
  urls: unknown[],
  {
    timeoutMs = 60_000,
    intervalMs = 2_000,
    providerLabel = 'Deployment provider',
    // How long an auth-wall answer counts as "not yet" rather than "refused".
    // 0 (the default) keeps the historical behaviour: the first wall wins.
    protectedGraceMs = 0,
    // How many consecutive reachable answers prove the link is really public.
    // 1 (the default) keeps the historical behaviour: the first success wins.
    confirmations = 1,
    // Minimum gap between two answers that both count towards `confirmations`.
    // A burst of requests inside one second proves one moment, not a steady
    // state, and the edge inconsistency this guards against lasts seconds.
    confirmSpacingMs = 1_000,
  } = {},
): Promise<{ status: string; url: string; statusMessage: string; statusCode?: number; reachableAt?: number }> {
  const candidates = [...new Set((urls || []).map(normalizeDeploymentUrl).filter(Boolean))];
  const fallbackUrl = candidates[0] || '';
  if (!fallbackUrl) {
    return {
      status: 'link-delayed',
      url: '',
      statusMessage: `${providerLabel} did not return a public deployment URL.`,
    };
  }

  const startedAt = Date.now();
  const requiredConfirmations = Math.max(1, confirmations);
  let lastMessage = '';
  // A run of consecutive reachable answers PER candidate URL. A deploy probes
  // the deployment URL and every alias, and each candidate is a separate
  // question: one shared run meant each candidate wiped the other's count on
  // every pass, so two reachable candidates could never reach two consecutive
  // successes and a perfectly healthy link sat out the whole timeout.
  // Any non-reachable answer ends that URL's run only, because the provider's
  // edge answering once says nothing about the next request to the same URL.
  const runs = new Map<string, { count: number; lastAt: number }>();
  // Candidates whose wall outlived the grace window. That is a definitive
  // answer for THAT hostname and nothing more: an alias can be walled while
  // the deployment URL serves the page perfectly, and a global return would
  // hand the user `protected` for a link that works. Walled candidates stop
  // being probed; the wait only ends as `protected` when every candidate is
  // in here.
  const walled = new Map<string, string>();
  // The LAST thing each candidate still being probed did. A checkpoint
  // challenge is not a wall — a browser passes it and it can clear — so a
  // challenged candidate keeps being probed and only its latest answer
  // decides what it was doing when the window ran out.
  const lastAnswer = new Map<string, 'reachable' | 'challenged' | 'other'>();
  let sawUnconfirmedSuccess = false;
  while (Date.now() - startedAt <= timeoutMs) {
    for (const url of candidates) {
      if (walled.has(url)) continue;
      const result = await checkDeploymentUrl(url);
      if (result.reachable) {
        lastAnswer.set(url, 'reachable');
        const run = runs.get(url) ?? { count: 0, lastAt: 0 };
        if (run.count === 0 || Date.now() - run.lastAt >= confirmSpacingMs) {
          run.count += 1;
          run.lastAt = Date.now();
        }
        runs.set(url, run);
        if (run.count >= requiredConfirmations) {
          return {
            status: 'ready',
            url,
            // A probe alone never proves who else can open the link; the
            // caller that knows the provider's settings replaces this.
            statusMessage: deployLinkSentence({ access: 'unknown', status: 'ready' }),
            reachableAt: Date.now(),
            ...(typeof result.statusCode === 'number' ? { statusCode: result.statusCode } : {}),
          };
        }
        sawUnconfirmedSuccess = true;
        continue;
      }
      runs.delete(url);
      lastAnswer.set(url, result.status === 'challenged' ? 'challenged' : 'other');
      if (result.status === 'challenged') {
        // Deliberately does NOT touch `lastMessage`: the checkpoint sentence
        // belongs to the `challenged` terminal below, which has its own copy.
        // Letting a challenge win `lastMessage` made the `link-delayed`
        // sentence depend on which candidate the sweep happened to ask last.
        continue;
      }
      if (result.status === 'protected') {
        const protectedAnswer = {
          url,
          statusMessage: result.statusMessage || VERCEL_PROTECTED_MESSAGE,
        };
        // Inside the grace window a wall means the provider's edge has not
        // caught up with a protection change yet, so keep asking.
        if (Date.now() - startedAt >= protectedGraceMs) {
          walled.set(url, protectedAnswer.statusMessage);
          if (walled.size >= candidates.length) {
            // Nothing left that could still become reachable.
            const reported = candidates.find((candidate) => walled.has(candidate)) ?? url;
            return { status: 'protected', url: reported, statusMessage: walled.get(reported) ?? protectedAnswer.statusMessage };
          }
          lastMessage = protectedAnswer.statusMessage;
          continue;
        }
        // Remembered only so the message can be reported if nothing better
        // arrives; it never decides the terminal status, because a wall the
        // preview has since stopped answering with is not what it is doing
        // now. A wall that outlives the grace window returns above.
        lastMessage = protectedAnswer.statusMessage;
        continue;
      }
      lastMessage = result.statusMessage || lastMessage;
    }
    if (Date.now() - startedAt >= timeoutMs) break;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // No candidate was confirmed reachable, and the walls did not take every
  // candidate (that returns `protected` inside the loop). What is left is
  // decided by what those candidates were last doing: a checkpoint everywhere
  // is `challenged` — including a checkpoint on one candidate and a wall on
  // the rest, because the checkpoint is the one a person can still get past.
  const stillProbed = candidates.filter((candidate) => !walled.has(candidate));
  const challenged = stillProbed.filter((candidate) => lastAnswer.get(candidate) === 'challenged');
  if (stillProbed.length > 0 && challenged.length === stillProbed.length) {
    return {
      status: 'challenged',
      url: challenged[0] || fallbackUrl,
      statusMessage: VERCEL_CHALLENGED_LINK_MESSAGE,
    };
  }

  return {
    status: 'link-delayed',
    url: fallbackUrl,
    statusMessage: sawUnconfirmedSuccess
      // It answered — just never consistently enough to promise anyone a
      // working link, which is the whole point of the confirmation run.
      ? `${providerLabel} answered, but not consistently enough to confirm the link is public yet.`
      : lastMessage || `${providerLabel} returned a deployment URL, but it is not reachable yet.`,
  };
}

export async function checkDeploymentUrl(url: unknown, { timeoutMs = 8_000 }: { timeoutMs?: number } = {}): Promise<DeploymentUrlCheck> {
  const normalized = normalizeDeploymentUrl(url);
  if (!normalized) {
    return { reachable: false, statusMessage: 'Deployment URL is empty.' };
  }
  const head = await requestDeploymentUrl(normalized, 'HEAD', timeoutMs);
  if (head.reachable) return head;
  // A wall and a checkpoint are both definitive answers to THIS request, and
  // an immediate second request is exactly the rate the checkpoint reacts to.
  if (head.status === 'protected' || head.status === 'challenged') return head;
  if (head.statusCode && (head.statusCode === 405 || head.statusCode === 403 || head.statusCode >= 400)) {
    const get = await requestDeploymentUrl(normalized, 'GET', timeoutMs);
    if (get.reachable) return get;
    if (get.status === 'protected' || get.status === 'challenged') return get;
    return get.statusMessage ? get : head;
  }
  const get = await requestDeploymentUrl(normalized, 'GET', timeoutMs);
  return get.reachable ? get : (get.statusMessage ? get : head);
}

async function requestDeploymentUrl(url: string, method: 'HEAD' | 'GET', timeoutMs: number): Promise<DeploymentUrlCheck> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      redirect: 'manual',
      signal: controller.signal,
    });
    // Vercel's Security Checkpoint answers with `x-vercel-mitigated: challenge`
    // — a 403 or a 429 today, but the page it serves is the checkpoint's
    // whatever status it carries, so the header is read before ANY status
    // branch below, the SSO redirect included: a redirect carrying the header
    // is the checkpoint, not the login wall, and calling it `protected` would
    // freeze a link a browser can still pass. The body is left unread, like
    // every other body this function ignores, so the abort timer in `finally`
    // still covers it.
    if (/challenge/i.test(resp.headers?.get?.('x-vercel-mitigated') || '')) {
      return {
        reachable: false,
        status: 'challenged',
        statusCode: resp.status,
        statusMessage: VERCEL_CHALLENGE_MESSAGE,
      };
    }
    // A bare 3xx used to count as reachable outright below, so a redirect
    // straight into Vercel's SSO login page (the account-level "Vercel
    // Authentication" wall) read as a live link. Recognize that specific
    // redirect first; every other 3xx keeps its old reachable behavior.
    if (
      resp.status >= 300 && resp.status < 400 &&
      isVercelAuthRedirectLocation(resp.headers?.get?.('location') || '', url)
    ) {
      return {
        reachable: false,
        status: 'protected',
        statusCode: resp.status,
        statusMessage: VERCEL_PROTECTED_MESSAGE,
      };
    }
    if (resp.status >= 200 && resp.status < 400) {
      return { reachable: true, statusCode: resp.status };
    }
    // A bare 401/403 on a *.vercel.app host is not on its own a reliable
    // signal — the deployed app itself can return either for its own
    // reasons. Vercel's own SSO wall sets a `_vercel_sso_nonce` cookie on
    // the response (the same marker isVercelProtectedResponse below already
    // trusts for the 401 body-sniffed case); require it here too, on the
    // headers alone so this fires for a HEAD request as well as a GET.
    if (
      (resp.status === 401 || resp.status === 403) &&
      /(?:^|\.)vercel\.app$/i.test(hostnameFromUrl(url)) &&
      /_vercel_sso_nonce/i.test(resp.headers?.get?.('set-cookie') || '')
    ) {
      return {
        reachable: false,
        status: 'protected',
        statusCode: resp.status,
        statusMessage: VERCEL_PROTECTED_MESSAGE,
      };
    }
    const body = method === 'GET' || resp.status === 401
      ? await resp.text()
      : '';
    if (resp.status === 401 && isVercelProtectedResponse(resp, body)) {
      return {
        reachable: false,
        status: 'protected',
        statusCode: resp.status,
        statusMessage: VERCEL_PROTECTED_MESSAGE,
      };
    }
    return {
      reachable: false,
      statusCode: resp.status,
      statusMessage: `Public link returned HTTP ${resp.status}.`,
    };
  } catch (err) {
    return {
      reachable: false,
      statusMessage: `Public link is not reachable yet: ${errorMessage(err, String(err))}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function isVercelProtectedResponse(resp: Response, body = '') {
  const server = resp.headers?.get?.('server') || '';
  const setCookie = resp.headers?.get?.('set-cookie') || '';
  const text = String(body || '');
  return (
    /vercel/i.test(server) ||
    /_vercel_sso_nonce/i.test(setCookie) ||
    /Authentication Required/i.test(text) ||
    /Vercel Authentication/i.test(text) ||
    /vercel\.com\/sso-api/i.test(text)
  );
}

function isVercelAuthRedirectLocation(location: string, requestUrl: string): boolean {
  if (!location) return false;
  // A substring match on the raw header would flag a same-site redirect
  // that merely mentions vercel.com/login in a query param (e.g. a "next="
  // deep link) as protected. Resolve it (Location can be relative) and
  // require an exact host match instead.
  let target: URL;
  try {
    target = new URL(location, requestUrl);
  } catch {
    return false;
  }
  return (
    target.hostname.toLowerCase() === 'vercel.com' &&
    (target.pathname.startsWith('/sso-api') || target.pathname.startsWith('/login'))
  );
}

export function deploymentUrlCandidates(...responses: MaybeJsonObject[]) {
  const urls: string[] = [];
  for (const json of responses) {
    if (!json) continue;
    if (json.url) urls.push(json.url);
    for (const alias of json.alias ?? []) urls.push(alias);
    for (const alias of json.aliases ?? []) {
      if (typeof alias === 'string') urls.push(alias);
      else if (alias?.domain) urls.push(alias.domain);
      else if (alias?.url) urls.push(alias.url);
    }
  }
  return [...new Set(urls.map(normalizeDeploymentUrl).filter(Boolean))];
}

export function normalizeDeploymentUrl(url: unknown) {
  if (typeof url !== 'string') return '';
  const trimmed = url.trim();
  if (!trimmed) return '';
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function vercelTeamQuery(config: DeployConfig) {
  const params = new URLSearchParams();
  if (config.teamId) params.set('teamId', config.teamId);
  else if (config.teamSlug) params.set('slug', config.teamSlug);
  const s = params.toString();
  return s ? `?${s}` : '';
}

function cloudflareAccountPagesProjectsUrl(config: DeployConfig) {
  if (!config.accountId) throw new DeployError('Cloudflare account ID is required.', 400, undefined, 'CF_ACCOUNT_ID_REQUIRED');
  return `${CLOUDFLARE_API}/accounts/${encodeURIComponent(config.accountId)}/pages/projects`;
}

function cloudflarePagesProjectUrl(config: DeployConfig, suffix = '') {
  if (!config.projectName) throw new DeployError('Cloudflare Pages project name could not be generated.', 400, undefined, 'CF_PROJECT_NAME_UNRESOLVED');
  const base = `${cloudflareAccountPagesProjectsUrl(config)}/${encodeURIComponent(config.projectName)}`;
  return suffix ? `${base}/${suffix}` : base;
}

function cloudflarePagesProjectDomainUrl(config: DeployConfig, hostname: string) {
  return `${cloudflarePagesProjectUrl(config, 'domains')}/${encodeURIComponent(hostname)}`;
}

function cloudflarePagesProductionUrl(config: DeployConfig) {
  return config?.projectName ? `https://${config.projectName}.pages.dev` : '';
}

function cloudflareZoneDnsRecordsUrl(zoneId: string) {
  return `${CLOUDFLARE_API}/zones/${encodeURIComponent(zoneId)}/dns_records`;
}

/**
 * The Vercel project name this daemon generates for an OD project. One source
 * for both the deployment that creates the project and the name check that
 * guards a protection write against it.
 */
export function vercelProjectNameForProject(projectId: string) {
  return safeVercelProjectName(`od-${projectId}`);
}

export function cloudflarePagesProjectNameForProject(projectId: string, projectName = '') {
  const idSuffix = safeDnsLabel(projectId).slice(0, 12) || randomUUID().slice(0, 8);
  const nameBase = safeDnsLabel(projectName) || 'project';
  const fixedLength = 'od--'.length + idSuffix.length;
  const baseLength = Math.max(1, 63 - fixedLength);
  return safeDnsLabel(`od-${nameBase.slice(0, baseLength)}-${idSuffix}`);
}

function cloudflareHeaders(config: DeployConfig, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${config.token}`,
    ...extra,
  };
}

function cloudflareAssetHeaders(token: string, extra: Record<string, string> = {}) {
  return {
    Authorization: `Bearer ${token}`,
    ...extra,
  };
}

async function readCloudflareJson(resp: Response): Promise<JsonObject> {
  try {
    return await resp.json() as JsonObject;
  } catch {
    throw new DeployError('Cloudflare returned a non-JSON response.', resp.status || 502, undefined, 'CF_BAD_RESPONSE');
  }
}

async function fetchCloudflarePaginatedResult(config: DeployConfig, buildUrl: (page: number, perPage: number) => string, fallback: string, options: { perPage?: number } = {}) {
  const results: JsonObject[] = [];
  const perPage = options.perPage || CLOUDFLARE_API_PAGE_SIZE;
  for (let page = 1; page <= CLOUDFLARE_API_MAX_PAGES; page += 1) {
    const resp = await fetch(buildUrl(page, perPage), {
      headers: cloudflareHeaders(config),
    });
    const json = await readCloudflareJson(resp);
    if (!resp.ok || json?.success === false) {
      throw cloudflareError(json, resp.status, fallback);
    }
    const pageItems = Array.isArray(json?.result) ? json.result : [];
    results.push(...pageItems);
    if (!shouldFetchNextCloudflarePage(json?.result_info, page, perPage, pageItems.length)) break;
  }
  return results;
}

function shouldFetchNextCloudflarePage(resultInfo: JsonObject | undefined, page: number, perPage: number, itemCount: number) {
  if (itemCount <= 0) return false;
  const totalPages = Number(resultInfo?.total_pages);
  if (Number.isFinite(totalPages) && totalPages > 0) return page < totalPages;
  const totalCount = Number(resultInfo?.total_count);
  const responsePerPage = Number(resultInfo?.per_page);
  const effectivePerPage = Number.isFinite(responsePerPage) && responsePerPage > 0
    ? responsePerPage
    : perPage;
  if (Number.isFinite(totalCount) && totalCount >= 0) {
    return page * effectivePerPage < totalCount;
  }
  const count = Number(resultInfo?.count);
  if (Number.isFinite(count) && count >= 0) return count >= effectivePerPage;
  return itemCount >= perPage;
}

async function readVercelJson(resp: Response): Promise<JsonObject> {
  try {
    return await resp.json() as JsonObject;
  } catch {
    throw new DeployError('Vercel returned a non-JSON response.', resp.status || 502, undefined, 'VERCEL_BAD_RESPONSE');
  }
}

function cloudflareError(json: JsonObject, status: number, fallback: string) {
  const message =
    json?.errors?.find?.((err: JsonObject) => err?.message)?.message ||
    json?.messages?.find?.((item: JsonObject) => item?.message)?.message ||
    json?.message ||
    fallback ||
    `Cloudflare request failed (${status}).`;
  // Deliberately NO structured code: this is the catch-all for any Cloudflare
  // API rejection, where the provider's HTTP status IS the signal. The client
  // (apps/web/src/providers/registry.ts) only falls back to `HTTP_${status}`
  // when the envelope code is generic, so stamping one code here would fold
  // auth (403), quota (429) and upstream faults (5xx) into a single bucket —
  // the opposite of what this file's specific codes are for. Add a code here
  // only for a failure whose CAUSE is known, not merely its status.
  return new DeployError(message, status, json);
}

function isCloudflareAlreadyExists(body: unknown) {
  const text = JSON.stringify(body || {}).toLowerCase();
  return (
    text.includes('already exists') ||
    text.includes('already exist') ||
    text.includes('already bound') ||
    text.includes('already been taken') ||
    text.includes('already in use') ||
    text.includes('duplicate')
  );
}

function isCloudflareCommentError(value: unknown) {
  return /comment/i.test(typeof value === 'string' ? value : JSON.stringify(value || {}));
}

function vercelError(json: JsonObject, status: number) {
  const code = json?.error?.code;
  const message = json?.error?.message || json?.message || `Vercel request failed (${status}).`;
  if (code === 'forbidden' || /permission/i.test(message)) {
    return new DeployError("You don't have permission to create a project.", status, json, 'PROVIDER_FORBIDDEN');
  }
  // Catch-all — no structured code, so the client keeps bucketing by the real
  // provider status. See cloudflareError above.
  return new DeployError(message, status, json);
}

function deploymentUrl(json: JsonObject | null | undefined) {
  const url = json?.url || json?.alias?.[0] || '';
  if (!url) return '';
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

function hostnameFromUrl(raw: unknown) {
  const normalized = normalizeDeploymentUrl(raw);
  if (!normalized) return '';
  try {
    return new URL(normalized).hostname.toLowerCase();
  } catch {
    return normalizeHostname(raw);
  }
}

function normalizeHostname(raw: unknown) {
  return String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//i, '')
    .split('/')[0]!
    .replace(/\.$/, '');
}

function normalizeCloudflareZoneName(raw: unknown) {
  return normalizeHostname(raw);
}

function isValidCloudflareZoneName(raw: unknown) {
  const name = normalizeCloudflareZoneName(raw);
  if (!name || name.length > 253 || name.includes('..')) return false;
  return name.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function normalizeCloudflareDomainPrefix(raw: unknown) {
  const prefix = String(raw || '').trim().toLowerCase();
  if (!prefix || prefix === '@' || prefix.includes('.') || prefix.includes('*')) return '';
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(prefix) ? prefix : '';
}

function cloudflarePagesDnsMarker(projectId: string, projectName: string, pagesTarget: string) {
  return `od:cfp:${shortCloudflareHash(projectId || projectName)}:${shortCloudflareHash(pagesTarget || projectName)}`;
}

function shortCloudflareHash(value: unknown) {
  return blake3Hash(String(value || '')).toString('hex').slice(0, 12);
}

function safeVercelProjectName(raw: unknown) {
  return safeProjectLabel(raw, 80) || `od-${randomUUID().slice(0, 8)}`;
}

function safeDnsLabel(raw: unknown) {
  return safeProjectLabel(raw, 63);
}

function safeProjectLabel(raw: unknown, maxLength: number) {
  return String(raw)
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
