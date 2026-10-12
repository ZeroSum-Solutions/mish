// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { advanceWorkspaceAccountGeneration, resetWorkspaceAccountGeneration } from '../src/collab/workspace-identity';
import { DEFAULT_CONFIG } from '../src/state/config';
import { useSessionModel } from '../src/runtime/workbench/use-session-model';
import { useHomeModel } from '../src/runtime/workbench/use-home-model';
import type { SessionModelSnapshot, PutSessionModel } from '@open-design/contracts';
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), preflight: vi.fn() }));
vi.mock('../src/providers/workbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/workbench')>()),
  getSessionModel: api.get, putSessionModel: api.put, postModelPreflight: api.preflight,
}));
vi.mock('../src/components/SettingsDialog', () => ({ switchApiProtocolConfig: (config: Record<string, unknown>, protocol: string) => ({ ...config, mode: 'api', apiProtocol: protocol, ...(config.apiProtocolConfigs as Record<string, Record<string, unknown>>)?.[protocol] }) }));
const defaults = { ...DEFAULT_CONFIG, agentId: 'codex', agentModels: { codex: { model: 'default', reasoning: 'high' } } };
const snapshot = (sessionId: string, agentId = 'codex', modelId = 'default', revision = 1): SessionModelSnapshot => ({ sessionId, projectId: 'project', revision, choice: { agentId, modelId }, updatedAt: 0 });
beforeEach(() => {
  resetWorkspaceAccountGeneration(); sessionStorage.clear();
  api.get.mockReset(); api.put.mockReset(); api.preflight.mockReset();
  api.get.mockImplementation(async (id: string) => snapshot(id));
  api.put.mockImplementation(async (id: string, _project: string, input: PutSessionModel) => ({ ...snapshot(id, input.agentId, input.modelId, input.expectedRevision + 1), choice: { agentId: input.agentId, modelId: input.modelId, ...(input.byokBinding ? { byokBinding: input.byokBinding } : {}) } }));
  // AC-R02.3 select-time gate: every picker selection in this file is
  // expected to be a GOOD one (these tests cover drafts/persistence, not
  // capability mismatches) — see `session-model-picker-preflight.test.tsx`
  // for the gate's own mismatch/network-error coverage. Resolving `ok: true`
  // here keeps every existing `act()`/`waitFor()` pair meaningful: the hook
  // now reports `status: 'saving'` for the gate itself, so these callers
  // still correctly block on it.
  api.preflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) => ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] }));
});
afterEach(() => cleanup());
describe('Home and per-conversation model hooks', () => {
  it.each(['Home', 'conversation'])('keeps %s provider drafts separate and reuses only matching Settings keys', async (surface) => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet', reasoning: 'high' } },
      apiProtocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: 'fixture-anthropic-key', model: 'claude-sonnet-4-5',
      apiProtocolConfigs: { openai: { baseUrl: 'https://gateway.example/v1', model: 'openai-default', apiKey: 'fixture-openai-key' } } };
    const original = JSON.stringify(initial);
    api.get.mockResolvedValue(snapshot('a', 'claude', 'sonnet'));
    const { result } = renderHook(() => surface === 'Home' ? useHomeModel(initial, null) : useSessionModel(initial, 'project', 'a', null));
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    act(() => result.current.onModeChange('api')); await settle();
    act(() => result.current.onApiModelChange('anthropic-draft')); await settle();
    act(() => result.current.onApiProtocolChange('openai')); await settle();
    act(() => result.current.onApiModelChange('openai-draft')); await settle();
    act(() => result.current.onApiProtocolChange('anthropic')); await settle();
    expect(result.current.config).toMatchObject({ apiProtocol: 'anthropic', model: 'anthropic-draft', apiKey: 'fixture-anthropic-key' });
    act(() => result.current.onModeChange('daemon')); await settle();
    expect(result.current.config).toMatchObject({ agentId: 'claude', agentModels: { claude: { model: 'sonnet', reasoning: 'high' } } });
    act(() => result.current.onModeChange('api')); await settle();
    expect(result.current.config).toMatchObject({ apiProtocol: 'anthropic', model: 'anthropic-draft' });
    act(() => result.current.onApiProtocolChange('openai')); await settle();
    expect(result.current.config).toMatchObject({ apiProtocol: 'openai', model: 'openai-draft', apiKey: 'fixture-openai-key' });
    if ('ensureSaved' in result.current) expect(result.current.executionConfig(await result.current.ensureSaved()).apiKey).toBe('fixture-openai-key');
    expect(JSON.stringify(initial)).toBe(original);
    const publicValues = Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)).join();
    expect(publicValues).not.toMatch(/apiKey|fixture-.*-key/);
    expect(JSON.stringify(api.put.mock.calls)).not.toMatch(/apiKey|fixture-.*-key/);
  });
  it.each(['Home', 'conversation'])('retains incomplete and unsupported %s BYOK drafts through Local CLI', async (surface) => {
    const initial = { ...defaults, apiProtocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    const { result } = renderHook(() => surface === 'Home' ? useHomeModel(initial, null) : useSessionModel(initial, 'project', 'a', null));
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    act(() => result.current.onModeChange('api')); await settle();
    act(() => result.current.onApiModelChange(''));
    act(() => result.current.onModeChange('daemon')); await settle();
    expect(result.current.config.agentId).toBe('codex');
    act(() => result.current.onModeChange('api'));
    expect(result.current.config).toMatchObject({ mode: 'api', apiProtocol: 'anthropic', model: '' });
    act(() => result.current.onApiProtocolChange('bedrock'));
    act(() => result.current.onModeChange('daemon')); await settle();
    act(() => result.current.onModeChange('api'));
    expect(result.current.config).toMatchObject({ mode: 'api', apiProtocol: 'bedrock', model: '' });
    if ('state' in result.current) expect(result.current.state.error).toEqual(new Error('session-model-protocol-unsupported'));
    else expect(result.current.choice()).toBeNull();
    expect(api.put.mock.calls.every(call => call[2].byokBinding?.protocol !== 'bedrock')).toBe(true);
  });
  it('does not invent a local agent when a BYOK default has no previous native choice', () => {
    const initial = { ...defaults, mode: 'api' as const, agentId: 'byok-opencode', baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    const { result } = renderHook(() => useHomeModel(initial, null));
    act(() => result.current.onModeChange('daemon'));
    expect(result.current.config).toMatchObject({ mode: 'daemon', agentId: null });
    expect(result.current.error).toEqual(new Error('session-model-agent-required'));
    expect(sessionStorage.length).toBe(0);
  });
  it('clears Home native and BYOK drafts on same-account sign-out and sign-in', () => {
    const initial = { ...defaults, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    const { result, rerender } = renderHook(() => useHomeModel(initial, null));
    act(() => result.current.onAgentChange('claude'));
    act(() => result.current.onModeChange('api'));
    act(() => result.current.onApiModelChange('private-session-draft'));
    advanceWorkspaceAccountGeneration('signed-out'); advanceWorkspaceAccountGeneration('signed-in-same-account'); rerender();
    act(() => result.current.onModeChange('api'));
    expect(result.current.config.model).toBe(initial.model);
    act(() => result.current.onModeChange('daemon'));
    expect(result.current.config.agentId).toBe('codex');
  });
  it.each(['Home', 'conversation'])('ignores stale %s picker callbacks after an account round trip', async (surface) => {
    const initial = { ...defaults, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    const { result, rerender } = renderHook(() => surface === 'Home' ? useHomeModel(initial, null) : useSessionModel(initial, 'project', 'a', null));
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    const stale = result.current;
    advanceWorkspaceAccountGeneration('signed-out'); advanceWorkspaceAccountGeneration('signed-in-same-account'); rerender();
    await settle();
    act(() => { stale.onApiModelChange('stale-draft'); stale.onAgentChange('gemini'); });
    act(() => result.current.onModeChange('api')); await settle();
    expect(result.current.config.model).toBe(initial.model);
    act(() => result.current.onModeChange('daemon')); await settle();
    expect(result.current.config.agentId).toBe('codex');
    expect(JSON.stringify(api.put.mock.calls)).not.toMatch(/stale-draft|gemini/);
  });
  // AC-R02.3 select-time gate: a picker selection is preflighted (no
  // attachments) before it is ever persisted. These three cover the gate
  // itself; the many other tests in this file rely on the `beforeEach`
  // default (`ok: true`) to keep exercising drafts/persistence unchanged.
  it('persists a picker selection that passes the select-time preflight', async () => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } };
    api.get.mockResolvedValue(snapshot('a', 'claude', 'sonnet'));
    const { result } = renderHook(() => useSessionModel(initial, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.choice).toEqual({ agentId: 'codex', modelId: 'fast' });
    expect(api.put).toHaveBeenCalledWith('a', 'project', expect.objectContaining({ agentId: 'codex', modelId: 'fast' }), null);
    expect(result.current.config).toMatchObject({ agentId: 'codex' });
    expect(result.current.pickerPreflight).toBeNull();
  });
  it('does not persist a picker selection the select-time preflight rejects, and keeps the previous choice selected', async () => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } };
    api.get.mockResolvedValue(snapshot('a', 'claude', 'sonnet'));
    api.preflight.mockResolvedValue({ agentId: 'codex', modelId: 'fast', ok: false, mismatches: [{ code: 'model-unavailable', message: 'nope' }] });
    const { result } = renderHook(() => useSessionModel(initial, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    await waitFor(() => expect(result.current.pickerPreflight?.status).toBe('mismatch'));
    expect(result.current.state.choice).toEqual({ agentId: 'claude', modelId: 'sonnet' });
    expect(result.current.config).toMatchObject({ agentId: 'claude' });
    expect(api.put).not.toHaveBeenCalled();
  });
  it('does not persist a picker selection when the preflight CALL itself fails, and keeps the previous choice selected', async () => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } };
    api.get.mockResolvedValue(snapshot('a', 'claude', 'sonnet'));
    api.preflight.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSessionModel(initial, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onAgentModelChange('codex', { model: 'fast' }));
    await waitFor(() => expect(result.current.pickerPreflight?.status).toBe('network-error'));
    expect(result.current.state.choice).toEqual({ agentId: 'claude', modelId: 'sonnet' });
    expect(api.put).not.toHaveBeenCalled();
  });
  it('uses the authoritative native pair and clears drafts when changing conversations', async () => {
    const initial = { ...defaults, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    api.get.mockImplementation(async (id: string) => snapshot(id, id === 'a' ? 'claude' : 'gemini', id === 'a' ? 'sonnet' : 'pro'));
    const { result, rerender } = renderHook(({ id }) => useSessionModel(initial, 'project', id, null), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onModeChange('api'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiModelChange('conversation-a-draft'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onModeChange('daemon'));
    await waitFor(() => expect(result.current.state.snapshot?.choice).toEqual({ agentId: 'claude', modelId: 'sonnet' }));
    rerender({ id: 'b' }); await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onModeChange('api'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.config.model).toBe(initial.model);
    act(() => result.current.onModeChange('daemon'));
    await waitFor(() => expect(result.current.state.snapshot?.choice).toEqual({ agentId: 'gemini', modelId: 'pro' }));
  });
  it('restores the Home local agent and BYOK draft across repeated mode switches without keys', () => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } },
      apiProtocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-5' };
    const { result } = renderHook(() => useHomeModel(initial, null));
    act(() => result.current.onModeChange('api'));
    act(() => result.current.onApiModelChange('claude-opus-5-5'));
    expect(result.current.config.mode).toBe('api');
    act(() => result.current.onModeChange('daemon'));
    expect(result.current.config).toMatchObject({ mode: 'daemon', agentId: 'claude', agentModels: { claude: { model: 'sonnet' } } });
    act(() => result.current.onModeChange('api'));
    expect(result.current.config).toMatchObject({ mode: 'api', model: 'claude-opus-5-5', apiKey: '' });
    act(() => result.current.onModeChange('daemon'));
    expect(result.current.config.agentId).toBe('claude');
  });
  it('restores the conversation local pair after keyless BYOK display switches and keeps HTTP choices coherent', async () => {
    const initial = { ...defaults, agentId: 'claude', agentModels: { claude: { model: 'sonnet' } },
      apiProtocol: 'anthropic' as const, baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-5' };
    api.get.mockResolvedValue(snapshot('a', 'claude', 'sonnet'));
    const { result } = renderHook(() => useSessionModel(initial, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onModeChange('api'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiModelChange('claude-opus-5-5'));
    await waitFor(() => expect(result.current.state.snapshot?.choice?.modelId).toBe('claude-opus-5-5'));
    act(() => result.current.onModeChange('daemon'));
    await waitFor(() => expect(result.current.config.mode).toBe('daemon'));
    expect(result.current.config.agentId).toBe('claude');
    expect((await result.current.ensureSaved()).choice).toEqual({ agentId: 'claude', modelId: 'sonnet' });
    act(() => result.current.onModeChange('api'));
    await waitFor(() => expect(result.current.state.snapshot?.choice).toMatchObject({ agentId: 'byok-opencode', modelId: 'claude-opus-5-5' }));
    act(() => result.current.onModeChange('daemon'));
    await waitFor(() => expect(result.current.state.snapshot?.choice).toEqual({ agentId: 'claude', modelId: 'sonnet' }));
    expect(api.put.mock.calls.map(call => call[2].agentId)).toEqual(['byok-opencode', 'byok-opencode', 'claude', 'byok-opencode', 'claude']);
  });
  it('saves an explicit native model pick from a BYOK conversation as a native pair', async () => {
    const initial = { ...defaults, baseUrl: 'https://api.anthropic.com', model: 'claude-sonnet-4-5' };
    const { result } = renderHook(() => useSessionModel(initial, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onModeChange('api'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onAgentModelChange('claude', { model: 'claude-opus-5-5' }));
    await waitFor(() => expect(result.current.state.snapshot?.choice).toEqual({ agentId: 'claude', modelId: 'claude-opus-5-5' }));
    expect(result.current.config.mode).toBe('daemon');
    expect(api.put.mock.calls.at(-1)?.[2]).not.toHaveProperty('byokBinding');
  });
  it('loads separate conversation choices without changing Settings defaults', async () => {
    api.get.mockImplementation(async (id: string) => id === 'a' ? snapshot(id, 'claude', 'opus') : snapshot(id, 'gemini', 'pro'));
    const { result, rerender } = renderHook(({ id }) => useSessionModel(defaults, 'project', id, null), { initialProps: { id: 'a' } });
    await waitFor(() => expect(result.current.config.agentId).toBe('claude'));
    rerender({ id: 'b' }); await waitFor(() => expect(result.current.config.agentId).toBe('gemini'));
    expect(defaults.agentId).toBe('codex'); expect(api.put).not.toHaveBeenCalled();
  });
  it('preserves failed picks on reload and shows a later server conflict', async () => {
    api.put.mockRejectedValue(new Error('offline'));
    const first = renderHook(() => useSessionModel(defaults, 'project', 'a', null));
    await waitFor(() => expect(first.result.current.state.status).toBe('ready'));
    act(() => first.result.current.onAgentModelChange('codex', { model: 'next' }));
    await waitFor(() => expect(first.result.current.state.status).toBe('error'));
    expect(first.result.current.config.agentModels?.codex?.model).toBe('next');
    first.unmount(); api.get.mockResolvedValue(snapshot('a', 'gemini', 'pro', 2));
    const next = renderHook(() => useSessionModel(defaults, 'project', 'a', null));
    await waitFor(() => expect(next.result.current.state.status).toBe('conflict'));
    expect(next.result.current.config.agentModels?.codex?.model).toBe('next');
    await expect(next.result.current.ensureSaved()).rejects.toThrow('session-model-conflict');
  });
  it('keeps a captured turn pair while changing the next choice and retains reasoning policy', async () => {
    const { result } = renderHook(() => useSessionModel(defaults, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    const admitted = await result.current.ensureSaved();
    act(() => result.current.onAgentModelChange('codex', { model: 'next', reasoning: 'low' }));
    await waitFor(() => expect(result.current.state.snapshot?.revision).toBe(2));
    expect(admitted.choice?.modelId).toBe('default');
    expect(result.current.executionConfig(await result.current.ensureSaved()).agentModels?.codex).toMatchObject({ model: 'next', reasoning: 'low' });
  });
  it('uses a repaired Settings carrier on explicit retry while keeping the requested model', async () => {
    const broken = { ...defaults, apiProtocolConfigs: { openai: { baseUrl: 'javascript:invalid', apiKey: 'fixture-key', model: 'requested-raw' } } };
    const { result, rerender } = renderHook(({ settings }) => useSessionModel(settings, 'project', 'a', null), { initialProps: { settings: broken } });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiProtocolChange('openai'));
    await waitFor(() => expect(result.current.state.status).toBe('error'));
    expect(api.put).not.toHaveBeenCalled();
    rerender({ settings: { ...broken, apiProtocolConfigs: { openai: { baseUrl: 'https://gateway.example/v1', apiKey: 'repaired-key', model: 'new-default' } } } });
    await act(async () => { await result.current.retry(); });
    expect(api.put).toHaveBeenLastCalledWith('a', 'project', expect.objectContaining({ modelId: 'requested-raw', byokBinding: expect.objectContaining({ baseUrl: 'https://gateway.example/v1' }) }), null);
    const execution = result.current.executionConfig(await result.current.ensureSaved());
    expect(execution.model).toBe('requested-raw'); expect(execution.apiKey).toBe('repaired-key');
  });
  it('refuses a pending model response across same-account sign-out/sign-in', async () => {
    let release!: (value: SessionModelSnapshot) => void;
    api.put.mockImplementationOnce(() => new Promise<SessionModelSnapshot>(resolve => { release = resolve; }));
    const { result, rerender } = renderHook(() => useSessionModel(defaults, 'project', 'a', null));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onAgentModelChange('codex', { model: 'pending' }));
    await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
    const admission = result.current.ensureSaved();
    const blocked = expect(admission).rejects.toThrow('session-model-scope-changed');
    advanceWorkspaceAccountGeneration('signed-out');
    advanceWorkspaceAccountGeneration('signed-in-same-account');
    rerender();
    release(snapshot('a', 'codex', 'pending', 2));
    await blocked;
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.state.snapshot?.choice?.modelId).toBe('default');
  });
  it('keeps Home choice local and persists only its public identity', () => {
    const { result } = renderHook(() => useHomeModel(defaults, null));
    act(() => result.current.onAgentChange('claude'));
    expect(result.current.choice()).toEqual({ agentId: 'claude', modelId: 'default' });
    expect(defaults.agentId).toBe('codex');
    const values = Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)).join();
    expect(values).toContain('claude'); expect(values).not.toContain('apiKey');
  });
  it('projects an unsupported Home default without throwing or persisting a choice', () => {
    const unsupported = { ...defaults, mode: 'api' as const, apiProtocol: 'bedrock' as const, model: 'bedrock-model' };
    const { result } = renderHook(() => useHomeModel(unsupported, null));
    expect(result.current.choice()).toBeNull();
    expect(result.current.config.apiProtocol).toBe('bedrock');
    expect(sessionStorage.length).toBe(0);
  });
  it('retains an incomplete Home picker draft without storing null as a public choice', () => {
    const configured = { ...defaults, mode: 'api' as const, apiProtocol: 'openai' as const, baseUrl: 'https://gateway.example/v1', model: 'configured-model' };
    const { result } = renderHook(() => useHomeModel(configured, null));
    act(() => result.current.onApiModelChange(''));
    expect(result.current.config.model).toBe('');
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.choice()).toBeNull();
    expect(sessionStorage.length).toBe(0);
  });
  it('rejects an incomplete unselected default locally and allows a repaired Settings retry', async () => {
    api.get.mockResolvedValue({ sessionId: 'a', projectId: 'project', revision: 0, choice: null, updatedAt: null });
    const incomplete = { ...defaults, agentId: '' };
    const { result, rerender } = renderHook(({ settings }) => useSessionModel(settings, 'project', 'a', null), { initialProps: { settings: incomplete } });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    await act(async () => { await expect(result.current.ensureSaved()).rejects.toBeInstanceOf(Error); });
    expect(result.current.state.status).toBe('error');
    expect(api.put).not.toHaveBeenCalled();
    rerender({ settings: defaults });
    await act(async () => { await result.current.ensureSaved(); });
    expect(result.current.state.status).toBe('ready');
    expect(result.current.state.snapshot?.choice).toEqual({ agentId: 'codex', modelId: 'default' });
    expect(api.put).toHaveBeenCalledTimes(1);
    expect(incomplete.agentId).toBe('');
  });
});
