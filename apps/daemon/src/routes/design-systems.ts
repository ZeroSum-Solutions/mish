import { readDesignSystemApproval, setDesignSystemApproval } from '../design-systems/approval.js';
import { sendInternalError } from '../http/api-errors.js';
import type { Express, Request, Response } from 'express';
import { withPreviewStorage } from '../plugins/preview-storage.js';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import {
  findRealTagEnd,
  HTML_TAG_PATTERNS,
  prependAfterDoctype,
} from '@mish/contracts/runtime/html-injection-points';
import { isApprovedDesignSystemFontHash } from '../design-systems/approved-font-hashes.js';
import type { RouteDeps } from '../server-context.js';
import type {
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemPackageInfo,
  DesignSystemRevision,
  DesignSystemSummary,
  UserDesignSystemInput,
} from '../design-systems/index.js';
import type { DesignTokenContractRebuildPreparation } from '../design-systems/token-contract-rebuild.js';
import { workspaceTeamDesignSystemBindingResourceId } from '../design-systems/workspace-team-binding.js';
import { teamResourceWorkspaceRoot } from '../collab/team-resource-materialization.js';
import type {
  DesignSystemGenerationJob,
  DesignSystemRevisionInput,
  DesignSystemTokenContractRebuildInput,
} from '../design-systems/generation-jobs.js';
import { deleteWorkspaceResourceByResourceId, type openDatabase } from '../db.js';
import {
  enforceVerifiedWorkspaceResourceMutation,
  enforceVerifiedWorkspaceResourceRead,
  headerValue,
  requestWithWorkspaceNavigationScope,
  resolveMemberVerifiedLocalWorkspaceRequestAuthority,
  resolveOptionalLocalWorkspaceRequestAuthority,
  resolveOptionalWorkspaceRequestAuthority,
  type OptionalWorkspaceRequestAuthorityResult,
  type VerifyWorkspaceRequestAuthority,
  type WorkspaceResourceAccessInput,
} from '../collab/workspace-resource-mutation.js';
import type { Project, ProjectFile } from '@mish/contracts';
import { KitMaterializeError } from '../design-systems/kit-materialize.js';

type DbHandle = ReturnType<typeof openDatabase>;

type DesignSystemWorkspaceProject = {
  project: Project;
  files: ProjectFile[];
};

type AvailableDesignSystemSummary = DesignSystemSummary & {
  source?: 'built-in' | 'installed' | 'user';
};

const PACKAGED_SHOWCASE_PATH = 'system/kit.html';

export interface RegisterDesignSystemRoutesDeps extends RouteDeps<'db' | 'paths' | 'projectFiles' | 'projectStore'> {
  verifyWorkspaceRequestAuthority: VerifyWorkspaceRequestAuthority;
  /**
   * Cached display-read lease (the one the `/api/design-systems` catalog
   * uses), consulted only for generation-job status reads. Per-kit reads and
   * mutations of bound Personal/Team kits never use it: they serve private
   * bytes, so they always prove membership with the fresh
   * `verifyWorkspaceRequestAuthority`. When absent, job reads fall back to
   * the fresh verifier too.
   */
  verifyWorkspaceReadAuthority?: VerifyWorkspaceRequestAuthority;
  workspaceResources: {
    getWorkspaceResource: (
      db: DbHandle,
      resourceType: string,
      workspaceId: string,
      resourceId: string,
    ) => WorkspaceResourceAccessInput | null | undefined;
    getWorkspaceResourceByResourceId: (
      db: DbHandle,
      resourceType: string,
      resourceId: string,
    ) => WorkspaceResourceAccessInput | null | undefined;
  };
  designSystems: {
    buildUserDesignSystemArchive: (
      root: string,
      id: string,
    ) => Promise<{ buffer: Buffer; baseName: string; title: string } | null>;
    /**
     * Whether the caller may mutate (edit / publish-toggle / delete) `id`.
     * Always true for a system the caller authored themselves. For a system
     * materialized locally from a teammate's team share, true only when the
     * caller can manage that share — the original sharer, or a workspace
     * owner/admin (see `canManageSharedResource` in
     * `collab/team-resource-share.ts`) — mirroring the "who can unshare"
     * rule exactly. Without this gate, a plain member with a synced local
     * copy could PATCH/DELETE a design system that was never theirs
     * (recvqb6mfyqXLD): the UI hides the affordances, but nothing stopped a
     * direct API call.
     *
     * `req` (spec 9.2) lets the implementation also refuse when the caller's
     * own workspace is locked/deleted (billing lapse, deletion in progress)
     * — a check design system never had, unlike project/plugin.
     */
    canMutateUserDesignSystem: (root: string, id: string, req: any) => Promise<boolean>;
    createUserDesignSystem: (
      root: string,
      input: UserDesignSystemInput,
      req: any,
    ) => Promise<DesignSystemSummary>;
    deleteUserDesignSystem: (root: string, id: string) => Promise<boolean>;
    ensureUserDesignSystemWorkspaceProject: (
      db: DbHandle,
      id: string,
      options?: {
        workspaceId?: string | null;
        workspaceMemberId?: string | null;
        exactTeam?: boolean;
      },
    ) => Promise<DesignSystemWorkspaceProject | null>;
    listAllDesignSystems: (options?: {
      workspaceId?: string | null;
      workspaceMemberId?: string | null;
      exactTeam?: boolean;
    }) => Promise<AvailableDesignSystemSummary[]>;
    listUserDesignSystemFiles: (root: string, id: string) => Promise<DesignSystemFileSummary[] | null>;
    listUserDesignSystemRevisions: (root: string, id: string) => Promise<DesignSystemRevision[] | null>;
    prepareDesignTokenContractRebuild: (root: string, id: string, options?: { force?: boolean }) => Promise<DesignTokenContractRebuildPreparation>;
    readAvailableDesignSystem: (
      id: string,
      options?: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean },
    ) => Promise<string | null>;
    readAvailableDesignSystemPackageInfo: (
      id: string,
      options?: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean },
    ) => Promise<DesignSystemPackageInfo | null>;
    readAvailableDesignSystemStaticFile: (
      id: string,
      filePath: string,
      options?: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean },
    ) => Promise<{
      /** The reader's sanitized package-relative path. */
      path?: string;
      bytes: Buffer;
      contentType: string;
      updatedAt: string;
    } | null>;
    readDesignSystemWorkspaceTextFile: (db: DbHandle, summary: AvailableDesignSystemSummary | undefined, filePath: string) => Promise<string | null>;
    readUserDesignSystemFile: (root: string, id: string, filePath: string) => Promise<DesignSystemFileDetail | null>;
    renderDesignSystemPreview: (id: string, body: string, options?: { tokensCss?: string | null }) => string;
    renderDesignSystemShowcase: (id: string, body: string) => string;
    /**
     * Physically copies the real `assets/` files out of a user design
     * system's workspace project (where an agent's Write/Edit tool calls
     * actually land) into the canonical directory — the fix for spec 04
     * §9.3 (recvqb1t4FrckM): canonical is the only directory
     * `team-resource-share` and the download archive read from, and until
     * this existed nothing ever copied a regenerated logo back into it.
     */
    syncUserDesignSystemAssetsFromWorkspace: (
      db: DbHandle,
      id: string,
      options?: {
        workspaceId?: string | null;
        workspaceMemberId?: string | null;
        exactTeam?: boolean;
      },
    ) => Promise<{ ok: true; synced: string[] } | { ok: false; reason: 'not-found' | 'no-workspace-project' }>;
    updateUserDesignSystem: (root: string, id: string, input: UserDesignSystemInput) => Promise<DesignSystemSummary | null>;
    updateUserDesignSystemRevisionStatus: (root: string, id: string, revisionId: string, status: 'accepted' | 'rejected') => Promise<DesignSystemRevision | null>;
    /**
     * spec 04 §11: unshare `id` from the team hub BEFORE the local delete
     * proceeds, but only when it is CURRENTLY on the live team share list
     * (`designSystemsTeamShare.sharedResources()` in server.ts) — never on
     * `isTeamSyncedUserDesignSystem` alone. That flag is true only on a
     * teammate's PULLED copy; the sharer deleting their OWN original always
     * reads `teamSynced: false`, which is exactly why the hub index used to
     * survive this route untouched and teammates kept seeing the deleted
     * design system. Returns whether an unshare actually ran (false when the
     * system was never shared, or team sharing isn't configured) so tests can
     * assert on the real state transition instead of a call-was-made mock.
     */
    unshareTeamDesignSystemIfShared: (id: string, req: any) => Promise<boolean>;
  };
  generationJobs: {
    get: (jobId: string) => DesignSystemGenerationJob | null;
    rebuildTokenContract: (input: DesignSystemTokenContractRebuildInput) => DesignSystemGenerationJob;
    revise: (input: DesignSystemRevisionInput) => DesignSystemGenerationJob;
    start: (
      input: UserDesignSystemInput,
      createDesignSystemForJob?: (
        root: string,
        input: UserDesignSystemInput,
      ) => Promise<DesignSystemSummary>,
    ) => DesignSystemGenerationJob;
  };
};

