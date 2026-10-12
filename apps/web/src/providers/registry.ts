import { readApiErrorMessage } from '@mish/contracts';
import { readApiErrorBody } from './api-error';
export { createIntakeBatch, listIntakeBatches, getIntakeBatch, putIntakeFile, clearIntakeBatch, attachIntakeBatch, intakeFileDownloadUrl } from './intake';
import type {
  AgencyBuildEvent,
  AgencyBuildForkRequest,
  AgencyBuildForkResponse,
  AgencyBuildListItem,
  AgencyBuildListResponse,
  AgencyBuildRepairResponse,
  AgencyBuildDesignKitRefusalCode,
  AgencyBuildRequest,
  AgencyBuildResponse,
  AgencyBuildSnapshot,
  AgencyFamilyOptionalSection,
  AgencyFamilySectionsResponse,
  AgencyFamilyEffectsResponse,
  AgencyOutputScope,
  DesignSystemWorkspaceResponse,
} from '@mish/contracts';
import {
  parseAgencyFamilyEffectsResponse,
  PUBLIC_FILE_MANUAL_REVOKE_REQUIRED,
  workspaceContextHasTeamIdentity,
  type PublicFileManualRevokeRequiredData,
  type PublicProjectFilePublication,
} from '@mish/contracts';
import {
  parseSectionCatalogResponse,
  type SectionCatalogDirectionOption,
  type SectionCatalogEntry,
  type SectionCatalogSectionKind,
  type SectionCatalogSpineCode,
  type SectionsListResponse,
} from '@mish/contracts/api/section-catalog';
import { boundedRequestErrorCode } from '../analytics/workspace';
import { createConnectorCallbackNonce } from '../runtime/connector-callback-trust';
import type {
  ConnectorAuthConfigPrepareResponse,
  ConnectorDetail,
  ConnectorConnectRequest,
  ConnectorConnectResponse,
  ConnectorDiscoveryResponse,
  ConnectorDetailResponse,
  ConnectorListResponse,
  ConnectorStatusResponse,
  FigmaImportResult,
  ImportGitHubDesignSystemRequest,
  ImportGitHubDesignSystemResponse,
  ImportShadcnDesignSystemRequest,
  ImportShadcnDesignSystemResponse,
  MishGithubLatestReleaseResponse,
  ImportLocalDesignSystemRequest,
  ImportLocalDesignSystemResponse,
  ReplaceProjectWorkingDirResponse,
  ProjectFileTextPreviewResponse,
  ProjectFileResponse,
  ProjectPreviewScopeRenewResponse,
  ProjectPreviewUrlResponse,
  ProjectFileVersion,
  ProjectFileVersionSource,
  ProjectFileVersionResponse,
  ProjectFileVersionsResponse,
  ProjectMediaTasksResponse,
  RestoreProjectFileVersionResponse,
  SocialShareRequest,
  SocialShareResponse,
  WorkspaceCollabContext,
} from '@mish/contracts';
import type {
  AgentInfo,
  AppVersionInfo,
  AppVersionResponse,
  WhatsNewResponse,
  ChatAttachment,
  CodexPetSummary,
  CodexPetsResponse,
  InstallDesignSystemResponse,
  InstallInput,
  InstallSkillRequest,
  InstallSkillResponse,
  SyncCommunityPetsRequest,
  SyncCommunityPetsResponse,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentUpsertRequest,
  CloudflarePagesDeploySelection,
  CloudflarePagesZonesResponse,
  DeployConfigResponse,
  DeployProjectFileResponse,
  DesignSystemDetail,
  DesignSystemFileDetail,
  DesignSystemFileSummary,
  DesignSystemGenerationJob,
  DesignSystemPackageAudit,
  DesignSystemProvenance,
  DesignSystemRevision,
  DesignSystemRevisionJobRequest,
  DesignSystemRevisionStatus,
  DesignSystemSummary,
  DesignSystemTokenContractRebuildJobRequest,
  DesignSystemTokenContractRebuildJobResponse,
  LiveArtifact,
  LiveArtifactRefreshLogEntry,
  LiveArtifactSummary,
  Project,
  ProjectDeploymentsResponse,
  PromptTemplateDetail,
  PromptTemplateSummary,
  ProjectFile,
  ProjectFolder,
  RenameProjectFileResponse,
  SkillDetail,
  SkillSummary,
  UpdateDeployConfigRequest,
} from '../types';
import type { ArtifactManifest } from '../artifacts/types';
import { GENERIC_DEPLOY_ENVELOPE_CODES } from '../analytics/deploy-error-code';
import {
  isMishHostAvailable,
  openHostExternalUrl,
} from '@mish/host';
import {
  coalescedGet,
  evictCoalescedGet,
} from '../lib/coalesced-get';
import {
  evictSharedCancellableGet,
  forceSharedCancellableGet,
  sharedCancellableGet,
} from '../lib/shared-cancellable-get';
import { workspaceProjectHeaders } from '../state/projects';
import { sharedTransferQueue } from '../runtime/intake/transfer-queue';
import {
  appendResourceQuery,
  workspaceIdentityCacheKey,
  workspaceResourceUrl,
  workspaceAccountScopedCacheKey,
  currentWorkspaceAccountGeneration,
} from '../collab/workspace-identity';
import { PublicFilePublishError } from '../collab/public-file-publish';

/**
 * `coalescedGet` ttl for reads that may only JOIN a request still on the wire.
 *
 * Zero means nothing is retained once the read settles: a caller that starts
 * after the previous one finished always issues its own request. That is the
 * whole safety argument — such a read can never hand anyone a body it did not
 * itself trigger, so it cannot serve stale state. It can only remove a request
 * the browser would have opened *concurrently* with an identical one.
 *
 * Why that is worth doing: several of these endpoints are read by one effect
 * that legitimately runs twice (React StrictMode replays mount effects in dev;
 * a settling dependency replays them in prod), and the replay always lands
 * while the first request is still open. Measured on one cold conversation
 * open: /api/editors ×2 1ms apart, /deployments ×2 6ms apart, /folders ×2 2ms
 * apart, /api/health ×2 4ms apart. The daemon answers each in 3-7ms, so the
 * cost is not server time — it is a slot in the browser's ~6-connection budget
 * for this origin, which the same page is already oversubscribing.
 *
 * Use this ttl, not a positive one, unless the endpoint has an explicit reason
 * a settled body stays true for a while.
 */
const IN_FLIGHT_SHARE_ONLY_MS = 0;

export const DEFAULT_DEPLOY_PROVIDER_ID = 'vercel-self';
export const CLOUDFLARE_PAGES_PROVIDER_ID = 'cloudflare-pages';
export const DEPLOY_PROVIDER_IDS = [
  DEFAULT_DEPLOY_PROVIDER_ID,
  CLOUDFLARE_PAGES_PROVIDER_ID,
] as const;

export type WebDeployProviderId = (typeof DEPLOY_PROVIDER_IDS)[number];

export type WebDeployConfigResponse = DeployConfigResponse;
export type WebUpdateDeployConfigRequest = UpdateDeployConfigRequest;
export type WebDeploymentInfo = ProjectDeploymentsResponse['deployments'][number];
export type WebDeployProjectFileResponse = DeployProjectFileResponse;
export type WebCloudflarePagesDeploySelection = CloudflarePagesDeploySelection;
export type WebCloudflarePagesZonesResponse = CloudflarePagesZonesResponse;

export type WebPublicProjectFileResponse = PublicProjectFilePublication;

export function isDeployProviderId(value: unknown): value is WebDeployProviderId {
  return typeof value === 'string' && (DEPLOY_PROVIDER_IDS as readonly string[]).includes(value);
}

function deployProviderQuery(providerId?: WebDeployProviderId): string {
  return providerId ? `?providerId=${encodeURIComponent(providerId)}` : '';
}

export async function fetchAgents(options?: { throwOnError?: boolean }): Promise<AgentInfo[]> {
  try {
    const resp = await fetch('/api/agents', { cache: 'no-store' });
    if (!resp.ok) {
      if (options?.throwOnError) throw new Error(`agents ${resp.status}`);
      return [];
    }
    const json = (await resp.json()) as { agents: AgentInfo[] };
    return json.agents ?? [];
  } catch (err) {
    if (options?.throwOnError) throw err;
    return [];
  }
}

// Incremental agent detection over Server-Sent Events: `onAgent` fires once
// per agent the moment its probe settles (completion order, not registry
// order), so a caller can paint cards as they resolve instead of waiting for
// the slowest CLI. Resolves with every agent collected once the stream's
// terminal `done` event arrives. This is additive: callers that don't need
// incremental delivery keep using `fetchAgents()` (whose batch probe is now
// parallelized per-agent and so is itself faster). Pass an AbortSignal to
// cancel the underlying request.
export async function fetchAgentsStream(args: {
  onAgent: (agent: AgentInfo) => void;
  signal?: AbortSignal;
}): Promise<AgentInfo[]> {
  const { onAgent, signal } = args;
  const resp = await fetch('/api/agents?stream=1', {
    cache: 'no-store',
    headers: { Accept: 'text/event-stream' },
    ...(signal ? { signal } : {}),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`agents stream ${resp.status}`);
  }
  const collected: AgentInfo[] = [];
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done = false;
  const errorMessageFromData = (data: string): string => {
    if (!data.trim()) return 'agents stream error';
    try {
      const parsed = JSON.parse(data) as { error?: unknown; message?: unknown };
      const message = readApiErrorMessage(parsed.error, typeof parsed.message === 'string' ? parsed.message : '');
      if (typeof message === 'string' && message.trim()) return message;
    } catch {
      // Fall through to the raw data string below.
    }
    return data;
  };

  const handleEvent = (rawEvent: string) => {
    // Each SSE record is `event: <name>\ndata: <json>`; we act on `agent`
    // (one AgentInfo), `error` (terminal failure), and `done` (terminal
    // success). Unknown events are ignored so the protocol can grow without
    // breaking older clients.
    let eventName = 'message';
    const dataLines: string[] = [];
    for (const line of rawEvent.split('\n')) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    const data = dataLines.join('\n');
    if (eventName === 'done') {
      done = true;
      return;
    }
    if (eventName === 'error') {
      throw new Error(errorMessageFromData(data));
    }
    if (eventName === 'agent' && data) {
      try {
        const agent = JSON.parse(data) as AgentInfo;
        collected.push(agent);
        onAgent(agent);
      } catch {
        // Ignore a malformed record rather than aborting the whole stream.
      }
    }
  };

  try {
    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      // SSE records are separated by a blank line ("\n\n").
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        if (rawEvent.trim().length > 0) handleEvent(rawEvent);
        if (done) break;
      }
    }
    if (!done && buffer.trim().length > 0) {
      handleEvent(buffer);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Reader may already be closed; nothing to do.
    }
  }
  if (!done) {
    throw new Error('agents stream ended before done');
  }
  return collected;
}

// `workspaceContext`, when present, attaches the same workspace identity
// headers project/plugin reads already carry (`workspaceProjectHeaders`) so
// the daemon's `GET /api/skills` can apply its workspace-scoped filter
// (skills.ts's `skillVisibleFromWorkspace`, mirroring `listInstalledPlugins`'s
// one-way "unclaimed visible everywhere, claimed elsewhere hidden" rule).
// Omit for callers that want the unfiltered, pre-workspace-isolation list.
export async function fetchSkills(
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillSummary[]> {
  try {
    const resp = await fetch(
      '/api/skills',
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { skills: SkillSummary[] };
    return json.skills ?? [];
  } catch {
    return [];
  }
}

export async function fetchProjectMediaTasks(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectMediaTasksResponse> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/media/tasks?includeDone=1`,
    {
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    },
  );
  if (!resp.ok) throw new Error(`media tasks ${resp.status}`);
  return await resp.json() as ProjectMediaTasksResponse;
}

// Design templates — the rendering catalogue (decks, prototypes, image/
// video/audio templates). Same SkillSummary shape as functional skills,
// fetched from a separate registry root so the EntryView Templates tab
// and Settings → Skills surface stay decoupled. See
// specs/current/skills-and-design-templates.md.
export async function fetchDesignTemplates(): Promise<SkillSummary[]> {
  try {
    const resp = await fetch('/api/design-templates');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { designTemplates: SkillSummary[] };
    return json.designTemplates ?? [];
  } catch {
    return [];
  }
}

export async function fetchDesignTemplate(id: string): Promise<SkillDetail | null> {
  try {
    const resp = await fetch(`/api/design-templates/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as SkillDetail;
  } catch {
    return null;
  }
}

// Pets packaged by the Codex `hatch-pet` skill — surfaced so the web
// pet settings can offer one-click adoption right after the agent run
// finishes. Returns an empty list (not an error) when the registry
// folder is missing so the "Recently hatched" UI can simply render an
// empty state.
export async function fetchCodexPets(): Promise<CodexPetsResponse> {
  try {
    const resp = await fetch('/api/codex-pets');
    if (!resp.ok) return { pets: [], rootDir: '' };
    return (await resp.json()) as CodexPetsResponse;
  } catch {
    return { pets: [], rootDir: '' };
  }
}

// One-click trigger for the daemon-side port of `sync-community-pets`.
// Always resolves with a summary (even when the daemon errored) so the
// caller can render a status line without having to wrap in try/catch
// on every keystroke.
export async function syncCommunityPets(
  input?: SyncCommunityPetsRequest,
): Promise<SyncCommunityPetsResponse & { error?: string }> {
  try {
    const resp = await fetch('/api/codex-pets/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input ?? {}),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: string }
        | null;
      return {
        wrote: 0,
        skipped: 0,
        failed: 0,
        total: 0,
        rootDir: '',
        errors: [],
        error: readApiErrorMessage(payload?.error, `Sync failed (${resp.status})`),
      };
    }
    return (await resp.json()) as SyncCommunityPetsResponse;
  } catch (err) {
    return {
      wrote: 0,
      skipped: 0,
      failed: 0,
      total: 0,
      rootDir: '',
      errors: [],
      error: err instanceof Error ? err.message : 'Sync request failed',
    };
  }
}

export function codexPetSpritesheetUrl(pet: CodexPetSummary): string {
  // The daemon stamps an absolute path-prefix in `spritesheetUrl`; if
  // that prefix is empty (default), it is already a same-origin path
  // we can hand to <img src> or fetch() as-is.
  return pet.spritesheetUrl;
}

// Body for POST /api/skills/import. Mirrors the contracts type but is
// repeated here so the registry module is self-describing for callers.
export interface SkillImportInput {
  name: string;
  description?: string;
  body: string;
  triggers?: string[];
}

export interface SkillImportError {
  code?: string;
  message: string;
  status?: number;
}

async function readSkillOperationError(resp: Response): Promise<SkillImportError> {
  try {
    const payload = await resp.json() as {
      error?: string | { code?: unknown; message?: unknown };
      code?: unknown;
      message?: unknown;
    };
    const envelope = payload.error && typeof payload.error === 'object'
      ? payload.error
      : null;
    const rawCode = envelope?.code ?? payload.code;
    const boundedCode = boundedRequestErrorCode(rawCode);
    const rawMessage = envelope?.message
      ?? payload.message
      ?? (typeof payload.error === 'string' ? payload.error : undefined);
    return {
      message: typeof rawMessage === 'string' && rawMessage.trim()
        ? rawMessage
        : `Request failed (${resp.status}).`,
      ...(boundedCode ? { code: boundedCode } : {}),
      status: resp.status,
    };
  } catch {
    return { message: `Request failed (${resp.status}).`, status: resp.status };
  }
}

// `workspaceContext`, when present, stamps the imported skill with the
// acting workspace (see `fetchSkills` above) so the daemon's
// `bindImportedSkillToWorkspace` (routes/static-resource.ts) has a workspace
// identity to bind against. Omit for callers that intentionally leave the
// skill unclaimed (visible everywhere).
export async function importSkill(
  input: SkillImportInput,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ skill: SkillSummary } | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/skills/import', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      return { error: await readSkillOperationError(resp) };
    }
    return (await resp.json()) as { skill: SkillSummary };
  } catch (err) {
    return {
      error: {
        code: 'network_error',
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

// Update an existing skill's body. For built-in skills the daemon writes
// a "shadow" copy under the user-skills root; the next listSkills() pass
// surfaces it in place of the bundled copy. The id passed here must
// match the SKILL.md frontmatter `name` — the daemon refuses cross-id
// renames so callers can drop "edit" into the same surface they use for
// "edit my own draft".
export interface SkillUpdateInput {
  name?: string;
  description?: string;
  body: string;
  triggers?: string[];
}

// `workspaceContext`, when present, proves the caller's workspace membership
// against the daemon's `enforceWorkspaceResourceMutation` gate (see
// `fetchSkills` above) — required once the skill being edited carries a
// `workspace_resources` binding row; a no-op for an unbound (legacy) skill.
export async function updateSkill(
  id: string,
  input: SkillUpdateInput,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ skill: SkillSummary } | { error: SkillImportError }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: SkillImportError }
        | null;
      return {
        error: {
          code: payload?.error?.code,
          message:
            payload?.error?.message ?? `Update failed (${resp.status}).`,
        },
      };
    }
    return (await resp.json()) as { skill: SkillSummary };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Update request failed.',
      },
    };
  }
}

