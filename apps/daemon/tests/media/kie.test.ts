import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderKieImage } from '../../src/media/kie.js';
const assetFetch = vi.hoisted(() => vi.fn());
vi.mock('../../src/connectionTest.js', () => ({ assertAndFetchExternalAsset: assetFetch }));
const ctx = { wireModel: 'kie/nano-banana-2', prompt: 'A paper sculpture', imageRefs: [] };
const key = 'test-kie-key';
function response(data: unknown, code = 200) { return new Response(JSON.stringify({ code, data })); }
function mockResponses(...responses: Response[]) {
  const f = vi.fn(); for (const r of responses) f.mockResolvedValueOnce(r); vi.stubGlobal('fetch', f);
  assetFetch.mockResolvedValue(new Response('png-data', { headers: { 'content-type': 'image/png' } })); return f;
}
const output = { taskId: 'task-1', state: 'success', resultJson: JSON.stringify({ resultUrls: ['https://tempfile.redpandaai.co/out.png'] }) };
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe('KIE image adapter', () => {
  it('submits Nano Banana once and polls until success; download receives no credential', async () => {
    vi.useFakeTimers(); const f = mockResponses(response({ taskId: 'task-1' }), response({ taskId: 'task-1', state: 'generating' }), response(output));
    const result = renderKieImage(ctx, { apiKey: key }); await vi.runAllTimersAsync(); expect((await result).bytes.toString()).toBe('png-data');
    expect(f.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(f.mock.calls[0]![1].headers.authorization).toBe(`Bearer ${key}`);
    expect(f.mock.calls[0]![1].redirect).toBe('error');
    expect(JSON.parse(f.mock.calls[0]![1].body)).toMatchObject({ model: 'nano-banana-2', input: { resolution: '1K', output_format: 'png' } });
    expect(assetFetch.mock.calls[0]![1].headers).toBeUndefined();
  });
  it('uploads a reference to the documented upload origin, then passes its returned URL', async () => {
    vi.useFakeTimers(); const f = mockResponses(response({ downloadUrl: 'https://tempfile.redpandaai.co/ref.png' }), response({ taskId: 'task-1' }), response(output));
    const result = renderKieImage({ ...ctx, imageRefs: [{ mime: 'image/png', dataUrl: 'data:image/png;base64,cG5n' }] }, { apiKey: key }); await vi.runAllTimersAsync(); await result;
    expect(f.mock.calls[0]![0]).toBe('https://kieai.redpandaai.co/api/file-base64-upload');
    expect(JSON.parse(f.mock.calls[1]![1].body).input.image_input).toEqual(['https://tempfile.redpandaai.co/ref.png']);
  });
  it('does not bill a retry when the submission response is ambiguous', async () => {
    const f = vi.fn().mockRejectedValue(new Error(key)); vi.stubGlobal('fetch', f);
    await expect(renderKieImage(ctx, { apiKey: key })).rejects.toThrow('KIE request failed'); expect(f).toHaveBeenCalledTimes(1);
  });
  it('handles terminal failure without echoing the upstream payload', async () => {
    vi.useFakeTimers(); mockResponses(response({ taskId: 'task-1' }), response({ taskId: 'task-1', state: 'fail', failMsg: key }));
    const result = renderKieImage(ctx, { apiKey: key }); const assertion = expect(result).rejects.toThrow('KIE image generation failed'); await vi.runAllTimersAsync(); await assertion;
    expect(assetFetch).not.toHaveBeenCalled();
  });
  it('rejects missing credentials and unsupported resolution before submitting', async () => {
    const f = mockResponses(); await expect(renderKieImage(ctx, {})).rejects.toThrow('configure its API key in Settings');
    await expect(renderKieImage({ ...ctx, resolution: '8k' }, { apiKey: key })).rejects.toThrow('unsupported KIE resolution'); expect(f).not.toHaveBeenCalled();
  });
  it('reports API-level errors even when HTTP is 200', async () => {
    mockResponses(response({ taskId: 'task-1' }, 402)); await expect(renderKieImage(ctx, { apiKey: key })).rejects.toThrow('KIE API 402');
  });
});
