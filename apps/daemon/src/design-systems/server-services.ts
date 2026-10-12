import { DesignSystemGenerationRefusal } from './generation-reader.js';
import { designSystemRunNotice } from '@open-design/contracts';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import {
  readTeamResourceMaterialization,
  teamResourceWorkspaceRoot,
} from '../collab/team-resource-materialization.js';
import {
  getWorkspaceProjectByProjectId,
  getWorkspaceResourceByResourceId,
} from '../db.js';
import { workspaceTeamSkillBindingAllowsRead } from '../skills/workspace-team-binding.js';
import { workspaceTeamDesignSystemBindingAllowsRead } from './workspace-team-binding.js';
import { syncDesignSystemPackageIntoProject } from './workspace-sync.js';
import { createDesignSystemListingCache } from './listing-cache.js';
import {
  designSystemPublishCommand,
  designSystemSelectability,
  type DesignSystemSelectabilityResult,
} from './selectability.js';

type JsonRecord = Record<string, unknown>;
type SkillEntry = { id: string; dir?: string } & JsonRecord;
type DesignSystemSummary = {
  id: string;
  source?: string;
  status?: string;
  title?: string;
  updatedAt?: string;
  projectId?: string;
  teamSynced?: boolean;
  workspaceId?: string;
  approval?: import('@open-design/contracts').DesignSystemApproval;
} & JsonRecord;

function selectabilityInput(summary: DesignSystemSummary) {
  return {
    id: summary.id,
    ...(summary.approval ? { approval: summary.approval as import('@open-design/contracts').DesignSystemApproval } : {}),
    title: typeof summary.title === 'string' ? summary.title : summary.id,
    ...(summary.status === 'draft' || summary.status === 'published'
      ? { status: summary.status as 'draft' | 'published' }
      : {}),
  };
}

type DesignSystemStaticFile = {
  bytes: Buffer;
  contentType: string;
  updatedAt: string;
} & JsonRecord;

type ProjectRecord = {
  id: string;
  name?: string;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string | null;
  metadata?: JsonRecord;
  createdAt?: number;
  updatedAt?: number;
} & JsonRecord;

type ProjectInsert = {
  id: string;
  name?: string | null;
  skillId?: string | null;
  designSystemId?: string | null;
  pendingPrompt?: string | null;
  metadata?: JsonRecord;
  createdAt: number;
  updatedAt: number;
};

type ProjectPatch = Partial<Omit<ProjectInsert, 'id' | 'createdAt'>> & {
  updatedAt?: number;
};

type DesignSystemListOptions = {
  freshApproval?: boolean;
  approvalReceiptRoot?: string;
  publishedApprovalSeed?: boolean;
  idPrefix?: string;
  source?: string;
  isEditable?: boolean;
  defaultStatus?: string;
  workspaceId?: string | null;
};

type DesignSystemWorkspaceOptions = {
  workspaceId?: string | null;
  workspaceMemberId?: string | null;
  /** A verified Team binding forbids same-id Personal fallback. */
  exactTeam?: boolean;
};

export type DesignSystemAssetSyncOutcome =
  | { ok: true; synced: string[] }
  | { ok: false; reason: 'not-found' | 'no-workspace-project' };

/**
 * A design system's persisted `workspace_resources` binding is the visibility
 * authority for a verified Workspace+member scope. The on-disk `metadata.json`
 * claim is deliberately NOT consulted here: a brand re-finalize can drop the
 * `workspaceId` claim while the envelope keeps the binding correct (issue
 * #6763), so the envelope alone must decide for `visibility: 'personal'`
 * systems. Mirrors `skillVisibleFromBinding` in `skills.ts`.
 */
function designSystemBindingAllowsRead(
  binding: ReturnType<typeof getWorkspaceResourceByResourceId>,
  workspaceId: string,
  workspaceMemberId: string,
): boolean {
  return Boolean(
    binding
    && binding.workspaceId === workspaceId
    && binding.visibility === 'personal'
    && binding.resourceState !== 'deleted'
    && binding.createdByWorkspaceMemberId === workspaceMemberId,
  );
}

type DesignSystemUserReadScope = {
  workspaceId?: string | null;
  workspaceMemberId?: string | null;
};

/**
 * Read options for a `user:` design-system directory read. `null` means the
 * caller must NOT read the system at all (fail-closed). When the request
 * carries a verified Workspace+member scope whose binding matches exactly,
 * read the FS copy UNSCOPED (issue #6763) so an ownerless-but-bound system
 * stays readable after a re-finalize dropped its metadata claim; otherwise
 * keep the current metadata-gated read so claimed/hidden states behave as
 * before. An explicit signed-out/incomplete scope hides envelope-bound
 * systems, mirroring the catalog lane (spec 04 §10).
 */
