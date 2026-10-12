import { WorkspaceProjectMoveError } from '../state/projects';

/** Public guidance is fixed by code; server diagnostics are never UI text. */
export function teamProjectMoveFailureMessage(error: unknown): string | null {
  if (!(error instanceof WorkspaceProjectMoveError)) return null;
  switch (error.code) {
    case 'TEAM_PROJECT_PRIVATE_PATH':
      return 'Team project contains a private or outside path alias. Restore public project files before sharing.';
    case 'TEAM_PROJECT_SNAPSHOT_UNAVAILABLE':
      return 'Team project snapshot is unavailable. Restore filesystem access and retry sharing.';
    default:
      return null;
  }
}