export interface SkillFileEntry {
  path: string;
  kind: 'file' | 'directory';
  size: number | null;
}

export async function fetchSkillFiles(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillFileEntry[]> {
  try {
    const resp = await fetch(
      `/api/skills/${encodeURIComponent(id)}/files`,
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: SkillFileEntry[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}

// `workspaceContext`, when present, proves the caller's workspace membership
// against the daemon's `enforceWorkspaceResourceMutation` gate (see
// `fetchSkills` above) — required once the skill being deleted carries a
// `workspace_resources` binding row (installed/imported by someone else, or
// pulled in from a team share); a no-op for an unbound (legacy) skill.
export async function deleteSkill(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ ok: true } | { error: SkillImportError }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: SkillImportError }
        | null;
      return {
        error: {
          code: payload?.error?.code,
          message: payload?.error?.message ?? `Delete failed (${resp.status}).`,
        },
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Delete request failed.',
      },
    };
  }
}

export async function fetchSkill(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillDetail | null> {
  try {
    const resp = await fetch(
      `/api/skills/${encodeURIComponent(id)}`,
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as SkillDetail;
  } catch {
    return null;
  }
}

export async function fetchDesignSystems(
  workspaceContext?: WorkspaceCollabContext | null,
  options?: FetchDesignSystemsOptions,
): Promise<DesignSystemSummary[]> {
  const result = await fetchDesignSystemsResult(workspaceContext, options);
  return result.ok ? result.designSystems : [];
}

// Discriminated-union variant: surfaces the fetch outcome instead of
// collapsing a network/HTTP failure into an empty array. The mid-chat
// design-system picker uses this so it can render a load-failure state
// instead of silently showing an empty catalog, which would otherwise
// be indistinguishable from "registry truly has no systems."
export type DesignSystemsResult =
  | { ok: true; designSystems: DesignSystemSummary[] }
  | { ok: false };

export interface FetchDesignSystemsOptions {
  /**
   * A realtime mutation invalidated the Team index. Every forced call starts
   * its own authoritative read; distinct mutations must never join an older
   * in-flight snapshot merely because they arrived inside one burst window.
   */
  forceTeamMaterialization?: boolean;
  /**
   * Exact Team ids returned by a workspace-scoped Team-index read that just
   * completed in the caller. Reuse that witness while reading the unified
   * catalog instead of issuing a duplicate `/team` materialization request.
   *
   * Supplying it also declares the catalog read itself authoritative: the only
   * caller passes it when its fresh `/team` witness disagrees with the rows it
   * holds, or straight after a share/unshare. So the catalog read starts fresh
   * rather than joining one issued before that change.
   */
  materializedTeamIds?: readonly string[];
}

async function materializeTeamDesignSystems(
  workspaceContext: WorkspaceCollabContext | null | undefined,
  accountGeneration: number,
  options?: FetchDesignSystemsOptions,
): Promise<ReadonlySet<string>> {
  if (!workspaceContext || !workspaceContextHasTeamIdentity(workspaceContext)) {
    return new Set();
  }
  if (options?.materializedTeamIds) {
    return new Set(options.materializedTeamIds);
  }

  // Team systems live in a workspace-scoped materialization directory. Prime
  // that directory before reading the unified catalog so Home and every other
  // picker see team shares even when the user has never opened the Design
  // Systems management tab.
  //
  // Never replace these explicit identity headers with a daemon/Vela "active
  // workspace" lookup. One account can have multiple clients open in different
  // Workspaces; a backend-global active Workspace would let either client
  // retarget the other's catalog request.
  try {
    // Account-scoped for the same reason the catalog key is, and with the SAME
    // captured generation: this witness decorates the catalog rows, so a `/team`
    // request still in flight across a sign-out/sign-in must not be joined by a
    // post-boundary reader — that would stamp the new account's rows with the
    // previous account's Team-share flags.
    const cacheKey = `design-system-team-materialization:`
      + `${workspaceAccountScopedCacheKey(workspaceContext, accountGeneration)}`;
    const readTeamIndex = async () => {
      const response = await fetch('/api/workspace/design-systems/team', {
        cache: 'no-store',
        headers: workspaceProjectHeaders(workspaceContext),
      });
      if (!response.ok) {
        throw new Error(`design-systems-team ${response.status}`);
      }
      const body = (await response.json()) as { ids?: unknown };
      return new Set(
        Array.isArray(body.ids)
          ? body.ids.filter((id): id is string => typeof id === 'string')
          : [],
      );
    };
    if (options?.forceTeamMaterialization) evictCoalescedGet(cacheKey);
    return await coalescedGet(cacheKey, readTeamIndex);
  } catch {
    // Keep personal/built-in systems usable while the remote team index is
    // temporarily unavailable. The scoped catalog request below remains the
    // authority and still fails closed for an invalid Workspace identity.
    return new Set();
  }
}

/**
 * Read the unified catalog once per burst of identical concurrent readers.
 *
 * Several independent surfaces want this catalog on the same launch or
 * navigation pass: bootstrap, the Workspace-identity effect, the home-route
 * effect, plus LibrarySection, DesignSystemsSection and DesignSystemSwitchPicker
 * as they mount. None of them can drop its read — each owns its own latest-wins
 * bookkeeping and must settle its own loading state — but on the wire they are
 * one request, and the browser's ~6-connections-per-host cap makes the extra
 * copies queue behind everything else the launch is already fetching.
 *
 * SINGLE-FLIGHT ONLY (ttl 0, no shared settled result). Some of those call
 * sites exist precisely to observe a change that just happened out of band:
 * returning home re-reads so an in-project brand extraction appears, and a
 * `forceTeamMaterialization` caller is announcing a realtime mutation. Sharing
 * a settled answer — for even a second — would hand exactly those reads the
 * state they were fired to replace.
 */
const CATALOG_SINGLE_FLIGHT_ONLY_MS = 0;

/**
 * Bumped by every successful LOCAL catalog mutation, and part of the read key.
 *
 * `ttl = 0` stops a settled result from being reused; it does not stop a new
 * caller from JOINING a request that is still in flight. The callers that follow
 * a mutation are exactly the ones that must not join: `DesignSystemsTab` awaits
 * `deleteDesignSystemDraft` / `updateDesignSystemDraft` and then calls its plain
 * `onSystemsRefresh()` — no `forceTeamMaterialization`, because nothing remote
 * changed — and the daemon answers `/api/design-systems` from a snapshot taken
 * when the request arrived. Joining a pre-mutation GET would leave the deleted
 * system on screen, or show the old published/draft status.
 *
 * The rule, stated so it stays checkable: every export that SYNCHRONOUSLY changes
 * catalog membership or a summary field bumps this on success — create, update,
 * update-revision-status, delete, uninstall, the three imports, install, and
 * asset sync.
 *
 * Two groups deliberately do not, and should not be "fixed" later:
 *   - the job starters (`startDesignSystemGenerationJob`,
 *     `startDesignSystemRevisionJob`,
 *     `startDesignSystemTokenContractRebuildJob`) — nothing has changed when they
 *     return; the finished job arrives through the invalidation path;
 *   - `ensureDesignSystemWorkspace` — it materializes an editing workspace and
 *     leaves the catalog rows alone.
 *
 * `forceTeamMaterialization` also stays as it is: that is the REMOTE
 * (team-invalidation) signal, this is the local one.
 */
let designSystemCatalogMutationGeneration = 0;

function noteDesignSystemCatalogMutation(): void {
  designSystemCatalogMutationGeneration += 1;
}

async function readDesignSystemCatalog(
  workspaceContext: WorkspaceCollabContext | null | undefined,
  accountGeneration: number,
  options?: FetchDesignSystemsOptions,
): Promise<DesignSystemSummary[]> {
  // Keyed by the exact identity the request will carry, PLUS the account
  // boundary it was captured under — the same two-part identity the app uses
  // for this catalog and the team-project catalog carries as its request
  // generation. `/api/design-systems` is fail-closed on a missing scope, so a
  // headerless read is a different, smaller catalog and never an answer a
  // Workspace-scoped read may join. The generation is load-bearing on its own:
  // a sign-out/sign-in cycle can leave every context field identical while the
  // authority behind them has changed, and ttl 0 would not catch it — it stops
  // settled-result reuse, not a post-boundary reader joining a request issued
  // before the boundary.
  const cacheKey = `design-system-catalog:${designSystemCatalogMutationGeneration}`
    + `:${workspaceAccountScopedCacheKey(workspaceContext, accountGeneration)}`;
  // Same rule as the Team index above: a forced call is an authoritative read
  // for one mutation and must never join a snapshot issued before it.
  //
  // `materializedTeamIds` counts too, and it is not obvious from the name.
  // `DesignSystemsTab.refreshTeamShared` is the only caller that supplies it,
  // and it does so exactly when the fresh `/team` witness disagrees with the
  // catalog it holds — or immediately after a share/unshare. Carrying that
  // witness therefore means "what I hold is out of date"; joining a catalog GET
  // issued before the share would omit the newly shared system or keep a
  // retired mirror on screen. Routine mounts do not pass it, so ordinary
  // readers still collapse onto the shared key.
  if (options?.forceTeamMaterialization || options?.materializedTeamIds) {
    evictCoalescedGet(cacheKey);
  }
  return coalescedGet(cacheKey, async () => {
    const resp = await fetch('/api/design-systems', {
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    // Throw rather than return a sentinel: `coalescedGet` never caches a
    // failure, so the next reader retries instead of joining a dead entry.
    if (!resp.ok) throw new Error(`design-systems ${resp.status}`);
    const json = (await resp.json()) as { designSystems?: DesignSystemSummary[] };
    return json.designSystems ?? [];
  }, CATALOG_SINGLE_FLIGHT_ONLY_MS);
}

export async function fetchDesignSystemsResult(
  workspaceContext?: WorkspaceCollabContext | null,
  options?: FetchDesignSystemsOptions,
): Promise<DesignSystemsResult> {
  // Capture the account boundary ONCE. The Team witness and the catalog are two
  // awaited reads; letting each resolve the generation at its own call time lets
  // them straddle a sign-out/sign-in, which would decorate post-boundary rows
  // with pre-boundary Team-share flags. Keyed as of one boundary, the pair is at
  // least internally consistent.
  //
  // What this does NOT do, stated because the opposite is easy to assume: it
  // does not stop a late result from being COMMITTED after a boundary. Only
  // `App`'s `refreshDesignSystems` re-checks the generation after awaiting;
  // `DesignSystemSwitchPicker`, `DesignSystemsSection` and `LibrarySection` key
  // their effects on workspace identity alone, and the Workspace hook
  // deliberately retains the old context while an identity change is pending, so
  // those fields can be unchanged across the boundary. That exposure predates
  // coalescing — each of those readers had it when every call made its own
  // request — and closing it means giving those three readers a generation
  // guard, which is its own change.
  const accountGeneration = currentWorkspaceAccountGeneration();
  try {
    const teamSharedIds = await materializeTeamDesignSystems(
      workspaceContext,
      accountGeneration,
      options,
    );
    const designSystems = await readDesignSystemCatalog(
      workspaceContext,
      accountGeneration,
      options,
    );
    return {
      ok: true,
      // Mapped per caller: readers sharing one catalog read still resolve the
      // Team-shared flag against their own Team-index witness.
      designSystems: designSystems.map((system) => (
        teamSharedIds.has(system.id)
          ? { ...system, teamShared: true }
          : system
      )),
    };
  } catch {
    return { ok: false };
  }
}

export async function fetchDesignSystem(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemDetail | null> {
  try {
    // no-store so edits made elsewhere (the in-project Design System tab) are
    // reflected the next time the manager / a consumer re-reads the system.
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!resp.ok) return null;
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

export async function fetchDesignSystemFiles(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemFileSummary[]> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/files`,
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { files: DesignSystemFileSummary[] };
    return json.files ?? [];
  } catch {
    return [];
  }
}

export async function fetchDesignSystemFile(
  id: string,
  filePath: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemFileDetail | null> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/file?path=${encodeURIComponent(filePath)}`,
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { file?: DesignSystemFileDetail };
    return json.file ?? null;
  } catch {
    return null;
  }
}

export async function ensureDesignSystemWorkspace(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemWorkspaceResponse | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/workspace`, {
      method: 'POST',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DesignSystemWorkspaceResponse;
  } catch {
    return null;
  }
}

function parseDesignSystemDetail(json: unknown): DesignSystemDetail | null {
  if (!json || typeof json !== 'object') return null;
  const wrapper = json as { designSystem?: DesignSystemDetail };
  return wrapper.designSystem ?? (json as DesignSystemDetail);
}

export interface DesignSystemDraftInput {
  title: string;
  summary?: string;
  category?: string;
  surface?: 'web' | 'image' | 'video' | 'audio';
  status?: 'draft' | 'published';
  artifactMode?: 'generated' | 'agent-managed';
  body?: string;
  sourceNotes?: string;
  provenance?: DesignSystemProvenance;
}

export async function createDesignSystemDraft(
  input: DesignSystemDraftInput,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemDetail | null> {
  try {
    const resp = await fetch('/api/design-systems', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    noteDesignSystemCatalogMutation();
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

export async function startDesignSystemGenerationJob(
  input: DesignSystemDraftInput,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const resp = await fetch('/api/design-systems/generation-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function fetchDesignSystemGenerationJob(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const url = `/api/design-systems/generation-jobs/${encodeURIComponent(id)}`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function fetchProjectDesignSystemPackageAudit(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemPackageAudit | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/design-system-package-audit`,
      {
        cache: 'no-store',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { audit?: DesignSystemPackageAudit };
    return json.audit ?? null;
  } catch {
    return null;
  }
}

export async function fetchDesignSystemRevisions(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemRevision[]> {
  try {
    const url = `/api/design-systems/${encodeURIComponent(id)}/revisions`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) return [];
    const json = (await resp.json()) as { revisions?: DesignSystemRevision[] };
    return json.revisions ?? [];
  } catch {
    return [];
  }
}

export async function updateDesignSystemRevisionStatus(
  id: string,
  revisionId: string,
  status: Extract<DesignSystemRevisionStatus, 'accepted' | 'rejected'>,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemRevision | null> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}/revisions/${encodeURIComponent(revisionId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify({ status }),
      },
    );
    if (!resp.ok) return null;
    noteDesignSystemCatalogMutation();
    const json = (await resp.json()) as { revision?: DesignSystemRevision };
    return json.revision ?? null;
  } catch {
    return null;
  }
}

export async function startDesignSystemRevisionJob(
  id: string,
  input: DesignSystemRevisionJobRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemGenerationJob | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/revision-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { job?: DesignSystemGenerationJob };
    return json.job ?? null;
  } catch {
    return null;
  }
}

export async function startDesignSystemTokenContractRebuildJob(
  id: string,
  input: DesignSystemTokenContractRebuildJobRequest = {},
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemTokenContractRebuildJobResponse | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/token-contract/rebuild-jobs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as DesignSystemTokenContractRebuildJobResponse;
  } catch {
    return null;
  }
}

export async function updateDesignSystemDraft(
  id: string,
  input: Partial<DesignSystemDraftInput>,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemDetail | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return null;
    noteDesignSystemCatalogMutation();
    return parseDesignSystemDetail(await resp.json());
  } catch {
    return null;
  }
}

