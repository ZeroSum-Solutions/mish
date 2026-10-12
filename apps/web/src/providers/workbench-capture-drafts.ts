import {
  parseCaptureDraftList, parseCaptureDraftRevision, parseCaptureView, parseCreateCaptureDraftRequest,
  parseReusableUnitManifest, parseUnitSavePlan, parseUnitSaveRequest,
  type CaptureDraftRevision, type CaptureView, type CreateCaptureDraftRequest,
  type ReusableUnitManifest, type UnitSavePlan, type UnitSaveRequest, type WorkspaceCollabContext,
} from '@mish/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';
import DOMPurify from 'dompurify';

export class CaptureDraftRequestError extends Error {
  constructor(readonly status: number, readonly reason: string | null, message: string, readonly recovery: string | null) { super(message); }
}

function headers(projectId: string, context?: WorkspaceCollabContext | null, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(context ? workspaceProjectHeaders(context) as Record<string, string> : {}), ...extra, 'x-od-project-id': projectId };
}

async function body(response: Response): Promise<unknown> {
  let value: unknown;
  try { value = await response.json(); } catch { throw new CaptureDraftRequestError(response.status, 'invalid-response', 'The draft response could not be read.', null); }
  if (!response.ok) {
    const error = value && typeof value === 'object' && 'error' in value ? (value as { error?: { message?: unknown; details?: { reason?: unknown; recovery?: unknown } } }).error : undefined;
    throw new CaptureDraftRequestError(response.status, typeof error?.details?.reason === 'string' ? error.details.reason : null,
      typeof error?.message === 'string' ? error.message : `HTTP ${response.status}`, typeof error?.details?.recovery === 'string' ? error.details.recovery : null);
  }
  return value;
}

function scoped(revision: CaptureDraftRevision, projectId: string, captureId?: string): CaptureDraftRevision {
  if (revision.projectId !== projectId || (captureId && revision.captureId !== captureId)) throw new CaptureDraftRequestError(409, 'scope-mismatch', 'The draft response belongs to another project or capture.', null);
  return revision;
}

/** The web and od clients use the same persisted draft revisions and scoped endpoints. */
export const captureDraftApi = {
  async list(projectId: string, context?: WorkspaceCollabContext | null, signal?: AbortSignal): Promise<CaptureDraftRevision[]> {
    const value = parseCaptureDraftList(await body(await fetch(`/api/workbench/capture-drafts?projectId=${encodeURIComponent(projectId)}`, { headers: headers(projectId, context), signal })));
    return value.drafts.map(revision => scoped(revision, projectId));
  },
  async create(request: CreateCaptureDraftRequest, context: WorkspaceCollabContext | null | undefined, idempotencyKey: string): Promise<CaptureDraftRevision> {
    const input = parseCreateCaptureDraftRequest(request);
    return scoped(parseCaptureDraftRevision(await body(await fetch('/api/workbench/capture-drafts', {
      method: 'POST', headers: headers(input.projectId, context, { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }), body: JSON.stringify(input),
    }))), input.projectId, input.captureId);
  },
  async revision(projectId: string, draftId: string, revision: number, context?: WorkspaceCollabContext | null, signal?: AbortSignal): Promise<CaptureDraftRevision> {
    const result = scoped(parseCaptureDraftRevision(await body(await fetch(`/api/workbench/capture-drafts/${encodeURIComponent(draftId)}/revisions/${revision}?projectId=${encodeURIComponent(projectId)}`, { headers: headers(projectId, context), signal }))), projectId);
    if (result.draftId !== draftId || result.revision !== revision) throw new CaptureDraftRequestError(409, 'revision-mismatch', 'The draft response does not match the selected revision.', null);
    return result;
  },
  async capture(projectId: string, captureId: string, context?: WorkspaceCollabContext | null, signal?: AbortSignal): Promise<CaptureView> {
    const view = parseCaptureView(await body(await fetch(`/api/workbench/captures/${encodeURIComponent(captureId)}?projectId=${encodeURIComponent(projectId)}`, { headers: headers(projectId, context), signal })));
    if (view.capture.projectId !== projectId || view.capture.id !== captureId) throw new CaptureDraftRequestError(409, 'scope-mismatch', 'The capture response belongs to another project.', null);
    return view;
  },
};

/** Draft sources carry immutable lineage; the current project scope travels in headers. */
export const captureDraftUnitApi = {
  async plan(projectId: string, request: UnitSaveRequest, context?: WorkspaceCollabContext | null): Promise<UnitSavePlan> {
    return parseUnitSavePlan(await body(await fetch('/api/workbench/units/plan', { method: 'POST', headers: headers(projectId, context, { 'content-type': 'application/json' }), body: JSON.stringify(parseUnitSaveRequest(request)) })));
  },
  async save(projectId: string, request: UnitSaveRequest, context: WorkspaceCollabContext | null | undefined, idempotencyKey: string): Promise<ReusableUnitManifest> {
    return parseReusableUnitManifest(await body(await fetch('/api/workbench/units', { method: 'POST', headers: headers(projectId, context, { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }), body: JSON.stringify(parseUnitSaveRequest(request)) })));
  },
};

/**
 * Inert visual preview only. Sandbox/CSP alone cannot prevent a script from
 * navigating its own frame, so remove active/navigation markup and run no
 * generated script. The persisted HTML and unit source remain unchanged.
 */
export function captureDraftPreviewDocument(html: string): string {
  const safe = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true, ADD_TAGS: ['style'],
    FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'form', 'object', 'embed', 'base', 'meta', 'link'],
    FORBID_ATTR: ['href', 'xlink:href', 'action', 'formaction', 'target', 'download', 'ping', 'srcset', 'poster', 'background', 'autofocus'],
  });
  const policy = "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'; object-src 'none'; worker-src 'none'";
  return `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="referrer" content="no-referrer"></head><body>${safe}</body></html>`;
}
