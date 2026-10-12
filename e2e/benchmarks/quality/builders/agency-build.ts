import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { refused } from './lifecycle.ts';
import type { Builder } from './types.ts';

const ACTIVE = ['queued', 'routing', 'building', 'verifying', 'publishing'];
const TERMINAL = ['done', 'unrouted', 'failed', 'cancelled'];
interface Snapshot { id: string; status: string; projectId?: string; family?: string; provider?: string; model?: string }
const snapshotOf = (value: unknown): Snapshot => {
  const build = (value as { build?: Partial<Snapshot> } | null)?.build;
  if (typeof build?.id !== 'string' || ![...ACTIVE, ...TERMINAL].includes(String(build.status))) throw new Error('Invalid agency build snapshot');
  return build as Snapshot;
};

/**
 * The Home "Build with Jev" path: `POST /api/agency/build` with the case brief and `family: auto`,
 * polled through `GET /api/agency/builds/:id`, then the published project's files. Fill models are
 * the agency lane's own (DeepSeek or Cerebras), so `--agent`/`--model` do not apply; the observed
 * provider and model are recorded as the builder identity. It takes no Improve prompt brief.
 */
export function agencyBuild(options: { verify?: 'strict' | 'advisory' | 'after' | 'off' } = {}): Builder {
  const verify = options.verify ?? 'strict';
  return {
    identity: { id: 'agency-build', options: { family: 'auto', verify } },
    async build(context) {
      const { api, item, dir, result } = context;
      if (context.input?.preview) throw new Error('agency-build takes no Improve prompt brief; use --builder chat-run');
      let admissionUnverified = false;
      let terminal = false;
      let stop = false;
      let buildId: string | undefined;
      try {
        const request = { brief: item.brief, family: 'auto', verify, projectName: `Quality benchmark ${item.id}` };
        await writeFile(join(dir, 'request.json'), JSON.stringify(request, null, 2));
        admissionUnverified = true;
        let snapshot = snapshotOf(await api.json('/api/agency/build', undefined, request));
        admissionUnverified = false;
        buildId = snapshot.id;
        // Recorded at once, so a later polling or cancellation failure still names the build to inspect.
        result.target = { agencyBuildId: buildId, entry: null };
        await context.save();
        const deadline = performance.now() + context.timeoutMs;
        for (;;) {
          result.status = snapshot.status;
          result.run = { agencyStatus: snapshot.status, family: snapshot.family ?? null, ...(snapshot.provider && snapshot.model ? { agentId: `agency:${snapshot.provider}`, model: snapshot.model } : {}) };
          if (snapshot.projectId) result.target = { ...result.target!, projectId: snapshot.projectId };
          await context.save();
          if (TERMINAL.includes(snapshot.status)) break;
          const remaining = deadline - performance.now();
          if (remaining <= 0) throw new Error('Agency build polling deadline exceeded');
          await new Promise(resolve => setTimeout(resolve, Math.min(context.pollMs, Math.max(1, remaining))));
          snapshot = snapshotOf(await api.json(`/api/agency/builds/${encodeURIComponent(buildId)}`, undefined, undefined, deadline - performance.now()));
        }
        terminal = true;
        result.wallTimeMs = performance.now() - context.startedAt;
        result.status = snapshot.status === 'done' ? 'succeeded' : snapshot.status;
        if (snapshot.status !== 'done') result.failures.push(`Agency build ${snapshot.status}`);
        if (!snapshot.projectId) throw new Error('Agency build published no project');
        result.files = await api.saveFiles(snapshot.projectId, join(dir, 'files'), receipt => result.files.push(receipt));
        result.target!.entry = result.files.map(file => file.name).find(name => /^index\.html?$/iu.test(name)) ?? result.files.map(file => file.name).find(name => /\.html?$/iu.test(name)) ?? null;
      } catch (error) {
        result.failures.push(error instanceof Error ? error.message : 'Build failed');
        if (!terminal) result.status = 'failed';
        if (refused(error)) admissionUnverified = false;
        if (admissionUnverified) { result.failures.push('Admission unverified: inspect agency build inventory before retrying'); stop = true; }
        if (buildId && !terminal) {
          try {
            await api.json(`/api/agency/builds/${encodeURIComponent(buildId)}/cancel`, undefined, {});
            const after = snapshotOf(await api.json(`/api/agency/builds/${encodeURIComponent(buildId)}`));
            if (!TERMINAL.includes(after.status)) throw new Error('Still active');
          } catch { result.failures.push('Cancellation unverified: inspect this agency build before retrying'); stop = true; }
        }
      }
      return { stop };
    },
  };
}
