// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher, stepTablistKey } from '../../src/components/InlineModelSwitcher';
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

const claude: AgentInfo = {
  id: 'claude',
  name: 'Claude',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ],
};

const config: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'claude',
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: { claude: { model: 'claude-sonnet-5-5' } },
  agentCliEnv: {},
};

function renderSwitcher(dir?: 'rtl') {
  const switcher = (
    <InlineModelSwitcher
      config={config}
      agents={[claude]}
      providerModelsCache={{}}
      compact
      showExecutionOptions
      preserveRequestedModel
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
    />
  );
  render(
    <>
      <button type="button">Outside</button>
      {dir ? <div dir={dir}>{switcher}</div> : switcher}
    </>,
  );
  return screen.getByTestId('inline-model-switcher-chip');
}

function openWithFocusInside(chip: HTMLElement) {
  chip.focus();
  fireEvent.click(chip);
  const popover = screen.getByTestId('inline-model-switcher-popover');
  const tab = within(popover).getByRole('tab', { name: /Model/ });
  tab.focus();
  expect(popover.contains(document.activeElement)).toBe(true);
  return popover;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  resetWorkspaceContextCache();
});

describe('InlineModelSwitcher focus return', () => {
  it('returns focus to the chip when Escape closes the card', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const chip = renderSwitcher();
    openWithFocusInside(chip);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('returns focus to the chip after an outside click on a non-focusable area', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const chip = renderSwitcher();
    openWithFocusInside(chip);

    fireEvent.mouseDown(document.body);

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(document.activeElement).toBe(chip);
  });

  it('does not steal focus from another control the user moved to', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const chip = renderSwitcher();
    openWithFocusInside(chip);
    const outside = screen.getByRole('button', { name: 'Outside' });

    outside.focus();
    fireEvent.mouseDown(outside);

    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(document.activeElement).toBe(outside);
  });

  it('flips ArrowLeft and ArrowRight between the tabs in a right-to-left layout', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})));
    const chip = renderSwitcher('rtl');
    fireEvent.click(chip);
    const modelTab = screen.getByRole('tab', { name: /Model/ });
    expect(modelTab.getAttribute('aria-selected')).toBe('true');

    // In RTL the Agent tab sits to the LEFT of Model, so ArrowLeft moves to it.
    fireEvent.keyDown(modelTab, { key: 'ArrowLeft' });
    const agentTab = screen.getByRole('tab', { name: /Agent/ });
    expect(agentTab.getAttribute('aria-selected')).toBe('true');

    fireEvent.keyDown(agentTab, { key: 'ArrowRight' });
    expect(screen.getByRole('tab', { name: /Model/ }).getAttribute('aria-selected')).toBe('true');
  });
});

// With two wrapping tabs both arrows reach the other tab, so the direction
// flip is pinned on the shared step helper with three tabs.
describe('stepTablistKey', () => {
  const order = ['a', 'b', 'c'] as const;
  it('steps forward on ArrowRight and back on ArrowLeft in left-to-right layouts', () => {
    expect(stepTablistKey(order, 'b', 'ArrowRight', false)).toBe('c');
    expect(stepTablistKey(order, 'b', 'ArrowLeft', false)).toBe('a');
    expect(stepTablistKey(order, 'c', 'ArrowRight', false)).toBe('a');
  });
  it('flips the arrows in right-to-left layouts', () => {
    expect(stepTablistKey(order, 'b', 'ArrowLeft', true)).toBe('c');
    expect(stepTablistKey(order, 'b', 'ArrowRight', true)).toBe('a');
    expect(stepTablistKey(order, 'a', 'ArrowRight', true)).toBe('c');
  });
  it('jumps with Home and End and ignores other keys', () => {
    expect(stepTablistKey(order, 'b', 'Home', true)).toBe('a');
    expect(stepTablistKey(order, 'b', 'End', false)).toBe('c');
    expect(stepTablistKey(order, 'b', 'Enter', false)).toBeNull();
  });
});
