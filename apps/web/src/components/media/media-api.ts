/**
 * The canvas media workbench's HTTP client. Every call goes to the same
 * daemon endpoint its `od media …` subcommand uses, so the UI and the CLI
 * can never disagree about what a task, a gallery entry or a lineage is.
 *
 * | UI action          | Endpoint                                              | CLI                     |
 * |--------------------|-------------------------------------------------------|-------------------------|
 * | model catalogue    | GET  /api/media/models                                | od media generate --help |
 * | create             | POST /api/projects/:id/media/generate                 | od media generate       |
 * | cancel             | POST /api/media/tasks/:id/cancel                      | od media cancel         |
 * | retry              | POST /api/media/tasks/:id/retry (Idempotency-Key)     | od media retry          |
 * | gallery page       | GET  /api/projects/:id/media/gallery                  | od media gallery        |
 * | entry + chain      | GET  /api/projects/:id/media/gallery/:entryId         | od media gallery --entry |
 * | place              | POST …/gallery/:entryId/place (Idempotency-Key)       | od media place          |
 * | reuse              | POST …/gallery/:entryId/reuse (Idempotency-Key)       | od media reuse          |
 * | unlink             | POST …/gallery/:entryId/unlink                        | od media unlink         |
 */
import type {
  MediaGalleryEntryDetail,
  MediaGalleryPlaceResponse,
  MediaGalleryResponse,
  MediaGalleryReuseResponse,
  MediaGalleryUnlinkResponse,
  MediaSurface,
  MediaTaskCancelResponse,
  MediaTaskRetryResponse,
  MediaTaskStatus,
  WorkspaceCollabContext,
} from '@mish/contracts';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';

/** One model as `GET /api/media/models` lists it. */
export interface MediaCatalogModel {
  id: string;
  label: string;
  hint?: string;
  provider: string;
  caps?: string[];
  default?: boolean;
}

export interface MediaCatalogProvider {
  id: string;
  label: string;
  hint?: string;
  /** False when the daemon has no real renderer: output is a placeholder. */
  integrated: boolean;
}

export interface MediaCatalog {
  providers: MediaCatalogProvider[];
  image: MediaCatalogModel[];
  video: MediaCatalogModel[];
  aspects: string[];
  videoLengthsSec: number[];
}

/** The generate body this form sends; a subset of the daemon's request record. */
export interface MediaCreateRequest {
  surface: Extract<MediaSurface, 'image' | 'video'>;
  model: string;
  prompt: string;
  aspect?: string;
  length?: number;
  image?: string;
}

export interface MediaGalleryFilters {
  kind?: MediaSurface;
  status: MediaTaskStatus[];
  provider?: string;
  /** Inclusive lower bound, epoch ms. */
  from?: number;
  /** Exclusive upper bound, epoch ms. */
  to?: number;
}

export class MediaRequestError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

async function checked<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const envelope = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const error = envelope.error && typeof envelope.error === 'object'
      ? envelope.error as Record<string, unknown>
      : envelope;
    const code = typeof error.code === 'string' ? error.code : `HTTP_${response.status}`;
    const message = typeof error.message === 'string'
      ? error.message
      : typeof envelope.error === 'string' ? envelope.error : `HTTP ${response.status}`;
    const details = error.details && typeof error.details === 'object' ? error.details as Record<string, unknown> : {};
    throw new MediaRequestError(response.status, code, message, details);
  }
  return body as T;
}

function scopeHeaders(workspaceContext?: WorkspaceCollabContext | null, extra: Record<string, string> = {}): Record<string, string> {
  return { ...(workspaceContext ? workspaceProjectHeaders(workspaceContext) as Record<string, string> : {}), ...extra };
}

const projectPath = (projectId: string) => `/api/projects/${encodeURIComponent(projectId)}`;

