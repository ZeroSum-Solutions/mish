// @vitest-environment jsdom
//
// AC-R02.3: the compact model list badges a row the caller's preflight check
// marked as unable to take the currently staged attachment(s). The switcher
// never computes this itself (see `InlineModelSwitcherAttachmentWarning`'s
// doc comment) — these specs exercise only the rendering contract: a row
// named in `unsupportedModelIds` gets a visible+readable reason and every
// other row is unaffected, including with the prop entirely omitted.

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

const baseConfig: AppConfig = {
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
  agentModels: {},
  agentCliEnv: {},
};

const agent: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '1.0.0',
  models: [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', default: true },
    { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  ],
};

function renderSwitcher(attachmentWarning?: { unsupportedModelIds: ReadonlySet<string>; reason: string }) {
  render(
    <InlineModelSwitcher
      config={baseConfig}
      agents={[agent]}
      providerModelsCache={{}}
      compact
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
      attachmentWarning={attachmentWarning}
    />,
  );
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

afterEach(cleanup);

it('renders no attachment badge on any row when the prop is omitted', () => {
  const popover = renderSwitcher();
  expect(within(popover).queryByTestId('inline-model-switcher-compact-model-attachment-warning-claude-sonnet-5-5')).toBeNull();
  expect(within(popover).queryByTestId('inline-model-switcher-compact-model-attachment-warning-claude-opus-5-5')).toBeNull();
});

it('badges exactly the row named in unsupportedModelIds with a readable reason, leaving it clickable', () => {
  const reason = "Claude Code can't receive image attachments (brief.png). Remove them or choose a different model.";
  const popover = renderSwitcher({ unsupportedModelIds: new Set(['claude-sonnet-5-5']), reason });
  const badge = within(popover).getByTestId('inline-model-switcher-compact-model-attachment-warning-claude-sonnet-5-5');
  expect(badge.textContent).toContain(reason);
  expect(badge.title).toBe(reason);
  expect(within(popover).queryByTestId('inline-model-switcher-compact-model-attachment-warning-claude-opus-5-5')).toBeNull();
  // Still a normal, selectable row — the badge warns, it does not lock.
  const row = screen.getByTestId('inline-model-switcher-compact-model-claude-sonnet-5-5');
  expect(row.getAttribute('aria-disabled')).not.toBe('true');
});
