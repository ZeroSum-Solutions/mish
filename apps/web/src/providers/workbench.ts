import { parseResourceSearchRequest, parseResourceSearchResponse, parseResourceDetailResponse, type ResourceSearchRequest, type ResourceSearchResponse, type ResourceDetailResponse, type WorkspaceCollabContext } from '@open-design/contracts';
import { parseFontCheckRequest, parseFontCheckResponse, type FontCheckRequest, type FontCheckResponse } from '@open-design/contracts';
import { parsePutSessionModel, parseSessionModelSnapshot, type PutSessionModel, type SessionModelSnapshot } from '@open-design/contracts';
import { parseModelPreflightRequest, parseModelPreflightResult, type ModelPreflightRequest, type ModelPreflightResult } from '@open-design/contracts';
import {
  parseProjectDesignContextSnapshot, parseProjectRubricSnapshot, parseWorkbenchPreferencesSnapshot,
  parsePutProjectDesignContext, parsePutProjectRubric, parsePutWorkbenchPreferences,
  type PutProjectDesignContext, type PutProjectRubric, type PutWorkbenchPreferences,
} from '@open-design/contracts';
import {
  parseDesignBriefPreview, parsePreviewDesignBriefRequest, parseAttachDesignBriefRequest, parseCreateDesignBriefRequest, parseDesignBriefRecordView, parsePatchDesignBriefRequest,
  type DesignBriefPreview, type PreviewDesignBriefRequest, type AttachDesignBriefRequest, type CreateDesignBriefRequest, type DesignBriefRecordView, type PatchDesignBriefRequest,
} from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

export class WorkbenchRequestError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string, public readonly nextSteps: string[] = [], public readonly current?: unknown) { super(message); }
}
async function checkedJson(response: Response, parseCurrent?: (value: unknown) => unknown): Promise<unknown> {
  const body: unknown = await response.json();
  if (!response.ok) {
    const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error as Record<string, unknown> : envelope;
    const code = typeof error.code === 'string' ? error.code : typeof envelope.error === 'string' ? envelope.error : 'workbench-request-failed';
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    const steps = details.nextSteps ?? error.nextSteps ?? envelope.nextSteps;
    throw new WorkbenchRequestError(response.status, code, typeof error.message === 'string' ? error.message : code, Array.isArray(steps) ? steps.filter((v): v is string => typeof v === 'string') : [], details.current === undefined ? undefined : parseCurrent?.(details.current));
  }
  return body;
}
function headers(projectId?: string, workspaceContext?: WorkspaceCollabContext | null): Record<string, string> {
  return { ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) : {}), ...(projectId ? { 'x-od-project-id': projectId } : {}) } as Record<string, string>;
}
export async function searchWorkbenchResources(request: ResourceSearchRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<ResourceSearchResponse> {
  const parsed = parseResourceSearchRequest(request);
  const response = await fetch('/api/workbench/resources/search', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(parsed.projectId, workspaceContext) }, body: JSON.stringify(parsed) });
  return parseResourceSearchResponse(await checkedJson(response));
}
export async function getWorkbenchResource(refKey: string, projectId?: string, workspaceContext?: WorkspaceCollabContext | null): Promise<ResourceDetailResponse> {
  const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
  const response = await fetch(`/api/workbench/resources/${encodeURIComponent(refKey)}${query}`, { headers: headers(projectId, workspaceContext) });
  return parseResourceDetailResponse(await checkedJson(response));
}

/** AC-R11.2: the same check `od workbench font-check` runs, for the canvas specimen's text. */
export async function postWorkbenchFontCheck(request: FontCheckRequest, workspaceContext?: WorkspaceCollabContext | null, options?: { signal?: AbortSignal }): Promise<FontCheckResponse> {
  const parsed = parseFontCheckRequest(request);
  const response = await fetch('/api/workbench/fonts/check', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(parsed.projectId, workspaceContext) }, body: JSON.stringify(parsed), ...(options?.signal ? { signal: options.signal } : {}) });
  return parseFontCheckResponse(await checkedJson(response));
}

export async function getSessionModel(sessionId: string, projectId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<SessionModelSnapshot> {
  const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(sessionId)}/model`, { headers: headers(projectId, workspaceContext) });
  const snapshot = parseSessionModelSnapshot(await checkedJson(response));
  if (snapshot.sessionId !== sessionId || snapshot.projectId !== projectId) throw new Error('session-model-scope-mismatch');
  return snapshot;
}
export async function putSessionModel(sessionId: string, projectId: string, input: PutSessionModel, workspaceContext?: WorkspaceCollabContext | null): Promise<SessionModelSnapshot> {
  const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(sessionId)}/model`, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...headers(projectId, workspaceContext) }, body: JSON.stringify(parsePutSessionModel(input)) });
  const snapshot = parseSessionModelSnapshot(await checkedJson(response));
  if (snapshot.sessionId !== sessionId || snapshot.projectId !== projectId) throw new Error('session-model-scope-mismatch');
  return snapshot;
}
/**
 * AC-R02.3: advisory, non-mutating pre-submit capability check — never
 * touches the stored session choice. Callers run this with the candidate
 * agent/model/attachments before starting a run so a mismatch (an
 * unavailable agent/model, an attachment the agent will not forward to its
 * model, or an oversize attachment) surfaces instead of silently dropping
 * content or failing deep inside a spawned run.
 */
