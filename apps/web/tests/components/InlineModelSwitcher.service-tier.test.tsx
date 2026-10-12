// @vitest-environment jsdom
import { useState } from 'react';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { useHomeModel } from '../../src/runtime/workbench/use-home-model';
import { useSessionModel } from '../../src/runtime/workbench/use-session-model';
import { DEFAULT_CONFIG } from '../../src/state/config';
import { resetWorkspaceContextCache } from '../../src/collab/useWorkspaceContext';
import type { AgentInfo, AppConfig } from '../../src/types';
import { parsePutSessionModel, sessionModelChoicesEqual } from '@open-design/contracts';
import { putSessionModel } from '../../src/providers/workbench';
import { getSessionModelFixture, putSessionModelFixture, resetSessionModelApiFixture } from '../fixtures/session-model-api';

vi.mock('../../src/providers/workbench', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/providers/workbench')>();
  const fixture = await import('../fixtures/session-model-api');
  return {
    ...actual, getSessionModel: fixture.getSessionModelFixture, putSessionModel: vi.fn(fixture.putSessionModelFixture),
    // AC-R02.3 select-time gate: every picker selection in this file is
    // expected to be a GOOD one — this suite covers service-tier/reasoning
    // picker wiring, not capability mismatches.
    postModelPreflight: vi.fn(async (_sessionId: string, _projectId: string, input: { agentId: string; modelId: string }) =>
      ({ agentId: input.agentId, modelId: input.modelId, ok: true, mismatches: [] })),
  };
});
vi.mock('../../src/providers/provider-models', () => ({
  fetchProviderModels: vi.fn(async () => ({ ok: false, models: [] })),
}));