function designSystemUserReadOptions(
  db: Database.Database | undefined,
  id: string,
  scope: DesignSystemUserReadScope,
): Pick<DesignSystemListOptions, 'idPrefix' | 'workspaceId'> | null {
  const workspaceId = scope.workspaceId?.trim();
  const workspaceMemberId = scope.workspaceMemberId?.trim();
  const metadataGated: Pick<DesignSystemListOptions, 'idPrefix' | 'workspaceId'> = {
    idPrefix: 'user:',
    ...(scope.workspaceId !== undefined ? { workspaceId: scope.workspaceId } : {}),
  };
  if (scope.workspaceId !== undefined && (!workspaceId || !workspaceMemberId)) {
    // Explicit signed-out/incomplete scope (`null`, `''`, or a memberless
    // positive workspace): a persisted envelope is positive evidence the
    // resource is not local-public and must stay hidden.
    if (db && getWorkspaceResourceByResourceId(db, 'design_system', id)) return null;
    return metadataGated;
  }
  if (!db || !workspaceId || !workspaceMemberId) return metadataGated;
  const binding = getWorkspaceResourceByResourceId(db, 'design_system', id);
  if (designSystemBindingAllowsRead(binding, workspaceId, workspaceMemberId)) {
    // Issue #6763: the binding is authoritative even when a re-finalize
    // dropped `workspaceId` from metadata.json — read the FS copy unscoped.
    return { idPrefix: 'user:' };
  }
  return metadataGated;
}

