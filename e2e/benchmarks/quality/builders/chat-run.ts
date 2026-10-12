import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cancelRun, pollRun, refused } from './lifecycle.ts';
import type { Builder } from './types.ts';

interface Attached { id: string; brief: { revision: number; hash: string } }
const isAttached = (value: unknown): value is Attached => {
  const record = value as Partial<Attached> | null;
  return typeof record?.id === 'string' && Number.isSafeInteger(record.brief?.revision) && typeof record.brief?.hash === 'string';
};

/**
 * The chat path a person takes after Improve prompt: a fresh project with discovery skipped, the
 * reviewed brief attached (`POST /api/workbench/briefs/attach`), then `POST /api/runs` with the case's
 * request as the message and the brief bound by id, revision and hash. With no brief (`original`)
 * the run gets the request alone. Required for `compare --writers`.
 */
export function chatRun(): Builder {
  return {
    identity: { id: 'chat-run', options: { skipDiscoveryBrief: true } },
    async build(context) {
      const { api, item, dir, result } = context;
      let admissionUnverified = false;
      let terminal = false;
      let stop = false;
      let runId: string | undefined;
      let projectId: string | undefined;
      try {
        const created = await api.json('/api/projects', undefined, { id: randomUUID(), name: `Quality compare ${item.id} ${context.input?.writer ?? 'original'}`, designSystemId: item.kitId, skipDiscoveryBrief: true, metadata: { skipDiscoveryBrief: true } }) as { project?: { id?: unknown } };
        if (typeof created.project?.id !== 'string') throw new Error('Project creation returned no id');
        projectId = created.project.id;
        result.target = { projectId, entry: null };
        await context.save();
        let brief: { id: string; revision: number; hash: string } | undefined;
        if (context.input?.preview) {
          const attached = await api.json('/api/workbench/briefs/attach', projectId, { projectId, preview: context.input.preview });
          if (!isAttached(attached)) throw new Error('Brief attach returned no revision');
          await writeFile(join(dir, 'brief.json'), JSON.stringify(attached, null, 2));
          brief = { id: attached.id, revision: attached.brief.revision, hash: attached.brief.hash };
          result.target.briefId = attached.id;
        }
        const request = { projectId, message: item.brief, agentId: context.agent, model: context.model, clientRequestId: `quality-${randomUUID()}`, ...(brief ? { brief } : {}) };
        await writeFile(join(dir, 'request.json'), JSON.stringify(request, null, 2));
        admissionUnverified = true;
        const started = await api.json('/api/runs', projectId, request) as { runId?: unknown };
        if (typeof started.runId !== 'string') throw new Error('Run start returned no run id');
        admissionUnverified = false;
        runId = started.runId; result.target.runId = runId; result.status = 'running';
        await context.save();
        const status = await pollRun(context, runId, projectId, performance.now() + context.timeoutMs);
        terminal = true;
        result.wallTimeMs = performance.now() - context.startedAt;
        if (status !== 'succeeded') result.failures.push(`Generation ${status}`);
        try {
          const pkg = await api.json(`/api/runs/${encodeURIComponent(runId)}/result-package`, projectId) as { artifacts?: Array<{ file?: unknown }> };
          const entry = pkg.artifacts?.map(artifact => artifact.file).find((file): file is string => typeof file === 'string' && /\.html?$/iu.test(file));
          if (entry) result.target.entry = entry;
        } catch (error) { result.failures.push(`Result package unavailable: ${error instanceof Error ? error.message : 'request failed'}`); }
        result.files = await api.saveFiles(projectId, join(dir, 'files'), receipt => result.files.push(receipt));
        result.target.entry ??= result.files.map(file => file.name).find(name => /\.html?$/iu.test(name) && !name.includes('/')) ?? null;
      } catch (error) {
        result.failures.push(error instanceof Error ? error.message : 'Build failed');
        if (!terminal) result.status = 'failed';
        if (refused(error)) admissionUnverified = false;
        if (admissionUnverified) { result.failures.push('Admission unverified: inspect project/run inventory before retrying'); stop = true; }
        if (runId && projectId && !terminal && !(await cancelRun(context, runId, projectId))) {
          result.failures.push('Cancellation unverified: inspect this run before retrying'); stop = true;
        }
      }
      return { stop };
    },
  };
}
