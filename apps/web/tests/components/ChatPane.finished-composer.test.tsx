// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import type { AppConfig, ChatMessage } from '../../src/types';
import { composerText, pressEnter } from '../helpers/lexical-composer';

const finishedMessage: ChatMessage = {
  id: 'finished-message',
  role: 'assistant',
  content: 'Done.',
  createdAt: 1,
  runId: 'finished-run',
  runStatus: 'succeeded',
  events: [
    { kind: 'text', text: 'Done.' },
    { kind: 'next_steps', suggestions: ['Make the hero darker'] },
  ],
};

function mountFinishedConversation(onSend = vi.fn()) {
  return render(
    <ChatPane
      messages={[finishedMessage]}
      streaming={false}
      error={null}
      projectId="finished-project"
      projectFiles={[]}
      onEnsureProject={async () => 'finished-project'}
      onSend={onSend}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      conversations={[
        { projectId: 'finished-project', id: 'conversation-1', title: 'Finished', createdAt: 1, updatedAt: 1 },
      ]}
      activeConversationId="conversation-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'claude', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
}

// Flush successive React commits as well as timer callbacks: the typewriter
// schedules its next character from an effect after each commit.
async function settleTimers() {
  for (let tick = 0; tick < 100; tick += 1) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  window.localStorage.clear();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
    servers: [], templates: [], plugins: [], connectors: [],
  }), { status: 200, headers: { 'content-type': 'application/json' } })));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('finished conversation composer', () => {
  it('stays empty after mount and reload with timers running; Enter never sends', async () => {
    const onSend = vi.fn();
    const mounted = mountFinishedConversation(onSend);
    await settleTimers();
    expect(composerText().trim()).toBe('');
    expect((screen.getByTestId('chat-send') as HTMLButtonElement).disabled).toBe(true);
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();

    mounted.unmount();
    mountFinishedConversation(onSend);
    await settleTimers();
    expect(composerText().trim()).toBe('');
    pressEnter();
    expect(onSend).not.toHaveBeenCalled();
  });

  it('shows a static empty-input placeholder instead of animating a next prompt over it', async () => {
    mountFinishedConversation();
    await settleTimers();
    expect(screen.queryByTestId('home-hero-carousel')).toBeNull();
    expect(screen.getByTestId('chat-composer-input').getAttribute('aria-placeholder')).toBeTruthy();
  });

  it('fills a next-step suggestion only after the user clicks it, without sending', async () => {
    const onSend = vi.fn();
    mountFinishedConversation(onSend);
    await settleTimers();
    expect(composerText().trim()).toBe('');
    fireEvent.click(screen.getByTestId('next-step-suggestion-0'));
    await settleTimers();
    expect(composerText()).toBe('Make the hero darker');
    expect(onSend).not.toHaveBeenCalled();
  });
});
