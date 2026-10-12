import { describe, expect, it, vi } from 'vitest';
import { SessionModelController } from '../src/runtime/workbench/session-model-controller';
const choice = { agentId: 'codex', modelId: 'default' };
const snapshot = (revision = 0, current: typeof choice | null = null) => ({ sessionId: 'conversation', projectId: 'project', revision, choice: current, updatedAt: 0 });
describe('next-turn session model controller', () => {
  it('saves the displayed legacy pair before allowing a send', async () => {
    const put = vi.fn(async (_id, input) => snapshot(1, input));
    const controller = new SessionModelController('conversation', choice, { get: async () => snapshot(), put });
    expect((await controller.ensureSaved()).revision).toBe(1);
    expect(put).toHaveBeenCalledWith('conversation', { ...choice, expectedRevision: 0 });
  });
  it('never bypasses a failed legacy PUT', async () => {
    const controller = new SessionModelController('conversation', choice, { get: async () => snapshot(), put: async () => { throw new Error('offline'); } });
    await expect(controller.ensureSaved()).rejects.toThrow('offline');
    expect(controller.state.choice).toEqual(choice);
    expect(controller.state.status).toBe('error');
  });
  it('preserves the requested choice and fetches authorized current state after409', async () => {
    const next = { agentId: 'claude', modelId: 'opus' };
    const get = vi.fn().mockResolvedValueOnce(snapshot(1, choice)).mockResolvedValue(snapshot(2, { agentId: 'gemini', modelId: 'pro' }));
    const put = vi.fn().mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 })).mockResolvedValue(snapshot(3, next));
    const controller = new SessionModelController('conversation', choice, { get, put });
    await controller.load();
    await expect(controller.select(next)).rejects.toThrow('conflict');
    expect(controller.state.choice).toEqual(next);
    expect(controller.state.snapshot?.revision).toBe(2);
    expect(controller.state.status).toBe('conflict');
    await expect(controller.ensureSaved()).rejects.toThrow('session-model-conflict');
    await controller.retry();
    expect(put).toHaveBeenLastCalledWith('conversation', { ...next, expectedRevision: 2 });
  });
  it('refuses a queued pre-conflict pick until explicit retry against current revision', async () => {
    const aChoice = { agentId: 'claude', modelId: 'opus' };
    const bChoice = { agentId: 'codex', modelId: 'next' };
    let rejectFirst!: (error: unknown) => void;
    const get = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(5, { agentId: 'gemini', modelId: 'pro' }));
    const put = vi.fn().mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; })).mockResolvedValue(snapshot(6, bChoice));
    const controller = new SessionModelController('conversation', choice, { get, put });
    await controller.load();
    const a = controller.select(aChoice);
    const aError = expect(a).rejects.toThrow('conflict');
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const b = controller.select(bChoice);
    const bError = expect(b).rejects.toThrow('session-model-conflict');
    rejectFirst(Object.assign(new Error('conflict'), { status: 409 }));
    await aError; await bError;
    expect(put).toHaveBeenCalledTimes(1);
    expect(controller.state.choice).toEqual(bChoice);
    expect(controller.state.status).toBe('conflict');
    await expect(controller.ensureSaved()).rejects.toThrow('session-model-conflict');
    await controller.retry();
    expect(put).toHaveBeenLastCalledWith('conversation', { ...bChoice, expectedRevision: 5 });
    expect(controller.state.snapshot?.revision).toBe(6);
  });
  it('allows an explicit new selection after the conflict is visible', async () => {
    const next = { agentId: 'claude', modelId: 'opus' };
    const get = vi.fn().mockResolvedValueOnce(snapshot()).mockResolvedValue(snapshot(5, { agentId: 'gemini', modelId: 'pro' }));
    const put = vi.fn().mockRejectedValueOnce(Object.assign(new Error('conflict'), { status: 409 })).mockResolvedValue(snapshot(6, next));
    const controller = new SessionModelController('conversation', choice, { get, put });
    await controller.load();
    await expect(controller.select(choice)).rejects.toThrow('conflict');
    expect(controller.state.status).toBe('conflict');
    await controller.select(next);
    expect(put).toHaveBeenLastCalledWith('conversation', { ...next, expectedRevision: 5 });
    expect(controller.state.status).toBe('ready');
  });
  it('blocks an invalid replacement instead of sending the old choice', async () => {
    const controller = new SessionModelController('conversation', choice, { get: async () => snapshot(1, choice), put: vi.fn() });
    await controller.load();
    controller.rejectSelection(new Error('endpoint unsupported'));
    await expect(controller.ensureSaved()).rejects.toThrow('endpoint unsupported');
  });
  it.each(['existing selection', 'legacy save'] as const)('keeps an invalid replacement while admission waits for %s', async mode => {
    const invalid = new Error('replacement endpoint unsupported');
    let release!: (value: ReturnType<typeof snapshot>) => void;
    const put = vi.fn(() => new Promise<ReturnType<typeof snapshot>>(resolve => { release = resolve; }));
    const controller = new SessionModelController('conversation', choice, { get: async () => snapshot(), put });
    await controller.load();
    const selection = mode === 'existing selection' ? controller.select(choice) : undefined;
    // Observe selection failure immediately, before releasing its deferred request.
    const selectionResult = selection?.catch(error => error);
    const admission = controller.ensureSaved();
    const admissionError = expect(admission).rejects.toBe(invalid);
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    controller.rejectSelection(invalid);
    release(snapshot(1, choice));
    await admissionError;
    if (selectionResult) expect(await selectionResult).toBe(invalid);
    expect(controller.state.snapshot).toEqual(snapshot(1, choice));
    expect(controller.state.status).toBe('error');
    expect(controller.state.error).toBe(invalid);
    await expect(controller.ensureSaved()).rejects.toBe(invalid);
    expect(put).toHaveBeenCalledTimes(1);
  });
  it('preserves a failed choice on reload and exposes a concurrent change', async () => {
    const pending = { agentId: 'claude', modelId: 'opus' };
    const controller = new SessionModelController('conversation', pending, { get: async () => snapshot(2, choice), put: vi.fn() }, 1);
    await controller.load();
    expect(controller.state.choice).toEqual(pending);
    expect(controller.state.status).toBe('conflict');
    await expect(controller.ensureSaved()).rejects.toThrow('session-model-conflict');
  });
  it('serializes rapid picks and freezes returned send snapshots', async () => {
    let release!: () => void;
    const put = vi.fn().mockImplementationOnce(async () => { await new Promise<void>(r => { release = r; }); return snapshot(2, { agentId: 'claude', modelId: 'opus' }); }).mockResolvedValue(snapshot(3, { agentId: 'gemini', modelId: 'pro' }));
    const controller = new SessionModelController('conversation', choice, { get: async () => snapshot(1, choice), put });
    await controller.load();
    const a = controller.select({ agentId: 'claude', modelId: 'opus' });
    await vi.waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const b = controller.select({ agentId: 'gemini', modelId: 'pro' });
    release(); await a; await b;
    expect(put).toHaveBeenLastCalledWith('conversation', { agentId: 'gemini', modelId: 'pro', expectedRevision: 2 });
    const admitted = await controller.ensureSaved();
    await controller.select({ agentId: 'codex', modelId: 'default' });
    expect(admitted.choice).toEqual({ agentId: 'gemini', modelId: 'pro' });
  });
});