export function createDesignSystemServerServices({
  getDb,
  roots,
  paths,
  skills,
  designSystems,
  projects,
  bindProjectToWorkspace,
}: {
  // Only consulted by `listAllSkills` below for its optional workspace scope
  // filter — every other service in this factory stays filesystem-only. A
  // getter (not the db value itself) because this factory runs BEFORE
  // server.ts opens its database connection; the closure defers the read
  // until a request actually needs it, long after `openDatabase()` has run.
  getDb?: () => Database.Database;
  roots: {
    SKILL_ROOTS: string[];
    DESIGN_TEMPLATE_ROOTS: string[];
    ALL_SKILL_LIKE_ROOTS: string[];
  };
  paths: {
    PROJECTS_DIR: string;
    DESIGN_SYSTEMS_DIR: string;
    USER_DESIGN_SYSTEMS_DIR: string;
  };
  skills: {
    listSkills: (
      roots: string[],
      options?: {
        db?: Database.Database;
        workspaceId?: string | null;
        workspaceMemberId?: string | null;
      },
    ) => Promise<SkillEntry[]>;
    findSkillById: (skills: SkillEntry[], id: string) => SkillEntry | undefined;
  };
  designSystems: {
    listDesignSystems: (root: string, options?: DesignSystemListOptions) => Promise<DesignSystemSummary[]>;
    readDesignSystem: (root: string, id: string, options?: Pick<DesignSystemListOptions, 'idPrefix' | 'workspaceId'>) => Promise<string | null | undefined>;
    readDesignSystemPackageInfo: (root: string, id: string, options?: Pick<DesignSystemListOptions, 'idPrefix' | 'workspaceId'>) => Promise<unknown>;
    readDesignSystemStaticFile: (root: string, id: string, filePath: string, options?: Pick<DesignSystemListOptions, 'idPrefix' | 'workspaceId'>) => Promise<DesignSystemStaticFile | null | undefined>;
    listUserDesignSystemFiles: (root: string, id: string) => Promise<Array<{ kind?: string; path: string; size?: number; updatedAt?: string }> | null | undefined>;
    readUserDesignSystemFile: (root: string, id: string, filePath: string) => Promise<{ path: string; content: string } | null | undefined>;
    readUserDesignSystemFileBytes: (root: string, id: string, filePath: string) => Promise<{ path: string; bytes: Buffer } | null | undefined>;
    linkUserDesignSystemProject: (root: string, id: string, projectId: string) => Promise<unknown>;
    // Physically copies real asset bytes (sourced from a workspace project's
    // editing mirror) into the canonical assets/ dir and un-fingerprints them
    // so the generator never overwrites them again (spec 04 §9.3).
    syncUserDesignSystemAssetsFromFiles: (
      root: string,
      id: string,
      files: Array<{ path: string; content: Buffer }>,
    ) => Promise<{ synced: string[] }>;
    LEGACY_DESIGN_SYSTEM_ARTIFACTS: Array<{
      replacementPaths: string[];
      legacyPath: string;
      removeDirectory?: boolean;
    }>;
  };
  projects: {
    getProject: (db: Database.Database, id: string) => ProjectRecord | null | undefined;
    insertProject: (db: Database.Database, project: ProjectInsert) => ProjectRecord | null | undefined;
    updateProject: (db: Database.Database, id: string, patch: ProjectPatch) => ProjectRecord | null | undefined;
    readProjectFile: (projectsDir: string, projectId: string, filePath: string, metadata?: JsonRecord) => Promise<{ buffer: Buffer }>;
    writeProjectFile: (projectsDir: string, projectId: string, filePath: string, content: Buffer, options?: JsonRecord, metadata?: JsonRecord) => Promise<unknown>;
    listFiles: (projectsDir: string, projectId: string, options?: { metadata?: JsonRecord }) => Promise<unknown[]>;
    resolveProjectDir: (projectsDir: string, projectId: string, metadata?: JsonRecord) => string;
    isSafeId: (id: string) => boolean;
  };
  /**
   * Give the `ds-*` project that backs a design system's editing workspace a
   * `workspace_projects` home, the same as any other created project.
   *
   * It is a real, run-hosting project — the chat/run prompt-composition path
   * stands it up on demand (`server.ts`) and the system prompt has a dedicated
   * `editingOwnDraftDesignSystem` branch for chatting inside it — so an unbound
   * one is denied its first turn by `enforceWorkspaceResourceMutation` exactly
   * like any other orphan. This factory has no Express request, so the daemon's
   * ambient workspace is the only thing that can answer; the injected closure
   * keeps that resolution in `server.ts` where the provider lives. Absent in
   * tests that do not exercise the seam.
   */
  bindProjectToWorkspace?: (
    projectId: string,
    createdAt: number,
    designSystem: DesignSystemSummary,
  ) => void;
}) {
  /**
   * The functional-skills catalog. `workspaceId` narrows it to the
   * user-imported skills that workspace may see (mirrors
   * `listAllDesignSystems` below). Request and project-bound consumers pass
   * their exact persisted scope; only true legacy/internal callers omit it.
   *
   * Checking `options.workspaceId === undefined` (not just falsy) matters:
   * `GET /api/skills` always passes the key, with `null` whenever the request
   * carries no `x-od-workspace-id` header (headerValue never returns
   * `undefined`) — that request DID ask to be scoped, just with no identity,
   * and must still reach `listSkills`'s workspace filter so a claimed skill is
   * hidden from it (spec 04 §10), not silently fall through to the unscoped
   * branch the way a plain `options.workspaceId ? … : …` truthiness check
   * would.
   */
  async function listAllSkills(options: {
    workspaceId?: string | null;
    workspaceMemberId?: string | null;
  } = {}) {
    const db = getDb?.();
    if (!db || options.workspaceId === undefined) {
      return skills.listSkills(roots.SKILL_ROOTS);
    }
    const personalAndBuiltIn = await skills.listSkills(roots.SKILL_ROOTS, {
      db,
      workspaceId: options.workspaceId,
      workspaceMemberId: options.workspaceMemberId ?? null,
    });
    const workspaceId = options.workspaceId?.trim();
    const userSkillsRoot = roots.SKILL_ROOTS[0];
    if (!workspaceId || !userSkillsRoot) return personalAndBuiltIn;
    const workspaceRoot = teamResourceWorkspaceRoot(userSkillsRoot, workspaceId);
    let directories: fs.Dirent[] = [];
    try {
      directories = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
    } catch {
      return personalAndBuiltIn;
    }
    const markerByDirectory = new Map<string, string>();
    await Promise.all(
      directories
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          // Skill hub ids may use either the plain local id or the historical
          // `user:` prefix. Both materialize into the same safe storage name;
          // the marker is authoritative about which logical id was pulled.
          const candidates = [entry.name, `user:${entry.name}`];
          let marker = null;
          for (const candidate of candidates) {
            marker = await readTeamResourceMaterialization(
              userSkillsRoot,
              workspaceId,
              candidate,
              entry.name,
            );
            if (marker) break;
          }
          if (
            marker?.kind !== 'skill'
            || !workspaceTeamSkillBindingAllowsRead(db, workspaceId, marker.resourceId)
          ) return;
          markerByDirectory.set(path.join(workspaceRoot, entry.name), marker.resourceId);
        }),
    );
    if (markerByDirectory.size === 0) return personalAndBuiltIn;
    const discoveredTeam = await skills.listSkills([workspaceRoot]);
    // Re-check the exact binding after filesystem parsing. Reconciliation can
    // tombstone a Team Skill while SKILL.md and its attachments are being
    // read; that newer negative verdict must win over the stale directory.
    const team = discoveredTeam.filter((entry) => {
      const logicalId = typeof entry.dir === 'string'
        ? markerByDirectory.get(entry.dir)
        : undefined;
      return Boolean(
        logicalId
        && (entry.id === logicalId || entry.id.startsWith(`${logicalId}:`))
        && workspaceTeamSkillBindingAllowsRead(db, workspaceId, logicalId),
      );
    });
    const teamIds = new Set(team.map((entry) => entry.id));
    return [
      ...team.map((entry) => ({ ...entry, teamSynced: true })),
      ...personalAndBuiltIn.filter((entry) => !teamIds.has(entry.id)),
    ];
  }

  async function listAllDesignTemplates() {
    return skills.listSkills(roots.DESIGN_TEMPLATE_ROOTS);
  }

  async function listAllSkillLikeEntries(
    options: {
      workspaceId?: string | null;
      workspaceMemberId?: string | null;
    } = {},
  ) {
    if (options.workspaceId === undefined) {
      return skills.listSkills(roots.ALL_SKILL_LIKE_ROOTS);
    }
    const [functional, templates] = await Promise.all([
      listAllSkills(options),
      listAllDesignTemplates(),
    ]);
    const functionalIds = new Set(functional.map((entry) => entry.id));
    return [
      ...functional,
      ...templates.filter((entry) => !functionalIds.has(entry.id)),
    ];
  }

  /**
   * The design-system catalog.
   *
   * `workspaceId` narrows the USER half to the systems that workspace may see
   * (#145); the built-in half is shipped with the app and stays global. Project
   * validation and request-bound lookups pass the project's exact persisted
   * Workspace, so shell navigation cannot retarget same-id resolution.
   *
   * The USER directory is listed UNSCOPED and the `workspace_resources`
   * envelope below is the sole visibility authority for any request that
   * carries a scope key (issue #6763): a brand re-finalize can drop the
   * `workspaceId` claim from `metadata.json` while the persisted binding keeps
   * the system correctly bound, so the metadata alone must never decide. The
   * signed-out lane hides BOTH envelope-bound systems and metadata-claimed
   * systems (spec 04 §10) — only genuinely unclaimed resources stay visible
   * to a headerless caller.
   */
  // Home re-reads the catalogue on every load; an unchanged root is answered
  // from memory (see `listing-cache.ts` for the invalidation contract).
  const listDesignSystemsCached = createDesignSystemListingCache(designSystems.listDesignSystems);

  async function listAllDesignSystems(options: {
    workspaceId?: string | null;
    workspaceMemberId?: string | null;
    exactTeam?: boolean;
    fresh?: boolean;
  } = {}) {
    const list = options.fresh ? designSystems.listDesignSystems : listDesignSystemsCached;
    const builtIn = (await list(paths.DESIGN_SYSTEMS_DIR, { source: 'built-in', freshApproval: options.fresh === true, approvalReceiptRoot: path.join(paths.USER_DESIGN_SYSTEMS_DIR, '.built-in') })).map((s) => ({
      ...s,
      source: 'built-in',
      isEditable: false,
      status: 'published',
    }));
    let installed: DesignSystemSummary[] = [];
    try {
      installed = await list(paths.USER_DESIGN_SYSTEMS_DIR, {
        idPrefix: 'user:',
        source: 'user',
        isEditable: true,
        defaultStatus: 'draft',
        freshApproval: options.fresh === true,
      });
    } catch {
      // User directory may not exist yet or be unreadable.
    }
    const workspaceId = options.workspaceId?.trim();
    if (workspaceId) {
      try {
        const team = await list(
          teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId),
          {
            idPrefix: 'user:',
            source: 'user',
            isEditable: false,
            defaultStatus: 'published',
            freshApproval: options.fresh === true,
            publishedApprovalSeed: true,
            approvalReceiptRoot: path.join(teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId), '.local'),
            workspaceId,
          },
        );
        // Team directories are intentionally retained after reconciliation so
        // offline/local data is recoverable. Availability comes from the local
        // binding row: filter both after async filesystem parsing and before
        // exposing the catalogue, matching the Skill catalogue's boundary.
        // This is local SSE/poll state, not a network membership check.
        const teamDb = getDb?.();
        const reconciledTeam = teamDb
          ? team.filter((system) => workspaceTeamDesignSystemBindingAllowsRead(
              teamDb,
              workspaceId,
              system.id,
            ))
          : team;
        const teamIds = new Set(reconciledTeam.map((system) => system.id));
        const teamSystems = reconciledTeam.map((system) => ({ ...system, teamSynced: true }));
        installed = options.exactTeam
          ? teamSystems
          : [
              ...teamSystems,
              ...installed.filter((system) => !teamIds.has(system.id)),
            ];
      } catch {
        // A workspace with no pulled Team systems has no scoped directory.
      }
    }
    const seen = new Set(builtIn.map((s) => s.id));
    const catalog = [
      ...installed
        .filter((s) => s.source === 'user')
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? '')),
      ...builtIn,
      ...installed.filter((s) => s.source !== 'user' && !seen.has(s.id)),
    ];
    async function checkEditingBodies(systems: DesignSystemSummary[]) {
      const db = getDb?.();
      if (!db) return systems;
      return Promise.all(systems.map(async system => {
        if (!system.approval || system.teamSynced || !system.projectId) return system;
        const body = await readDesignSystemWorkspaceTextFile(db, system, 'DESIGN.md');
        if (body === null || body === system.body) return system;
        return { ...system, approval: { ...system.approval, status: 'unreviewed' as const, revision: createHash('sha256').update(system.approval.revision).update(body).digest('hex') } };
      }));
    }
    if (options.workspaceId === undefined) return checkEditingBodies(catalog);
    const exactWorkspaceId = options.workspaceId?.trim() ?? '';
    const exactMemberId = options.workspaceMemberId?.trim() ?? '';
    const db = getDb?.();
    return checkEditingBodies(catalog.filter((system) => {
      if (system.source !== 'user') return true;
      // A fully headerless request is the signed-out/local compatibility
      // lane. It may see resources that have never been claimed by any
      // Workspace, but both a persisted binding and a metadata claim are
      // positive evidence that the resource is not local-public and must stay
      // hidden without authority (spec 04 §10, issue #6763).
      if (!exactWorkspaceId && !exactMemberId) {
        if (!db) return false;
        return !system.workspaceId?.trim()
          && !getWorkspaceResourceByResourceId(
            db,
            'design_system',
            system.id,
          );
      }
      if (system.teamSynced === true) {
        return Boolean(exactWorkspaceId) && system.workspaceId === exactWorkspaceId;
      }
      if (!db || !exactWorkspaceId || !exactMemberId) return false;
      return designSystemBindingAllowsRead(
        getWorkspaceResourceByResourceId(db, 'design_system', system.id),
        exactWorkspaceId,
        exactMemberId,
      );
    }));
  }

  async function readAvailableDesignSystem(
    id: string,
    options: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean } = {},
  ) {
    const db = getDb?.();
    const workspaceId = options.workspaceId?.trim();
    if (workspaceId && typeof id === 'string' && id.startsWith('user:')) {
      const scoped = await designSystems.readDesignSystem(
        teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId),
        id,
        { idPrefix: 'user:', workspaceId },
      );
      if (scoped != null) return scoped;
      if (options.exactTeam) return null;
    }
    if (typeof id === 'string' && id.startsWith('user:')) {
      const readOptions = designSystemUserReadOptions(db, id, options);
      if (readOptions === null) return null;
      return designSystems.readDesignSystem(paths.USER_DESIGN_SYSTEMS_DIR, id, readOptions);
    }
    return (
      (await designSystems.readDesignSystem(paths.DESIGN_SYSTEMS_DIR, id))
      ?? (await designSystems.readDesignSystem(paths.USER_DESIGN_SYSTEMS_DIR, id))
    );
  }

  async function readAvailableDesignSystemPackageInfo(
    id: string,
    options: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean } = {},
  ) {
    const db = getDb?.();
    const workspaceId = options.workspaceId?.trim();
    if (workspaceId && typeof id === 'string' && id.startsWith('user:')) {
      const scoped = await designSystems.readDesignSystemPackageInfo(
        teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId),
        id,
        { idPrefix: 'user:', workspaceId },
      );
      if (scoped != null) return scoped;
      if (options.exactTeam) return null;
    }
    if (typeof id === 'string' && id.startsWith('user:')) {
      const readOptions = designSystemUserReadOptions(db, id, options);
      if (readOptions === null) return null;
      return designSystems.readDesignSystemPackageInfo(paths.USER_DESIGN_SYSTEMS_DIR, id, readOptions);
    }
    return (
      (await designSystems.readDesignSystemPackageInfo(paths.DESIGN_SYSTEMS_DIR, id))
      ?? (await designSystems.readDesignSystemPackageInfo(paths.USER_DESIGN_SYSTEMS_DIR, id))
    );
  }

  async function readAvailableDesignSystemStaticFile(
    id: string,
    filePath: string,
    options: { workspaceId?: string | null; workspaceMemberId?: string | null; exactTeam?: boolean } = {},
  ) {
    const db = getDb?.();
    const workspaceId = options.workspaceId?.trim();
    if (workspaceId && typeof id === 'string' && id.startsWith('user:')) {
      const scoped = await designSystems.readDesignSystemStaticFile(
        teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId),
        id,
        filePath,
        { idPrefix: 'user:', workspaceId },
      );
      if (scoped != null) return scoped;
      if (options.exactTeam) return null;
    }
    if (typeof id === 'string' && id.startsWith('user:')) {
      const readOptions = designSystemUserReadOptions(db, id, options);
      if (readOptions === null) return null;
      return designSystems.readDesignSystemStaticFile(
        paths.USER_DESIGN_SYSTEMS_DIR,
        id,
        filePath,
        readOptions,
      );
    }
    return (
      (await designSystems.readDesignSystemStaticFile(paths.DESIGN_SYSTEMS_DIR, id, filePath))
      ?? (await designSystems.readDesignSystemStaticFile(paths.USER_DESIGN_SYSTEMS_DIR, id, filePath))
    );
  }

  function isProjectUsableDesignSystem(summary: DesignSystemSummary | null | undefined) {
    if (!summary) return true;
    return designSystemSelectability(selectabilityInput(summary)).selectable;
  }

  /**
   * Is this kit selectable for generation, and if not, why. The one answer
   * every daemon surface uses (project binding, run composition, install
   * reports, and routes that refuse a draft), scoped exactly like the
   * catalogue the caller would see.
   */
  async function resolveDesignSystemSelectability(
    id: string,
    options: {
      workspaceId?: string | null;
      workspaceMemberId?: string | null;
      exactTeam?: boolean;
    } = {},
  ): Promise<DesignSystemSelectabilityResult> {
    const systems = await listAllDesignSystems({ ...options, fresh: true });
    const summary = systems.find((system) => system.id === id);
    if (!summary) {
      return {
        found: false,
        selectable: false,
        reason: 'not_found',
        message: `design system not found: ${id}`,
        publishCommand: null,
      };
    }
    const verdict = designSystemSelectability(selectabilityInput(summary));
    return verdict.selectable
      ? { found: true, selectable: true, summary }
      : { found: true, ...verdict, summary };
  }

  async function readGenerationDesignSystemForProject(id: string, projectId: string): Promise<string> {
    const db = getDb?.();
    const project = db ? projects.getProject(db, projectId) : null;
    const binding = db ? getWorkspaceProjectByProjectId(db, projectId) : null;
    const stored = (project?.metadata as { localCatalogScopes?: { designSystem?: { workspaceId?: string; workspaceMemberId?: string } } } | undefined)?.localCatalogScopes?.designSystem;
    const scope = stored?.workspaceId && stored?.workspaceMemberId
      ? { workspaceId: stored.workspaceId, workspaceMemberId: stored.workspaceMemberId }
      : binding?.workspaceId
        ? { workspaceId: binding.workspaceId, workspaceMemberId: binding.createdByWorkspaceMemberId ?? null }
        : {};
    const selected = await resolveDesignSystemSelectability(id, scope);
    if (!selected.selectable) throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary: selected.found ? selectabilityInput(selected.summary) : null, hasBody: false }));
    const body = await readAvailableDesignSystem(id, scope);
    if (typeof body !== 'string' || !body.trim()) throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary: selectabilityInput(selected.summary), hasBody: false }));
    const current = await resolveDesignSystemSelectability(id, scope);
    if (!current.selectable || (current.summary.approval as { revision?: string } | undefined)?.revision !== (selected.summary.approval as { revision?: string } | undefined)?.revision || body !== current.summary.body) {
      const summary = current.found ? selectabilityInput(current.summary) : null;
      if (summary?.approval) summary.approval = { ...summary.approval, status: 'unreviewed' };
      throw new DesignSystemGenerationRefusal(designSystemRunNotice({ designSystemId: id, summary, hasBody: false }));
    }
    return body;
  }

  async function validateProjectDesignSystemId(
    id: unknown,
    options: {
      workspaceId?: string | null;
      workspaceMemberId?: string | null;
    } = {},
  ) {
    // Product boundary: this validator identifies the item in the daemon's
    // locally reconciled catalog; it is not a fresh Team-authorization gate.
    // A not-yet-reconciled local copy remains usable, while a locally recorded
    // tombstone removes it from future selection. Never add a network
    // membership check to this project-create path.
    if (id === undefined || id === null || id === '') return { ok: true, id: null };
    if (typeof id !== 'string') {
      return {
        ok: false,
        code: 'INVALID_DESIGN_SYSTEM',
        message: 'designSystemId must be a string or null',
      };
    }
    const systems = await listAllDesignSystems({ ...options, fresh: true });
    const summary = systems.find((system) => system.id === id);
    if (!summary) {
      return {
        ok: false,
        code: 'DESIGN_SYSTEM_NOT_FOUND',
        message: 'design system not found',
      };
    }
    if (!isProjectUsableDesignSystem(summary)) {
      const verdict = designSystemSelectability(selectabilityInput(summary));
      return {
        ok: false,
        code: verdict.selectable ? 'INVALID_DESIGN_SYSTEM' : verdict.reason === 'unreviewed' ? 'DESIGN_SYSTEM_NOT_APPROVED' : 'DESIGN_SYSTEM_NOT_PUBLISHED',
        message: verdict.selectable ? 'Kit is unavailable' : `${verdict.message} ${verdict.publishCommand}`,
      };
    }
    return { ok: true, id };
  }

  async function validateProjectSkillId(
    id: unknown,
    options: { workspaceId?: string | null } = {},
  ) {
    // Same invariant as Design Systems and exact-source plugins: project
    // creation follows locally reconciled content. Team membership is checked
    // by remote install/pull/sync/share operations, not by Send. Eventual
    // consistency is intentional: a stale local copy remains usable until
    // reconciliation records the retraction in the local catalog.
    if (id === undefined || id === null || id === '') {
      return { ok: true, id: null };
    }
    if (typeof id !== 'string') {
      return {
        ok: false,
        code: 'INVALID_SKILL_ID',
        message: 'skillId must be a string or null',
      };
    }
    const allSkills = await listAllSkillLikeEntries(options);
    const resolved = skills.findSkillById(allSkills, id);
    if (!resolved) {
      return {
        ok: false,
        code: 'SKILL_NOT_FOUND',
        message: 'skill not found',
      };
    }
    return { ok: true, id: resolved.id };
  }

  function userDesignSystemDirectoryId(id: string) {
    if (typeof id !== 'string' || !id.startsWith('user:')) return null;
    const dirId = id.slice('user:'.length);
    if (!/^[A-Za-z0-9._-]{1,120}$/.test(dirId)) return null;
    return dirId;
  }

  function userDesignSystemWorkspaceProjectId(id: string) {
    const dirId = userDesignSystemDirectoryId(id);
    if (!dirId) return null;
    return `ds-${dirId}`.slice(0, 128);
  }

  function projectBackedDesignSystemProjectId(id: string, summary: DesignSystemSummary) {
    if (typeof summary?.projectId === 'string' && projects.isSafeId(summary.projectId)) {
      return summary.projectId;
    }
    return userDesignSystemWorkspaceProjectId(id);
  }

  function workspaceScopedDesignSystemProjectId(id: string, workspaceId: string) {
    const dirId = userDesignSystemDirectoryId(id);
    if (!dirId) return null;
    const suffix = createHash('sha256')
      .update(`${workspaceId}\0${id}`, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const prefix = `ds-${dirId}-`.slice(0, 128 - suffix.length);
    return `${prefix}${suffix}`;
  }

  function isExactDesignSystemProjectBinding(
    binding: ReturnType<typeof getWorkspaceProjectByProjectId>,
    summary: DesignSystemSummary,
    workspaceId: string,
    workspaceMemberId: string,
  ) {
    if (!binding || binding.workspaceId !== workspaceId || binding.resourceState === 'deleted') {
      return false;
    }
    if (summary.teamSynced === true) return binding.visibility === 'team';
    return binding.visibility === 'personal'
      && binding.createdByWorkspaceMemberId === workspaceMemberId;
  }

  async function resolveDesignSystemWorkspaceProject(
    dbHandle: Database.Database,
    id: string,
    options: DesignSystemWorkspaceOptions = {},
  ) {
    const isScoped = options.workspaceId !== undefined
      || options.workspaceMemberId !== undefined;
    const workspaceId = options.workspaceId?.trim() ?? '';
    const workspaceMemberId = options.workspaceMemberId?.trim() ?? '';
    // A request that claims Workspace scope must carry the complete verified
    // identity. Falling back to the legacy unscoped catalog here is precisely
    // what allowed a Team operation to mutate a same-id Personal project.
    if (isScoped && (!workspaceId || !workspaceMemberId)) return null;

    const systems = await listAllDesignSystems(
      isScoped
        ? {
            workspaceId,
            workspaceMemberId,
            ...(options.exactTeam !== undefined ? { exactTeam: options.exactTeam } : {}),
          }
        : {},
    );
    const summary = systems.find((s) => s.id === id && s.source === 'user');
    if (!summary) return null;

    const sourceRoot = summary.teamSynced === true
      ? teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, workspaceId)
      : paths.USER_DESIGN_SYSTEMS_DIR;
    let projectId = summary.teamSynced === true
      ? workspaceScopedDesignSystemProjectId(id, workspaceId)
      : projectBackedDesignSystemProjectId(id, summary);
    if (!projectId) return null;

    if (isScoped) {
      const existing = projects.getProject(dbHandle, projectId);
      const binding = existing
        ? getWorkspaceProjectByProjectId(dbHandle, projectId)
        : undefined;
      const exactBinding = isExactDesignSystemProjectBinding(
        binding,
        summary,
        workspaceId,
        workspaceMemberId,
      );
      if (existing && !exactBinding) {
        projectId = workspaceScopedDesignSystemProjectId(id, workspaceId);
        if (!projectId) return null;
        const scopedExisting = projects.getProject(dbHandle, projectId);
        const scopedBinding = scopedExisting
          ? getWorkspaceProjectByProjectId(dbHandle, projectId)
          : undefined;
        if (scopedExisting && !isExactDesignSystemProjectBinding(
          scopedBinding,
          summary,
          workspaceId,
          workspaceMemberId,
        )) {
          return null;
        }
      }
    }
    return { summary, projectId, sourceRoot, workspaceId };
  }

  async function ensureUserDesignSystemWorkspaceProject(
    dbHandle: Database.Database,
    id: string,
    options: DesignSystemWorkspaceOptions = {},
  ) {
    const resolved = await resolveDesignSystemWorkspaceProject(dbHandle, id, options);
    if (!resolved) return null;
    const { summary, projectId, sourceRoot } = resolved;

    const now = Date.now();
    const metadata = {
      kind: 'other',
      importedFrom: 'design-system',
      entryFile: 'DESIGN.md',
      sourceFileName: id,
    };
    const existing = projects.getProject(dbHandle, projectId);
    const projectName = summary.title ?? id;
    const project = existing
      ? projects.updateProject(dbHandle, projectId, {
          name: projectName,
          designSystemId: id,
          metadata: { ...(existing.metadata ?? {}), ...metadata },
          updatedAt: now,
        })
      : projects.insertProject(dbHandle, {
          id: projectId,
          name: projectName,
          skillId: null,
          designSystemId: id,
          pendingPrompt: null,
          metadata,
          createdAt: now,
          updatedAt: now,
        });
    if (!project) return null;
    if (!existing) bindProjectToWorkspace?.(projectId, now, summary);

    const files = await designSystems.listUserDesignSystemFiles(sourceRoot, id);
    if (!files) return null;
    const syncConflicts = await syncDesignSystemPackageIntoProject({
      db: dbHandle,
      projectId,
      projectDir: projects.resolveProjectDir(paths.PROJECTS_DIR, projectId, project.metadata),
      packageFiles: files.filter((file) => file.kind !== 'folder'),
      readPackageFile: (filePath) => designSystems.readUserDesignSystemFileBytes(sourceRoot, id, filePath),
      now,
    });
    if (syncConflicts.length > 0) {
      console.warn(
        `[design-systems] workspace sync for ${projectId} (${id}) kept ${syncConflicts.length} file(s): `
          + syncConflicts.map((conflict) => `${conflict.path} (${conflict.reason})`).join(', '),
      );
    }
    await removeLegacyDesignSystemWorkspaceArtifacts(project);
    await designSystems.linkUserDesignSystemProject(sourceRoot, id, project.id);
    const projectFiles = await projects.listFiles(
      paths.PROJECTS_DIR,
      projectId,
      project.metadata ? { metadata: project.metadata } : {},
    );
    return { project, files: projectFiles, syncConflicts };
  }

  async function removeLegacyDesignSystemWorkspaceArtifacts(project: ProjectRecord) {
    if (project?.metadata?.importedFrom !== 'design-system') return;
    const dir = projects.resolveProjectDir(paths.PROJECTS_DIR, project.id, project.metadata);
    for (const artifact of designSystems.LEGACY_DESIGN_SYSTEM_ARTIFACTS) {
      const replacementReady = await Promise.all(
        artifact.replacementPaths.map(async (replacementPath) => {
          try {
            const stats = await fs.promises.stat(path.join(dir, ...replacementPath.split('/')));
            return stats.isFile();
          } catch (err: unknown) {
            if (!isNodeErrorCode(err, 'ENOENT') && !isNodeErrorCode(err, 'ENOTDIR')) throw err;
            return false;
          }
        }),
      );
      if (!replacementReady.every(Boolean)) continue;
      await fs.promises.rm(path.join(dir, ...artifact.legacyPath.split('/')), {
        recursive: artifact.removeDirectory === true,
        force: true,
      });
    }
  }

  async function readDesignSystemWorkspaceTextFile(
    dbHandle: Database.Database,
    summary: DesignSystemSummary | null | undefined,
    filePath: string,
  ) {
    if (!summary?.projectId || !projects.isSafeId(summary.projectId)) return null;
    const project = projects.getProject(dbHandle, summary.projectId);
    if (!project) return null;
    try {
      const file = await projects.readProjectFile(
        paths.PROJECTS_DIR,
        project.id,
        filePath,
        project.metadata,
      );
      const text = file.buffer.toString('utf8');
      if (text.includes('\0')) return null;
      return text;
    } catch {
      return null;
    }
  }

  /** Private freshness witness, not read authority. Call only after the binding
   * gate. Cover fallback directories and selection metadata as well as bytes;
   * a newly appearing editing mirror must fence a registry-body resolution.
   * The validated package manifest currently fixes its design file to DESIGN.md. */
  function designSystemReferenceSourceKey(
    dbHandle: Database.Database,
    id: string,
    options: DesignSystemWorkspaceOptions,
    summary?: DesignSystemSummary,
  ): string | null {
    const user = id.startsWith('user:'); const dirId = user ? id.slice(5) : id;
    if (!/^[a-zA-Z0-9._-]+$/.test(dirId) || dirId === '.' || dirId === '..') return null;
    const roots = user ? (options.exactTeam ? [] : [paths.USER_DESIGN_SYSTEMS_DIR]) : [paths.DESIGN_SYSTEMS_DIR, paths.USER_DESIGN_SYSTEMS_DIR];
    if (user && options.workspaceId) roots.unshift(teamResourceWorkspaceRoot(paths.USER_DESIGN_SYSTEMS_DIR, options.workspaceId));
    const files = roots.flatMap(root => ['metadata.json', 'manifest.json', 'DESIGN.md'].map(file => path.join(root, dirId, file)));
    try {
      if (summary?.teamSynced !== true && summary?.projectId && projects.isSafeId(summary.projectId)) {
        const project = projects.getProject(dbHandle, summary.projectId);
        if (project) files.push(path.join(projects.resolveProjectDir(paths.PROJECTS_DIR, project.id, project.metadata), 'DESIGN.md'));
      }
      const witness = files.map(file => {
        try { return [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]; }
        catch (error) {
          if (isNodeErrorCode(error, 'ENOENT') || isNodeErrorCode(error, 'ENOTDIR')) return [file, null];
          throw error;
        }
      });
      return createHash('sha256').update(JSON.stringify(witness)).digest('hex');
    } catch { return null; }
  }

  /**
   * Copies the real `assets/` files out of a user design system's workspace
   * project (the editing-time mirror an agent actually writes to) into the
   * canonical design-system directory, so `team-resource-share`'s zip and
   * `/api/design-systems/:id/archive` stop shipping a stale/placeholder
   * `assets/logo.svg` (spec 04 §9.3, recvqb1t4FrckM). Locates the source
   * project the same way `ensureUserDesignSystemWorkspaceProject` does
   * (`projectBackedDesignSystemProjectId`), just copying in the opposite
   * direction — from the project mirror back to canonical.
   */
  async function syncUserDesignSystemAssetsFromWorkspace(
    dbHandle: Database.Database,
    id: string,
    options: DesignSystemWorkspaceOptions = {},
  ): Promise<DesignSystemAssetSyncOutcome> {
    const resolved = await resolveDesignSystemWorkspaceProject(dbHandle, id, options);
    if (!resolved) return { ok: false, reason: 'not-found' };
    const { projectId, sourceRoot } = resolved;
    const project = projects.getProject(dbHandle, projectId);
    if (!project) return { ok: false, reason: 'no-workspace-project' };

    const projectFiles = await projects.listFiles(
      paths.PROJECTS_DIR,
      project.id,
      project.metadata ? { metadata: project.metadata } : {},
    );
    const assetPaths = projectFiles
      .map((file) => (file && typeof file === 'object' ? (file as { path?: unknown }).path : undefined))
      .filter(
        (candidate): candidate is string =>
          typeof candidate === 'string' && (candidate === 'assets' || candidate.startsWith('assets/')),
      );

    const files: Array<{ path: string; content: Buffer }> = [];
    for (const assetPath of assetPaths) {
      try {
        const detail = await projects.readProjectFile(
          paths.PROJECTS_DIR,
          project.id,
          assetPath,
          project.metadata,
        );
        files.push({ path: assetPath, content: detail.buffer });
      } catch {
        // A file that vanished or was mid-rename during the scan shouldn't
        // fail the whole sync — skip it and continue with the rest.
      }
    }

    const result = await designSystems.syncUserDesignSystemAssetsFromFiles(
      sourceRoot,
      id,
      files,
    );
    return { ok: true, synced: result.synced };
  }

  /**
   * Resolves the directory that a team-share publish may archive. Unlike the
   * read-only canonical path resolver, this first snapshots the workspace
   * project's latest assets back into canonical. A missing source fails
   * closed so a repeat "Sync to team" can never publish stale bytes.
   */
  async function resolveUserDesignSystemShareDirectory(
    dbHandle: Database.Database,
    id: string,
  ): Promise<string> {
    const outcome = await syncUserDesignSystemAssetsFromWorkspace(dbHandle, id);
    if (!outcome.ok) {
      throw new Error(`design_system_share_asset_sync_failed:${outcome.reason}`);
    }
    const dirId = userDesignSystemDirectoryId(id);
    if (!dirId) {
      throw new Error('design_system_share_asset_sync_failed:not-found');
    }
    return path.join(paths.USER_DESIGN_SYSTEMS_DIR, dirId);
  }

  return {
    ensureUserDesignSystemWorkspaceProject,
    isProjectUsableDesignSystem,
    listAllDesignSystems,
    listAllDesignTemplates,
    listAllSkillLikeEntries,
    listAllSkills,
    readAvailableDesignSystem,
    readGenerationDesignSystemForProject,
    readAvailableDesignSystemPackageInfo,
    readAvailableDesignSystemStaticFile,
    readDesignSystemWorkspaceTextFile,
    designSystemReferenceSourceKey,
    resolveDesignSystemSelectability,
    resolveUserDesignSystemShareDirectory,
    syncUserDesignSystemAssetsFromWorkspace,
    validateProjectDesignSystemId,
    validateProjectSkillId,
  };
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === code
  );
}
