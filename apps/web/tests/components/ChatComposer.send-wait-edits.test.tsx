// @vitest-environment jsdom

// AC-R02.3: "attachment incompatibility never silently discards content", and
// the composer must not discard content the user adds while a send waits.
// ProjectView and DesignSystemFlow both hold a send open while a picker check
// settles (`restartOnSettledChoice`), and the composer stays editable meanwhile.
// When that send finally goes out, the composer may clear only what the send
// carried; text and attachments the user changed during the wait stay.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChatComposer, type ChatSendMeta, type ChatSendOutcome } from '../../src/components/ChatComposer';
import { ANNOTATION_EVENT } from '../../src/components/PreviewDrawOverlay';
import type { ChatAttachment, ChatCommentAttachment } from '../../src/types';
import { composerText, flushMounts, typeAndSettle } from '../helpers/lexical-composer';

const uploads = vi.hoisted(() => ({ uploadProjectFiles: vi.fn() }));
vi.mock('../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/providers/registry')>()),
  uploadProjectFiles: uploads.uploadProjectFiles,
}));

const SKILL = {
  id: 'deck-builder',
  name: 'Deck Builder',
  description: 'Build a polished slide deck.',
  triggers: ['deck'],
  mode: 'deck' as const,
  previewType: 'html',
  designSystemRequired: false,
  defaultFor: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Make a deck',
  aggregatesExamples: false,
};

const MCP_SERVER = { id: 'slack', label: 'Slack MCP', transport: 'stdio' as const, enabled: true, command: 'slack-mcp' };

