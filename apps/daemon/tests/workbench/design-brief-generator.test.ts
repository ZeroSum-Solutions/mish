import { afterEach, describe, expect, it } from 'vitest';
import { parseDesignBriefRecordView } from '@mish/contracts';
import { BRIEF_TRANSFORMER_MODEL, claudeBriefArgs, createClaudeMaxBriefGenerator } from '../../src/workbench/brief/generator.js';
import type { ClaudeProcessRequest } from '../../src/workbench/review/reviewers/claude-visual.js';
import { createDesignBriefService } from '../../src/workbench/brief/service.js';
import { fakeGenerator, modelOutput, tempDir } from './design-brief-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });

const frames = (...values: unknown[]) => values.map(value => JSON.stringify(value)).join('\n');
const resultFrame = { type: 'result', subtype: 'success', is_error: false, result: '', structured_output: modelOutput() };

async function generatorWith(stdout: string) {
  const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
  const requests: ClaudeProcessRequest[] = [];
  const generator = createClaudeMaxBriefGenerator({
    workDir: dir, resolveBin: () => '/fixture/claude', env: { PATH: '/usr/bin' },
    run: async request => { requests.push(request); return { exitCode: 0, stdout, stderr: '' }; },
  });
  return { generator, requests };
}

describe('R15-1 brief transformer model pin and reported model', () => {
  it('pins the concrete Sonnet id, never an alias or Opus', async () => {
    expect(BRIEF_TRANSFORMER_MODEL).toBe('claude-sonnet-5-5');
    const { generator, requests } = await generatorWith(frames(resultFrame));
    expect(generator.modelId).toBe('claude-sonnet-5-5');
    await generator.generate({ system: 's', user: 'u' }, new AbortController().signal);
    const args = requests[0]!.args;
    expect(args[args.indexOf('--model') + 1]).toBe('claude-sonnet-5-5');
    expect(args.join(' ')).not.toMatch(/opus/i);
    expect(claudeBriefArgs(BRIEF_TRANSFORMER_MODEL, 's')).toContain('claude-sonnet-5-5');
  });

  it('reports the model the CLI names in its stream-json init frame', async () => {
    const { generator } = await generatorWith(frames({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: 'x' }, resultFrame));
    const generation = await generator.generate({ system: 's', user: 'u' }, new AbortController().signal);
    expect(generation.reportedModel).toBe('claude-sonnet-5-5');
    expect(JSON.parse(generation.text)).toEqual(modelOutput());
  });

  it('reports null, not a guess, when the init frame carries no model', async () => {
    const { generator } = await generatorWith(frames({ type: 'system', subtype: 'init', session_id: 'x' }, resultFrame));
    expect((await generator.generate({ system: 's', user: 'u' }, new AbortController().signal)).reportedModel).toBeNull();
    const bare = await generatorWith(frames(resultFrame));
    expect((await bare.generator.generate({ system: 's', user: 'u' }, new AbortController().signal)).reportedModel).toBeNull();
  });

  it('stores the requested and reported model on the brief record', async () => {
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const generator = fakeGenerator([{ text: JSON.stringify(modelOutput()), reportedModel: 'claude-sonnet-5-5' }]);
    const svc = createDesignBriefService({ dataDir: dir, generator });
    const pending = await svc.create({ projectId: 'p1', originalText: 'A site for my bakery.' }, { principalId: 'local-daemon', projectId: 'p1' });
    const view = parseDesignBriefRecordView(await svc.settled(pending.id));
    expect(view.status).toBe('ready');
    expect(view.transformer).toEqual({ requestedModel: 'fake-model', reportedModel: 'claude-sonnet-5-5' });
  });

  it('stores a null reported model when the lane did not report one', async () => {
    const { dir, cleanup } = await tempDir(); cleanups.push(cleanup);
    const svc = createDesignBriefService({ dataDir: dir, generator: fakeGenerator([JSON.stringify(modelOutput())]) });
    const pending = await svc.create({ projectId: 'p1', originalText: 'A site for my bakery.' }, { principalId: 'local-daemon', projectId: 'p1' });
    expect(parseDesignBriefRecordView(await svc.settled(pending.id)).transformer).toEqual({ requestedModel: 'fake-model', reportedModel: null });
  });
});
