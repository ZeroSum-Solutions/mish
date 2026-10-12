// @vitest-environment jsdom
// AC-R02.3: a send that waits for the picker to settle must never wait
// forever. A picker check times out as a failed check, every wait is capped,
// and unmount or a conversation change ends the wait as `cancelled`.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PutSessionModel, SessionModelSnapshot } from '@mish/contracts';
import { resetWorkspaceAccountGeneration } from '../src/collab/workspace-identity';
import { DEFAULT_CONFIG } from '../src/state/config';
import {
  PICKER_PREFLIGHT_TIMEOUT_MS,
  PICKER_SETTLE_MAX_WAIT_MS,
  useSessionModel,
} from '../src/runtime/workbench/use-session-model';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), preflight: vi.fn() }));
vi.mock('../src/providers/workbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/workbench')>()),
  getSessionModel: api.get, putSessionModel: api.put, postModelPreflight: api.preflight,
}));
vi.mock('../src/components/SettingsDialog', () => ({ switchApiProtocolConfig: (config: Record<string, unknown>) => config }));

const defaults = { ...DEFAULT_CONFIG, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } };
const snapshot = (sessionId: string, agentId = 'claude', modelId = 'sonnet', revision = 1): SessionModelSnapshot =>
  ({ sessionId, projectId: 'project', revision, choice: { agentId, modelId }, updatedAt: 0 });

/** Records each picker check's abort signal; the check itself never answers. */
const signals: AbortSignal[] = [];

beforeEach(() => {
  resetWorkspaceAccountGeneration();
  sessionStorage.clear();
  signals.length = 0;
  api.get.mockReset(); api.put.mockReset(); api.preflight.mockReset();
  api.get.mockImplementation(async (id: string) => snapshot(id));
  api.put.mockImplementation(async (id: string, _project: string, input: PutSessionModel) =>
    snapshot(id, input.agentId, input.modelId, input.expectedRevision + 1));
  api.preflight.mockImplementation((_s: string, _p: string, _input: unknown, _ctx: unknown, options?: { signal?: AbortSignal }) => {
    if (options?.signal) signals.push(options.signal);
    return new Promise(() => {});
  });
});
afterEach(() => { vi.useRealTimers(); cleanup(); });

async function renderReady(id = 'a') {
  const hook = renderHook(({ sessionId }) => useSessionModel(defaults, 'project', sessionId, null), { initialProps: { sessionId: id } });
  await waitFor(() => expect(hook.result.current.state.status).toBe('ready'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return hook;
}

describe('a wait for a settled picker always ends', () => {
  it('times out a picker check that never answers as a failed check and keeps the previous choice', async () => {
    const { result } = await renderReady();
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    expect(result.current.pickerPreflight?.status).toBe('checking');

    await act(async () => { await vi.advanceTimersByTimeAsync(PICKER_PREFLIGHT_TIMEOUT_MS); });
    expect(result.current.pickerPreflight?.status).toBe('network-error');
    expect(result.current.state.choice).toEqual({ agentId: 'claude', modelId: 'sonnet' });
    expect(signals).toHaveLength(1);
    expect(signals[0]!.aborted).toBe(true);
    expect(api.put).not.toHaveBeenCalled();
  });

  it('settles a waiting send once that check times out', async () => {
    const { result } = await renderReady();
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    let outcome: unknown = 'pending';
    act(() => { void result.current.whenPickerSettled().then(value => { outcome = value; }); });
    await act(async () => { await vi.advanceTimersByTimeAsync(PICKER_PREFLIGHT_TIMEOUT_MS); });
    expect(outcome).toBe('settled');
  });

  it('cancels a waiting send when the view unmounts', async () => {
    const { result, unmount } = await renderReady();
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    let outcome: unknown = 'pending';
    act(() => { void result.current.whenPickerSettled().then(value => { outcome = value; }); });
    unmount();
    await act(async () => { await Promise.resolve(); });
    expect(outcome).toBe('cancelled');
  });

  it('cancels a waiting send when the conversation changes', async () => {
    const { result, rerender } = await renderReady();
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    let outcome: unknown = 'pending';
    act(() => { void result.current.whenPickerSettled().then(value => { outcome = value; }); });
    act(() => rerender({ sessionId: 'b' }));
    await act(async () => { await Promise.resolve(); });
    expect(outcome).toBe('cancelled');
  });

  it('caps the whole wait when the user keeps picking new models', async () => {
    const { result } = await renderReady();
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    let outcome: unknown = 'pending';
    act(() => { void result.current.whenPickerSettled().then(value => { outcome = value; }); });
    const repick = PICKER_PREFLIGHT_TIMEOUT_MS - 1_000;
    for (let elapsed = repick; elapsed < PICKER_SETTLE_MAX_WAIT_MS; elapsed += repick) {
      await act(async () => { await vi.advanceTimersByTimeAsync(repick); });
      expect(outcome).toBe('pending');
      act(() => result.current.onAgentModelChange('codex', { model: elapsed % 2 === 0 ? 'fast' : 'slow' }));
    }
    await act(async () => { await vi.advanceTimersByTimeAsync(PICKER_SETTLE_MAX_WAIT_MS); });
    expect(outcome).toBe('timed-out');
  });
});