// Strip a brand title down to a safe download filename stem (no path
// separators, control chars, or trailing dashes; capped so the OS accepts it).
function sanitizeArchiveFilename(raw: string): string {
  return String(raw ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

export interface DesignSystemRouteServices {
  authorizeDesignSystemRead: (
    req: any,
    res: Response,
    id: string,
    allowNavigationQuery?: boolean,
  ) => Promise<boolean>;
  deleteDesignSystemForRequest: (
    req: Request,
    res: Response,
    id: string,
    options?: { beforeDelete?: () => Promise<boolean> },
  ) => Promise<boolean>;
}

export function registerDesignSystemRoutes(
  app: Express,
  ctx: RegisterDesignSystemRoutesDeps,
): DesignSystemRouteServices {
  const { db } = ctx;
  const { CRAFT_DIR, USER_DESIGN_SYSTEMS_DIR } = ctx.paths;
  const {
    buildUserDesignSystemArchive,
    canMutateUserDesignSystem,
    createUserDesignSystem,
    deleteUserDesignSystem,
    ensureUserDesignSystemWorkspaceProject,
    listAllDesignSystems,
    listUserDesignSystemFiles,
    listUserDesignSystemRevisions,
    prepareDesignTokenContractRebuild,
    readAvailableDesignSystem,
    readAvailableDesignSystemPackageInfo,
    readAvailableDesignSystemStaticFile,
    readDesignSystemWorkspaceTextFile,
    readUserDesignSystemFile,
    renderDesignSystemPreview,
    renderDesignSystemShowcase,
    syncUserDesignSystemAssetsFromWorkspace,
    unshareTeamDesignSystemIfShared,
    updateUserDesignSystem,
    updateUserDesignSystemRevisionStatus,
  } = ctx.designSystems;
  const designSystemGenerationJobs = ctx.generationJobs;
  const generationJobScopes = new Map<
    string,
    { workspaceId: string; workspaceMemberId: string } | null
  >();

  const getBoundDesignSystem = (
    dbHandle: unknown,
    workspaceId: string,
    resourceId: string,
  ) => ctx.workspaceResources.getWorkspaceResource(
    dbHandle as DbHandle,
    'design_system',
    workspaceId,
    resourceId,
  );
  const getDesignSystemBinding = (
    dbHandle: unknown,
    resourceId: string,
  ) => ctx.workspaceResources.getWorkspaceResourceByResourceId(
    dbHandle as DbHandle,
    'design_system',
    resourceId,
  );

  function resolveDesignSystemStorage(
    req: any,
    id: string,
    allowNavigationQuery = false,
  ): { root: string; bindingResourceId: string; exactTeam: boolean } {
    const workspaceId = (
      headerValue(req, 'x-od-workspace-id')
      ?? (allowNavigationQuery
        ? designSystemNavigationWorkspaceQuery(req)?.workspaceId
        : null)
      ?? ''
    ).trim();
    if (!workspaceId) {
      return { root: USER_DESIGN_SYSTEMS_DIR, bindingResourceId: id, exactTeam: false };
    }
    const teamBindingResourceId = workspaceTeamDesignSystemBindingResourceId(
      workspaceId,
      id,
    );
    const teamBinding = getBoundDesignSystem(db, workspaceId, teamBindingResourceId);
    return teamBinding?.visibility === 'team'
      ? {
          root: teamResourceWorkspaceRoot(USER_DESIGN_SYSTEMS_DIR, workspaceId),
          bindingResourceId: teamBindingResourceId,
          exactTeam: true,
        }
      : { root: USER_DESIGN_SYSTEMS_DIR, bindingResourceId: id, exactTeam: false };
  }

  function sendWorkspaceAuthorityRefusal(
    res: Response,
    refusal: Exclude<OptionalWorkspaceRequestAuthorityResult, { ok: true }>,
  ): false {
    res.status(refusal.status).json({
      error: refusal.code,
      message: refusal.message,
      ...(refusal.retryable ? { retryable: true } : {}),
    });
    return false;
  }

  /**
   * Prove that the caller holds the Workspace/member pair it claims.
   *
   * Invariant: a claimed pair (headers, or the navigation query on iframe/src
   * routes) only SELECTS which membership to check. It is never proof of
   * membership. Every per-design-system gate calls this before it compares
   * the pair with a binding's persisted creator or opens a Workspace's Team
   * mirror, so knowing a kit id and another member's pair does not open that
   * member's kit. Unknown, removed and non-member pairs get the verifier's
   * refusal (403 `WORKSPACE_ACCESS_DENIED`, or 401/503 when the directory
   * cannot answer). See `resolveMemberVerifiedLocalWorkspaceRequestAuthority`.
   */
  async function proveClaimedWorkspaceMembership(
    req: any,
    res: Response,
    verify: VerifyWorkspaceRequestAuthority,
  ): Promise<boolean> {
    const verified = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(
      req,
      verify,
    );
    return verified.ok ? true : sendWorkspaceAuthorityRefusal(res, verified);
  }

  async function authorizeDesignSystemRead(
    req: any,
    res: Response,
    id: string,
    allowNavigationQuery = false,
  ): Promise<boolean> {
    const scopedRequest = allowNavigationQuery
      ? requestWithWorkspaceNavigationScope(req)
      : req;
    if (scopedRequest === 'conflict') {
      res.status(400).json({
        error: 'WORKSPACE_CONTEXT_CONFLICT',
        message: 'workspace header and navigation scope must match',
      });
      return false;
    }
    const resolution = resolveOptionalLocalWorkspaceRequestAuthority(scopedRequest);
    if (!resolution.ok) return sendWorkspaceAuthorityRefusal(res, resolution);
    let bindingResourceId = id;
    let binding = getDesignSystemBinding(db, id);
    if (resolution.context) {
      const teamBindingResourceId = workspaceTeamDesignSystemBindingResourceId(
        resolution.context.workspaceId,
        id,
      );
      const teamBinding = getBoundDesignSystem(
        db,
        resolution.context.workspaceId,
        teamBindingResourceId,
      );
      const personalBinding = getBoundDesignSystem(
        db,
        resolution.context.workspaceId,
        id,
      );
      if (teamBinding?.visibility === 'team') {
        bindingResourceId = teamBindingResourceId;
        binding = teamBinding;
      } else {
        binding = personalBinding;
      }
    }
    const isPublicBuiltIn = resolution.context && !binding
      ? (await listAllDesignSystems({
          workspaceId: resolution.context.workspaceId,
        })).some((system) => system.id === id && system.source === 'built-in')
      : false;
    // An unbound public built-in grants nothing to the claimed pair, so only
    // that read skips the membership proof (and stays usable offline).
    // Invariant: every other per-kit read serves Personal/Team bytes, so it
    // proves membership with the FRESH directory verifier, never the cached
    // display-read lease. A member Vela removed loses access on the next
    // request instead of when the lease expires.
    if (
      resolution.context
      && (binding || !isPublicBuiltIn)
      && !(await proveClaimedWorkspaceMembership(
        scopedRequest,
        res,
        ctx.verifyWorkspaceRequestAuthority,
      ))
    ) {
      return false;
    }
    // Explicit Workspace requests never inherit ownerless legacy resources.
    // A Personal design system is private to its exact persisted creator even
    // when the caller is an owner/admin in the same Workspace. Team resources
    // remain readable by every verified active member through the shared gate.
    if (resolution.context && (
      (!binding && !isPublicBuiltIn)
      || (
        binding
        && binding.visibility !== 'team'
        && binding.createdByWorkspaceMemberId !== resolution.context.workspaceMemberId
      )
    )) {
      res.status(403).json({
        error: 'WORKSPACE_DESIGN_SYSTEM_PERMISSION_DENIED',
        message: 'workspace design_system read is not allowed',
      });
      return false;
    }
    if (binding && !resolution.context) {
      res.status(400).json({
        error: 'WORKSPACE_CONTEXT_REQUIRED',
        message: 'an explicit workspace context is required',
      });
      return false;
    }
    return enforceVerifiedWorkspaceResourceRead(
      'design_system',
      req,
      res,
      (_res, status, code, message, details) =>
        res.status(status).json({ error: code, message, ...details }),
      getBoundDesignSystem,
      getDesignSystemBinding,
      db,
      bindingResourceId,
      resolution.context
        ? async () => ({ ok: true as const, context: resolution.context! })
        : ctx.verifyWorkspaceRequestAuthority,
      { allowNavigationQuery },
    );
  }

  async function authorizeDesignSystemMutation(
    req: any,
    res: Response,
    id: string,
  ): Promise<boolean> {
    const resolution = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!resolution.ok) return sendWorkspaceAuthorityRefusal(res, resolution);
    if (
      resolution.context
      && !(await proveClaimedWorkspaceMembership(
        req,
        res,
        ctx.verifyWorkspaceRequestAuthority,
      ))
    ) {
      return false;
    }
    let bindingResourceId = id;
    let binding = getDesignSystemBinding(db, id);
    if (resolution.context) {
      const teamBindingResourceId = workspaceTeamDesignSystemBindingResourceId(
        resolution.context.workspaceId,
        id,
      );
      const teamBinding = getBoundDesignSystem(
        db,
        resolution.context.workspaceId,
        teamBindingResourceId,
      );
      const personalBinding = getBoundDesignSystem(
        db,
        resolution.context.workspaceId,
        id,
      );
      if (teamBinding?.visibility === 'team') {
        bindingResourceId = teamBindingResourceId;
        binding = teamBinding;
      } else {
        binding = personalBinding;
      }
    }
    if (resolution.context && (
      !binding
      || (
        binding.visibility !== 'team'
        && binding.createdByWorkspaceMemberId !== resolution.context.workspaceMemberId
      )
    )) {
      res.status(403).json({
        error: 'WORKSPACE_DESIGN_SYSTEM_PERMISSION_DENIED',
        message: 'workspace design_system mutation is not allowed',
      });
      return false;
    }
    if (binding && !resolution.context) {
      res.status(400).json({
        error: 'WORKSPACE_CONTEXT_REQUIRED',
        message: 'an explicit workspace context is required',
      });
      return false;
    }
    return enforceVerifiedWorkspaceResourceMutation(
      'design_system',
      req,
      res,
      (_res, status, code, message) =>
        res.status(status).json({ error: code, message }),
      getBoundDesignSystem,
      getDesignSystemBinding,
      db,
      bindingResourceId,
      'writeFiles',
      resolution.context
        ? async () => ({ ok: true as const, context: resolution.context! })
        : ctx.verifyWorkspaceRequestAuthority,
    );
  }

  /**
   * The Workspace/member pair a generation job is pinned to, or read against.
   *
   * Invariant: the pair is directory-verified before it is returned, the same
   * proof `authorizeDesignSystemRead` requires, so replaying another member's
   * pair can neither attribute a new job to that member nor read that
   * member's job. Pass `'membership-proven'` only when the route has already
   * run `authorizeDesignSystemMutation` for this request, which verified the
   * same pair with the fresh verifier.
   */
  async function resolveGenerationJobScope(
    req: any,
    res: Response,
    verify: VerifyWorkspaceRequestAuthority | 'membership-proven',
  ): Promise<{ workspaceId: string; workspaceMemberId: string } | null | 'denied'> {
    const resolution = verify === 'membership-proven'
      ? resolveOptionalLocalWorkspaceRequestAuthority(req)
      : await resolveMemberVerifiedLocalWorkspaceRequestAuthority(req, verify);
    if (!resolution.ok) {
      res.status(resolution.status).json({
        error: resolution.code,
        message: resolution.message,
        ...(resolution.retryable ? { retryable: true } : {}),
      });
      return 'denied';
    }
    return resolution.context
      ? {
          workspaceId: resolution.context.workspaceId,
          workspaceMemberId: resolution.context.workspaceMemberId,
        }
      : null;
  }

  async function authorizeGenerationJobRead(
    req: any,
    res: Response,
    job: DesignSystemGenerationJob,
  ): Promise<boolean> {
    const scope = generationJobScopes.get(job.id);
    if (scope) {
      const resolution = await resolveGenerationJobScope(
        req,
        res,
        ctx.verifyWorkspaceReadAuthority ?? ctx.verifyWorkspaceRequestAuthority,
      );
      if (resolution === 'denied') return false;
      if (
        !resolution
        || resolution.workspaceId !== scope.workspaceId
        || resolution.workspaceMemberId !== scope.workspaceMemberId
      ) {
        res.status(403).json({ error: 'WORKSPACE_DESIGN_SYSTEM_PERMISSION_DENIED' });
        return false;
      }
      return true;
    }
    return job.designSystemId
      ? authorizeDesignSystemRead(req, res, job.designSystemId)
      : true;
  }

  function sendWorkspaceScopeError(res: Response, error: unknown): boolean {
    if (
      !error ||
      typeof error !== 'object' ||
      !('status' in error) ||
      (error.status !== 400 && error.status !== 403 && error.status !== 503) ||
      !('code' in error) ||
      typeof error.code !== 'string'
    ) {
      return false;
    }
    res.status(error.status).json({
      error: error.code,
      message: error instanceof Error ? error.message : String(error.code),
      ...('retryable' in error && error.retryable === true ? { retryable: true } : {}),
    });
    return true;
  }

  /**
   * A write to a design system installed by symlink before installs became
   * copies first converts it into a managed copy; when the linked folder
   * cannot be copied safely the write is refused. That refusal is the
   * user's to fix (reinstall from a clean folder), so every write route
   * reports it the same way: 422 with a stable code and the reason.
   */
  function sendKitMaterializeRefusal(res: Response, err: unknown): boolean {
    if (!(err instanceof KitMaterializeError)) return false;
    res.status(422).json({
      error: 'KIT_MATERIALIZE_REFUSED',
      reason: err.code,
      message: err.message,
    });
    return true;
  }

  app.post('/api/design-systems', async (req, res) => {
    try {
      const created = await createUserDesignSystem(
        USER_DESIGN_SYSTEMS_DIR,
        req.body || {},
        req,
      );
      res.status(201).json({ ...created as object, designSystem: created });
    } catch (err) {
      if (sendWorkspaceScopeError(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/generation-jobs', async (req, res) => {
    try {
      const scope = await resolveGenerationJobScope(
        req,
        res,
        ctx.verifyWorkspaceRequestAuthority,
      );
      if (scope === 'denied') return;
      const job = designSystemGenerationJobs.start(
        req.body || {},
        (root, input) => createUserDesignSystem(root, input, req),
      );
      generationJobScopes.set(job.id, scope);
      res.status(202).json({ job });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/generation-jobs/:jobId', async (req, res) => {
    try {
      const job = designSystemGenerationJobs.get(req.params.jobId);
      if (!job) {
        return res.status(404).json({ error: 'design system generation job not found' });
      }
      if (!(await authorizeGenerationJobRead(req, res, job))) return;
      res.json({ job });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.post('/api/design-systems/:id/revision-jobs', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      const scope = await resolveGenerationJobScope(req, res, 'membership-proven');
      if (scope === 'denied') return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const feedback = typeof req.body?.feedback === 'string' ? req.body.feedback : '';
      if (!feedback.trim()) return res.status(400).json({ error: 'feedback is required' });
      const job = designSystemGenerationJobs.revise({
        root: storage.root,
        designSystemId: req.params.id,
        feedback,
        sectionTitle: typeof req.body?.sectionTitle === 'string' ? req.body.sectionTitle : undefined,
        body: typeof req.body?.body === 'string' ? req.body.body : undefined,
      });
      generationJobScopes.set(job.id, scope);
      res.status(202).json({ job });
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  app.post('/api/design-systems/:id/token-contract/rebuild-jobs', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      const scope = await resolveGenerationJobScope(req, res, 'membership-proven');
      if (scope === 'denied') return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const preparation = await prepareDesignTokenContractRebuild(
        storage.root,
        req.params.id,
        { force: req.body?.force === true },
      );
      if (!preparation.decision.available) {
        return res.status(200).json({ decision: preparation.decision });
      }
      if (!preparation.revision) {
        return res.status(200).json({ decision: preparation.decision });
      }
      const job = designSystemGenerationJobs.rebuildTokenContract({
        root: storage.root,
        designSystemId: req.params.id,
        decision: preparation.decision,
        ...preparation.revision,
      });
      generationJobScopes.set(job.id, scope);
      res.status(202).json({ decision: preparation.decision, job });
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/revisions', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const revisions = await listUserDesignSystemRevisions(
        storage.root,
        req.params.id,
      );
      if (!revisions) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ revisions });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.patch('/api/design-systems/:id/revisions/:revisionId', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      // recvqb6mfyqXLD: accepting a revision commits its proposed body onto
      // the canonical design system — the same "edit" this route family
      // gates everywhere else (PATCH/DELETE/sync-assets above). Without this,
      // a plain member viewing a teammate's team-synced design system could
      // accept/reject its pending revision (surfaced to anyone who can read
      // the system, not just the owner) with no server-side check at all,
      // even after the UI stopped showing it as editable.
      const storage = resolveDesignSystemStorage(req, req.params.id);
      if (!(await canMutateUserDesignSystem(storage.root, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const status = typeof req.body?.status === 'string' ? req.body.status : '';
      if (status !== 'accepted' && status !== 'rejected') {
        return res.status(400).json({ error: 'status must be accepted or rejected' });
      }
      const revision = await updateUserDesignSystemRevisionStatus(
        storage.root,
        req.params.id,
        req.params.revisionId,
        status,
      );
      if (!revision) {
        return res.status(404).json({ error: 'design system revision not found' });
      }
      res.json({ revision });
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id))) return;
      const workspaceId = headerValue(req, 'x-od-workspace-id');
      const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const systems = await listAllDesignSystems({
        workspaceId,
        workspaceMemberId,
        exactTeam: storage.exactTeam,
      });
      const summary = systems.find((s) => s.id === req.params.id);
      const projectBody = await readDesignSystemWorkspaceTextFile(db, summary, 'DESIGN.md');
      const body = projectBody ?? await readAvailableDesignSystem(req.params.id, {
        workspaceId,
        workspaceMemberId,
        exactTeam: storage.exactTeam,
      });
      if (body === null || !summary) {
        return res.status(404).json({ error: 'design system not found' });
      }
      const packageInfo = await readAvailableDesignSystemPackageInfo(req.params.id, {
        workspaceId,
        workspaceMemberId,
        exactTeam: storage.exactTeam,
      });
      // recvqb6mfyqXLD: mirror the exact PATCH/DELETE verdict onto the read
      // path too. `DesignSystemsTab` already re-derives an equivalent verdict
      // from the separate `/team` share listing for its own list+detail pane,
      // but a design system reached any other way — e.g. the direct
      // `/design-systems/:id` route the Library's "Open the design system" link
      // and `LibrarySection` navigate to, which renders `DesignSystemFlow`
      // directly — had no ownership signal at all and fell back to treating
      // any non-built-in system as fully editable. Computing it once here,
      // from the same `canMutateUserDesignSystem` the mutation routes below
      // already gate on, means every detail surface can hide/disable its
      // Publish toggle and Save button on the same authority the backend
      // enforces, instead of each surface re-deriving (or forgetting to
      // derive) its own verdict.
      const canMutate = await canMutateUserDesignSystem(storage.root, req.params.id, req);
      const detail = { ...summary, body, canMutate, ...(packageInfo ? { packageInfo } : {}) };
      res.json({ ...detail, designSystem: detail });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.get('/api/design-systems/:id/preview', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id, true))) return;
      const workspaceId =
        headerValue(req, 'x-od-workspace-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceId
        ?? null;
      const workspaceMemberId =
        headerValue(req, 'x-od-workspace-member-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceMemberId
        ?? null;
      const storage = resolveDesignSystemStorage(req, req.params.id, true);
      const body = await readAvailableDesignSystem(req.params.id, {
        workspaceId,
        workspaceMemberId,
        exactTeam: storage.exactTeam,
      });
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const tokens = await readAvailableDesignSystemStaticFile(
        req.params.id,
        'tokens.css',
        { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam },
      );
      const html = renderDesignSystemPreview(req.params.id, body, {
        tokensCss: tokens ? tokens.bytes.toString('utf8') : null,
      });
      res.type('text/html').send(withPreviewStorage(html));
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  app.get('/api/design-systems/:id/showcase', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id, true))) return;
      const workspaceId =
        headerValue(req, 'x-od-workspace-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceId
        ?? null;
      const workspaceMemberId =
        headerValue(req, 'x-od-workspace-member-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceMemberId
        ?? null;
      const storage = resolveDesignSystemStorage(req, req.params.id, true);
      const packaged = await readAvailableDesignSystemStaticFile(
        req.params.id,
        PACKAGED_SHOWCASE_PATH,
        { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam },
      );
      if (packaged?.contentType.startsWith('text/html')) {
        res.setHeader('Cache-Control', 'no-store');
        const packagedHtml = packaged.bytes.toString('utf8');
        if (packagePathFormAvailable(req, req.params.id) && !mentionsBaseTag(packagedHtml)) {
          // The kit opens at its own place in the package, so the document URL
          // and its base are the same URL: script-built relative URLs resolve
          // to package files and `#fragment` links stay in this document.
          return res.redirect(302, designSystemPackageFileUrl(req.params.id, PACKAGED_SHOWCASE_PATH));
        }
        const workspaceQuery = designSystemNavigationWorkspaceQuery(req);
        res.setHeader('Last-Modified', packaged.updatedAt);
        return res.type('text/html').send(
          withPreviewStorage(rewriteDesignSystemShowcaseAssetUrls(
            packagedHtml,
            req.params.id,
            path.posix.dirname(PACKAGED_SHOWCASE_PATH),
            workspaceQuery,
          )),
        );
      }
      const body = await readAvailableDesignSystem(req.params.id, {
        workspaceId,
        workspaceMemberId,
        exactTeam: storage.exactTeam,
      });
      if (body === null) return res.status(404).type('text/plain').send('not found');
      const html = renderDesignSystemShowcase(req.params.id, body);
      res.type('text/html').send(withPreviewStorage(html));
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  });

  // Package files are addressable two ways. `?path=` is the original form.
  // The path form mirrors the package layout in the URL, so a page's own
  // relative references — including URLs its scripts build at runtime, which
  // no rewriter sees — resolve to sibling package files. Relative URLs drop
  // the query string, so the path form cannot carry Workspace navigation
  // scope; it serves only kits outside any Workspace and answers 404 for the
  // rest, which keep the query form and its rewrites.
  app.get('/api/design-systems/:id/static', async (req, res) => {
    const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
    await serveDesignSystemStaticFile(req, res, requestedPath, 'query');
  });
  app.get('/api/design-systems/:id/static/*filePath', async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (!packagePathFormAvailable(req, req.params.id)) {
      return res.status(404).type('text/plain').send('not found');
    }
    await serveDesignSystemStaticFile(req, res, wildcardPackagePath(req.params.filePath), 'path');
  });

  /**
   * True when a request may use the path form for this kit: no Workspace
   * header or navigation query key is present at all (empty values included),
   * the kit's storage resolves to the local user root, and the kit has no
   * Workspace binding. Never trusts or synthesizes a Workspace identity.
   */
  function packagePathFormAvailable(req: any, id: string): boolean {
    const headers = req.headers ?? {};
    if ('x-od-workspace-id' in headers || 'x-od-workspace-member-id' in headers) return false;
    const query = req.query ?? {};
    if (Object.hasOwn(query, 'workspaceId') || Object.hasOwn(query, 'workspaceMemberId')) return false;
    const storage = resolveDesignSystemStorage(req, id);
    if (storage.exactTeam || storage.root !== USER_DESIGN_SYSTEMS_DIR || storage.bindingResourceId !== id) {
      return false;
    }
    return !getDesignSystemBinding(db, id);
  }

  async function serveDesignSystemStaticFile(
    req: any,
    res: Response,
    requestedPath: string,
    form: 'query' | 'path',
  ) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id, true))) return;
      const workspaceId =
        headerValue(req, 'x-od-workspace-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceId
        ?? null;
      const workspaceMemberId =
        headerValue(req, 'x-od-workspace-member-id')
        ?? designSystemNavigationWorkspaceQuery(req)?.workspaceMemberId
        ?? null;
      const storage = resolveDesignSystemStorage(req, req.params.id, true);
      const file = await readAvailableDesignSystemStaticFile(
        req.params.id,
        requestedPath,
        { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam },
      );
      if (!file) return res.status(404).type('text/plain').send('not found');
      const fontAsset = /^font\//i.test(file.contentType);
      // Revalidate mutable font files with Express's ETag rather than downloading
      // their bytes on every hover. Workspace responses stay browser-private.
      res.setHeader('Cache-Control', fontAsset ? 'private, no-cache' : 'no-store');
      if (fontAsset) res.vary('Origin');
      if (fontAsset && req.headers.origin === 'null') {
        // Opaque origins can originate on any website. Expose only the licensed
        // bundle bytes whose source-owned hash and OFL provenance match the served font. An
        // editable upload cannot inherit this permission from a reused filename.
        const provenance = await readAvailableDesignSystemStaticFile(
          req.params.id, 'fonts/package-fonts.json',
          { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam },
        );
        let approved = false;
        try {
          const records = provenance ? JSON.parse(provenance.bytes.toString('utf8')).fonts : null;
          const sha256 = createHash('sha256').update(file.bytes).digest('hex');
          approved = isApprovedDesignSystemFontHash(sha256) && Array.isArray(records) && records.some((record: unknown) => {
            if (!record || typeof record !== 'object') return false;
            const font = record as { file?: unknown; license?: unknown; sha256?: unknown };
            return font.file === requestedPath && font.license === 'OFL-1.1' && font.sha256 === sha256;
          });
        } catch {
          // Missing or malformed provenance grants no opaque-origin access.
        }
        if (!approved) {
          res.setHeader('Cache-Control', 'no-store');
          return res.status(403).json({ error: 'Sandbox font access requires matching OFL bundle provenance' });
        }
        res.setHeader('Access-Control-Allow-Origin', 'null');
      }
      res.setHeader('Last-Modified', file.updatedAt);
      // Query-based static URLs need package-relative dependencies rewritten too.
      // Carry the same Workspace authority into nested CSS/font requests.
      const textAsset = /^(text\/html|text\/css)(?:;|$)/i.test(file.contentType);
      const htmlAsset = /^text\/html(?:;|$)/i.test(file.contentType);
      const scope = workspaceId && workspaceMemberId ? { workspaceId, workspaceMemberId } : null;
      // The reader's sanitized path, so `a/./b` and `a\\b` resolve like `a/b`.
      const packagePath = file.path ?? requestedPath;
      const rewritten = textAsset
        ? rewriteDesignSystemShowcaseAssetUrls(
            file.bytes.toString('utf8'), req.params.id,
            path.posix.dirname(packagePath),
            scope,
            !htmlAsset,
          )
        : null;
      if (
        htmlAsset
        && form === 'query'
        && packagePathFormAvailable(req, req.params.id)
        && !mentionsBaseTag(file.bytes.toString('utf8'))
      ) {
        // Same reason as /showcase: open documents where their base is.
        return res.redirect(302, designSystemPackageFileUrl(req.params.id, packagePath));
      }
      const content = rewritten === null
        ? file.bytes
        : htmlAsset && form === 'path'
          ? injectDesignSystemPackageBase(rewritten, req.params.id, packagePath)
          : rewritten;
      res.type(file.contentType).send(htmlAsset ? withPreviewStorage(String(content)) : content);
    } catch (err) {
      res.status(500).type('text/plain').send(String(err));
    }
  }

  app.post('/api/design-systems/:id/workspace', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      const workspaceId = headerValue(req, 'x-od-workspace-id');
      const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const workspace = await ensureUserDesignSystemWorkspaceProject(
        db,
        req.params.id,
        workspaceId || workspaceMemberId
          ? { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam }
          : undefined,
      );
      if (!workspace) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.status(201).json(workspace);
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  app.get('/api/design-systems/:id/files', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      const files = await listUserDesignSystemFiles(storage.root, req.params.id);
      if (!files) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ files });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.get('/api/design-systems/:id/file', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id, true))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id, true);
      const requestedPath = typeof req.query.path === 'string' ? req.query.path : '';
      const file = await readUserDesignSystemFile(
        storage.root,
        req.params.id,
        requestedPath,
      );
      if (!file) return res.status(404).json({ error: 'design system file not found' });
      res.json({ file });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  // Streams a .zip of the whole user design system directory plus a generated
  // SKILLS.md usage guide, so the "Download brand" action (and `od
  // design-systems download`) hand the recipient a self-contained, shareable
  // brand package. Only user systems have an editable dir; presets resolve to
  // null and surface as 404.
  app.get('/api/design-systems/:id/archive', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemRead(req, res, req.params.id, true))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id, true);
      const archive = await buildUserDesignSystemArchive(storage.root, req.params.id);
      if (!archive) {
        return res.status(404).json({ error: 'downloadable design system not found' });
      }
      const fileSlug = sanitizeArchiveFilename(archive.baseName) || 'design-system';
      const filename = `${fileSlug}.zip`;
      // RFC 5987: ASCII `filename=` fallback plus UTF-8 `filename*=` so brand
      // names with non-ASCII characters (CJK, accents) download without mojibake.
      const asciiFallback =
        filename.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, '_') || 'design-system.zip';
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      );
      res.send(archive.buffer);
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.put('/api/design-systems/:id/approval', async (req, res) => {
    try {
      const builtIn = !req.params.id.startsWith('user:');
      // Built-ins are global read-only packages without workspace binding rows.
      // Approval writes only a local receipt; it never mutates the package.
      if (builtIn) {
        const authority = await resolveOptionalWorkspaceRequestAuthority(req, ctx.verifyWorkspaceRequestAuthority);
        if (!authority.ok) { sendWorkspaceAuthorityRefusal(res, authority); return; }
        const member = authority.context;
        if (member && (member.memberStatus !== 'active' || !member.permissions.canWriteSyncedFiles || !['owner', 'admin'].includes(member.role))) {
          return res.status(403).json({ error: 'WORKSPACE_DESIGN_SYSTEM_PERMISSION_DENIED', message: 'Managing built-in approvals requires verified workspace management permission.' });
        }
      }
      if (!(await (builtIn ? authorizeDesignSystemRead(req, res, req.params.id) : authorizeDesignSystemMutation(req, res, req.params.id)))) return;
      const storage = builtIn ? { root: ctx.paths.DESIGN_SYSTEMS_DIR, exactTeam: false } : resolveDesignSystemStorage(req, req.params.id);
      const receiptRoot = builtIn ? path.join(USER_DESIGN_SYSTEMS_DIR, '.built-in') : storage.exactTeam ? path.join(storage.root, '.local') : storage.root;
      if (!builtIn && !(await canMutateUserDesignSystem(storage.root, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const { approved, expectedRevision } = req.body ?? {};
      if (typeof approved !== 'boolean' || typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
        return res.status(400).json({ error: 'Pass approved and the inspected expectedRevision' });
      }
      const options = { workspaceId: headerValue(req, 'x-od-workspace-id'), workspaceMemberId: headerValue(req, 'x-od-workspace-member-id'), exactTeam: storage.exactTeam, fresh: true };
      const summary = (await listAllDesignSystems(options)).find(item => item.id === req.params.id);
      if (!summary) return res.status(404).json({ error: 'design system not found' });
      const canonical = await readDesignSystemApproval(storage.root, req.params.id, receiptRoot);
      if (approved && summary.approval?.revision !== canonical.revision) return res.status(409).json({ error: 'DESIGN_SYSTEM_WORKSPACE_UNSAVED', message: 'Save kit edits and inspect the saved revision before approval.' });
      if (summary.approval?.revision !== expectedRevision) return res.status(409).json({ error: 'DESIGN_SYSTEM_REVISION_CONFLICT' });
      const system = approved && !builtIn
        ? await updateUserDesignSystem(storage.root, req.params.id, { status: 'published' })
        : summary;
      if (!system) return res.status(404).json({ error: 'design system not found' });
      const approval = await setDesignSystemApproval(storage.root, req.params.id, approved, approved ? expectedRevision : canonical.revision, receiptRoot);
      if (approved && approval.status !== 'approved') return res.status(409).json({ error: 'DESIGN_SYSTEM_REVISION_CONFLICT' });
      res.json({ designSystem: { ...system, approval } });
    } catch (error) {
      if (sendKitMaterializeRefusal(res, error)) return;
      const message = error instanceof Error ? error.message : String(error);
      res.status(message === 'DESIGN_SYSTEM_REVISION_CONFLICT' ? 409 : (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400).json({ error: message });
    }
  });

  app.patch('/api/design-systems/:id', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      if (!(await canMutateUserDesignSystem(storage.root, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const updated = await updateUserDesignSystem(
        storage.root,
        req.params.id,
        req.body || {},
      );
      if (!updated) {
        return res.status(404).json({ error: 'editable design system not found' });
      }
      res.json({ ...updated as object, designSystem: updated });
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      res.status(400).json({ error: String(err) });
    }
  });

  // Asset sync (spec 04 §9.3, recvqb1t4FrckM): a signal-only endpoint — the
  // browser never uploads file bytes here. The daemon locates the design
  // system's workspace project itself (same lookup
  // `ensureUserDesignSystemWorkspaceProject` uses) and copies real files
  // under that project's `assets/` directory into the canonical design
  // system directory, entirely on the daemon side of the data-directory
  // boundary. Gated the same way as PATCH/DELETE: a locked workspace or a
  // caller who cannot manage the (possibly team-synced) design system may
  // not trigger a write to canonical.
  app.post('/api/design-systems/:id/sync-assets', async (req, res) => {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, req.params.id))) return;
      const storage = resolveDesignSystemStorage(req, req.params.id);
      if (!(await canMutateUserDesignSystem(storage.root, req.params.id, req))) {
        return res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
      }
      const workspaceId = headerValue(req, 'x-od-workspace-id');
      const workspaceMemberId = headerValue(req, 'x-od-workspace-member-id');
      const outcome = await syncUserDesignSystemAssetsFromWorkspace(
        db,
        req.params.id,
        workspaceId || workspaceMemberId
          ? { workspaceId, workspaceMemberId, exactTeam: storage.exactTeam }
          : undefined,
      );
      if (!outcome.ok) {
        if (outcome.reason === 'not-found') {
          return res.status(404).json({ error: 'editable design system not found' });
        }
        // No workspace project to sync from yet — a benign no-op, not an
        // error; the trigger sites call this speculatively on every asset
        // write and run-end.
        return res.json({ synced: [] });
      }
      res.json({ synced: outcome.synced });
    } catch (err) {
      if (sendKitMaterializeRefusal(res, err)) return;
      sendInternalError(res, err);
    }
  });

  async function deleteDesignSystemForRequest(
    req: Request,
    res: Response,
    id: string,
    options: { beforeDelete?: () => Promise<boolean> } = {},
  ): Promise<boolean> {
    try {
      if (!(await authorizeDesignSystemMutation(req, res, id))) return false;
      const storage = resolveDesignSystemStorage(req, id);
      if (!(await canMutateUserDesignSystem(storage.root, id, req))) {
        res.status(403).json({ error: 'WORKSPACE_RESOURCE_MANAGE_DENIED' });
        return false;
      }
      if (options.beforeDelete && !(await options.beforeDelete())) return false;
      // spec 04 §11: drop the hub-side share BEFORE the local delete, so a
      // sharer deleting their OWN design system does not leave the hub index
      // pointing at a canonical directory that is about to stop existing —
      // otherwise `syncSharedTeamDesignSystem` (server.ts) keeps re-stamping
      // `markTeamSynced()` onto every teammate's already-synced local copy
      // forever, because the hub still reports the resource as shared. A
      // thrown error here (e.g. the caller cannot actually manage the share)
      // aborts before `deleteUserDesignSystem` runs, matching "unshare must
      // succeed before the local delete proceeds".
      await unshareTeamDesignSystemIfShared(id, req);
      const ok = await deleteUserDesignSystem(storage.root, id);
      if (!ok) {
        res.status(404).json({ error: 'editable design system not found' });
        return false;
      }
      // Envelope cleanup (spec 9.2): drop the `workspace_resources` binding
      // row too, mirroring skill's DELETE route (routes/static-resource.ts)
      // and plugin uninstall (plugins/installer.ts) — the generic table has
      // no ON DELETE CASCADE, so skipping this leaves an orphan row pointing
      // at a design system that no longer exists on disk.
      deleteWorkspaceResourceByResourceId(db, 'design_system', storage.bindingResourceId);
      return true;
    } catch (err) {
      if (sendWorkspaceScopeError(res, err)) return false;
      sendInternalError(res, err);
      return false;
    }
  }

  app.delete('/api/design-systems/:id', async (req, res) => {
    if (!(await deleteDesignSystemForRequest(req, res, req.params.id))) return;
    res.status(204).end();
  });

  app.get('/api/craft', async (_req, res) => {
    try {
      let entries;
      try {
        entries = await fsp.readdir(CRAFT_DIR, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.json({ craft: [] });
        }
        throw err;
      }
      const out = [];
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const slug = entry.name.replace(/\.md$/, '');
        try {
          const fullPath = `${CRAFT_DIR}/${entry.name}`;
          const text = await fsp.readFile(fullPath, 'utf8');
          const heading = text.split('\n').find((line) => line.startsWith('# '));
          out.push({
            id: slug,
            label: heading ? heading.replace(/^#+\s*/, '').trim() : slug,
            bytes: Buffer.byteLength(text, 'utf8'),
          });
        } catch {
          // Skip unreadable files; surface what we can.
        }
      }
      res.json({ craft: out });
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  app.get('/api/craft/:id', async (req, res) => {
    try {
      const slug = req.params.id;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
        return res.status(400).json({ error: 'invalid craft id' });
      }
      try {
        const text = await fsp.readFile(`${CRAFT_DIR}/${slug}.md`, 'utf8');
        res.json({ id: slug, body: text });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
          return res.status(404).json({ error: 'craft section not found' });
        }
        throw err;
      }
    } catch (err) {
      sendInternalError(res, err);
    }
  });

  return { authorizeDesignSystemRead, deleteDesignSystemForRequest };
}

export function rewriteDesignSystemShowcaseAssetUrls(
  html: string,
  designSystemId: string,
  baseDir: string,
  workspaceQuery?: { workspaceId: string; workspaceMemberId: string } | null,
  cssOnly = false,
): string {
  if (!html) return html;
  const rewriteUrl = (raw: string): string =>
    rewriteDesignSystemShowcaseAssetUrl(raw, designSystemId, baseDir, workspaceQuery);
  // CSS references live in stylesheets, `<style>` elements and style
  // attributes only. Matching `url(` across a whole document also hit script —
  // `URL.createObjectURL(f)` became a syntax error that killed the kit's script.
  const rewriteCss = (css: string): string => css
    .replace(/@import\s+(["'])([^"']+)\1/gi, (match, quote: string, raw: string) => {
      const rewritten = rewriteUrl(raw);
      return rewritten === raw ? match : `@import ${quote}${rewritten}${quote}`;
    })
    .replace(/(?<![\w$.-])url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (match, quote: string, raw: string) => {
      const rewritten = rewriteUrl(raw);
      return rewritten === raw ? match : `url(${quote}${rewritten}${quote})`;
    });
  if (cssOnly) return rewriteCss(html);
  return html
    .replace(/\b(src|href)=(["'])([^"']+)\2/gi, (match, attr: string, quote: string, raw: string) => {
      const rewritten = rewriteUrl(raw);
      return rewritten === raw ? match : `${attr}=${quote}${rewritten}${quote}`;
    })
    .replace(
      /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi,
      (_match, open: string, css: string, close: string) => `${open}${rewriteCss(css)}${close}`,
    )
    .replace(
      /\bstyle=(?:"([^"]*)"|'([^']*)')/gi,
      (match, doubleQuoted: string | undefined, singleQuoted: string | undefined) => (
        doubleQuoted !== undefined
          ? `style="${rewriteCss(doubleQuoted)}"`
          : singleQuoted !== undefined ? `style='${rewriteCss(singleQuoted)}'` : match
      ),
    );
}

/**
 * Whether the text contains `<base` anywhere, case-insensitively — inside
 * script or an attribute, and as a prefix (`<base64`, `<base-foo`) included.
 * Such documents are served the way main serves them: href/src rewritten
 * against the file's own directory, inline rather than redirected, and with
 * no injected base.
 */
function mentionsBaseTag(html: string): boolean {
  return html.toLowerCase().includes('<base');
}

function wildcardPackagePath(segments: unknown): string {
  return Array.isArray(segments) ? segments.join('/') : typeof segments === 'string' ? segments : '';
}

/** Path-form URL of one package file; see the static route registration. */
export function designSystemPackageFileUrl(designSystemId: string, packagePath: string): string {
  const encodedPath = packagePath.split('/').map((part) => encodeURIComponent(part)).join('/');
  return `/api/design-systems/${encodeURIComponent(designSystemId)}/static/${encodedPath}`;
}

/**
 * Give a path-form package HTML document an explicit base equal to its own
 * URL. It changes nothing for direct navigation, and it keeps relative URLs a
 * kit builds at runtime (iframe sources, fetches) resolving to sibling package
 * files when a consumer fetches the HTML and embeds it as srcdoc. A document
 * that mentions `<base` anywhere gets none.
 */
export function injectDesignSystemPackageBase(
  html: string,
  designSystemId: string,
  packagePath: string,
): string {
  if (mentionsBaseTag(html)) return html;
  const href = designSystemPackageFileUrl(designSystemId, packagePath)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
  const tag = `<base href="${href}" data-od-design-system-package-base>`;
  const headEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.headOpen);
  if (headEnd >= 0) return html.slice(0, headEnd) + tag + html.slice(headEnd);
  const htmlEnd = findRealTagEnd(html, HTML_TAG_PATTERNS.htmlOpen);
  if (htmlEnd >= 0) return `${html.slice(0, htmlEnd)}<head>${tag}</head>${html.slice(htmlEnd)}`;
  return prependAfterDoctype(html, tag);
}

function rewriteDesignSystemShowcaseAssetUrl(
  rawUrl: string,
  designSystemId: string,
  baseDir: string,
  workspaceQuery?: { workspaceId: string; workspaceMemberId: string } | null,
): string {
  const value = rawUrl.trim();
  if (
    value.length === 0
    || value.startsWith('#')
    // A percent-encoded fragment (`url(%23mask)`, usually inside an inline SVG
    // data URI) names an element, never a package file.
    || /^%23/i.test(value)
    || value.startsWith('/')
    || /^[a-z][a-z0-9+.-]*:/i.test(value)
  ) {
    return rawUrl;
  }

  const match = /^([^?#]+)([?#].*)?$/.exec(value);
  if (!match) return rawUrl;
  const [, rawPath, suffix = ''] = match;
  if (!rawPath) return rawUrl;
  const relativePath = path.posix.normalize(path.posix.join(baseDir, rawPath));
  if (
    relativePath === '.'
    || relativePath.startsWith('../')
    || path.posix.isAbsolute(relativePath)
  ) {
    return rawUrl;
  }

  const staticUrl =
    `/api/design-systems/${encodeURIComponent(designSystemId)}/static`
    + `?path=${encodeURIComponent(relativePath)}`
    + (workspaceQuery
      ? `&workspaceId=${encodeURIComponent(workspaceQuery.workspaceId)}`
        + `&workspaceMemberId=${encodeURIComponent(workspaceQuery.workspaceMemberId)}`
      : '');
  if (suffix.startsWith('?')) return `${staticUrl}&${suffix.slice(1)}`;
  return `${staticUrl}${suffix}`;
}

function designSystemNavigationWorkspaceQuery(
  req: any,
): { workspaceId: string; workspaceMemberId: string } | null {
  const workspaceId =
    typeof req.query?.workspaceId === 'string' ? req.query.workspaceId.trim() : '';
  const workspaceMemberId =
    typeof req.query?.workspaceMemberId === 'string'
      ? req.query.workspaceMemberId.trim()
      : '';
  return workspaceId && workspaceMemberId
    ? { workspaceId, workspaceMemberId }
    : null;
}