// Signal-only trigger for the daemon-side asset sync (spec 04 §9.3,
// recvqb1t4FrckM): fires when the design-system chat's agent writes real
// files under `assets/` in the workspace project, so the canonical
// design-system directory — the only thing team-share/download/showcase
// ever read from — stops shipping a stale placeholder logo. No file bytes
// cross the browser: the daemon locates the workspace project itself and
// copies file contents straight through on its own side of the data-
// directory boundary. See `workspaceProjectHeaders` — this is a mutating
// write against a resource `canMutateUserDesignSystem` gates the same way
// PATCH/DELETE are gated, so the workspace identity headers must ride along.
export async function syncDesignSystemAssetsFromWorkspace(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ synced: string[] } | null> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}/sync-assets`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
    });
    if (!resp.ok) return null;
    noteDesignSystemCatalogMutation();
    return (await resp.json()) as { synced: string[] };
  } catch {
    return null;
  }
}

export class DesignSystemDeleteError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'DesignSystemDeleteError';
  }
}

export async function deleteDesignSystemDraft(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/design-systems/${encodeURIComponent(id)}`,
      {
        method: 'DELETE',
        ...(workspaceContext
          ? { headers: workspaceProjectHeaders(workspaceContext) }
          : {}),
      },
    );
    if (!resp.ok && resp.status === 403) {
      const errorBody = await readApiErrorBody(resp);
      const code = errorBody.code
        ?? (/^[A-Z][A-Z0-9_]+$/.test(errorBody.message) ? errorBody.message : undefined);
      throw new DesignSystemDeleteError(errorBody.message, resp.status, code);
    }
    if (resp.ok) noteDesignSystemCatalogMutation();
    return resp.ok;
  } catch (error) {
    if (error instanceof DesignSystemDeleteError) throw error;
    return false;
  }
}

export async function importLocalDesignSystem(
  input: ImportLocalDesignSystemRequest,
): Promise<ImportLocalDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/local', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      return { error: await readImportError(resp) };
    }
    noteDesignSystemCatalogMutation();
    return (await resp.json()) as ImportLocalDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

export async function importGitHubDesignSystem(
  input: ImportGitHubDesignSystemRequest,
): Promise<ImportGitHubDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { error: await readImportError(resp) };
    noteDesignSystemCatalogMutation();
    return (await resp.json()) as ImportGitHubDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

export async function importShadcnDesignSystem(
  input: ImportShadcnDesignSystemRequest,
): Promise<ImportShadcnDesignSystemResponse | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/design-systems/import/shadcn', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { error: await readImportError(resp) };
    noteDesignSystemCatalogMutation();
    return (await resp.json()) as ImportShadcnDesignSystemResponse;
  } catch (err) {
    return {
      error: {
        message: err instanceof Error ? err.message : 'Import request failed.',
      },
    };
  }
}

async function readImportError(resp: Response): Promise<SkillImportError> {
  const payload = (await resp.json().catch(() => null)) as
    | { error?: SkillImportError | string; message?: string }
    | null;
  const error = payload?.error;
  if (typeof error === 'object' && error !== null) return error;
  return {
    message:
      typeof error === 'string'
        ? error
        : payload?.message ?? `Import failed (${resp.status}).`,
  };
}

export async function fetchPromptTemplates(): Promise<PromptTemplateSummary[]> {
  try {
    const resp = await fetch('/api/prompt-templates');
    if (!resp.ok) return [];
    const json = (await resp.json()) as { promptTemplates: PromptTemplateSummary[] };
    return json.promptTemplates ?? [];
  } catch {
    return [];
  }
}

export async function fetchPromptTemplate(
  surface: 'image' | 'video',
  id: string,
): Promise<PromptTemplateDetail | null> {
  try {
    const resp = await fetch(
      `/api/prompt-templates/${encodeURIComponent(surface)}/${encodeURIComponent(id)}`,
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { promptTemplate: PromptTemplateDetail };
    return json.promptTemplate ?? null;
  } catch {
    return null;
  }
}

export async function daemonIsLive(): Promise<boolean> {
  return coalescedGet(
    'daemon-health',
    async () => {
      try {
        const resp = await fetch('/api/health');
        return resp.ok;
      } catch {
        return false;
      }
    },
    IN_FLIGHT_SHARE_ONLY_MS,
  );
}

export async function fetchConnectors(): Promise<ConnectorDetail[]> {
  try {
    const resp = await fetch('/api/connectors');
    if (!resp.ok) return [];
    const json = (await resp.json()) as ConnectorListResponse;
    return json.connectors ?? [];
  } catch {
    return [];
  }
}

export async function fetchConnectorStatuses(options?: {
  signal?: AbortSignal;
}): Promise<ConnectorStatusResponse['statuses']> {
  try {
    const resp = await fetch('/api/connectors/status', { signal: options?.signal });
    if (!resp.ok) return {};
    const json = (await resp.json()) as ConnectorStatusResponse;
    return json.statuses ?? {};
  } catch {
    return {};
  }
}

let connectorDiscoveryCache: ConnectorDetail[] | null = null;
let connectorDiscoveryPromise: Promise<ConnectorDetail[]> | null = null;

export async function fetchConnectorDiscovery(options: { refresh?: boolean } = {}): Promise<ConnectorDetail[]> {
  if (options.refresh) {
    connectorDiscoveryCache = null;
    connectorDiscoveryPromise = null;
  }
  if (connectorDiscoveryCache && !options.refresh) return connectorDiscoveryCache;
  if (connectorDiscoveryPromise && !options.refresh) return connectorDiscoveryPromise;

  const promise = (async () => {
    try {
      const params = options.refresh ? '?refresh=true' : '';
      const resp = await fetch(`/api/connectors/discovery${params}`);
      if (!resp.ok) return [];
      const json = (await resp.json()) as ConnectorDiscoveryResponse;
      const connectors = json.connectors ?? [];
      connectorDiscoveryCache = connectors;
      return connectors;
    } catch {
      return [];
    } finally {
      connectorDiscoveryPromise = null;
    }
  })();
  connectorDiscoveryPromise = promise;
  return promise;
}

export async function fetchConnectorDetail(
  connectorId: string,
  options: { hydrateTools?: boolean; toolsLimit?: number; toolsCursor?: string } = {},
): Promise<ConnectorDetail | null> {
  try {
    const params = new URLSearchParams();
    if (options.hydrateTools) params.set('hydrateTools', 'true');
    if (options.toolsLimit !== undefined) params.set('toolsLimit', String(options.toolsLimit));
    if (options.toolsCursor) params.set('toolsCursor', options.toolsCursor);
    const query = params.toString();
    const resp = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}${query ? `?${query}` : ''}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as ConnectorDetailResponse;
    return json.connector ?? null;
  } catch {
    return null;
  }
}

export interface ConnectorActionResult {
  connector: ConnectorDetail | null;
  auth?: ConnectorConnectResponse['auth'];
  error?: string;
}

function popupBlockedMessage(): string {
  return 'Popup blocked. Allow popups for Mishh Mashh and try again.';
}

export async function openExternalUrl(url: string): Promise<boolean> {
  const bridgedUrl = await bridgeFirstPartyUrl(url);
  const targetUrl = bridgedUrl ?? url;
  if (isMishHostAvailable()) {
    const opened = await openHostExternalUrl(targetUrl);
    if (opened.ok) return true;
  }
  try {
    const resp = await fetch('/api/system/open-external', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: targetUrl }),
    });
    if (resp.ok) {
      const json = (await resp.json().catch(() => null)) as { ok?: unknown } | null;
      if (json?.ok === true) return true;
    }
  } catch {
    // Fall through to a new-tab open below.
  }
  // Never navigate the app window away; only open http(s) URLs in a new tab.
  try {
    const parsed = new URL(targetUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return window.open(parsed.toString(), '_blank', 'noopener,noreferrer') !== null;
  } catch {
    return false;
  }
}

async function bridgeFirstPartyUrl(url: string): Promise<string | null> {
  try {
    const target = new URL(url);
    if (!['mish.invalid', 'www.mish.invalid', 'staging.mish.invalid'].includes(target.hostname)) return null;
    const resp = await fetch('/api/attribution/bridge-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: target.toString() }),
    });
    if (!resp.ok) return null;
    const body = await resp.json() as { url?: unknown };
    return typeof body.url === 'string' ? body.url : null;
  } catch {
    return null;
  }
}

async function decodeConnectorError(resp: Response): Promise<string> {
  try {
    const payload = (await resp.json()) as { error?: { message?: string } } | null;
    return payload?.error?.message?.trim() || `Connector request failed (${resp.status})`;
  } catch {
    return `Connector request failed (${resp.status})`;
  }
}

export async function connectConnector(connectorId: string): Promise<ConnectorActionResult> {
  let authWindow: Window | null = null;
  const useExternalBrowser = isMishHostAvailable();
  try {
    if (!useExternalBrowser) {
      authWindow = window.open('about:blank', '_blank');
      renderConnectorAuthLoading(authWindow, {
        title: 'Initializing auth config…',
        body: 'Creating or reusing the Composio auth configuration for this app. This can take a moment the first time.',
      });
    }
    const prepare = await prepareConnectorAuthConfig(connectorId);
    if (prepare.status !== 'ready') {
      renderConnectorAuthError(authWindow, prepare.message);
      return { connector: null, error: prepare.message };
    }
    renderConnectorAuthLoading(authWindow, {
      title: 'Opening authorization…',
      body: 'The auth config is ready. Preparing the provider authorization page.',
    });
    // The callback page renders sandboxed (opaque origin); it echoes this
    // nonce so the opener can trust its postMessage.
    const connectRequest: ConnectorConnectRequest = { callbackNonce: createConnectorCallbackNonce() };
    const resp = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}/connect`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(connectRequest),
    });
    if (!resp.ok) {
      const error = await decodeConnectorError(resp);
      renderConnectorAuthError(authWindow, error);
      return { connector: null, error };
    }
    const json = (await resp.json()) as ConnectorConnectResponse;
    if (json.auth?.kind === 'redirect_required' && json.auth.redirectUrl) {
      if (useExternalBrowser) {
        const opened = await openHostExternalUrl(json.auth.redirectUrl);
        if (!opened.ok) {
          return {
            connector: json.connector ?? null,
            auth: json.auth,
            error: popupBlockedMessage(),
          };
        }
      } else if (authWindow) {
        openConnectorAuthRedirect(authWindow, json.auth.redirectUrl);
      } else {
        // The embedded browser can block even the synchronous placeholder
        // popup. Ask the local daemon to open the system browser; if that
        // route is unavailable, openExternalUrl falls back to a new tab.
        await openExternalUrl(json.auth.redirectUrl);
      }
    } else if (json.auth?.kind === 'connected') {
      renderConnectorAuthInfo(authWindow, {
        title: 'Already connected',
        body: 'This connector is already authorized. You can close this window.',
      });
    } else if (json.auth?.kind === 'pending') {
      renderConnectorAuthInfo(authWindow, {
        title: 'Authorization pending',
        body: 'Authorization is in progress but no redirect URL was returned. Watch for an email confirmation, or open the Composio dashboard to continue.',
      });
    } else {
      renderConnectorAuthInfo(authWindow, {
        title: 'No authorization URL returned',
        body: 'The connector responded without a redirect URL. If this seems wrong, retry from Settings → Connectors, and confirm your Composio API key.',
      });
    }
    return { connector: json.connector ?? null, ...(json.auth === undefined ? {} : { auth: json.auth }) };
  } catch (err) {
    renderConnectorAuthError(authWindow, err instanceof Error && err.message ? err.message : 'Could not start connector authentication.');
    return {
      connector: null,
      error: err instanceof Error && err.message ? err.message : 'Could not start connector authentication.',
    };
  }
}

async function prepareConnectorAuthConfig(connectorId: string): Promise<{ status: 'ready' } | { status: 'error'; message: string }> {
  const resp = await fetch('/api/connectors/auth-configs/prepare', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connectorIds: [connectorId] }),
  });
  if (!resp.ok) {
    return { status: 'error', message: await decodeConnectorError(resp) };
  }
  const json = (await resp.json()) as ConnectorAuthConfigPrepareResponse;
  const result = json.results?.[connectorId];
  if (!result) return { status: 'error', message: 'Auth config initialization did not return a result.' };
  if (result.status === 'ready') return { status: 'ready' };
  return { status: 'error', message: result.message };
}

function openConnectorAuthRedirect(authWindow: Window | null, redirectUrl: string): void {
  if (authWindow) {
    renderConnectorAuthRedirect(authWindow, redirectUrl);
    try {
      authWindow.location.replace(redirectUrl);
      return;
    } catch {
      // Some embedded browsers block async popup navigation. Leave the
      // clickable fallback in the popup so the user can continue.
    }
  }
  // Never navigate the app window away if the popup is blocked.
  window.open(redirectUrl, '_blank');
}

function renderConnectorAuthLoading(authWindow: Window | null, copy: { title: string; body: string }): void {
  if (!authWindow) return;
  try {
    authWindow.document.title = 'Connecting…';
    authWindow.document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#0f1115;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:grid;gap:14px;justify-items:center;text-align:center;padding:32px;">
          <div aria-hidden="true" style="width:28px;height:28px;border-radius:999px;border:3px solid rgba(255,255,255,.22);border-top-color:#fff;animation:od-spin .8s linear infinite;"></div>
          <div style="font-size:15px;font-weight:600;">${escapeHtmlText(copy.title)}</div>
          <div style="max-width:300px;color:rgba(246,247,251,.72);font-size:13px;line-height:1.5;">${escapeHtmlText(copy.body)}</div>
        </div>
        <style>@keyframes od-spin{to{transform:rotate(360deg)}}</style>
      </main>
    `;
  } catch {
    /* Popup may be unavailable or already navigated; ignore. */
  }
}

function renderConnectorAuthInfo(authWindow: Window | null, copy: { title: string; body: string }): void {
  if (!authWindow) return;
  try {
    authWindow.document.title = copy.title;
    authWindow.document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#0f1115;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:grid;gap:14px;justify-items:center;text-align:center;padding:32px;">
          <div style="font-size:15px;font-weight:600;">${escapeHtmlText(copy.title)}</div>
          <div style="max-width:360px;color:rgba(246,247,251,.72);font-size:13px;line-height:1.5;">${escapeHtmlText(copy.body)}</div>
        </div>
      </main>
    `;
  } catch {
    /* Popup may be unavailable or already navigated; ignore. */
  }
}

function renderConnectorAuthRedirect(authWindow: Window, redirectUrl: string): void {
  try {
    authWindow.document.title = 'Continue authorization';
    authWindow.document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#0f1115;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:grid;gap:14px;justify-items:center;text-align:center;padding:32px;">
          <div style="font-size:15px;font-weight:600;">Continue authorization</div>
          <div style="max-width:300px;color:rgba(246,247,251,.72);font-size:13px;line-height:1.5;">If this window does not redirect automatically, use the button below.</div>
          <a href="${escapeHtmlAttribute(redirectUrl)}" style="display:inline-flex;align-items:center;justify-content:center;min-width:164px;border-radius:8px;padding:9px 14px;background:#df7b56;color:#fff;text-decoration:none;font-size:13px;font-weight:600;">Open Composio</a>
        </div>
      </main>
    `;
  } catch {
    /* Popup may already be cross-origin; navigation fallback still runs. */
  }
}

async function readConnectorApiErrorMessage(resp: Response): Promise<string> {
  try {
    const payload = await resp.json() as { error?: { message?: string }; message?: string };
    return payload.error?.message ?? payload.message ?? `Connection failed (${resp.status})`;
  } catch {
    return `Connection failed (${resp.status})`;
  }
}

function renderConnectorAuthError(authWindow: Window | null, message: string): void {
  if (!authWindow) return;
  try {
    authWindow.document.title = 'Connection failed';
    authWindow.document.body.innerHTML = `
      <main style="min-height:100vh;display:grid;place-items:center;margin:0;background:#0f1115;color:#f6f7fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
        <div style="display:grid;gap:14px;justify-items:center;text-align:center;padding:32px;">
          <div style="font-size:15px;font-weight:600;">Connection failed</div>
          <div style="max-width:360px;color:rgba(246,247,251,.72);font-size:13px;line-height:1.5;">${escapeHtmlText(message)}</div>
        </div>
      </main>
    `;
  } catch {
    /* Popup may be unavailable or already navigated; ignore. */
  }
}

function escapeHtmlText(value: string): string {
  return value.replace(/[&<>]/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      default:
        return char;
    }
  });
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      case "'":
        return '&#39;';
      default:
        return char;
    }
  });
}

