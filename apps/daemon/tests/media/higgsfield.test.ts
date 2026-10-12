import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHiggsfieldImage } from '../../src/media/higgsfield.js';
const assetFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/connectionTest.js', () => ({ assertAndFetchExternalAsset: assetFetch }));
const ctx = { wireModel: 'higgsfield/gpt-image-2', prompt: 'A paper sculpture', imageRefs: [] };
const complete = { id: 'job-1', status: 'completed', result_url: 'https://images.higgs.ai/output.png' };
function mockCommands(...values: unknown[]) { const run = vi.fn(); for (const value of values) run.mockResolvedValueOnce(JSON.stringify(value)); assetFetch.mockResolvedValue(new Response('png-data', { headers: { 'content-type': 'image/png' } })); return run; }
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('HiggsField subscription image adapter', () => {
  it('submits once using the subscription CLI and polls the same job; prompt uses stdin', async () => {
    vi.useFakeTimers(); const run = mockCommands(['job-1'], { id: 'job-1', status: 'in_progress' }, complete);
    const result = renderHiggsfieldImage(ctx, undefined, run); await vi.runAllTimersAsync(); expect((await result).bytes.toString()).toBe('png-data');
    expect(run.mock.calls[0]).toEqual([['generate', 'create', 'gpt_image_2', '--aspect_ratio', '1:1', '--resolution', '2k'], ctx.prompt]);
    expect(run.mock.calls.filter(([args]) => args[1] === 'create')).toHaveLength(1);
    expect(assetFetch.mock.calls[0]![1].headers).toBeUndefined();
  });
  it('passes validated local reference files to the CLI upload boundary', async () => {
    vi.useFakeTimers(); const run = mockCommands(['job-1'], complete);
    const result = renderHiggsfieldImage({ ...ctx, imageRefs: [{ abs: '/test/project/ref.png', mime: 'image/png', dataUrl: 'data:image/png;base64,cG5n' }] }, undefined, run);
    await vi.runAllTimersAsync(); await result; expect(run.mock.calls[0]![0]).toContain('/test/project/ref.png');
  });
  it.each(['failed', 'nsfw', 'canceled'])('stops on %s without retrying or echoing the provider error', async (status) => {
    vi.useFakeTimers(); const run = mockCommands(['job-1'], { id: 'job-1', status, error: 'secret upstream details' });
    const result = renderHiggsfieldImage(ctx, undefined, run); const assertion = expect(result).rejects.toThrow(`HiggsField generation ${status}`); await vi.runAllTimersAsync(); await assertion;
    expect(run.mock.calls.filter(([args]) => args[1] === 'create')).toHaveLength(1); expect(assetFetch).not.toHaveBeenCalled();
  });
  it('never retries an ambiguous submission', async () => {
    const run = vi.fn().mockRejectedValue(new Error('HiggsField CLI request failed')); await expect(renderHiggsfieldImage(ctx, undefined, run)).rejects.toThrow('CLI request failed'); expect(run).toHaveBeenCalledTimes(1);
  });
  it('rejects mismatched job identity before downloading', async () => {
    vi.useFakeTimers(); const run = mockCommands(['job-1'], { ...complete, id: 'job-2' });
    const result = renderHiggsfieldImage(ctx, undefined, run); const assertion = expect(result).rejects.toThrow('invalid HiggsField job response'); await vi.runAllTimersAsync(); await assertion;
  });
  it('rejects unsupported inputs before spending credits', async () => {
    const run = mockCommands(); await expect(renderHiggsfieldImage({ ...ctx, resolution: '8k' }, undefined, run)).rejects.toThrow('unsupported HiggsField resolution');
    await expect(renderHiggsfieldImage({ ...ctx, wireModel: 'higgsfield/recraft-v4.1', imageRefs: [{ abs: '/ref.png', mime: 'image/png', dataUrl: '' }] }, undefined, run)).rejects.toThrow('Recraft accepts text only'); expect(run).not.toHaveBeenCalled();
  });
  it('does not report an HTML download as an image', async () => {
    vi.useFakeTimers(); const run = mockCommands(['job-1'], complete); assetFetch.mockResolvedValue(new Response('error', { headers: { 'content-type': 'text/html' } }));
    const result = renderHiggsfieldImage(ctx, undefined, run); const assertion = expect(result).rejects.toThrow('did not return an image'); await vi.runAllTimersAsync(); await assertion;
  });
});
