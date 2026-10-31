// Client for the daemon's link-page API (`apps/daemon/src/routes/linkpage.ts`, contract in
// `packages/contracts/src/api/linkpage.ts`). The same endpoints `od linkpage …` calls.

import type {
  LinkPageAssetResponse,
  LinkPageBuildRequest,
  LinkPageBuildResponse,
  LinkPageExportResponse,
  LinkPageGetResponse,
  LinkPageListResponse,
  LinkPagePutRequest,
  LinkPagePublicRecord,
  LinkPageSummary,
} from '@mish/contracts';

async function failure(resp: Response): Promise<Error> {
  let message = `request failed (${resp.status})`;
  try {
    const body = (await resp.json()) as { error?: { message?: string } | string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message;
    if (detail) message = detail;
  } catch {
    // keep the status text
  }
  return new Error(message);
}

async function json<T>(resp: Response): Promise<T> {
  if (!resp.ok) throw await failure(resp);
  return (await resp.json()) as T;
}

const base = (slug: string) => `/api/linkpages/${encodeURIComponent(slug)}`;

export async function listLinkPages(): Promise<LinkPageSummary[]> {
  return (await json<LinkPageListResponse>(await fetch('/api/linkpages'))).pages;
}

export async function getLinkPage(slug: string): Promise<LinkPagePublicRecord> {
  return (await json<LinkPageGetResponse>(await fetch(base(slug)))).page;
}

export async function buildLinkPage(request: LinkPageBuildRequest): Promise<LinkPageBuildResponse> {
  return json<LinkPageBuildResponse>(
    await fetch('/api/linkpages/build', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(request),
    }),
  );
}

export async function putLinkPage(slug: string, request: LinkPagePutRequest): Promise<LinkPagePublicRecord> {
  return (
    await json<LinkPageGetResponse>(
      await fetch(base(slug), {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      }),
    )
  ).page;
}

export async function uploadLinkPageAsset(slug: string, name: string, file: Blob): Promise<LinkPageAssetResponse> {
  return json<LinkPageAssetResponse>(
    await fetch(`${base(slug)}/assets/${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': file.type },
      body: file,
    }),
  );
}

export async function exportLinkPage(slug: string): Promise<LinkPageExportResponse> {
  return json<LinkPageExportResponse>(await fetch(`${base(slug)}/export`));
}

/** The sandboxed preview document. `version` changes after each build or save so the frame reloads. */
export function linkPageRenderUrl(slug: string, version: number): string {
  return `${base(slug)}/render?v=${version}`;
}

export function linkPageAssetUrl(slug: string, assetPath: string, version: number): string {
  return `${base(slug)}/${assetPath.split('/').map(encodeURIComponent).join('/')}?v=${version}`;
}
