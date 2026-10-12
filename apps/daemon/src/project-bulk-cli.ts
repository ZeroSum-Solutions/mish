import type { ProjectBulkAction, ProjectBulkResponse, ProjectBulkResult } from '@open-design/contracts';

/** Mirror UI batching through the authorized per-project routes, continuing after failures. */
export async function handleProjectBulkCommand(
  action: string | undefined,
  ids: string[],
  base: string,
  headers: Record<string, string>,
  options: { json?: boolean; unarchive?: boolean },
  structuredHttpFailure: (response: Response) => Promise<{ error: { code: string; message: string; data?: unknown }; exitCode: number }>,
): Promise<boolean> {
  if (action !== 'delete' && action !== 'archive' && action !== 'unarchive') return false;
  const operation: ProjectBulkAction = action === 'archive' && options.unarchive ? 'unarchive' : action;
  const uniqueIds = [...new Set(ids)];
  if (!uniqueIds.length) {
    process.stderr.write(`Usage: od project ${action} <id...> [--json]\n`);
    process.exitCode = 2;
    return true;
  }
  const results: ProjectBulkResult[] = [];
  let singleResponse: unknown;
  let exitCode = 0;
  for (const id of uniqueIds) {
    try {
      const response = await fetch(`${base}/api/projects/${encodeURIComponent(id)}${operation === 'delete' && ids.length > 1 ? '?ifIdle=1' : ''}`, {
        method: operation === 'delete' ? 'DELETE' : 'PATCH',
        headers: { ...headers, ...(operation === 'delete' ? {} : { 'content-type': 'application/json' }) },
        ...(operation === 'delete' ? {} : { body: JSON.stringify({ metadata: { archived: operation === 'archive' } }) }),
      });
      if (!response.ok) {
        const failure = await structuredHttpFailure(response);
        exitCode ||= failure.exitCode;
        if (ids.length === 1) {
          process.stderr.write(`${JSON.stringify({ error: { ...failure.error, data: failure.error.data ?? {} } })}\n`);
          process.exitCode = failure.exitCode;
          return true;
        }
        results.push({ id, ok: false, error: failure.error.message });
      } else {
        if (ids.length === 1) singleResponse = await response.json();
        results.push({ id, ok: true });
      }
    } catch (error) {
      exitCode ||= 1;
      results.push({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  }
  const body: ProjectBulkResponse = { action: operation, results };
  if (options.json) process.stdout.write(`${JSON.stringify(ids.length === 1 && results[0]?.ok ? singleResponse : body, null, 2)}\n`);
  else if (ids.length === 1 && results[0]?.ok) {
    // Single-id text output keeps the pre-bulk wording that scripts already parse.
    const projectId = (singleResponse as { project?: { id?: string } } | undefined)?.project?.id ?? results[0].id;
    const pastTense = { delete: 'deleted', archive: 'archived', unarchive: 'unarchived' }[operation];
    process.stdout.write(`[project] ${pastTense} ${operation === 'delete' ? results[0].id : projectId}\n`);
  } else for (const result of results) {
    process.stdout.write(result.ok ? `[project] ${operation} ${result.id}: ok\n` : `[project] ${operation} ${result.id}: failed — ${result.error}\n`);
  }
  if (exitCode) process.exitCode = exitCode;
  return true;
}
