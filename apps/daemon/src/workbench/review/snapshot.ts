import { listProjectFileVersions } from '../../project-file-versions.js';
import type { EntryVersion } from './freshness.js';
import { readPreviewFile } from './preview-files.js';

export interface EntryVersionResolverDeps {
  /** The daemon's managed-project root (PROJECTS_DIR). */
  projectsRoot: string;
  /** The project's file root and stored metadata (imported folders keep their own base dir). */
  project(projectId: string): { root: string; metadata: unknown } | null;
}

/**
 * Resolves the saved revision a review names. `versionId: null` is the entry's
 * current content. A named version that does not exist resolves to null (404);
 * one that is no longer the file's current content resolves with
 * `current: false`, because the browser worker renders the live project files.
 */
export function createEntryVersionResolver(deps: EntryVersionResolverDeps) {
  return async (projectId: string, entry: string, versionId: string | null): Promise<EntryVersion | null> => {
    const project = deps.project(projectId);
    if (!project) return null;
    const file = await readPreviewFile(project.root, `/${entry.split('/').map(encodeURIComponent).join('/')}`);
    const contentDigest = file.status === 200 ? file.sha256 : null;
    let versions: Awaited<ReturnType<typeof listProjectFileVersions>> = [];
    try { versions = await listProjectFileVersions(deps.projectsRoot, projectId, entry, project.metadata); } catch { versions = []; }
    if (versionId === null) return { versionId: versions.find(version => version.current)?.id ?? null, contentDigest, current: true };
    const version = versions.find(item => item.id === versionId);
    if (!version) return null;
    return { versionId: version.id, contentDigest, current: version.current && (!version.contentDigest || version.contentDigest === contentDigest) };
  };
}