export async function disconnectConnector(connectorId: string): Promise<ConnectorDetail | null> {
  try {
    const resp = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}/connection`, {
      method: 'DELETE',
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as ConnectorDetailResponse;
    return json.connector ?? null;
  } catch {
    return null;
  }
}

export async function cancelConnectorAuthorization(connectorId: string): Promise<ConnectorDetail | null> {
  try {
    const resp = await fetch(`/api/connectors/${encodeURIComponent(connectorId)}/authorization/cancel`, {
      method: 'POST',
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as ConnectorDetailResponse;
    return json.connector ?? null;
  } catch {
    return null;
  }
}


function isAppVersionInfo(value: unknown): value is AppVersionInfo {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AppVersionInfo>;
  // `capabilities` is optional so an older daemon's response stays valid; a
  // present-but-wrong shape is rejected rather than half-trusted.
  const caps = candidate.capabilities as { slideRenderer?: unknown } | undefined;
  if (caps !== undefined && (!caps || typeof caps.slideRenderer !== 'boolean')) return false;
  return (
    typeof candidate.version === 'string' &&
    typeof candidate.channel === 'string' &&
    typeof candidate.packaged === 'boolean' &&
    typeof candidate.platform === 'string' &&
    typeof candidate.arch === 'string'
  );
}

export async function fetchAppVersionInfo(): Promise<AppVersionInfo | null> {
  try {
    const resp = await fetch('/api/version');
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<AppVersionResponse>;
    return isAppVersionInfo(json?.version) ? json.version : null;
  } catch {
    return null;
  }
}

export type LatestGithubReleaseInfo = {
  tagName: string;
  htmlUrl: string;
  stale: boolean;
};

export async function fetchLatestGithubReleaseInfo(): Promise<LatestGithubReleaseInfo | null> {
  try {
    const resp = await fetch('/api/github/mish/releases/latest');
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<MishGithubLatestReleaseResponse>;
    if (typeof json.tag_name !== 'string' || typeof json.html_url !== 'string') return null;
    return {
      tagName: json.tag_name,
      htmlUrl: json.html_url,
      stale: json.stale === true,
    };
  } catch {
    return null;
  }
}

export async function fetchWhatsNew(): Promise<WhatsNewResponse | null> {
  try {
    const resp = await fetch('/api/whats-new');
    if (!resp.ok) return null;
    const json = (await resp.json()) as Partial<WhatsNewResponse>;
    if (typeof json.version !== 'string') {
      return null;
    }
    return {
      version: json.version,
      id: typeof json.id === 'string' ? json.id : null,
      content: json.content ?? null,
    };
  } catch {
    return null;
  }
}

export type SkillExampleResult =
  | { html: string }
  // The skill declares a non-HTML preview surface (image / markdown / …)
  // and the daemon's `/example` endpoint only ships HTML, so calling it
  // would 404 into a misleading "failed to fetch" state. The modal
  // renders a calm "no shipped preview" affordance instead. The `kind`
  // is the raw `od.preview.type` from SKILL.md so future preview kinds
  // can be picked up by name without a registry change. Issue #897.
  | { unavailable: true; kind: string }
  | { error: string };

// Returns a discriminated result so callers can distinguish a real
// failure (network error, daemon unreachable, server error) from a
// normal load or a missing shipped preview. Previously this collapsed
// every failure into `null`, which left the example preview modal stuck
// at its loading state with no recovery affordance. Issue #860.
//
// `previewType` is the skill's `od.preview.type` (defaults to `'html'`
// daemon-side). Anything other than `'html'` short-circuits to an
// `unavailable` result so we don't fire a network call against a
// daemon endpoint that only resolves HTML files. Issue #897.
export async function fetchSkillExample(
  id: string,
  previewType: string = 'html',
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillExampleResult> {
  if (previewType !== 'html') {
    return { unavailable: true, kind: previewType };
  }
  try {
    const url = `/api/skills/${encodeURIComponent(id)}/example`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) {
        return { unavailable: true, kind: 'html' };
      }
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

export async function fetchDeployConfig(
  providerId?: WebDeployProviderId,
): Promise<WebDeployConfigResponse | null> {
  try {
    const resp = await fetch(`/api/deploy/config${deployProviderQuery(providerId)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as WebDeployConfigResponse;
  } catch {
    return null;
  }
}

export async function updateDeployConfig(
  input: WebUpdateDeployConfigRequest,
): Promise<WebDeployConfigResponse | null> {
  try {
    const resp = await fetch('/api/deploy/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;
      throw new Error(payload?.error?.message || payload?.message || `Could not save deploy config (${resp.status})`);
    }
    return (await resp.json()) as WebDeployConfigResponse;
  } catch (err) {
    if (err instanceof Error) throw err;
    return null;
  }
}

export async function fetchCloudflarePagesZones(): Promise<WebCloudflarePagesZonesResponse | null> {
  try {
    const resp = await fetch('/api/deploy/cloudflare-pages/zones');
    if (!resp.ok) {
      const payload = (await resp.json().catch(() => null)) as
        | { error?: { message?: string }; message?: string }
        | null;
      throw new Error(payload?.error?.message || payload?.message || `Could not load Cloudflare zones (${resp.status})`);
    }
    return (await resp.json()) as WebCloudflarePagesZonesResponse;
  } catch (err) {
    if (err instanceof Error) throw err;
    return null;
  }
}

export async function fetchProjectDeployments(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WebDeploymentInfo[]> {
  // HtmlViewer reads this from its identity-load effect and again when the
  // Share/Export popover opens; those can overlap. Retaining nothing after the
  // read settles keeps the popover's on-demand refresh a real request — it
  // exists precisely to observe a deploy that happened since the mount read.
  return coalescedGet(
    `project-deployments:${projectId}:${workspaceIdentityCacheKey(workspaceContext)}`,
    async () => {
      try {
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/deployments`,
          workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
        );
        if (!resp.ok) return [];
        const json = (await resp.json()) as ProjectDeploymentsResponse;
        return (json.deployments ?? []) as WebDeploymentInfo[];
      } catch {
        return [];
      }
    },
    IN_FLIGHT_SHARE_ONLY_MS,
  );
}

export async function deployProjectFile(
  projectId: string,
  fileName: string,
  providerId: WebDeployProviderId = DEFAULT_DEPLOY_PROVIDER_ID,
  cloudflarePages?: WebCloudflarePagesDeploySelection,
  target?: 'preview' | 'production',
  workspaceContext?: WorkspaceCollabContext | null,
  publicAccess?: boolean,
  vercel?: { projectName?: string },
): Promise<WebDeployProjectFileResponse> {
  const body = {
    fileName,
    providerId,
    ...(cloudflarePages ? { cloudflarePages } : {}),
    ...(vercel ? { vercel } : {}),
    ...(target ? { target } : {}),
    // Vercel only, and only when the caller has an answer: an absent field
    // leaves the account's deployment-protection default alone.
    ...(publicAccess === undefined ? {} : { publicAccess }),
  };
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/deploy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string; code?: string; details?: { suggestion?: string } }; code?: string; message?: string }
      | null;
    const message = payload?.error?.message || payload?.message || `Deploy failed (${resp.status})`;
    // Preserve a queryable failure code for analytics (`deployErrorCode` reads
    // `.code` first). The daemon deploy route (apps/daemon/src/routes/deploy.ts)
    // names the causes it can classify (NOT_HTML, MISSING_REFERENCES, …) and
    // falls back to a generic `BAD_REQUEST` (404 → `FILE_NOT_FOUND`) for a
    // provider transport failure, where it keeps the REAL provider HTTP status
    // on the response and the real message in the body — so ignore those generic
    // envelope codes and fall back to `HTTP_${resp.status}`, which then buckets
    // as HTTP_403 / HTTP_429 / HTTP_500 instead of collapsing every failure into
    // one code.
    const rawCode = payload?.error?.code || payload?.code;
    const code = rawCode && !GENERIC_DEPLOY_ENVELOPE_CODES.has(rawCode) ? rawCode : `HTTP_${resp.status}`;
    throw Object.assign(new Error(message), { code, suggestion: payload?.error?.details?.suggestion });
  }
  return (await resp.json()) as WebDeployProjectFileResponse;
}

function parsePublicFileManualRevokeData(
  value: unknown,
): PublicFileManualRevokeRequiredData | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const data = value as Partial<Record<keyof PublicFileManualRevokeRequiredData, unknown>>;
  if (
    typeof data.projectId !== 'string'
    || typeof data.url !== 'string'
    || typeof data.slug !== 'string'
    || typeof data.fileName !== 'string'
    || !data.projectId
    || !data.url
    || !data.slug
    || !data.fileName
  ) {
    return undefined;
  }
  return {
    projectId: data.projectId,
    url: data.url,
    slug: data.slug,
    fileName: data.fileName,
  };
}

export async function publishProjectFilePublic(
  projectId: string,
  fileName: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WebPublicProjectFileResponse> {
  // Carry the active workspace identity so the daemon's `canShareProjectsForRequest`
  // gate (apps/daemon/src/routes/collab-sync.ts) reads the real permission bit
  // instead of falling back to a headerless context read — see
  // workspaceProjectHeaders' call sites in state/projects.ts for the same pattern.
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileName)}/publish-public`,
    {
      method: 'POST',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    },
  );
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | {
          error?: { code?: unknown; message?: unknown; data?: unknown } | string;
          message?: unknown;
        }
      | null;
    const structuredError = payload?.error && typeof payload.error === 'object'
      ? payload.error
      : null;
    const code = typeof structuredError?.code === 'string'
      ? structuredError.code
      : typeof payload?.error === 'string'
        ? payload.error
        : undefined;
    const errorMessage =
      typeof structuredError?.message === 'string'
        ? structuredError.message
      : typeof payload?.error === 'string'
          ? payload.error
          : typeof payload?.message === 'string'
            ? payload.message
            : undefined;
    const recoveryData = code === PUBLIC_FILE_MANUAL_REVOKE_REQUIRED
      ? parsePublicFileManualRevokeData(structuredError?.data)
      : undefined;
    throw new PublicFilePublishError(
      errorMessage || `Publish failed (${resp.status})`,
      resp.status,
      code,
      recoveryData?.projectId === projectId && recoveryData.fileName === fileName
        ? recoveryData
        : undefined,
    );
  }
  return (await resp.json()) as WebPublicProjectFileResponse;
}

export async function fetchProjectFilePublicPublication(
  projectId: string,
  fileName: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WebPublicProjectFileResponse | null> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileName)}/publish-public`,
    workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
  );
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string } | string; message?: string }
      | null;
    const errorMessage =
      typeof payload?.error === 'object'
        ? payload.error.message
        : typeof payload?.error === 'string'
          ? payload.error
          : payload?.message;
    throw new Error(errorMessage || `Fetch publish state failed (${resp.status})`);
  }
  const payload = (await resp.json()) as { publication?: WebPublicProjectFileResponse | null };
  return payload.publication ?? null;
}

export async function unpublishProjectFilePublic(
  projectId: string,
  fileName: string,
  slug: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ ok: true; slug: string; fileName: string }> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileName)}/publish-public`,
    {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({ slug }),
    },
  );
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string } | string; message?: string }
      | null;
    const errorMessage =
      typeof payload?.error === 'object'
        ? payload.error.message
        : typeof payload?.error === 'string'
          ? payload.error
          : payload?.message;
    throw new Error(errorMessage || `Unpublish failed (${resp.status})`);
  }
  return (await resp.json()) as { ok: true; slug: string; fileName: string };
}

export async function checkDeploymentLink(
  projectId: string,
  deploymentId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WebDeployProjectFileResponse> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/deployments/${encodeURIComponent(deploymentId)}/check-link`,
    {
      method: 'POST',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    },
  );
  if (!resp.ok) {
    const payload = (await resp.json().catch(() => null)) as
      | { error?: { message?: string }; message?: string }
      | null;
    throw new Error(payload?.error?.message || payload?.message || `Link check failed (${resp.status})`);
  }
  return (await resp.json()) as WebDeployProjectFileResponse;
}

export async function createSocialSharePayload(
  input: SocialShareRequest,
): Promise<SocialShareResponse> {
  const resp = await fetch('/api/social-share', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!resp.ok) {
    const payload = await resp.json().catch(() => null) as {
      error?: { message?: string };
      message?: string;
    } | null;
    throw new Error(payload?.error?.message || payload?.message || `Share payload failed (${resp.status})`);
  }
  return (await resp.json()) as SocialShareResponse;
}

// Project files — all paths are scoped under .od/projects/<id>/ on disk.

function projectFilesCacheKey(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  return `project-files:${projectId}:${workspaceIdentityCacheKey(workspaceContext)}`;
}

const projectFilesCacheGenerations = new Map<string, number>();

/**
 * Announce that one authority-scoped project file list is obsolete.
 *
 * This drops a settled shared read and advances the generation fence checked
 * by any request already in flight. The next reader therefore cannot reuse a
 * pre-event snapshot, and an overtaken request re-reads before it resolves to
 * its caller.
 */
export function invalidateProjectFilesCache(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): void {
  const key = projectFilesCacheKey(projectId, workspaceContext);
  projectFilesCacheGenerations.set(key, (projectFilesCacheGenerations.get(key) ?? 0) + 1);
  evictSharedCancellableGet(key);
}

export async function fetchProjectFiles(
  projectId: string,
  options?: {
    signal?: AbortSignal;
    workspaceContext?: WorkspaceCollabContext | null;
    fresh?: boolean;
    requireAuthoritative?: boolean;
  },
): Promise<ProjectFile[]> {
  // Every reader of the same project's file list shares one request
  // (Batch A §4.3). Cancellable callers (project-card cover scans aborted
  // when Home unmounts) detach individually; the shared request is aborted
  // only when no reader is left awaiting it, so a foreground project read
  // can never be killed by an abandoned card scan.
  try {
    const cacheKey = projectFilesCacheKey(projectId, options?.workspaceContext);
    const cacheGeneration = projectFilesCacheGenerations.get(cacheKey) ?? 0;
    const get = options?.fresh ? forceSharedCancellableGet : sharedCancellableGet;
    return await get(
      cacheKey,
      async (signal): Promise<ProjectFile[]> => {
        const url = `/api/projects/${encodeURIComponent(projectId)}/files`;
        const resp = await fetch(url, {
          signal,
          // Agent CLIs write directly to the project directory, so the same
          // URL can change without an HTTP mutation. Keep caching confined to
          // sharedCancellableGet's explicit one-second window; a forced/fresh
          // read must reach the daemon instead of reusing a browser/proxy 200.
          cache: 'no-store',
          ...(options?.workspaceContext
            ? { headers: workspaceProjectHeaders(options.workspaceContext) }
            : {}),
        });
        if (!resp.ok) {
          throw new Error(`Project files request failed (${resp.status})`);
        }
        const json = (await resp.json()) as { files?: unknown };
        if (!Array.isArray(json.files)) {
          throw new Error('Project files response was malformed');
        }
        if ((projectFilesCacheGenerations.get(cacheKey) ?? 0) !== cacheGeneration) {
          return fetchProjectFiles(projectId, options);
        }
        return json.files as ProjectFile[];
      },
      { signal: options?.signal },
    );
  } catch (error) {
    // Preserve the historical empty fallback for broad list/card callers.
    // State owners that must distinguish an authoritative empty directory
    // from transport failure opt into rejection explicitly.
    if (
      options?.signal?.aborted
      && error instanceof DOMException
      && error.name === 'AbortError'
    ) {
      return [];
    }
    if (options?.requireAuthoritative) throw error;
    return [];
  }
}

export type ProjectDesignTokenSuggestion = import('@mish/contracts').ProjectDesignTokenSuggestion;
export type ProjectDesignTokenSuggestionProp = import('@mish/contracts').ProjectDesignTokenSuggestionProp;

export async function fetchProjectDesignTokenSuggestions(
  projectId: string,
  input: {
    file?: string;
    targetId?: string;
    props?: ProjectDesignTokenSuggestionProp[];
    values?: Partial<Record<ProjectDesignTokenSuggestionProp, string>>;
  },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectDesignTokenSuggestion[]> {
  const params = new URLSearchParams();
  if (input.file) params.set('file', input.file);
  if (input.targetId) params.set('targetId', input.targetId);
  if (input.props?.length) params.set('props', input.props.join(','));
  for (const [prop, value] of Object.entries(input.values ?? {})) {
    if (value) params.set(`value_${prop}`, value);
  }
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/design-token-suggestions?${params.toString()}`, {
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!resp.ok) return [];
    const json = (await resp.json()) as { suggestions?: ProjectDesignTokenSuggestion[] };
    return json.suggestions ?? [];
  } catch {
    return [];
  }
}

export async function fetchProjectFolders(
  projectId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFolder[]> {
  // Keyed by the authority the request is made under as well as the project:
  // two readers may only share a request that carries the same Workspace
  // headers, or one identity's answer could satisfy another's read.
  return coalescedGet(
    `project-folders:${projectId}:${workspaceIdentityCacheKey(workspaceContext)}`,
    async () => {
      try {
        const resp = await fetch(
          `/api/projects/${encodeURIComponent(projectId)}/folders`,
          workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
        );
        if (!resp.ok) return [];
        const json = (await resp.json()) as { folders?: ProjectFolder[] };
        return json.folders ?? [];
      } catch {
        return [];
      }
    },
    IN_FLIGHT_SHARE_ONLY_MS,
  );
}

export async function createProjectFolder(
  projectId: string,
  name: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFolder | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({ name }),
    });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { folder?: ProjectFolder };
    return json.folder ?? null;
  } catch {
    return null;
  }
}

