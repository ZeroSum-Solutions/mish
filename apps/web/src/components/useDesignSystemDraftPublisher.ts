import { useCallback } from 'react';
import type { DesignSystemSummary } from '@mish/contracts';
import { useWorkspaceContext } from '../collab/useWorkspaceContext';
import { updateDesignSystemDraft } from '../providers/registry';

/**
 * Publish one of the caller's draft kits through the same PATCH the Design
 * systems page uses, then re-read the catalogue. Resolves true on success.
 */
export function useDesignSystemDraftPublisher(
  onDesignSystemsRefresh?: () => Promise<void> | void,
): (system: DesignSystemSummary) => Promise<boolean> {
  const { context: workspaceContext } = useWorkspaceContext();
  return useCallback(
    async (system: DesignSystemSummary) => {
      const updated = await updateDesignSystemDraft(
        system.id,
        { status: 'published' },
        workspaceContext,
      );
      if (!updated) return false;
      await onDesignSystemsRefresh?.();
      return true;
    },
    [onDesignSystemsRefresh, workspaceContext],
  );
}
