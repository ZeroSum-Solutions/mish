import { describe, expect, it, vi } from 'vitest';
import type { BriefTransformerLane } from '@mish/contracts';
import { createSelectableBriefGenerator } from '../../src/workbench/brief/generator-select.js';
import { BRIEF_TERRA_MODEL, createOpenRouterBriefGenerator } from '../../src/workbench/brief/generator-provider.js';
import type { BriefGenerator } from '../../src/workbench/brief/generator.js';
import { modelOutput } from './design-brief-fixture.js';

const valid = JSON.stringify(modelOutput());
function lane(id: string, answer: () => Promise<string>, available = true): BriefGenerator & { generate: ReturnType<typeof vi.fn> } {
  return {
    id, modelId: `${id}-model`, billingLane: id, maxInputChars: 100_000,
    available: async () => (available ? { available: true } : { available: false, reason: 'no key', recovery: 'add one' }),
    generate: vi.fn(async () => ({ text: await answer(), reportedModel: `${id}-reported` })),
  };
}
function select(choice: BriefTransformerLane | Error, terra: BriefGenerator, claude: BriefGenerator) {
  const onFallback = vi.fn();
  const generator = createSelectableBriefGenerator({ readLane: async () => { if (choice instanceof Error) throw choice; return choice; }, terra, claude, onFallback });
  return { generator, onFallback };
}
const input = { system: 'S', user: 'U' };
const signal = () => new AbortController().signal;

describe('Improve prompt transformer selection', () => {
  it('runs claude alone when the user opts out, and never touches terra', async () => {
    const terra = lane('terra', async () => valid); const claude = lane('claude', async () => valid);
    const { generator } = select('claude', terra, claude);
    const generation = await generator.generate(input, signal());
    expect(generation).toMatchObject({ reportedModel: 'claude-reported', requestedModel: 'claude-model' });
    expect(terra.generate).not.toHaveBeenCalled();
  });

  it('runs terra when chosen and reports its model', async () => {
    const terra = lane('terra', async () => valid); const claude = lane('claude', async () => valid);
    const { generator, onFallback } = select('terra', terra, claude);
    expect(await generator.generate(input, signal())).toMatchObject({ reportedModel: 'terra-reported', requestedModel: 'terra-model' });
    expect(claude.generate).not.toHaveBeenCalled();
    expect(onFallback).not.toHaveBeenCalled();
  });

  it.each([
    ['failed', lane('terra', async () => { throw new Error('openrouter 500'); })],
    ['invalid-output', lane('terra', async () => '{"audience":"value":')],
    ['unavailable', lane('terra', async () => valid, false)],
  ])('falls back to claude when terra is %s', async (reason, terra) => {
    const claude = lane('claude', async () => valid);
    const { generator, onFallback } = select('terra', terra, claude);
    expect(await generator.generate(input, signal())).toMatchObject({ reportedModel: 'claude-reported', requestedModel: 'claude-model' });
    expect(onFallback).toHaveBeenCalledWith(reason);
  });

  it('does not retry on claude when the caller cancelled', async () => {
    const controller = new AbortController();
    const terra = lane('terra', async () => { controller.abort(); throw new Error('aborted'); });
    const claude = lane('claude', async () => valid);
    await expect(select('terra', terra, claude).generator.generate(input, controller.signal)).rejects.toThrow('aborted');
    expect(claude.generate).not.toHaveBeenCalled();
  });

  it('gives Terra one attempt per transformation; the repair turn goes to claude', async () => {
    const terra = lane('terra', async () => valid); const claude = lane('claude', async () => valid);
    const { generator } = select('terra', terra, claude);
    const transformation = signal();
    expect((await generator.generate(input, transformation)).requestedModel).toBe('terra-model');
    expect((await generator.generate({ ...input, user: 'U + repair' }, transformation)).requestedModel).toBe('claude-model');
    expect(terra.generate).toHaveBeenCalledTimes(1);
    // A new transformation (new signal) gets Terra again.
    expect((await generator.generate(input, signal())).requestedModel).toBe('terra-model');
  });

  it('never spends a second Terra timeout on the repair after a fallback', async () => {
    const terra = lane('terra', async () => { throw new Error('openrouter timeout'); }); const claude = lane('claude', async () => valid);
    const { generator } = select('terra', terra, claude);
    const transformation = signal();
    await generator.generate(input, transformation);
    await generator.generate(input, transformation);
    expect(terra.generate).toHaveBeenCalledTimes(1);
    expect(claude.generate).toHaveBeenCalledTimes(2);
  });

  it('reads an unreadable setting as claude', async () => {
    const terra = lane('terra', async () => valid); const claude = lane('claude', async () => valid);
    await select(new Error('config unreadable'), terra, claude).generator.generate(input, signal());
    expect(claude.generate).toHaveBeenCalled();
    expect(terra.generate).not.toHaveBeenCalled();
  });
});

