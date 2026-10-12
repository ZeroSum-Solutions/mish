import type { Request } from 'express';
import { resolveMemberVerifiedLocalWorkspaceRequestAuthority, type VerifyWorkspaceRequestAuthority } from '../collab/workspace-resource-mutation.js';
import type { DesignSystemSelectabilityResult } from '../design-systems/selectability.js';
import type { ComponentKitApprovalResolver } from './component-ranking.js';
import type { ResourceSourceAdapter } from './resources.js';

interface ApprovalDeps {
  verifyWorkspaceRequestAuthority: VerifyWorkspaceRequestAuthority;
  resolveDesignSystemSelectability(id: string, scope: { workspaceId: string | null; workspaceMemberId: string | null }): Promise<DesignSystemSelectabilityResult>;
  /** New request-scoped adapters: never reuse a picker listing to authorize Apply. */
  sourcesForRequest(req: Request): readonly ResourceSourceAdapter[];
}

function approvedRevision(result: DesignSystemSelectabilityResult): string | null {
  if (!result.selectable) return null;
  const approval = result.summary.approval;
  return approval && typeof approval === 'object' && 'revision' in approval && typeof approval.revision === 'string' ? approval.revision : null;
}

/** V05 owns admission. Bind its full-content revision to the exact discovery
 * source+ID+digest under verified membership, and recheck after reading discovery
 * bytes because discovery and V05 intentionally use different digest formats. */
export function createComponentKitApprovalResolver(req: Request, projectId: string | undefined, deps: ApprovalDeps): ComponentKitApprovalResolver {
  return async ref => {
    if (ref.sourceType !== 'library' || ref.sourceId !== 'design-systems') return 'unverified';
    try {
      const authority = await resolveMemberVerifiedLocalWorkspaceRequestAuthority(req, deps.verifyWorkspaceRequestAuthority);
      if (!authority.ok) return 'unverified';
      const member = authority.context;
      const scope = { workspaceId: member?.workspaceId ?? null, workspaceMemberId: member?.workspaceMemberId ?? null };
      const before = approvedRevision(await deps.resolveDesignSystemSelectability(ref.itemId, scope));
      if (!before) return 'unapproved';
      const source = deps.sourcesForRequest(req).find(source => source.sourceId === ref.sourceId);
      if (!source) return 'unverified';
      const snapshot = await source.list({ principalId: member ? `workspace:${member.workspaceId}:${member.workspaceMemberId}` : 'local-daemon', ...(projectId ? { projectId } : {}) });
      const current = snapshot.items.find(item => item.category === 'design-system' && item.ref.sourceType === ref.sourceType && item.ref.sourceId === ref.sourceId && item.ref.itemId === ref.itemId && item.ref.revisionOrDigest === ref.revisionOrDigest);
      if (!current) return 'unapproved';
      const after = approvedRevision(await deps.resolveDesignSystemSelectability(ref.itemId, scope));
      return after === before ? 'approved' : 'unapproved';
    } catch {
      return 'unverified';
    }
  };
}
