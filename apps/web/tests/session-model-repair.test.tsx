// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PutSessionModel, SessionModelSnapshot } from '@open-design/contracts';
import { resetWorkspaceAccountGeneration } from '../src/collab/workspace-identity';
import { switchApiProtocolConfig } from '../src/components/SettingsDialog';
import { DEFAULT_CONFIG } from '../src/state/config';
import { useHomeModel } from '../src/runtime/workbench/use-home-model';
import { useSessionModel } from '../src/runtime/workbench/use-session-model';
import { configForSessionChoice, requireSessionChoiceFromConfig } from '../src/runtime/workbench/session-model-config';
import type { AppConfig } from '../src/types';

const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), preflight: vi.fn() }));
vi.mock('../src/providers/workbench', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/providers/workbench')>()),
  getSessionModel: api.get, putSessionModel: api.put, postModelPreflight: api.preflight,
}));
// SettingsDialog and switchApiProtocolConfig are deliberately real here.
const settings: AppConfig = { ...DEFAULT_CONFIG, mode: 'daemon', agentId: 'codex', agentModels: { codex: { model: 'default' } },
  apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiKey: '', model: 'claude-sonnet-4-5',
  apiProtocolConfigs: { openai: { baseUrl: 'https://old.gateway.example/v1', apiProviderBaseUrl: null, apiKey: '', model: 'settings-x' } } };
