// @vitest-environment jsdom
//
// Integration witness for explicit AMR selection across first-run onboarding.
// Keep the real App, router and onboarding UI. Emit the initial daemon agent
// probe incrementally so Claude arrives before AMR, then select the cloud source
// explicitly and verify both persisted config and the Home switcher's branding.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { AgentInfo, AppConfig } from '../../src/types';
import { loadConfig, fetchDaemonConfig, saveConfig, syncConfigToDaemon } from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgentsStream,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { fetchAmrModels } from '../../src/providers/daemon';
import { listProjects, listTemplates } from '../../src/state/projects';

const analyticsMocks = vi.hoisted(() => ({ track: vi.fn() }));

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      newRequestId: vi.fn(() => 'request-1'),
      setConfigureGlobals: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setUserId: vi.fn(),
      track: analyticsMocks.track,
    }),
    useAppVersion: () => null,
  };
});

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));
vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgentsStream: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../src/providers/daemon', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/daemon')>(
    '../../src/providers/daemon',
  );
  return { ...actual, fetchAmrModels: vi.fn() };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, listProjects: vi.fn(), listTemplates: vi.fn() };
});

// Keep the REAL mergeDaemonConfig/loadConfig logic; only stub the network
// writes and the daemon GET so we can drive a deterministic first-run.
vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn().mockResolvedValue(null),
    loadConfig: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn().mockResolvedValue({ status: 'ok', providers: null }),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
    syncMediaProvidersToDaemon: vi.fn().mockResolvedValue(undefined),
    saveConfig: vi.fn(),
  };
});

const mockedDaemonIsLive = vi.mocked(daemonIsLive);
const mockedFetchAgentsStream = vi.mocked(fetchAgentsStream);
const mockedFetchAppVersionInfo = vi.mocked(fetchAppVersionInfo);
const mockedFetchDesignSystems = vi.mocked(fetchDesignSystems);
const mockedFetchDesignTemplates = vi.mocked(fetchDesignTemplates);
const mockedFetchPromptTemplates = vi.mocked(fetchPromptTemplates);
const mockedFetchSkills = vi.mocked(fetchSkills);
const mockedFetchAmrModels = vi.mocked(fetchAmrModels);
const mockedListProjects = vi.mocked(listProjects);
const mockedListTemplates = vi.mocked(listTemplates);
const mockedLoadConfig = vi.mocked(loadConfig);
const mockedFetchDaemonConfig = vi.mocked(fetchDaemonConfig);

const claudeAgent = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [{ id: 'sonnet', label: 'Sonnet' }],
};
const amrAgent = {
  id: 'amr',
  name: 'AMR',
  bin: 'vela',
  available: true,
  version: '1.0.0',
  models: [{ id: 'amr-model', label: 'AMR Model' }],
};

function firstRunConfig(): AppConfig {
  return {
    // Prove the explicit cloud choice also switches a saved BYOK mode.
    mode: 'api',
    apiKey: '',
    apiProtocol: 'anthropic',
    apiVersion: '',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-sonnet-4-5',
    apiProviderBaseUrl: 'https://api.anthropic.com',
    apiProtocolConfigs: {},
    agentId: null,
    skillId: null,
    designSystemId: null,
    onboardingCompleted: false,
    privacyDecisionAt: 1,
    mediaProviders: {},
    composio: {},
    agentModels: {},
    agentCliEnv: {},
  } as AppConfig;
}

beforeEach(() => {
  // jsdom polyfills the full EntryView tree expects.
  if (!window.matchMedia) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }
  const win = window as unknown as Record<string, unknown>;
  win.ResizeObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  win.IntersectionObserver ||= class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() {
      return [];
    }
  };
  window.scrollTo = window.scrollTo || (() => {});
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();

  mockedDaemonIsLive.mockResolvedValue(true);
  mockedFetchAgentsStream.mockReset();
  mockedFetchAgentsStream.mockResolvedValue([{ ...amrAgent }, { ...claudeAgent }]);
  mockedFetchSkills.mockResolvedValue([]);
  mockedFetchDesignSystems.mockResolvedValue([]);
  mockedFetchDesignTemplates.mockResolvedValue([]);
  mockedFetchPromptTemplates.mockResolvedValue([]);
  mockedFetchAppVersionInfo.mockResolvedValue(null);
  mockedListProjects.mockResolvedValue([]);
  mockedListTemplates.mockResolvedValue([]);
  mockedFetchAmrModels.mockResolvedValue({
    source: 'preset',
    refreshing: false,
    models: [{ id: 'amr-model', label: 'AMR Model' }],
  });
  mockedLoadConfig.mockReturnValue(firstRunConfig());
  mockedFetchDaemonConfig.mockResolvedValue({});

  // The onboarding + inline switcher poll the vela login status; report a
  // signed-in account so the AMR runtime is fully selectable.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const json = url.includes('/api/integrations/vela/status')
        ? {
            loggedIn: true,
            profile: 'prod',
            user: { id: 'u', email: 'user@example.com' },
            configPath: '/x',
          }
        : {};
      return new Response(JSON.stringify(json), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  analyticsMocks.track.mockReset();
});

