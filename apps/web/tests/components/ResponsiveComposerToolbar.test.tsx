// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChatComposer } from '../../src/components/ChatComposer';
import { ComposerImproveButton, ResponsiveComposerToolbar } from '../../src/components/composer/ResponsiveComposerToolbar';
import { InlineModelSwitcher } from '../../src/components/InlineModelSwitcher';
import { SessionModelStatus } from '../../src/components/workbench/SessionModelStatus';
import { I18nProvider } from '../../src/i18n';
import { flushMounts, typeAndSettle } from '../helpers/lexical-composer';
import type { AppConfig } from '../../src/types';

vi.mock('../../src/components/workbench/WorkbenchImprovePrompt', () => ({ WorkbenchImprovePrompt: ({ draft }: { draft: string }) => <div role="dialog">{draft}</div> }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

// Layout visibility is verified by the running-browser companion test, since
// jsdom has no container-query layout. These are the semantic/action invariants
// which must survive every layout and resizing without remounting draft state.
describe.each([320, 400, 520, 720])('composer toolbar at %i px', width => {
  it('keeps Improve accessible and opens the review without changing the draft', async () => {
    const view = (size: number) => <div style={{ width: size }}><ChatComposer projectId="p1" projectFiles={[]} streaming={false} onEnsureProject={async () => 'p1'} onSend={vi.fn()} onStop={vi.fn()} /></div>;
    const { rerender } = render(view(width));
    await flushMounts();
    await typeAndSettle('A bakery website');
    rerender(view(width === 720 ? 320 : 720));
    const improve = screen.getByRole('button', { name: 'Improve prompt' });
    expect(improve).toHaveAttribute('data-tooltip', 'Improve prompt');
    expect(improve).toHaveAttribute('title', 'Improve prompt');
    fireEvent.click(improve);
    expect(screen.getByRole('dialog')).toHaveTextContent('A bakery website');
    expect(screen.getByTestId('chat-send')).toBeEnabled();
  });
});

it.each([['en', 'Improve prompt'], ["en", "Improve prompt"]] as const)('names the icon action in %s', (locale, label) => {
  const onClick = vi.fn();
  render(<I18nProvider initial={locale}><ResponsiveComposerToolbar><ComposerImproveButton label={label} disabled={false} onClick={onClick} /></ResponsiveComposerToolbar></I18nProvider>);
  fireEvent.click(screen.getByRole('button', { name: label }));
  expect(onClick).toHaveBeenCalledOnce();
});

it('keeps the full model and next-turn meaning in the chip tooltip and accessible name', async () => {
  const config = { mode: 'daemon', agentId: 'mock', apiKey: '', apiVersion: '', apiProtocol: 'anthropic', baseUrl: 'https://api.anthropic.com', apiProviderBaseUrl: 'https://api.anthropic.com', apiProtocolConfigs: {}, model: '', agentModels: { mock: { model: 'sonnet', reasoning: 'default' } }, agentCliEnv: {}, mediaProviders: {}, skillId: null, designSystemId: null, onboardingCompleted: true } as AppConfig;
  render(<I18nProvider initial="en"><InlineModelSwitcher compact showExecutionOptions config={config} agents={[{ id: 'mock', name: 'Claude', bin: 'mock', available: true, models: [{ id: 'sonnet', label: 'Claude Sonnet 5.5 with extended thinking' }] }]} daemonLive onModeChange={vi.fn()} onAgentChange={vi.fn()} onAgentModelChange={vi.fn()} onApiProtocolChange={vi.fn()} onApiModelChange={vi.fn()} onOpenSettings={vi.fn()} /></I18nProvider>);
  const chip = screen.getByTestId('inline-model-switcher-chip');
  await waitFor(() => expect(chip).toHaveAttribute('data-tooltip', 'Model for the next turn: Claude · Claude Sonnet 5.5 with extended thinking'));
  expect(chip).toHaveAccessibleName('Model for the next turn: Claude · Claude Sonnet 5.5 with extended thinking');
});

it('moves only the ready caption out of the row; saving and errors remain announced', () => {
  const props = { onRetry: vi.fn(), onOpenSettings: vi.fn() };
  const { rerender } = render(<SessionModelStatus {...props} state={{ status: 'ready', choice: null, snapshot: null, error: null }} />);
  expect(screen.queryByText('Model for the next turn')).toBeNull();
  rerender(<SessionModelStatus {...props} state={{ status: 'saving', choice: null, snapshot: null, error: null }} />);
  expect(screen.getByRole('status')).toHaveTextContent('Saving');
  rerender(<SessionModelStatus {...props} state={{ status: 'error', choice: null, snapshot: null, error: null }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Your draft is kept');
  fireEvent.click(screen.getByRole('button', { name: 'Save my choice' }));
  expect(props.onRetry).toHaveBeenCalledOnce();
});
