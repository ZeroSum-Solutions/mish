import { createHash } from 'node:crypto';
import { kitTokenAxes, kitTokenNames } from './component-kit.js';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ResourceCandidate, ResourceRef, ResourceRequestContext } from '@open-design/contracts';
import { resolveMemberVerifiedLocalWorkspaceRequestAuthority, resolveOptionalLocalWorkspaceRequestAuthority, type VerifyWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import { readPackageFile } from './resources-design-systems.js';
import { tokenPreviewUrl, type WorkspaceNavigation } from './resources-tokens.js';
import { COHORT_LABELS, classifyToken, contrastEvidenceLines, extractCustomProperties, paletteContrastEvidence, type DesignTokenValue, type TokenCohort, type TokenSpecimen } from './token-evidence.js';

/**
 * AC-R04.1/R04.2: the caller's own installed, imported or generated design-system
 * kits from the USER design-systems directory under the daemon data root.
 *
 * Visibility is decided per request, never cached across principals:
 * - a claimed Workspace/member pair must pass the FRESH membership verifier, the
 *   same proof `authorizeDesignSystemRead` requires before serving Personal/Team
 *   bytes; an unverifiable pair hides every user kit and names the reason;
 * - the catalog listing is then narrowed by the catalog route's own per-member
 *   rule, so a member never sees another member's Personal kit;
 * - a headerless (signed-out/local) request sees only never-claimed kits,
 *   exactly as the catalog's signed-out lane does.
 * Reads open each file without following symlinks and stay inside the kit.
 */
export interface OwnedKit { id: string; title: string; root: string; dirId: string; teamSynced: boolean }
export interface OwnedKitListing { kits: OwnedKit[]; reason: string | null; workspace: WorkspaceNavigation }
type CatalogEntry = { id: string; title: string; source: string; teamSynced?: boolean };
export interface OwnedKitListerDeps {
  verifyWorkspaceRequestAuthority: VerifyWorkspaceRequestAuthority;
  listAllDesignSystems(options: { workspaceId: string | null; workspaceMemberId: string | null }): Promise<readonly CatalogEntry[]>;
  visibleInWorkspaceCatalog(system: CatalogEntry, workspaceId: string, workspaceMemberId: string): boolean;
  userRoot: string;
  teamRoot(workspaceId: string): string;
}
const USER_PREFIX = 'user:';
const DIR_ID = /^[A-Za-z0-9._-]{1,120}$/u;
export async function listOwnedDesignSystemKits(req: unknown, deps: OwnedKitListerDeps): Promise<OwnedKitListing> {
  const local = resolveOptionalLocalWorkspaceRequestAuthority(req);
  if (!local.ok) return { kits: [], reason: 'workspace-scope-invalid', workspace: null };
  if (local.context) {
    const verified = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(req, deps.verifyWorkspaceRequestAuthority).catch(() => null);
    if (!verified?.ok) return { kits: [], reason: 'workspace-membership-unverified', workspace: null };
  }
  const workspaceId = local.context?.workspaceId ?? null;
  const workspaceMemberId = local.context?.workspaceMemberId ?? null;
  const catalog = await deps.listAllDesignSystems({ workspaceId, workspaceMemberId });
  const kits: OwnedKit[] = [];
  for (const system of catalog) {
    if (system.source !== 'user' || !system.id.startsWith(USER_PREFIX)) continue;
    if (workspaceId && workspaceMemberId && !deps.visibleInWorkspaceCatalog(system, workspaceId, workspaceMemberId)) continue;
    const dirId = system.id.slice(USER_PREFIX.length);
    if (!DIR_ID.test(dirId) || dirId === '.' || dirId === '..') continue;
    const teamSynced = system.teamSynced === true;
    if (teamSynced && !workspaceId) continue;
    kits.push({ id: system.id, title: system.title || dirId, root: teamSynced ? deps.teamRoot(workspaceId!) : deps.userRoot, dirId, teamSynced });
  }
  return { kits, reason: null, workspace: local.context ? { workspaceId: local.context.workspaceId, workspaceMemberId: local.context.workspaceMemberId } : null };
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const ORDER: readonly TokenCohort[] = ['color-palette', 'type-scale', 'spacing-scale', 'motion'];
export type UserKitReason = 'user-kit-outside-root' | 'user-kit-design-unreadable' | 'user-kit-tokens-unreadable' | 'user-kit-unreadable';
/** Declared token stylesheet: the manifest's `files.tokens` when the kit ships a valid one, else `tokens.css`. */
function declaredTokensPath(manifest: Buffer | null): { file: string; declared: boolean } {
  if (!manifest) return { file: 'tokens.css', declared: false };
  try {
    const value: unknown = JSON.parse(manifest.toString('utf8'));
    const files = value && typeof value === 'object' && 'files' in value ? (value as { files?: unknown }).files : null;
    const tokens = files && typeof files === 'object' && 'tokens' in files ? (files as { tokens?: unknown }).tokens : null;
    return typeof tokens === 'string' && tokens.trim() ? { file: tokens.trim(), declared: true } : { file: 'tokens.css', declared: false };
  } catch { return { file: 'tokens.css', declared: false }; }
}
function navigationQuery(workspace: WorkspaceNavigation): string {
  return workspace ? `?workspaceId=${encodeURIComponent(workspace.workspaceId)}&workspaceMemberId=${encodeURIComponent(workspace.workspaceMemberId)}` : '';
}
/** One kit's items plus the token cohorts its previews render; throws only for an escaping kit. */
export async function userKitItems(kit: OwnedKit, context: ResourceRequestContext, workspace: WorkspaceNavigation, note: (reason: UserKitReason) => void): Promise<{ items: ResourceCandidate[]; specimens: TokenSpecimen[] }> {
  let kitRoot: string;
  try {
    const root = await realpath(kit.root);
    kitRoot = await realpath(path.join(root, kit.dirId));
    if (!kitRoot.startsWith(root + path.sep)) { note('user-kit-outside-root'); return { items: [], specimens: [] }; }
  } catch { note('user-kit-unreadable'); return { items: [], specimens: [] }; }
  const design = await readPackageFile(kitRoot, 'DESIGN.md');
  if (!design) { note('user-kit-design-unreadable'); return { items: [], specimens: [] }; }
  const manifest = await readPackageFile(kitRoot, 'manifest.json');
  const tokensPath = declaredTokensPath(manifest);
  const tokensCss = await readPackageFile(kitRoot, tokensPath.file);
  if (tokensPath.declared && !tokensCss) note('user-kit-tokens-unreadable');
  const revision = `sha256:${sha256(JSON.stringify([['DESIGN.md', sha256(design)], ['manifest.json', manifest ? sha256(manifest) : null], [tokensPath.file, tokensCss ? sha256(tokensCss) : null]]))}`;
  const attribution = `${kit.title} · ${kit.teamSynced ? 'team kit' : 'your kit'}`;
  const origin = kit.teamSynced ? 'team-design-system' : 'user-design-system';
  const base = (itemId: string, title: string, category: ResourceCandidate['category'], nativeFormat: string, preview: ResourceCandidate['previewCapability'], fitReasons: string[]): ResourceCandidate => ({
    ref: { sourceType: 'library', sourceId: 'design-systems', itemId, revisionOrDigest: revision } satisfies ResourceRef,
    title, category, readiness: 'unverified',
    compatibility: { nativeFormat, targets: [], state: 'unverified', reason: 'Per-item acceptance evidence is pending' },
    // User-owned or imported kits carry no rights claim of their own here.
    rightsStatus: 'unknown', fitReasons, previewCapability: preview,
    adoptionCapability: { available: false, reason: 'adapter-missing' }, sourceAttribution: { title: attribution },
    implementationOrigin: origin, styleTags: [category], operationGrants: [], admissionStage: 'discovered',
    needDecision: 'not-assessed', needReason: 'Project need is not assessed by inventory discovery',
  });
  const items: ResourceCandidate[] = [
    base(kit.id, kit.title, 'design-system', 'design-md', { available: true, kind: 'html', url: `/api/design-systems/${encodeURIComponent(kit.id)}/preview${navigationQuery(workspace)}`, reason: null }, []),
  ];
  items[0]!.kitTokenAxes = kitTokenAxes(tokensCss?.toString('utf8') ?? '');
  items[0]!.kitTokenNames = kitTokenNames(tokensCss?.toString('utf8') ?? '');
  const specimens: TokenSpecimen[] = [];
  const tokens = tokensCss ? extractCustomProperties(tokensCss.toString('utf8')) : [];
  const values = new Map(tokens.map(token => [token.name, token.value]));
  const cohorts = new Map<TokenCohort, DesignTokenValue[]>();
  for (const token of tokens) {
    const cohort = classifyToken(token.name, token.value, values);
    if (cohort) cohorts.set(cohort, [...(cohorts.get(cohort) ?? []), token]);
  }
  for (const category of ORDER) {
    const members = cohorts.get(category);
    if (!members?.length) continue;
    const itemId = `${kit.id}/${category}`;
    const fitReasons = [`${members.length} ${COHORT_LABELS[category]} token(s) declared in ${tokensPath.file}`];
    if (category === 'color-palette') {
      const evidence = paletteContrastEvidence(members, values);
      fitReasons.push(`Contrast: ${evidence.reason}`, ...contrastEvidenceLines(evidence));
    }
    const ref: ResourceRef = { sourceType: 'library', sourceId: 'design-systems', itemId, revisionOrDigest: revision };
    items.push(base(itemId, `${kit.title} ${COHORT_LABELS[category]}`, category, 'css-custom-properties', { available: true, kind: 'html', url: tokenPreviewUrl(ref, { principalId: context.principalId }, workspace), reason: null }, fitReasons));
    specimens.push({ itemId, revision, title: `${kit.title} ${COHORT_LABELS[category]}`, category, tokens: members, notes: fitReasons });
  }
  return { items, specimens };
}