export async function deleteProjectFolder(
  projectId: string,
  folderPath: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<boolean> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/folders`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({ path: folderPath }),
    });
    if (!resp.ok) return false;
    invalidateProjectFilesCache(projectId, workspaceContext);
    return true;
  } catch {
    return false;
  }
}

export async function fetchLiveArtifacts(
  projectId: string,
  options?: {
    signal?: AbortSignal;
    workspaceContext?: WorkspaceCollabContext | null;
  },
): Promise<LiveArtifactSummary[]> {
  const run = async () => {
    try {
      const url = workspaceResourceUrl(
        `/api/live-artifacts?projectId=${encodeURIComponent(projectId)}`,
        options?.workspaceContext,
      );
      const resp = await fetch(url, {
        ...(options?.signal ? { signal: options.signal } : {}),
        ...(options?.workspaceContext
          ? { headers: workspaceProjectHeaders(options.workspaceContext) }
          : {}),
      });
      if (!resp.ok) return [];
      const json = (await resp.json()) as {
        artifacts?: LiveArtifactSummary[];
        liveArtifacts?: LiveArtifactSummary[];
      };
      return json.liveArtifacts ?? json.artifacts ?? [];
    } catch {
      return [];
    }
  };
  // Foreground consumers keep the existing coalescing contract. Cancellable
  // card scans are background work: sharing their promise would let a hidden
  // EntryShell pane pin or abort the ProjectView request that needs to win
  // during a reopen.
  if (options?.signal) return run();
  return coalescedGet(
    `live-artifacts:${workspaceIdentityCacheKey(options?.workspaceContext)}:${projectId}`,
    run,
  );
}

export async function fetchLiveArtifact(
  projectId: string,
  artifactId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LiveArtifact | null> {
  try {
    const resp = await fetch(
      liveArtifactDetailUrl(projectId, artifactId, workspaceContext),
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as {
      artifact?: LiveArtifact;
      liveArtifact?: LiveArtifact;
    };
    return json.liveArtifact ?? json.artifact ?? null;
  } catch {
    return null;
  }
}

export interface LiveArtifactRefreshResult {
  artifact: LiveArtifact;
  refresh: {
    id: string;
    status: 'succeeded';
    refreshedSourceCount: number;
  };
}

export class LiveArtifactRefreshError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'LiveArtifactRefreshError';
  }
}

export async function refreshLiveArtifact(
  projectId: string,
  artifactId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LiveArtifactRefreshResult> {
  let resp: Response;
  try {
    resp = await fetch(
      workspaceResourceUrl(
        `/api/live-artifacts/${encodeURIComponent(artifactId)}/refresh?projectId=${encodeURIComponent(projectId)}`,
        workspaceContext,
      ),
      {
        method: 'POST',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
  } catch (error) {
    throw new LiveArtifactRefreshError(
      error instanceof Error ? error.message : 'Refresh request failed.',
      0,
    );
  }

  if (!resp.ok) {
    const errorBody = await readApiErrorBody(resp);
    throw new LiveArtifactRefreshError(errorBody.message, resp.status, errorBody.code);
  }

  return (await resp.json()) as LiveArtifactRefreshResult;
}

export async function fetchLiveArtifactRefreshes(
  projectId: string,
  artifactId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LiveArtifactRefreshLogEntry[]> {
  try {
    const resp = await fetch(
      workspaceResourceUrl(
        `/api/live-artifacts/${encodeURIComponent(artifactId)}/refreshes?projectId=${encodeURIComponent(projectId)}`,
        workspaceContext,
      ),
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { refreshes?: LiveArtifactRefreshLogEntry[] };
    return json.refreshes ?? [];
  } catch {
    return [];
  }
}

export async function updateLiveArtifact(
  projectId: string,
  artifactId: string,
  input: Pick<LiveArtifact, 'title' | 'status' | 'pinned' | 'preview'> & {
    slug?: string;
    document?: LiveArtifact['document'];
  },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LiveArtifact> {
  let resp: Response;
  try {
    resp = await fetch(
      workspaceResourceUrl(
        `/api/live-artifacts/${encodeURIComponent(artifactId)}?projectId=${encodeURIComponent(projectId)}`,
        workspaceContext,
      ),
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify(input),
      },
    );
  } catch (error) {
    throw new LiveArtifactRefreshError(
      error instanceof Error ? error.message : 'Update request failed.',
      0,
    );
  }

  if (!resp.ok) {
    const errorBody = await readApiErrorBody(resp);
    throw new LiveArtifactRefreshError(errorBody.message, resp.status, errorBody.code);
  }

  const json = (await resp.json()) as { artifact?: LiveArtifact; liveArtifact?: LiveArtifact };
  const artifact = json.liveArtifact ?? json.artifact;
  if (!artifact) throw new LiveArtifactRefreshError('Update response did not include a live artifact.', resp.status);
  return artifact;
}

export async function deleteLiveArtifact(
  projectId: string,
  artifactId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<boolean> {
  try {
    const resp = await fetch(
      workspaceResourceUrl(
        `/api/live-artifacts/${encodeURIComponent(artifactId)}?projectId=${encodeURIComponent(projectId)}`,
        workspaceContext,
      ),
      {
        method: 'DELETE',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}


export function liveArtifactDetailUrl(
  projectId: string,
  artifactId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  return workspaceResourceUrl(
    `/api/live-artifacts/${encodeURIComponent(artifactId)}?projectId=${encodeURIComponent(projectId)}`,
    workspaceContext,
  );
}

export type LiveArtifactPreviewVariant = 'rendered' | 'template' | 'rendered-source';

export function liveArtifactPreviewUrl(
  projectId: string,
  artifactId: string,
  variant: LiveArtifactPreviewVariant = 'rendered',
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  const baseUrl = workspaceResourceUrl(
    `/api/live-artifacts/${encodeURIComponent(artifactId)}/preview?projectId=${encodeURIComponent(projectId)}`,
    workspaceContext,
  );
  return variant === 'rendered'
    ? baseUrl
    : appendResourceQuery(baseUrl, `variant=${encodeURIComponent(variant)}`);
}

export async function fetchLiveArtifactCode(
  projectId: string,
  artifactId: string,
  variant: Exclude<LiveArtifactPreviewVariant, 'rendered'>,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<string | null> {
  try {
    const resp = await fetch(
      liveArtifactPreviewUrl(projectId, artifactId, variant, workspaceContext),
      {
        cache: 'no-store',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export function projectFileUrl(
  projectId: string,
  name: string,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  return projectRawUrl(projectId, name, workspaceContext);
}

/**
 * Mint the daemon-owned, project-scoped preview capability and return its
 * directory URL for srcDoc relative-resource resolution. Project ownership is
 * persisted by the daemon, so the browser must not duplicate that authority in
 * query parameters or headers. The opaque preview scope authorizes subsequent
 * asset navigation without exposing Workspace identifiers in iframe URLs.
 */
export interface ProjectPreviewBaseScope {
  href: string;
  expiresAt: number;
}

// Newer daemons return the authoritative scope expiry. During a rolling
// desktop/web update the web bundle can briefly run against an older daemon,
// so retain a conservative refresh horizon instead of rejecting an otherwise
// valid preview URL and dropping relative assets altogether.
const LEGACY_PREVIEW_SCOPE_REFRESH_MS = 45 * 60 * 1000;

function previewCapabilityHref(pathname: string): string {
  const runtimeHref = typeof globalThis.location?.href === 'string'
    ? globalThis.location.href
    : 'http://mish.local/';
  return new URL(pathname, runtimeHref).href;
}

export async function fetchProjectPreviewBaseHref(
  projectId: string,
  name: string,
  _workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectPreviewBaseScope | null> {
  const params = new URLSearchParams({ file: name });
  const requestUrl =
    `/api/projects/${encodeURIComponent(projectId)}/preview-url?${params.toString()}`;
  try {
    const response = await fetch(requestUrl, {
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const body = (await response.json()) as ProjectPreviewUrlResponse;
    if (typeof body.url !== 'string' || !body.url.startsWith('/')) return null;
    const parsed = new URL(body.url, 'http://mish.local');
    const expectedPrefix = `/api/projects/${encodeURIComponent(projectId)}/preview/`;
    if (!parsed.pathname.startsWith(expectedPrefix)) return null;
    const directoryEnd = parsed.pathname.lastIndexOf('/') + 1;
    if (directoryEnd <= expectedPrefix.length) return null;
    const expiresAt = typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : Date.now() + LEGACY_PREVIEW_SCOPE_REFRESH_MS;
    return {
      // Electron renders injected HTML from blob:od:// URLs. A root-relative
      // <base> is ignored in a Blob document, leaving document.baseURI on the
      // Blob and breaking lazy or script-created relative assets. Resolve the
      // capability against the host document while it still has a real origin.
      href: previewCapabilityHref(parsed.pathname.slice(0, directoryEnd)),
      expiresAt,
    };
  } catch {
    return null;
  }
}

export async function renewProjectPreviewBaseScope(
  projectId: string,
  href: string,
): Promise<number | null> {
  try {
    const parsed = new URL(href, 'http://mish.local');
    const expectedPrefix = `/api/projects/${encodeURIComponent(projectId)}/preview/`;
    if (!parsed.pathname.startsWith(expectedPrefix)) return null;
    const scopeEnd = parsed.pathname.indexOf('/', expectedPrefix.length);
    if (scopeEnd <= expectedPrefix.length) return null;
    const scope = parsed.pathname.slice(expectedPrefix.length, scopeEnd);
    if (!/^[A-Za-z0-9_-]{8,128}$/u.test(scope)) return null;
    const response = await fetch(
      `${expectedPrefix}${encodeURIComponent(scope)}/renew`,
      {
        method: 'POST',
        cache: 'no-store',
        headers: { 'x-od-preview-scope-renewal': '1' },
      },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as ProjectPreviewScopeRenewResponse;
    return typeof body.expiresAt === 'number' && Number.isFinite(body.expiresAt)
      ? body.expiresAt
      : null;
  } catch {
    return null;
  }
}

export interface ProjectFilePreviewSection {
  title: string;
  lines: string[];
}

export interface ProjectFilePreview {
  kind: 'pdf' | 'document' | 'presentation' | 'spreadsheet';
  title: string;
  sections: ProjectFilePreviewSection[];
}

export async function fetchProjectFilePreview(
  projectId: string,
  name: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFilePreview | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(name)}/preview`,
      workspaceContext
        ? { headers: workspaceProjectHeaders(workspaceContext) }
        : undefined,
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFilePreview;
  } catch {
    return null;
  }
}

export async function fetchProjectFileText(
  projectId: string,
  name: string,
  options?: {
    cache?: RequestCache;
    cacheBustKey?: string | number;
    signal?: AbortSignal;
    workspaceContext?: WorkspaceCollabContext | null;
    optional?: boolean;
  },
): Promise<string | null> {
  if (options?.optional) {
    return fetchOptionalProjectFileText(projectId, name, { ...options, optional: false });
  }
  const url = projectFileUrl(projectId, name, options?.workspaceContext);
  const cacheBustKey = options?.cacheBustKey;
  const requestUrl =
    cacheBustKey == null
      ? url
      : `${url}${url.includes('?') ? '&' : '?'}cacheBust=${encodeURIComponent(String(cacheBustKey))}`;
  const init: RequestInit = {};
  if (options?.cache) init.cache = options.cache;
  if (options?.signal) init.signal = options.signal;
  if (options?.workspaceContext) {
    init.headers = workspaceProjectHeaders(options.workspaceContext);
  }

  try {
    const resp = await fetch(requestUrl, init);
    if (options?.signal?.aborted) return null;
    if (!resp.ok) {
      console.warn('[fetchProjectFileText] failed:', {
        name,
        projectId,
        status: resp.status,
        statusText: resp.statusText,
        url: requestUrl,
      });
      return null;
    }
    return await resp.text();
  } catch (err) {
    if (
      options?.signal?.aborted ||
      (err instanceof DOMException && err.name === 'AbortError')
    ) {
      return null;
    }
    console.warn('[fetchProjectFileText] failed:', {
      error: err,
      name,
      projectId,
      url: requestUrl,
    });
    return null;
  }
}

/** Read an optional file only when the authoritative project file list names it. */
export async function fetchOptionalProjectFileText(
  projectId: string,
  name: string,
  options?: Parameters<typeof fetchProjectFileText>[2],
): Promise<string | null> {
  try {
    const files = await fetchProjectFiles(projectId, {
      signal: options?.signal,
      workspaceContext: options?.workspaceContext,
      requireAuthoritative: true,
    });
    if (options?.signal?.aborted) return null;
    if (!files.some((file) => (file.path ?? file.name) === name)) return null;
  } catch (error) {
    if (!options?.signal?.aborted) {
      console.warn('[fetchOptionalProjectFileText] file list failed:', { projectId, name, error });
    }
    return null;
  }
  return fetchProjectFileText(projectId, name, options);
}

export async function fetchProjectFileTextPreview(
  projectId: string,
  name: string,
  options?: {
    limit?: number;
    cacheBustKey?: string | number;
    workspaceContext?: WorkspaceCollabContext | null;
  },
): Promise<ProjectFileTextPreviewResponse | null> {
  const segments = name
    .split('/')
    .filter((segment) => segment.length > 0)
    .map(encodeURIComponent)
    .join('/');
  if (!segments) return null;
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.cacheBustKey != null) params.set('cacheBust', String(options.cacheBustKey));
  const query = params.toString();
  const url = `/api/projects/${encodeURIComponent(projectId)}/text-preview/${segments}${query ? `?${query}` : ''}`;

  try {
    const resp = await fetch(url, {
      cache: 'no-store',
      ...(options?.workspaceContext
        ? { headers: workspaceProjectHeaders(options.workspaceContext) }
        : {}),
    });
    if (!resp.ok) {
      console.warn('[fetchProjectFileTextPreview] failed:', {
        name,
        projectId,
        status: resp.status,
        statusText: resp.statusText,
        url,
      });
      return null;
    }
    return (await resp.json()) as ProjectFileTextPreviewResponse;
  } catch (err) {
    console.warn('[fetchProjectFileTextPreview] failed:', {
      error: err,
      name,
      projectId,
      url,
    });
    return null;
  }
}

