import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildOnBrandResultSchema, siteCheckResultSchema } from '@mish/contracts';
import { cancelRun, pollRun, refused } from './lifecycle.ts';
import type { Builder } from './types.ts';

/**
 * QT's path, unchanged: `POST /api/build-on-brand` with the case brief, a four-page plan on the
 * case's kit, then the run, the site check and the saved files. It takes no Improve prompt brief.
 */
export function buildOnBrand(): Builder {
  return {
    identity: { id: 'build-on-brand', options: { pageCount: 4, useLibrary: true } },
    async build(context) {
      const { api, item, dir, result } = context;
      if (context.input?.preview) throw new Error('build-on-brand takes no Improve prompt brief; use --builder chat-run');
      let admissionUnverified = false;
      let terminal = false;
      let stop = false;
      try {
        const request = { brief: item.brief, designSystemId: item.kitId, name: `Quality benchmark ${item.id}`, agentId: context.agent, model: context.model, pageCount: 4, useLibrary: true };
        await writeFile(join(dir, 'request.json'), JSON.stringify(request, null, 2));
        await context.save();
        admissionUnverified = true;
        result.build = buildOnBrandResultSchema.parse(await api.json('/api/build-on-brand', undefined, request));
        admissionUnverified = false;
        result.status = 'running';
        await context.save();
        const status = await pollRun(context, result.build.runId, result.build.projectId, performance.now() + context.timeoutMs);
        terminal = true;
        result.wallTimeMs = performance.now() - context.startedAt;
        if (status !== 'succeeded') result.failures.push(`Generation ${status}`);
        try { result.siteCheck = siteCheckResultSchema.parse(await api.json(`/api/projects/${encodeURIComponent(result.build.projectId)}/site-check`, result.build.projectId)); }
        catch (error) { result.failures.push(`Site check unavailable: ${error instanceof Error ? error.message : 'request failed'}`); }
        result.files = await api.saveFiles(result.build.projectId, join(dir, 'files'), receipt => result.files.push(receipt));
        for (const page of result.build.plan.pages) if (!result.files.some(file => file.name === page.file)) result.failures.push(`Missing planned page: ${page.file}`);
      } catch (error) {
        result.failures.push(error instanceof Error ? error.message : 'Build failed');
        if (!terminal) result.status = 'failed';
        if (refused(error)) admissionUnverified = false;
        if (admissionUnverified) { result.failures.push('Admission unverified: inspect project/run inventory before retrying'); stop = true; }
        if (result.build && !terminal && !(await cancelRun(context, result.build.runId, result.build.projectId))) {
          result.failures.push('Cancellation unverified: inspect this run before retrying'); stop = true;
        }
      }
      return { stop };
    },
  };
}
