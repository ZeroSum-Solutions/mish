// @vitest-environment jsdom
//
// Red spec for the onboarding Local Agent picker losing a click to an
// in-flight rescan (QA sweep2 j1-prototype-and-clone, P1: clicking "Claude
// Code" silently stayed on "DeepSeek TUI"). The picker selects by agent id,
// but `scanCliAgents`'s async continuation closed over `config.agentId` from
// whichever render started the rescan — a snapshot that goes stale the
// instant the user picks a different agent while that rescan is still
// awaiting `onRefreshAgents()`. On resolve, the stale snapshot (not found in
// the fresh list) fell back to the list's first entry and silently
// overwrote the user's live choice.

import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { EntryShell } from '../../src/components/EntryShell';
import { I18nProvider } from '../../src/i18n';
import type { AgentInfo, AppConfig } from '../../src/types';

const originalFetch = globalThis.fetch;
const originalResizeObserver = globalThis.ResizeObserver;

class ResizeObserverMock {
  observe() {}
  disconnect() {}
  unobserve() {}
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function agent(overrides: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id: 'deepseek-tui',
    name: 'DeepSeek TUI',
    bin: 'deepseek-tui',
    available: true,
    version: '1.0.0',
    models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    ...overrides,
  };
}

function baseConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    mode: 'daemon',
    agentId: null,
    agentModels: {},
    apiProtocol: 'anthropic',
    apiProtocolConfigs: {},
    apiKey: '',
    baseUrl: '',
    model: '',
    ...overrides,
  } as AppConfig;
}

// A render harness that wires `onAgentChange` into live `config` state the
// way the real app (`App.tsx`'s `handleAgentChange`) does: an unconditional,
// immediate `setConfig`. The shared suite's `renderOnboarding` only threads
// `onConfigPersist` back into state, so it never exercises this path — the
// bug lives entirely in the gap between a live `onAgentChange` and a stale
// async read of `config.agentId`.
function renderOnboardingWithLiveAgentSelection(
  overrides: Partial<React.ComponentProps<typeof EntryShell>> = {},
) {
  window.history.replaceState(null, '', '/onboarding');
  const props: React.ComponentProps<typeof EntryShell> = {
    skills: [],
    designTemplates: [],
    designSystems: [],
    projects: [],
    templates: [],
    promptTemplates: [],
    defaultDesignSystemId: null,
    connectors: [],
    connectorsLoading: false,
    config: baseConfig(),
    agents: [],
    daemonLive: true,
    onModeChange: vi.fn(),
    onAgentChange: vi.fn(),
    onAgentModelChange: vi.fn(),
    onApiProtocolChange: vi.fn(),
    onApiModelChange: vi.fn(),
    onConfigPersist: vi.fn(),
    onRefreshAgents: vi.fn(() => []),
    onCreateProject: vi.fn(),
    onImportClaudeDesign: vi.fn(),
    onOpenProject: vi.fn(),
    onOpenLiveArtifact: vi.fn(),
    onDeleteProject: vi.fn(),
    onRenameProject: vi.fn(),
    onChangeDefaultDesignSystem: vi.fn(),
    onPersistComposioKey: vi.fn(),
    onOpenSettings: vi.fn(),
    onCompleteOnboarding: vi.fn(),
    ...overrides,
  };

  function Harness() {
    const [config, setConfig] = useState(props.config);
    return (
      <I18nProvider initial="en">
        <EntryShell
          {...props}
          config={config}
          onAgentChange={(id) => {
            props.onAgentChange(id);
            setConfig((current) => ({ ...current, agentId: id }));
          }}
          onModeChange={(mode) => {
            props.onModeChange(mode);
            setConfig((current) => ({ ...current, mode }));
          }}
        />
      </I18nProvider>
    );
  }

  render(<Harness />);
  return props;
}

beforeEach(() => {
  globalThis.fetch = vi.fn(async () =>
    jsonResponse({ loggedIn: false, profile: 'prod', user: null, configPath: '/x' }),
  ) as typeof fetch;
  globalThis.ResizeObserver = ResizeObserverMock as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  globalThis.ResizeObserver = originalResizeObserver;
  vi.restoreAllMocks();
});

describe('EntryShell onboarding Local CLI picker — rescan race', () => {
  it('keeps the agent the user clicked, even when an in-flight rescan resolves afterward', async () => {
    const deepseekTui = agent({ id: 'deepseek-tui', name: 'DeepSeek TUI' });
    const claudeCode = agent({
      id: 'claude-code',
      name: 'Claude Code',
      bin: 'claude',
      models: [{ id: 'sonnet', label: 'Sonnet' }],
    });
    // The rescan's fresh result: the previously-selected agent (deepseek-tui)
    // no longer available, a brand-new agent now first in the list, and
    // claude-code still there. A correct picker keeps whatever the user
    // clicked (claude-code); the stale-closure bug falls back to the first
    // agent in this fresh list (codex) because its captured snapshot
    // ('deepseek-tui') can no longer be found in it.
    const codex = agent({ id: 'codex', name: 'Codex', bin: 'codex' });

    let releaseRescan!: (agents: AgentInfo[]) => void;
    const rescanPromise = new Promise<AgentInfo[]>((resolve) => {
      releaseRescan = resolve;
    });
    const onRefreshAgents = vi.fn(() => rescanPromise);

    const props = renderOnboardingWithLiveAgentSelection({
      agents: [deepseekTui, claudeCode],
      agentsLoading: false,
      onRefreshAgents,
    });

    // Reach the Local CLI step. With no AMR agent detected, onboarding lands
    // on a chooser whose Local Agent button starts the local step directly.
    expect(
      await screen.findByRole('heading', { name: 'Choose your model source' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Local Agent/i }));
    expect(await screen.findByText('Local CLI')).toBeTruthy();

    // Both agents already existed, so entering the step auto-picked the
    // first one — DeepSeek TUI — exactly like the QA repro's starting state.
    expect(props.onAgentChange).toHaveBeenLastCalledWith('deepseek-tui');
    expect(
      screen.getByRole('button', { name: /Claude Code/i }).getAttribute('aria-pressed'),
    ).toBe('false');

    // Start the async rescan.
    fireEvent.click(screen.getByRole('button', { name: /Rescan/i }));
    expect(onRefreshAgents).toHaveBeenCalledTimes(1);

    // While the rescan is still in flight, the user clicks Claude Code.
    const claudeChip = screen.getByRole('button', { name: /Claude Code/i });
    fireEvent.click(claudeChip);
    expect(props.onAgentChange).toHaveBeenLastCalledWith('claude-code');
    expect(claudeChip.getAttribute('aria-pressed')).toBe('true');

    // The rescan now resolves with a fresh, changed agent list.
    await act(async () => {
      releaseRescan([codex, claudeCode, { ...deepseekTui, available: false }]);
      await rescanPromise;
      await Promise.resolve();
    });

    // The user's click must win: Claude Code stays selected. The bug
    // overwrites it with `codex` (the fresh list's first entry) because the
    // rescan's stale closure never saw the live 'claude-code' pick.
    expect(props.onAgentChange).toHaveBeenLastCalledWith('claude-code');
    expect(
      screen.getByRole('button', { name: /Claude Code/i }).getAttribute('aria-pressed'),
    ).toBe('true');
  });
});
