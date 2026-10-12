import type Database from 'better-sqlite3';
import type { Request, Response } from 'express';
import type { ResourceRef, InstalledPluginRecord } from '@open-design/contracts';
import { getProject, getWorkspaceResourceByResourceId } from '../db.js';
import { isSafeId } from '../projects.js';
import { getLibraryAsset } from '../library-store.js';
import { listInstalledPlugins, workspaceTeamPluginBindingResourceId } from '../plugins/registry.js';
import { workspaceTeamDesignSystemBindingResourceId } from '../design-systems/workspace-team-binding.js';
import { resolveOptionalLocalWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import type { AuthorizeProjectRequestSync } from '../collab/project-request-authority.js';
import type { createDesignSystemServerServices } from '../design-systems/server-services.js';
import { createPluginResourceRevisionValidator, type ResourceSourceAdapter } from './resources.js';
import { resolveProjectContextReferences, type ProjectContextReferenceRequest } from './context-references.js';

type Systems = ReturnType<typeof createDesignSystemServerServices>;
/** Uses existing daemon-root services and explicit request scope on every read. */
export function createProjectContextReferenceResolver(deps: {
  db: Database.Database;
  authorizeProject: AuthorizeProjectRequestSync;
  requestScopedSources(req: Request, observePlugins?: (plugins: readonly InstalledPluginRecord[]) => void): readonly ResourceSourceAdapter[];
  teamPluginDirectory(workspaceId: string, pluginId: string): string;
  listAllDesignSystems: Systems['listAllDesignSystems'];
  readAvailableDesignSystem: Systems['readAvailableDesignSystem'];
  readWorkspaceFile: Systems['readDesignSystemWorkspaceTextFile'];
  designSystemSourceKey: Systems['designSystemReferenceSourceKey'];
}) {
  return async (req: Request, projectId: string, requested: ProjectContextReferenceRequest) => {
    const authority = resolveOptionalLocalWorkspaceRequestAuthority(req);
    if (!authority.ok) throw new Error('Invalid workspace scope');
    // Explicit null is the signed-out request lane. Undefined would invoke
    // unfiltered legacy compatibility catalogs.
    const workspaceId = authority.context?.workspaceId ?? null;
    const workspaceMemberId = authority.context?.workspaceMemberId ?? null;
    const teamBinding = (id: string) => workspaceId ? getWorkspaceResourceByResourceId(deps.db, 'design_system', workspaceTeamDesignSystemBindingResourceId(workspaceId, id)) : undefined;
    const systemOptions = (id: string) => ({ workspaceId, workspaceMemberId, exactTeam: teamBinding(id)?.visibility === 'team' });
    const projectKey = (id?: string) => {
      if (!id) return '';
      const silent = { status() { return silent; }, json() {} } as unknown as Response;
      if (!deps.authorizeProject(req, silent, id, { mode: 'read' })) return null;
      // The detail path falls back to registry DESIGN.md without a usable
      // editing project. Keep absence as evidence so a later project fences it.
      if (!isSafeId(id)) return JSON.stringify(['absent', id]);
      const project = getProject(deps.db, id);
      return project ? JSON.stringify(project) : JSON.stringify(['absent', id]);
    };
    const designSystemBindingKey = (id: string, linkedProjectId?: string): string | null => {
      const linked = projectKey(linkedProjectId); if (linked === null) return null;
      if (!id.startsWith('user:')) return JSON.stringify(['built-in', id, linked]);
      const team = teamBinding(id);
      if (team?.visibility === 'team') return team.workspaceId === workspaceId && team.resourceState !== 'deleted' ? JSON.stringify(['team', team, linked]) : null;
      const personal = getWorkspaceResourceByResourceId(deps.db, 'design_system', id);
      if (!workspaceId && !workspaceMemberId) return personal ? null : JSON.stringify(['local', id, linked]);
      return personal?.workspaceId === workspaceId && personal.visibility === 'personal' && personal.resourceState !== 'deleted' && personal.createdByWorkspaceMemberId === workspaceMemberId ? JSON.stringify(['personal', personal, linked]) : null;
    };
    let selectedPlugins: readonly InstalledPluginRecord[] = [];
    const sources = deps.requestScopedSources(req, plugins => { selectedPlugins = plugins; });
    const resourceBindingKey = (ref: ResourceRef): string | null => {
      if (ref.sourceId !== 'plugins') return JSON.stringify(['catalog', ref.sourceId]);
      const selected = selectedPlugins.find(plugin => plugin.id === ref.itemId);
      if (!selected) return null;
      const team = workspaceId && selected.fsPath === deps.teamPluginDirectory(workspaceId, ref.itemId) ? getWorkspaceResourceByResourceId(deps.db, 'plugin', workspaceTeamPluginBindingResourceId(workspaceId, ref.itemId)) : undefined;
      if (workspaceId && selected.fsPath === deps.teamPluginDirectory(workspaceId, ref.itemId)) return team && team.workspaceId === workspaceId && team.visibility === 'team' && team.resourceState !== 'deleted' ? JSON.stringify(['team', team]) : null;
      const plugin = listInstalledPlugins(deps.db, workspaceId, workspaceMemberId).find(item => item.id === ref.itemId);
      return plugin && plugin.fsPath === selected.fsPath ? JSON.stringify(['installed', plugin, getWorkspaceResourceByResourceId(deps.db, 'plugin', ref.itemId) ?? null]) : null;
    };
    // Lazy final-byte checks share one budget/cache for this save only.
    const currentPluginRevision = createPluginResourceRevisionValidator();
    return resolveProjectContextReferences(projectId, requested, {
      getAsset: id => getLibraryAsset(deps.db, id),
      requestContext: { projectId, principalId: authority.context ? `workspace:${workspaceId}:${workspaceMemberId}` : 'local-daemon' },
      requestScopedSources: sources, resourceBindingKey, designSystemBindingKey,
      resourceSourceCurrent(ref) {
        if (ref.sourceId !== 'plugins') return true; // immutable in-process catalogs
        const selected = selectedPlugins.find(plugin => plugin.id === ref.itemId);
        return !!selected && currentPluginRevision(selected) === ref.revisionOrDigest;
      },
      // This body is digest evidence only: resolveProjectContextReferences discards
      // it and exposes a boolean validator. putProjectContext saves just {id,
      // revisionOrDigest}; buildTransformPrompt receives that saved record, never
      // these bytes. Inspection of draft/unreviewed kits therefore stays available.
      // Generation readers enforce approval separately (context-references test).
      async readDesignSystem(id) {
        const options = systemOptions(id);
        if (designSystemBindingKey(id) === null) return null;
        const registryKey = deps.designSystemSourceKey(deps.db, id, options);
        if (registryKey === null) return null;
        const summary = (await deps.listAllDesignSystems(options)).find(system => system.id === id);
        if (!summary) return null;
        // Team packages may name the author's unrelated editing project. Only
        // personal/local editing mirrors can select a workspace DESIGN.md.
        const linkedProjectId = summary.teamSynced === true ? undefined : summary.projectId;
        const bindingKey = designSystemBindingKey(id, linkedProjectId); if (bindingKey === null) return null;
        const sourceKey = deps.designSystemSourceKey(deps.db, id, options, summary);
        if (sourceKey === null) return null;
        const sourceCurrent = () => deps.designSystemSourceKey(deps.db, id, options) === registryKey && deps.designSystemSourceKey(deps.db, id, options, summary) === sourceKey;
        const workspaceBody = linkedProjectId ? await deps.readWorkspaceFile(deps.db, summary, 'DESIGN.md') : null;
        const body = workspaceBody ?? await deps.readAvailableDesignSystem(id, options);
        const visible = (await deps.listAllDesignSystems(options)).find(system => system.id === id);
        if (typeof body !== 'string' || !visible || visible.projectId !== summary.projectId || visible.teamSynced !== summary.teamSynced || designSystemBindingKey(id, linkedProjectId) !== bindingKey || !sourceCurrent()) return null;
        return { body, bindingKey, sourceCurrent, ...(linkedProjectId ? { projectId: linkedProjectId } : {}) };
      },
    });
  };
}
