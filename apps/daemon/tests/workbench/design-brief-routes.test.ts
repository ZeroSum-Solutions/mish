import { readdir } from 'node:fs/promises';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { renderDesignBriefDirective, type DesignBrief, type OdNextStrategyRequestRecipeV2 } from '@open-design/contracts';
import { registerWorkbenchBriefRoutes } from '../../src/routes/workbench-brief.js';
import { createDesignBriefService, type DesignBriefService } from '../../src/workbench/brief/service.js';
import { runBriefCli, runDesignBriefBindingFromFlags } from '../../src/workbench/brief/cli.js';
import { resolveRunDesignBrief } from '../../src/workbench/brief/run-binding.js';
import { composeSystemPrompt } from '../../src/prompts/system.js';
import { fakeGenerator, modelOutput, tempDir } from './design-brief-fixture.js';

let server: Server | undefined;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = undefined;
  await Promise.all(cleanups.splice(0).map(fn => fn()));
});

async function boot(answers: string[] = [JSON.stringify(modelOutput()), JSON.stringify(modelOutput())]) {
  const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
  const briefs = createDesignBriefService({ dataDir: dir, generator: fakeGenerator(answers) });
  const app = express(); app.use(express.json());
  registerWorkbenchBriefRoutes(app, {
    http: { sendApiError: (res, status, code, message, init) => res.status(status).json({ error: { code, message, ...init } }) },
    authorizeProjectRequest: async (_req, res, id) => { if (id === 'foreign') { res.status(403).json({ error: 'private' }); return false; } return true; },
    briefs,
  });
  server = app.listen(0); await new Promise<void>(resolve => server!.once('listening', resolve));
  return { base: `http://127.0.0.1:${(server!.address() as AddressInfo).port}`, briefs, dir };
}
async function cli(base: string, args: string[], stdin?: string) {
  const values: unknown[] = [];
  const code = await runBriefCli(args, { baseUrl: base, env: {}, readStdin: async () => stdin ?? '', write: value => values.push(value) });
  return { code, value: values[0] as Record<string, any> };
}
const json = { 'content-type': 'application/json', 'x-od-project-id': 'p1' };

