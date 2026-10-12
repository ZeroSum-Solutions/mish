import {
  encodeCaptureMetadataHeader, parseCaptureList, parseCaptureView, parseReusableUnitManifest, parseUnitList, parseUnitSavePlan, parseUnitInsertReceipt, parseUnitInsertList,
  WORKBENCH_CAPTURE_METADATA_HEADER,
  type CaptureImportMetadata, type CaptureList, type CaptureView, type ReusableUnitManifest, type UnitSavePlan, type UnitSaveRequest,
  type UnitInsertReceipt, type UnitInsertRequest, type UnitUndoInsertRequest, type WorkspaceCollabContext,
} from '@mish/contracts';
import { workspaceProjectHeaders, workspaceResourceUrl } from '../collab/workspace-identity';

/** A daemon refusal with its typed reason, kept for the UI to show and recover from. */
export class CaptureRequestError extends Error {
  constructor(readonly status: number, readonly reason: string | null, message: string, readonly paths: string[] = [], readonly insertion: UnitInsertReceipt | null = null, readonly discardEditsAllowed = false) { super(message); }
}

function headers(workspaceContext: WorkspaceCollabContext | null | undefined, extra: Record<string, string>): Record<string, string> {
  return { ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {}), ...extra };
}
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `web-${Date.now()}-${Math.random().toString(36).slice(2)}`);

async function body(response: Response): Promise<unknown> {
  let value: unknown = null;
  try { value = await response.json(); } catch { /* handled below */ }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? (value as { error: { message?: unknown; details?: { reason?: unknown; paths?: unknown; insertion?: unknown; discardEditsAllowed?: unknown } } }).error : null;
    const paths = Array.isArray(error?.details?.paths) ? error!.details!.paths.filter((item): item is string => typeof item === 'string') : [];
    let insertion: UnitInsertReceipt | null = null;
    try { if (error?.details?.insertion) insertion = parseUnitInsertReceipt(error.details.insertion); } catch { /* Malformed recovery receipts cannot drive undo. */ }
    throw new CaptureRequestError(response.status, typeof error?.details?.reason === 'string' ? error.details.reason : null, typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`, paths, insertion, error?.details?.discardEditsAllowed === true);
  }
  return value;
}

/** Same endpoints and DTOs as `od workbench capture …`. */
export const captureApi = {
  async list(projectId: string, workspaceContext?: WorkspaceCollabContext | null, cursor?: string): Promise<CaptureList> {
    const query = `projectId=${encodeURIComponent(projectId)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    return parseCaptureList(await body(await fetch(`/api/workbench/captures?${query}`, { headers: headers(workspaceContext, { 'x-od-project-id': projectId }) })));
  },
  async save(image: Blob, metadata: CaptureImportMetadata, workspaceContext?: WorkspaceCollabContext | null, idempotencyKey = newKey()): Promise<CaptureView> {
    return parseCaptureView(await body(await fetch(`/api/workbench/captures?projectId=${encodeURIComponent(metadata.projectId)}`, {
      method: 'POST',
      headers: headers(workspaceContext, { 'content-type': image.type || 'image/png', [WORKBENCH_CAPTURE_METADATA_HEADER]: encodeCaptureMetadataHeader(metadata), 'idempotency-key': idempotencyKey, 'x-od-project-id': metadata.projectId }),
      body: image,
    })));
  },
};

/** Same endpoints and DTOs as `od workbench unit …`. */
export const unitApi = {
  async listInsertions(unitId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<UnitInsertReceipt[]> {
    return parseUnitInsertList(await body(await fetch(`/api/workbench/units/${encodeURIComponent(unitId)}/inserts`, { headers: headers(workspaceContext, {}) }))).insertions;
  },
  async insert(unitId: string, request: UnitInsertRequest, workspaceContext?: WorkspaceCollabContext | null, idempotencyKey = newKey()): Promise<UnitInsertReceipt> {
    return parseUnitInsertReceipt(await body(await fetch(`/api/workbench/units/${encodeURIComponent(unitId)}/insert`, { method: 'POST', headers: headers(workspaceContext, { 'content-type': 'application/json', 'x-od-project-id': request.projectId, 'idempotency-key': idempotencyKey }), body: JSON.stringify(request) })));
  },
  async undoInsert(insertId: string, workspaceContext?: WorkspaceCollabContext | null, request: UnitUndoInsertRequest = {}): Promise<UnitInsertReceipt> {
    return parseUnitInsertReceipt(await body(await fetch(`/api/workbench/unit-inserts/${encodeURIComponent(insertId)}/undo`, { method: 'POST', headers: headers(workspaceContext, { 'content-type': 'application/json' }), body: JSON.stringify(request) })));
  },
  async plan(request: UnitSaveRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<UnitSavePlan> {
    const projectId = request.source.kind === 'project' ? request.source.projectId : null;
    return parseUnitSavePlan(await body(await fetch('/api/workbench/units/plan', { method: 'POST', headers: headers(workspaceContext, { 'content-type': 'application/json', ...(projectId ? { 'x-od-project-id': projectId } : {}) }), body: JSON.stringify(request) })));
  },
  async save(request: UnitSaveRequest, workspaceContext?: WorkspaceCollabContext | null, idempotencyKey = newKey()): Promise<ReusableUnitManifest> {
    const projectId = request.source.kind === 'project' ? request.source.projectId : null;
    return parseReusableUnitManifest(await body(await fetch('/api/workbench/units', { method: 'POST', headers: headers(workspaceContext, { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, ...(projectId ? { 'x-od-project-id': projectId } : {}) }), body: JSON.stringify(request) })));
  },
  async list(workspaceContext?: WorkspaceCollabContext | null): Promise<ReusableUnitManifest[]> {
    return parseUnitList(await body(await fetch('/api/workbench/units', { headers: headers(workspaceContext, {}) }))).units;
  },
  /** For an <img>: workspace authority travels in the query because images cannot send headers. */
  thumbnailUrl(unitId: string, workspaceContext?: WorkspaceCollabContext | null): string { return workspaceResourceUrl(`/api/workbench/units/${encodeURIComponent(unitId)}/thumbnail`, workspaceContext); },
};