const defaults: AppConfig = {
  ...DEFAULT_CONFIG, agentId: 'codex', model: 'byok-model',
  agentModels: { codex: { model: 'gpt-5.5', reasoning: 'high' } },
};
const codex: AgentInfo = {
  id: 'codex', name: 'Codex CLI', bin: 'codex', available: true,
  reasoningOptions: [{ id: 'default', label: 'Default' }],
  models: [
    { id: 'gpt-5.5', label: 'GPT 5.5', serviceTierOptions: [{ id: 'priority', label: 'Fast' }],
      reasoningOptions: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High', default: true }] },
    { id: 'default', label: 'Default' },
  ],
};

function Picker({ host, conversation = false, agent = codex }: {
  host: ReturnType<typeof useHomeModel>; conversation?: boolean; agent?: AgentInfo;
}) {
  return <>
    <InlineModelSwitcher {...host} agents={[agent]} compact daemonLive
      showExecutionOptions={conversation} preserveRequestedModel={conversation}
      onOpenSettings={vi.fn()} />
    <output data-testid="choice">{JSON.stringify(host.config.agentModels?.codex)}</output>
    <output data-testid="byok-model">{host.config.model}</output>
  </>;
}
function Home() { return <Picker host={useHomeModel(defaults, null)} />; }
function Conversation({ initialConfig = defaults, agent = codex }: {
  initialConfig?: AppConfig; agent?: AgentInfo;
}) {
  const host = useSessionModel(initialConfig, 'tier-project', 'tier-session', null);
  const [execution, setExecution] = useState<AppConfig | null>(null);
  return <>
    <Picker host={{ ...host, choice: () => host.state.choice, error: host.state.error }} conversation agent={agent} />
    <button onClick={async () => setExecution(host.executionConfig(await host.ensureSaved()))}>Capture next run</button>
    <output data-testid="execution">{JSON.stringify(execution?.agentModels?.codex)}</output>
  </>;
}
function open() { fireEvent.click(screen.getByTestId('inline-model-switcher-chip')); }
function choice() { return JSON.parse(screen.getByTestId('choice').textContent!); }

beforeEach(() => {
  sessionStorage.clear(); resetSessionModelApiFixture(); resetWorkspaceContextCache();
  vi.mocked(putSessionModel).mockReset().mockImplementation(putSessionModelFixture);
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe('InlineModelSwitcher reasoning', () => {
  it('lets Home change advertised reasoning without replacing the model, tier or Settings', () => {
    render(<Home />); open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Service tier' }), { target: { value: 'priority' } });
    const reasoning = screen.getByRole('combobox', { name: 'Reasoning' });
    expect(within(reasoning).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['low', 'high']);
    expect(reasoning).toHaveValue('high');
    fireEvent.change(reasoning, { target: { value: 'low' } });
    expect(choice()).toEqual({ model: 'gpt-5.5', reasoning: 'low', serviceTier: 'priority' });
    fireEvent.keyDown(document, { key: 'Escape' }); open();
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveValue('low');
    expect(defaults.agentModels?.codex).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
    expect(screen.getByTestId('byok-model')).toHaveTextContent('byok-model');
  });

  it('carries the conversation reasoning edit through the saved pair and next-run projection', async () => {
    // The daemon returns the current snapshot for an unchanged canonical pair.
    vi.mocked(putSessionModel).mockImplementation(async (sessionId, projectId, input, context) => {
      const { expectedRevision, ...nextChoice } = parsePutSessionModel(input);
      const current = await getSessionModelFixture(sessionId, projectId, context);
      if (expectedRevision <= current.revision && sessionModelChoicesEqual(current.choice, nextChoice)) return current;
      return putSessionModelFixture(sessionId, projectId, input, context);
    });
    render(<Conversation />); open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning' }), { target: { value: 'low' } });
    await waitFor(async () => expect(await getSessionModelFixture('tier-session', 'tier-project')).toMatchObject({
      revision: 1, choice: { agentId: 'codex', modelId: 'gpt-5.5' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual({ model: 'gpt-5.5', reasoning: 'low' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Reasoning' }), { target: { value: 'high' } });
    await waitFor(() => expect(vi.mocked(putSessionModel)).toHaveBeenCalledTimes(2));
    expect(vi.mocked(putSessionModel).mock.calls[1]?.[2]).toEqual({
      expectedRevision: 1, agentId: 'codex', modelId: 'gpt-5.5',
    });
    expect(await getSessionModelFixture('tier-session', 'tier-project')).toMatchObject({
      revision: 1, choice: { agentId: 'codex', modelId: 'gpt-5.5' },
    });
    expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual({ model: 'gpt-5.5', reasoning: 'low' });
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual({ model: 'gpt-5.5', reasoning: 'high' }));
    expect((await getSessionModelFixture('tier-session', 'tier-project')).revision).toBe(1);
    expect(screen.getByTestId('byok-model')).toHaveTextContent('byok-model');
    expect(defaults.agentModels?.codex).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
  });

  it.each([
    { label: 'unsupported', options: [{ id: 'high', label: 'High', default: true }], retained: false },
    { label: 'disabled', options: [{ id: 'high', label: 'High', default: true }, { id: 'xhigh', label: 'Extra high', enabled: false }], retained: false },
    { label: 'explicitly empty', options: [], retained: false },
    { label: 'supported', options: [{ id: 'xhigh', label: 'Extra high' }], retained: true },
    { label: 'agent fallback', options: undefined, retained: true },
  ])('filters $label reasoning during an explicit conversation model pick', async ({ options, retained }) => {
    const initialConfig: AppConfig = { ...defaults, agentModels: {
      codex: { model: 'gpt-5.5', reasoning: 'xhigh', serviceTier: 'priority' },
    } };
    const agent: AgentInfo = { ...codex,
      reasoningOptions: [{ id: 'xhigh', label: 'Extra high' }],
      models: [
        { ...codex.models![0]!, reasoningOptions: [{ id: 'xhigh', label: 'Extra high' }] },
        { id: 'gpt-5.5-mini', label: 'GPT 5.5 Mini', reasoningOptions: options },
      ],
    };
    render(<Conversation initialConfig={initialConfig} agent={agent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual(initialConfig.agentModels!.codex));
    open();
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveValue('xhigh');
    expect(vi.mocked(putSessionModel)).toHaveBeenCalledTimes(1);
    fireEvent.click(within(screen.getByTestId('inline-model-switcher-agent-model-popover'))
      .getByRole('option', { name: /GPT 5.5 Mini/ }));
    await waitFor(async () => expect(await getSessionModelFixture('tier-session', 'tier-project')).toMatchObject({
      revision: 2, choice: { agentId: 'codex', modelId: 'gpt-5.5-mini' },
    }));
    const expected = { model: 'gpt-5.5-mini', ...(retained ? { reasoning: 'xhigh' } : {}) };
    expect(choice()).toEqual(expected);
    expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual(initialConfig.agentModels!.codex);
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual(expected));
    expect(initialConfig.agentModels!.codex).toEqual({ model: 'gpt-5.5', reasoning: 'xhigh', serviceTier: 'priority' });
    expect(screen.getByTestId('byok-model')).toHaveTextContent('byok-model');
  });

  it.each([undefined, 'unadvertised'])('uses the model-marked default for %s reasoning without writing a replacement', (reasoning) => {
    const onChange = vi.fn();
    render(<InlineModelSwitcher config={{ ...defaults, agentModels: { codex: { model: 'gpt-5.5', reasoning } } }}
      agents={[codex]} compact daemonLive preserveRequestedModel
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={onChange}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    open();
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveValue('high');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses agent-level reasoning only when the selected model has no reasoning declaration', () => {
    const { rerender } = render(<InlineModelSwitcher config={{ ...defaults, agentModels: { codex: { model: 'default' } } }}
      agents={[codex]} compact daemonLive preserveRequestedModel
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    open();
    expect(screen.getByRole('combobox', { name: 'Reasoning' })).toHaveValue('default');
    const noReasoning = { ...codex, models: codex.models?.map(model => ({ ...model, reasoningOptions: [] })) };
    rerender(<InlineModelSwitcher config={defaults} agents={[noReasoning]} compact daemonLive preserveRequestedModel
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    expect(screen.queryByRole('combobox', { name: 'Reasoning' })).toBeNull();
  });

  it('does not expose the dormant native reasoning choices in BYOK mode', () => {
    render(<InlineModelSwitcher config={{ ...defaults, mode: 'api' }} agents={[codex]} compact daemonLive
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    open(); expect(screen.queryByRole('combobox', { name: 'Reasoning' })).toBeNull();
  });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('InlineModelSwitcher service tier', () => {
  it('lets Home select and clear the advertised tier without changing model, reasoning or Settings', () => {
    render(<Home />); open();
    const tier = screen.getByRole('combobox', { name: 'Service tier' });
    expect(within(tier).getAllByRole('option').map(option => option.getAttribute('value'))).toEqual(['default', 'priority']);
    fireEvent.change(tier, { target: { value: 'priority' } });
    expect(choice()).toEqual({ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'priority' });
    fireEvent.keyDown(document, { key: 'Escape' }); open();
    expect(screen.getByRole('combobox', { name: 'Service tier' })).toHaveValue('priority');
    fireEvent.change(screen.getByRole('combobox', { name: 'Service tier' }), { target: { value: 'default' } });
    expect(choice()).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
    expect(screen.getByTestId('byok-model')).toHaveTextContent('byok-model');
    expect(defaults.agentModels?.codex).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
  });

  it('carries priority through the real conversation callback, saved pair and next-run projection', async () => {
    render(<Conversation />);
    await waitFor(() => expect(screen.getByTestId('choice')).toHaveTextContent('gpt-5.5'));
    open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Service tier' }), { target: { value: 'priority' } });
    await waitFor(async () => expect(await getSessionModelFixture('tier-session', 'tier-project')).toMatchObject({
      revision: 1, choice: { agentId: 'codex', modelId: 'gpt-5.5' },
    }));
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(screen.getByTestId('execution')).toHaveTextContent('priority'));
    expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual({ model: 'gpt-5.5', reasoning: 'high', serviceTier: 'priority' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Service tier' }), { target: { value: 'default' } });
    await waitFor(async () => expect((await getSessionModelFixture('tier-session', 'tier-project')).revision).toBe(2));
    fireEvent.click(screen.getByRole('button', { name: 'Capture next run' }));
    await waitFor(() => expect(JSON.parse(screen.getByTestId('execution').textContent!)).toEqual({ model: 'gpt-5.5', reasoning: 'high' }));
    expect(defaults.agentModels?.codex).toEqual({ model: 'gpt-5.5', reasoning: 'high' });
  });

  it('clears the previous tier and unsupported reasoning when Home picks another model', () => {
    render(<Home />); open();
    fireEvent.change(screen.getByRole('combobox', { name: 'Service tier' }), { target: { value: 'priority' } });
    fireEvent.click(screen.getByTestId('inline-model-switcher-compact-model-default'));
    expect(choice()).toEqual({ model: 'default' });
    open();
    expect(screen.queryByRole('combobox', { name: 'Service tier' })).toBeNull();
    expect(screen.getByTestId('byok-model')).toHaveTextContent('byok-model');
  });

  it.each([
    { mode: 'api' as const, model: 'gpt-5.5' },
    { mode: 'daemon' as const, model: 'default' },
    { mode: 'daemon' as const, model: 'custom-unlisted-model' },
  ])('does not offer native tiers for $mode/$model without selected capabilities', ({ mode, model }) => {
    render(<InlineModelSwitcher config={{ ...defaults, mode, agentModels: { codex: { model } } }}
      agents={[codex]} compact daemonLive preserveRequestedModel
      onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()}
      onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} />);
    open();
    expect(screen.queryByRole('combobox', { name: 'Service tier' })).toBeNull();
  });
});
