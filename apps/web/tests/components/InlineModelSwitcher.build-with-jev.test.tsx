// @vitest-environment jsdom
//
// The Home model picker's pinned "Build with Jev" row: a mode, not a provider model. It sits above
// the models, selecting it switches Home into the agency fast lane, the chip names it while it is
// on, and picking a real model, an execution mode or a BYOK provider turns it off. Surfaces that
// pass no `buildWithJev` never show it.

import { useState } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import type { AgentInfo, AppConfig } from '../../src/types';

vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

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
  agentModels: {},
  agentCliEnv: {},
};

const claude: AgentInfo = {
  id: 'claude',
  name: 'Claude Code',
  bin: 'claude',
  available: true,
  version: '2.0.0',
  models: [
    { id: 'sonnet', label: 'sonnet', default: true },
    { id: 'opus', label: 'opus' },
  ],
};

function Harness({
  initial = false,
  onChange,
  compact = true,
  mode = 'daemon',
}: {
  initial?: boolean;
  onChange?: (active: boolean) => void;
  compact?: boolean;
  mode?: AppConfig['mode'];
}) {
  const [active, setActive] = useState(initial);
  return (
    <InlineModelSwitcher
      compact={compact}
      config={{ ...config, mode }}
      agents={[claude]}
      providerModelsCache={{}}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()}
      onApiModelChange={vi.fn()}
      onOpenSettings={vi.fn()}
      buildWithJev={{
        active,
        onChange: (next) => {
          onChange?.(next);
          setActive(next);
        },
      }}
    />
  );
}

function open(): HTMLElement {
  fireEvent.click(screen.getByTestId('inline-model-switcher-chip'));
  return screen.getByTestId('inline-model-switcher-popover');
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('InlineModelSwitcher — Build with Jev', () => {
  it('pins "Build with Jev" above the models and selects it', () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    const popover = open();

    // Pinned first in the popover, as a toggle button — not a second radiogroup.
    const pinned = popover.querySelector('button');
    expect(pinned?.getAttribute('data-testid')).toBe('inline-model-switcher-build-with-jev');
    expect(pinned?.getAttribute('aria-label')).toBe('Build with Jev');
    expect(pinned?.getAttribute('aria-pressed')).toBe('false');
    expect(popover.querySelectorAll('[role="radiogroup"]')).toHaveLength(1);

    fireEvent.click(screen.getByTestId('inline-model-switcher-build-with-jev'));
    expect(onChange).toHaveBeenCalledWith(true);
    expect(screen.queryByTestId('inline-model-switcher-popover')).toBeNull();
    expect(screen.getByTestId('inline-model-switcher-chip').textContent).toContain('Build with Jev');
  });

  it('turns the mode off when a model is picked', () => {
    const onChange = vi.fn();
    render(<Harness initial onChange={onChange} />);
    open();
    expect(screen.getByTestId('inline-model-switcher-build-with-jev').getAttribute('aria-pressed')).toBe('true');
    // While the mode is on, no model row claims to be the selection.
    expect(screen.getByTestId('inline-model-switcher-compact-model-sonnet').getAttribute('aria-checked')).toBe('false');

    fireEvent.click(screen.getByTestId('inline-model-switcher-compact-model-opus'));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('inline-model-switcher-chip').textContent).not.toContain('Build with Jev');
  });

  it.each([
    ['the BYOK execution mode', 'daemon', 'inline-model-switcher-mode-api'],
    ['the local CLI execution mode', 'api', 'inline-model-switcher-mode-daemon'],
    ['another BYOK provider', 'api', 'inline-model-switcher-provider-openai'],
  ] as const)('turns the mode off when %s is picked', (_label, mode, testId) => {
    // The full popover (not Home's compact one) also offers the execution mode and the BYOK
    // provider. Either is a configuration choice, so the chip must stop naming Build with Jev.
    const onChange = vi.fn();
    render(<Harness initial compact={false} mode={mode} onChange={onChange} />);
    expect(screen.getByTestId('inline-model-switcher-chip').textContent).toContain('Build with Jev');
    open();
    fireEvent.click(screen.getByTestId(testId));
    expect(onChange).toHaveBeenCalledWith(false);
    expect(screen.getByTestId('inline-model-switcher-chip').textContent).not.toContain('Build with Jev');
  });

  it('is absent where the host offers no Build with Jev mode', () => {
    render(
      <InlineModelSwitcher
        compact
        config={config}
        agents={[claude]}
        providerModelsCache={{}}
        daemonLive
        onModeChange={vi.fn()}
        onAgentChange={vi.fn()}
        onAgentModelChange={vi.fn()}
        onApiProtocolChange={vi.fn()}
        onApiModelChange={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );
    open();
    expect(screen.queryByTestId('inline-model-switcher-build-with-jev')).toBeNull();
  });
});