const CONNECTOR = {
  id: 'figma',
  name: 'Figma',
  provider: 'composio',
  category: 'design',
  status: 'connected',
  tools: [],
  allowedToolNames: ['FIGMA_GET_FILE'],
  curatedToolNames: ['FIGMA_GET_FILE'],
  toolCount: 1,
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function renderComposer(onSend: ComponentProps<typeof ChatComposer>['onSend'], draftStorageKey?: string) {
  return render(
    <ChatComposer
      {...(draftStorageKey ? { draftStorageKey } : {})}
      projectId="project-1"
      projectFiles={[]}
      streaming={false}
      onEnsureProject={async () => 'project-1'}
      onSend={onSend}
      onStop={vi.fn()}
      skills={[SKILL]}
    />,
  );
}

function stagedContexts(): string {
  return screen.queryByTestId('staged-contexts')?.textContent ?? '';
}

/** Picks `label` from the @ picker opened by typing `query` (replaces the editor text). */
async function pickMention(query: string, label: string) {
  await typeAndSettle(query);
  fireEvent.click(await screen.findByText(label));
  await waitFor(() => expect(stagedContexts()).toContain(`@${label}`));
}

/** Stages a visual annotation the way the preview's Mark overlay does ("add to draft"). */
async function stageVisualAnnotation(note: string, x: number) {
  await act(async () => {
    window.dispatchEvent(new CustomEvent(ANNOTATION_EVENT, {
      detail: {
        note,
        action: 'draft',
        filePath: 'index.html',
        markKind: 'click',
        bounds: { x, y: 0.2, width: 0.1, height: 0.1 },
        file: null,
        ack: () => {},
      },
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function attachFile(name: string) {
  const input = screen.getByTestId('chat-file-input') as HTMLInputElement;
  await act(async () => {
    fireEvent.change(input, { target: { files: [new File(['bytes'], name, { type: 'text/plain' })] } });
  });
  await waitFor(() => expect(stagedNames()).toContain(name));
}

function stagedNames(): string {
  return screen.queryByTestId('staged-attachments')?.textContent ?? '';
}

/** An onSend that stays pending (a send waiting on a picker check) until released. */
function pendingSend() {
  let release!: (outcome: ChatSendOutcome) => void;
  const onSend = vi.fn((
    _prompt: string,
    _attachments: ChatAttachment[],
    _comments?: ChatCommentAttachment[],
    _meta?: ChatSendMeta,
  ) => new Promise<ChatSendOutcome>((resolve) => { release = resolve; }));
  return { onSend, release: (outcome: ChatSendOutcome) => act(async () => { release(outcome); }) };
}

beforeEach(() => {
  uploads.uploadProjectFiles.mockImplementation(async (_projectId: string, files: File[]) => ({
    uploaded: files.map((file) => ({ path: file.name, name: file.name, kind: 'file', size: file.size })),
    failed: [],
  }));
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    if (url === '/api/mcp/servers') return json({ servers: [MCP_SERVER], templates: [] });
    if (url === '/api/connectors') return json({ connectors: [CONNECTOR] });
    if (url === '/api/connectors/status') return json({ statuses: { figma: { status: 'connected' } } });
    if (url === '/api/skills') return json({ skills: [SKILL] });
    if (url === '/api/projects/project-1' && init?.method === 'PATCH') {
      return json({ project: { id: 'project-1', name: 'Project', skillId: SKILL.id, designSystemId: null, createdAt: 1, updatedAt: 1, metadata: { kind: 'prototype' } } });
    }
    return json({});
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  cleanup();
});

describe('ChatComposer keeps edits made while a send waits', () => {
  it('keeps text and an attachment added during the wait once the send goes out', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send.onSend).toHaveBeenCalledTimes(1);

    await typeAndSettle('second thought typed while waiting');
    await attachFile('added-while-waiting.txt');

    await send.release(undefined);
    await flushMounts();
    expect(composerText()).toBe('second thought typed while waiting');
    expect(stagedNames()).toContain('added-while-waiting.txt');
    // What went out was the payload captured at send time.
    expect(send.onSend.mock.calls[0]?.[0]).toBe('first prompt');
  });

  it('clears only the attachments the send carried and keeps the ones added during the wait', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await attachFile('sent.txt');
    await typeAndSettle('send with one file');
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send.onSend.mock.calls[0]?.[1]?.map((attachment) => attachment.name)).toEqual(['sent.txt']);

    await attachFile('added-while-waiting.txt');
    await send.release(undefined);
    await flushMounts();
    expect(stagedNames()).toContain('added-while-waiting.txt');
    expect(stagedNames()).not.toContain('sent.txt');
    // The text was not edited during the wait, so it went out and is cleared.
    expect(composerText().trim()).toBe('');
  });

  it('still clears everything when nothing changed during the wait', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await attachFile('sent.txt');
    await typeAndSettle('plain send');
    fireEvent.click(screen.getByTestId('chat-send'));
    await send.release(undefined);
    await flushMounts();
    expect(composerText().trim()).toBe('');
    expect(screen.queryByTestId('staged-attachments')).toBeNull();
  });

  // Switching conversation while a send waits remounts the composer (ChatPane
  // keys it per conversation), so a later 'restore-draft' reaches a composer
  // that is gone. The draft survives through the per-conversation draft store:
  // it is cleared only once a send goes out.
  it('keeps the draft for its conversation when the composer is replaced during the wait and the send gives up', async () => {
    const key = 'od:chat-composer:draft:project-1:conversation-a';
    const send = pendingSend();
    const first = renderComposer(send.onSend, key);
    await flushMounts();
    await attachFile('kept.txt');
    await typeAndSettle('draft for conversation a');
    fireEvent.click(screen.getByTestId('chat-send'));
    first.unmount();
    await send.release('restore-draft');

    renderComposer(vi.fn(), key);
    await flushMounts();
    expect(composerText()).toBe('draft for conversation a');
    expect(stagedNames()).toContain('kept.txt');
  });

  it('keeps the original draft and the edits when the send gives up', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    await typeAndSettle('first prompt, edited while waiting');
    await attachFile('added-while-waiting.txt');
    await send.release('restore-draft');
    await flushMounts();
    expect(composerText()).toBe('first prompt, edited while waiting');
    expect(stagedNames()).toContain('added-while-waiting.txt');
  });
  // Finding 2: attachments are matched by identity, not by path.
  it('keeps a file removed and re-attached at the same path during the wait', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await attachFile('same.txt');
    await typeAndSettle('send with one file');
    fireEvent.click(screen.getByTestId('chat-send'));

    fireEvent.click(screen.getByLabelText(/Remove same\.txt/));
    await waitFor(() => expect(stagedNames()).not.toContain('same.txt'));
    await attachFile('same.txt');

    await send.release(undefined);
    await flushMounts();
    expect(stagedNames()).toContain('same.txt');
  });

  it('keeps a visual annotation added during the wait and clears only the one the send carried', async () => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await stageVisualAnnotation('carried mark', 0.1);
    fireEvent.click(screen.getByTestId('chat-send'));
    const carried = send.onSend.mock.calls[0]?.[2] ?? [];
    expect(carried.map((comment) => comment.comment)).toEqual(['carried mark']);

    await stageVisualAnnotation('added while waiting', 0.5);
    await send.release(undefined);
    await flushMounts();

    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(send.onSend).toHaveBeenCalledTimes(2));
    const next = send.onSend.mock.calls[1]?.[2] ?? [];
    expect(next.map((comment) => comment.comment)).toEqual(['added while waiting']);
  });

  it.each([
    { kind: 'skill', query: '@deck', label: 'Deck Builder', contextKey: 'skillIds', id: SKILL.id },
    { kind: 'MCP server', query: '@sl', label: 'Slack MCP', contextKey: 'mcpServerIds', id: MCP_SERVER.id },
    { kind: 'connector', query: '@fig', label: 'Figma', contextKey: 'connectorIds', id: CONNECTOR.id },
  ] as const)('keeps a $kind selected during the wait for the next turn', async ({ query, label, contextKey, id }) => {
    const send = pendingSend();
    renderComposer(send.onSend);
    await flushMounts();
    await typeAndSettle('first prompt');
    fireEvent.click(screen.getByTestId('chat-send'));
    expect(send.onSend.mock.calls[0]?.[3]?.context?.[contextKey]).toBeUndefined();

    await pickMention(query, label);
    await send.release(undefined);
    await flushMounts();
    expect(stagedContexts()).toContain(`@${label}`);

    fireEvent.click(screen.getByTestId('chat-send'));
    await waitFor(() => expect(send.onSend).toHaveBeenCalledTimes(2));
    expect(send.onSend.mock.calls[1]?.[3]?.context?.[contextKey]).toEqual([id]);
  });
});