describe('onboarding -> home AMR selection (end to end)', () => {
  it('preserves an explicit AMR choice when its first detection trails Claude', async () => {
    let emitAgent: ((agent: AgentInfo) => void) | undefined;
    let finishProbe: ((agents: AgentInfo[]) => void) | undefined;
    mockedFetchAgentsStream.mockImplementationOnce(({ onAgent }) => {
      emitAgent = onAgent;
      return new Promise<AgentInfo[]>((resolve) => {
        finishProbe = resolve;
      });
    });

    render(<App />);
    await waitFor(() => {
      expect(emitAgent).toBeTypeOf('function');
    });

    // Keep one SSE probe open while Claude settles first. The cloud sign-in
    // control must stay hidden until an available AMR runtime is detected.
    await act(async () => {
      emitAgent!({ ...claudeAgent });
    });
    await waitFor(() => {
      expect(window.location.pathname).toBe('/onboarding');
    });
    expect(screen.queryByRole('button', { name: /Continue \(signed in\)/i })).toBeNull();
    expect(vi.mocked(saveConfig).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);
    expect(vi.mocked(syncConfigToDaemon).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);

    // The late AMR event and the terminal done are distinct stream phases.
    await act(async () => {
      emitAgent!({ ...amrAgent });
    });
    await act(async () => {
      finishProbe!([{ ...claudeAgent }, { ...amrAgent }]);
    });

    const runtimeContinue = await screen.findByRole('button', {
      name: /Continue \(signed in\)/i,
    });
    expect((runtimeContinue as HTMLButtonElement).disabled).toBe(false);
    // Detection is complete now: only the onboarding route guard prevents
    // the App fallback from persisting Claude before the user chooses AMR.
    expect(vi.mocked(saveConfig).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);
    expect(vi.mocked(syncConfigToDaemon).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);
    fireEvent.click(runtimeContinue);

    // AMR was unavailable when this view mounted, so the source starts local.
    // Verify that state before choosing AMR; availability must not fake a pick.
    const cloudSource = await screen.findByRole('radio', { name: /AMR cloud/i });
    const localSource = screen.getByRole('radio', { name: /Local Agent/i });
    expect(localSource.getAttribute('aria-checked')).toBe('true');
    expect(cloudSource.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(cloudSource);
    expect(cloudSource.getAttribute('aria-checked')).toBe('true');
    const writesBeforeChoice = vi.mocked(saveConfig).mock.calls.length;
    const syncsBeforeChoice = vi.mocked(syncConfigToDaemon).mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: /^Continue$/i }));

    await waitFor(() => {
      const chip = screen.getByTestId('inline-model-switcher-chip');
      expect(chip.getAttribute('aria-label') ?? '').toContain('Mishh Mashh');
      expect(chip.getAttribute('aria-label') ?? '').toContain('AMR Model');
      expect(chip.getAttribute('aria-label') ?? '').not.toContain('Claude');
      expect(window.location.pathname).toBe('/');
    });

    // The config written by selection and the config written by completion
    // must both retain the exact provider identity, regardless of display copy.
    const selectedWrites = vi.mocked(saveConfig).mock.calls.slice(writesBeforeChoice);
    const selectedSyncs = vi.mocked(syncConfigToDaemon).mock.calls.slice(syncsBeforeChoice);
    const firstAmrWrite = selectedWrites.findIndex(([cfg]) => cfg.agentId === 'amr');
    expect(firstAmrWrite).toBeGreaterThanOrEqual(0);
    const amrWrites = selectedWrites.slice(firstAmrWrite);
    expect(amrWrites.length).toBeGreaterThanOrEqual(2);
    expect(vi.mocked(saveConfig).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);
    expect(vi.mocked(syncConfigToDaemon).mock.calls.some(([cfg]) => cfg.agentId === 'claude')).toBe(false);
    expect(selectedSyncs.length).toBeGreaterThanOrEqual(2);
    expect(amrWrites.every(([cfg]) => cfg.mode === 'daemon' && cfg.agentId === 'amr')).toBe(true);
    expect(selectedSyncs.every(([cfg]) => cfg.mode === 'daemon' && cfg.agentId === 'amr')).toBe(true);
    expect(selectedWrites.at(-1)?.[0]).toMatchObject({
      agentId: 'amr',
      onboardingCompleted: true,
    });
    expect(selectedSyncs.at(-1)?.[0]).toMatchObject({
      agentId: 'amr',
      onboardingCompleted: true,
    });
    expect(mockedFetchAgentsStream).toHaveBeenCalledTimes(1);
  });
});
