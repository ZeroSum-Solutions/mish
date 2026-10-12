// Web client for the Mish packs surface (`/api/mish-packs*`, daemon `routes/mish-packs.ts`).
// Settings -> Packs is its caller; `od packs` calls the same routes.
//
// Every result carries a pack error `code`, never the daemon's text: the UI renders its own
// localized message per code. Callers re-read the list after an install or removal.

import type {
  MishPackErrorCode,
  MishPackInstallResponse,
  MishPackRemoveResponse,
  MishPackRuntimeResponse,
  MishPacksListResponse,
} from '@mish/contracts';

import { setStyleCatalogAssetOrigin } from '../runtime/visual-style-catalog';

export type MishPackClientErrorCode = MishPackErrorCode | 'FORBIDDEN' | 'NETWORK_ERROR';
export type MishPackResult<T> = { ok: true; value: T } | { ok: false; code: MishPackClientErrorCode };

/** Header on every multipart upload: a custom header forces a CORS preflight (see the daemon route). */
export const MISH_PACK_UPLOAD_HEADER = 'X-OD-Pack-Upload';

const KNOWN_CODES: ReadonlySet<string> = new Set<MishPackClientErrorCode>([
  'INVALID_MANIFEST', 'INVALID_ARCHIVE', 'UNSAFE_PATH', 'MISSING_RESOURCE', 'TOO_LARGE', 'NOT_FOUND',
  'SOURCE_NOT_FOUND', 'BUSY', 'READ_ONLY', 'INTERNAL_ERROR', 'FORBIDDEN', 'NETWORK_ERROR',
]);

async function errorCodeOf(response: Response): Promise<MishPackClientErrorCode> {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };
    const code = body.error?.code;
    if (typeof code === 'string' && KNOWN_CODES.has(code)) return code as MishPackClientErrorCode;
  } catch {
    // fall through to the status mapping
  }
  if (response.status === 404) return 'NOT_FOUND';
  if (response.status === 403) return 'FORBIDDEN';
  return 'INTERNAL_ERROR';
}

async function call<T>(input: string, init?: RequestInit): Promise<MishPackResult<T>> {
  try {
    const response = await fetch(input, init);
    if (!response.ok) return { ok: false, code: await errorCodeOf(response) };
    return { ok: true, value: (await response.json()) as T };
  } catch {
    return { ok: false, code: 'NETWORK_ERROR' };
  }
}

export function fetchMishPacks(): Promise<MishPackResult<MishPacksListResponse>> {
  return call<MishPacksListResponse>('/api/mish-packs');
}

/** Install from an absolute path on the machine that runs the daemon (a folder or a .zip). */
export function installMishPackFromPath(source: string): Promise<MishPackResult<MishPackInstallResponse>> {
  return call<MishPackInstallResponse>('/api/mish-packs/install', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source }),
  });
}

/** Install from a .zip the person picked in the file dialog. */
export function installMishPackFromFile(file: File): Promise<MishPackResult<MishPackInstallResponse>> {
  const form = new FormData();
  form.set('file', file, file.name);
  return call<MishPackInstallResponse>('/api/mish-packs/install', {
    method: 'POST',
    headers: { [MISH_PACK_UPLOAD_HEADER]: '1' },
    body: form,
  });
}

export function removeMishPack(id: string): Promise<MishPackResult<MishPackRemoveResponse>> {
  return call<MishPackRemoveResponse>(`/api/mish-packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * Applies what the active packs tell the web app: today, where style-picker previews come from.
 * Safe to call at start and after an install or removal; with no pack it clears the origin.
 */
export async function applyMishPackRuntime(): Promise<void> {
  const result = await call<MishPackRuntimeResponse>('/api/mish-packs/runtime');
  if (!result.ok) return;
  const { styleCatalogOrigin, styleCatalogPath } = result.value;
  setStyleCatalogAssetOrigin(styleCatalogOrigin ?? (styleCatalogPath ? `${window.location.origin}${styleCatalogPath}` : null));
}