function projectFileVersionsUrl(projectId: string, name: string): string {
  const safePath = name
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/files/${safePath}/versions`;
}

/**
 * `workspaceContext` is not an authorization argument here — this GET is never
 * refused. It tells the daemon whose read this is, so a readonly member's read
 * of someone else's shared project stops bootstrapping a baseline version into
 * a project they cannot write (see `requestCanMutateWorkspaceResource` in
 * `apps/daemon/src/collab/workspace-resource-mutation.ts`). Without the
 * headers the daemon has no identity on this path and falls back to
 * bootstrapping, which is what made a member's mirror show one synthetic
 * "Version 1" instead of the owner's real history.
 */
export async function fetchProjectFileVersions(
  projectId: string,
  name: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFileVersionsResponse | null> {
  try {
    const resp = await fetch(projectFileVersionsUrl(projectId, name), {
      cache: 'no-store',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFileVersionsResponse;
  } catch {
    return null;
  }
}

export async function fetchProjectFileVersion(
  projectId: string,
  name: string,
  versionId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFileVersionResponse | null> {
  try {
    const resp = await fetch(
      `${projectFileVersionsUrl(projectId, name)}/${encodeURIComponent(versionId)}`,
      {
        cache: 'no-store',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
    if (!resp.ok) return null;
    return (await resp.json()) as ProjectFileVersionResponse;
  } catch {
    return null;
  }
}

export async function restoreProjectFileVersion(
  projectId: string,
  name: string,
  version: Pick<ProjectFileVersion, 'id'>,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<RestoreProjectFileVersionResponse | null> {
  try {
    const resp = await fetch(
      `${projectFileVersionsUrl(projectId, name)}/${encodeURIComponent(version.id)}/restore`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify({}),
      },
    );
    if (!resp.ok) return null;
    invalidateProjectFilesCache(projectId, workspaceContext);
    return (await resp.json()) as RestoreProjectFileVersionResponse;
  } catch {
    return null;
  }
}

export async function fetchPreviewComments(
  projectId: string,
  conversationId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<PreviewComment[]> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
      {
        headers: workspaceContext
          ? workspaceProjectHeaders(workspaceContext)
          : undefined,
      },
    );
    if (!resp.ok) return [];
    const json = (await resp.json()) as { comments: PreviewComment[] };
    return json.comments ?? [];
  } catch {
    return [];
  }
}

// `workspaceContext`, when present, proves the caller's workspace membership
// to the daemon's `enforceCommentWorkspaceMutation` gate (spec 04 §10 fix
// #4/#6 — recvqbklNGDqYY) the same way `workspaceProjectHeaders`' call sites
// elsewhere in this file do. A workspace-bound project mutated with no
// headers fails closed with 401 `WORKSPACE_CONTEXT_REQUIRED` — silently, from
// the caller's point of view, unless it inspects the response — so this
// param is NOT optional-in-spirit for a team project even though it stays an
// optional trailing arg for personal-project callers that have no context.
export async function upsertPreviewComment(
  projectId: string,
  conversationId: string,
  input: PreviewCommentUpsertRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify(input),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function patchPreviewCommentStatus(
  projectId: string,
  conversationId: string,
  commentId: string,
  status: PreviewCommentStatus,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify({ status }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a drag-reorder of the sidebar's display order (recvq5BVsolIxi
 * Phase 2). Writes only the dragged comment's `sortKey` — never a whole-list
 * renumber, and never touches `pinSeq` (the canvas pin number).
 *
 * `workspaceContext`, when present, attaches the same workspace identity
 * headers the sibling comment-mutation calls in this file carry (see
 * `upsertPreviewComment` above) — kept consistent with those call sites even
 * though today's `/reorder` route does not itself gate on them, so this
 * write stays correct if/when that route gains the same
 * `enforceCommentWorkspaceMutation` coverage the other comment mutations
 * have.
 */
export async function patchPreviewCommentSortKey(
  projectId: string,
  conversationId: string,
  commentId: string,
  sortKey: number,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<PreviewComment | null> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}/reorder`,
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
        },
        body: JSON.stringify({ sortKey }),
      },
    );
    if (!resp.ok) return null;
    const json = (await resp.json()) as { comment: PreviewComment };
    return json.comment ?? null;
  } catch {
    return null;
  }
}

export async function deletePreviewComment(
  projectId: string,
  conversationId: string,
  commentId: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<boolean> {
  try {
    const resp = await fetch(
      `/api/projects/${encodeURIComponent(projectId)}/conversations/${encodeURIComponent(conversationId)}/comments/${encodeURIComponent(commentId)}`,
      {
        method: 'DELETE',
        headers: workspaceContext ? workspaceProjectHeaders(workspaceContext) : undefined,
      },
    );
    return resp.ok;
  } catch {
    return false;
  }
}

export async function writeProjectTextFile(
  projectId: string,
  name: string,
  content: string,
  options?: {
    artifactManifest?: ArtifactManifest;
    versionSource?: ProjectFileVersionSource;
    versionLabel?: string;
    versionPrompt?: string | null;
    parentVersionId?: string;
    agencyImagePath?: string;
  },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFile | null> {
  const result = await writeProjectTextFileDetailed(projectId, name, content, options, workspaceContext);
  return result.ok ? result.file : null;
}

export type WriteProjectTextFileResult =
  | { ok: true; file: ProjectFile; version?: ProjectFileVersion | null }
  | { ok: false; status?: number; code?: string; message: string };

export async function writeProjectTextFileDetailed(
  projectId: string,
  name: string,
  content: string,
  options?: {
    artifactManifest?: ArtifactManifest;
    versionSource?: ProjectFileVersionSource;
    versionLabel?: string;
    versionPrompt?: string | null;
    parentVersionId?: string;
    agencyImagePath?: string;
  },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<WriteProjectTextFileResult> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({
        name,
        content,
        artifactManifest: options?.artifactManifest,
        versionSource: options?.versionSource,
        versionLabel: options?.versionLabel,
        versionPrompt: options?.versionPrompt,
        parentVersionId: options?.parentVersionId,
        agencyImagePath: options?.agencyImagePath,
      }),
    });
    if (!resp.ok) {
      const body = await readApiErrorBody(resp);
      return {
        ok: false,
        status: resp.status,
        code: body.code,
        message: body.message || resp.statusText || 'Save failed',
      };
    }
    invalidateProjectFilesCache(projectId, workspaceContext);
    const json = (await resp.json()) as ProjectFileResponse;
    return {
      ok: true,
      file: json.file,
      ...(json.version !== undefined ? { version: json.version } : {}),
    };
  } catch {
    return { ok: false, message: 'Network error while saving the file' };
  }
}

