import {
  CATALOGUE_TARGET_ADAPTERS, CATALOGUE_TARGET_REASONS, parseAdoptionOperationResponse, parseApplyAdoptionRequest, parseCatalogueAdoptionRequest, parseCatalogueAdoptionResponse,
  parseCatalogueSaveRequest, parseCatalogueSavedUnitDeleteResponse, parseCatalogueSavedUnitResponse, parseCatalogueSavedUnitsResponse,
  type AdoptionOperationView, type CatalogueAdoptionRequest, type CatalogueAdoptionResponse, type CatalogueDependencyReport,
  type CatalogueReplacementReview, type CatalogueSaveRequest, type CatalogueSavedUnit, type CatalogueTargetRefusal, type PreparedAdoptionPlan, type WorkspaceCollabContext,
  parseWorkbenchAdoptionStatusResponse, type WorkbenchAdoptionStatusResponse,
} from '@mish/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import { WorkbenchRequestError } from './workbench';

/** A refused adoption request with the daemon's typed reason and the details the user must see. */
export class AdoptionRequestError extends WorkbenchRequestError {
  constructor(status: number, code: string, message: string, readonly reason: string | null, readonly details: Record<string, unknown>) {
    super(status, code, message);
  }
  /**
   * 422 `dependencies-unsatisfied`: what to install or align. Either list may
   * be absent (read as empty) and a malformed entry is skipped, so one bad
   * entry never hides the packages that are reported correctly.
   */
  get dependencyReport(): CatalogueDependencyReport | null {
    if (this.reason !== 'dependencies-unsatisfied') return null;
    const entries = (value: unknown): Record<string, unknown>[] => Array.isArray(value)
      ? value.filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string')
      : [];
    const text = (value: unknown) => (typeof value === 'string' && value ? value : '*');
    return {
      missing: entries(this.details.missing).map(entry => ({ name: entry.name as string, range: text(entry.range) })),
      incompatible: entries(this.details.incompatible).map(entry => ({ name: entry.name as string, required: text(entry.required), installed: text(entry.installed) })),
    };
  }
  /** 422 `target-incompatible` (G02): the unit's target adapter and what the project manifest declares. */
  get targetRefusal(): CatalogueTargetRefusal | null {
    const { adapter, targetReason, detected } = this.details;
    if (this.reason !== 'target-incompatible' || !detected || typeof detected !== 'object'
      || !(CATALOGUE_TARGET_ADAPTERS as readonly unknown[]).includes(adapter) || !(CATALOGUE_TARGET_REASONS as readonly unknown[]).includes(targetReason)) return null;
    const { framework, reactMajor } = detected as Record<string, unknown>;
    if (typeof framework !== 'string' || !(reactMajor === null || typeof reactMajor === 'number')) return null;
    return { adapter, targetReason, detected: { framework, reactMajor } } as CatalogueTargetRefusal;
  }
  /** 409 `replacement-review-required`: the diff to review before replacing project bytes. */
  get replacementReview(): CatalogueReplacementReview | null {
    const review = this.details.review;
    return this.reason === 'replacement-review-required' && review && typeof review === 'object' ? review as CatalogueReplacementReview : null;
  }
}

async function adoptionJson(response: Response): Promise<unknown> {
  const body: unknown = await response.json();
  if (response.ok) return body;
  const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = envelope.error && typeof envelope.error === 'object' ? envelope.error as Record<string, unknown> : {};
  const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
  const code = typeof error.code === 'string' ? error.code : 'adoption-request-failed';
  throw new AdoptionRequestError(response.status, code, typeof error.message === 'string' ? error.message : code, typeof details.reason === 'string' ? details.reason : null, details);
}
function headers(projectId: string, workspaceContext?: WorkspaceCollabContext | null): Record<string, string> {
  return { 'Content-Type': 'application/json', ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {}), 'x-od-project-id': projectId };
}
const BASE = '/api/workbench/adoption';

