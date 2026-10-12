// Web client for the licensed pack install surface (`/api/packs*`, daemon
// `routes/packs.ts`). Settings → Licensed packs is its only caller; `od pack`
// calls the same routes.
//
// Every result carries a pack error `code`, never the daemon's text: the UI
// renders its own localized message per code. Callers re-read the list after
// an install or removal instead of patching state from the success event, so
// a pack whose files went missing shows its live `damaged` status.

import {
  isPackApiErrorCode,
  PACK_INSTALL_FORM_FIELDS,
  parsePackApiError,
  parsePackGithubAccessStatus,
  parsePackListResponse,
  type InstalledPackSummary,
  type PackApiErrorCode,
  type PackGithubAccessStatus,
  type PackInstallOutcome,
  type PackInstallPhase,
  type PackInstallRequest,
} from '@open-design/contracts';

import { parseSseFrame } from '../providers/sse';

/** Codes the web layer adds for failures that never reached a pack route. */
export type PackClientErrorCode = PackApiErrorCode | 'NETWORK_ERROR';

export type PackResult<T> = { ok: true; value: T } | { ok: false; code: PackClientErrorCode };

export type PackInstallUpdate = { phase: PackInstallPhase; bytes?: number; totalBytes?: number };

export type PackInstallResult =
  | { ok: true; outcome: PackInstallOutcome; pack: InstalledPackSummary; warnings: string[] }
  | { ok: false; code: PackClientErrorCode; warnings?: string[] };

/**
 * Header on every multipart upload. A custom header makes the browser
 * preflight the request, so a page on another origin (a powered preview)
 * cannot send the upload as a CORS-simple POST; the daemon refuses an upload
 * without it.
 */
export const PACK_UPLOAD_HEADER = 'X-OD-Pack-Upload';

function warningsOf(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((w): w is string => typeof w === 'string') : [];
}

async function errorCodeOf(response: Response): Promise<PackClientErrorCode> {
  try {
    const parsed = parsePackApiError(await response.json());
    if (parsed) return parsed.code;
  } catch {
    // fall through to the status mapping
  }
  if (response.status === 404) return 'PACK_NOT_FOUND';
  if (response.status === 403) return 'FORBIDDEN';
  return 'INTERNAL_ERROR';
}

async function request(input: string, init?: RequestInit): Promise<Response | null> {
  try {
    return await fetch(input, init);
  } catch {
    return null;
  }
}

export async function fetchInstalledPacks(): Promise<PackResult<InstalledPackSummary[]>> {
  const response = await request('/api/packs');
  if (!response) return { ok: false, code: 'NETWORK_ERROR' };
  if (!response.ok) return { ok: false, code: await errorCodeOf(response) };
  try {
    const parsed = parsePackListResponse(await response.json());
    return parsed ? { ok: true, value: parsed.packs } : { ok: false, code: 'INTERNAL_ERROR' };
  } catch {
    return { ok: false, code: 'INTERNAL_ERROR' };
  }
}

export async function removeInstalledPack(id: string): Promise<PackResult<{ id: string; removedVersion: string }>> {
  const response = await request(`/api/packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!response) return { ok: false, code: 'NETWORK_ERROR' };
  if (!response.ok) return { ok: false, code: await errorCodeOf(response) };
  const body = (await response.json().catch(() => null)) as { id?: unknown; removedVersion?: unknown } | null;
  return {
    ok: true,
    value: { id: typeof body?.id === 'string' ? body.id : id, removedVersion: typeof body?.removedVersion === 'string' ? body.removedVersion : '' },
  };
}

async function accessCall(init?: RequestInit): Promise<PackResult<PackGithubAccessStatus>> {
  const response = await request('/api/packs/github-access', init);
  if (!response) return { ok: false, code: 'NETWORK_ERROR' };
  if (!response.ok) return { ok: false, code: await errorCodeOf(response) };
  const status = parsePackGithubAccessStatus(await response.json().catch(() => null));
  return status ? { ok: true, value: status } : { ok: false, code: 'INTERNAL_ERROR' };
}

export function fetchGithubAccessStatus(): Promise<PackResult<PackGithubAccessStatus>> {
  return accessCall();
}

/** The token travels only in this POST body. */
export function saveGithubToken(token: string): Promise<PackResult<PackGithubAccessStatus>> {
  return accessCall({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
}

export function clearGithubToken(): Promise<PackResult<PackGithubAccessStatus>> {
  return accessCall({ method: 'DELETE' });
}

export type PackInstallSource =
  | { kind: 'source'; request: PackInstallRequest }
  | { kind: 'file'; file: Blob; fileName: string; sha256: string; force: boolean };

/**
 * POST /api/packs/install and follow its SSE stream. A refusal before the
 * stream (400/409/413) and an `error` event both resolve `{ok: false, code}`.
 */
export async function installPack(
  source: PackInstallSource,
  onProgress: (update: PackInstallUpdate) => void,
  signal?: AbortSignal,
): Promise<PackInstallResult> {
  let init: RequestInit;
  if (source.kind === 'file') {
    const form = new FormData();
    form.append(PACK_INSTALL_FORM_FIELDS.sha256, source.sha256);
    if (source.force) form.append(PACK_INSTALL_FORM_FIELDS.force, 'true');
    form.append(PACK_INSTALL_FORM_FIELDS.archive, source.file, source.fileName);
    init = { method: 'POST', body: form, headers: { [PACK_UPLOAD_HEADER]: '1' }, signal };
  } else {
    init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(source.request),
      signal,
    };
  }
  const response = await request('/api/packs/install', init);
  if (!response) return { ok: false, code: signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR' };
  if (!response.ok) return { ok: false, code: await errorCodeOf(response) };
  if (!response.body) return { ok: false, code: 'INTERNAL_ERROR' };

  let result: PackInstallResult | null = null;
  const handle = (frame: string) => {
    const parsed = parseSseFrame(frame);
    if (!parsed || parsed.kind !== 'event') return;
    const data = parsed.data;
    if (parsed.event === 'progress' && typeof data.phase === 'string') {
      const update: PackInstallUpdate = { phase: data.phase as PackInstallPhase };
      if (typeof data.bytes === 'number') update.bytes = data.bytes;
      if (typeof data.totalBytes === 'number') update.totalBytes = data.totalBytes;
      onProgress(update);
    } else if (parsed.event === 'success' && data.pack && typeof data.outcome === 'string') {
      result = {
        ok: true,
        outcome: data.outcome as PackInstallOutcome,
        pack: data.pack as InstalledPackSummary,
        warnings: warningsOf(data.warnings),
      };
    } else if (parsed.event === 'error') {
      result = { ok: false, code: isPackApiErrorCode(data.code) ? data.code : 'INTERNAL_ERROR', warnings: warningsOf(data.warnings) };
    }
  };

  try {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
      let index: number;
      while ((index = buffer.indexOf('\n\n')) >= 0) {
        handle(buffer.slice(0, index));
        buffer = buffer.slice(index + 2);
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) handle(buffer);
  } catch {
    if (!result) return { ok: false, code: signal?.aborted ? 'CANCELLED' : 'NETWORK_ERROR' };
  }
  return result ?? { ok: false, code: 'INTERNAL_ERROR' };
}