describe('OpenRouter brief generator (no live calls)', () => {
  it('requests the pinned Terra model with the schema and low reasoning, and returns the reported model', async () => {
    const fetchImpl = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({ model: 'openai/gpt-5.6-terra', choices: [{ message: { content: valid } }] })));
    const generator = createOpenRouterBriefGenerator({ apiKey: async () => 'test-key', fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(await generator.generate(input, signal())).toEqual({ text: valid, reportedModel: 'openai/gpt-5.6-terra', requestedModel: BRIEF_TERRA_MODEL });
    const body = JSON.parse(String(fetchImpl.mock.calls[0]![1]!.body));
    expect(body.model).toBe(BRIEF_TERRA_MODEL);
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect(body.messages[0].content).toMatch(/^S\n/);
    expect(body.messages[0].content).toContain('"referenceChanges"');
    expect((fetchImpl.mock.calls[0]![1]!.headers as Record<string, string>).authorization).toBe('Bearer test-key');
  });

  it('throws status-only errors and never repeats the provider body', async () => {
    const fetchImpl = vi.fn(async () => new Response('provider body: secret-token', { status: 500 }));
    const error = await createOpenRouterBriefGenerator({ apiKey: async () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch }).generate(input, signal()).then(() => null, (e: unknown) => e as Error);
    expect(error?.message).toBe('openrouter 500');
    const empty = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] })));
    await expect(createOpenRouterBriefGenerator({ apiKey: async () => 'k', fetchImpl: empty as unknown as typeof fetch }).generate(input, signal())).rejects.toThrow('openrouter empty answer');
  });

  it('bounds a stalled key lookup instead of holding the preview', async () => {
    const stalled = createOpenRouterBriefGenerator({ apiKey: () => new Promise<string>(() => {}), keyTimeoutMs: 10 });
    expect((await stalled.available()).available).toBe(false);
    await expect(stalled.generate(input, signal())).rejects.toThrow('openrouter key timeout');
    const controller = new AbortController();
    const pending = createOpenRouterBriefGenerator({ apiKey: () => new Promise<string>(() => {}), keyTimeoutMs: 60_000 }).generate(input, controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeDefined();
  });

  it('shares one hung key lookup across timeouts instead of piling up new ones', async () => {
    const apiKey = vi.fn(() => new Promise<string>(() => {}));
    const generator = createOpenRouterBriefGenerator({ apiKey, keyTimeoutMs: 5 });
    for (let attempt = 0; attempt < 4; attempt++) {
      expect((await generator.available()).available).toBe(false);
      await expect(generator.generate(input, signal())).rejects.toThrow('openrouter key timeout');
    }
    expect(apiKey).toHaveBeenCalledTimes(1);
  });

  it('drops a blank or malformed reported model instead of storing it', async () => {
    for (const model of [' ', 'x'.repeat(200), 'bad model id', 42]) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ model, choices: [{ message: { content: valid } }] })));
      const generation = await createOpenRouterBriefGenerator({ apiKey: async () => 'k', fetchImpl: fetchImpl as unknown as typeof fetch }).generate(input, signal());
      expect(generation.reportedModel).toBeNull();
      expect(generation.requestedModel).toBe(BRIEF_TERRA_MODEL);
    }
  });

  it('is unavailable when no key resolves', async () => {
    expect((await createOpenRouterBriefGenerator({ apiKey: async () => { throw new Error('no key'); } }).available()).available).toBe(false);
    expect((await createOpenRouterBriefGenerator({ apiKey: async () => ' ' }).available()).available).toBe(false);
  });
});

describe('Terra through the brief service', () => {
  it('records the model each concurrent transformation actually used', async () => {
    const { createDesignBriefService } = await import('../../src/workbench/brief/service.js');
    const { tempDir } = await import('./design-brief-fixture.js');
    const { dir, cleanup } = await tempDir();
    try {
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      let calls = 0;
      // First transformation falls back to claude and waits; the second completes on terra meanwhile.
      const terra = lane('terra', async () => { calls += 1; if (calls === 1) throw new Error('openrouter 500'); return valid; });
      const claude = lane('claude', async () => { await gate; return valid; });
      const svc = createDesignBriefService({ dataDir: dir, generator: select('terra', terra, claude).generator });
      const ctx = { principalId: 'local-daemon', projectId: 'p1' };
      const a = await svc.create({ projectId: 'p1', originalText: 'A bakery site.' }, ctx);
      await new Promise(resolve => setTimeout(resolve, 20));
      const b = await svc.create({ projectId: 'p1', originalText: 'A florist site.' }, ctx);
      await svc.settled(b.id);
      release();
      await svc.settled(a.id);
      const { readFile } = await import('node:fs/promises');
      const record = async (id: string) => JSON.parse(await readFile(`${dir}/workbench/briefs/${id}/record.json`, 'utf8'));
      expect((await record(a.id)).transformer).toEqual({ requestedModel: 'claude-model', reportedModel: 'claude-reported' });
      expect((await record(b.id)).transformer).toEqual({ requestedModel: 'terra-model', reportedModel: 'terra-reported' });
    } finally { await cleanup(); }
  });
});