export async function postModelPreflight(sessionId: string, projectId: string, input: ModelPreflightRequest, workspaceContext?: WorkspaceCollabContext | null, options?: { signal?: AbortSignal }): Promise<ModelPreflightResult> {
  const response = await fetch(`/api/workbench/sessions/${encodeURIComponent(sessionId)}/model/preflight`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(projectId, workspaceContext) }, body: JSON.stringify(parseModelPreflightRequest(input)), ...(options?.signal ? { signal: options.signal } : {}) });
  return parseModelPreflightResult(await checkedJson(response));
}
async function projectRecord<T extends { projectId: string; revision: number }>(
  family: 'context' | 'rubric' | 'preferences', projectId: string, parse: (value: unknown) => T,
  workspaceContext?: WorkspaceCollabContext | null, input?: unknown, revision?: number,
): Promise<T> {
  if (!projectId || projectId !== projectId.trim() || /\p{Cc}/u.test(projectId)) throw new Error('project-record-scope-mismatch');
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 1)) throw new Error('project-record-revision-invalid');
  const scoped = (value: unknown) => {
    const snapshot = parse(value);
    if (snapshot.projectId !== projectId || (revision !== undefined && snapshot.revision !== revision)) throw new Error('project-record-scope-mismatch');
    return snapshot;
  };
  const response = await fetch(`/api/workbench/projects/${encodeURIComponent(projectId)}/${family}${revision === undefined ? '' : `?revision=${revision}`}`, {
    method: input === undefined ? 'GET' : 'PUT', headers: { ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers(projectId, workspaceContext) },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
  return scoped(await checkedJson(response, scoped));
}
export const getProjectDesignContext = (projectId: string, workspaceContext?: WorkspaceCollabContext | null, revision?: number) => projectRecord('context', projectId, parseProjectDesignContextSnapshot, workspaceContext, undefined, revision);
export const putProjectDesignContext = (projectId: string, input: PutProjectDesignContext, workspaceContext?: WorkspaceCollabContext | null) => projectRecord('context', projectId, parseProjectDesignContextSnapshot, workspaceContext, parsePutProjectDesignContext(input));
export const getProjectRubric = (projectId: string, workspaceContext?: WorkspaceCollabContext | null, revision?: number) => projectRecord('rubric', projectId, parseProjectRubricSnapshot, workspaceContext, undefined, revision);
export const putProjectRubric = (projectId: string, input: PutProjectRubric, workspaceContext?: WorkspaceCollabContext | null) => projectRecord('rubric', projectId, parseProjectRubricSnapshot, workspaceContext, parsePutProjectRubric(input));
export const getWorkbenchPreferences = (projectId: string, workspaceContext?: WorkspaceCollabContext | null, revision?: number) => projectRecord('preferences', projectId, parseWorkbenchPreferencesSnapshot, workspaceContext, undefined, revision);
export const putWorkbenchPreferences = (projectId: string, input: PutWorkbenchPreferences, workspaceContext?: WorkspaceCollabContext | null) => projectRecord('preferences', projectId, parseWorkbenchPreferencesSnapshot, workspaceContext, parsePutWorkbenchPreferences(input));

/** R15 Improve prompt: the same endpoints as `od workbench transform` and `od workbench brief …`. Transforming never starts a run. */
export async function createDesignBrief(input: CreateDesignBriefRequest, workspaceContext?: WorkspaceCollabContext | null, options?: { signal?: AbortSignal }): Promise<DesignBriefRecordView> {
  const parsed = parseCreateDesignBriefRequest(input);
  const response = await fetch('/api/workbench/briefs', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(parsed.projectId, workspaceContext) }, body: JSON.stringify(parsed), ...(options?.signal ? { signal: options.signal } : {}) });
  return parseDesignBriefRecordView(await checkedJson(response));
}
export async function getDesignBrief(projectId: string, briefId: string, workspaceContext?: WorkspaceCollabContext | null, options?: { signal?: AbortSignal }): Promise<DesignBriefRecordView> {
  const response = await fetch(`/api/workbench/briefs/${encodeURIComponent(briefId)}?projectId=${encodeURIComponent(projectId)}`, { headers: headers(projectId, workspaceContext), ...(options?.signal ? { signal: options.signal } : {}) });
  return parseDesignBriefRecordView(await checkedJson(response));
}
export async function patchDesignBrief(projectId: string, briefId: string, patch: PatchDesignBriefRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<DesignBriefRecordView> {
  const response = await fetch(`/api/workbench/briefs/${encodeURIComponent(briefId)}?projectId=${encodeURIComponent(projectId)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', ...headers(projectId, workspaceContext) }, body: JSON.stringify(parsePatchDesignBriefRequest(patch)) });
  return parseDesignBriefRecordView(await checkedJson(response));
}
export async function cancelDesignBrief(projectId: string, briefId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<DesignBriefRecordView> {
  const response = await fetch(`/api/workbench/briefs/${encodeURIComponent(briefId)}/cancel?projectId=${encodeURIComponent(projectId)}`, { method: 'POST', headers: headers(projectId, workspaceContext) });
  return parseDesignBriefRecordView(await checkedJson(response));
}

/** Home transforms without a project; only the caller holds the result. */
export async function previewDesignBrief(request: PreviewDesignBriefRequest, workspaceContext?: WorkspaceCollabContext | null, options?: { signal?: AbortSignal }): Promise<DesignBriefPreview> {
  const response = await fetch('/api/workbench/briefs/preview', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(undefined, workspaceContext) }, body: JSON.stringify(parsePreviewDesignBriefRequest(request)), ...(options?.signal ? { signal: options.signal } : {}) });
  return parseDesignBriefPreview(await checkedJson(response));
}
export async function attachDesignBrief(request: AttachDesignBriefRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<DesignBriefRecordView> {
  const parsed = parseAttachDesignBriefRequest(request);
  const response = await fetch('/api/workbench/briefs/attach', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(parsed.projectId, workspaceContext) }, body: JSON.stringify(parsed) });
  return parseDesignBriefRecordView(await checkedJson(response));
}
