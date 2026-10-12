// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatPane } from '../../src/components/ChatPane';
import type { AppConfig, ProjectFile } from '../../src/types';

// A project the Build with Jev fast lane published (Devin, 2026-10-10): its page exists, but it has
// no chat messages yet. The composer used to animate the blank-project starters over it ("Create a
// 10-slide investor roadshow deck…"), which reads as a stray prompt typed into a finished site.
const builtPage: ProjectFile = {
  name: 'restaurant-r1.html',
  type: 'file',
  size: 2048,
  mtime: 1,
  kind: 'html',
  mime: 'text/html',
};

function mount(projectFiles: ProjectFile[]) {
  return render(
    <ChatPane
      messages={[]}
      streaming={false}
      error={null}
      projectId="built-project"
      projectFiles={projectFiles}
      onEnsureProject={async () => 'built-project'}
      onSend={vi.fn()}
      onStop={vi.fn()}
      onRetry={vi.fn()}
      conversations={[{ projectId: 'built-project', id: 'conversation-1', title: 'New conversation', createdAt: 1, updatedAt: 1 }]}
      activeConversationId="conversation-1"
      onSelectConversation={vi.fn()}
      onDeleteConversation={vi.fn()}
      config={{ agentId: 'claude', agentCliEnv: {} } as unknown as AppConfig}
    />,
  );
}

async function settle() {
  for (let tick = 0; tick < 20; tick += 1) {
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

describe('composer placeholder on a project that already has a page', () => {
  it('shows the static placeholder, not the new-project starter prompts', async () => {
    mount([builtPage]);
    await settle();
    expect(screen.queryByTestId('home-hero-carousel')).toBeNull();
    expect(document.body.textContent ?? '').not.toContain('10-slide investor roadshow');
    expect(screen.getByTestId('chat-composer-input').getAttribute('aria-placeholder')).toBe('Describe what you want to generate…');
  });

  it('still animates the starters on a truly blank project, or one holding only a folder', async () => {
    mount([]);
    await settle();
    expect(screen.queryByTestId('home-hero-carousel')).not.toBeNull();
    cleanup();
    mount([{ name: 'assets', type: 'dir', size: 0, mtime: 1, kind: 'other' as ProjectFile['kind'], mime: '' }]);
    await settle();
    expect(screen.queryByTestId('home-hero-carousel')).not.toBeNull();
  });

  it('stops the starters once the file list arrives after the messages (files load separately)', async () => {
    const view = mount([]);
    await settle();
    expect(screen.queryByTestId('home-hero-carousel')).not.toBeNull();
    view.rerender(
      <ChatPane
        messages={[]}
        streaming={false}
        error={null}
        projectId="built-project"
        projectFiles={[builtPage]}
        onEnsureProject={async () => 'built-project'}
        onSend={vi.fn()}
        onStop={vi.fn()}
        onRetry={vi.fn()}
        conversations={[{ projectId: 'built-project', id: 'conversation-1', title: 'New conversation', createdAt: 1, updatedAt: 1 }]}
        activeConversationId="conversation-1"
        onSelectConversation={vi.fn()}
        onDeleteConversation={vi.fn()}
        config={{ agentId: 'claude', agentCliEnv: {} } as unknown as AppConfig}
      />,
    );
    await settle();
    expect(screen.queryByTestId('home-hero-carousel')).toBeNull();
    expect(screen.getByTestId('chat-composer-input').getAttribute('aria-placeholder')).toBeTruthy();
  });
});
