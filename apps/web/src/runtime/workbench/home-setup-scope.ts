import type { WorkspaceCollabContext } from '@open-design/contracts';
import { currentWorkspaceAccountGeneration, workspaceAccountScopedCacheKey } from '../../collab/workspace-identity';

/** One authority lifetime for all dependent Home setup reads and writes. */
export function captureHomeSetupScope(
  context: WorkspaceCollabContext | null | undefined,
  currentContext?: () => WorkspaceCollabContext | null | undefined,
  generation = currentWorkspaceAccountGeneration(),
) {
  const originalContext = context ? structuredClone(context) : null;
  const scopeKey = workspaceAccountScopedCacheKey(originalContext, generation);
  const isCurrent = () => currentWorkspaceAccountGeneration() === generation
    && (!currentContext || workspaceAccountScopedCacheKey(currentContext(), generation) === scopeKey);
  const assertCurrent = () => { if (!isCurrent()) throw new Error('home-handoff-scope-changed'); };
  return { context: originalContext, scopeKey, isCurrent, assertCurrent };
}
export type HomeSetupScope = ReturnType<typeof captureHomeSetupScope>;
