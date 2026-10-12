import { runDesignBriefBindingSchema, type DesignBrief } from '@open-design/contracts';
import { BriefError, type DesignBriefService } from './service.js';

export type RunDesignBriefResolution =
  | { ok: true; brief: DesignBrief | null }
  | { ok: false; status: number; code: string; message: string };

/**
 * `POST /api/runs` accepts an optional `brief: {id, revision, hash}` and the
 * daemon resolves that exact accepted revision. `designBrief` is the
 * server-issued result that the prompt composers read, so any client-supplied
 * value is removed before anything else happens.
 */
export async function resolveRunDesignBrief(body: Record<string, unknown>, briefs: Pick<DesignBriefService, 'resolveForRun'> | undefined): Promise<RunDesignBriefResolution> {
  delete body.designBrief;
  if (body.brief === undefined || body.brief === null) return { ok: true, brief: null };
  const parsed = runDesignBriefBindingSchema.safeParse(body.brief);
  if (!parsed.success) return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'brief must be {id, revision, hash} of an accepted design brief' };
  if (typeof body.projectId !== 'string' || !body.projectId) return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'A design brief binds only to a project run' };
  if (!briefs) return { ok: false, status: 422, code: 'brief-unavailable', message: 'Design briefs are not available on this daemon' };
  try {
    return { ok: true, brief: await briefs.resolveForRun(body.projectId, parsed.data) };
  } catch (error) {
    if (error instanceof BriefError) return { ok: false, status: error.status, code: error.code, message: error.message };
    throw error;
  }
}
