import type { OperationRight, RightsDeclaration, UnitSavePlan, WorkbenchDeclarationSurface, WorkbenchRightsStatus } from '@open-design/contracts';

type Basis = RightsDeclaration['basis'];
const RANK: Record<WorkbenchRightsStatus, number> = { redistributable: 4, 'incorporation-only': 3, 'private-use-only': 2, 'reference-only': 1, unknown: 0 };
/** The user's declaration, recorded with the save request; it is the only evidence these grants rest on. */
export const DECLARATION_EVIDENCE_REF = 'rights-declaration.user-request';

/** Basis of one file: a captured file keeps the captured basis unless the declaration names that exact path as owned or licensed. */
export function fileBasis(relPath: string, captured: boolean, declaration: RightsDeclaration | undefined): Basis | null {
  const scoped = declaration?.scope?.paths;
  const covered = declaration !== undefined && (scoped === undefined || scoped.includes(relPath));
  if (captured) {
    return declaration && scoped?.includes(relPath) && (declaration.basis === 'user-owned' || declaration.basis === 'licensed') ? declaration.basis : 'captured-third-party';
  }
  return covered ? declaration!.basis : null;
}

/** Server-computed status for a basis; a model-authored file without a private-use attestation stays unknown. */
export function statusFor(basis: Basis | null, declaration: RightsDeclaration | undefined): WorkbenchRightsStatus {
  switch (basis) {
    case 'user-owned': return declaration && declaration.evidenceRefs.length > 0 ? 'redistributable' : 'private-use-only';
    case 'licensed': return 'incorporation-only';
    case 'model-authored': return declaration?.privateUseAttestation ? 'private-use-only' : 'unknown';
    case 'captured-third-party': return 'reference-only';
    default: return 'unknown';
  }
}

/** Aggregate status: the intersection, i.e. the most restrictive included file. */
export function aggregateStatus(statuses: readonly WorkbenchRightsStatus[]): WorkbenchRightsStatus {
  if (statuses.length === 0) return 'unknown';
  return statuses.reduce((low, status) => (RANK[status] < RANK[low] ? status : low), 'redistributable' as WorkbenchRightsStatus);
}

export function computeRights(input: {
  files: Array<{ path: string; captured: boolean }>;
  declaration: RightsDeclaration | undefined;
  principalId: string;
  surface: WorkbenchDeclarationSurface;
}): { rights: UnitSavePlan['rights']; operationRights: OperationRight[] } {
  const { declaration } = input;
  const files = input.files.map(file => {
    const basis = fileBasis(file.path, file.captured, declaration);
    return { path: file.path, basis, status: statusFor(basis, declaration) };
  });
  const status = aggregateStatus(files.map(file => file.status));
  const rights: UnitSavePlan['rights'] = {
    status,
    basis: declaration?.basis ?? null,
    evidenceRefs: declaration?.evidenceRefs ?? [],
    notices: declaration?.notices ?? [],
    ...(declaration?.privateUseAttestation ? { privateUseAttestation: declaration.privateUseAttestation } : {}),
    files,
    declaredBy: declaration ? 'user-request' : 'none',
    declaredVia: declaration ? input.surface : null,
  };
  const obligations = (declaration?.notices ?? []).map((description, index) => ({ id: `notice-${index + 1}`, kind: 'notice' as const, description }));
  const scope = (projectScope: 'unbound' | 'any-authorized', visibility: 'private' | 'reusable-distribution') => ({
    projectScope, targetScope: 'any' as const, principalId: input.principalId, projectIds: [], targetProfileIds: [], visibility,
  });
  const privateUse = RANK[status] >= RANK['private-use-only'];
  const privateDecision = (): Pick<OperationRight, 'decision' | 'reason' | 'evidenceRefs'> => privateUse
    ? { decision: 'allowed', reason: null, evidenceRefs: [DECLARATION_EVIDENCE_REF] }
    : status === 'unknown'
      ? { decision: 'unknown', reason: 'No ownership, licence or private-use authority is recorded for every included file', evidenceRefs: [] }
      : { decision: 'blocked', reason: 'Reference-only material cannot be saved as a reusable unit', evidenceRefs: [] };
  const redistribute: Pick<OperationRight, 'decision' | 'reason' | 'evidenceRefs'> = status === 'redistributable'
    ? { decision: 'allowed', reason: null, evidenceRefs: [DECLARATION_EVIDENCE_REF] }
    : status === 'unknown'
      ? { decision: 'unknown', reason: 'Rights are unknown', evidenceRefs: [] }
      : { decision: 'blocked', reason: `A ${status} unit cannot be redistributed`, evidenceRefs: [] };
  const operationRights: OperationRight[] = [
    { operation: 'save-private-unit', scope: scope('unbound', 'private'), obligations, ...privateDecision() },
    { operation: 'reuse-private-project', scope: scope('any-authorized', 'private'), obligations, ...privateDecision() },
    { operation: 'redistribute-unit', scope: scope('unbound', 'reusable-distribution'), obligations, ...redistribute },
  ];
  return { rights, operationRights };
}
