// @vitest-environment jsdom
//
// The picker opens on the Agent / Provider tab when the current agent has no
// model catalog yet. A change the user makes on that tab (switching mode,
// picking an agent) can give the Model tab content. That change must not move
// the user off the tab they are working in: the agent list they were about to
// click would be inside a `hidden` tabpanel and could not be clicked. The
// Canvas composer of the model-picker roundtrip e2e (a new conversation with
// no model draft) hit exactly this: `inline-model-switcher-agent-claude`
// resolved but was "not visible" for two minutes.

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/analytics/provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/analytics/provider')>();
  return {
    ...actual,
    useAnalytics: () => ({
      track: vi.fn(),
      setConsent: vi.fn(),
      setIdentity: vi.fn(),
      setConfigureGlobals: vi.fn(),
      setUserId: vi.fn(),
      anonymousId: 'test-anonymous-id',
      sessionId: 'test-session-id',
      newRequestId: () => 'test-request-id',
    }),
  };
});

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(),
}));

afterEach(() => {
  cleanup();
  resetWorkspaceContextCache();
});

const claude: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ],
};

/** An installed agent that publishes no model catalog. */
const bare: AgentInfo = { id: 'codex', name: 'Codex CLI', bin: 'codex', available: true, version: '1.0.0', models: [] };

const baseConfig: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'openai',
  apiVersion: '',
  baseUrl: 'https://api.openai.com/v1',
  model: 'gpt-5',
  apiProviderBaseUrl: 'https://api.openai.com/v1',
  apiProtocolConfigs: {},
  agentId: 'codex',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
};

/** A parent that applies the user's choices, like Home and the Canvas composer do. */
function Harness() {
  const [config, setConfig] = useState<AppConfig>(baseConfig);
  return (
    <InlineModelSwitcher
      config={config}
      agents={[bare, claude]}
      providerModelsCache={{}}
      compact
      showExecutionOptions
      daemonLive
      onModeChange={(mode) => setConfig((c) => ({ ...c, mode }))}
      onAgentChange={(agentId) => setConfig((c) => ({ ...c, agentId }))}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
}

function sourcePanel(): HTMLElement {
  return screen.getByTestId('inline-model-switcher-panel-source');
}

function openOnSourceTab() {
  render(<Harness />);
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  // No catalog for the current agent, so the card opens on Agent / Provider.
  expect(screen.getByTestId('inline-model-switcher-tab-source').getAttribute('aria-selected')).toBe('true');
  expect(sourcePanel().hidden).toBe(false);
}

describe('InlineModelSwitcher: a change on the Agent / Provider tab keeps that tab open', () => {
  it('picking an agent that has a catalog leaves the agent list visible', () => {
    openOnSourceTab();
    fireEvent.click(screen.getByTestId('inline-model-switcher-agent-claude'));
    expect(screen.getByTestId('inline-model-switcher-agent-claude').getAttribute('aria-checked')).toBe('true');
    expect(screen.getByTestId('inline-model-switcher-tab-source').getAttribute('aria-selected')).toBe('true');
    expect(sourcePanel().hidden).toBe(false);
    expect(sourcePanel().contains(screen.getByTestId('inline-model-switcher-agent-claude'))).toBe(true);
  });

  it('switching to BYOK leaves the provider chips visible', () => {
    openOnSourceTab();
    fireEvent.click(screen.getByTestId('inline-model-switcher-mode-api'));
    expect(screen.getByTestId('inline-model-switcher-tab-source').getAttribute('aria-selected')).toBe('true');
    expect(sourcePanel().hidden).toBe(false);
    expect(sourcePanel().contains(screen.getByTestId('inline-model-switcher-provider-openai'))).toBe(true);
  });

  it('still follows the catalog when it arrives before the user does anything', () => {
    const { rerender } = render(
      <InlineModelSwitcher
        config={{ ...baseConfig, agentId: 'claude' }}
        agents={[bare]}
        providerModelsCache={{}}
        compact
        showExecutionOptions
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
    expect(screen.getByTestId('inline-model-switcher-tab-source').getAttribute('aria-selected')).toBe('true');
    rerender(
      <InlineModelSwitcher
        config={{ ...baseConfig, agentId: 'claude' }}
        agents={[bare, claude]}
        providerModelsCache={{}}
        compact
        showExecutionOptions
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    expect(screen.getByTestId('inline-model-switcher-tab-model').getAttribute('aria-selected')).toBe('true');
  });
});