/** A fresh key for one user intent. Reuse it when the same intent is resent. */
export function newIdempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return `web-${crypto.randomUUID()}`;
  return `web-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

function asModels(value: unknown): MediaCatalogModel[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const model = raw as Record<string, unknown>;
    if (typeof model.id !== 'string' || typeof model.provider !== 'string') return [];
    return [{
      id: model.id,
      label: typeof model.label === 'string' ? model.label : model.id,
      ...(typeof model.hint === 'string' ? { hint: model.hint } : {}),
      provider: model.provider,
      caps: asStringArray(model.caps),
      ...(model.default === true ? { default: true } : {}),
    }];
  });
}

/** Validates the catalogue at the boundary; unknown shapes become empty lists. */
export function parseMediaCatalog(body: unknown): MediaCatalog {
  const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const providers = Array.isArray(raw.providers)
    ? raw.providers.flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const provider = value as Record<string, unknown>;
      if (typeof provider.id !== 'string') return [];
      return [{
        id: provider.id,
        label: typeof provider.label === 'string' ? provider.label : provider.id,
        ...(typeof provider.hint === 'string' ? { hint: provider.hint } : {}),
        integrated: provider.integrated === true,
      }];
    })
    : [];
  return {
    providers,
    image: asModels(raw.image),
    video: asModels(raw.video),
    aspects: asStringArray(raw.aspects),
    videoLengthsSec: Array.isArray(raw.videoLengthsSec)
      ? raw.videoLengthsSec.filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      : [],
  };
}

export function galleryQueryString(filters: MediaGalleryFilters, cursor?: string | null): string {
  const params = new URLSearchParams();
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.status.length > 0) params.set('status', filters.status.join(','));
  if (filters.provider) params.set('provider', filters.provider);
  if (filters.from !== undefined) params.set('from', String(filters.from));
  if (filters.to !== undefined) params.set('to', String(filters.to));
  if (cursor) params.set('cursor', cursor);
  const query = params.toString();
  return query ? `?${query}` : '';
}

export const mediaApi = {
  async place(projectId: string, entryId: string, targetProjectId: string, output: string, idempotencyKey: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaGalleryPlaceResponse> {
    return checked<MediaGalleryPlaceResponse>(await fetch(`${projectPath(projectId)}/media/gallery/${encodeURIComponent(entryId)}/place`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext, { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }),
      body: JSON.stringify({ targetProjectId, output }),
    }));
  },
  async catalog(): Promise<MediaCatalog> {
    return parseMediaCatalog(await checked<unknown>(await fetch('/api/media/models', { cache: 'no-store' })));
  },

  async create(projectId: string, request: MediaCreateRequest, workspaceContext?: WorkspaceCollabContext | null): Promise<{ taskId: string }> {
    const response = await fetch(`${projectPath(projectId)}/media/generate`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext, { 'content-type': 'application/json' }),
      body: JSON.stringify(request),
    });
    return checked<{ taskId: string }>(response);
  },

  async cancel(taskId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaTaskCancelResponse> {
    const response = await fetch(`/api/media/tasks/${encodeURIComponent(taskId)}/cancel`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext),
    });
    return checked<MediaTaskCancelResponse>(response);
  },

  async retry(taskId: string, idempotencyKey: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaTaskRetryResponse> {
    const response = await fetch(`/api/media/tasks/${encodeURIComponent(taskId)}/retry`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext, { 'idempotency-key': idempotencyKey }),
    });
    return checked<MediaTaskRetryResponse>(response);
  },

  async gallery(projectId: string, filters: MediaGalleryFilters, cursor?: string | null, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaGalleryResponse> {
    const response = await fetch(`${projectPath(projectId)}/media/gallery${galleryQueryString(filters, cursor)}`, {
      cache: 'no-store',
      headers: scopeHeaders(workspaceContext),
    });
    const body = await checked<MediaGalleryResponse>(response);
    return { entries: Array.isArray(body.entries) ? body.entries : [], nextCursor: body.nextCursor ?? null, limit: body.limit };
  },

  async entry(projectId: string, entryId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaGalleryEntryDetail> {
    const response = await fetch(`${projectPath(projectId)}/media/gallery/${encodeURIComponent(entryId)}`, {
      cache: 'no-store',
      headers: scopeHeaders(workspaceContext),
    });
    return checked<MediaGalleryEntryDetail>(response);
  },

  async reuse(projectId: string, entryId: string, targetProjectId: string, idempotencyKey: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaGalleryReuseResponse> {
    const response = await fetch(`${projectPath(projectId)}/media/gallery/${encodeURIComponent(entryId)}/reuse`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext, { 'content-type': 'application/json', 'idempotency-key': idempotencyKey }),
      body: JSON.stringify({ targetProjectId }),
    });
    return checked<MediaGalleryReuseResponse>(response);
  },

  async unlink(projectId: string, entryId: string, workspaceContext?: WorkspaceCollabContext | null): Promise<MediaGalleryUnlinkResponse> {
    const response = await fetch(`${projectPath(projectId)}/media/gallery/${encodeURIComponent(entryId)}/unlink`, {
      method: 'POST',
      headers: scopeHeaders(workspaceContext),
    });
    return checked<MediaGalleryUnlinkResponse>(response);
  },
};
