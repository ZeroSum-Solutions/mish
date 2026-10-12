/** Client-side batch results over the existing per-project HTTP routes. */
export type ProjectBulkAction = 'delete' | 'archive' | 'unarchive';
export type ProjectBulkResult = { id: string; ok: true } | { id: string; ok: false; error: string };
export interface ProjectBulkResponse { action: ProjectBulkAction; results: ProjectBulkResult[] }

/** Read only a textual reason from an untrusted HTTP error envelope. */
export function projectMutationFailureMessage(body: unknown, fallback: string): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fallback;
  const record = body as Record<string, unknown>;
  const error = record.error;
  const nested = error && typeof error === 'object' && !Array.isArray(error)
    ? (error as Record<string, unknown>).message : undefined;
  const message = nested ?? record.message ?? (typeof error === 'string' ? error : undefined);
  return typeof message === 'string' && message.trim() ? message : fallback;
}
