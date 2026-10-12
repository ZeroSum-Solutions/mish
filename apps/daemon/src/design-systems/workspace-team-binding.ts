import type Database from 'better-sqlite3';

import { getWorkspaceResourceByResourceId } from '../db.js';

type SqliteDb = Database.Database;

const WORKSPACE_TEAM_DESIGN_SYSTEM_BINDING_PREFIX = 'team-mirror:';

/**
 * Persisted Team mirrors use a Workspace-qualified envelope id. The logical
 * Design System id remains `user:<slug>` in every UI/API surface; only the
 * generic `workspace_resources` key is namespaced so two Teams, or Personal
 * and Team in one Workspace, can safely carry the same logical id.
 */
export function workspaceTeamDesignSystemBindingResourceId(
  workspaceId: string,
  designSystemId: string,
): string {
  return `${WORKSPACE_TEAM_DESIGN_SYSTEM_BINDING_PREFIX}${encodeURIComponent(workspaceId)}:${encodeURIComponent(designSystemId)}`;
}

export function designSystemIdFromWorkspaceTeamBinding(
  workspaceId: string,
  bindingResourceId: string,
): string | null {
  const prefix = `${WORKSPACE_TEAM_DESIGN_SYSTEM_BINDING_PREFIX}${encodeURIComponent(workspaceId)}:`;
  if (!bindingResourceId.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(bindingResourceId.slice(prefix.length));
  } catch {
    return null;
  }
}

export function designSystemLogicalResourceId(bindingResourceId: string): string {
  if (!bindingResourceId.startsWith(WORKSPACE_TEAM_DESIGN_SYSTEM_BINDING_PREFIX)) {
    return bindingResourceId;
  }
  const separator = bindingResourceId.indexOf(
    ':',
    WORKSPACE_TEAM_DESIGN_SYSTEM_BINDING_PREFIX.length,
  );
  if (separator < 0) return bindingResourceId;
  try {
    return decodeURIComponent(bindingResourceId.slice(separator + 1));
  } catch {
    return bindingResourceId;
  }
}

export function workspaceTeamDesignSystemBindingAllowsRead(
  db: SqliteDb,
  workspaceId: string,
  designSystemId: string,
): boolean {
  const binding = getWorkspaceResourceByResourceId(
    db,
    'design_system',
    workspaceTeamDesignSystemBindingResourceId(workspaceId, designSystemId),
  );
  return binding?.workspaceId === workspaceId
    && binding.visibility === 'team'
    && binding.resourceState !== 'deleted';
}

/**
 * The Workspace catalog's per-member visibility rule for one listed design
 * system (`GET /api/design-systems`, and the workbench resource federation).
 *
 * Built-in systems are global. A user system is visible to a Workspace member
 * only through a live Team binding in that Workspace, or through a live
 * Personal binding the same member created. A Personal system is never
 * visible to another member of the same Workspace, owners and admins included.
 */
export function designSystemVisibleInWorkspaceCatalog(
  db: SqliteDb,
  system: { id: string; source: string },
  workspaceId: string,
  workspaceMemberId: string,
): boolean {
  if (system.source !== 'user') return true;
  const teamBinding = getWorkspaceResourceByResourceId(
    db,
    'design_system',
    workspaceTeamDesignSystemBindingResourceId(workspaceId, system.id),
  );
  if (
    teamBinding?.workspaceId === workspaceId
    && teamBinding.visibility === 'team'
    && teamBinding.resourceState !== 'deleted'
  ) {
    return true;
  }
  const personalBinding = getWorkspaceResourceByResourceId(db, 'design_system', system.id);
  return personalBinding?.workspaceId === workspaceId
    && personalBinding.visibility !== 'team'
    && personalBinding.resourceState !== 'deleted'
    && personalBinding.createdByWorkspaceMemberId === workspaceMemberId;
}