const repaired: AppConfig = { ...settings, apiProtocolConfigs: { openai: {
  baseUrl: 'https://repaired.gateway.example/v1', apiProviderBaseUrl: null, apiKey: 'fixture-repaired-key', model: 'settings-y',
} } };
const snapshot = (choice: SessionModelSnapshot['choice'], revision = 1): SessionModelSnapshot => ({
  sessionId: 'a', projectId: 'project', revision, choice, updatedAt: 0,
});
beforeEach(() => {
  resetWorkspaceAccountGeneration(); sessionStorage.clear(); api.get.mockReset(); api.put.mockReset(); api.preflight.mockReset();
  api.get.mockResolvedValue(snapshot({ agentId: 'codex', modelId: 'default' }));
  api.put.mockImplementation(async (_id: string, _project: string, input: PutSessionModel) => snapshot({
    agentId: input.agentId, modelId: input.modelId, ...(input.byokBinding ? { byokBinding: input.byokBinding } : {}),
  }, input.expectedRevision + 1));
  // AC-R02.3 select-time gate: this file covers Settings-repair/BYOK
  // carrier picking, not capability mismatches — every picker selection
  // here is expected to pass.
  api.preflight.mockImplementation(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) =>
    ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] }));
});
afterEach(cleanup);
describe('picker recovery through the real Settings protocol switch', () => {
  it.each([
    ['Home', 'mode'], ['Home', 'provider'], ['conversation', 'mode'], ['conversation', 'provider'],
  ] as const)('uses the repaired Settings endpoint after %s %s round trips while keeping the chosen model', async (surface, route) => {
    // Establish the helper's real target-slot behavior, independently of hooks.
    expect(switchApiProtocolConfig(repaired, 'openai')).toMatchObject(repaired.apiProtocolConfigs!.openai!);
    const { result, rerender } = renderHook(({ defaults }) => surface === 'Home'
      ? useHomeModel(defaults, null) : useSessionModel(defaults, 'project', 'a', null), { initialProps: { defaults: settings } });
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    act(() => result.current.onApiProtocolChange('openai')); await settle();
    act(() => result.current.onApiModelChange('owner/chosen:tag')); await settle();
    expect(result.current.config).toMatchObject({ baseUrl: 'https://old.gateway.example/v1', apiKey: '' });
    if ('ensureSaved' in result.current) {
      const { executionConfig, state } = result.current;
      expect(() => executionConfig(state.snapshot!)).toThrow('session-model-credentials-unavailable');
    }
    rerender({ defaults: repaired });
    act(() => route === 'mode' ? result.current.onModeChange('daemon') : result.current.onApiProtocolChange('anthropic')); await settle();
    act(() => route === 'mode' ? result.current.onModeChange('api') : result.current.onApiProtocolChange('openai')); await settle();
    expect(result.current.config).toMatchObject({ mode: 'api', apiProtocol: 'openai', baseUrl: 'https://repaired.gateway.example/v1', apiKey: 'fixture-repaired-key', model: 'owner/chosen:tag' });
    const choice = requireSessionChoiceFromConfig(result.current.config);
    expect(configForSessionChoice(repaired, choice)).toMatchObject({ apiKey: 'fixture-repaired-key', model: 'owner/chosen:tag' });
    if ('ensureSaved' in result.current) expect(result.current.executionConfig(await result.current.ensureSaved()).baseUrl).toBe('https://repaired.gateway.example/v1');
    const publicValues = Object.keys(sessionStorage).map(key => sessionStorage.getItem(key)).join();
    expect(publicValues).not.toMatch(/apiKey|fixture-repaired-key/);
    expect(JSON.stringify(api.put.mock.calls)).not.toMatch(/apiKey|fixture-repaired-key/);
  });
  it.each(['Home', 'conversation'])('keeps an executable non-default endpoint in %s when its existing carrier still matches', async (surface) => {
    const initial: AppConfig = { ...settings, apiProtocolConfigs: { openai: { ...settings.apiProtocolConfigs!.openai!, apiKey: 'fixture-pinned-key' } } };
    const nextSettings: AppConfig = { ...repaired, byokProviderConfigDrafts: {
      'openai:custom:old': { apiConfig: initial.apiProtocolConfigs!.openai! },
    } };
    const { result, rerender } = renderHook(({ defaults }) => surface === 'Home'
      ? useHomeModel(defaults, null) : useSessionModel(defaults, 'project', 'a', null), { initialProps: { defaults: initial } });
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    act(() => result.current.onApiProtocolChange('openai')); await settle();
    act(() => result.current.onApiModelChange('owner/pinned:tag')); await settle();
    rerender({ defaults: nextSettings });
    act(() => result.current.onModeChange('daemon')); await settle();
    act(() => result.current.onModeChange('api')); await settle();
    expect(result.current.config).toMatchObject({ baseUrl: 'https://old.gateway.example/v1', apiKey: 'fixture-pinned-key', model: 'owner/pinned:tag' });
    expect(configForSessionChoice(nextSettings, requireSessionChoiceFromConfig(result.current.config)).apiKey).toBe('fixture-pinned-key');
  });
  it.each(['Home', 'conversation'])('retains an incomplete %s model while adopting a repaired endpoint, then recovers when selected', async (surface) => {
    const { result, rerender } = renderHook(({ defaults }) => surface === 'Home'
      ? useHomeModel(defaults, null) : useSessionModel(defaults, 'project', 'a', null), { initialProps: { defaults: settings } });
    const settle = async () => { if (surface === 'conversation') await waitFor(() => {
      expect('state' in result.current && result.current.state.status).toBe('ready');
    }); };
    await settle();
    act(() => result.current.onApiProtocolChange('openai')); await settle();
    act(() => result.current.onApiModelChange(''));
    rerender({ defaults: repaired });
    act(() => result.current.onModeChange('daemon')); await settle();
    act(() => result.current.onModeChange('api'));
    expect(result.current.config).toMatchObject({ baseUrl: 'https://repaired.gateway.example/v1', model: '', apiKey: '' });
    expect(requireSessionChoiceFromConfig.bind(null, result.current.config)).toThrow('session-model-config-incomplete');
    act(() => result.current.onApiModelChange('owner/selected:tag')); await settle();
    expect(result.current.config).toMatchObject({ model: 'owner/selected:tag', apiKey: 'fixture-repaired-key' });
  });
  it('never combines the old endpoint with a new keyless or unrelated credential slot', () => {
    const withoutCarrier: AppConfig = { ...repaired, apiProtocolConfigs: {
      ...repaired.apiProtocolConfigs, openai: { ...repaired.apiProtocolConfigs!.openai!, apiKey: '' },
      google: { baseUrl: 'https://old.gateway.example/v1', model: 'google-model', apiKey: 'fixture-unrelated-key' },
    } };
    const { result, rerender } = renderHook(({ defaults }) => useHomeModel(defaults, null), { initialProps: { defaults: settings } });
    act(() => result.current.onApiProtocolChange('openai'));
    act(() => result.current.onApiModelChange('owner/draft:tag'));
    rerender({ defaults: withoutCarrier });
    act(() => result.current.onModeChange('daemon'));
    act(() => result.current.onModeChange('api'));
    expect(result.current.config).toMatchObject({ baseUrl: 'https://old.gateway.example/v1', apiKey: '', model: 'owner/draft:tag' });
    expect(() => configForSessionChoice(withoutCarrier, requireSessionChoiceFromConfig(result.current.config))).toThrow('session-model-credentials-unavailable');
  });
  it('adopts the repaired Azure API version and keeps the chosen deployment', async () => {
    const initial: AppConfig = { ...settings, apiProtocolConfigs: { azure: {
      baseUrl: 'https://azure.example', apiVersion: '2024-10-21', model: 'default-deployment', apiKey: '',
    } } };
    const nextSettings: AppConfig = { ...initial, apiProtocolConfigs: { azure: {
      ...initial.apiProtocolConfigs!.azure!, apiVersion: '2025-04-01-preview', model: 'new-default', apiKey: 'fixture-azure-key',
    } } };
    const { result, rerender } = renderHook(({ defaults }) => useSessionModel(defaults, 'project', 'a', null), { initialProps: { defaults: initial } });
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiProtocolChange('azure'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiModelChange('chosen-deployment'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    rerender({ defaults: nextSettings });
    act(() => result.current.onApiProtocolChange('anthropic'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    act(() => result.current.onApiProtocolChange('azure'));
    await waitFor(() => expect(result.current.state.status).toBe('ready'));
    expect(result.current.config).toMatchObject({ apiProtocol: 'azure', apiVersion: '2025-04-01-preview', model: 'chosen-deployment', apiKey: 'fixture-azure-key' });
    expect((await result.current.ensureSaved()).choice?.byokBinding?.apiVersion).toBe('2025-04-01-preview');
  });
});