describe('Improve prompt over HTTP and od (AC-R15.2, AC-R15.3)', () => {
  it('previews without any durable records, then attaches exact reviewed content as accepted revision 2 through od', async () => {
    const { base, dir, briefs } = await boot();
    const preview = await cli(base, ['transform', '--prompt-file', '-', '--json'], 'A Windows 95 bakery site in React.');
    expect(preview.code).toBe(0);
    expect(preview.value).toMatchObject({ originalText: 'A Windows 95 bakery site in React.', intent: { styleDirections: ['Windows 95'], targetRuntime: 'React' } });
    expect(preview.value).not.toHaveProperty('projectId');
    expect(await readdir(dir)).toEqual([]);
    preview.value.purpose = { value: 'Take cake orders', basis: 'user' };
    preview.value.userEditedPaths = ['purpose'];
    const attached = await cli(base, ['brief', 'attach', '--project', 'p1', '--input-file', '-', '--json'], JSON.stringify(preview.value));
    expect(attached.code).toBe(0);
    expect(attached.value.brief).toMatchObject({ projectId: 'p1', revision: 2, state: 'accepted', audience: { basis: 'user' }, purpose: { value: 'Take cake orders', basis: 'user' } });
    const binding = { id: attached.value.brief.id, revision: 2, hash: attached.value.brief.hash };
    expect(await briefs.resolveForRun('p1', binding)).toEqual(attached.value.brief);
    const foreign = await cli(base, ['brief', 'attach', '--project', 'foreign', '--input-file', '-', '--json'], JSON.stringify(preview.value));
    expect(foreign.code).toBe(3);
  });
  it('rejects project scope and forged resource claims on the project-less endpoint before generation', async () => {
    const { base, dir } = await boot();
    for (const body of [{ projectId: 'p1', originalText: 'A bakery site' }, { originalText: '' }, { originalText: 'x', selectedReferenceRefs: [] }]) {
      const response = await fetch(`${base}/api/workbench/briefs/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(400);
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it('POST returns 202, GET polls to ready, PATCH edits then accepts; od shows the identical record', async () => {
    const { base, briefs } = await boot();
    const created = await fetch(`${base}/api/workbench/briefs`, { method: 'POST', headers: json, body: JSON.stringify({ projectId: 'p1', originalText: 'A bakery site.' }) });
    expect(created.status).toBe(202);
    const { id } = await created.json() as { id: string };
    await briefs.settled(id);
    const ready = await (await fetch(`${base}/api/workbench/briefs/${id}?projectId=p1`, { headers: json })).json() as Record<string, any>;
    expect(ready.status).toBe('ready');
    const shown = await cli(base, ['brief', 'show', '--project', 'p1', '--brief', id, '--json']);
    expect(shown).toEqual({ code: 0, value: ready });
    const edited = await cli(base, ['brief', 'edit', '--project', 'p1', '--brief', id, '--expected-revision', '1', '--input-file', '-', '--json'], JSON.stringify({ edits: { purpose: 'Take cake orders' } }));
    expect(edited.value.brief).toMatchObject({ revision: 2, purpose: { value: 'Take cake orders', basis: 'user' } });
    const conflict = await fetch(`${base}/api/workbench/briefs/${id}`, { method: 'PATCH', headers: json, body: JSON.stringify({ expectedRevision: 1, accept: true }) });
    expect(conflict.status).toBe(409);
    const accepted = await cli(base, ['brief', 'accept', '--project', 'p1', '--brief', id, '--expected-revision', '2', '--json']);
    expect(accepted.value.brief).toMatchObject({ revision: 3, state: 'accepted' });
  });

  it('od workbench transform reads --prompt-file and --input-file, waits, and never starts a run', async () => {
    const { base } = await boot();
    const { code, value } = await cli(base, ['transform', '--project', 'p1', '--prompt-file', '-', '--input-file', '/dev/null', '--json'], 'A Windows 95 bakery site in React.');
    expect(code).toBe(0);
    expect(value.status).toBe('ready');
    expect(value.brief.intent).toEqual({ styleDirections: ['Windows 95'], targetRuntime: 'React' });
  });

  it('refuses a foreign project and an invalid request with the shared error envelope', async () => {
    const { base } = await boot();
    const foreign = await fetch(`${base}/api/workbench/briefs`, { method: 'POST', headers: { ...json, 'x-od-project-id': 'foreign' }, body: JSON.stringify({ projectId: 'foreign', originalText: 'x' }) });
    expect(foreign.status).toBe(403);
    const invalid = await fetch(`${base}/api/workbench/briefs`, { method: 'POST', headers: json, body: JSON.stringify({ projectId: 'p1', originalText: '' }) });
    expect(invalid.status).toBe(400);
    const mismatch = await fetch(`${base}/api/workbench/briefs`, { method: 'POST', headers: { ...json, 'x-od-project-id': 'p2' }, body: JSON.stringify({ projectId: 'p1', originalText: 'x' }) });
    expect(mismatch.status).toBe(400);
    expect((await cli(base, ['transform', '--project', 'p1', '--json'])).code).toBe(2);
  });
});

async function acceptedBrief(briefs: DesignBriefService): Promise<DesignBrief> {
  const { id } = await briefs.create({ projectId: 'p1', originalText: 'A Windows 95 bakery site.' }, { principalId: 'local-daemon', projectId: 'p1' });
  await briefs.settled(id);
  return (await briefs.patch('p1', id, { expectedRevision: 1, accept: true })).brief!;
}

describe('Use prompt binds generation to the exact accepted brief (AC-R15.2, AC-R15.3)', () => {
  it('resolves the run binding, strips any client-supplied brief body and maps refusals', async () => {
    const { briefs } = await boot();
    const brief = await acceptedBrief(briefs);
    const body: Record<string, unknown> = { projectId: 'p1', message: 'go', brief: { id: brief.id, revision: brief.revision, hash: brief.hash }, designBrief: { forged: true } };
    const result = await resolveRunDesignBrief(body, briefs);
    expect(result).toEqual({ ok: true, brief });
    expect(body.designBrief).toBeUndefined();
    expect(await resolveRunDesignBrief({ projectId: 'p1', designBrief: { forged: true } }, briefs)).toEqual({ ok: true, brief: null });
    expect(await resolveRunDesignBrief({ projectId: 'p1', brief: { id: brief.id, revision: brief.revision, hash: 'f'.repeat(64) } }, briefs)).toMatchObject({ ok: false, status: 409 });
    expect(await resolveRunDesignBrief({ projectId: 'p2', brief: { id: brief.id, revision: brief.revision, hash: brief.hash } }, briefs)).toMatchObject({ ok: false, status: 403 });
    expect(await resolveRunDesignBrief({ projectId: 'p1', brief: { id: 'x' } }, briefs)).toMatchObject({ ok: false, status: 400 });
    expect(await resolveRunDesignBrief({ brief: { id: brief.id, revision: brief.revision, hash: brief.hash } }, briefs)).toMatchObject({ ok: false, status: 400 });
  });

  it('od run start carries --brief, --brief-revision and --brief-hash together or not at all', () => {
    expect(runDesignBriefBindingFromFlags({ brief: 'brief_a', 'brief-revision': '2', 'brief-hash': 'a'.repeat(64) })).toEqual({ id: 'brief_a', revision: 2, hash: 'a'.repeat(64) });
    expect(runDesignBriefBindingFromFlags({})).toBeNull();
    expect(() => runDesignBriefBindingFromFlags({ brief: 'brief_a' })).toThrow();
  });

  it('the daemon classic, slim and OD Next composers all carry the same rendered brief', async () => {
    const { briefs } = await boot();
    const brief = await acceptedBrief(briefs);
    const directive = renderDesignBriefDirective(brief);
    expect(composeSystemPrompt({ designBrief: brief })).toContain(directive);
    expect(composeSystemPrompt({ designBrief: brief, promptCoreVariant: 'slim' })).toContain(directive);
    expect(composeSystemPrompt({ designBrief: brief, sessionMode: 'chat', promptCoreVariant: 'slim' })).toContain(directive);
    const recipe: OdNextStrategyRequestRecipeV2 = {
      recipe: 'od-next-plan-build-v2', strategyId: 'od-next-strategy', strategyVersion: '2.0.0', snapshotId: 'snap',
      packageHash: 'a'.repeat(64), taskProfileDigest: 'b'.repeat(64), taskProfileVersion: '2.0.0', taskType: 'prototype',
      executionProfile: 'filesystem', coreStrategy: '# Core', generalOrchestration: '# Orch', taskSkill: '# Prototype',
      activeStages: [
        { name: 'discovery', atoms: [{ name: 'discovery-question-form' }] },
        { name: 'plan', atoms: [{ name: 'direction-picker' }, { name: 'todo-write' }] },
        { name: 'generate', atoms: [{ name: 'file-write' }, { name: 'live-artifact' }] },
      ],
    };
    expect(composeSystemPrompt({ odNextStrategyRecipe: recipe, designBrief: brief })).toContain(directive);
    // Host injection resistance still precedes the brief on the legacy path.
    const classic = composeSystemPrompt({ designBrief: brief });
    expect(classic.indexOf(directive)).toBeGreaterThan(0);
  });
});