export async function getAdoptionStatus(): Promise<WorkbenchAdoptionStatusResponse> {
  const response = await fetch(`${BASE}/status`);
  return parseWorkbenchAdoptionStatusResponse(await adoptionJson(response));
}

/** Reads the same admitted catalogue source without requiring the placement helper. */
export async function copyWorkbenchCode(refKey: string): Promise<string> {
  const response = await fetch(`${BASE}/catalogue/copy/${encodeURIComponent(refKey)}`);
  const body = await adoptionJson(response);
  if (!body || typeof body !== 'object' || typeof (body as { code?: unknown }).code !== 'string') throw new Error('Code is unavailable');
  return (body as { code: string }).code;
}

/** Same endpoint as `od workbench adoption catalogue-prepare`. Never writes the project. */
export async function prepareCatalogueAdoption(request: CatalogueAdoptionRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<CatalogueAdoptionResponse> {
  const parsed = parseCatalogueAdoptionRequest(request);
  const response = await fetch(`${BASE}/catalogue/prepare`, { method: 'POST', headers: headers(parsed.projectId, workspaceContext), body: JSON.stringify(parsed) });
  return parseCatalogueAdoptionResponse(await adoptionJson(response));
}
/** Same endpoint as `od workbench adoption apply`: names only the stored plan ID and digest. */
export async function applyAdoptionPlan(plan: PreparedAdoptionPlan, workspaceContext?: WorkspaceCollabContext | null): Promise<AdoptionOperationView> {
  const body = parseApplyAdoptionRequest({ planId: plan.id, planDigest: plan.digest });
  const response = await fetch(`${BASE}/apply`, { method: 'POST', headers: headers(plan.projectId, workspaceContext), body: JSON.stringify(body) });
  return parseAdoptionOperationResponse(await adoptionJson(response)).operation;
}
/** Same endpoint as `od workbench adoption undo`. */
export async function undoAdoptionOperation(operation: AdoptionOperationView, workspaceContext?: WorkspaceCollabContext | null): Promise<AdoptionOperationView> {
  const response = await fetch(`${BASE}/operations/${encodeURIComponent(operation.operationId)}/undo`, { method: 'POST', headers: headers(operation.projectId, workspaceContext) });
  return parseAdoptionOperationResponse(await adoptionJson(response)).operation;
}
/** Same endpoint as `od workbench adoption catalogue-save`: saves the applied unit, as edited, for private reuse. */
export async function saveCatalogueUnit(request: CatalogueSaveRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<CatalogueSavedUnit> {
  const parsed = parseCatalogueSaveRequest(request);
  const response = await fetch(`${BASE}/catalogue/save`, { method: 'POST', headers: headers(parsed.projectId, workspaceContext), body: JSON.stringify(parsed) });
  return parseCatalogueSavedUnitResponse(await adoptionJson(response)).savedUnit;
}
/** Same endpoint as `od workbench adoption catalogue-saved delete <id>`: removes one of the caller's saved units. */
export async function deleteSavedCatalogueUnit(id: string, workspaceContext?: WorkspaceCollabContext | null): Promise<void> {
  const response = await fetch(`${BASE}/catalogue/saved/${encodeURIComponent(id)}`, { method: 'DELETE', headers: workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {} });
  parseCatalogueSavedUnitDeleteResponse(await adoptionJson(response));
}
/** Same endpoint as `od workbench adoption catalogue-saved`: the caller's saved units for one catalogue reference. */
export async function listSavedCatalogueUnits(refKey: string, workspaceContext?: WorkspaceCollabContext | null): Promise<CatalogueSavedUnit[]> {
  const response = await fetch(`${BASE}/catalogue/saved?refKey=${encodeURIComponent(refKey)}`, { headers: workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {} });
  return parseCatalogueSavedUnitsResponse(await adoptionJson(response)).savedUnits;
}