export async function writeProjectBase64File(
  projectId: string,
  name: string,
  base64: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFile | null> {
  try {
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({ name, content: base64, encoding: 'base64' }),
    });
    if (!resp.ok) return null;
    invalidateProjectFilesCache(projectId, workspaceContext);
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

export async function uploadProjectFile(
  projectId: string,
  file: File,
  desiredName?: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ProjectFile | null> {
  try {
    const form = new FormData();
    form.append('file', file);
    if (desiredName) form.append('name', desiredName);
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files`, {
      method: 'POST',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      body: form,
    });
    if (!resp.ok) return null;
    invalidateProjectFilesCache(projectId, workspaceContext);
    const json = (await resp.json()) as { file: ProjectFile };
    return json.file;
  } catch {
    return null;
  }
}

// Offline `.fig` import. Uploads the Figma file to the daemon, which decodes
// it in-process (no Figma account) and stages a `figma/` snapshot into the
// project. Returns the inventory + a ready-to-send reshape prompt, or an
// error string the caller can surface.
export async function importProjectFigma(
  projectId: string,
  file: File,
  opts?: { notes?: string; subdir?: string },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ ok: true; result: FigmaImportResult } | { ok: false; error: string }> {
  try {
    const form = new FormData();
    form.append('file', file);
    if (opts?.notes && opts.notes.trim()) form.append('notes', opts.notes.trim());
    if (opts?.subdir && opts.subdir.trim()) form.append('subdir', opts.subdir.trim());
    const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/figma/import`, {
      method: 'POST',
      ...(workspaceContext
        ? { headers: workspaceProjectHeaders(workspaceContext) }
        : {}),
      body: form,
    });
    if (!resp.ok) {
      let message = `import failed (${resp.status})`;
      try {
        const body = (await resp.json()) as { error?: { message?: string } | string };
        const text = typeof body.error === 'string' ? body.error : body.error?.message;
        if (text) message = text;
      } catch {
        /* keep the status-only message */
      }
      return { ok: false, error: message };
    }
    invalidateProjectFilesCache(projectId, workspaceContext);
    const result = (await resp.json()) as FigmaImportResult;
    return { ok: true, result };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Multi-file project upload used by the chat composer's paste / drop /
// picker. Each file lands flat in the project folder; the response is
// reshaped into ChatAttachments so the composer can stage them without a
// follow-up listFiles round-trip.
export interface ProjectUploadFailure {
  name: string;
  code?: string;
  error?: string;
}

export interface UploadProjectFilesResult {
  uploaded: ChatAttachment[];
  failed: ProjectUploadFailure[];
  error?: string;
}

export async function uploadProjectFiles(
  projectId: string,
  files: File[],
  dir?: string,
  workspaceContext?: WorkspaceCollabContext | null,
  imageArtifact?: string,
): Promise<UploadProjectFilesResult> {
  if (files.length === 0) return { uploaded: [], failed: [] };

  const targetDir = dir?.trim() ?? '';
  // One request per input owns its failure identity. All callers share admission.
  const outcomes = await Promise.all(files.map((file) => sharedTransferQueue.run(async () => {
    const form = new FormData();
    // Preserve the legacy parser's field ordering and Agency imageArtifact path.
    if (targetDir) form.append('dir', targetDir);
    if (imageArtifact) form.append('imageArtifact', imageArtifact);
    form.append('files', file);
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/upload`, {
        method: 'POST',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
        body: form,
      });
      if (!response.ok) {
        const payload = await readApiErrorBody(response);
        return { uploaded: [], failed: [{ name: file.name, code: payload.code, error: payload.message }], error: payload.message } satisfies UploadProjectFilesResult;
      }
      const payload = await response.json() as { files?: { name: string; path: string; size?: number; originalName?: string }[] };
      const responseFiles = Array.isArray(payload.files) ? payload.files.filter((entry) => typeof entry?.name === 'string' && typeof entry.path === 'string') : [];
      if (responseFiles.length === 0) {
        const error = 'file could not be stored';
        return { uploaded: [], failed: [{ name: file.name, error }], error } satisfies UploadProjectFilesResult;
      }
      invalidateProjectFilesCache(projectId, workspaceContext);
      return { uploaded: responseFiles.map((entry) => ({ path: entry.path, name: entry.originalName ?? entry.name, kind: looksLikeImage(entry.name) ? 'image' as const : 'file' as const, size: entry.size })), failed: [] } satisfies UploadProjectFilesResult;
    } catch {
      const error = 'upload request failed';
      return { uploaded: [], failed: [{ name: file.name, error }], error } satisfies UploadProjectFilesResult;
    }
  })));
  return {
    uploaded: outcomes.flatMap((outcome) => outcome.uploaded),
    failed: outcomes.flatMap((outcome) => outcome.failed),
    error: outcomes.find((outcome) => 'error' in outcome)?.error,
  };
}

// Stable URL that serves a project file with its original mime — for
// thumbnails in the staged-attachment chips and for any preview iframe
// that needs to point at the live file (not a srcDoc).
export function projectRawUrl(
  projectId: string,
  filePath: string,
  _workspaceContext?: WorkspaceCollabContext | null,
): string {
  // Encode each path segment individually so a slash inside the file
  // path stays a path separator, not %2F.
  const safePath = filePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `/api/projects/${encodeURIComponent(projectId)}/raw/${safePath}`;
}

export function designSystemStaticUrl(
  designSystemId: string,
  filePath: string,
  workspaceContext?: WorkspaceCollabContext | null,
): string {
  return workspaceResourceUrl(
    `/api/design-systems/${encodeURIComponent(designSystemId)}/static?path=${encodeURIComponent(filePath)}`,
    workspaceContext,
  );
}

function looksLikeImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i.test(name);
}

export async function deleteProjectFile(
  projectId: string,
  name: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<boolean> {
  try {
    const resp = await fetch(
      projectRawUrl(projectId, name, workspaceContext),
      {
        method: 'DELETE',
        ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
      },
    );
    if (!resp.ok) return false;
    invalidateProjectFilesCache(projectId, workspaceContext);
    return true;
  } catch {
    return false;
  }
}

export async function renameProjectFile(
  projectId: string,
  from: string,
  to: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<RenameProjectFileResponse> {
  const resp = await fetch(`/api/projects/${encodeURIComponent(projectId)}/files/rename`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
    },
    body: JSON.stringify({ from, to }),
  });
  if (!resp.ok) {
    const errorBody = await readApiErrorBody(resp);
    throw new Error(errorBody.message);
  }
  invalidateProjectFilesCache(projectId, workspaceContext);
  return (await resp.json()) as RenameProjectFileResponse;
}

export async function openFolderDialog(options: { throwOnError?: boolean } = {}): Promise<string | null> {
  try {
    const resp = await fetch('/api/dialog/open-folder', { method: 'POST' });
    if (!resp.ok) {
      if (options.throwOnError) {
        const errorBody = await readApiErrorBody(resp);
        throw new Error(errorBody.message);
      }
      return null;
    }
    const data = await resp.json();
    return typeof data.path === 'string' && data.path.length > 0 ? data.path : null;
  } catch (err) {
    if (options.throwOnError) {
      throw err instanceof Error ? err : new Error('Could not open folder picker');
    }
    return null;
  }
}

// Probe whether a local directory still exists on disk. Used by the composer
// to flag a working directory in red the moment its folder is deleted.
export async function dirExists(path: string): Promise<boolean | null> {
  try {
    const resp = await fetch('/api/dir-exists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
    if (!resp.ok) return null; // cannot verify
    const data = await resp.json();
    return typeof data?.exists === 'boolean' ? data.exists : null;
  } catch {
    return null; // daemon unreachable → cannot verify
  }
}

// Global most-recently-used working directories (the local folders the user
// grants the agent read-only awareness of). Persisted in the daemon's
// app-config so they survive browser resets and are shared across projects
// and the `od` CLI. Returns most-recent-first.
export async function fetchRecentLinkedDirs(): Promise<string[]> {
  try {
    // `/api/recent-dirs` returns the list pruned to folders that still exist
    // on disk (and persists the pruning), so deleted folders never linger.
    // Concurrent consumers (composer pickers, project panels) share one read
    // per burst (Batch A §4.3); pushRecentLinkedDir evicts after writing.
    return await coalescedGet('recent-dirs', async () => {
      const resp = await fetch('/api/recent-dirs');
      if (!resp.ok) return [] as string[];
      const data = await resp.json();
      const list = data?.dirs;
      return Array.isArray(list)
        ? list.filter((d: unknown): d is string => typeof d === 'string')
        : [];
    });
  } catch {
    return [];
  }
}

// Record `dir` as the most-recently-used working directory and return the
// updated list. PUT /api/app-config merges per-key, so sending only
// `recentLinkedDirs` leaves every other preference untouched. The daemon
// also trims/de-dupes/caps the list, but we do it client-side too so the
// optimistic UI matches what gets persisted.
export async function pushRecentLinkedDir(dir: string): Promise<string[]> {
  const existing = await fetchRecentLinkedDirs();
  const next = [dir, ...existing.filter((d) => d !== dir)].slice(0, 5);
  try {
    await fetch('/api/app-config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recentLinkedDirs: next }),
    });
  } catch {
    // Daemon offline — the picked dir still applies to this project; the
    // recents list just won't persist for next time.
  }
  // Thin invalidation: the daemon list changed, so the next read must not be
  // answered by the shared burst cache.
  evictCoalescedGet('recent-dirs');
  return next;
}

// "Replace working directory" — points an existing project at a new
// folder. Mirrors the import-folder trust gate but updates the current
// project record instead of creating a new project.
export async function replaceProjectWorkingDir(
  projectId: string,
  baseDir: string,
  desktopImportToken?: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<ReplaceProjectWorkingDirResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (desktopImportToken) {
    headers['x-od-desktop-import-token'] = desktopImportToken;
  }
  if (workspaceContext) {
    Object.assign(headers, workspaceProjectHeaders(workspaceContext));
  }
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/working-dir`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ baseDir }),
    },
  );
  if (!resp.ok) {
    const body = await readApiErrorBody(resp);
    throw new Error(body.message);
  }
  return (await resp.json()) as ReplaceProjectWorkingDirResponse;
}

// Hand-off (open project in local app). The daemon enumerates installed
// editors on demand (PATH probe + macOS bundle scan), and the POST
// endpoint spawns the chosen app with the project's resolvedDir.
export async function fetchHostEditors(): Promise<
  import('@mish/contracts').HostEditorsResponse
> {
  return coalescedGet(
    'host-editors',
    async () => {
      const resp = await fetch('/api/editors');
      if (!resp.ok) throw new Error(`GET /api/editors failed: ${resp.status}`);
      return (await resp.json()) as import('@mish/contracts').HostEditorsResponse;
    },
    IN_FLIGHT_SHARE_ONLY_MS,
  );
}

export async function openProjectInEditor(
  projectId: string,
  editorId: import('@mish/contracts').HostEditorId,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<import('@mish/contracts').OpenProjectInEditorResponse> {
  const resp = await fetch(
    `/api/projects/${encodeURIComponent(projectId)}/open-in`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({ editorId }),
    },
  );
  if (!resp.ok) {
    const body = await readApiErrorBody(resp);
    throw new Error(body.message);
  }
  return (await resp.json()) as import('@mish/contracts').OpenProjectInEditorResponse;
}

export async function fetchDesignSystemPreview(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<string | null> {
  try {
    const resp = await fetch(
      workspaceResourceUrl(
        `/api/design-systems/${encodeURIComponent(id)}/preview`,
        workspaceContext,
      ),
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

export async function fetchDesignSystemShowcase(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<string | null> {
  try {
    const resp = await fetch(
      workspaceResourceUrl(
        `/api/design-systems/${encodeURIComponent(id)}/showcase`,
        workspaceContext,
      ),
      workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : undefined,
    );
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

// Fetch the sandboxed HTML preview the daemon serves for a plugin.
// Mirrors fetchSkillExample's discriminated result so the modal can
// surface a Retry button instead of staying stuck at "Loading…" when
// a plugin ships no preview entry or the asset is missing on disk.
//
// 404 is mapped to `unavailable` (mirroring the skill helper's #897
// behavior) because the daemon returns 404 when the manifest's
// `preview.entry` points at a file that doesn't ship — a missing
// asset for an otherwise valid plugin is not an error the user can
// retry their way out of. Surfacing the calm "no shipped preview"
// placeholder is the truthful UX.
export async function fetchPluginPreviewHtml(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillExampleResult> {
  try {
    const url = `/api/plugins/${encodeURIComponent(id)}/preview`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) return { unavailable: true, kind: 'html' };
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

// Fetch a single example output by stem (matches the basename of the
// `od.useCase.exampleOutputs[].path` minus its extension). 404 is
// mapped to `unavailable` for the same reason as fetchPluginPreviewHtml.
export async function fetchPluginExampleHtml(
  pluginId: string,
  stem: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<SkillExampleResult> {
  try {
    const url =
      `/api/plugins/${encodeURIComponent(pluginId)}/example/${encodeURIComponent(stem)}`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) {
      if (resp.status === 404) return { unavailable: true, kind: 'html' };
      return { error: `HTTP ${resp.status}` };
    }
    return { html: await resp.text() };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'network error';
    return { error: message };
  }
}

// Fetch a raw text asset shipped inside a plugin (DESIGN.md,
// SKILL.md, README.md, etc.). Returns null on any error so the
// caller can fall back to a placeholder; callers that need a
// distinguishable failure should switch to the discriminated
// SkillExampleResult shape used by the HTML helpers above.
export async function fetchPluginAssetText(
  pluginId: string,
  relpath: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<string | null> {
  try {
    const url =
      `/api/plugins/${encodeURIComponent(pluginId)}/asset/${encodePluginAssetPath(relpath)}`;
    const resp = workspaceContext
      ? await fetch(url, { headers: workspaceProjectHeaders(workspaceContext) })
      : await fetch(url);
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  }
}

function encodePluginAssetPath(relpath: string): string {
  return relpath
    .replace(/^\.\//, '')
    .split(/[\\/]/)
    .filter(Boolean)
    .map((seg) => encodeURIComponent(seg))
    .join('/');
}

export async function installSkill(
  input: InstallSkillRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ skill: SkillSummary } | { error: SkillImportError }> {
  try {
    const resp = await fetch('/api/skills/install', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify(input),
    });
    if (!resp.ok) return { error: await readSkillOperationError(resp) };
    const json = await resp.json();
    return json as InstallSkillResponse;
  } catch {
    return { error: { code: 'network_error', message: 'Network error' } };
  }
}

// `workspaceContext`, when present, proves the caller's workspace membership
// against the daemon's `enforceWorkspaceResourceMutation` gate — see
// `deleteSkill` above for the same pattern on the user-authored skill CRUD
// surface; this is the counterpart for the marketplace "已安装" uninstall
// action (`PluginsView.tsx`'s `uninstallResource`).
export async function uninstallSkill(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ ok: true } | { error: string }> {
  try {
    const resp = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(workspaceContext ? { headers: workspaceProjectHeaders(workspaceContext) } : {}),
    });
    const json = await resp.json();
    if (!resp.ok) return { error: readApiErrorMessage(json.error, 'Uninstall failed') };
    return { ok: true };
  } catch {
    return { error: 'Network error' };
  }
}

export async function installDesignSystem(
  input: InstallInput,
): Promise<{ designSystem: DesignSystemSummary } | { error: string }> {
  try {
    const resp = await fetch('/api/design-systems/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
    const json = await resp.json();
    if (!resp.ok) return { error: readApiErrorMessage(json.error, 'Install failed') };
    noteDesignSystemCatalogMutation();
    return json as InstallDesignSystemResponse;
  } catch {
    return { error: 'Network error' };
  }
}

export async function uninstallDesignSystem(
  id: string,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<{ ok: true } | { error: string }> {
  try {
    const resp = await fetch(`/api/design-systems/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      ...(workspaceContext
        ? { headers: workspaceProjectHeaders(workspaceContext) }
        : {}),
    });
    // Success is decided by the status, not by a parsed body: this route can
    // answer an empty 204, and parsing first threw straight into the catch —
    // which also made any bump placed on the success path unreachable.
    if (resp.ok) {
      noteDesignSystemCatalogMutation();
      return { ok: true };
    }
    const json = (await resp.json().catch(() => null)) as { error?: string } | null;
    return { error: readApiErrorMessage(json?.error, 'Uninstall failed') };
  } catch {
    return { error: 'Network error' };
  }
}

// --- OD Library ------------------------------------------------------------

import type {
  LibraryApplyResponse,
  LibraryAsset,
  LibraryAssetListResponse,
  LibraryConnectionStatus,
  LibraryEditAsPageResponse,
  LibraryIngestResponse,
  LibraryPairingStartResponse,
  LibrarySyncResponse,
} from '@mish/contracts';
import { LIBRARY_UPLOAD_MAX_BYTES, isLibraryUploadMimeAllowed } from '@mish/contracts';

/** Raw bytes URL for a library asset (image src / download href). */
export function libraryAssetRawUrl(id: string): string {
  return `/api/library/assets/${encodeURIComponent(id)}/raw`;
}

/** Explicit opaque-origin interactive viewing; raw byte links remain inert. */
export function libraryAssetPreviewUrl(id: string, context?: WorkspaceCollabContext | null): string {
  return workspaceResourceUrl(`/api/library/assets/${encodeURIComponent(id)}/preview`, context);
}

/**
 * OD Figma capture download URL — only meaningful for clipper-captured `html`
 * assets whose `metadata.figmaCapture` marker is set. Importable via the OD
 * Figma plugin.
 */
export function libraryAssetFigmaUrl(id: string): string {
  return `/api/library/assets/${encodeURIComponent(id)}/figma`;
}

/**
 * Captured-element markup URL — only meaningful for element-pick screenshot
 * assets whose `metadata.element.hasHtml` is set. Returns the element's
 * `outerHTML` as `text/html`.
 */
export function libraryAssetElementUrl(id: string): string {
  return `/api/library/assets/${encodeURIComponent(id)}/element`;
}

export interface LibraryAssetQuery {
  kind?: string;
  source?: string;
  q?: string;
  date?: string;
  tag?: string;
}

export async function fetchLibraryAssets(query: LibraryAssetQuery = {}): Promise<LibraryAsset[]> {
  try {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value) params.set(key, value);
    }
    const qs = params.toString();
    const resp = await fetch(`/api/library/assets${qs ? `?${qs}` : ''}`);
    if (!resp.ok) return [];
    const json = (await resp.json()) as LibraryAssetListResponse;
    return json.assets ?? [];
  } catch {
    return [];
  }
}

/**
 * Fetch a single library asset by id (`GET /api/library/assets/:id`). Returns
 * null when the asset is gone or the request fails. Powers the Library grid's
 * incremental SSE merge — on an `ingest` event we hydrate just the one asset
 * instead of refetching the whole list.
 */
export async function fetchLibraryAsset(id: string): Promise<LibraryAsset | null> {
  try {
    const resp = await fetch(`/api/library/assets/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const json = (await resp.json()) as { asset?: LibraryAsset };
    return json.asset ?? null;
  } catch {
    return null;
  }
}

/**
 * Copy a library asset into a project's design files (default `library/`
 * subdir) and record a provenance back-link so the registry knows the asset
 * was consumed. Powers "Select from library" in the composer and Design Files.
 * With `includeElement`, an element-pick capture also materializes its captured
 * markup as a companion `.element.html` file (see `elementRelPath`). Returns the
 * apply response (`relPath` + optional `elementRelPath`), or null on error.
 */
export async function applyLibraryAsset(
  assetId: string,
  projectId: string,
  dir?: string,
  opts?: { includeElement?: boolean },
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<LibraryApplyResponse | null> {
  try {
    const resp = await fetch(`/api/library/assets/${encodeURIComponent(assetId)}/apply`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}),
      },
      body: JSON.stringify({
        projectId,
        ...(dir ? { dir } : {}),
        ...(opts?.includeElement ? { includeElement: true } : {}),
      }),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as LibraryApplyResponse;
  } catch {
    return null;
  }
}

/**
 * Fetch the captured `outerHTML` of an element-pick library asset (served from
 * `/api/library/assets/:id/element`). Returns null when the asset has no stored
 * element markup or the request fails.
 */
export async function fetchLibraryAssetElementHtml(assetId: string): Promise<string | null> {
  try {
    const resp = await fetch(libraryAssetElementUrl(assetId));
    if (!resp.ok) return null;
    const html = await resp.text();
    return html.trim() ? html : null;
  } catch {
    return null;
  }
}

/**
 * Turn a captured `html` library asset into a brand-new editable OD project.
 * The daemon copies the capture into the project as an editable `index.html`
 * and seeds a conversation; the caller opens the project on that file. Returns
 * null on error.
 */
export async function editLibraryAssetAsPage(
  assetId: string,
): Promise<LibraryEditAsPageResponse | null> {
  try {
    const resp = await fetch(`/api/library/assets/${encodeURIComponent(assetId)}/edit-as-page`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) return null;
    return (await resp.json()) as LibraryEditAsPageResponse;
  } catch {
    return null;
  }
}

const LIBRARY_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'image/avif': '.avif',
  'image/bmp': '.bmp',
  'text/html': '.html',
  'text/css': '.css',
  'application/json': '.json',
};

/** A filesystem-safe filename for a library asset, with an extension by mime. */
function libraryAssetFileName(asset: LibraryAsset, mime: string): string {
  const fallback = `asset-${asset.id.slice(0, 8)}`;
  const base =
    (asset.sourceTitle || asset.sourceDomain || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || fallback;
  const ext =
    LIBRARY_MIME_EXT[mime] ||
    (mime.startsWith('image/') ? `.${mime.slice(6).split('+')[0]}` : '');
  return `${base}${ext}`;
}

/**
 * Fetch a library asset's bytes and wrap them in a `File`, so the asset can be
 * fed into upload-shaped flows that expect browser File objects (e.g. seeding
 * the design-system creation flow's source material). Returns null on error.
 */
export async function fetchLibraryAssetAsFile(asset: LibraryAsset): Promise<File | null> {
  if (asset.kind === 'file') return null;
  try {
    const resp = await fetch(libraryAssetRawUrl(asset.id));
    if (!resp.ok) return null;
    const blob = await resp.blob();
    const type = asset.mime || blob.type || 'application/octet-stream';
    return new File([blob], libraryAssetFileName(asset, type), { type });
  } catch {
    return null;
  }
}

export async function deleteLibraryAsset(id: string): Promise<boolean> {
  try {
    const resp = await fetch(`/api/library/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return resp.ok;
  } catch {
    return false;
  }
}

/**
 * Force a Library reconcile (`POST /api/library/sync`) — pulls design systems
 * and agent-produced project deliverables into the Library as referenced assets.
 * Powers the Library toolbar "Sync" button. Returns the counts of what was newly
 * indexed, or null on error.
 */
export async function syncLibrary(): Promise<LibrarySyncResponse | null> {
  try {
    const resp = await fetch('/api/library/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    if (!resp.ok) return null;
    return (await resp.json()) as LibrarySyncResponse;
  } catch {
    return null;
  }
}

// --- manual upload ---------------------------------------------------------

/** Outcome of a single manual upload — drives the per-file status in the UI. */
export interface LibraryUploadOutcome {
  ok: boolean;
  asset?: LibraryAsset;
  deduped?: boolean;
  /** Human-readable failure reason (policy reject, oversize, network…). */
  error?: string;
  /** Daemon error code when the failure came back from the server. */
  code?: string;
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error('file read failed'));
    reader.readAsDataURL(file);
  });
}

async function readLibraryUploadError(resp: Response): Promise<{ error: string; code?: string }> {
  const payload = (await resp.json().catch(() => null)) as
    | { error?: { message?: string; code?: string } | string }
    | null;
  const err = payload?.error;
  if (typeof err === 'object' && err) {
    return { error: err.message ?? `Upload failed (${resp.status})`, ...(err.code ? { code: err.code } : {}) };
  }
  return { error: typeof err === 'string' && err ? err : `Upload failed (${resp.status})` };
}

/**
 * Upload one file into the Library through the manual-upload ingest path.
 *
 * Runs the shared format/size policy as a pre-flight so an unsupported or
 * oversized file fails instantly with a friendly message instead of a wasted
 * round-trip, then posts the bytes inline as a `data:` URI. The daemon enforces
 * the same policy as the source of truth.
 */
export async function uploadLibraryFile(file: File): Promise<LibraryUploadOutcome> {
  if (file.size > LIBRARY_UPLOAD_MAX_BYTES) {
    return {
      ok: false,
      code: 'PAYLOAD_TOO_LARGE',
      error: `Too large — max ${Math.round(LIBRARY_UPLOAD_MAX_BYTES / 1_000_000)} MB`,
    };
  }
  if (!isLibraryUploadMimeAllowed(file.type || undefined, file.name)) {
    return { ok: false, code: 'UNSUPPORTED_MEDIA_TYPE', error: 'Unsupported format' };
  }
  try {
    const dataUrl = await readFileAsDataUrl(file);
    const resp = await fetch('/api/library/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataUrl, filename: file.name, mime: file.type || undefined }),
    });
    if (!resp.ok) {
      return { ok: false, ...(await readLibraryUploadError(resp)) };
    }
    const json = (await resp.json()) as LibraryIngestResponse;
    return { ok: true, asset: json.asset, deduped: json.deduped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

/** Upload a pasted/typed text snippet as a text-family Library asset. */
export async function uploadLibraryText(
  text: string,
  opts: { filename?: string } = {},
): Promise<LibraryUploadOutcome> {
  try {
    const resp = await fetch('/api/library/ingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...(opts.filename ? { filename: opts.filename } : {}) }),
    });
    if (!resp.ok) {
      return { ok: false, ...(await readLibraryUploadError(resp)) };
    }
    const json = (await resp.json()) as LibraryIngestResponse;
    return { ok: true, asset: json.asset, deduped: json.deduped };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Upload failed' };
  }
}

export async function startLibraryPairing(): Promise<LibraryPairingStartResponse | null> {
  try {
    const resp = await fetch('/api/library/pair', { method: 'POST' });
    if (!resp.ok) return null;
    return (await resp.json()) as LibraryPairingStartResponse;
  } catch {
    return null;
  }
}

export async function fetchLibraryConnection(): Promise<LibraryConnectionStatus | null> {
  try {
    const resp = await fetch('/api/library/connection');
    if (!resp.ok) return null;
    return (await resp.json()) as LibraryConnectionStatus;
  } catch {
    return null;
  }
}

// The fast-lane build job (`/api/agency/build`, design 2026-09-20 §6.6). Every endpoint is local
// same-origin only, so these are same-origin fetches with no headers of their own; the daemon
// takes the workspace scope from the request that starts the build and forwards it to the project
// it publishes. Nothing here starts on its own — a build spends model credit, so it waits for the
// Route panel's Build button.

export type WebAgencyBuildStart =
  | { ok: true; build: AgencyBuildSnapshot }
  /** The daemon refused before anything started. `code` is what the UI renders a sentence from —
   * never the daemon's own English message, which has no locale. `MOTIONSITES_LOGIN_REQUIRED` /
   * `MOTIONSITES_PAID_ACCESS_REQUIRED` are `sectionSelection.designReferenceId`'s own preflight
   * refusals (sol-design.md §1/§2) — the daemon checks the reference before starting the build,
   * so these arrive the same way `JEV_UNAVAILABLE` does, never as a build error after the fact. */
  | { ok: false; code: 'JEV_UNAVAILABLE' | 'BUILD_BUSY' | 'MOTIONSITES_LOGIN_REQUIRED' | 'MOTIONSITES_PAID_ACCESS_REQUIRED' | AgencyBuildDesignKitRefusalCode | 'REQUEST_FAILED' };

/** `GET /api/sections`'s result for the section picker: the merged catalog (filtered server-side
 * by `spine`/`kind`), the five design directions a `sectionSelection.directionId` may name, and
 * — only when the federated MotionSites half degraded — an `upstream` note. `ok: false` covers
 * any transport/parse failure; the picker treats it the same as "no sections available yet". */
export type WebSectionsList =
  | {
      ok: true;
      entries: SectionCatalogEntry[];
      directions: SectionCatalogDirectionOption[];
      upstream?: { code: 'MOTIONSITES_UPSTREAM_UNAVAILABLE'; message: string };
    }
  | { ok: false };

/** `GET /api/motionsites/connection`'s status only — the picker's own access label ("Free
 * account" / "Paid access" / "Sign in") needs to know whether the daemon has a usable MotionSites
 * connection, the same way `od sections`'s human output does. `null` on any transport failure;
 * the picker then falls back to "Sign in" for a gated entry, which is the safe reading (an
 * unreachable connection status is not proof of a connection). */
export async function fetchMotionSitesConnectionStatus(): Promise<'not_connected' | 'connected' | 'expired' | null> {
  try {
    const resp = await fetch('/api/motionsites/connection', { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = (await resp.json()) as { status?: unknown };
    return json.status === 'connected' || json.status === 'expired' || json.status === 'not_connected' ? json.status : null;
  } catch {
    return null;
  }
}

export async function fetchSections(filter: { spine?: SectionCatalogSpineCode; kind?: SectionCatalogSectionKind } = {}): Promise<WebSectionsList> {
  try {
    const query = new URLSearchParams();
    if (filter.spine) query.set('spine', filter.spine);
    if (filter.kind) query.set('kind', filter.kind);
    const qs = query.toString();
    const resp = await fetch(`/api/sections${qs ? `?${qs}` : ''}`, { cache: 'no-store' });
    if (!resp.ok) return { ok: false };
    const json = (await resp.json()) as SectionsListResponse;
    // Validates the `catalog` shape only (an untrusted daemon response boundary — see
    // parseSectionCatalogResponse's own module header); `directions`/`upstream` are this route's
    // own fields, read straight from the parsed JSON alongside it.
    const parsed = parseSectionCatalogResponse(json);
    return {
      ok: true,
      entries: parsed.catalog.entries,
      directions: Array.isArray(json.directions) ? json.directions : [],
      ...(json.upstream ? { upstream: json.upstream } : {}),
    };
  } catch {
    return { ok: false };
  }
}

export async function startAgencyBuild(request: AgencyBuildRequest): Promise<WebAgencyBuildStart> {
  try {
    const resp = await fetch('/api/agency/build', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!resp.ok) {
      // The envelope's `code` is the daemon's own name for what happened; the status is only a
      // fallback for an answer that has no envelope at all (a proxy's 503, a dropped body).
      const code = await startFailureCode(resp);
      return { ok: false, code };
    }
    const json = (await resp.json()) as AgencyBuildResponse;
    return { ok: true, build: json.build };
  } catch {
    return { ok: false, code: 'REQUEST_FAILED' };
  }
}

async function startFailureCode(resp: Response): Promise<Exclude<WebAgencyBuildStart, { ok: true }>['code']> {
  try {
    const body = (await resp.json()) as { error?: { code?: string } };
    if (body?.error?.code === 'JEV_UNAVAILABLE') return 'JEV_UNAVAILABLE';
    if (body?.error?.code === 'BUILD_BUSY') return 'BUILD_BUSY';
    if (body?.error?.code === 'MOTIONSITES_LOGIN_REQUIRED') return 'MOTIONSITES_LOGIN_REQUIRED';
    if (body?.error?.code === 'MOTIONSITES_PAID_ACCESS_REQUIRED') return 'MOTIONSITES_PAID_ACCESS_REQUIRED';
    // A named design kit refused before the build started (`AgencyBuildRequest.designSystemId`).
    if (body?.error?.code === 'DESIGN_SYSTEM_NOT_SELECTABLE') return 'DESIGN_SYSTEM_NOT_SELECTABLE';
    if (body?.error?.code === 'DESIGN_SYSTEM_TOKENS_UNUSABLE') return 'DESIGN_SYSTEM_TOKENS_UNUSABLE';
  } catch {
    // No envelope: fall through to the status.
  }
  if (resp.status === 503) return 'JEV_UNAVAILABLE';
  if (resp.status === 409) return 'BUILD_BUSY';
  // Deliberately NO status-only fallback for 401/403 → MotionSites (delta audit finding 4): a
  // 401/403 from any other cause — a future auth layer, a proxy — would otherwise be mislabeled
  // as a MotionSites access problem. Only the daemon's own envelope code (checked above) may
  // report either MotionSites code; a 401/403 with no envelope, or one this parser could not
  // read, is the generic failure sentence instead.
  return 'REQUEST_FAILED';
}

export async function fetchAgencyBuild(buildId: string): Promise<AgencyBuildSnapshot | null> {
  try {
    const resp = await fetch(`/api/agency/builds/${encodeURIComponent(buildId)}`, { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = (await resp.json()) as AgencyBuildResponse;
    return json.build;
  } catch {
    return null;
  }
}

/** The builds this daemon still remembers, newest first — survives a restart up to
 * `AGENCY_BUILD_HISTORY_LIMIT`. An empty list on failure, same as `fetchAgencyBuild`'s `null`:
 * the Route panel's recent-builds list has nothing to show either way. */
export async function listAgencyBuilds(): Promise<AgencyBuildListItem[]> {
  try {
    const resp = await fetch('/api/agency/builds', { cache: 'no-store' });
    if (!resp.ok) return [];
    const json = (await resp.json()) as AgencyBuildListResponse;
    return json.builds;
  } catch {
    return [];
  }
}

export type WebAgencyBuildFork =
  | { ok: true; build: AgencyBuildSnapshot }
  | {
      ok: false;
      code: 'JEV_UNAVAILABLE' | 'BUILD_BUSY' | 'BUILD_NOT_FOUND' | 'BUILD_NOT_FORKABLE'
        | 'MOTIONSITES_LOGIN_REQUIRED' | 'MOTIONSITES_PAID_ACCESS_REQUIRED' | 'REQUEST_FAILED';
    };

/** A family's optional sections, or `ok: false` when the daemon could not answer. */
export type WebAgencyFamilySections =
  | { ok: true; sections: AgencyFamilyOptionalSection[]; outputScope?: AgencyOutputScope }
  | { ok: false };

/**
 * A family's optional sections, for the keep/drop controls (Build panel and "Start from this
 * build") — the same endpoint `od agency sections <family>` reads. A failed request (HTTP error,
 * network error, unreadable body) is `ok: false`, never an empty list: an empty list means the
 * family has no optional sections, and the controls must not vanish as if it had none.
 */
export async function fetchAgencyFamilySections(family: string): Promise<WebAgencyFamilySections> {
  try {
    const resp = await fetch(`/api/agency/families/${encodeURIComponent(family)}/sections`);
    if (!resp.ok) return { ok: false };
    const json = (await resp.json()) as AgencyFamilySectionsResponse;
    if (!Array.isArray(json?.sections)) return { ok: false };
    return {
      ok: true,
      sections: json.sections.filter((section) => typeof section?.id === 'string' && typeof section.label === 'string'),
      // C16: only the two known scopes are trusted; anything else is treated as unlabelled.
      ...(json.outputScope === 'site' || json.outputScope === 'static-prototype' ? { outputScope: json.outputScope } : {}),
    };
  } catch {
    return { ok: false };
  }
}

export type WebAgencyFamilyEffects =
  | { ok: true; offer: AgencyFamilyEffectsResponse }
  | { ok: false };

/**
 * A family's effect placements and the reviewed components each allows, for the Build panel's
 * Effects block — the same endpoint `od agency effects <family>` reads. A failed or malformed
 * answer is `{ ok: false }`, never an empty offer: "offers nothing" is a real answer of its own.
 */
export async function fetchAgencyFamilyEffects(family: string): Promise<WebAgencyFamilyEffects> {
  try {
    const resp = await fetch(`/api/agency/families/${encodeURIComponent(family)}/effects`);
    if (!resp.ok) return { ok: false };
    const parsed = parseAgencyFamilyEffectsResponse(await resp.json());
    return parsed.ok ? { ok: true, offer: parsed.value } : { ok: false };
  } catch {
    return { ok: false };
  }
}

/** "Start from this build": same endpoint `od agency build --from` drives. `brief` overrides the
 * saved build's own brief text; omit it to reuse that build's brief verbatim. `sections` merges
 * over the saved build's hints id by id (`auto` clears one); omit it to reuse them as they are. */
export async function forkAgencyBuild(
  buildId: string,
  options: {
    brief?: string;
    sections?: AgencyBuildForkRequest['sections'];
    /** Replaces the saved build's `sectionSelection`; `null` clears it. Omit to reuse it as-is. */
    sectionSelection?: AgencyBuildForkRequest['sectionSelection'];
    /** Replaces the saved build's `designReferenceId` (re-fetched fresh); `null` clears it. Omit
     * to reuse the saved id. Mutually exclusive with `designReferenceText`. */
    designReferenceId?: AgencyBuildForkRequest['designReferenceId'];
    designReferenceText?: AgencyBuildForkRequest['designReferenceText'];
  } = {},
): Promise<WebAgencyBuildFork> {
  try {
    const request: AgencyBuildForkRequest = {
      ...(options.brief ? { brief: options.brief } : {}),
      ...(options.sections && Object.keys(options.sections).length > 0 ? { sections: options.sections } : {}),
      ...(options.sectionSelection !== undefined ? { sectionSelection: options.sectionSelection } : {}),
      ...(options.designReferenceId !== undefined ? { designReferenceId: options.designReferenceId } : {}),
      ...(options.designReferenceText !== undefined ? { designReferenceText: options.designReferenceText } : {}),
    };
    const resp = await fetch(`/api/agency/builds/${encodeURIComponent(buildId)}/fork`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    if (!resp.ok) {
      const code = await forkFailureCode(resp);
      return { ok: false, code };
    }
    const json = (await resp.json()) as AgencyBuildForkResponse;
    return { ok: true, build: json.build };
  } catch {
    return { ok: false, code: 'REQUEST_FAILED' };
  }
}

async function forkFailureCode(resp: Response): Promise<Exclude<WebAgencyBuildFork, { ok: true }>['code']> {
  try {
    const body = (await resp.json()) as { error?: { code?: string } };
    if (body?.error?.code === 'JEV_UNAVAILABLE') return 'JEV_UNAVAILABLE';
    if (body?.error?.code === 'BUILD_BUSY') return 'BUILD_BUSY';
    if (body?.error?.code === 'BUILD_NOT_FOUND') return 'BUILD_NOT_FOUND';
    if (body?.error?.code === 'BUILD_NOT_FORKABLE') return 'BUILD_NOT_FORKABLE';
    if (body?.error?.code === 'MOTIONSITES_LOGIN_REQUIRED') return 'MOTIONSITES_LOGIN_REQUIRED';
    if (body?.error?.code === 'MOTIONSITES_PAID_ACCESS_REQUIRED') return 'MOTIONSITES_PAID_ACCESS_REQUIRED';
  } catch {
    // No envelope: fall through to the status.
  }
  if (resp.status === 503) return 'JEV_UNAVAILABLE';
  // Deliberately no status-only 401/403 fallback here either — see `startFailureCode`'s own note
  // (delta audit finding 4).
  // Unlike `startFailureCode`'s 409 (which only ever means `BUILD_BUSY`), this endpoint's 409
  // covers two different daemon codes — busy and not-forkable — so a status-only fallback (no
  // envelope, or one this parser missed) cannot honestly guess which one happened. Reporting
  // `REQUEST_FAILED` here is the generic failure sentence; guessing `BUILD_BUSY` would tell
  // someone the daemon is busy when their saved build was simply never publishable.
  if (resp.status === 404) return 'BUILD_NOT_FOUND';
  return 'REQUEST_FAILED';
}

/** Asks the daemon to stop the build. Idempotent, and a finished build simply answers itself. */
export async function cancelAgencyBuild(buildId: string): Promise<void> {
  try {
    await fetch(`/api/agency/builds/${encodeURIComponent(buildId)}/cancel`, { method: 'POST' });
  } catch {
    // The stream is what tells the UI what happened; a failed cancel just means it did not stop.
  }
}

export type AgencyBuildRepairErrorCode =
  | 'JEV_UNAVAILABLE'
  | 'BUILD_NOT_FOUND'
  | 'BUILD_NOT_REPAIRABLE'
  | 'BUILD_REPAIR_IN_PROGRESS'
  | 'REQUEST_FAILED';

/**
 * Thrown by `repairAgencyBuild` on any refusal or failure — the code the UI renders a sentence
 * from, same as every other build endpoint's `code`. `BUILD_NOT_REPAIRABLE` is the one exception
 * to "never the daemon's own message": its `message` IS the daemon's own reason (`designIndex.
 * build.error.notRepairable` interpolates it), because that reason is already a fixed, honest
 * fact about the build ("nothing is flagged") rather than free text.
 */
export class AgencyBuildRepairError extends Error {
  code: AgencyBuildRepairErrorCode;
  constructor(code: AgencyBuildRepairErrorCode, message: string) {
    super(message);
    this.name = 'AgencyBuildRepairError';
    this.code = code;
  }
}

async function repairFailure(resp: Response): Promise<AgencyBuildRepairError> {
  try {
    const body = (await resp.json()) as { error?: { code?: string; message?: string } };
    const message = body?.error?.message ?? 'The request failed.';
    switch (body?.error?.code) {
      case 'JEV_UNAVAILABLE':
      case 'BUILD_NOT_FOUND':
      case 'BUILD_NOT_REPAIRABLE':
      case 'BUILD_REPAIR_IN_PROGRESS':
        return new AgencyBuildRepairError(body.error!.code as AgencyBuildRepairErrorCode, message);
      default:
        break;
    }
  } catch {
    // No envelope: fall through to the status.
  }
  if (resp.status === 503) return new AgencyBuildRepairError('JEV_UNAVAILABLE', 'Jev is not available on this daemon');
  if (resp.status === 404) return new AgencyBuildRepairError('BUILD_NOT_FOUND', 'The request failed.');
  return new AgencyBuildRepairError('REQUEST_FAILED', 'The request failed.');
}

/**
 * The repair pass for a `verify: 'after'` build (`POST .../:id/repair`) — see
 * `AgencyBuildRepairResponse`. Synchronous on the daemon's side, so unlike a build start or a
 * fork there is no "started, watch it" shape to hand back on failure: the response IS the
 * outcome, so a failure rejects with `AgencyBuildRepairError` rather than an `ok: false` result.
 */
export async function repairAgencyBuild(buildId: string): Promise<AgencyBuildRepairResponse> {
  let resp: Response;
  try {
    resp = await fetch(`/api/agency/builds/${encodeURIComponent(buildId)}/repair`, { method: 'POST' });
  } catch {
    throw new AgencyBuildRepairError('REQUEST_FAILED', 'The request failed.');
  }
  if (!resp.ok) throw await repairFailure(resp);
  return (await resp.json()) as AgencyBuildRepairResponse;
}

/**
 * Subscribes to one build's progress.
 *
 * `EventSource` is used rather than a streamed fetch because the browser's own reconnect is
 * exactly what this stream is built for: the daemon sends each event with its `seq` as the SSE id
 * and honours `Last-Event-ID`, so a dropped connection resumes without dropping or repeating an
 * event. The caller closes the returned source; `status` is terminal and arrives exactly once.
 */
export function agencyBuildEvents(
  buildId: string,
  handlers: { onEvent: (event: AgencyBuildEvent) => void; onStatus: (build: AgencyBuildSnapshot) => void; onError?: () => void },
): EventSource {
  const source = new EventSource(`/api/agency/builds/${encodeURIComponent(buildId)}/events`);
  source.addEventListener('build-event', (message) => {
    try {
      handlers.onEvent(JSON.parse((message as MessageEvent).data) as AgencyBuildEvent);
    } catch {
      // A malformed record is dropped rather than aborting the stream.
    }
  });
  source.addEventListener('status', (message) => {
    try {
      handlers.onStatus(JSON.parse((message as MessageEvent).data) as AgencyBuildSnapshot);
    } catch {
      handlers.onError?.();
    }
    source.close();
  });
  source.onerror = () => {
    // The browser reconnects on its own with `Last-Event-ID`; only a closed source is a failure.
    if (source.readyState === EventSource.CLOSED) handlers.onError?.();
  };
  return source;
}

/** Approve exactly the revision shown by the picker; a changed kit requires reinspection. */
export async function setDesignSystemApproval(
  id: string,
  input: import('@mish/contracts').SetDesignSystemApprovalRequest,
  workspaceContext?: WorkspaceCollabContext | null,
): Promise<DesignSystemSummary | null> {
  try {
    const response = await fetch(`/api/design-systems/${encodeURIComponent(id)}/approval`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}) },
      body: JSON.stringify(input),
    });
    if (!response.ok) return null;
    noteDesignSystemCatalogMutation();
    return (await response.json()).designSystem ?? null;
  } catch { return null; }
}
