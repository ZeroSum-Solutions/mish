import {
  parseCreateIntakeBatchRequest, parseIntakeBatchSnapshot, parseListIntakeBatchesResponse,
  parseIntakeFilePutResponse, parseClearIntakeRequest, parseAttachIntakeRequest, parseAttachIntakeResponse,
  type CreateIntakeBatchRequest, type IntakeBatchSnapshot, type ListIntakeBatchesResponse,
  type IntakeFilePutResponse, type ClearIntakeRequest, type AttachIntakeRequest, type AttachIntakeResponse,
  type WorkspaceCollabContext,
} from '@open-design/contracts';
import { workspaceProjectHeaders, workspaceResourceUrl } from '../collab/workspace-identity';
import { transferWithRetry, TransferRetryAfterError } from '../runtime/intake/transfer-queue';
import { readApiErrorBody } from './api-error';

export class IntakeRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) { super(message); }
}

function headers(context?: WorkspaceCollabContext | null): Record<string, string> {
  return context ? workspaceProjectHeaders(context) as Record<string, string> : {};
}
function batchUrl(batchId: string): string { return `/api/workbench/intake/${encodeURIComponent(batchId)}`; }
async function checkedJson(response: Response): Promise<unknown> {
  if (!response.ok) {
    const error = await readApiErrorBody(response);
    throw new IntakeRequestError(response.status, error.message, error.code);
  }
  return response.json();
}

export async function createIntakeBatch(request: CreateIntakeBatchRequest, context?: WorkspaceCollabContext | null): Promise<IntakeBatchSnapshot> {
  const body = parseCreateIntakeBatchRequest(request);
  const response = await fetch('/api/workbench/intake', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(context) }, body: JSON.stringify(body) });
  const snapshot = parseIntakeBatchSnapshot(await checkedJson(response));
  if (snapshot.intakeBatchId !== body.intakeBatchId) throw new Error('Intake receipt identity mismatch');
  return snapshot;
}
export async function getIntakeBatch(batchId: string, context?: WorkspaceCollabContext | null): Promise<IntakeBatchSnapshot> {
  const response = await fetch(batchUrl(batchId), { headers: headers(context) });
  const snapshot = parseIntakeBatchSnapshot(await checkedJson(response));
  if (snapshot.intakeBatchId !== batchId) throw new Error('Intake receipt identity mismatch');
  return snapshot;
}
export async function listIntakeBatches(context?: WorkspaceCollabContext | null): Promise<ListIntakeBatchesResponse> {
  const response = await fetch('/api/workbench/intake?state=pending', { headers: headers(context) });
  return parseListIntakeBatchesResponse(await checkedJson(response));
}
export async function clearIntakeBatch(batchId: string, request: ClearIntakeRequest, context?: WorkspaceCollabContext | null): Promise<IntakeBatchSnapshot> {
  const body = parseClearIntakeRequest(request);
  const response = await fetch(batchUrl(batchId), { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...headers(context) }, body: JSON.stringify(body) });
  const snapshot = parseIntakeBatchSnapshot(await checkedJson(response));
  if (snapshot.intakeBatchId !== batchId) throw new Error('Intake receipt identity mismatch');
  return snapshot;
}
export async function attachIntakeBatch(batchId: string, request: AttachIntakeRequest, context?: WorkspaceCollabContext | null): Promise<AttachIntakeResponse> {
  const body = parseAttachIntakeRequest(request);
  const response = await fetch(`${batchUrl(batchId)}/attach`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers(context) }, body: JSON.stringify(body) });
  const result = parseAttachIntakeResponse(await checkedJson(response));
  if (result.intakeBatchId !== batchId || result.attachments.some((item) => item.projectId !== body.projectId || item.conversationId !== body.conversationId)) throw new Error('Intake attachment identity mismatch');
  return result;
}

/** Direct receipt-addressed navigation; no buffered download or credential URL. */
export function intakeFileDownloadUrl(batchId: string, fileId: string, context?: WorkspaceCollabContext | null): string {
  return workspaceResourceUrl(`${batchUrl(batchId)}/files/${encodeURIComponent(fileId)}/download`, context);
}

function retryDelay(response: Response): number {
  const value = response.headers.get('Retry-After');
  if (!value) return 1000;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 1000;
}

function xhrPut(url: string, body: Blob, requestHeaders: Record<string, string>, signal: AbortSignal, progress: (loaded: number, total: number) => void): Promise<Response> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const done = () => signal.removeEventListener('abort', abort);
    xhr.open('PUT', url);
    for (const [key, value] of Object.entries(requestHeaders)) xhr.setRequestHeader(key, value);
    xhr.upload.onprogress = (event) => progress(event.loaded, event.lengthComputable ? event.total : body.size);
    xhr.onload = () => {
      done();
      if (xhr.status < 100) { reject(new Error('Intake transfer request failed')); return; }
      const responseHeaders = new Headers();
      for (const line of xhr.getAllResponseHeaders().trim().split(/[\r\n]+/)) {
        const separator = line.indexOf(':');
        if (separator > 0) responseHeaders.append(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
      }
      resolve(new Response(xhr.responseText, { status: xhr.status, headers: responseHeaders }));
    };
    xhr.onerror = () => { done(); reject(new Error('Intake transfer request failed')); };
    xhr.onabort = () => { done(); reject(signal.reason ?? new DOMException('Transfer cancelled', 'AbortError')); };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) { done(); reject(signal.reason); return; }
    try { xhr.send(body); } catch (error) { done(); reject(error); }
  });
}

export async function putIntakeFile(batchId: string, fileId: string, body: Blob, context?: WorkspaceCollabContext | null, options: { signal?: AbortSignal; onProgress?: (loaded: number, total: number) => void } = {}): Promise<IntakeFilePutResponse> {
  const url = `${batchUrl(batchId)}/files/${encodeURIComponent(fileId)}`;
  const requestHeaders = { 'Content-Type': 'application/octet-stream', ...headers(context) };
  return transferWithRetry(async (signal) => {
    const response = options.onProgress
      ? await xhrPut(url, body, requestHeaders, signal, options.onProgress)
      : await fetch(url, { method: 'PUT', headers: requestHeaders, body, signal });
    if (response.status === 429) throw new TransferRetryAfterError(retryDelay(response));
    const payload: unknown = await response.clone().json().catch(() => null);
    let result: IntakeFilePutResponse;
    try { result = parseIntakeFilePutResponse(payload); }
    catch (error) { if (!response.ok) await checkedJson(response); throw error; }
    if (result.intakeBatchId !== batchId || result.file.clientFileId !== fileId) throw new Error('Intake receipt identity mismatch');
    return result;
  }, options);
}
