/** Approval is valid only for the exact package revision the reviewer inspected. */
export interface DesignSystemApproval {
  status: 'approved' | 'unreviewed';
  revision: string;
  approvedRevision?: string;
}
export interface SetDesignSystemApprovalRequest {
  approved: boolean;
  /** Prevent approving a revision that changed since the inspection. */
  expectedRevision: string;
}
export interface SetDesignSystemApprovalResponse {
  designSystem: import('./registry.js').DesignSystemSummary;
}
export function isApprovedDesignSystem(system: { approval?: DesignSystemApproval }): boolean {
  return system.approval?.status === 'approved'
    && Boolean(system.approval.revision)
    && system.approval.revision === system.approval.approvedRevision;
}
