interface ProjectRunReader {
  beginProjectDeletion?: (projectId: string, options?: { ifIdle?: boolean }) => (() => void) | null;
  list: (filter: { projectId: string; status: string }) => unknown[];
}
/** Identify non-terminal project work for idle-only deletion. */
export function hasActiveProjectRuns(runs: ProjectRunReader, projectId: string): boolean {
  return runs.list({ projectId, status: 'active' }).length > 0;
}

/** The real run service also fences admission while async project cleanup is in flight. */
export function beginProjectDeletion(runs: ProjectRunReader, projectId: string, options: { ifIdle?: boolean }): (() => void) | null {
  if (runs.beginProjectDeletion) return runs.beginProjectDeletion(projectId, options);
  return options.ifIdle && hasActiveProjectRuns(runs, projectId) ? null : () => {};
}
