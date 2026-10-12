// @vitest-environment jsdom

import { cleanup, fireEvent, render as rtlRender, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';

import { AssistantMessage } from '../../src/components/AssistantMessage';
import { I18nProvider } from '../../src/i18n';
import type { ChatMessage } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderZh(ui: ReactElement) {
  return rtlRender(<I18nProvider initial="en">{ui}</I18nProvider>);
}

function assistantMessage(events: ChatMessage['events']): ChatMessage {
  return {
    id: 'assistant-1',
    role: 'assistant',
    content: '',
    events,
    runStatus: 'succeeded',
    startedAt: 1_000,
    endedAt: 2_000,
  };
}

function pluginCandidateMessage(): ChatMessage {
  return assistantMessage([
    {
      kind: 'plugin_candidate',
      candidateId: 'candidate-1',
      title: 'Design review helper',
      description: 'This repo looks like it could work as a plugin.',
    },
  ]);
}

describe('AssistantMessage client-provided system copy', () => {
  it('localizes the design-system direction suppression notice', () => {
    const directionForm = [
      '<question-form id="direction" title="Pick a visual direction">',
      JSON.stringify({
        questions: [
          {
            id: 'direction',
            label: 'Direction',
            type: 'direction-cards',
            options: ['Modern minimal'],
            cards: [
              {
                id: 'Modern minimal',
                label: 'Modern minimal',
                mood: 'Clean and restrained.',
                references: ['Linear'],
                palette: ['#ffffff', '#111111'],
                displayFont: 'serif',
                bodyFont: 'sans-serif',
              },
            ],
          },
        ],
      }),
      '</question-form>',
    ].join('\n');

    renderZh(
      <AssistantMessage
        message={assistantMessage([{ kind: 'text', text: directionForm }])}
        streaming={false}
        projectId="project-1"
        isLast
        suppressDirectionForms
      />,
    );

    expect(screen.getByText("Active design system selected. Visual direction is already locked.")).toBeTruthy();
  });

  it('localizes only the known context-compaction status label', () => {
    renderZh(
      <AssistantMessage
        message={assistantMessage([
          { kind: 'status', label: 'context_compaction', detail: 'runtime detail' },
          { kind: 'status', label: 'custom_runtime_phase', detail: 'custom detail' },
        ])}
        streaming
        projectId="project-1"
      />,
    );

    expect(screen.getByText("Compacting context")).toBeTruthy();
    expect(screen.getByText('custom_runtime_phase')).toBeTruthy();
  });

  it('localizes the plugin contribution busy label', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderZh(
      <AssistantMessage
        message={pluginCandidateMessage()}
        streaming={false}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: "Contribute to Mishh Mashh" }));

    expect(await screen.findByText("Starting…")).toBeTruthy();
    expect(screen.queryByText('Starting...')).toBeNull();
  });

  it('localizes the plugin draft busy label', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)));
    renderZh(
      <AssistantMessage
        message={pluginCandidateMessage()}
        streaming={false}
        projectId="project-1"
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'View details' }));
    fireEvent.click(screen.getByRole('button', { name: "Create plugin/template" }));

    expect(await screen.findByText("Creating…")).toBeTruthy();
    expect(screen.queryByText('Creating...')).toBeNull();
  });
});
